/**
 * Tests for the diagnostic log.
 *
 * The log is the instrument this investigation runs on, so its own behaviour is tested
 * against a REAL file rather than a stub: redaction, the enabled switch, live re-targeting
 * when the path setting changes, and the promise that a logging failure never escapes.
 *
 * @module git-for-dsh/test/log
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createDiagnosticLog, defaultLogPath, formatValue } from '../src/log.js'

const scratch = mkdtempSync(join(tmpdir(), 'git-for-dsh-log-'))
after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/**
 * Wait for a streamed write to land.
 *
 * The log is deliberately non-blocking — a synchronous append once froze the whole
 * application when the filesystem stalled — so a test cannot read the file immediately
 * after logging.
 */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 50) })

/** Read a log file's lines, or an empty list when it was never created. */
const lines = (path) => {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
  } catch {
    return []
  }
}

describe('log values', () => {
  it('redacts a credential URL', () => {
    // A transcript is not the only place a token can leak into; a log file is another.
    const formatted = formatValue('https://user:ghp_EXAMPLE@github.com/o/r.git')
    assert.ok(!formatted.includes('ghp_EXAMPLE'))
    assert.match(formatted, /<redacted>@/)

    // A token with no password is the same leak, and was not covered.
    const bare = formatValue('clone https://ghp_abcdefghijklmnopqrst@example.com/team/repo')
    assert.match(bare, /<redacted>@/)
    assert.ok(!bare.includes('ghp_abcdefghijklmnopqrst'), 'the token must not survive')
  })

  it('bounds a long value and says how long it was', () => {
    const formatted = formatValue('x'.repeat(500))
    assert.ok(formatted.length < 260)
    assert.match(formatted, /\(500\)$/)
  })

  it('passes numbers and booleans through', () => {
    assert.equal(formatValue(3), '3')
    assert.equal(formatValue(false), 'false')
  })
})

describe('the log handle', () => {
  it('writes a line per event when enabled', async () => {
    const path = join(scratch, 'enabled.log')
    const log = createDiagnosticLog(() => ({ enabled: true, path }))
    log.line('guard.enter', { tool: 'bash' })
    log.line('guard.exit', { tool: 'bash', verdict: 'allow', ms: 1 })
    await settle()
    const written = lines(path)
    assert.equal(written.length, 2)
    assert.match(written[0], /guard\.enter tool=bash$/)
    assert.match(written[1], /guard\.exit tool=bash verdict=allow ms=1$/)
  })

  it('writes nothing while it is switched off', async () => {
    const path = join(scratch, 'disabled.log')
    const log = createDiagnosticLog(() => ({ enabled: false, path }))
    log.line('guard.enter', { tool: 'bash' })
    // Wait even for the negative case: a queued write could land late.
    await settle()
    assert.deepEqual(lines(path), [])
  })

  it('follows a path change without being rebuilt', async () => {
    // The settings page can redirect the log mid-investigation; that only works if the
    // destination is read per line rather than captured at construction.
    const first = join(scratch, 'before.log')
    const second = join(scratch, 'after.log')
    let current = { enabled: true, path: first }
    const log = createDiagnosticLog(() => current)
    log.line('activate', {})
    current = { enabled: true, path: second }
    log.line('activate', {})
    await settle()
    assert.equal(lines(first).length, 1)
    assert.equal(lines(second).length, 1)
  })

  it('reports its own failure, once, when it cannot write', () => {
    // The most ironic possible hole: the instrument for observing failures failing
    // unobserved. It now tells its caller — once per distinct message, so a broken log does
    // not turn every tool call into console noise.
    const reported = []
    const log = createDiagnosticLog(
      () => ({ enabled: true, path: join(scratch, 'missing-dir', 'x.log') }),
      (message) => reported.push(message),
    )
    log.line('activate', {})
    log.line('activate', {})
    assert.equal(reported.length, 1)
    assert.match(reported[0], /cannot write/)
  })

  it('never throws when the destination is unusable', () => {
    // A logging failure must not fail the call it was describing.
    const log = createDiagnosticLog(() => ({ enabled: true, path: join(scratch, 'missing-dir', 'x.log') }))
    assert.doesNotThrow(() => log.line('activate', { a: 1 }))
  })

  it('appends rather than truncating across activations', async () => {
    const path = join(scratch, 'append.log')
    writeFileSync(path, 'first\n')
    createDiagnosticLog(() => ({ enabled: true, path })).line('second', {})
    await settle()
    const written = lines(path)
    assert.equal(written[0], 'first', 'the pre-existing content is kept')
    assert.match(written[1], / second$/, 'and the new line is appended after it')
  })
})

describe('two gates, one file', () => {
  it('lets either purpose log alone', async () => {
    const path = join(scratch, 'gates.log')
    // The call log's switch is off, the heartbeat's is on.
    const calls = createDiagnosticLog(() => ({ enabled: false, path }))
    const beats = createDiagnosticLog(() => ({ enabled: true, path }))
    calls.line('guard.enter', { tool: 'bash' })
    beats.line('heartbeat', { n: 1, open: 'none' })
    await settle()
    const written = lines(path)
    assert.equal(written.length, 1)
    assert.match(written[0], /heartbeat n=1 open=none$/)
  })

  it('writes both when both are on, and neither when both are off', async () => {
    const path = join(scratch, 'gates-both.log')
    const on = createDiagnosticLog(() => ({ enabled: true, path }))
    on.line('guard.enter', { tool: 'bash' })
    on.line('heartbeat', { n: 1 })
    const off = createDiagnosticLog(() => ({ enabled: false, path: join(scratch, 'never.log') }))
    off.line('heartbeat', { n: 2 })
    await settle()
    assert.equal(lines(path).length, 2)
    assert.deepEqual(lines(join(scratch, 'never.log')), [])
  })
})

describe('the default destination', () => {
  it('sits beside the harness state, not on a Windows drive', () => {
    // This file is written synchronously once per tool call, so where it lives is a
    // performance decision, not a cosmetic one.
    assert.match(defaultLogPath(), /git-for-dsh\.log$/)
    assert.ok(defaultLogPath().startsWith('/'))
  })
})
