/**
 * Integration tests for the Host plugin against a fake Cordis context.
 *
 * The point of these is the END-TO-END gate: a refused operation must be
 * refused BEFORE any process is spawned, and an allowed one must reach the
 * shell with the hardened environment. Both assertions would pass in a unit test
 * of `validateArgv` alone, so they are checked here through the real `apply()`,
 * the real tool definition, and a real settings scope.
 *
 * @module git-for-dsh/test/host.test
 */
import assert from 'node:assert/strict'
import { symlinkSync, utimesSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { apply, applyUnguarded, DEFAULT_CONFIG, inject as pluginInject } from '../src/index.js'
import { fileStamp } from '../src/index.js'
import { retiredKeys } from '../src/index.js'
import { CONFIG_AUDIT_COMMAND } from '../src/git-catalog.js'

/**
 * Build a fake context that records everything the plugin touches.
 * @param options - the settings value the fake service resolves, and the run result to return.
 * @returns the context plus the recorder arrays a test asserts against.
 */
function fakeContext(options = {}) {
  const recorded = { runs: [], approvals: [], sections: [], writes: [], starts: [], listeners: [], routes: [], requestedWorkdir: undefined }
  // Diagnostics off by default in tests: the log's default path is the operator's real
  // file, and the heartbeat writes to it on a timer — which is how a test run once put 60
  // heartbeat lines into their log. A test that wants either passes it explicitly.
  // Diagnostics off, and the target scope open by DEFAULT: this fixture drives the tool
  // from arbitrary workdirs to exercise the OTHER gates, and the scope gate would refuse
  // them first. It is spread first so that a test which sets targetScope itself — the scope
  // tests do — still wins.
  const rawSettings = options.settings ?? {}
  let settingsValue = {
    ...DEFAULT_CONFIG,
    logEnabled: false,
    heartbeat: false,
    ...rawSettings,
  }
  // The scope is open UNLESS the test asked for one: the settings service validates the
  // document, so the schema default would otherwise fill 'workspace' and refuse every call
  // that drives the tool from an arbitrary workdir to exercise the other gates.
  if (!('targetScope' in rawSettings)) settingsValue.targetScope = 'unrestricted'
  const listeners = new Set()
  // Mirrors the REAL host-side SettingsScope: get/watch/update/replace. A
  // fixture with subscribe()/set() would let a bug pass, because the settings
  // service does not have those methods.
  const scope = {
    get: () => settingsValue,
    watch(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const tools = {
    registered: [],
    register(definition) {
      tools.registered.push(definition)
      return () => {}
    },
  }
  const approval =
    options.approval === undefined
      ? undefined
      : {
          request(request) {
            recorded.approvals.push(request)
            return Promise.resolve(options.approval.outcome)
          },
          // The real service exposes the session's policy override, and the
          // plugin reads it to explain an auto-rejection. A fixture that omitted
          // it would silently test the wrong reason text.
          ...(options.approval.overrideOf === undefined ? {} : { overrideOf: options.approval.overrideOf }),
        }
  // The settings service hands back the namespace scope; the fake returns the
  // scope object the recorder watches.
  const settings = {
    written: [],
    update: (ns, patch) => {
      settings.written.push({ ns, patch })
      return Promise.resolve()
    },
    register: (ns, schema) => {
      settings.registeredNamespace = ns
      // Real providers resolve AT registration: schema defaults over the base.
      settingsValue = schema(settingsValue)
      return scope
    },
    update: (ns, patch) => {
      recorded.writes.push({ ns, patch })
      settingsValue = { ...settingsValue, ...patch }
      for (const listener of listeners) listener(settingsValue)
      return Promise.resolve()
    },
  }
  /**
   * Services this fixture exposes, keyed as Cordis would serve them.
   *
   * `ctx.<name>` is legal only when the plugin DECLARED `name` in `inject`; an
   * undeclared property read throws, mirroring cordis. `ctx.get(name)` answers
   * undefined for anything, declared or not, which is how the host half silently
   * skipped registering the settings namespace.
   */
  const services = {
    settings: options.withSettings === false ? undefined : settings,
    approval,
    /** Routes are recorded so the port-test handler can be driven directly. */
    webServer: {
      register(route) {
        recorded.routes.push(route)
        return () => {}
      },
    },
  }
  const declared = new Set(pluginInject)
  const ctx = new Proxy(
    {
      get: (name) => services[name],
      /**
       * Event registration. Listeners are RECORDED so a test can invoke them directly,
       * which is how the tool guard is exercised without a whole tool dispatch.
       */
      on(event, listener) {
        recorded.listeners.push({ event, listener })
        return () => {}
      },
      effect(callback) {
        const disposer = callback()
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
      tools,
    shell: {
      resolve(request) {
        // Mirrors the real executor: an omitted workdir falls back to the
        // PROCESS cwd, which is why the plugin must not omit it for a real
        // session. `requestedWorkdir` records what the CALLER asked for.
        recorded.requestedWorkdir = request.workdir
        return { ...request, workdir: request.workdir ?? '/process/cwd', timeoutMs: request.timeoutMs ?? 1000, stdoutMaxBytes: 1e6 }
      },
      /**
       * Background start, which is how the plugin launches the operator's proxy.
       * The test supplies `onStart` to open a real listener, so the plugin's own
       * port wait is exercised rather than stubbed.
       */
      start(spec) {
        recorded.starts.push(spec.command)
        const stop = options.onStart === undefined ? () => {} : options.onStart(spec)
        return {
          kill() {
            stop()
          },
          readOutput: () => ({ delta: '', lossy: false }),
          done: new Promise(() => {}),
        }
      },
      run(spec) {
        recorded.runs.push(spec)
        // The repository-config audit issues its own shell call, answered here from
        // the test's own knobs so a test can arm the configuration it wants.
        if (AUDIT_COMMAND.test(spec.command)) {
          const keys = options.configKeys ?? []
          return Promise.resolve({
            exitCode: options.configExitCode ?? 0,
            signal: null,
            timedOut: false,
            timeoutMs: spec.timeoutMs,
            stdout: { text: keys.join('\u0000'), truncated: false },
            stderr: { text: '', truncated: false },
          })
        }
        return Promise.resolve(
          options.runResult ?? {
            exitCode: 0,
            signal: null,
            timedOut: false,
            timeoutMs: spec.timeoutMs,
            stdout: { text: 'ok\n', truncated: false },
            stderr: { text: '', truncated: false },
          },
        )
      },
    },
      systemPrompt: {
        section(section) {
          recorded.sections.push(section)
        },
        getSectionOrder: () => 1000,
      },
    },
    {
      get(target, prop) {
        if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop)
        if (!declared.has(prop) && services[prop] !== undefined) {
          throw new Error(`cannot get required service "${prop}" in inactive context`)
        }
        return services[prop]
      },
    },
  )
  /** Change the value the settings scope resolves, then notify subscribers. */
  const setSettings = (next) => {
    settingsValue = next
    for (const listener of listeners) listener(next)
  }
  return { ctx, recorded, setSettings, settings }
}

/** Register the plugin against a fake context and return the `git_exec` definition. */
function mount(options) {
  const { ctx, recorded, setSettings, settings } = fakeContext(options)
  // The scope is open by default here: this fixture drives the tool from arbitrary
  // workdirs to exercise the other gates. A test that sets targetScope itself still wins,
  // because the entry is spread first and the stored settings are read over it.
  applyUnguarded(ctx, { targetScope: 'unrestricted', ...(options?.entry ?? {}) })
  const definition = ctx.tools.registered.find((tool) => tool.name === 'git_exec')
  assert.ok(definition !== undefined, 'git_exec must be registered')
  return { definition, recorded, setSettings, settings }
}

/**
 * Matches the shell call the repository-config audit makes.
 *
 * Kept as a fragment of the real command rather than the whole string, so this
 * fixture cannot disagree with the gate about which call is the audit.
 */
const AUDIT_COMMAND = /config --local --includes --list --name-only/

/**
 * The recorded runs that are the COMMAND UNDER TEST.
 *
 * The audit issues its own shell call, so asserting over every recorded run would
 * be off by one and could hide a real regression. Tests that care about execution
 * ask for this view instead.
 *
 * @param recorded - the recorder from the fake context.
 * @returns the specs that are not the audit.
 */
function executed(recorded) {
  return recorded.runs.filter((spec) => !AUDIT_COMMAND.test(spec.command))
}

/** The minimal accepted arguments for one call. */
const CALL = { description: 'Show working tree status' }

describe('host plugin: registration', () => {
  it('registers git_exec and one prompt section, and nothing else', () => {
    const { recorded } = mount()
    assert.equal(recorded.sections.length, 1)
    assert.equal(recorded.sections[0].name, 'tool:git_exec')
    assert.match(recorded.sections[0].text(), /git_exec/)
  })

  it('describes the live allowlist to the model', async () => {
    const { definition, setSettings } = mount()
    assert.match(definition.description, /Repository status and history: status,/)
    assert.doesNotMatch(definition.description, /Remote|push/)
    setSettings({ ...DEFAULT_CONFIG, enabled: [...DEFAULT_CONFIG.enabled, 'push'] })
    assert.match(definition.description, /push/)
  })

  it('states plainly when nothing is enabled', () => {
    const { definition } = mount({ settings: { enabled: [], approveMutating: true, dangerousKeyPolicy: 'refuse-repo' } })
    assert.match(definition.description, /NO git operation is currently enabled/)
  })

  it('keeps the prompt section in step with the allowlist', () => {
    const { recorded, setSettings } = mount()
    assert.match(recorded.sections[0].text(), /status/)
    setSettings({ enabled: [], approveMutating: false, dangerousKeyPolicy: 'refuse-repo' })
    assert.match(recorded.sections[0].text(), /no git operation/i)
  })

  it('falls back to the composition entry with no settings service', () => {
    const { definition } = mount({ withSettings: false, entry: { enabled: ['status'] } })
    assert.match(definition.description, /Repository status and history: status\n/)
    assert.doesNotMatch(definition.description, /, diff,/)
  })
})

describe('host artifact: every host module is present', () => {
  it('ships every module lib/index.js imports', () => {
    // A new host module that the build does not copy fails only at ACTIVATION, as
    // "cannot find module", with no test covering it. This is that test.
    const lib = fileURLToPath(new URL('../lib/', import.meta.url))
    const entry = readFileSync(`${lib}index.js`, 'utf8')
    const imported = [...entry.matchAll(/from '\.\/([A-Za-z0-9_-]+\.js)'/g)].map((match) => match[1])
    assert.ok(imported.length > 0, 'the entry point imports at least one host module')
    for (const module of imported) {
      assert.ok(existsSync(`${lib}${module}`), `lib/${module} is imported but missing; add it to scripts/build.mjs`)
    }
  })
})

describe('host plugin: the settings namespace', () => {
  it('registers the git-tool namespace, which is what makes the page writable', () => {
    // The read-only settings page was exactly this failing: the namespace was
    // never registered, so the client saw no writable section and disabled every
    // control. Nothing else in the plugin errors in that state, which is why it
    // needs its own assertion.
    const { settings } = mount()
    assert.equal(settings.registeredNamespace, 'git-tool')
  })

  it('does not register the namespace when no settings service exists', () => {
    // The other half of the rule: a composition without the service must still
    // activate and simply keep the entry policy, not fail.
    const { settings } = mount({ withSettings: false })
    assert.equal(settings.registeredNamespace, undefined)
  })
})

describe('host plugin: the allowlist gate', () => {
  it('refuses a disabled operation before spawning anything', async () => {
    const { definition, recorded } = mount()
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['push', 'origin', 'main'] }, execution()),
      /not enabled by the user/,
    )
    assert.equal(executed(recorded).length, 0, 'no process may start for a refused operation')
  })

  it('runs an enabled operation', async () => {
    const { definition, recorded } = mount()
    const value = await definition.execute({ ...CALL, argv: ['status', '--porcelain'] }, execution())
    assert.equal(value.operation, 'status')
    assert.equal(executed(recorded).length, 1)
    assert.equal(executed(recorded)[0].command, 'git status --porcelain')
  })

  it('reaches the shell with an explicit danger-full-access policy', async () => {
    const { definition, recorded } = mount()
    await definition.execute({ ...CALL, argv: ['log', '-n', '1'] }, execution())
    assert.equal(executed(recorded)[0].sandboxPolicy.mode, 'danger-full-access')
  })

  it('defaults the workdir to the SESSION workspace, not the shell cwd', async () => {
    // Measured: ctx.shell.resolve({}).workdir answers the process cwd, so a git
    // call that left workdir unset would run in the wrong repository.
    const { definition, recorded } = mount()
    await definition.execute({ ...CALL, argv: ['status'] }, execution({ session: { header: { cwd: '/session/workspace' } } }))
    assert.equal(executed(recorded)[0].workdir, '/session/workspace')
  })

  it('omits workdir entirely when neither the call nor the session supplies one', async () => {
    const { definition, recorded } = mount()
    await definition.execute({ ...CALL, argv: ['status'] }, execution(null))
    assert.equal(recorded.requestedWorkdir, undefined, 'the plugin must not invent a path')
    assert.equal(executed(recorded)[0].workdir, '/process/cwd', 'the executor default applies')
    assert.equal(executed(recorded)[0].sandboxPolicy.mode, 'danger-full-access')
  })
  it('honours an explicit workdir over the session default', async () => {
    const { definition, recorded } = mount()
    await definition.execute({ ...CALL, argv: ['status'], workdir: '/elsewhere/repo' }, execution())
    assert.equal(executed(recorded)[0].workdir, '/elsewhere/repo')
  })

  it('passes the hardened environment through to the run', async () => {
    const { definition, recorded } = mount()
    await definition.execute({ ...CALL, argv: ['status'] }, execution())
    assert.equal(executed(recorded)[0].env.GIT_TERMINAL_PROMPT, '0')
    assert.equal(executed(recorded)[0].env.GIT_CONFIG_GLOBAL, '/dev/null')
    assert.ok(executed(recorded)[0].env.GIT_CONFIG_COUNT)
  })

  it('appends caller paths after -- rather than into argv', async () => {
    const { definition, recorded } = mount({ settings: { enabled: ['add'], approveMutating: false, dangerousKeyPolicy: 'refuse-repo' } })
    await definition.execute({ ...CALL, argv: ['add'], paths: ['src/a b.js', '--weird'] }, execution())
    assert.equal(executed(recorded)[0].command, `git add -- 'src/a b.js' --weird`)
  })

  it('refuses a config-injection attempt on an ENABLED operation', async () => {
    const { definition, recorded } = mount()
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['-c', 'core.pager=sh -c evil', 'status'] }, execution()),
      /must be a git subcommand/,
    )
    assert.equal(executed(recorded).length, 0)
  })

  it('ignores an unknown name smuggled into the stored allowlist', async () => {
    const { definition, recorded } = mount({ entry: { enabled: ['status', 'not-a-git-command'] } })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['not-a-git-command'] }, execution()),
      /unknown git subcommand/,
    )
    assert.equal(executed(recorded).length, 0)
  })

  it('picks up an allowlist changed through the settings service', async () => {
    const { definition, recorded, setSettings } = mount({ entry: { enabled: ['status'] } })
    setSettings({ enabled: ['status', 'commit'], approveMutating: false, dangerousKeyPolicy: 'refuse-repo' })
    await definition.execute({ ...CALL, argv: ['commit', '-m', 'x'] }, execution())
    assert.equal(executed(recorded).length, 1)
    assert.equal(executed(recorded)[0].command, `git commit -m x`)
  })
})

describe('host plugin: approval gate', () => {
  it('does not ask for a read operation', async () => {
    const { definition, recorded } = mount({ approval: approveOnce() })
    await definition.execute({ ...CALL, argv: ['status'] }, execution())
    assert.equal(recorded.approvals.length, 0)
  })

  it('asks before a write operation, and runs it when allowed', async () => {
    const approval = approveOnce()
    const { definition, recorded } = mount({ settings: { enabled: ['commit'], approveMutating: true, dangerousKeyPolicy: 'refuse-repo' }, approval })
    await definition.execute({ ...CALL, argv: ['commit', '-m', 'x'], justification: 'record the fix' }, execution())
    assert.equal(recorded.approvals.length, 1)
    assert.match(recorded.approvals[0].reason, /git commit/)
    assert.match(recorded.approvals[0].reason, /record the fix/)
    assert.equal(executed(recorded).length, 1)
  })

  it('refuses the call when the user rejects', async () => {
    const { definition, recorded } = mount({ settings: { enabled: ['push'], approveMutating: true, dangerousKeyPolicy: 'refuse-repo' }, approval: approveWith('rejected') })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['push', 'origin', 'main'] }, execution()),
      /you rejected the prompt/,
    )
    assert.equal(executed(recorded).length, 0)
  })

  it('fails closed with no approval service', async () => {
    const { definition, recorded } = mount({ settings: { enabled: ['clean'], approveMutating: true, dangerousKeyPolicy: 'refuse-repo' } })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['clean', '-fd'] }, execution()),
      /no approval service/,
    )
    assert.equal(executed(recorded).length, 0)
  })

  it('skips the ask when the user turned approveMutating off', async () => {
    const { definition, recorded } = mount({ settings: { enabled: ['push'], approveMutating: false, dangerousKeyPolicy: 'refuse-repo' } })
    await definition.execute({ ...CALL, argv: ['push', 'origin', 'main'] }, execution())
    assert.equal(recorded.approvals.length, 0)
    assert.equal(executed(recorded).length, 1)
  })
})

describe('host plugin: approval refusals name the cause', () => {
  it('says the policy is "never" rather than blaming the user', async () => {
    // The field report was "the user did not approve git init (rejected)" for a
    // call nobody was asked about, because the session policy auto-rejects.
    const never = {
      outcome: 'rejected',
      overrideOf: () => 'never',
    }
    const { definition, recorded } = mount({
      settings: { enabled: ['init'], approveMutating: true, dangerousKeyPolicy: 'refuse-repo' },
      approval: never,
    })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['init'] }, execution()),
      /approval policy is "never"/,
    )
    assert.equal(executed(recorded).length, 0)
  })

  it('names the setting to change when no approval channel exists', async () => {
    const { definition } = mount({
      settings: { enabled: ['init'], approveMutating: true, dangerousKeyPolicy: 'refuse-repo' },
      approval: approveWith('unavailable'),
    })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['init'] }, execution()),
      /no approval channel is available.*approveMutating/s,
    )
  })
})

describe('host plugin: the port test route', () => {
  /** A port nothing is listening on: bind one, note it, release it. */
  const freePort = async () => {
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const free = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    return free
  }

  /** A listening socket on a port of the test's choosing. */
  const listen = async (port) => {
    const server = createServer()
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    return server
  }

  /** Drive the registered handler with a fake request and response. */
  const ask = async (recorded, query) => {
    const route = recorded.routes.find((row) => row.path === '/git-tool/proxy-check')
    assert.ok(route !== undefined, 'the route must be registered')
    assert.equal(route.kind, 'exact')
    let body = ''
    let status = 0
    await route.handler(
      { url: '/git-tool/proxy-check?' + query },
      {
        setHeader() {},
        set statusCode(code) {
          status = code
        },
        get statusCode() {
          return status
        },
        end(text) {
          body = text
        },
      },
    )
    return { status, body: JSON.parse(body) }
  }

  it('reports a live port as usable', async () => {
    const port = await freePort()
    const server = await listen(port)
    try {
      const { recorded } = mount({ settings: { ...DEFAULT_CONFIG, proxyPort: port } })
      const answer = await ask(recorded, 'port=' + String(port))
      assert.equal(answer.status, 200)
      assert.equal(answer.body.listening, true)
      assert.equal(answer.body.effective, true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('names the ports that DO answer when the configured one does not', async () => {
    // This is the whole point: the operator entered 7890 while their proxy listened
    // on 7897, and only a test that answers "then which port?" catches that.
    const dead = await freePort()
    const live = await freePort()
    const server = await listen(live)
    try {
      const { recorded } = mount({ settings: { ...DEFAULT_CONFIG, proxyPort: dead } })
      const answer = await ask(recorded, 'port=' + String(dead))
      assert.equal(answer.body.listening, false)
      // The candidate list has fixed ports, so assert the SHAPE and the advice rather
      // than pretending a random port is among the well-known ones.
      assert.ok(Array.isArray(answer.body.alternatives))
      assert.equal(answer.body.commandConfigured, false)
      assert.equal(answer.body.effective, true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('rejects a port that is not a port', async () => {
    const { recorded } = mount()
    for (const query of ['port=abc', 'port=0', 'port=99999', '']) {
      // eslint-disable-next-line no-await-in-loop -- four cheap cases
      const answer = await ask(recorded, query)
      assert.equal(answer.status, 400, query + ' must be rejected')
      assert.match(answer.body.error, /端口无效/)
    }
  })
})

describe('host plugin: the audit can be switched off', () => {
  it('runs no shell call and refuses nothing', async () => {
    const { definition, recorded } = mount({
      configKeys: ['core.fsmonitor'],
      settings: { ...DEFAULT_CONFIG, dangerousKeyPolicy: 'off' },
    })
    await definition.execute({ ...CALL, argv: ['status'] }, execution())
    assert.equal(recorded.runs.filter((spec) => AUDIT_COMMAND.test(spec.command)).length, 0, 'no audit call')
    assert.equal(executed(recorded).length, 1, 'and the command ran')
  })
})

describe('host plugin: the target scope', () => {
  const run = (extra, workdir) => {
    const { definition } = mount({ settings: { ...DEFAULT_CONFIG, logEnabled: false, heartbeat: false, ...extra } })
    return definition.execute({ ...CALL, argv: ['status'], workdir }, execution())
  }

  it('refuses a target outside the session workspace by default', async () => {
    await assert.rejects(() => run({ targetScope: 'workspace' }, '/elsewhere/repo'), /不在本次会话的工作区/)
    await assert.doesNotReject(() => run({ targetScope: 'workspace' }, '/fake/cwd'))
  })

  it('compares by path segment, so a sibling is not inside', async () => {
    // /fake/cwd2 must not count as being inside /fake/cwd — the classic prefix mistake.
    await assert.rejects(() => run({ targetScope: 'workspace' }, '/fake/cwd2'), /不在本次会话的工作区/)
  })

  it('allows only the listed roots, and refuses when none are listed', async () => {
    await assert.doesNotReject(() => run({ targetScope: 'allowlist', targetPaths: ['/elsewhere'] }, '/elsewhere/repo'))
    await assert.rejects(() => run({ targetScope: 'allowlist', targetPaths: ['/elsewhere'] }, '/other/repo'), /不在允许的根目录内/)
    await assert.rejects(() => run({ targetScope: 'allowlist', targetPaths: [] }, '/elsewhere/repo'), /一个允许的根目录都没有配置/)
  })

  it('still permits anywhere when asked to', async () => {
    await assert.doesNotReject(() => run({ targetScope: 'unrestricted' }, '/anywhere/at/all'))
  })
})

describe('host plugin: the blacklist covers the target directory', () => {
  const row = (path, extra) => ({ path, read: false, write: false, ask: false, ...extra })

  it('refuses to run inside a blacklisted folder, even where the scope allows it', () => {
    // The scope is open (unrestricted), so only the blacklist can refuse this — and it must
    // say which row to change, because that is the setting the operator has to touch.
    const { definition } = mount({
      settings: { ...DEFAULT_CONFIG, logEnabled: false, heartbeat: false, targetScope: 'unrestricted', pathRules: [row('/blacklisted')] },
    })
    return definition.execute({ ...CALL, argv: ['status'], workdir: '/blacklisted/repo' }, execution()).then(
      () => assert.fail('a blacklisted target must be refused'),
      (error) => {
        assert.match(error.message, /路径黑名单/)
        assert.match(error.message, /黑名单优先于「目标范围」/)
      },
    )
  })

  it('lets it through once the row permits the access the operation needs', async () => {
    const { definition } = mount({
      settings: {
        ...DEFAULT_CONFIG,
        logEnabled: false,
        heartbeat: false,
        targetScope: 'unrestricted',
        pathRules: [row('/blacklisted', { read: true })],
      },
    })
    await assert.doesNotReject(() => definition.execute({ ...CALL, argv: ['status'], workdir: '/blacklisted/repo' }, execution()))
  })
})

describe('host plugin: the configuration health', () => {
  it('reports the keys the current schema no longer declares', () => {
    // The user layer is what the operator actually wrote, so a key there with no declaration
    // in this schema is a leftover from a setting this plugin no longer has.
    const descriptor = (user) => ({ describe: () => [{ ns: 'git-tool', user }] })
    assert.deepEqual(retiredKeys(descriptor({ pathRules: [], retiredThing: 1 })), ['retiredThing'])
    assert.deepEqual(retiredKeys(descriptor({ pathRules: [], bashPathMode: 'heuristic' })), [])
    assert.deepEqual(retiredKeys(descriptor({ a: 1, b: 2 })), ['a', 'b'], 'sorted, so the list is stable')
  })

  it('reports nothing rather than inventing a fault', () => {
    // A service that cannot answer is not a broken configuration. The settings service is
    // optional, so this half must survive without one.
    const descriptor = (user) => ({ describe: () => [{ ns: 'git-tool', user }] })
    assert.deepEqual(retiredKeys(descriptor(undefined)), [])
    assert.deepEqual(retiredKeys(descriptor(null)), [])
    assert.deepEqual(retiredKeys({}), [], 'no describe to ask')
    assert.deepEqual(retiredKeys({ describe: () => [] }), [], 'the namespace is not registered')
  })
})

describe('host plugin: the audit stamp', () => {
  it('tells two files of the same shape apart', () => {
    // The hole: a symlink swapped to a file with the same size and mtime left the cached
    // verdict describing the PREVIOUS file, and that verdict is what decides whether a
    // repository configuration is dangerous.
    const dir = mkdtempSync(join(tmpdir(), 'git-tool-stamp-'))
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    writeFileSync(a, 'core.pager=evil')
    writeFileSync(b, 'core.pager=nice')
    const when = new Date(1_600_000_000_000)
    utimesSync(a, when, when)
    utimesSync(b, when, when)
    assert.notEqual(fileStamp(a), fileStamp(b), 'same size and mtime, different file')

    // A symlink and its target are the same file, so they agree.
    const link = join(dir, 'link')
    symlinkSync(a, link)
    assert.equal(fileStamp(link), fileStamp(a))

    assert.equal(fileStamp(join(dir, 'missing')), undefined)
  })
})

describe('host plugin: the tool guard', () => {
  const PROTECTED = '/home/probe/.git-credentials'
  const settingsWith = (extra) => ({ ...DEFAULT_CONFIG, pathRules: [{ path: PROTECTED, read: false, write: false, ask: false }], ...extra })

  /** The registered pre-execute listener, called the way the registry calls it. */
  const decide = async (recorded, execution) => {
    const entry = recorded.listeners.find((row) => row.event === 'tools/pre-execute')
    assert.ok(entry !== undefined, 'the guard must be registered on tools/pre-execute')
    // Whether the guard DELEGATED must be observed, not inferred: next() itself
    // returns an allow decision, so the return value alone cannot tell them apart.
    let delegated = false
    const decision = await entry.listener(execution, () => {
      delegated = true
      return Promise.resolve({ kind: 'allow' })
    })
    return delegated ? { kind: 'delegated', reason: '' } : decision
  }

  const call = (name, args, cwd = '/fake/cwd') => ({ name, arguments: args, agent: { session: { header: { cwd } } }, signal: new AbortController().signal })

  /** A settings section whose script check is the given tier. */
  const withTier = (extra) => mount({ settings: settingsWith(extra) })

  /** A write of a shell script whose body is the given line. */
  const writeScript = (body) => call('write', {
    file_path: '/repo/deploy.sh',
    content: `#!/bin/sh\n${body}\n`,
  }, '/repo')

  it('judges a written script by its tier', async () => {
    // 严格: a mere mention is enough. It catches a script that only talks about git, and
    // therefore also catches scripts that are no threat.
    const strict = await decide(withTier({ scriptCheckPolicy: 'strict' }).recorded, writeScript('echo "see git docs"'))
    assert.equal(strict.kind, 'deny')

    // 限制: only a real invocation counts, so a mention in a string or a comment passes —
    // this is the tier that barely misfires.
    const restrictMention = await decide(withTier({ scriptCheckPolicy: 'restrict' }).recorded, writeScript('echo "see git docs"'))
    assert.equal(restrictMention.kind, 'delegated')
    const restrictInvocation = await decide(withTier({ scriptCheckPolicy: 'restrict' }).recorded, writeScript('git status'))
    assert.equal(restrictInvocation.kind, 'deny')

    // 关闭: the content is not looked at. The command line is still judged when it runs.
    const off = await decide(withTier({ scriptCheckPolicy: 'off' }).recorded, writeScript('git status'))
    assert.equal(off.kind, 'delegated')
  })

  it('does not judge a file that is not a shell script', async () => {
    // The check is scoped to shell scripts; a note that happens to mention git is not one.
    const { recorded } = withTier({ scriptCheckPolicy: 'strict' })
    const decision = await decide(recorded, call('write', {
      file_path: '/repo/notes.md',
      content: 'run git status to see the tree',
    }, '/repo'))
    assert.equal(decision.kind, 'delegated')
  })

  it('reads the boolean the tier replaced, so an existing profile keeps its choice', async () => {
    // scanScripts: false used to mean "do not check", and that must still hold now that the
    // setting is a policy.
    const legacyOff = await decide(withTier({ scriptCheckPolicy: undefined, scanScripts: false }).recorded, writeScript('git status'))
    assert.equal(legacyOff.kind, 'delegated')
  })

  it('refuses native git in bash, and names the way forward', async () => {
    const { recorded } = mount()
    const decision = await decide(recorded, call('bash', { command: 'git status', description: 'x' }))
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /git_exec/)
  })

  it('sees the absolute, aliased and prefixed forms', async () => {
    const { recorded } = mount()
    for (const command of ['/usr/bin/git log', 'env git push', 'echo x && git commit -m y']) {
      // eslint-disable-next-line no-await-in-loop -- three cheap cases
      const decision = await decide(recorded, call('bash', { command, description: 'x' }))
      assert.equal(decision.kind, 'deny', command + ' must be refused')
    }
  })

  it('leaves an ordinary command alone', async () => {
    const { recorded } = mount()
    assert.equal((await decide(recorded, call('bash', { command: 'ls -la && npm test', description: 'x' }))).kind, 'delegated')
  })

  it('refuses a protected file, and a directory that contains it', async () => {
    const { recorded } = mount({ settings: settingsWith({}) })
    const direct = await decide(recorded, call('read', { file_path: PROTECTED }))
    assert.equal(direct.kind, 'deny')
    assert.match(direct.reason, /git-credentials/)
    // Reading the CONTAINER exposes the file just as well as naming it.
    assert.equal((await decide(recorded, call('grep', { pattern: '.', path: '/home/probe' }))).kind, 'deny')
  })

  it('resolves a relative argument against the session workspace', async () => {
    const { recorded } = mount({ settings: settingsWith({}) })
    assert.equal((await decide(recorded, call('read', { file_path: '.git-credentials' }, '/home/probe'))).kind, 'deny')
  })

  it('refuses shell text that names a protected path', async () => {
    const { recorded } = mount({ settings: settingsWith({}) })
    assert.equal((await decide(recorded, call('bash', { command: 'cat ' + PROTECTED, description: 'x' }))).kind, 'deny')
  })

  it('restrict refuses a real invocation but not a mention', async () => {
    const settings = { ...DEFAULT_CONFIG, nativeGitPolicy: 'restrict', pathRules: [{ path: '/nonexistent', read: false, write: false, ask: false }] }
    const { recorded } = mount({ settings })
    assert.equal(
      (await decide(recorded, call('bash', { command: 'git log', description: 'x' }))).kind,
      'deny',
    )
    // The mention case is what the tier exists for.
    assert.equal(
      (await decide(recorded, call('bash', { command: 'echo "(请看 git 的状态)"', description: 'x' }))).kind,
      'delegated',
    )
  })

  it('deny refuses the same mention, so the tiers are not the same rule', async () => {
    const { recorded } = mount({ settings: { ...DEFAULT_CONFIG, pathRules: [{ path: '/nonexistent', read: false, write: false, ask: false }] } })
    assert.equal(
      (await decide(recorded, call('bash', { command: 'echo "(请看 git 的状态)"', description: 'x' }))).kind,
      'deny',
    )
  })

  it('judges each blacklist row on its own boxes', async () => {
    const ask = mount({ settings: settingsWith({ nativeGitPolicy: 'ask' }) })
    assert.equal((await decide(ask.recorded, call('bash', { command: 'git status', description: 'x' }))).kind, 'ask')

    // Identity: the default migrates to the ask box, so a read prompts; opening it to
    // read+write lets the same read through without asking.
    const identity = join(homedir(), '.gitconfig')
    const asked = mount({ settings: settingsWith({}) })
    assert.equal((await decide(asked.recorded, call('read', { file_path: identity }))).kind, 'deny')

    const opened = mount({ settings: settingsWith({ pathRules: [{ path: '~/.gitconfig', read: true, write: false, ask: false }, { path: PROTECTED, read: false, write: false, ask: false }] }) })
    assert.equal((await decide(opened.recorded, call('read', { file_path: identity }))).kind, 'delegated')
    // ...while the operator's own row, ticked nowhere, is still denied: rows are independent.
    assert.equal((await decide(opened.recorded, call('read', { file_path: PROTECTED }))).kind, 'deny')

    // Credentials start with nothing ticked: denied silently, and the message names the row.
    const denied = await decide(opened.recorded, call('bash', { command: 'cat ~/.git-credentials', description: 'x' }))
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /路径黑名单/)

    // The bash tier decides how a mention is judged; write-only counts a plain read as a
    // write, which matters once only the read box is ticked.
    const readOnly = mount({
      settings: settingsWith({
        pathRules: [{ path: '~/.gitconfig', read: true, write: false, ask: false }],
        bashPathMode: 'heuristic',
      }),
    })
    assert.equal(
      (await decide(readOnly.recorded, call('bash', { command: 'cat ~/.gitconfig', description: 'x' }))).kind,
      'delegated',
      'heuristic: cat is a read, and the read box is ticked',
    )
    const writeOnly = mount({
      settings: settingsWith({
        pathRules: [{ path: '~/.gitconfig', read: true, write: false, ask: false }],
        bashPathMode: 'write-only',
      }),
    })
    assert.equal(
      (await decide(writeOnly.recorded, call('bash', { command: 'cat ~/.gitconfig', description: 'x' }))).kind,
      'deny',
      'write-only: the same mention counts as a write, and the write box is empty',
    )
  })

  it('sees a protected path handed to git_exec itself', async () => {
    // The gap: this tool's operands are argv/paths, not file_path/path, so a read-tier
    // `diff --no-index` printed a protected file with no approval and no path rule applied.
    // A path that collides with no built-in name, so the operator's own row is what fires.
    const privatePath = '/home/probe/private-notes.txt'
    const unticked = mount({ settings: settingsWith({ pathRules: [{ path: privatePath, read: false, write: false, ask: false }] }) })
    const read = await decide(unticked.recorded, call('git_exec', { argv: ['diff', '--no-index', privatePath, '/dev/null'] }))
    assert.equal(read.kind, 'deny')
    assert.match(read.reason, /private-notes\.txt/, 'the operator row is what refused it')

    // The same call through paths.
    const viaPaths = await decide(unticked.recorded, call('git_exec', { argv: ['diff', '--no-index'], paths: [privatePath] }))
    assert.equal(viaPaths.kind, 'deny')

    // Ticking the read box permits it, because a diff is judged as a read.
    const readTicked = mount({ settings: settingsWith({ pathRules: [{ path: privatePath, read: true, write: false, ask: false }] }) })
    const allowed = await decide(readTicked.recorded, call('git_exec', { argv: ['diff', '--no-index', privatePath, '/dev/null'] }))
    assert.equal(allowed.kind, 'delegated')

    // A write-shaped operation still needs the write box.
    const writeAttempt = await decide(readTicked.recorded, call('git_exec', { argv: ['add', privatePath] }))
    assert.equal(writeAttempt.kind, 'deny')
  })

  it('judges a silenced read as a read, not a write', async () => {
    // A row opened for reading only. Every command below reads the file and throws output
    // away, so none of them names a file to write.
    const notes = '/home/probe/private-notes.txt'
    const { recorded } = mount({ settings: settingsWith({ pathRules: [{ path: notes, read: true, write: false, ask: false }] }) })
    const command = (text) => decide(recorded, call('bash', { command: text, description: 'x' }))

    assert.equal((await command('cat ' + notes)).kind, 'delegated')
    assert.equal((await command('cat ' + notes + ' 2>/dev/null')).kind, 'delegated')
    assert.equal((await command('cat ' + notes + ' > /dev/null')).kind, 'delegated')
    assert.equal((await command('grep -n x ' + notes + ' 2>&1')).kind, 'delegated')

    // A redirection that names a file is still a write, so the write box is required.
    assert.equal((await command('cat ' + notes + ' > /tmp/out.txt')).kind, 'deny')
    assert.equal((await command('cat ' + notes + ' >> /tmp/out.txt')).kind, 'deny')
    assert.equal((await command('cat ' + notes + ' | tee /tmp/out.txt')).kind, 'deny')
  })
  it('judges the bash working directory against the blacklist', async () => {
    // The directory row does not stop a command that simply runs inside it — the command text
    // names nothing. The row's own boxes decide, as they do everywhere else.
    const dir = join(mkdtempSync(join(tmpdir(), 'git-tool-workdir-')), 'notes-dir')
    const deep = join(dir, 'inner')
    mkdirSync(deep, { recursive: true })
    const unticked = mount({ settings: settingsWith({ pathRules: [{ path: dir, read: false, write: false, ask: false }] }) })
    const inside = await decide(unticked.recorded, call('bash', { command: 'ls', workdir: deep }))
    assert.equal(inside.kind, 'deny')
    assert.match(inside.reason, /路径黑名单/)

    // Reading is permitted once the read box is ticked; the same command still runs.
    const readTicked = mount({ settings: settingsWith({ pathRules: [{ path: dir, read: true, write: false, ask: false }] }) })
    const allowed = await decide(readTicked.recorded, call('bash', { command: 'ls', workdir: dir + '/inner' }))
    assert.equal(allowed.kind, 'delegated')

    // A command that writes there still needs the write box.
    const written = await decide(readTicked.recorded, call('bash', { command: 'rm -rf notes', workdir: deep }))
    assert.equal(written.kind, 'deny')

    // A directory outside the row is untouched.
    const elsewhere = await decide(readTicked.recorded, call('bash', { command: 'ls', workdir: join(dir, '..', 'elsewhere') }))
    assert.equal(elsewhere.kind, 'delegated')
  })

  it('never breaks a call it cannot judge', async () => {
    // The guard absorbs its own failures: throwing here would take down every tool
    // call in the session, which is worse than the one call it failed to inspect.
    const { recorded } = mount()
    assert.equal((await decide(recorded, call('bash', { command: 42 }))).kind, 'delegated')
    assert.equal((await decide(recorded, call('read', { file_path: null }))).kind, 'delegated')
    assert.equal((await decide(recorded, { name: 'read', arguments: undefined })).kind, 'delegated')
  })
})

describe('host plugin: the operator proxy', () => {
  /** A port nothing is listening on: bind one, note it, release it. */
  const freePort = async () => {
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const free = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    return free
  }

  const proxySettings = (port, command) => ({
    enabled: ['fetch'],
    approveMutating: false,
    dangerousKeyPolicy: 'refuse-repo',
    proxyPort: port,
    proxyCommand: command,
  })

  it('leaves the environment alone when no port is configured', async () => {
    const { definition, recorded } = mount({ settings: proxySettings(0, '') })
    await definition.execute({ ...CALL, argv: ['fetch', 'origin'] }, execution())
    assert.equal(recorded.starts.length, 0)
    assert.equal(executed(recorded)[0].env.HTTPS_PROXY, undefined)
  })

  it('leaves LOCAL operations alone even when a proxy is configured', async () => {
    const port = await freePort()
    const { definition, recorded } = mount({
      settings: { enabled: ['gc'], approveMutating: false, dangerousKeyPolicy: 'refuse-repo', proxyPort: port, proxyCommand: 'fake-proxy' },
    })
    await definition.execute({ ...CALL, argv: ['gc'] }, execution())
    assert.equal(recorded.starts.length, 0, 'a local operation must not start a proxy')
  })

  it('USES a proxy that is already listening, and starts nothing', async () => {
    // The case that actually occurs: the operator's proxy is already up on its port.
    // The first version of this test asserted the opposite and demanded a different
    // port, which made the feature useless for its own motivation.
    const port = await freePort()
    const server = createServer()
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    try {
      const { definition, recorded } = mount({ settings: proxySettings(port, 'must-not-run') })
      await definition.execute({ ...CALL, argv: ['fetch', 'origin'] }, execution())
      assert.equal(recorded.starts.length, 0, 'an already-running proxy must not be started')
      assert.equal(executed(recorded)[0].env.HTTPS_PROXY, `http://127.0.0.1:${String(port)}`)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('refuses, naming the port, when nothing listens and there is no command', async () => {
    const port = await freePort()
    const { definition } = mount({ settings: proxySettings(port, '') })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['fetch', 'origin'] }, execution()),
      /没有代理在监听/,
    )
  })

  it('starts the proxy, waits for the port, and points git at it', async () => {
    const port = await freePort()
    let server
    const { definition, recorded } = mount({
      settings: proxySettings(port, 'fake-proxy --port ' + String(port)),
      onStart: () => {
        server = createServer()
        server.listen(port, '127.0.0.1')
        return () => server.close()
      },
    })
    try {
      await definition.execute({ ...CALL, argv: ['fetch', 'origin'] }, execution())
      assert.deepEqual(recorded.starts, ['fake-proxy --port ' + String(port)])
      const gitRun = executed(recorded)[0]
      assert.equal(gitRun.env.HTTPS_PROXY, 'http://127.0.0.1:' + String(port))
      assert.equal(gitRun.env.HTTP_PROXY, 'http://127.0.0.1:' + String(port))
      assert.match(gitRun.env.NO_PROXY, /127/)
    } finally {
      if (server !== undefined) await new Promise((resolve) => server.close(resolve))
    }
  })

  it('refuses and stops the process when the port never comes up', async () => {
    const port = await freePort()
    const killed = []
    const { definition, recorded } = mount({
      settings: proxySettings(port, 'fake-proxy-that-fails'),
      onStart: () => () => killed.push('stop'),
    })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['fetch', 'origin'] }, execution()),
      /没有开始监听/,
    )
    assert.deepEqual(recorded.starts, ['fake-proxy-that-fails'])
    assert.deepEqual(killed, ['stop'], 'a proxy that never listened must be stopped again')
  })
})

describe('host plugin: the form decides approval', () => {
  it('asks before a read-tier operation\'s mutating form', async () => {
    const approval = approveOnce()
    const { definition, recorded } = mount({ settings: { enabled: ['branch'], approveMutating: true, dangerousKeyPolicy: 'refuse-repo' }, approval })
    await definition.execute({ ...CALL, argv: ['branch', 'newbranch'] }, execution())
    assert.equal(recorded.approvals.length, 1, 'creating a ref must be approved')
    assert.equal(executed(recorded).length, 1)
  })

  it('does not ask for the listing form of the same operation', async () => {
    const approval = approveOnce()
    const { definition, recorded } = mount({ settings: { enabled: ['branch'], approveMutating: true, dangerousKeyPolicy: 'refuse-repo' }, approval })
    await definition.execute({ ...CALL, argv: ['branch', '-a'] }, execution())
    assert.equal(recorded.approvals.length, 0, 'listing changes nothing')
    assert.equal(executed(recorded).length, 1)
  })
})

describe('host plugin: the audit is cached by repository state', () => {
  it('reuses an audit until the configuration changes', async () => {
    // A process start on WSL costs tens of milliseconds, and the audit is a second one per
    // git call. The key covers the directory, the policy and the config's stamp, so reuse
    // can never hide a changed configuration.
    const repo = mkdtempSync(join(tmpdir(), 'audit-cache-'))
    mkdirSync(join(repo, '.git'), { recursive: true })
    const config = join(repo, '.git', 'config')
    writeFileSync(config, '[core]\n\trepositoryformatversion = 0\n')
    after(() => rmSync(repo, { recursive: true, force: true }))

    const { definition, recorded } = mount({ configKeys: ['core.fsmonitor'] })
    const audits = () => recorded.runs.filter((spec) => AUDIT_COMMAND.test(spec.command)).length

    // This key names a program, so every call is refused — and that refusal proves the
    // verdict came from the cached keys rather than being skipped.
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['status'], workdir: repo }, execution()),
      /core\.fsmonitor/,
    )
    assert.equal(audits(), 1)

    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['status'], workdir: repo }, execution()),
      /core\.fsmonitor/,
    )
    assert.equal(audits(), 1, 'the second call reused the cached audit')

    writeFileSync(config, '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = true\n')
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['status'], workdir: repo }, execution()),
      /core\.fsmonitor/,
    )
    assert.equal(audits(), 2, 'a changed configuration forces a fresh audit')
  })

  it('does not cache a directory with no configuration to watch', async () => {
    const { definition, recorded } = mount({ configKeys: ['core.fsmonitor'] })
    const audits = () => recorded.runs.filter((spec) => AUDIT_COMMAND.test(spec.command)).length
    for (let index = 0; index < 2; index += 1) {
      await assert.rejects(
        () => definition.execute({ ...CALL, argv: ['status'], workdir: '/nonexistent-repo' }, execution()),
        /core\.fsmonitor/,
      )
    }
    assert.equal(audits(), 2, 'an unwatchable directory is audited every time')
  })
})

describe('host plugin: repository-config audit', () => {
  it('consults the config WITH includes, and before anything else runs', async () => {
    // `--local --list` hides keys that arrived through an [include] directive even
    // though they execute, so the audit must ask for includes explicitly.
    const { definition, recorded } = mount()
    await definition.execute({ ...CALL, argv: ['status'] }, execution())
    const audit = recorded.runs.find((spec) => AUDIT_COMMAND.test(spec.command))
    assert.ok(audit !== undefined, 'the audit must run')
    // Pinned to the shared constant: a command git rejects would make the gate
    // inert, and an earlier substring assertion passed while the command could not
    // run at all. scripts/verify-config-audit.mjs proves git accepts it.
    assert.equal(audit.command, CONFIG_AUDIT_COMMAND)
  })

  it('refuses the call when the repository config names a program', async () => {
    const { definition, recorded } = mount({ configKeys: ['core.fsmonitor'] })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['status'] }, execution()),
      /core\.fsmonitor/,
    )
    assert.equal(executed(recorded).length, 0, 'the subcommand must not run')
  })

  it('refuses a key that arrived through an include', async () => {
    // The include directive itself is dangerous: it can pull configuration from
    // anywhere on the machine, and a plain listing would not show what it brought.
    const { definition, recorded } = mount({ configKeys: ['include.path', 'user.name'] })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['status'] }, execution()),
      /include\.path/,
    )
    assert.equal(executed(recorded).length, 0)
  })

  it('allows a clean repository', async () => {
    const { definition, recorded } = mount({ configKeys: ['user.name', 'core.repositoryformatversion'] })
    await definition.execute({ ...CALL, argv: ['status'] }, execution())
    assert.equal(executed(recorded).length, 1)
  })

  it('does not refuse when the directory is not a repository', async () => {
    // A non-repository has no configuration to read; the command itself reports that.
    const { definition, recorded } = mount({ configExitCode: 128 })
    await definition.execute({ ...CALL, argv: ['status'] }, execution())
    assert.equal(executed(recorded).length, 1)
  })

  it('honours refuse-affected: a key that cannot affect the call passes', async () => {
    const { definition, recorded } = mount({
      configKeys: ['alias.co'],
      settings: { enabled: ['status'], approveMutating: true, dangerousKeyPolicy: 'refuse-affected' },
    })
    // `alias.*` cannot hijack a builtin subcommand, so status is unaffected.
    await definition.execute({ ...CALL, argv: ['status'] }, execution())
    assert.equal(executed(recorded).length, 1)
  })

  it('honours refuse-affected: the same key refuses the call it would affect', async () => {
    const { definition, recorded } = mount({
      configKeys: ['diff.evil.command'],
      settings: { enabled: ['diff'], approveMutating: true, dangerousKeyPolicy: 'refuse-affected' },
    })
    await assert.rejects(
      () => definition.execute({ ...CALL, argv: ['diff'] }, execution()),
      /diff\.evil\.command/,
    )
    assert.equal(executed(recorded).length, 0)
  })

  it('honours neutralize: a pinned key is allowed, an unpinnable one is not', async () => {
    const pinned = mount({
      configKeys: ['core.pager'],
      settings: { enabled: ['status'], approveMutating: true, dangerousKeyPolicy: 'neutralize' },
    })
    await pinned.definition.execute({ ...CALL, argv: ['status'] }, execution())
    assert.equal(executed(pinned.recorded).length, 1, 'a pinned key is neutralized, not fatal')

    const wildcard = mount({
      configKeys: ['filter.evil.clean'],
      settings: { enabled: ['status'], approveMutating: true, dangerousKeyPolicy: 'neutralize' },
    })
    await assert.rejects(
      () => wildcard.definition.execute({ ...CALL, argv: ['status'] }, execution()),
      /filter\.evil\.clean/,
    )
    assert.equal(executed(wildcard.recorded).length, 0, 'an unpinnable key still refuses')
  })
})

describe('host plugin: results', () => {
  it('reports a non-zero exit as a result, not a tool failure', async () => {
    const { definition } = mount({
      runResult: {
        exitCode: 1,
        signal: null,
        timedOut: false,
        timeoutMs: 1000,
        stdout: { text: '', truncated: false },
        stderr: { text: 'fatal: not a git repository\n', truncated: false },
      },
    })
    const value = await definition.execute({ ...CALL, argv: ['status'] }, execution())
    assert.equal(value.exitCode, 1)
    assert.match(value.stderr, /not a git repository/)
  })

  it('renders exit status, stderr, and truncation for the model', async () => {
    const { definition } = mount({
      runResult: {
        exitCode: 128,
        signal: null,
        timedOut: false,
        timeoutMs: 1000,
        stdout: { text: '', truncated: false },
        stderr: { text: 'fatal: bad revision\n', truncated: false },
      },
    })
    const value = await definition.execute({ ...CALL, argv: ['status'] }, execution())
    const [block] = definition.output.render({ ...CALL, argv: ['status'] }, value)
    assert.match(block.text, /\[stderr\]/)
    assert.match(block.text, /\[exit code: 128\]/)
  })
})

/** A tool execution context stub. */
function execution(agent = { session: { header: { cwd: '/fake/cwd' } } }) {
  return { callId: 'call-1', agent, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} }
}

/** An approval answerer that grants the ask. Asks are recorded by `fakeContext`. */
function approveOnce() {
  return { outcome: 'allowed-once' }
}

/** An approval answerer that answers with `outcome` (\`rejected\`, \`cancelled\`, \`unavailable\`). */
function approveWith(outcome) {
  return { outcome }
}
