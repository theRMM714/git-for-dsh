/**
 * The diagnostic log, without blocking the event loop.
 *
 * The history this file records, because the lesson cost three attempts:
 *
 *  1. Streamed writes. Non-blocking, but a line generated just before the process stopped
 *     could sit in the buffer and never reach the disk — which made "guard.enter without
 *     guard.exit" ambiguous between "the guard hung" and "the process stopped".
 *  2. Synchronous appends, to make every line durable. **This is the one that caused the
 *     freezes.** `appendFileSync` blocks the whole event loop when the filesystem stalls,
 *     and the log itself proved it: the heartbeats stopped at exactly the moment a
 *     `guard.exit` went missing, i.e. the timer could not fire because the loop was stuck
 *     inside the write.
 *  3. Back to streamed writes, which is where this file is now. The durability question is
 *     answered by an INDEPENDENT observer instead — a shell loop the operator runs in their
 *     own terminal, appending a timestamp every few seconds. If that stops too, the machine
 *     stalled rather than our process, and no in-process log can tell the difference.
 *
 * A diagnostic tool must never be able to hang the thing it is diagnosing.
 *
 * @module git-for-dsh/log
 */
import { createWriteStream, renameSync } from 'node:fs'
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
 * A credential URL is the one shape that must never reach a file, and length bounding keeps
 * a large argument from filling the log with itself.
 *
 * @param value - any logged value.
 * @returns a single-line, redacted, bounded string.
 */
export function formatValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const safe = text
    // A credential URL.
    .replace(/\/\/[^/\s@]+:[^/\s@]*@/g, '//<redacted>@')
    // Token-shaped strings. Command text reaches this file now, and a token is far more
    // likely to appear inside a command than as a bare argument.
    .replace(/\b(ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '<redacted-token>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted-token>')
    .replace(/(Authorization:\s*\S+\s+)[A-Za-z0-9._-]{16,}/gi, '$1<redacted-token>')
  return safe.length > 200 ? `${safe.slice(0, 200)}…(${String(safe.length)})` : safe
}

/**
 * Open a non-blocking append stream.
 *
 * @param path - the log file.
 * @returns a write stream, or undefined when it cannot be opened.
 */
function openStream(path) {
  try {
    const stream = createWriteStream(path, { flags: 'a' })
    // An error on the stream must never become an unhandled rejection or a thrown call.
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
 * @param read - returns the current `{ enabled, path }`.
 * @returns `{ line, close }`.
 */
export function createDiagnosticLog(read) {
  let open = { path: undefined, stream: undefined, written: 0 }

  const closeOpen = () => {
    if (open.stream !== undefined) {
      try {
        open.stream.end()
      } catch {
        // Closing a broken stream is not a reportable failure.
      }
    }
    open = { path: undefined, stream: undefined, written: 0 }
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
      open = { path, stream: openStream(path), written: 0 }
    }
    return open.stream === undefined || open.stream.__dshBroken === true ? undefined : open.stream
  }

  return {
    /**
     * Append one entry. Queued, never awaited, never synchronous: a diagnostic log that can
     * block the process is worse than no log at all.
     *
     * @param event - a short event name.
     * @param fields - measured values; never a secret.
     */
    line(event, fields = {}) {
      const target = stream()
      if (target === undefined) return
      const parts = [new Date().toISOString(), event]
      for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${formatValue(value)}`)
      const text = `${parts.join(' ')}\n`
      try {
        target.write(text)
      } catch {
        // A write failure must never fail the call it was describing.
        return
      }
      // Rotation is counted, not stat-ed: a stat per append is the syscall-per-call pattern
      // this file exists to avoid.
      open.written += text.length
      if (open.written > LOG_LIMIT_BYTES) {
        const previous = open.path
        closeOpen()
        try {
          renameSync(previous, `${previous}.1`)
        } catch {
          // A failed rotation costs a larger file, nothing more.
        }
      }
    },
    close: closeOpen,
  }
}
