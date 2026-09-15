/**
 * Port probing for the user's own proxy.
 *
 * The plugin does NOT proxy anything and never touches a credential: it starts the
 * proxy the operator configured, and points git at it. That is the whole feature —
 * it exists so nobody has to `export HTTPS_PROXY=…` before launching dsh.
 *
 * @module git-for-dsh/proxy
 */
import { connect } from 'node:net'

/** How long a probe waits before deciding nothing is listening. */
export const PROBE_TIMEOUT_MS = 400

/**
 * Ask whether something accepts a TCP connection on this address.
 *
 * A listening socket is all this can see: the probe cannot tell the operator's
 * proxy from an unrelated service, so callers must not treat "listening" as
 * "usable" without also knowing who started it.
 *
 * @param host - host to connect to.
 * @param port - port to connect to.
 * @param timeoutMs - how long to wait before answering false.
 * @returns true when a connection was established.
 */
export function probePort(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (listening) => {
      if (settled) return
      settled = true
      socket.destroy()
      clearTimeout(timer)
      resolve(listening)
    }
    const socket = connect({ host, port })
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    // ECONNREFUSED and friends mean "nothing is listening".
    socket.once('error', () => finish(false))
  })
}

/**
 * Wait for a port to start accepting connections.
 *
 * @param host - host to poll.
 * @param port - port to poll.
 * @param timeoutMs - total budget.
 * @param signal - aborts the wait.
 * @returns true when the port came up before the budget ran out.
 */
export async function waitForPort(host, port, timeoutMs = 5000, signal = undefined) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted === true) return false
    // eslint-disable-next-line no-await-in-loop -- polling is the point
    if (await probePort(host, port, 250)) return true
    // eslint-disable-next-line no-await-in-loop -- polling is the point
    await new Promise((resolve) => {
      setTimeout(resolve, 150)
    })
  }
  return false
}

/**
 * The environment overrides that route git through the proxy.
 * @param host - proxy host.
 * @param port - proxy port.
 * @returns the child-environment entries to add.
 */
export function proxyEnvironment(host, port) {
  const url = `http://${host}:${String(port)}`
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    // The proxy must not be used to reach itself, and local remotes keep working.
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  }
}
