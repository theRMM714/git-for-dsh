/**
 * Tests for the shell driver: the one module that touches `ctx.shell`.
 *
 * Every other test in this suite fakes the plugin's other collaborators; this file is
 * where the seam ITSELF is pinned, because a fixture that agrees with a wrong call site
 * is exactly how this plugin shipped a completely dead tool with a green suite. The
 * contract under test is the harness's `ShellExecutor`:
 *
 *   resolve(request) -> spec
 *   execute(spec)    -> handle with result()
 *
 * @module git-for-dsh/test/shell-driver
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SHELL_SEAM, createShellDriver } from '../src/shell-driver.js'

/** A settled `ShellRunResult`, as the harness shapes one. */
const RESULT = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  timeoutMs: 1000,
  stdout: { text: 'ok\n', truncated: false },
  stderr: { text: '', truncated: false },
}

/**
 * Build a shell service shaped like the real seam, recording what it was asked.
 * @param overrides - per-test changes: `spec`, `result`, `handle`, or `onExecute`.
 * @returns the service plus the recorder.
 */
function fakeShell(overrides = {}) {
  const recorded = { resolved: [], executed: [], resultCalls: 0 }
  return {
    recorded,
    service: {
      resolve(request) {
        recorded.resolved.push(request)
        return overrides.spec ?? { ...request, workdir: request.workdir ?? '/process/cwd', timeoutMs: request.timeoutMs ?? 1000, onExpiry: request.onExpiry ?? 'kill' }
      },
      execute(spec) {
        recorded.executed.push(spec)
        if (overrides.onExecute !== undefined) return overrides.onExecute(spec)
        return Promise.resolve(
          overrides.handle ?? {
            // A real handle can always be stopped; the driver refuses one that cannot.
            kill() {},
            result() {
              recorded.resultCalls += 1
              return Promise.resolve(overrides.result ?? RESULT)
            },
          },
        )
      },
    },
  }
}

describe('shell driver: runOnce', () => {
  it('resolves, executes, and settles the result', async () => {
    const { service, recorded } = fakeShell()
    const result = await createShellDriver(service).runOnce({ command: 'git status' })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(recorded.resolved.map((request) => request.command), ['git status'])
    assert.deepEqual(recorded.executed.map((spec) => spec.command), ['git status'])
    // Foreground means the caller awaited the result: the handle was consumed once.
    assert.equal(recorded.resultCalls, 1)
  })

  it('hands the RESOLVED spec to execute, not the raw request', async () => {
    // The deployment default workdir is applied by `resolve`; skipping it is how a
    // command lands in the process cwd instead of the session workspace.
    const { service, recorded } = fakeShell()
    await createShellDriver(service).runOnce({ command: 'git status' })
    assert.equal(recorded.executed[0].workdir, '/process/cwd')
  })

  it('carries a rejected resolve out to the caller', async () => {
    // The proxy launch once sent `timeoutMs: 0`; the real executor rejects it, and that
    // rejection must reach the caller rather than be swallowed into "no output".
    const { service } = fakeShell()
    service.resolve = () => {
      throw new Error('timeoutMs must be a positive finite number')
    }
    await assert.rejects(() => createShellDriver(service).runOnce({ command: 'git status', timeoutMs: 0 }), /positive finite/)
  })

  it('carries a failed preparation out to the caller', async () => {
    const { service } = fakeShell({ onExecute: () => Promise.reject(new Error('spawn failed')) })
    await assert.rejects(() => createShellDriver(service).runOnce({ command: 'git status' }), /spawn failed/)
  })

  it('carries a rejected result out to the caller', async () => {
    const { service } = fakeShell({ handle: { result: () => Promise.reject(new Error('infrastructure failure')) } })
    await assert.rejects(() => createShellDriver(service).runOnce({ command: 'git status' }), /infrastructure failure/)
  })
})

describe('shell driver: startBackground', () => {
  it('arms no deadline, sends no timeout, and keeps the handle', async () => {
    const { service, recorded } = fakeShell()
    const handle = await createShellDriver(service).startBackground({ command: 'fake-proxy --port 7897' })
    assert.equal(recorded.resolved[0].onExpiry, 'none', 'a process that outlives the call must not be killed at a deadline')
    assert.equal(recorded.resolved[0].timeoutMs, undefined, 'the default timeout is inert under onExpiry none, and 0 is rejected outright')
    assert.equal(recorded.resultCalls, 0, 'a background launch must not await its own result')
    assert.equal(typeof handle.kill, 'function')
  })

  it('refuses a handle that could never be stopped', async () => {
    // The proxy disposer kills exactly what this activation started; a handle without
    // `kill` would leave the process behind with no way to notice.
    const { service } = fakeShell({ handle: { result: () => Promise.resolve(RESULT) } })
    await assert.rejects(() => createShellDriver(service).startBackground({ command: 'fake-proxy' }), /cannot be killed/)
  })
})

describe('shell driver: the seam is checked, and the check names the cause', () => {
  it('declares exactly the harness methods', () => {
    assert.deepEqual([...SHELL_SEAM], ['resolve', 'execute'])
  })

  it('refuses a shell that has no execute(), by name', async () => {
    // The reported production failure was "ctx.shell.run is not a function" — a message
    // that names the CALLER's typo and nothing about the mismatch. A missing seam method
    // must instead say which method is missing and that it is a plugin/harness mismatch.
    const driver = createShellDriver({ resolve: () => ({}) })
    await assert.rejects(() => driver.runOnce({ command: 'git status' }), /does not implement the shell seam[\s\S]*typeof execute === undefined/)
    await assert.rejects(() => driver.startBackground({ command: 'fake-proxy' }), /plugin\/harness mismatch/)
  })

  it('refuses an execution that is not a handle', async () => {
    const { service } = fakeShell({ onExecute: () => Promise.resolve(RESULT) })
    await assert.rejects(() => createShellDriver(service).runOnce({ command: 'git status' }), /no result\(\)/)
  })

  it('refuses a missing service with a message that says so', async () => {
    await assert.rejects(() => createShellDriver(undefined).runOnce({ command: 'git status' }), /no shell service/)
  })
})
