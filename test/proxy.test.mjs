/**
 * Tests for the proxy feature.
 *
 * The probe is tested against a REAL listening socket rather than a mock: the whole
 * point of the probe is what the operating system answers, and a mocked one would
 * pass with a probe that cannot work.
 *
 * @module git-for-dsh/test/proxy
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { probePort, proxyEnvironment, waitForPort } from '../src/proxy.js'

/** A real listener on an ephemeral port, to probe against. */
let server
let port

before(async () => {
  server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

/** A port nothing is listening on: bind one, note it, release it. */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const free = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return free
}

describe('probePort', () => {
  it('reports true when something is listening', async () => {
    assert.equal(await probePort('127.0.0.1', port, 1000), true)
  })

  it('reports false when nothing is listening', async () => {
    assert.equal(await probePort('127.0.0.1', await freePort(), 1000), false)
  })

  it('answers within the timeout on an address that cannot connect', async () => {
    const started = Date.now()
    assert.equal(await probePort('127.0.0.1', await freePort(), 300), false)
    assert.ok(Date.now() - started < 2000, 'the probe must not hang')
  })
})

describe('waitForPort', () => {
  it('returns immediately when the port is already up', async () => {
    assert.equal(await waitForPort('127.0.0.1', port, 1000), true)
  })

  it('gives up when the port never comes up', async () => {
    const started = Date.now()
    assert.equal(await waitForPort('127.0.0.1', await freePort(), 600), false)
    assert.ok(Date.now() - started < 3000, 'the wait must respect its budget')
  })
})

describe('proxyEnvironment', () => {
  it('routes http and https through the proxy, and keeps loopback direct', () => {
    const env = proxyEnvironment('127.0.0.1', 7890)
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890')
    // Without this, a request to the proxy itself would be sent through it.
    assert.match(env.NO_PROXY, /127\.0\.0\.1/)
    assert.match(env.no_proxy, /localhost/)
  })
})
