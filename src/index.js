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
 * @module git-for-dsh
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
  isShellScriptTarget,
  isPathInside,
  createBudget,
  SCRIPT_CHECK_POLICIES,
  DEFAULT_SCRIPT_CHECK_POLICY,
  TARGET_SCOPES,
  DEFAULT_PROTECTION_ROWS,
  resolveProtectionRows,
  BASH_PATH_MODES,
  DEFAULT_BASH_PATH_MODE,
  DEFAULT_TARGET_SCOPE,
  DEFAULT_SSH_COMMAND,
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
import { createDiagnosticLog, defaultLogPath } from './log.js'
import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
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
  /**
   * Whether the operator's own protected list is enforced.
   *
   * Two states, not three: the list means "the AI must not touch this", so there is nothing
   * useful to ask about. Turning it off keeps the list for later — that was the point.
   */
  /**
   * The blacklist: one row per path, with the read, write and ask boxes.
   *
   * No schema default: `migrateProtectionRows` reads this key to decide whether the stored
   * document already carries a blacklist, and a default would hide that (PITFALLS 35).
   */
  pathRules: z
    .array(z.object({
      path: z.string(),
      read: z.boolean(),
      write: z.boolean(),
      ask: z.boolean(),
    }))
    .description('One row per protected path: read and write allow without asking, ask prompts for every access, nothing ticked means denied.'),
  /** How a path mentioned in a bash command is judged; see BASH_PATH_MODES. */
  bashPathMode: z
    .union(BASH_PATH_MODES.map((mode) => z.const(mode)))
    .default(DEFAULT_BASH_PATH_MODE)
    .description('How a path named in a bash command is judged: heuristic (obvious reads as reads, everything else as a write) or write-only (any mention counts as a write).'),
  /**
   * How hard to judge a shell script WHEN IT IS WRITTEN.
   *
   * The content arrives in the call's own arguments, so this costs no filesystem access —
   * which matters because the guard runs in the DSH process on every tool call. The write
   * is refused, so the script never lands.
   *
   * The tiers exist because "how suspicious is a mention" is the operator's judgement, not
   * the code's:
   *
   *   strict    refuse when the content mentions git at all — catches a script that only
   *             talks about git, and therefore also catches scripts that are no threat;
   *   restrict  refuse only when the content actually invokes git, which barely misfires;
   *   off       do not look at the content.
   *
   * The gap is the same at every tier: a script that arrives by other means (a heredoc, a
   * pull, another tool) is not content-checked, and its command line is still judged by the
   * ordinary matchers.
   */
  scriptCheckPolicy: z
    // No default: an absent key is what the migration below needs to see.
    .union(SCRIPT_CHECK_POLICIES.map((policy) => z.const(policy)))
    .description('How hard to judge a shell script when it is written: strict refuses on any mention of git, restrict only on a real invocation in it (barely misfires), off does not look.'),
  /**
   * The boolean this policy replaced.
   *
   * Kept in the schema so an existing profile still validates, and read as a fallback by
   * `normalizePolicy`: true is strict, false is off.
   */
  scanScripts: z
    .boolean()
    .default(true)
    .description('Deprecated: superseded by scriptCheckPolicy. true means strict, false means off.'),
  /**
   * The ssh program git runs.
   *
   * Pinned through GIT_SSH_COMMAND, which outranks every config file, so a repository
   * cannot nominate the program — the same protection core.sshCommand=false gave, but
   * with SSH still usable.
   */
  sshCommand: z
    .string()
    .default(DEFAULT_SSH_COMMAND)
    .description('The ssh program git runs, pinned via GIT_SSH_COMMAND (env outranks config). Change it when ssh lives elsewhere.'),
  /**
   * The plugin's own runtime switch.
   *
   * DSH's Cordis panel manages DYNAMIC plugins only, so there is no built-in way to turn
   * a profile-loaded row off without editing the composition and restarting. This is
   * that switch, and it takes effect on the next call: off means the tool refuses and the
   * guard stops intercepting, which is what makes an A/B comparison possible without a
   * restart.
   */
  pluginEnabled: z
    .boolean()
    .default(true)
    .description('Turn the plugin off without restarting: git_exec refuses and the tool guard stops intercepting, so the difference is measurable immediately.'),
  /**
   * Whether to write the diagnostic log.
   *
   * On by default because its whole purpose is to survive a hang: the last line before a
   * freeze is the evidence, and a log that has to be enabled first is a log that is
   * missing when it matters.
   */
  logEnabled: z
    .boolean()
    .default(true)
    .description('Write a diagnostic log (one line per gate decision, with timings). Streamed writes only, redacted, rotated at 2 MB.'),
  /** Where that log goes; empty means the default beside the harness state. */
  logPath: z
    .string()
    .default('')
    .description('Log destination. Empty uses the default path shown on the settings page.'),
  /**
   * Whether to write a heartbeat line every few seconds.
   *
   * Nothing else writes the log while the harness is idle, so without this every stall
   * looks like it was caused by whatever was logged last. The line carries the call that
   * has been open and for how long, which is what separates "wedged inside a call" from
   * "wedged while idle".
   */
  heartbeat: z
    .boolean()
    .default(false)
    .description('Optional. A heartbeat line every 5 seconds, naming any call stuck in flight and for how long. It was what located a hang inside a call; turn it on when investigating one, off otherwise.'),
  /**
   * Where a git command may run.
   *
   * The workdir arrives in the tool call and is judged against this: the session workspace
   * only, the roots listed in `targetPaths`, or anywhere.
   */
  targetScope: z
    .union(TARGET_SCOPES.map((scope) => z.const(scope)))
    .default(DEFAULT_TARGET_SCOPE)
    .description('Where git may run: workspace (only the session workspace, the default), allowlist (only the roots below), or unrestricted (anywhere).'),
  /** The roots the allowlist mode permits. */
  targetPaths: z
    .array(z.string())
    .default([])
    .description('Root directories git may run inside when targetScope is allowlist. One per entry; a target must fall inside one of them.'),
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
  scriptCheckPolicy: DEFAULT_SCRIPT_CHECK_POLICY,
  targetScope: DEFAULT_TARGET_SCOPE,
  targetPaths: [],
  scanScripts: true,
  heartbeat: false,
  sshCommand: DEFAULT_SSH_COMMAND,
  pluginEnabled: true,
  logEnabled: true,
  logPath: '',
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
      // The catalog is CLOSED: an operation outside it cannot be enabled by any setting.
      // "Every other operation is also enabled" told the model the opposite, and it spent
      // turns looking for a switch that does not exist.
      ? 'Every operation in the catalog is enabled. Subcommands that are NOT in the catalog cannot be enabled at all and are refused — do not look for a setting that turns them on.'
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
/**
 * The script check's tier, including the boolean that came before it.
 *
 * @param value - the stored settings section.
 * @returns one of SCRIPT_CHECK_POLICIES.
 */
function normalizeScriptCheck(value) {
  const stored = value?.scriptCheckPolicy
  if (typeof stored === 'string' && SCRIPT_CHECK_POLICIES.includes(stored)) return stored
  // Migration: an existing profile set the boolean, and that choice must survive.
  if (value?.scanScripts === false) return 'off'
  return DEFAULT_SCRIPT_CHECK_POLICY
}

/**
 * Whether the operator's list is enforced, including the tier that came before it.
 *
 * The old single tier served both the list and the built-in files. A non-allow tier meant the
 * list was enforced, so that is what it migrates to; allow migrates to off. The direction
 * matters: an unclear old value stays strict.
 *
 * @param value - the stored settings section.
 * @returns true when the list should be enforced.
 */
/**
 * A group's tier, falling back when the stored value is not one of them.
 *
 * @param stored - the stored value, if any.
 * @param fallback - the default for that group.
 * @returns one of GUARD_POLICIES.
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
    pathRules: resolveProtectionRows(value),
    bashPathMode: BASH_PATH_MODES.includes(value?.bashPathMode) ? value.bashPathMode : DEFAULT_BASH_PATH_MODE,
    scriptCheckPolicy: normalizeScriptCheck(value),
    targetScope: typeof value?.targetScope === 'string' && TARGET_SCOPES.includes(value.targetScope)
      ? value.targetScope
      : DEFAULT_TARGET_SCOPE,
    targetPaths: Array.isArray(value?.targetPaths)
      ? value.targetPaths.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      : [],
    scanScripts: value?.scanScripts !== false,
    heartbeat: value?.heartbeat === true,
    sshCommand: typeof value?.sshCommand === 'string' && value.sshCommand.trim().length > 0
      ? value.sshCommand
      : DEFAULT_SSH_COMMAND,
    pluginEnabled: value?.pluginEnabled !== false,
    logEnabled: value?.logEnabled !== false,
    logPath: typeof value?.logPath === 'string' ? value.logPath : '',
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

/** Whether the harness itself runs on Windows, rather than in WSL on Linux. */
const IS_WINDOWS = process.platform === 'win32'

/**
 * Whether this is Linux — WSL or a real distribution.
 *
 * Only Linux has Windows drives to look for, and only Linux has /mnt. macOS ships its own
 * ssh at /usr/bin/ssh and needs none of that: running the Windows logic there produced
 * "no Windows drive visible" as an answer, which is not a statement about a Mac.
 */
const IS_LINUX = process.platform === 'linux'

/** Where a native Windows OpenSSH is normally installed. */
const WINDOWS_NATIVE_CANDIDATES = Object.freeze([
  'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  'C:\\Program Files\\OpenSSH\\ssh.exe',
  'C:\\Program Files (x86)\\OpenSSH\\ssh.exe',
  'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
])

/** The route the settings page asks which ssh programs exist. */
const SSH_CHECK_PATH = '/git-tool/ssh-check'

/**
 * Where an ssh is worth looking for, beyond whatever `$PATH` already holds.
 *
 * The Windows paths matter on WSL: a Linux `ssh` is often absent there, and git then finds
 * a Windows one through the interop path — which is exactly the case that made an SSH
 * remote unusable through this tool until the pin moved to `GIT_SSH_COMMAND`.
 */
const SSH_CANDIDATES = Object.freeze([
  '/usr/bin/ssh',
  '/bin/ssh',
  '/usr/local/bin/ssh',
  '/opt/homebrew/bin/ssh',
])

/**
 * The places a Windows OpenSSH is installed, relative to a mounted drive.
 *
 * Kept relative because the mount point and the drive letter are both configurable (see
 * `/etc/wsl.conf`), and a hardcoded /mnt/c is how this probe managed to miss an ssh that
 * worked from the Windows side.
 */
const WINDOWS_SSH_LAYOUTS = Object.freeze([
  'Windows/System32/OpenSSH/ssh.exe',
  'Program Files/OpenSSH/ssh.exe',
  'Program Files (x86)/OpenSSH/ssh.exe',
  'Program Files/Git/usr/bin/ssh.exe',
])

/**
 * Translate an absolute Windows path into the path WSL sees.
 *
 * `C:\\Windows\\System32\\OpenSSH\\ssh.exe` becomes
 * `<mountRoot>/Windows/System32/OpenSSH/ssh.exe`, using whichever mount root exists.
 *
 * @param windowsPath - a path as Windows writes it.
 * @returns the WSL path, or undefined when the drive has no mount here.
 */
function toWslPath(windowsPath) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(windowsPath.trim())
  if (match === null) return undefined
  const drive = match[1].toLowerCase()
  const rest = match[2].replace(/\\/g, '/')
  for (const root of windowsMountRoots()) {
    if (root.toLowerCase().endsWith(`/${drive}`) && rest.length > 0) return `${root}/${rest}`
  }
  // The drive is not mounted at a root we know; the caller reports the path as it came.
  return undefined
}

/**
 * Ask Windows where its ssh is.
 *
 * @returns the paths Windows reports, as WSL paths where possible.
 */
function windowsWhereSsh() {
  const found = []
  // where.exe is a Windows program: on macOS neither form exists, so do not try.
  if (!IS_WINDOWS && !IS_LINUX) return []
  const commands = IS_WINDOWS ? ['where.exe'] : ['where.exe', '/mnt/c/Windows/System32/where.exe']
  for (const command of commands) {
    let result
    try {
      result = spawnSync(command, ['ssh'], { encoding: 'utf8', timeout: 5000 })
    } catch {
      continue
    }
    if (result === undefined || result.status !== 0) continue
    for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      // On native Windows the reported path is already the path to use.
      const usable = IS_WINDOWS ? trimmed : toWslPath(trimmed)
      if (usable === undefined) continue
      if (!found.includes(usable)) found.push(usable)
    }
    if (found.length > 0) break
  }
  return found
}

/** Where Windows drives are mounted, by default and by common alternatives. */
function windowsMountRoots() {
  // Only Linux mounts Windows drives; Windows and macOS have nothing to enumerate.
  if (!IS_LINUX) return []
  const roots = ['/mnt/c', '/c']
  try {
    for (const entry of readdirSync('/mnt')) {
      // A mounted drive appears as a single letter; anything else is not one.
      if (/^[a-zA-Z]$/.test(entry)) roots.push(`/mnt/${entry}`)
    }
  } catch {
    // No /mnt at all: not WSL, or a very unusual layout. The fixed roots still apply.
  }
  return [...new Set(roots)]
}

/**
 * Every ssh path worth offering: each PATH directory first, then the known locations.
 *
 * @returns paths, deduplicated, in the order they should be tried.
 */
function sshCandidatePaths() {
  const found = []
  const add = (candidate) => {
    if (typeof candidate === 'string' && candidate.length > 0 && !found.includes(candidate)) found.push(candidate)
  }
  // The separator is the platform's, not a colon by assumption.
  const separator = IS_WINDOWS ? ';' : ':'
  for (const directory of (process.env.PATH ?? '').split(separator).filter((entry) => entry.length > 0)) {
    const base = directory.replace(/[\\/]+$/, '')
    if (base.length === 0) continue
    add(IS_WINDOWS ? `${base}\\ssh.exe` : `${base}/ssh`)
    if (!IS_WINDOWS) {
      // On WSL the Windows OpenSSH also sits in a PATH directory, as an .exe.
      add(`${base}/ssh.exe`)
    }
  }
  if (IS_WINDOWS) {
    // Native Windows: these are the real paths, and the platform's own lookup knows the rest.
    for (const candidate of WINDOWS_NATIVE_CANDIDATES) add(candidate)
    for (const candidate of windowsWhereSsh()) add(candidate)
    return found
  }
  // POSIX: a Linux ssh, then whatever Windows drives are mounted here.
  for (const candidate of SSH_CANDIDATES) add(candidate)
  for (const root of windowsMountRoots()) {
    for (const layout of WINDOWS_SSH_LAYOUTS) add(`${root}/${layout}`)
  }
  for (const candidate of windowsWhereSsh()) add(candidate)
  return found
}

/**
 * Report which of those exist, are executable, and what they call themselves.
 *
 * @returns one row per candidate.
 */
/**
 * Report what was found, and enough context to explain a negative.
 *
 * @returns `{ rows, checked, windowsMounts }`.
 */
function sshCandidateScan() {
  const rows = []
  for (const path of sshCandidatePaths()) {
    let executable = false
    try {
      executable = statSync(path).isFile()
      accessSync(path, constants.X_OK)
    } catch {
      executable = false
    }
    // Only ask a program that is there for its version; spawning is not free.
    let version = ''
    if (executable) {
      const probe = spawnSync(path, ['-V'], { encoding: 'utf8', timeout: 3000 })
      const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim().split('\n')[0] ?? ''
      version = output.slice(0, 80)
    }
    rows.push({ path, executable, version })
  }
  return {
    rows,
    checked: rows.length,
    nativeWindows: IS_WINDOWS,
    platform: process.platform,
    // Whether any Windows drive was visible at all: a negative report means "install ssh"
    // only when the places it would live in could actually be looked at.
    windowsMounts: windowsMountRoots().filter((root) => {
      try {
        return statSync(root).isDirectory()
      } catch {
        return false
      }
    }).length,
  }
}

/** The route the settings page reads and clears the diagnostic log through. */
const LOG_PATH = '/git-tool/log'

/** How much of the log the page may read, and how many lines it shows. */
const LOG_TAIL_BYTES = 256 * 1024
const LOG_TAIL_LINES = 2000

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
 * The repository-config audit's cache, so a git call does not pay for a second process.
 *
 * Keyed by every input the verdict depends on — the directory, the policy, and the state
 * (mtime + size) of the repository's own configuration — so a changed configuration cannot
 * produce a stale verdict. Only the raw KEYS are cached; the verdict is recomputed per call
 * from the current subcommand, which is why the subcommand is not part of the key.
 *
 * Two limits are stated rather than hidden:
 *
 *  - **Includes.** The audit follows `[include]` directives, and the paths they name are not
 *    visible here without asking git — the very call being avoided. An edit to an included
 *    file is therefore caught by the TTL, not immediately.
 *  - **Worktrees.** Where `.git` is a file rather than a directory there is no configuration
 *    to watch, so nothing is cached at all.
 *
 * The `statSync` here reads a drvfs path on a Windows-mounted repository, which is exactly
 * what the guard must never do — and it is fine HERE, because this runs once per
 * `git_exec` call (an operation that already spawns processes) rather than on every tool
 * call.
 */
const auditCache = new Map()

/** How long a cached audit stays usable. Bounds an edit to an included file. */
const AUDIT_CACHE_TTL_MS = 30_000

/** How many repositories may be remembered at once. */
const AUDIT_CACHE_MAX = 32

/**
 * The state stamp of one file.
 * @param path - the file to stamp.
 * @returns `mtimeMs:size`, or undefined when it cannot be read.
 */
function fileStamp(path) {
  try {
    const info = statSync(path)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return undefined
  }
}

/**
 * A stamp for the configuration a repository's audit reads.
 * @param workdir - the directory the audit runs in.
 * @returns a stamp, or undefined when this repository cannot be watched.
 */
function repositoryStamp(workdir) {
  if (typeof workdir !== 'string' || workdir.length === 0) return undefined
  const main = fileStamp(resolvePath(workdir, '.git', 'config'))
  // No configuration to watch: do not cache, rather than cache something unverifiable.
  if (main === undefined) return undefined
  const worktree = fileStamp(resolvePath(workdir, '.git', 'config.worktree'))
  return worktree === undefined ? main : `${main}|${worktree}`
}

/**
 * Tell the operator about a failure the log cannot record.
 *
 * The log is how this plugin speaks, so when the LOG is the thing failing there is nowhere
 * left to write except the harness terminal — which is where a human is already looking.
 * Deduped, because a persistent failure should send one line rather than one per call.
 *
 * @param message - what went wrong, and what it means for this call.
 */
const announced = new Set()
function announce(message) {
  if (announced.has(message)) return
  announced.add(message)
  try {
    process.stderr.write(`git-for-dsh: ${message}\n`)
  } catch {
    // There is nothing left to report to.
  }
}

/**
 * The resolved protected paths and their basenames, cached per activation.
 *
 * The cache is keyed by the configured list, so a settings change invalidates it and two
 * activations never share a stale entry.
 *
 * @param paths - the configured protected paths.
 * @param cache - this activation's cache.
 * @returns `{ files, names }` for the current configuration.
 */
function protectedTargets(paths, cache) {
  const key = paths.join('\u0000')
  if (cache.key !== key) {
    const files = paths.map((entry) => absoluteProtectedPath(entry))
    cache.key = key
    cache.files = files
    cache.names = new Set(files.map((file) => file.split('/').slice(-1)[0]))
  }
  return cache
}

/**
 * Whether a path argument reaches a protected file, paying for a syscall only when the
 * name is suspicious.
 *
 * The lexical comparison catches the literal path without touching the filesystem. A
 * symlink needs `realpathSync` to be caught, so it is resolved ONLY when the last
 * segment matches a protected basename — otherwise every tool call carrying any path
 * would make a synchronous filesystem call, and on a Windows-mounted workspace that can
 * stall the DSH process itself.
 *
 * @param raw - the argument as the model wrote it.
 * @param cwd - the session workspace, for relative arguments.
 * @param protectedFiles - the resolved protected paths.
 * @param protectedNames - their basenames.
 * @returns the protected path it reaches, or undefined.
 */
function reachesCandidate(raw, cwd, protectedFiles, protectedNames) {
  const expanded = raw.startsWith('~/') ? resolvePath(homedir(), raw.slice(2)) : raw
  const absolute = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(cwd, expanded)
  const direct = reachesProtectedPath(absolute, protectedFiles)
  if (direct !== undefined) return direct
  const base = absolute.split('/').slice(-1)[0]
  if (base === undefined || !protectedNames.has(base)) return undefined
  /*
   * Silence is right HERE, and only here: a realpath that fails almost always means the
   * protected file does not exist, which is normal, and the lexical comparison has already
   * run — the path is protected either way. Logging it would bury the real failures in noise.
   */
  try {
    return reachesProtectedPath(realpathSync(absolute), protectedFiles)
  } catch {
    return undefined
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
function inspectToolCall(execution, current, cache) {
  const args = execution.arguments
  if (args === null || typeof args !== 'object') return undefined
  const session = execution.agent == null ? undefined : execution.agent.session
  const cwd = session == null ? process.cwd() : session.header.cwd

  if (execution.name === 'bash') {
    const command = typeof args.command === 'string' ? args.command : ''
    if (current.nativeGitPolicy !== 'allow') {
      /*
       * The tier decides BOTH what counts as an invocation and what to do about it.
       * deny/ask use the broad matcher (a mention counts); restrict uses the
       * command-position matcher, which never refuses a mere mention.
       */
      const narrow = current.nativeGitPolicy === 'restrict'
      /*
       * One budget for the whole scan of this command, recursion included. It is the only
       * instrument that can end a synchronous loop — a timer never gets to run while one
       * spins, which is how a freeze looked from the log.
       */
      const budget = createBudget()
      const matched = narrow
        ? invokesGit(command, budget.spend)
        : containsNativeGit(command, budget.spend)
      /*
       * Out of budget means the matcher met input it was not written for. Refusing is the
       * conservative answer and far better than the alternative: this code runs in the DSH
       * process, so a scan that never returns takes the whole harness with it.
       */
      if (budget.exhausted()) {
        return guardDecision(
          current.nativeGitPolicy === 'ask' ? 'ask' : 'deny',
          '这条命令的文本过长或形态异常，扫描已达步数预算上限；为安全起见按最严策略处理。请把命令拆小后重试。',
        )
      }
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
    const bashKind = bashAccessKind(command, current.bashPathMode ?? DEFAULT_BASH_PATH_MODE)
    for (const row of current.pathRules) {
      if (!mentionsProtectedPath(command, [row.path])) continue
      // The blacklist outranks the target scope: a path named here is refused on its own
      // terms, and the message names the row to change.
      const decision = rowDecision(row, bashKind, `这条命令提到了黑名单路径「${row.path}」`)
      if (decision !== undefined) return decision
    }
  }

  /*
   * A script is judged when it is WRITTEN, not when it is run.
   *
   * The content is already in the arguments, so this costs no filesystem access — and the
   * guard runs in the DSH process on every tool call, where a synchronous read risks
   * stalling the whole application. Refusing here also means the script never lands,
   * instead of existing and being refused when something tries to run it.
   */
  if (current.scriptCheckPolicy !== 'off' && (execution.name === 'write' || execution.name === 'edit')) {
    const target = typeof args.file_path === 'string' ? args.file_path : ''
    const text = execution.name === 'write' ? args.content : args.new_string
    if (isShellScriptTarget(target, text) && typeof text === 'string') {
      /*
       * The tier picks the matcher, and it is self-contained on purpose: borrowing the
       * native-git tier here made one setting mean two different things.
       */
      const narrow = current.scriptCheckPolicy === 'restrict'
      if (narrow ? invokesGit(text) : containsNativeGit(text)) {
        return guardDecision(
          'deny',
          `要写入的脚本「${target}」里检测到 git 调用，已被本插件拦截（脚本检查档位：${current.scriptCheckPolicy}）。`
            + '脚本本身没有生成。若确实需要，请改用 git_exec，或在设置里把「写入脚本时检查内容」改为「限制」或「关闭」。',
        )
      }
    }
  }

  /*
   * git_exec's own arguments.
   *
   * Its command lives in `argv` and its file operands in `paths`, so the path rules above
   * never saw either: a protected file could be passed to `git diff --no-index` and printed
   * with no approval in the way. The joined arguments are judged as command text — which keeps
   * the read/write heuristic and its tier in charge rather than adding a second opinion — and
   * every operand is also resolved like a path, so a symlink is caught too.
   */
  if (execution.name === 'git_exec') {
    const operands = [
      ...(Array.isArray(args.argv) ? args.argv : []),
      ...(Array.isArray(args.paths) ? args.paths : []),
    ].filter((item) => typeof item === 'string' && item.length > 0)
    const kind = bashAccessKind(operands.join(' '), current.bashPathMode ?? DEFAULT_BASH_PATH_MODE)
    for (const row of current.pathRules) {
      if (operands.length > 0 && mentionsProtectedPath(operands.join(' '), [row.path])) {
        const decision = rowDecision(row, kind, `git_exec 的参数里出现了黑名单路径「${row.path}」`)
        if (decision !== undefined) return decision
      }
      for (const operand of operands) {
        const targets = rowTargets(cache, row.path)
        const reached = reachesCandidate(operand, cwd, targets.files, targets.names)
        if (reached === undefined) continue
        const decision = rowDecision(row, kind, `「${reached}」命中黑名单路径「${row.path}」`)
        if (decision !== undefined) return decision
      }
    }
  }

  for (const key of ['file_path', 'path']) {
    const raw = args[key]
    if (typeof raw !== 'string' || raw.length === 0) continue
    // Read or write comes from the tool: file calls say what they are, unlike a shell line.
    const kind = READ_TOOLS.has(execution.name) ? 'read' : 'write'
    for (const row of current.pathRules) {
      const targets = rowTargets(cache, row.path)
      const reached = reachesCandidate(raw, cwd, targets.files, targets.names)
      if (reached === undefined) continue
      const decision = rowDecision(row, kind, `「${reached}」命中黑名单路径「${row.path}」`)
      if (decision !== undefined) return decision
    }
  }
  return undefined
}


/**
 * The three protection groups, each with its own tier.
 *
 * Credentials come first because they are the highest stakes, and identity before the
 * operator's own list so that a path in both reports the more specific reason. A disabled
 * group carries 'allow', which produces no decision — it falls through to the next group
 * rather than ending the check.
 *
 * @param current - the live policy.
 * @returns the groups, in consultation order.
 */
/** Commands that plainly read, for the bash heuristic. */
const READ_COMMANDS = /\b(cat|less|more|head|tail|grep|egrep|fgrep|rg|awk|cut|diff|wc|file|stat|strings|xxd|od|jq|nl|tac|du)\b/

/**
 * Redirections that discard output or merge descriptors instead of writing a file:
 * `2>/dev/null`, `2>&1`, `>/dev/null`, `&>/dev/null`.
 *
 * Removed before the write markers are looked for, because output thrown away never names a
 * file — without this, a read whose errors are silenced counted as a write.
 */
const DISCARD_REDIRECT = /(&>>?|>>?)\s*(&\d+|\d|\/dev\/null)/g

/** Signs of a write. Checked first: sed -i is a write even though sed is not. */
const WRITE_MARKERS = /(>>?|\|\s*tee\b|\btee\b|\bcp\b|\bmv\b|\brm\b|\bdd\b|\btruncate\b|\bsed\s+-i|\bpatch\b|\binstall\b|\bshred\b)/

/** Tool names whose path argument is a read, not a write. */
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'ls', 'search', 'find'])

/**
 * Whether a bash command's access to a path counts as a read or a write.
 *
 * The guard sees command text, never a file access, so this cannot be more than a heuristic
 * and the settings page and README say so. write-only skips the guess; the heuristic also
 * falls back to a write, because the strict side is the safe one.
 *
 * @param command - the shell command text.
 * @param mode - one of BASH_PATH_MODES.
 * @returns 'read' or 'write'.
 */
function bashAccessKind(command, mode) {
  if (mode !== 'write-only') {
    const withoutDiscards = command.replace(DISCARD_REDIRECT, ' ')
    if (WRITE_MARKERS.test(withoutDiscards)) return 'write'
    if (READ_COMMANDS.test(withoutDiscards)) return 'read'
  }
  return 'write'
}

/**
 * The resolved targets of one row, cached by path.
 *
 * @param cache - this activation's cache.
 * @param rowPath - the row's path.
 * @returns `{ files, names }` for that row.
 */
function rowTargets(cache, rowPath) {
  cache.rows = cache.rows ?? new Map()
  if (!cache.rows.has(rowPath)) cache.rows.set(rowPath, { key: undefined, files: [], names: new Set() })
  return protectedTargets([rowPath], cache.rows.get(rowPath))
}

/**
 * The blacklist row a directory falls under, if any.
 *
 * Shares the target scope's comparison: resolved paths, compared segment by segment, so a
 * blacklisted folder covers its subdirectories and a symlink cannot walk out.
 *
 * @param rows - the blacklist.
 * @param target - the directory a command would run in.
 * @returns the row, or undefined.
 */
function matchingPathRow(rows, target) {
  for (const row of rows ?? []) {
    if (isInside(target, row.path)) return row
  }
  return undefined
}

/**
 * The verdict for one row, or undefined when the row permits this access.
 *
 * The rule, in one place: permitted when the access's own box is ticked OR when ask is
 * ticked; ask is also what makes it prompt, and approval allows that one access; nothing
 * ticked means denied, and denied silently.
 *
 * @param row - a blacklist row.
 * @param kind - 'read' or 'write'.
 * @param what - what was seen, for the message.
 * @returns a decision, or undefined.
 */
function rowDecision(row, kind, what) {
  const word = kind === 'read' ? '读' : '写'
  const guide = '请在设置 → 闸门 → 「路径黑名单」里勾选该行的「' + word + '」，或勾「询问」改为逐次确认。'
  if (row.ask === true) {
    return guardDecision('ask', what + '（该行勾选了「询问」，因此每次访问都会先问你）' + guide)
  }
  const permitted = kind === 'read' ? row.read === true : row.write === true
  if (permitted) return undefined
  return guardDecision('deny', what + '（该行既没勾「' + word + '」也没勾「询问」= 静默禁止）' + guide)
}

/**
 * The resolved targets of one group, cached per group.
 *
 * A group's paths change only when the settings do, so resolving them once is what keeps the
 * per-call cost at string comparison. Each group keeps its own cache entry, so one group's
 * list cannot invalidate another's.
 *
 * @param cache - this activation's cache.
 * @param id - the group's id.
 * @param paths - the group's configured paths.
 * @returns `{ files, names }` for that group.
 */
function groupTargets(cache, id, paths) {
  cache.groups = cache.groups ?? {}
  cache.groups[id] = cache.groups[id] ?? { key: undefined, files: [], names: new Set() }
  return protectedTargets(paths, cache.groups[id])
}

/**
 * Resolve a directory for comparison, following symlinks when it exists.
 *
 * @param path - the path to resolve.
 * @returns the resolved path, or undefined when it cannot be read.
 */
function resolvedDirectory(path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  try {
    return realpathSync(path)
  } catch {
    // It does not exist yet: the lexical form still compares correctly, and refusing on
    // "cannot resolve" would be a fail-closed answer to a question nobody asked.
    return resolvePath(path)
  }
}

/**
 * Whether a target directory is inside a root.
 *
 * Segments, not string prefixes: `/work/app2` must not count as being inside `/work/app`.
 * Symlinks are resolved first, because a link inside the workspace pointing at / would
 * otherwise walk straight out of the scope. Windows compares case-insensitively, as its
 * filesystem does.
 *
 * @param target - the directory the command would run in.
 * @param root - a permitted root.
 * @returns true when target is root or below it.
 */
function isInside(target, root) {
  const resolvedTarget = resolvedDirectory(target)
  const resolvedRoot = resolvedDirectory(root)
  if (resolvedTarget === undefined || resolvedRoot === undefined) return false
  // Resolving is this side's job (it needs the filesystem); the containment rule itself is
  // shared with the file-argument rule, so the two cannot drift apart.
  return isPathInside(resolvedTarget, resolvedRoot)
}

/**
 * Why this target is out of scope, or undefined when it is allowed.
 *
 * @param policy - the live policy.
 * @param target - the directory git would run in.
 * @param workspace - the session's workspace, when there is one.
 * @returns the refusal reason, or undefined.
 */
function targetRefusal(policy, target, workspace) {
  const scope = policy.targetScope ?? DEFAULT_TARGET_SCOPE
  if (scope === 'unrestricted') return undefined
  if (scope === 'allowlist') {
    if (policy.targetPaths.length === 0) {
      return '「目标范围」是「指定路径」，但一个允许的根目录都没有配置，因此拒绝执行。请在设置里添加根目录，或改用其它模式。'
    }
    if (policy.targetPaths.some((root) => isInside(target, root))) return undefined
    return `目标目录「${target}」不在允许的根目录内（当前允许：${policy.targetPaths.join('、')}）。`
  }
  if (workspace !== undefined && isInside(target, workspace)) return undefined
  return `目标目录「${target}」不在本次会话的工作区内（工作区：${workspace ?? '未知'}）。`
    + '若确实需要在别处执行，请把设置里的「目标范围」改为「指定路径」或「无限制」。'
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

    /*
     * The log routes. Same-origin, like the port check: the page has no other way to
     * reach the file, and the operator asked to read and clear it from the settings UI.
     */
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: LOG_PATH,
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
          const path = policy.current.logPath.length > 0 ? policy.current.logPath : defaultLogPath()

          if (url.searchParams.get('action') === 'clear') {
            await writeFile(path, '')
            // Logged AFTER clearing, so the file the operator is looking at starts with
            // the record of who emptied it.
            log.line('log.cleared', { path })
            respond({ path, cleared: true, lines: [] })
            return
          }

          const requested = Number.parseInt(url.searchParams.get('tail') ?? '', 10)
          const wanted = Number.isInteger(requested) && requested > 0 && requested <= LOG_TAIL_LINES
            ? requested
            : 200
          /*
           * Only a missing file stays quiet: that is the normal state before the first line.
           * Any OTHER read failure is reported, because an unreadable log and an empty one
           * look identical to the operator otherwise.
           */
          let text = ''
          let exists = true
          try {
            text = await readFile(path, 'utf8')
          } catch (error) {
            const code = error !== null && typeof error === 'object' ? error.code : undefined
            if (code !== 'ENOENT') {
              respond({
                path,
                lines: [],
                exists: true,
                error: `读不了日志文件（${code ?? (error instanceof Error ? error.message : String(error))}）`,
              })
              return
            }
            exists = false
          }
          const recent = text.slice(-LOG_TAIL_BYTES)
          const lines = recent.split('\n').filter((line) => line.length > 0).slice(-wanted)
          respond({
            path,
            lines,
            exists,
            truncated: text.length > LOG_TAIL_BYTES,
            enabled: policy.current.logEnabled !== false,
          })
        } catch (error) {
          respond({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'git-tool: log route')

    /*
     * Which ssh programs exist. A click, not a per-call probe: see the log-route comment
     * above, and entry 29 for why that distinction is load-bearing.
     */
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: SSH_CHECK_PATH,
      handler: (req, res) => {
        const respond = (payload, status = 200) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(payload))
        }
        try {
          const scan = sshCandidateScan()
          respond({
            current: policy.current.sshCommand,
            expected: DEFAULT_SSH_COMMAND,
            candidates: scan.rows,
            checked: scan.checked,
            windowsMounts: scan.windowsMounts,
          })
        } catch (error) {
          respond({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'git-tool: ssh check route')
  }

  /**
   * The tool guard.
   *
   * `tools/pre-execute` is a waterfall EVENT, which is what makes it reachable: the
   * service method `ctx.tools.guard` is not exposed to a plugin's curated view. The
   * listener delegates by default and absorbs its own failures — a throwing guard
   * would break every tool call in the session.
   */
  /**
   * The third timeline point: the tool finished.
   *
   * `post-execute` is the only hook that runs after dispatch, so this is what separates
   * "the guard wedged" from "the tool's own execution wedged" from "the process stopped
   * between calls" — the question a single unmatched `guard.enter` could not answer.
   */
  ctx.on('tools/post-execute', (execution, result, next) => {
    // The switch has to silence BOTH listeners: a line per call from this one kept the
    // plugin in the hot path of every call even while it was "off".
    if (policy.current.pluginEnabled === false) return next()
    try {
      log.line('tool.done', { tool: execution.name, failed: result?.isError === true })
    } catch {
      // A logging failure never affects the call it describes.
    }
    return next()
  })

  /**
   * The diagnostic log.
   *
   * The destination is read per line, so the settings page can redirect or silence it
   * without a restart — which is the entire point of having it during an investigation.
   */
  const log = createDiagnosticLog(() => ({
    enabled: policy.current.logEnabled !== false,
    path: policy.current.logPath.length > 0 ? policy.current.logPath : defaultLogPath(),
  }), announce)
  ctx.effect(() => () => log.close(), 'git-for-dsh: diagnostic log')

  /**
   * The heartbeat writes through its OWN handle, so its switch is independent of the call
   * log's. Watching liveness should not require logging every call, and logging every call
   * should not require a line every five seconds.
   */
  const beatLog = createDiagnosticLog(() => ({
    enabled: policy.current.heartbeat === true,
    path: policy.current.logPath.length > 0 ? policy.current.logPath : defaultLogPath(),
  }), announce)
  ctx.effect(() => () => beatLog.close(), 'git-for-dsh: heartbeat log')

  /**
   * The call currently in flight, if any.
   *
   * Written by the guard's enter line and cleared by its exit line, so a wedged call stays
   * "open" and every heartbeat keeps reporting it — with a growing age, which is the
   * duration of the stall.
   */
  const flight = { tool: undefined, startedAt: 0 }
  /** Every few seconds, so an idle stall is still visible in the timeline. */
  const heartbeatMs = 5000
  let beats = 0
  const beat = () => {
    if (policy.current.pluginEnabled === false || policy.current.heartbeat !== true) return
    beats += 1
    if (flight.tool === undefined) {
      beatLog.line('heartbeat', { n: beats, open: 'none' })
      return
    }
    beatLog.line('heartbeat', {
      n: beats,
      open: flight.tool,
      openMs: Date.now() - flight.startedAt,
    })
  }
  const timer = ctx.get('timer')
  ctx.effect(() => {
    if (timer !== undefined && typeof timer.interval === 'function') {
      const stop = timer.interval(beat, heartbeatMs)
      return () => {
        if (typeof stop === 'function') stop()
      }
    }
    // A composition without the timer service still gets a heartbeat, disposed with this
    // activation like any other effect.
    const handle = setInterval(beat, heartbeatMs)
    // Never let a diagnostic timer keep the process alive: the suite mounts the plugin
    // many times, and an un-disposed interval makes it run forever.
    if (typeof handle.unref === 'function') handle.unref()
    return () => clearInterval(handle)
  }, 'git-for-dsh: heartbeat')
  log.line('activate', {
    pluginEnabled: policy.current.pluginEnabled,
    operations: policy.current.enabled.length,
    nativeGit: policy.current.nativeGitPolicy,
    scanScripts: policy.current.scanScripts,
    sshCommand: policy.current.sshCommand,
    hostCredentials: policy.current.useHostCredentials,
    proxyPort: policy.current.proxyPort,
    logPath: policy.current.logPath.length > 0 ? policy.current.logPath : defaultLogPath(),
  })

  /**
   * The guard's own cache, per activation: it holds the resolved protected paths so the
   * per-call cost stays at string comparison. It lives here rather than at module scope
   * because module state is shared by every activation — the mistake entry 20 records.
   */
  const guardCache = { key: undefined, files: [], names: new Set() }
  ctx.on('tools/pre-execute', (execution, next) => {
    /*
     * Off means off: no interception, no inspection, and no log line. Writing a line here
     * would keep the plugin in the hot path of every call, which is exactly what makes an
     * A/B comparison unreliable.
     */
    if (policy.current.pluginEnabled === false) return next()
    /*
     * Enter and exit are logged separately and on purpose: a freeze between them names
     * the guard, and a missing exit with no line after it names everything downstream.
     * That is the whole diagnostic value of this log.
     */
    const startedAt = Date.now()
    flight.tool = execution.name
    flight.startedAt = startedAt
    /*
     * A bash call is identified by what it runs. Without this the log says `tool=bash`
     * and nothing more, which cannot tell a build from a tail — and the freeze reports all
     * landed on bash calls, so the distinction is the whole question.
     */
    const callArgs = execution.arguments
    const commandPrefix = execution.name === 'bash'
      && callArgs !== null && typeof callArgs === 'object' && typeof callArgs.command === 'string'
      ? JSON.stringify(callArgs.command.slice(0, 60))
      : undefined
    log.line('guard.enter', commandPrefix === undefined
      ? { tool: execution.name }
      : { tool: execution.name, cmd: commandPrefix })
    try {
      const decision = inspectToolCall(execution, policy.current, guardCache)
      flight.tool = undefined
      /*
       * "delegated", not "allow": a LATER listener in this waterfall can still deny the
       * call, so this records what the guard decided, not what dsh did. The real outcome is
       * the tool.done line, written after dispatch.
       */
      log.line('guard.exit', {
        tool: execution.name,
        verdict: decision === undefined ? 'delegated' : decision.kind,
        ms: Date.now() - startedAt,
      })
      if (decision !== undefined) return decision
    } catch (error) {
      log.line('guard.error', {
        tool: execution.name,
        message: error instanceof Error ? error.message : String(error),
        ms: Date.now() - startedAt,
      })
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
      if (policy.current.pluginEnabled === false) {
        log.line('git_exec.refused', { reason: 'plugin-disabled' })
        throw new Error(
          'git 工具已被关闭（Git 工具 → 策略与代理 → 启用本插件）。这是插件开关，不是允许清单问题；请先在设置页打开。',
        )
      }
      const { verdict, paths, workdir, timeoutMs, justification } = checkArgs(args)
      /*
       * The target gate, before anything is audited or approved: there is no point asking
       * the operator to approve a command that this plugin will not run anywhere.
       */
      const sessionWorkspace = exec.agent == null ? undefined : exec.agent.session?.header?.cwd
      /*
       * The EFFECTIVE target, not the one the call happened to name: an omitted workdir is
       * defaulted to the session workspace further along, so judging the raw argument
       * refused legitimate in-workspace calls for a target of "undefined".
       */
      const effectiveTarget = workdir ?? sessionWorkspace
      /*
       * The blacklist is judged FIRST, because it outranks the target scope: when both would
       * refuse, the operator needs to change that row, not the scope setting.
       *
       * It is also judged on the WORKDIR, which the guard cannot do — it sees tool
       * arguments, and workdir is neither a file_path nor a path. Without this, a command
       * could run inside a blacklisted directory and read everything in it.
       */
      const blacklisted = matchingPathRow(policy.current.pathRules, effectiveTarget)
      if (blacklisted !== undefined) {
        // The operation's own tier decides whether running inside counts as reading or
        // writing, and anything not plainly a read is treated as a write.
        const rowVerdict = rowDecision(
          blacklisted,
          verdict.operation.risk === 'read' ? 'read' : 'write',
          `目标目录「${effectiveTarget}」在`,
        )
        if (rowVerdict !== undefined) {
          log.line('git_exec.refused', { reason: 'blacklist', target: effectiveTarget })
          throw new Error(rowVerdict.reason + '（黑名单优先于「目标范围」）')
        }
      }
      const scopeRefusal = targetRefusal(policy.current, effectiveTarget, sessionWorkspace)
      if (scopeRefusal !== undefined) {
        log.line('git_exec.refused', { reason: 'target-scope', target: workdir })
        throw new Error(scopeRefusal)
      }
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
        env: {
          ...buildEnv({
            hostCredentials: policy.current.useHostCredentials,
            sshCommand: policy.current.sshCommand,
          }),
          ...proxyEnv,
        },
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
  const stamp = repositoryStamp(workdir)
  const cacheKey = stamp === undefined ? undefined : `${workdir ?? ''}\u0000${policy}\u0000${stamp}`
  const cached = cacheKey === undefined ? undefined : auditCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < AUDIT_CACHE_TTL_MS) {
    const reused = auditRepoConfig(cached.keys, subcommand, policy)
    return reused.ok ? null : `git ${subcommand} was not run: ${reused.reason}`
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
  } catch (error) {
    /*
     * The audit has no verdict here — and "no verdict" must not be dressed up as "nothing
     * dangerous found", which is the shape of a security net that was silently inert for
     * weeks. The enforced-config pins still hold the critical keys, so the call proceeds,
     * but the operator is told.
     */
    announce(`仓库配置审计无法运行，本次未做审计：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (result.exitCode !== 0) return null

  const keys = parseConfigKeys(result.stdout.text)
  if (cacheKey !== undefined) {
    auditCache.set(cacheKey, { at: Date.now(), keys })
    // Bounded: a long-lived session must not accumulate one entry per repository seen.
    if (auditCache.size > AUDIT_CACHE_MAX) auditCache.clear()
  }
  const verdict = auditRepoConfig(keys, subcommand, policy)
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
  } catch (error) {
    // Silence here changes what the user is asked, so it is not allowed to be silent.
    announce(`审批覆盖查询失败，本次按"未覆盖"处理：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Append `--` and the caller's paths, so a path never reads as a flag. */
function composeWithPaths(argv, paths) {
  return paths.length === 0 ? [...argv] : [...argv, '--', ...paths]
}

export { DEFAULT_ENABLED, OPERATIONS, OPERATION_NAMES, RISK, buildEnv, composeCommand, describeCatalog, validateArgv }
