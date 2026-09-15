/**
 * Test: the committed artifacts match a fresh build.
 *
 * The comparison itself lives in `scripts/verify-artifacts.mjs` so there is one
 * implementation; this only asserts it is clean, which makes a stale `lib/` fail
 * `npm test` instead of surfacing at activation.
 *
 * @module git-for-dsh/test/artifacts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('committed artifacts', () => {
  it('are exactly what the sources build', () => {
    const result = spawnSync(process.execPath, [`${root}scripts/verify-artifacts.mjs`], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(
      result.status,
      0,
      `lib/ is out of date with src/; run "node scripts/build.mjs" and commit lib/\n${result.stdout ?? ''}`,
    )
  })

  it('register under the package name', () => {
    // The bundle's module id IS the package name, so a rename cannot leave the two
    // disagreeing: the id is substituted at build time and asserted here.
    const name = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).name
    const source = readFileSync(`${root}lib/client.js`, 'utf8')
    assert.ok(source.includes(`id: ${JSON.stringify(name)}`), 'the served bundle registers under the package name')
    const patch = readFileSync(`${root}cordis.patch.yml`, 'utf8')
    assert.ok(patch.includes(`name: ${name}`), 'the loader row names the package')
  })
})
