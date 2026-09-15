/**
 * `git_exec` — a model-facing git tool for DeepSeek Harness that runs git
 * OUTSIDE the file sandbox, under a user-managed allowlist.
 *
 * Why it exists: the shipped `bash` tool runs under the session sandbox. A
 * bare repository's `.git` directory is a write target outside the session
 * workspace, and `git` itself writes to `.git`, `~/.gitconfig`, and object
 * packs — so repository work needs an executor that is deliberately not
 * confined, or it fails confusingly.
 *
 * What makes that safe is not confinement but this file's two gates:
 *
 * 1. An allowlist. Only subcommands the user ticked in the settings page can
 *    run at all; everything else is refused before a process is spawned.
 * 2. An argument gate. `git -c key=value` and the repository-redirecting global
 *    options are always refused, because either one turns an allowed
 *    subcommand into arbitrary command execution or into access to a different
 *    repository. The configuration this tool needs is injected through
 *    `GIT_CONFIG_KEY_n` in the child environment, which the caller cannot reach.
 *
 * The tool description and the system-prompt section are generated from the
 * live allowlist, so the model is told exactly which operations it may use
 * rather than discovering the answer by being refused.
 *
 * @module dsh-plugin-git-tool
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_ENABLED,
  OPERATIONS,
  OPERATION_NAMES,
  RISK,
  buildEnv,
  composeCommand,
  CONFIG_AUDIT_COMMAND,
  GUARD_POLICIES,
  DEFAULT_GUARD_POLICY,
  NATIVE_GIT_POLICIES,
  DEFAULT_NATIVE_GIT_POLICY,
  invokesGit,
  DEFAULT_PROTECTED_PATHS,
  containsNativeGit,
  mentionsProtectedPath,
  reachesProtectedPath,
  CONFIG_POLICIES,
  DEFAULT_CONFIG_POLICY,
  auditRepoConfig,
  describeCatalog,
  hardenArgv,
  parseConfigKeys,
  validateArgv,
} from './git-catalog.js'
import { probePort, proxyEnvironment, waitForPort } from './proxy.js'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve as resolvePath } from 'node:path'

export const name = 'git-tool'

/**
 * Hard dependencies.
 *
 * `settings` belongs here even though the code reaches it with `ctx.get` and
 * tolerates its absence: an undeclared service read answers `undefined`, so
 * leaving it out silently skips the namespace registration and turns the settings
 * page READ-ONLY with no error anywhere. Declaring it makes the resolution
 * explicit, and Cordis parks the plugin rather than letting it run half-wired.
 */
export const inject = ['tools', 'shell', 'systemPrompt', 'settings']

/** Namespace holding this tool's durable allowlist. */
const NAMESPACE = 'git-tool'

/** Risk tiers that a per-call approval covers when `approveMutating` is on. */
const APPROVAL_TIERS = new Set([RISK.write, RISK.remote])

/** Default invocation budget, and the budget for operations known to reach a remote. */
const DEFAULT_TIMEOUT_MS = 120_000
const REMOTE_TIMEOUT_MS = 300_000

/** Schema of the durable allowlist. */
export const Config = z.object({
  /**
   * Operations the model may invoke.
   *
   * The default carries the read tier — not the composition `base` layer alone.
   * Measured on a running profile: a schema whose `enabled` defaults to an empty
   * array resolves to `[]` for a namespace with no stored user section, so a
   * tool relying on `base` to supply the read defaults starts with NOTHING
   * enabled. The default belongs in the schema.
   *
   * Unknown names are ignored at enforcement time, so retiring a catalog entry
   * never strands a stored document.
   */
  enabled: z.array(z.string()).default([...DEFAULT_ENABLED]).description('Git subcommands the model is allowed to run.'),
  /** Ask the user before every state-changing or remote call. */
  approveMutating: z
    .boolean()
    .default(true)
    .description('Require a per-call user approval for write and remote operations.'),
  /**
   * How to treat repository configuration that can name a program, redirect a
   * command, or include configuration from elsewhere.
   *
   * The repository config sits inside the workspace, so the model can write it
   * directly. This audit is about refusing to RUN under such configuration, which
   * holds no matter who wrote it — and unlike the pinned keys, it also covers the
   * wildcard keys git resolves natively and no single override can neutralize.
   */
  dangerousKeyPolicy: z
    .union(CONFIG_POLICIES.map((policy) => z.const(policy)))
    .default(DEFAULT_CONFIG_POLICY)
    .description(
      'How a dangerous key in .git/config is handled: refuse-repo (default) refuses any call in that repository; '
        + 'refuse-affected refuses only the subcommands the key can influence; neutralize keeps the pinned keys working and refuses only the keys that cannot be pinned.',
    ),
  /**
   * What the guard does about git invoked through `bash`.
   *
   * The tool pipeline cannot REWRITE a call, only allow, refuse or ask — and routing a
   * shell command into this plugin is not possible either: the sandbox PATH holds
   * several git binaries and an absolute path bypasses any shim. So these three
   * verdicts are the honest options, and the refusal names `git_exec` as the way
   * forward.
   */
  nativeGitPolicy: z
    .union(NATIVE_GIT_POLICIES.map((policy) => z.const(policy)))
    .default(DEFAULT_NATIVE_GIT_POLICY)
    .description(
      'What to do when bash is used to run git: deny (default, broad match — refuses a mere mention too), '
        + 'restrict (refuses only a real command position: no false refusals, may miss an obfuscated form), '
        + 'ask, or allow. git_exec is the supported path and passes the allowlist, the argument gate, the audit and approval.',
    ),
  /**
   * What the guard does about the machine credential and identity files.
   *
   * `deny` and `ask` cover the tools whose arguments name a path, plus shell text
   * that mentions one. It is a filter over ARGUMENTS: a caller that derives the path at
   * runtime is not stopped, which is why this is documented as a rule and not a
   * boundary.
   */
  pathGuardPolicy: z
    .union(GUARD_POLICIES.map((policy) => z.const(policy)))
    .default(DEFAULT_GUARD_POLICY)
    .description('What to do when a tool call names a protected credential path: deny (default), ask, or allow.'),
  /** The paths the guard protects. */
  protectedPaths: z
    .array(z.string())
    .default([...DEFAULT_PROTECTED_PATHS])
    .description('Paths whose contents are credentials or identity. A path argument that IS one of them, or CONTAINS one, is refused; shell text that names one is refused too.'),
  /**
   * Port for the operator's OWN proxy, which this plugin starts and nothing more.
   *
   * The plugin never proxies traffic and never holds a credential: the token stays
   * with whatever the start command launches. 0 disables the feature, and git then
   * inherits whatever proxy variables the dsh process already has.
   */
  /**
   * Let git read the machine's own credential configuration.
   *
   * Off by default: with it off, the global and system configuration are hidden and
   * `credential.helper` is cleared, so this tool cannot authenticate anywhere. With
   * it on, remote writes become possible — and the secret stays out of argv, the
   * approval prompt and the transcript, because git reads it itself.
   *
   * WARNING: it also re-arms everything else the global config says, which the
   * hiding was suppressing — `url.<base>.insteadOf` can redirect a host, and a
   * credential helper is a program git executes.
   */
  useHostCredentials: z
    .boolean()
    .default(false)
    .description('Let git use the machine credential helper/config so remote writes (push) can authenticate. Off: this tool cannot push at all. On: everything in ~/.gitconfig becomes effective again, including url.insteadOf and any helper program.'),
  proxyPort: z
    .number()
    .default(0)
    .description('Port of your own proxy on 127.0.0.1. The plugin starts it with the command below and points git at it. 0 disables this.'),
  /**
   * The command that starts that proxy.
   *
   * This is TRUSTED CONFIGURATION: the plugin executes it as written. Only the
   * operator can set it — the model cannot write the settings document (its file
   * policy confines writes to the session workspace).
   */
  proxyCommand: z
    .string()
    .default('')
    .description('Shell command that starts your proxy on the port above, run once on the first remote operation. Leave empty to start it yourself.'),
})

/** The composition-default policy: the read tier, approval on, audit at its strictest. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: DEFAULT_ENABLED,
  approveMutating: true,
  dangerousKeyPolicy: DEFAULT_CONFIG_POLICY,
  useHostCredentials: false,
  nativeGitPolicy: DEFAULT_NATIVE_GIT_POLICY,
  pathGuardPolicy: DEFAULT_GUARD_POLICY,
  protectedPaths: DEFAULT_PROTECTED_PATHS,
  proxyPort: 0,
  proxyCommand: '',
})

/**
 * One-line-per-group rendering of an operation name list, used by both the tool
 * description and the prompt section.
 * @param names - enabled operation names.
 * @returns grouped text, or an empty string when nothing is enabled.
 */
function renderEnabled(names) {
  const enabled = new Set(names)
  const lines = []
  for (const tier of describeCatalog()) {
    for (const group of tier.groups) {
      const rows = group.operations.filter((operation) => enabled.has(operation.name))
      if (rows.length === 0) continue
      lines.push(`${group.group}: ${rows.map((operation) => operation.name).join(', ')}`)
    }
  }
  return lines.join('\n')
}

/**
 * Build the model-facing tool description from the live allowlist.
 *
 * The description is re-derived on every read (the definition carries an
 * accessor), so flipping a checkbox changes what the model is told without
 * re-registering the tool.
 * @param enabled - currently enabled operation names.
 * @returns the description text sent to the model.
 */
function describeTool(enabled) {
  const enabledText = renderEnabled(enabled)
  const disabledCount = OPERATION_NAMES.length - new Set(enabled).size
  const allowed =
    enabled.length === 0
      ? 'NO git operation is currently enabled, so every call fails. Tell the user which operation they need and where to enable it (Settings -> Git 工具, or the Cordis panel).'
      : `Currently ENABLED operations (this is the complete list; any other subcommand is refused):\n${enabledText}`
  return [
    'Run one git command and return its stdout/stderr. The command executes OUTSIDE the file sandbox, under an allowlist the user controls — so it can commit in a repository outside the session workspace, and it never needs sandbox escalation.',
    allowed,
    disabledCount === 0
      ? 'Every other operation is also enabled.'
      : `${disabledCount} further operation(s) exist in the catalog but are DISABLED by the user. If the task needs one, ask the user to enable it; do not try to reach it through another command, and do not use \`bash\` for it (the sandbox will deny repository writes).`,
    'Arguments: put the subcommand and its arguments in `argv`, and file paths in `paths`. Example: {"argv":["add","--all"],"paths":["src/app.js"]} runs `git add --all -- src/app.js`. Use `paths` rather than embedding paths in `argv` — it needs no quoting and survives spaces and glob characters.',
    'Refused outright: `-c`/`--config-env` (configuration injection can execute programs) and the repository-redirecting global options (`-C`, `--git-dir`, `--work-tree`, `--exec-path`, ...). The tool already forces a non-interactive environment: no pager, no editor, no terminal prompt, no repository hooks, and no global credential helper.',
    'Report the `[exit code: N]` marker rather than assuming success. Non-zero exits are results, not tool failures: read the stderr and react.',
  ].join('\n\n')
}

/**
 * Shape a settled run into the model-facing text.
 * @param result - the `ctx.shell.run` outcome.
 * @returns stdout, then a marked stderr section, then status markers.
 */
function renderRun(result) {
  const stream = (output) => (output.truncated ? `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]` : output.text)
  const out = stream(result.stdout)
  const err = stream(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/** Validate one call's arguments against the declared tool schema and the argv rules. */
function checkArgs(args) {
  if (typeof args !== 'object' || args === null) throw new Error('invalid arguments: expected an object')
  const { argv, paths, description, workdir, timeoutMs, justification } = args
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty sentence describing what this git command does')
  }
  if (paths !== undefined && (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string'))) {
    throw new Error('invalid paths: expected an array of path strings')
  }
  if (workdir !== undefined && (typeof workdir !== 'string' || workdir.trim().length === 0)) {
    throw new Error('invalid workdir: expected a non-empty directory path')
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(timeoutMs)}`)
  }
  if (justification !== undefined && typeof justification !== 'string') throw new Error('invalid justification: expected a string')
  const verdict = validateArgv(argv)
  if (!verdict.ok) throw new Error(verdict.reason)
  return { verdict, paths: paths ?? [], description, workdir, timeoutMs, justification }
}

/** The prompt section text: which git operations this agent may use right now. */
function promptText(enabled) {
  if (enabled.length === 0) {
    return 'The `git_exec` tool is composed, but the user has enabled no git operation: every call is refused. Ask the user to enable the operations you need before attempting git work.'
  }
  return [
    'Use `git_exec` for repository work, not `bash`: `git_exec` runs outside the file sandbox, while `bash` cannot write `.git` or any path outside the session workspace, and a sandbox denial there is not a reason to retry with escalation.',
    'Native git through `bash` is intercepted by a tool guard, and so is any attempt to read the machine credential files. Neither is a workaround: use `git_exec`, which is the supported path and passes the allowlist, the argument gate, the audit and approval.',
    `The user currently allows: ${renderEnabled(enabled).split('\n').join(' | ')}. A subcommand outside that list is refused — ask the user to enable it instead of working around it.`,
    'Put paths in `paths`, not in `argv`. Never pass `-c` or a repository-redirecting global option; the tool refuses them.',
  ].join(' ')
}

/**
 * Register the `git_exec` tool, its settings namespace, and its prompt section.
 *
 * A failure here is CONTAINED, not propagated: this plugin deliberately runs
 * outside the sandbox, so a partial registration would leave a tool that is
 * advertised but half-initialised, and letting the throw escape the loader is
 * worse still — it can cost the whole profile its boot, which is a plugin bug
 * presenting as a broken harness and needs out-of-band file surgery to undo. The
 * failure is logged loudly, the tool is not registered, and the session keeps
 * working without it.
 *
 * @param ctx - the plugin context.
 * @param entry - composition entry config, used as the settings base layer.
 */
export function apply(ctx, entry = {}) {
  try {
    setup(ctx, entry)
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(
      `git-tool: activation failed, so the git_exec tool is NOT available and every git operation is refused. ` +
        `Fix this plugin or disable its row (set "disabled: !!js process.env.DSH_GIT_TOOL_DISABLED === '1'" on the ` +
        `tool-git row) and restart dsh. Cause: ${detail}`,
    )
  }
}

/**
 * Activation without the containment wrapper.
 *
 * The tests go through this so a broken fixture fails the suite instead of being
 * swallowed by {@link apply}'s catch — otherwise a test that accidentally broke
 * the plugin would just report "git_exec is not registered" and hide the cause.
 * Production always goes through {@link apply}.
 *
 * @param ctx - the plugin context.
 * @param entry - composition entry config, used as the settings base layer.
 */
export function applyUnguarded(ctx, entry = {}) {
  setup(ctx, entry)
}

/**
 * Bind the settings scope, with the composition entry as the fallback policy.
 * @param ctx - the plugin context.
 * @param base - the composition defaults for this namespace.
 * @returns the mutable state holder the gates read.
 */
function bindPolicy(ctx, base) {
  const state = { current: normalizePolicy(base), update: undefined }
  // Declared: read the service directly. The optional read stays as a fallback so
  // this half also works in a composition without one (a headless test boot, for
  // instance), where the composition entry is then the whole policy.
  const settings = ctx.settings ?? ctx.get('settings')
  if (settings === undefined) return state
  const scope = settings.register(NAMESPACE, Config, { base, applies: 'live' })
  ctx.effect(() => {
    state.current = normalizePolicy(scope.get())
    const off = scope.watch((value) => {
      state.current = normalizePolicy(value)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, 'git-tool: settings scope')
  state.update = (patch) => settings.update(NAMESPACE, patch)
  return state
}

/**
 * The one place a stored allowlist becomes the enforced one.
 * @param value - a resolved settings section, or the composition entry.
 * @returns the policy the gates read: unknown names dropped, booleans strict.
 */
function normalizePolicy(value) {
  const enabled = Array.isArray(value?.enabled)
    ? value.enabled.filter((item) => typeof item === 'string' && OPERATIONS.has(item))
    : [...DEFAULT_ENABLED]
  return {
    enabled,
    approveMutating: value?.approveMutating !== false,
    dangerousKeyPolicy: CONFIG_POLICIES.includes(value?.dangerousKeyPolicy) ? value.dangerousKeyPolicy : DEFAULT_CONFIG_POLICY,
    useHostCredentials: value?.useHostCredentials === true,
    nativeGitPolicy: NATIVE_GIT_POLICIES.includes(value?.nativeGitPolicy)
      ? value.nativeGitPolicy
      : DEFAULT_NATIVE_GIT_POLICY,
    pathGuardPolicy: GUARD_POLICIES.includes(value?.pathGuardPolicy) ? value.pathGuardPolicy : DEFAULT_GUARD_POLICY,
    protectedPaths: Array.isArray(value?.protectedPaths)
      ? value.protectedPaths.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      : [...DEFAULT_PROTECTED_PATHS],
    proxyPort: Number.isInteger(value?.proxyPort) && value.proxyPort >= 0 && value.proxyPort <= 65535 ? value.proxyPort : 0,
    proxyCommand: typeof value?.proxyCommand === 'string' ? value.proxyCommand : '',
  }
}

/**
 * The real activation: settings scope, tool, prompt section, catalog RPC.
 * @param ctx - the plugin context.
 * @param entry - composition entry config, used as the settings base layer.
 */
/**
 * Make sure the operator's proxy is running and return the environment that points
 * git at it.
 *
 * `state` is created PER ACTIVATION and passed in: a module-level flag would be
 * shared by every activation and every session, so one of them would believe a
 * proxy is already running when it is not — and the disposer that stops the process
 * belongs to one fiber anyway.
 *
 * A port that is ALREADY LISTENING is the normal case, not a conflict: it means the
 * operator's proxy is up, so git is pointed at it and nothing is started.
 *
 * @param ctx - the plugin context.
 * @param state - this activation's proxy state.
 * @param policy - the live policy.
 * @param signal - the call's abort signal, for the startup wait.
 * @returns `{ ok: true, env }`, or `{ ok: false, reason }` naming what to fix.
 */
async function ensureProxy(ctx, state, policy, signal) {
  const port = policy.proxyPort
  if (!Number.isInteger(port) || port <= 0) return { ok: true, env: {} }
  const host = '127.0.0.1'
  const env = proxyEnvironment(host, port)

  // Already resolved by this activation: nothing to probe again.
  if (state.mode !== undefined) return { ok: true, env }

  /*
   * Something is listening: treat it as the proxy and use it.
   *
   * This is deliberate rather than a guess — the checkout is "the operator runs a
   * proxy and does not want to export HTTPS_PROXY before starting dsh", and a proxy
   * that is already up is the case that motivates the setting. The probe cannot
   * prove WHAT is listening, so the note below says which port was used, and a wrong
   * guess shows up as a failed request rather than as silence.
   */
  if (await probePort(host, port)) {
    state.mode = 'external'
    return { ok: true, env }
  }

  const command = policy.proxyCommand.trim()
  if (command.length === 0) {
    return {
      ok: false,
      reason:
        `${host}:${String(port)} 上没有代理在监听，而设置里没有填「代理启动命令」，插件不知道要拉起什么。` +
        '请先启动代理（或填写启动命令）。',
    }
  }

  let process
  try {
    process = ctx.shell.start(ctx.shell.resolve({
      command,
      timeoutMs: 0,
      ...(signal !== undefined ? { signal } : {}),
      // The proxy is a long-lived process of the operator's own; it is not a git
      // invocation, so none of the git hardening applies to it.
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '' },
    }))
  } catch (error) {
    return { ok: false, reason: `代理启动命令执行失败：${error instanceof Error ? error.message : String(error)}` }
  }

  state.process = process
  ctx.effect(() => () => {
    // Stop exactly what this activation started. A proxy that was already running
    // is the operator's, and stopping it here would be a surprise.
    if (state.mode === 'started' && state.process !== undefined) state.process.kill()
    state.mode = undefined
    state.process = undefined
  }, 'git-tool: proxy process')

  if (!(await waitForPort(host, port, 8000, signal))) {
    process.kill()
    state.mode = undefined
    state.process = undefined
    const output = process.readOutput().delta.trim().slice(0, 300)
    return {
      ok: false,
      reason:
        `代理启动后 ${host}:${String(port)} 在 8 秒内没有开始监听` +
        (output.length > 0 ? `。进程输出：${output}` : '。请检查启动命令与端口是否一致。'),
    }
  }

  state.mode = 'started'
  return { ok: true, env }
}

/**
 * Ports worth naming when the configured one has no listener.
 *
 * The point is to answer "then WHICH port?", which is the question a wrong entry
 * actually raises — it is how the operator's 7890-versus-7897 mistake would have been
 * caught in one click.
 */
const COMMON_PROXY_PORTS = Object.freeze([7890, 7897, 7891, 10808, 10809, 1080, 8889, 8080, 20171])

/** The route the settings page asks for a port verdict. */
const PROXY_CHECK_PATH = '/git-tool/proxy-check'

/**
 * Probe the configured proxy port, and look for a better answer when it is dead.
 *
 * @param port - the port to test.
 * @param commandConfigured - whether a start command is set, which changes the advice.
 * @param effective - whether this is the port the plugin will actually use.
 * @returns the report the page renders.
 */
async function buildProxyReport(port, commandConfigured, effective) {
  const listening = await probePort('127.0.0.1', port, 600)
  let alternatives = []
  if (!listening) {
    // Probing in parallel keeps the button responsive; several ports that refuse
    // immediately cost nothing, and the worst case is one timeout.
    const results = await Promise.all(
      COMMON_PROXY_PORTS.filter((candidate) => candidate !== port).map(async (candidate) => ({
        candidate,
        listening: await probePort('127.0.0.1', candidate, 250),
      })),
    )
    alternatives = results.filter((row) => row.listening).map((row) => row.candidate)
  }
  return { port, listening, alternatives, commandConfigured, effective }
}

/**
 * Expand one configured path to an absolute path, following symlinks when it exists.
 *
 * The symlink step is what makes "link the credential into the workspace, then read
 * the link" land on the same answer.
 *
 * @param entry - a configured path, possibly tilde-prefixed.
 * @returns the absolute path.
 */
function absoluteProtectedPath(entry) {
  const expanded = entry.startsWith('~/') ? resolvePath(homedir(), entry.slice(2)) : entry
  const absolute = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(homedir(), expanded)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/**
 * Resolve a tool's path argument the way the tool would.
 * @param raw - the argument as the model wrote it.
 * @param cwd - the session workspace, used for relative arguments.
 * @returns the absolute path, symlinks followed when it exists.
 */
function absoluteCandidatePath(raw, cwd) {
  const expanded = raw.startsWith('~/') ? resolvePath(homedir(), raw.slice(2)) : raw
  const absolute = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/**
 * Turn a configured verdict into a waterfall decision.
 * @param policy - deny, ask, or allow.
 * @param reason - what to tell the model.
 * @returns the decision, or undefined to delegate.
 */
function guardDecision(policy, reason) {
  if (policy === 'deny') return { kind: 'deny', reason }
  if (policy === 'ask') return { kind: 'ask', reason }
  return undefined
}

/**
 * Decide one pending tool call.
 *
 * @param execution - the pending call.
 * @param current - the live policy.
 * @returns a deny/ask decision, or undefined to let the call proceed.
 */
function inspectToolCall(execution, current) {
  const args = execution.arguments
  if (args === null || typeof args !== 'object') return undefined
  const session = execution.agent == null ? undefined : execution.agent.session
  const cwd = session == null ? process.cwd() : session.header.cwd
  const protectedFiles = current.protectedPaths.map((entry) => absoluteProtectedPath(entry))

  if (execution.name === 'bash') {
    const command = typeof args.command === 'string' ? args.command : ''
    if (current.nativeGitPolicy !== 'allow') {
      /*
       * The tier decides BOTH what counts as an invocation and what to do about it.
       * deny/ask use the broad matcher (a mention counts); restrict uses the
       * command-position matcher, which never refuses a mere mention.
       */
      const narrow = current.nativeGitPolicy === 'restrict'
      const matched = narrow ? invokesGit(command) : containsNativeGit(command)
      if (matched) {
        return guardDecision(
          current.nativeGitPolicy === 'ask' ? 'ask' : 'deny',
          'bash 里的原生 git 已被本插件拦截（当前策略：'
            + current.nativeGitPolicy
            + (narrow ? '，只在命令位置判定' : '，出现 git 调用即判定')
            + '）。请改用 git_exec：它有允许清单、参数闸门、配置审计与逐次审批，bash 里的 git 会绕过全部这些闸门。'
            + (current.nativeGitPolicy === 'ask' ? '（若确实需要，请在审批中确认。）' : ''),
        )
      }
    }
    if (mentionsProtectedPath(command, current.protectedPaths)) {
      return guardDecision(
        current.pathGuardPolicy,
        `这条命令提到了受保护的凭据路径（当前保护：${current.protectedPaths.join('、')}）。凭据不需要进入你的上下文 —— 推送认证由 git_exec 内部自行完成。`
          + (current.pathGuardPolicy === 'ask' ? '（当前策略为「询问」。）' : ''),
      )
    }
  }

  for (const key of ['file_path', 'path']) {
    const raw = args[key]
    if (typeof raw !== 'string' || raw.length === 0) continue
    const reached = reachesProtectedPath(absoluteCandidatePath(raw, cwd), protectedFiles)
    if (reached !== undefined) {
      return guardDecision(
        current.pathGuardPolicy,
        `「${reached}」是本机的 git 凭据/身份文件，已被本插件保护。它不需要进入你的上下文：认证由 git_exec 内部的 git 自行读取。`
          + (current.pathGuardPolicy === 'ask' ? '（当前策略为「询问」：若确实需要，请在审批中确认。）' : ''),
      )
    }
  }
  return undefined
}


function setup(ctx, entry = {}) {
  const base = { ...DEFAULT_CONFIG, ...entry }
  // The HOST-side settings scope is a narrower API than the browser one: it
  // exposes `get()`, `watch()`, `update()`, and `replace()` — not
  // `subscribe()`/`set()`. Reads go through `get()`, and a change is a namespace
  // `update`, which is what makes the value durable in the profile's
  // `settings.yaml`.
  const policy = bindPolicy(ctx, base)
  /**
   * This activation's proxy lifecycle.
   *
   * `mode` says where the proxy came from: `external` means it was already
   * listening (so this activation must never stop it), `started` means this
   * activation ran the command (so it must stop it when the plugin goes away).
   */
  /**
   * The port-test route behind the settings page's "test" button.
   *
   * Same-origin, so the page's own fetch reaches it; optional, because a profile
   * without a web server simply has no page to serve the button to.
   */
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: PROXY_CHECK_PATH,
      handler: async (req, res) => {
        /** One JSON response, with the headers a fetch from the page needs. */
        const respond = (payload, status = 200) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(payload))
        }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const port = Number.parseInt(url.searchParams.get('port') ?? '', 10)
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            respond({ error: '端口无效：需要 1-65535 之间的整数。' }, 400)
            return
          }
          const current = policy.current
          respond(await buildProxyReport(port, current.proxyCommand.trim().length > 0, current.proxyPort === port))
        } catch (error) {
          respond({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'git-tool: proxy check route')
  }

  /**
   * The tool guard.
   *
   * `tools/pre-execute` is a waterfall EVENT, which is what makes it reachable: the
   * service method `ctx.tools.guard` is not exposed to a plugin's curated view. The
   * listener delegates by default and absorbs its own failures — a throwing guard
   * would break every tool call in the session.
   */
  ctx.on('tools/pre-execute', (execution, next) => {
    try {
      const decision = inspectToolCall(execution, policy.current)
      if (decision !== undefined) return decision
    } catch (error) {
      // Absorbed on purpose: a throwing guard would take down every tool call in the
      // session. The trade-off is that a BROKEN guard looks like a permissive one, so
      // the unit tests drive this listener directly — that is what catches a guard
      // that has stopped judging.
      ctx.logger?.warn?.(`git-tool: the tool guard failed and delegated: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  const proxy = { mode: undefined, process: undefined }

  // ── model-facing tool ─────────────────────────────────────────────────────
  // `defineTool` SNAPSHOTS `description` into the definition it returns, so a
  // plain literal would freeze the allowlist text at load time. The accessor is
  // re-installed on the returned definition below; every schema projection reads
  // `definition.description` afresh (`ToolRuntime.schemaOf` destructures it), so
  // the model sees the current allowlist on its next step.
  const definition = defineTool({
    name: 'git_exec',
    description: describeTool(policy.current.enabled),
    parameters: {
      argv: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'The git arguments AFTER the program name: subcommand first. Example: ["commit", "-m", "fix: typo"], ["log", "--oneline", "-n", "20"], ["status", "--porcelain"].',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'File or directory paths for this command, appended after `--`. Preferred over embedding paths in `argv`: no quoting needed for spaces, globs, or leading dashes. Example: ["src/app.js", "src/lib"] with argv ["add"].',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Example: "Show working tree status".',
      },
      workdir: {
        type: 'string',
        description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
      },
      timeoutMs: {
        type: 'number',
        description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} for local operations and ${REMOTE_TIMEOUT_MS} for operations that reach a remote.`,
      },
      justification: {
        type: 'string',
        description: 'Required with an approval prompt: one sentence for the user explaining why this exact operation is needed.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer' },
          signal: { type: 'string' },
          timedOut: { type: 'boolean', required: true },
          operation: { type: 'string', required: true },
          command: { type: 'string', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render(args, value) {
        const text = renderRun({
          exitCode: value.exitCode ?? 0,
          signal: value.signal ?? null,
          timedOut: value.timedOut,
          timeoutMs: 0,
          stdout: { text: value.stdout, truncated: false },
          stderr: { text: value.stderr, truncated: false },
        })
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const { verdict, paths, workdir, timeoutMs, justification } = checkArgs(args)
      const { operation } = verdict
      const name = operation.name
      /*
       * The FORM can outrank the operation's declared tier: `branch` is a read while
       * `branch <name>` creates a ref, and `tag` likewise. A mutating form is
       * treated as the write tier, so it passes the approval gate rather than
       * slipping through the read tier unapproved.
       */
      const risk = verdict.mutating === true ? RISK.write : operation.risk

      // The shell's own default workdir is the PROCESS cwd, not the session
      // workspace (measured: `ctx.shell.resolve({}).workdir` answers the cwd dsh
      // was launched from). Defaulting to it would silently run git in the wrong
      // repository, so the session's cwd is resolved here. When neither the call
      // nor the session supplies one, no workdir is sent at all and the executor
      // applies its own default.
      //
      // The agent is read with a nullish guard because it is absent for a
      // non-session execution and may be explicitly null on a transport
      // sub-dispatch; either way there is no session workspace to inherit.
      const session = exec.agent == null ? undefined : exec.agent.session
      const workspaceRoot = session == null ? undefined : session.header.cwd
      const targetWorkdir = workdir ?? workspaceRoot

      // Gate 1 — the allowlist.
      if (!policy.current.enabled.includes(name)) {
        throw new Error(
          `git ${name} is not enabled by the user, so it will not run. ` +
            `Enabled now: ${policy.current.enabled.length === 0 ? '(none)' : policy.current.enabled.join(', ')}. ` +
            'Ask the user to enable this operation in the git tool settings (Settings -> Git 工具). Do not try to reach the same effect through another enabled subcommand or through bash.',
        )
      }

      // Gate 2 — the repository's own configuration must be safe to run under.
      const auditRefusal = await auditRepositoryConfig(ctx, exec, name, policy.current.dangerousKeyPolicy, targetWorkdir, workspaceRoot)
      if (auditRefusal !== null) throw new Error(auditRefusal)

      // Gate 3 — per-call approval for state-changing work, when the user asked for it.
      if (policy.current.approveMutating && APPROVAL_TIERS.has(risk)) {
        const approval = ctx.get('approval')
        if (approval === undefined) {
          throw new Error(`git ${name} needs user approval (approveMutating is on) but no approval service is composed; enable it in the git tool settings or disable approveMutating`)
        }
        if (exec.agent === undefined) throw new Error(`git ${name} needs user approval but this call has no agent to route it through`)
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: 'git_exec',
          callId: exec.callId,
          reason: `git ${name} (${risk} operation): ${justification ?? args.description}`,
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          throw new Error(`git ${name} was not approved: ${approvalRefusal(outcome, ctx, exec)}`)
        }
      }

      // Compose the exact command. Caller paths travel as separate argv
      // entries after `--`, so quoting and leading dashes stop mattering, and
      // diff-producing subcommands carry the flags that keep a configured
      // external driver from running.
      const fullArgv = hardenArgv(composeWithPaths(args.argv, paths))
      const command = composeCommand(fullArgv)

      // Only the operations that actually reach a remote need a proxy; `gc`,
      // `clean` and friends sit in the same tier but stay local.
      let proxyEnv = {}
      if (operation.remote === true) {
        const started = await ensureProxy(ctx, proxy, policy.current, exec.signal)
        if (!started.ok) throw new Error(`git ${name} 未执行：${started.reason}`)
        proxyEnv = started.env
      }

      const budget = timeoutMs ?? (operation.remote === true ? REMOTE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
      const resolved = ctx.shell.resolve({
        command,
        ...(targetWorkdir !== undefined ? { workdir: targetWorkdir } : {}),
        timeoutMs: budget,
        signal: exec.signal,
        env: { ...buildEnv({ hostCredentials: policy.current.useHostCredentials }), ...proxyEnv },
        // The one deliberate bypass in this plugin. `resolve()` would otherwise
        // stamp the deployment policy (measured as `workspace-write` rooted at
        // the process cwd), and that policy denies `.git` outside it — the whole
        // reason this tool exists. What replaces confinement is the allowlist
        // gate above: only a user-ticked subcommand reaches this line, and only
        // with arguments that passed `validateArgv`.
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspaceRoot ?? targetWorkdir ?? '' },
      })

      let result
      try {
        result = await ctx.shell.run(resolved)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`git ${name} could not start: ${detail}`)
      }

      return {
        exitCode: result.exitCode ?? 0,
        ...(result.signal !== null ? { signal: result.signal } : {}),
        timedOut: result.timedOut,
        operation: name,
        command,
        stdout: result.stdout.text,
        stderr: result.stderr.text,
      }
    },
  })

  // Re-install the live accessor that `defineTool` snapshotted, so the model is
  // told the CURRENT allowlist rather than the one in force at load time.
  Object.defineProperty(definition, 'description', {
    configurable: true,
    enumerable: true,
    get: () => describeTool(policy.current.enabled),
  })
  ctx.tools.register(definition)

  // ── prompt section: the same allowlist, stated where the model plans ─────
  ctx.systemPrompt.section({
    name: 'tool:git_exec',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
    text: () => promptText(policy.current.enabled),
  })
}
/**
 * Audit the target repository's configuration before running a subcommand.
 *
 * Two details decide whether this is real or theatre:
 *
 *  - The listing MUST pass `--includes`. A plain `--local --list` hides keys that
 *    arrived through an `[include]` directive, and an included `core.fsmonitor`
 *    was measured executing while staying invisible to `--local --list` — an
 *    audit without `--includes` would miss exactly the values that run.
 *  - A failure to READ the configuration is not treated as a refusal, and that is
 *    not a bypass: a directory that is not a repository has no configuration, and
 *    a configuration git cannot parse makes every git command in that repository
 *    fail, including the one this gate protects.
 *
 * @param ctx - the plugin context.
 * @param exec - the call being gated.
 * @param subcommand - the subcommand about to run.
 * @param policy - the configured verdict (see {@link CONFIG_POLICIES}).
 * @param workdir - the resolved working directory, when one is known.
 * @param workspaceRoot - the session workspace, for the sandbox policy.
 * @returns a refusal message, or null when the call may proceed.
 */
async function auditRepositoryConfig(ctx, exec, subcommand, policy, workdir, workspaceRoot) {
  /*
   * Loud, and OUTSIDE the try below.
   *
   * The catch under this line treats every failure as "this directory has no
   * configuration to read", which is the right fail-open for an unavailable shell —
   * but it also swallowed a programming error once: the parameter named `policy`
   * here is the dangerous-key STRING, and a refactor passed the settings OBJECT
   * instead. The resulting TypeError made the gate skip every call while every test
   * that asserted behaviour on a hostile repository still passed.
   *
   * A type that cannot be a policy is a bug in this file, not an unreadable
   * repository, so it must not be absorbed.
   */
  // Off means off: no shell call, no refusal. It is the operator's explicit choice,
  // so it must not be silently equivalent to "audit ran and found nothing".
  if (policy === 'off') return null
  if (typeof policy !== 'string' || !CONFIG_POLICIES.includes(policy)) {
    throw new TypeError(`git-tool internal error: the repository-config audit needs a policy name, received ${typeof policy}`)
  }
  let spec
  let result
  try {
    spec = ctx.shell.resolve({
      command: CONFIG_AUDIT_COMMAND,
      ...(workdir !== undefined ? { workdir } : {}),
      timeoutMs: 15_000,
      signal: exec.signal,
      /*
       * Deliberately NOT `hostCredentials`: the audit reads the repository's own
       * configuration, and letting the machine's file in would make the user's own
       * `credential.helper` match a dangerous-key rule and refuse every call.
       */
      env: buildEnv(),
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspaceRoot ?? workdir ?? '' },
    })
    result = await ctx.shell.run(spec)
  } catch {
    return null
  }
  if (result.exitCode !== 0) return null

  const verdict = auditRepoConfig(parseConfigKeys(result.stdout.text), subcommand, policy)
  if (verdict.ok) return null
  return `git ${subcommand} was not run: ${verdict.reason}`
}

/**
 * Explain a non-granting approval outcome.
 *
 * "the user did not approve" was misleading: a session whose approval policy is
 * `never` is never asked, and the operator then has no idea which switch to
 * change. Each outcome names its own cause and the switch that fixes it.
 *
 * @param outcome - the approval result other than `allowed-once`.
 * @param ctx - the plugin context, used to read the session's policy override.
 * @param exec - the call being gated.
 * @returns one sentence naming the cause and the remedy.
 */
function approvalRefusal(outcome, ctx, exec) {
  const policy = sessionPolicy(ctx, exec)
  if (outcome === 'rejected') {
    if (policy === 'never') {
      return (
        'this session approval policy is "never", so no prompt was shown and every ask is auto-rejected. ' +
        'Switch the session approval policy to "ask", or turn off "写操作前询问我" (approveMutating) in the git tool settings.'
      )
    }
    return 'you rejected the prompt for this call.'
  }
  if (outcome === 'cancelled') return 'the approval request was cancelled before it was answered.'
  if (outcome === 'unavailable') {
    return (
      'no approval channel is available to answer it. ' +
      'Turn off "写操作前询问我" (approveMutating) in the git tool settings, or give this session an answerer.'
    )
  }
  return `unexpected approval outcome ${JSON.stringify(outcome)}.`
}

/**
 * Read this session's approval policy override, when the service exposes it.
 * @param ctx - the plugin context.
 * @param exec - the call being gated.
 * @returns the override, or undefined when there is none or it cannot be read.
 */
function sessionPolicy(ctx, exec) {
  const approval = ctx.get('approval')
  if (approval === undefined || typeof approval.overrideOf !== 'function') return undefined
  const session = exec.agent == null ? undefined : exec.agent.session
  if (session == null) return undefined
  try {
    return approval.overrideOf(session)
  } catch {
    return undefined
  }
}

/** Append `--` and the caller's paths, so a path never reads as a flag. */
function composeWithPaths(argv, paths) {
  return paths.length === 0 ? [...argv] : [...argv, '--', ...paths]
}

export { DEFAULT_ENABLED, OPERATIONS, OPERATION_NAMES, RISK, buildEnv, composeCommand, describeCatalog, validateArgv }
