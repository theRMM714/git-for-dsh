/**
 * The diagnostic log: durable, and gated per purpose.
 *
 * Writes are synchronous, so a line is on disk before the next step runs. That is what makes
 * a missing line mean "this never happened" rather than "this sat in a buffer" — the pair
 * `guard.enter` / `guard.exit` is read that way. The cost is one small append per entry, and
 * the log is the only thing in this plugin that touches the filesystem, which is why its
 * default destination is beside the harness state rather than on a Windows-mounted drive.
 *
 * Two independent gates, because they answer different questions:
 *
 *   - the call log (guard.enter / guard.exit / tool.done) says what the plugin DID;
 *   - the heartbeat says whether the process is ALIVE, and what is stuck if it is not.
 *
 * Either may be on alone: a heartbeat with no call log is a liveness probe; a call log with
 * no heartbeat is an audit trail.
 *
 * @module git-for-dsh/log
 */
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

/** Rotate before the file grows past this. */
export const LOG_LIMIT_BYTES = 2 * 1024 * 1024

/** How often the size is checked, in appended lines. */
const ROTATE_CHECK_EVERY = 200

/** The default destination, beside the rest of the harness state. */
export function defaultLogPath() {
  const home = process.env.DSH_HOME
  return resolvePath(home !== undefined && home.length > 0 ? home : resolvePath(homedir(), '.dsh'), 'git-for-dsh.log')
}

/**
 * Redact and bound one value.
 *
 * A credential URL is the one shape that must never reach a file — and command text does
 * reach this file, so token-shaped strings are redacted as well. Length bounding keeps a
 * large argument from filling the log with itself.
 *
 * @param value - any logged value.
 * @returns a single-line, redacted, bounded string.
 */
export function formatValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const safe = text
    // The password is optional: https://token@host carries one just as
    // https://user:password@host does, and both are credentials.
    .replace(/\/\/[^/\s@]+@/g, '//<redacted>@')
    .replace(/\b(ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '<redacted-token>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted-token>')
    .replace(/(Authorization:\s*\S+\s+)[A-Za-z0-9._-]{16,}/gi, '$1<redacted-token>')
  return safe.length > 200 ? `${safe.slice(0, 200)}…(${String(safe.length)})` : safe
}

/**
 * Rotate an oversized file.
 *
 * Sampled rather than per line: a stat on every append is the syscall-per-call pattern the
 * guard was cured of.
 *
 * @param path - the log file.
 */
function rotateIfNeeded(path) {
  try {
    if (statSync(path).size > LOG_LIMIT_BYTES) renameSync(path, `${path}.1`)
  } catch {
    // A missing file is the normal first case; a rotation failure is not fatal.
  }
}

/**
 * Build one log handle, gated by its own reader.
 *
 * Two handles over one file is deliberate: each purpose carries its own switch, so the
 * operator can watch liveness without logging every call, or log every call without a
 * heartbeat. Appends are small and O_APPEND, so the two interleave safely.
 *
 * @param read - returns the current `{ enabled, path }` for THIS purpose.
 * @returns `{ line, close }`.
 */
export function createDiagnosticLog(read, onFailure) {
  let sinceCheck = 0
  /*
   * The log is the plugin's voice. When the VOICE is what broke there is nothing left to
   * write to, so the caller decides — and it is told once per distinct message, because a
   * broken log must not turn every tool call into console noise.
   */
  const reported = new Set()
  const report = (message) => {
    if (typeof onFailure !== 'function' || reported.has(message)) return
    reported.add(message)
    try {
      onFailure(message)
    } catch {
      // There is nothing left to report to.
    }
  }

  return {
    /**
     * Append one entry, and do not return until it is written.
     *
     * @param event - a short event name.
     * @param fields - measured values; never a secret.
     */
    line(event, fields = {}) {
      let config
      try {
        config = read()
      } catch (error) {
        report(`cannot read its own settings: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (config === undefined || config.enabled !== true) return
      const path = typeof config.path === 'string' && config.path.length > 0 ? config.path : defaultLogPath()
      const parts = [new Date().toISOString(), event]
      for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${formatValue(value)}`)
      try {
        appendFileSync(path, `${parts.join(' ')}\n`)
      } catch (error) {
        // A logging failure must never fail the call it was describing — but it must not
        // vanish either, or a broken log would look like a quiet day.
        report(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      sinceCheck += 1
      if (sinceCheck >= ROTATE_CHECK_EVERY) {
        sinceCheck = 0
        rotateIfNeeded(path)
      }
    },
    /** Kept for symmetry: a synchronous append holds nothing open. */
    close() {},
  }
}
