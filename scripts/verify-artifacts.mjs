/**
 * Fails when the committed `lib/` no longer matches a fresh build of `src/`.
 *
 * Why this exists: `lib/` is committed so that installing from git needs no build step
 * (pnpm 12 gates build scripts behind a per-commit allowBuilds key, which would make
 * every update require a new key). A committed artifact can drift from its source, so
 * the drift has to be a FAILURE rather than a surprise at activation.
 *
 * The build is reproducible — the stamp is a content digest, not a timestamp — so the
 * comparison is byte-for-byte and needs no tolerance.
 *
 *   node scripts/verify-artifacts.mjs
 *
 * @module git-for-dsh/scripts/verify-artifacts
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const lib = fileURLToPath(new URL('../lib/', import.meta.url))
const scratch = fileURLToPath(new URL('../.tmp-verify/', import.meta.url))

/** The host modules the build copies, plus the generated client bundle. */
const ARTIFACTS = ['index.js', 'git-catalog.js', 'proxy.js', 'log.js', 'client.js']

const failures = []
const check = (label, condition, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${!condition && detail !== undefined ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

const build = spawnSync(process.execPath, [`${root}scripts/build.mjs`, '--out', `${scratch}`], {
  cwd: root,
  encoding: 'utf8',
})
check('a fresh build succeeds', build.status === 0, (build.stderr ?? '').trim().split('\n').slice(-1)[0])

for (const artifact of ARTIFACTS) {
  if (!existsSync(`${lib}${artifact}`)) {
    check(`lib/${artifact} is committed`, false, 'not present')
    continue
  }
  const committed = readFileSync(`${lib}${artifact}`, 'utf8')
  const fresh = readFileSync(`${scratch}${artifact}`, 'utf8')
  check(`lib/${artifact} matches src/`, committed === fresh, 'stale — run: node scripts/build.mjs, then commit lib/')
}

rmSync(scratch, { recursive: true, force: true })

console.log(
  failures.length === 0
    ? 'RESULT: the committed artifacts are exactly what the sources build'
    : `RESULT: ${String(failures.length)} artifact(s) out of date`,
)
process.exit(failures.length === 0 ? 0 : 1)
