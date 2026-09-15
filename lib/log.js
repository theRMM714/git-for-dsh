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
 *  1. **Never make a call wait.** The writes are streamed, so no tool call ever blocks on
 *     the filesystem. A synchronous append would add exactly the hazard this log exists
 *     to find.
 *  2. **Never break a call.** A logging failure disables logging and nothing else.
 *  3. **Never log a secret.** Callers pass lengths and rule names rather than command
 *     text, and anything that does reach here is redacted for credential URLs and
 *     truncated. The transcript is not the only place a token can leak into.
 *
 * @module git-for-dsh/log
 */
import { createWriteStream, renameSync, statSync } from 'node:fs'
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

/**
 * Open a stream, rotating an oversized file first.
 *
 * The rotation happens ONCE per open, not per line: a synchronous stat per line would put
 * the very hazard this log is meant to observe back into the hot path.
 *
 * @param path - the log file.
 * @returns a write stream, or undefined when it cannot be opened.
 */
function openStream(path) {
  try {
    if (statSync(path).size > LOG_LIMIT_BYTES) renameSync(path, `${path}.1`)
  } catch {
    // A missing file is the normal first case; a rotation failure is not fatal.
  }
  try {
    const stream = createWriteStream(path, { flags: 'a' })
    stream.on('error', () => {
      stream.__dshBroken = true
    })
    return stream
  } catch {
    return undefined
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
  let open = { path: undefined, stream: undefined }

  const closeOpen = () => {
    if (open.stream !== undefined) {
      try {
        open.stream.end()
      } catch {
        // Closing a broken stream is not a reportable failure.
      }
    }
    open = { path: undefined, stream: undefined }
  }

  const stream = () => {
    let config
    try {
      config = read()
    } catch {
      return undefined
    }
    if (config === undefined || config.enabled !== true) {
      closeOpen()
      return undefined
    }
    const path = typeof config.path === 'string' && config.path.length > 0 ? config.path : defaultLogPath()
    if (open.path !== path) {
      closeOpen()
      open = { path, stream: openStream(path) }
    }
    return open.stream === undefined || open.stream.__dshBroken === true ? undefined : open.stream
  }

  return {
    /**
     * Append one entry.
     * @param event - a short event name.
     * @param fields - measured values; never a secret.
     */
    line(event, fields = {}) {
      const target = stream()
      if (target === undefined) return
      const parts = [new Date().toISOString(), event]
      for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${formatValue(value)}`)
      try {
        target.write(`${parts.join(' ')}\n`)
      } catch {
        // Streamed writes do not throw for a full pipe; a throw here would still not be
        // worth failing a tool call over.
      }
    },
    close: closeOpen,
  }
}
