/**
 * Tests for the browser half, loaded through its REAL delivery path.
 *
 * Every assertion here exists because of a field failure, not a hypothetical:
 *
 *  - **An undeclared service read failed the plugin load.** An earlier version
 *    read `ctx.slots` while declaring only `settingsScope`. The Guard's rule —
 *    "declare a service on the plugin you return, or reach it with `ctx.get`" —
 *    was applied against a package-level declaration list that holds PACKAGE
 *    names, so the read was rejected and the whole plugin failed to load with
 *    `failed to apply loader entry … cannot get property "slots" without inject`.
 *  - **Declaring the service instead parks the package.** So the fix is not to
 *    declare it: this bundle reads every service with `ctx.get`, the optional
 *    form, and exports NO `inject`.
 *  - **A throw during module evaluation failed the load too.** The factory body
 *    is wrapped, so a broken body degrades to a no-op.
 *
 * The harness reproduces the page's own mechanisms: the bundle is executed with
 * a real `window.__ModuleLoader__` and a `require`, and `ctx` is a proxy that
 * implements `get(name)` and the context verbs while REFUSING property reads —
 * which is exactly what a declaration-less plugin hits at runtime.
 *
 * @module git-for-dsh/test/client
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The BUILT bundle, not the source: the build substitutes the embedded catalog
 * into it, and a source file still carrying the token would fail evaluation and
 * silently take the fail-safe path — which is exactly what happened when this
 * test pointed at `src/client.js`. `npm test` runs the build first (see the
 * TestOrder in package.json's scripts), and the token check below fails loudly if
 * it ever runs against an unbuilt copy.
 */
const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** The expected module id: the package name, not a second copy of it. */
const PACKAGE_NAME = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).name


/**
 * React as the page provides it. Structural only: these tests are about
 * activation and wiring, not pixels.
 */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  Component: class {
    constructor(props) {
      this.props = props ?? {}
    }
  },
}

/** Modules the page's `require` can answer. */
const PAGE_MODULES = {
  react: React,
  'react/jsx-runtime': {},
  '@deepseek-ai/dsh-client-ui-settings': {},
}

/**
 * Execute the bundle the way the client module system does.
 *
 * The scope is deliberately BARE: only `window` (the module loader) is bound.
 * An earlier harness also bound `styles` and `host`, which hid a render-time
 * `host is not defined` — so nothing extra may be provided here. If the bundle
 * needs another identifier, it must come from `require` or be absent.
 *
 * @param pageModules - the module table `require` resolves against.
 * @returns the registered factory, keyed by module id.
 */
function executeBundle(pageModules = PAGE_MODULES) {
  const registry = new Map()
  const window = { __ModuleLoader__: { load: (row) => registry.set(row.id, row.factory) } }
  const previous = globalThis.window
  globalThis.window = window
  try {
    new Function('window', SOURCE)(window)
  } finally {
    globalThis.window = previous
  }
  assert.equal(registry.size, 1, 'the bundle must register exactly one module')
  const [id, factory] = [...registry.entries()][0]
  return { id, factory, require: (name) => {
    if (!(name in pageModules)) throw new Error(`the page cannot resolve module "${name}"`)
    return pageModules[name]
  } }
}

/**
 * A stand-in for the page's `document`, used to observe the stylesheet the
 * bundle inserts itself.
 *
 * This exists because the settings page shipped COMPLETELY UNSTYLED: the sheet
 * was handed to a builtin that a composition-loaded bundle never receives, and no
 * assertion noticed because nothing looked at the document.
 *
 * @returns the fake document plus the tags appended to it.
 */
function fakeDocument() {
  const appended = []
  const document = {
    head: {
      appendChild(tag) {
        appended.push(tag)
      },
    },
    querySelector: () => null,
    createElement(tagName) {
      return { tagName, dataset: {}, textContent: '', remove() {} }
    },
  }
  return { document, appended }
}

/**
 * Load the bundle and build a context that behaves like the page's.
 * @param options - which services the page exposes, and the stored allowlist.
 * @returns the module exports plus everything the plugin did through the context.
 */
function loadPlugin(options = {}) {
  const { id, factory, require } = executeBundle(options.pageModules ?? PAGE_MODULES)
  const { document, appended } = fakeDocument()
  const moduleExports = factory(require)

  const calls = { slots: [], registered: null, effects: 0, binds: 0, namespace: null, getCalls: [], setCalls: [], hostCalls: [] }
  const provided = new Set(options.provide ?? ['slots', 'settingsScope'])
  // `mode: 'memory'` reproduces what a non-loopback page reports: the namespace is
  // reachable and writable, but the client does not read it back.
  const snapshot = options.snapshot ?? {
    status: 'ready',
    value: {
      enabled: options.enabled ?? ['status'],
      approveMutating: true,
      dangerousKeyPolicy: 'refuse-repo',
      useHostCredentials: options.useHostCredentials === true,
      proxyPort: options.proxyPort ?? 0,
      proxyCommand: options.proxyCommand ?? '',
    },
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const services = {
    slots: {
      inject(key, callback) {
        calls.slots.push(key)
        callback()
      },
      register(spec, component) {
        calls.registered = { ...(calls.registered ?? {}), spec, component }
      },
    },
    settingsScope: {
      bind(spec) {
        calls.binds += 1
        calls.namespace = spec.namespace
        calls.bindSpec = spec
        return {
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
          set: (field, value) => {
            calls.setCalls.push({ field, value })
            return Promise.resolve()
          },
          unset: () => Promise.resolve(),
          mutate: () => Promise.resolve(),
        }
      },
    },
    styles: {
      insert() {
        calls.effects += 1
        return () => {}
      },
    },
  }

  const ctx = new Proxy(
    {
      get(name) {
        calls.getCalls.push(name)
        return provided.has(name) ? services[name] : undefined
      },
      effect(callback) {
        callback()
        return () => {}
      },
      on: () => () => {},
    },
    {
      // Ported from cordis: a service read through a property that is not part
      // of the context object is precisely what "without inject" means.
      get(target, prop) {
        if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop)
        throw new Error(`cannot get property "${prop}" without inject`)
      },
    },
  )

  return { id, exports: moduleExports, ctx, calls, snapshot, document, appended }
}

describe('client bundle: artifact', () => {
  it('is built: the catalog token has been substituted', () => {
    assert.ok(
      !SOURCE.includes('__GIT_TOOL_CATALOG__'),
      'lib/client.js still carries the build token; run: node scripts/build.mjs',
    )
  })

  it('carries a build stamp, not the placeholder', () => {
    // The stamp is how a stale page is recognised: a browser can keep an older
    // bundle in memory, which makes a fixed bug look present.
    assert.ok(!SOURCE.includes('__GIT_TOOL_BUILD__'), 'lib/client.js still carries the build token; run: node scripts/build.mjs')
    // A content digest, so rebuilding unchanged sources is byte-identical.
    assert.match(SOURCE, /const BUILD = "[0-9a-f]{12}"/)
  })

  it('embeds the operations the Host enforces', () => {
    // The embedded list comes from src/git-catalog.js, so the page cannot offer
    // an operation the Host would refuse.
    for (const name of ['status', 'commit', 'push', 'init']) {
      assert.ok(SOURCE.includes(`"name":"${name}"`), `the embedded catalog must contain ${name}`)
    }
  })
})

describe('client bundle: loading', () => {
  it('registers one module whose id is the package name', () => {
    assert.equal(loadPlugin().id, PACKAGE_NAME)
  })

  it('resolves every module it requires from the page', () => {
    assert.doesNotThrow(() => loadPlugin())
  })

  it('decodes every policy id the Host accepts', async () => {
    // The bug: nativeGitPolicy grew a fourth tier and the decoder kept validating
    // against the three-entry table, so "限制" rendered as "禁止" — a setting that
    // appeared to do nothing.
    const {
      NATIVE_GIT_POLICIES,
      GUARD_POLICIES,
      CONFIG_POLICIES,
      SCRIPT_CHECK_POLICIES,
    } = await import('../src/git-catalog.js')
    const { calls } = activate()
    const decode = calls.bindSpec.decode

    for (const id of NATIVE_GIT_POLICIES) {
      assert.equal(decode({ nativeGitPolicy: id }).nativeGitPolicy, id, `nativeGitPolicy "${id}" must survive decoding`)
    }
    // The tiers are gone: a row's boxes are what must survive decoding, because a stored
    // row that lost a box would silently deny (or silently allow) the wrong operation.
    const stored = decode({ pathRules: [{ path: '/x', read: true, write: false, ask: true }] })
    assert.deepEqual(
      stored.pathRules.map((row) => [row.path, row.read, row.write, row.ask]),
      [['/x', true, false, true]],
    )
    // The built-ins are re-added, so a document that dropped one cannot lose it.
    assert.ok(stored.pathRules.length > 1, 'the built-in rows come back')
    for (const id of CONFIG_POLICIES) {
      assert.equal(decode({ dangerousKeyPolicy: id }).dangerousKeyPolicy, id, `dangerousKeyPolicy "${id}" must survive decoding`)
    }
    for (const id of SCRIPT_CHECK_POLICIES) {
      assert.equal(decode({ scriptCheckPolicy: id }).scriptCheckPolicy, id, `scriptCheckPolicy "${id}" must survive decoding`)
    }

    // An unknown value still falls back rather than reaching the Host.
    assert.equal(decode({ nativeGitPolicy: 'nonsense' }).nativeGitPolicy, 'deny')
  })

  it('offers reading and clearing the log on its own tab', () => {
    const page = renderPage(activate().calls)
    const buttons = collect(page, (element) => element.type === 'button')
      .map((button) => button.children.join(''))
    assert.ok(buttons.includes('刷新'), 'a refresh action exists')
    assert.ok(buttons.includes('清空日志'), 'and a clear action')
    const box = collect(page, (element) => element.props?.className === 'git-tool-log')
    assert.equal(box.length, 1, 'the log has a display area')
  })

  it('paginates: one tab per group, and only the active panel is not hidden', () => {
    // The page listed 47 operations plus every strategy control in one column; the
    // tab bar is what keeps it readable. Hidden panels stay MOUNTED, so the content
    // assertions elsewhere in this file still see them.
    const { calls } = activate()
    const page = renderPage(calls)
    // Exact, because `git-tool-tabs` (the container) also starts with the same text.
    const tabs = collect(page, (element) => (element.props?.className ?? '').split(' ')[0] === 'git-tool-tab')
    assert.equal(tabs.length, 5, 'strategy / read / write / remote / log')
    assert.equal(tabs.filter((tab) => tab.props.className.includes('is-active')).length, 1)

    const panels = collect(page, (element) => element.props?.className === 'git-tool-tier')
    assert.equal(panels.length, 5, 'three tiers, the strategy card and the log tab')
    const visible = panels.filter((panel) => panel.props.hidden !== true)
    assert.equal(visible.length, 1, 'exactly one panel shows at a time')
    // Settings first: it is where a decision is waiting, and the operation lists are
    // reference material.
    assert.equal(tabs[0].children.join(''), '策略与代理')
    assert.equal(tabs[4].children.join(''), '日志')
    assert.equal(visible[0].props['data-tier'], undefined, 'the strategy card opens first')
  })

  it('warns about what the credential setting re-arms', () => {
    // Enabling it restores push, and also everything else ~/.gitconfig says. The
    // warning has to be on the page, not only in the README.
    const text = JSON.stringify(renderPage(activate({ useHostCredentials: true }).calls))
    assert.ok(text.includes('本机凭据'), 'the row renders')
    assert.ok(text.includes('url.<base>.insteadOf'), 'the redirect risk is named')
    assert.ok(text.includes('credential.helper'), 'the helper-is-a-program risk is named')
    assert.ok(text.includes('令牌'), 'and what still cannot be protected is named')
    // Present BEFORE it is switched on: a warning that appears only afterwards
    // cannot inform the decision it is about.
    const off = JSON.stringify(renderPage(activate().calls))
    assert.ok(off.includes('url.<base>.insteadOf'), 'the cost is readable while the setting is off')
  })

  it('gives each guard its own advice', () => {
    // Both rows once shared one hint, so a blocked READ of the credential file advised
    // "use git_exec" — which is the right advice for a git invocation and the wrong
    // advice for a read the tool performs for itself.
    const page = renderPage(activate().calls)
    const notes = collect(page, (element) => element.props?.className === 'git-tool-rowNote')
      .map((note) => note.children.join(''))
    // The native-git row explains the match trade-off; the path row explains why a read
    // is unnecessary at all. Different questions, different answers.
    assert.ok(notes.some((note) => note.includes('提到') && note.includes('也会被拒')), 'the native-git row states its cost')
    assert.ok(notes.some((note) => note.includes('认证由 git_exec 内部完成')), 'the path row explains why no read is needed')
    assert.notEqual(notes[0], notes[1], 'the two guards must not share one hint')
  })

  it('groups the settings instead of listing every control in one column', () => {
    const page = renderPage(activate().calls)
    const groups = collect(page, (element) => element.props?.className === 'git-tool-groupTitle')
    assert.deepEqual(
      groups.map((group) => group.children.join('')),
      // Document order: the settings tab first, then the log tab that follows it.
      ['插件', '审批', '闸门', '凭据', '代理', '仓库配置审计', '诊断日志'],
    )
    // Three-way choices are compact segmented buttons, not three radio rows each
    // carrying two lines of prose.
    const segments = collect(page, (element) => element.props?.className?.startsWith('git-tool-segItem') === true)
    // Native git has four tiers, credential paths three, dangerous keys four, and the
    // script check three — the toggles are checkboxes, not segments.
    assert.equal(segments.length, 20)
  })

  it('explains a non-JSON port-check answer instead of leaking a parse error', () => {
    // The concrete defect: an unmatched route answers with an EMPTY body, and calling
    // response.json() on it surfaced "Unexpected end of JSON input" — which names the
    // parser rather than the fix (a restart).
    const { exports } = loadPlugin()
    assert.equal(typeof exports.classifyJsonResponse, 'function')

    const live = exports.classifyJsonResponse(200, JSON.stringify({ port: 7897, listening: true, alternatives: [] }), 'n/a')
    assert.equal(live.ok, true)
    assert.equal(live.body.listening, true)

    const empty404 = exports.classifyJsonResponse(404, '', 'Host 侧没有这个检查路由（运行中的 Host 可能是重启前的版本），请重启 dsh web 后再试。')
    assert.equal(empty404.ok, false)
    assert.match(empty404.message, /重启 dsh web/)
    assert.ok(!empty404.message.includes('JSON input'), 'the parser wording must not reach the page')

    const html = exports.classifyJsonResponse(200, '<!doctype html>', 'n/a')
    assert.equal(html.ok, false)
    assert.match(html.message, /不是 JSON/)
  })

  it('offers a port test beside the field, so a wrong port is visible', () => {
    // The operator entered the wrong port and nothing in the page could have said so.
    const text = JSON.stringify(renderPage(activate().calls))
    assert.ok(text.includes('端口测试'), 'the test button renders')
  })

  it('renders the guard settings, including what they cannot do', () => {
    // The guard earns trust only if the page states its STRENGTH, so these assertions
    // check the wording that admits the limitation, not merely that rows rendered.
    const text = JSON.stringify(renderPage(activate().calls))
    assert.ok(text.includes('原生 git'), 'the native-git row renders')
    assert.ok(text.includes('受保护的路径'), 'the path list renders')
    // The wording moved into a collapsed details block, which keeps the nuance
    // reachable without owning the page.
    assert.ok(text.includes('策略闸门'), 'the page says this is a gate')
    assert.ok(text.includes('而非安全边界'), 'and that it is not a boundary')
    assert.ok(text.includes('git-tool-details'), 'the long explanation is collapsed')
  })

  it('declares exactly the services it reads, so activation waits for them', () => {
    // This assertion used to require NO inject — it locked in the regression that
    // made the page read-only. Without the declaration, apply can run before
    // settingsScope is registered, and every control then renders disabled.
    const { exports } = loadPlugin()
    assert.deepEqual(exports.inject, ['slots', 'settingsScope'])
    assert.equal(typeof exports.apply, 'function', 'apply must still be exported')
  })

  it('degrades to a no-op when module evaluation throws', () => {
    // A page that cannot answer `require('react')` is the cheapest real
    // evaluation failure; the factory must contain it and still answer a plugin.
    const { factory } = executeBundle(PAGE_MODULES)
    const broken = factory(() => {
      throw new Error('page cannot resolve module "react"')
    })
    assert.equal(typeof broken.apply, 'function', 'a degraded module still exports apply')
    assert.doesNotThrow(() => broken.apply({ effect: () => () => {}, get: () => undefined }))
  })

  it('keeps production errors out of the page', () => {
    // The wrapper logs via console.error, which must exist on the page.
    const { factory } = executeBundle(PAGE_MODULES)
    assert.doesNotThrow(() => factory(() => {
      throw new Error('boom')
    }))
  })
})

/**
 * Every control row in a rendered tree, at any depth.
 *
 * The strategy card nests its rows, so a direct-children lookup would silently
 * under-count and let a disabled control slip past an assertion.
 *
 * @param element - a rendered element tree.
 * @returns the elements whose className marks them as a control row.
 */
/**
 * Every element matching a predicate, at any depth.
 *
 * @param element - a rendered tree.
 * @param matches - the predicate.
 * @returns the matches.
 */
function collect(element, matches) {
  if (Array.isArray(element)) return element.flatMap((entry) => collect(entry, matches))
  if (element === null || element === undefined || typeof element !== 'object') return []
  const found = matches(element) ? [element] : []
  return found.concat((element.children ?? []).flatMap((child) => collect(child, matches)))
}

function controlRows(element) {
  // `.map()` yields a nested array, which React flattens at render time; a walker
  // that skips arrays would under-count and could miss a disabled control.
  if (Array.isArray(element)) return element.flatMap(controlRows)
  if (element === null || element === undefined || typeof element !== 'object') return []
  // Collected by MARKER, not by class name: an element marked `data-writes` changes
  // the settings document, which is precisely the set that has to follow canWrite.
  // A control that only reads (the port test) is deliberately not in it.
  const rows = element.props?.['data-writes'] === 'true' ? [element] : []
  return rows.concat((element.children ?? []).flatMap(controlRows))
}

/**
 * Render the page component registered during an activation.
 * @param calls - the recorded activation.
 * @returns the rendered element tree.
 */
function renderPage(calls) {
  const Wrapper = calls.registered.component
  const Page = Wrapper({}).children[0].type
  return Page({})
}

/**
 * Activate the plugin with the fake document installed, so the stylesheet the
 * bundle inserts is observable.
 * @param options - forwarded to loadPlugin.
 * @returns the loaded plugin plus the tags appended to the document.
 */
function activate(options) {
  const loaded = loadPlugin(options)
  const previous = globalThis.document
  globalThis.document = loaded.document
  try {
    loaded.exports.apply(loaded.ctx)
  } finally {
    globalThis.document = previous
  }
  return loaded
}

describe('client bundle: activation', () => {
  it('activates without throwing when both services are present', () => {
    const { calls } = activate()
    assert.deepEqual(calls.slots, ['settings.section'])
    assert.equal(calls.binds, 1)
  })

  it('reads every service through ctx.get, never as a property', () => {
    const { exports, ctx, calls } = loadPlugin()
    // The proxy throws on a property read, so a regression to `ctx.slots` fails
    // here with the field's exact error message.
    assert.doesNotThrow(() => exports.apply(ctx))
    for (const name of ['slots', 'settingsScope']) {
      assert.ok(calls.getCalls.includes(name), `apply must reach ${name} through ctx.get`)
    }
  })

  it('supplies a decoder, which is what keeps the controls enabled', () => {
    // Without a decoder the scope validates the section against the wire schema
    // and reports undefined when that fails, so the status never reaches ready
    // and every control renders disabled with no explanation.
    const { calls } = activate()
    assert.equal(typeof calls.bindSpec.decode, 'function', 'bind() must receive a decode function')
    const decoded = calls.bindSpec.decode({
      enabled: ['status', 'commit'],
      approveMutating: false,
      dangerousKeyPolicy: 'neutralize',
      useHostCredentials: true,
      nativeGitPolicy: 'ask',
      protectedPathsEnabled: false,
      credentialPolicy: 'ask',
      identityPolicy: 'allow',
      protectedPaths: ['~/.git-credentials'],
      scanScripts: false,
      scriptCheckPolicy: 'restrict',
      targetScope: 'allowlist',
      targetPaths: ['/work'],
      sshCommand: '/opt/ssh',
      pluginEnabled: false,
      logEnabled: false,
      logPath: '/tmp/probe.log',
      heartbeat: false,
      proxyPort: 7890,
      proxyCommand: 'my-proxy --port 7890',
    })
    assert.deepEqual(decoded, {
      enabled: ['status', 'commit'],
      approveMutating: false,
      dangerousKeyPolicy: 'neutralize',
      useHostCredentials: true,
      nativeGitPolicy: 'ask',
      protectedPathsEnabled: false,
      credentialPolicy: 'ask',
      identityPolicy: 'allow',
      protectedPaths: ['~/.git-credentials'],
      scanScripts: false,
      scriptCheckPolicy: 'restrict',
      targetScope: 'allowlist',
      targetPaths: ['/work'],
      sshCommand: '/opt/ssh',
      pluginEnabled: false,
      logEnabled: false,
      logPath: '/tmp/probe.log',
      heartbeat: false,
      proxyPort: 7890,
      proxyCommand: 'my-proxy --port 7890',
    })
  })

  it('decodes a missing or malformed section instead of failing the page', () => {
    const { calls } = activate()
    const decode = calls.bindSpec.decode
    for (const section of [undefined, null, [], 'nonsense', {}]) {
      const decoded = decode(section)
      assert.ok(Array.isArray(decoded.enabled), `decoding ${JSON.stringify(section)} must still yield a usable list`)
      assert.equal(typeof decoded.approveMutating, 'boolean')
    }
    const withJunk = decode({ enabled: ['status', 42, null, 'commit'], approveMutating: 'yes' })
    assert.deepEqual(withJunk.enabled, ['status', 'commit'], 'non-string names are dropped')
    assert.equal(withJunk.approveMutating, true, 'a non-boolean falls back to the safe default')
  })

  it('binds the namespace the Host half registers', () => {
    const { exports, ctx, calls } = loadPlugin()
    exports.apply(ctx)
    assert.equal(calls.namespace, 'git-tool')
  })

  it('keeps the controls usable when the client does not read the namespace back', () => {
    // THE REPORTED BUG: a non-loopback page reports memory persistence, so the
    // snapshot is 'unavailable' with no value. That means "not read back here",
    // NOT "not writable" — writes still travel to the Host. Disabling the controls
    // made the whole page read-only.
    const { calls } = activate({
      snapshot: { status: 'unavailable', value: undefined, revision: undefined, writable: false, mode: 'memory' },
    })
    const page = renderPage(calls)
    const controls = controlRows(page)
    assert.ok(controls.length >= 10, 'the toggles, the three selectors and the text fields render')
    for (const control of controls) {
      assert.notEqual(control.props.disabled, true, 'a memory-persistence page must still allow changes')
    }
    // The port test is a READ of the host's state, so it must not be disabled with
    // the settings document.
    // The port test stays usable even when the settings document cannot be written: it
    // only reads the host's state. The log tab's two buttons are reads as well.
    const buttons = collect(page, (element) => element.type === 'button' && element.props?.className === 'git-tool-testButton')
    assert.equal(buttons.length, 4, 'port test, refresh, clear and the ssh probe')
    for (const button of buttons) assert.notEqual(button.props.disabled, true)
  })

  it('disables the controls only when there is no settings service at all', () => {
    // With slots but no settingsScope the page still registers, against an inert
    // scope. That — and only that — is the disabled case.
    const { calls } = activate({ provide: ['slots'] })
    const page = renderPage(calls)
    const controls = controlRows(page)
    assert.ok(controls.length >= 10, 'the controls still render')
    for (const control of controls) {
      assert.equal(control.props.disabled, true, 'an inert scope is the only disabled case')
    }
  })

  it('shows the allowlist checkboxes enabled in memory mode too', () => {
    const { calls } = activate({
      snapshot: { status: 'unavailable', value: undefined, revision: undefined, writable: false, mode: 'memory' },
    })
    const page = renderPage(calls)
    const list = JSON.stringify(page)
    assert.ok(list.includes('git status'), 'the operations still render')
    assert.ok(!list.includes('"disabled":true'), 'no control is disabled in memory mode')
  })

  it('does not require the slots ledger to be present', () => {
    const { exports, ctx } = loadPlugin({ provide: ['settingsScope'] })
    assert.doesNotThrow(() => exports.apply(ctx), 'a missing slot ledger must not fail the load')
  })

  it('does not require the settings service to be present', () => {
    const { exports, ctx, calls } = loadPlugin({ provide: ['slots'] })
    assert.doesNotThrow(() => exports.apply(ctx), 'a missing settings service must not fail the load')
    assert.deepEqual(calls.slots, ['settings.section'], 'the page still registers, showing current state only')
  })

  it('activates with NO service at all', () => {
    const { exports, ctx } = loadPlugin({ provide: [] })
    assert.doesNotThrow(() => exports.apply(ctx))
  })

  it('inserts its own stylesheet, so the page is never unstyled', () => {
    // The regression this pins: the page rendered with no card, no border and no
    // spacing because the sheet went to a builtin a composition-loaded bundle
    // never receives.
    const { appended } = activate()
    assert.equal(appended.length, 1, 'exactly one style tag is appended')
    assert.equal(appended[0].tagName, 'style')
    const css = appended[0].textContent
    assert.ok(css.includes('.git-tool-tier{'), 'the tag carries the card rule')
    assert.ok(css.includes('.git-tool-itemBody{display:flex'), 'the tag carries the two-line rule')
    assert.ok(css.includes('@media (width <= 680px)'), 'the tag carries the narrow-screen rule')
  })

  it('inserts the stylesheet once, on the plugin\'s own lifecycle', () => {
    const loaded = loadPlugin()
    const previous = globalThis.document
    globalThis.document = loaded.document
    try {
      loaded.exports.apply(loaded.ctx)
      loaded.exports.apply(loaded.ctx)
    } finally {
      globalThis.document = previous
    }
    assert.equal(loaded.appended.length, 2, 'each activation inserts exactly one tag, never zero and never many')
  })

  it('registers the section as soon as the slot declaration arrives', () => {
    const { exports, ctx, calls } = loadPlugin()
    exports.apply(ctx)
    assert.equal(calls.registered.spec.name, 'settings.section')
    assert.equal(calls.registered.spec.id, 'git-tool')
  })

  it('registers the page behind an error boundary', () => {
    const { exports, ctx, calls } = loadPlugin()
    exports.apply(ctx)
    const element = calls.registered.component({})
    assert.equal(element.type.name, 'Boundary')
    assert.equal(typeof element.children[0].type, 'function')
  })

  it('degrades a render failure into page copy instead of a blank panel', () => {
    const { exports, ctx, calls } = loadPlugin()
    exports.apply(ctx)
    const Boundary = calls.registered.component({}).type
    assert.deepEqual(Boundary.getDerivedStateFromError(new Error('render exploded')), { error: 'render exploded' })
    const instance = new Boundary({ children: null })
    instance.state = { error: 'render exploded' }
    const tree = instance.render()
    assert.equal(tree.type, 'div')
    assert.ok(JSON.stringify(tree).includes('render exploded'), 'the card names the failure')
  })

  it('renders status copy before the catalog arrives', () => {
    const { exports, ctx, calls } = loadPlugin()
    exports.apply(ctx)
    const Page = calls.registered.component({}).children[0].type
    const tree = Page({})
    assert.equal(tree.props.className, 'git-tool-page')
    assert.ok(JSON.stringify(tree).includes('git-tool-status'))
    assert.ok(JSON.stringify(tree).includes('页面版本'), 'the page names the bundle it is running')
  })
})

describe('client bundle: declaration completeness', () => {
  it('never reaches a service as a bare ctx property', () => {
    // Comments explain this rule using the forbidden forms, so only shipped
    // CODE is judged — which is the thing that would actually run.
    const commentFree = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    // The list is explicit rather than regex-derived: this is the one rule that
    // cost two broken dsh boots, so it should read as a rule, not as a clever
    // scan. Any of these forms in the shipped source is a regression.
    const forbidden = [
      'ctx.slots',
      'ctx.settingsScope',
      'ctx.theme',
      'ctx.locale',
      'ctx.connection',
      'ctx.remote',
      'ctx.timer',
      'ctx.sessions',
      'ctx.layout',
      'ctx.styles',
    ]
    const code = commentFree(SOURCE)
    for (const form of forbidden) {
      assert.ok(
        !code.includes(form),
        `the client half mentions ${form}: a service must be reached with ctx.get('<name>'), because a ` +
          'client half loaded from a composition cannot declare services and must not read them as properties',
      )
    }
  })

  it('carries exactly the operations the Host source defines', () => {
    // The embedded catalog is generated FROM src/git-catalog.js, so this pins the
    // two together: a divergence would let the page offer an operation the Host
    // refuses, or hide one it allows.
    const source = readFileSync(fileURLToPath(new URL('../src/git-catalog.js', import.meta.url)), 'utf8')
    const embedded = JSON.parse(SOURCE.slice(SOURCE.indexOf('const CATALOG = ') + 'const CATALOG = '.length).split('\n')[0].replace(/;$/, ''))
    const embeddedNames = embedded.catalog
      .flatMap((tier) => tier.groups.flatMap((group) => group.operations.map((operation) => operation.name)))
      .sort()
    // Every host operation name must appear in the host source AND the artifact.
    const hostNames = [...source.matchAll(/\n        name: '([a-z-]+)',/g)].map((match) => match[1]).sort()
    assert.deepEqual(embeddedNames, hostNames, 'the embedded catalog must match src/git-catalog.js exactly')
    assert.ok(embedded.defaults.enabled.length > 0, 'the embedded defaults must carry the read tier')
  })
})
