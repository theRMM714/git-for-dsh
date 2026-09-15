/**
 * The plugin's diagnostic log.
 *
 * Why it exists: the operator reported freezes that no reproduction pinned down, and the
 * only way to find them is a timeline that survives the hang. The last line before a
 * freeze is the evidence — so every entry carries a millisecond cost where one is
 * measurable.
 *
 * Three rules shape this file:
 *
 *  1. **Every line is durable before the next step runs.** The first version streamed,
 *     so a line could be generated and then lost in the buffer when the event loop
 *     stopped — which is precisely when the log matters, and it made `guard.enter` without
 *     `guard.exit` ambiguous between "the guard hung" and "the process stopped". A
 *     synchronous append is one small write per call, on the file the operator chose.
 *  2. **Never break a call.** A logging failure disables logging and nothing else.
 *  3. **Never log a secret.** Callers pass lengths and rule names rather than command
 *     text, and anything that does reach here is redacted for credential URLs and
 *     truncated. The transcript is not the only place a token can leak into.
 *
 * @module git-for-dsh/log
 */
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

/** Rotate before the file grows past this. */
export const LOG_LIMIT_BYTES = 2 * 1024 * 1024

/** The default destination, beside the rest of the harness state. */
export function defaultLogPath() {
  const home = process.env.DSH_HOME
  return resolvePath(home !== undefined && home.length > 0 ? home : resolvePath(homedir(), '.dsh'), 'git-for-dsh.log')
}

/**
 * Redact and bound one value.
 *
 * A credential URL is the one shape that must never reach a file, and length bounding
 * keeps a large argument from filling the log with itself.
 *
 * @param value - any logged value.
 * @returns a single-line, redacted, bounded string.
 */
export function formatValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const safe = text.replace(/\/\/[^/\s@]+:[^/\s@]*@/g, '//<redacted>@')
  return safe.length > 200 ? `${safe.slice(0, 200)}…(${String(safe.length)})` : safe
}

/** How often the size is checked, in appended lines. */
const ROTATE_CHECK_EVERY = 200

/**
 * Rotate an oversized file.
 *
 * Sampled rather than per line: a stat on every append would put the syscall-per-call
 * pattern back that the guard was just cured of.
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
 * Build the log handle.
 *
 * The destination is read through a getter rather than captured, so the settings page can
 * turn logging on, off, or elsewhere and take effect on the next line instead of at the
 * next restart — which is the point of having it during a live investigation.
 *
 * @param read - returns the current `{ enabled, path }`.
 * @returns `{ line, close }`.
 */
export function createDiagnosticLog(read) {
  let sinceCheck = 0

  return {
    /**
     * Append one entry, and do not return until it is written.
     * @param event - a short event name.
     * @param fields - measured values; never a secret.
     */
    line(event, fields = {}) {
      let config
      try {
        config = read()
      } catch {
        return
      }
      if (config === undefined || config.enabled !== true) return
      const path = typeof config.path === 'string' && config.path.length > 0 ? config.path : defaultLogPath()
      const parts = [new Date().toISOString(), event]
      for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${formatValue(value)}`)
      try {
        appendFileSync(path, `${parts.join(' ')}\n`)
      } catch {
        // A logging failure must never fail the call it was describing.
        return
      }
      sinceCheck += 1
      if (sinceCheck >= ROTATE_CHECK_EVERY) {
        sinceCheck = 0
        rotateIfNeeded(path)
      }
    },
    /** Kept for symmetry with the streamed version: there is nothing to close now. */
    close() {},
  }
}
