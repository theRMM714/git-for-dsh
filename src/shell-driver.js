/**
 * The one seam through which this plugin reaches the harness shell.
 *
 * The seam is the harness's own `ShellExecutor` contract (`@deepseek-ai/dsh-shell`),
 * which declares exactly two methods:
 *
 *   resolve(request: ShellExecRequest): ShellExecSpec
 *   execute(spec: ShellExecSpec): Promise<ShellExecution>
 *   ShellExecution.result(): Promise<ShellRunResult>
 *
 * There is no `run()` and no `start()` on it. `execute` only PREPARES the process:
 * whether a call is foreground is decided by the caller — one that awaits `result()`
 * ran it in the foreground, one that keeps the handle ran it in the background.
 *
 * This module names the two shapes the plugin actually needs, so no call site has to
 * re-derive them:
 *
 *   runOnce         a one-shot command: await preparation AND its result.
 *   startBackground a process meant to outlive the call (the operator's proxy): keep
 *                   the handle, arm no deadline, never await `result()`.
 *
 * The seam is duck-typed rather than imported: `@deepseek-ai/dsh-shell` is an optional
 * peer dependency, and a module that imported it would fail to load in a composition
 * that has no shell service at all.
 *
 * @module git-for-dsh/shell-driver
 */

/**
 * The methods `ctx.shell` must expose for this plugin to run anything.
 *
 * Declared as data because a mismatch is the failure this module exists to name: the
 * plugin was once written against an invented `run`/`start` pair, and every git call
 * in production died with "ctx.shell.run is not a function" while the test fixture,
 * which implemented the same invented API, stayed green.
 */
export const SHELL_SEAM = Object.freeze(['resolve', 'execute'])

/**
 * Explain why the composed shell cannot be used.
 *
 * @param shell - the service as `ctx.shell` resolved it.
 * @returns the refusal message, or null when the service implements the seam.
 */
function seamRefusal(shell) {
  for (const name of SHELL_SEAM) {
    if (shell?.[name] === undefined || typeof shell[name] !== 'function') {
      const found = shell === undefined || shell === null ? 'no shell service' : `typeof ${name} === ${typeof shell[name]}`
      return (
        `ctx.shell does not implement the shell seam (${SHELL_SEAM.join(' + ')}): ${found}. ` +
        'This is a plugin/harness mismatch, not a command problem — no git command can run. Report it with the plugin version.'
      )
    }
  }
  return null
}

/**
 * Resolve and prepare one command, returning the execution handle.
 *
 * The handle check is the drift guard: an implementation that answered `execute` with a
 * settled result object would otherwise fail later, at an unrelated `result()` call, with
 * a message that names nothing.
 *
 * @param shell - the composed shell service.
 * @param request - the caller's request; `resolve` fills the implementation defaults.
 * @returns the prepared execution handle.
 */
async function prepare(shell, request) {
  const refusal = seamRefusal(shell)
  if (refusal !== null) throw new Error(refusal)
  const execution = await shell.execute(shell.resolve(request))
  if (execution === null || typeof execution !== 'object' || typeof execution.result !== 'function') {
    throw new Error(
      'ctx.shell.execute did not answer with a ShellExecution handle (no result()): this shell implementation does not match the plugin\'s seam, so no command can run.',
    )
  }
  return execution
}

/**
 * Bind the driver to one activation's shell service.
 *
 * The seam is checked on USE rather than here, on purpose: a mismatch is a defect, and a
 * defect that throws during activation is swallowed by `apply`'s containment catch and
 * shows up only as "the git tool is not available". Checked per call, the same defect
 * reaches the model as the tool's own refusal, next to the log line, which is how the
 * first reported failure was diagnosed at all.
 *
 * @param shell - `ctx.shell` for this activation.
 * @returns the two shapes this plugin needs.
 */
export function createShellDriver(shell) {
  return {
    /**
     * Run one command to completion.
     * @param request - the shell request, without a resolved spec.
     * @returns the settled `ShellRunResult`.
     */
    async runOnce(request) {
      const execution = await prepare(shell, request)
      return await execution.result()
    },
    /**
     * Start a process meant to outlive the call.
     *
     * `onExpiry: 'none'` is forced because it is the only correct expiry for such a
     * process: the alternative, `'kill'`, would end the operator's proxy at the deadline.
     * No `timeoutMs` is sent either — the executor rejects a non-positive one, and its
     * default stops mattering once no deadline is armed.
     *
     * @param request - the shell request for the long-lived process.
     * @returns the running handle, for `readOutput()` and `kill()`.
     */
    async startBackground(request) {
      const execution = await prepare(shell, { ...request, onExpiry: 'none' })
      if (typeof execution.kill !== 'function') {
        throw new Error('ctx.shell.execute answered with a handle that cannot be killed, so a process this plugin starts could never be stopped.')
      }
      return execution
    },
  }
}
