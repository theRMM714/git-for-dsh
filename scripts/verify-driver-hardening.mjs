/**
 * Verifies, against a real git binary and a hostile repository, that the two
 * reproduced code-execution paths are closed.
 *
 * The earlier reproductions, both through read-tier operations:
 *
 *   git config --local core.fsmonitor "sh -c '…'"                 → git status ran it
 *   git config --local diff.evil.command "sh -c '…'" + .gitattributes → git diff ran it
 *
 * This script rebuilds the same hostile state and then executes the commands the
 * PLUGIN would build — `buildEnv()` for the child environment and `hardenArgv()`
 * for the argv — so the mitigation is measured rather than assumed.
 *
 *   node scripts/verify-driver-hardening.mjs
 *
 * @module dsh-plugin-git-tool/scripts/verify-driver-hardening
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildEnv, hardenArgv } from '../src/git-catalog.js'

const repo = fileURLToPath(new URL('../.git-test-fixture/', import.meta.url))
if (!existsSync(repo)) {
  console.error(`the fixture repository is missing: ${repo}\nRun the fixture setup first.`)
  process.exit(2)
}

const STATUS_MARKER = 'FSMONITOR_EXECUTED'
const DIFF_MARKER = 'EXTERNAL_DIFF_EXECUTED'
const failures = []

/**
 * Run one git command the plugin's way and report what came back.
 * @param argv - the requested argv, subcommand first.
 * @returns the combined stderr, or the error text.
 */
function run(argv, env) {
  const result = spawnSync('git', argv, { cwd: repo, env, encoding: 'utf8' })
  return {
    argv,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // A driver's marker lands on stderr while git still exits 0, so BOTH streams
    // have to be inspected; watching only stdout would make every check below
    // pass for the wrong reason.
    combined: (result.stdout ?? '') + (result.stderr ?? ''),
    status: result.status,
  }
}

/**
 * Run one git command the way the plugin does.
 * @param argv - the requested argv, subcommand first.
 * @returns the run, with the hardened argv and both output streams.
 */
function runAsPlugin(argv) {
  return run(hardenArgv(argv), buildEnv())
}

const check = (label, condition, detail) => {
  // A detail explains a FAILURE; printing one on success reads as a problem.
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${!condition && detail !== undefined ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

// ── Rebuild the hostile repository state ────────────────────────────────────
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

git(['config', '--local', 'core.fsmonitor', `sh -c 'echo ${STATUS_MARKER} >&2'`])
git(['config', '--local', 'diff.evil.command', `sh -c 'echo ${DIFF_MARKER} >&2'`])
if (!existsSync(`${repo}/.gitattributes`)) writeFileSync(`${repo}/.gitattributes`, 'a.txt diff=evil\n')
writeFileSync(`${repo}/a.txt`, 'alpha\nuncommitted-change\n')

console.log('hostile repository state restored:')
console.log("  core.fsmonitor      = sh -c 'echo " + STATUS_MARKER + " >&2'")
console.log("  diff.evil.command   = sh -c 'echo " + DIFF_MARKER + " >&2'")
console.log('  .gitattributes      = a.txt diff=evil')
console.log('')

// ── The gate that makes both writes impossible in the first place ───────────
{
  const { validateArgv } = await import('../src/git-catalog.js')
  const write = validateArgv(['config', '--local', 'core.fsmonitor', 'sh -c evil'])
  check('config write form is refused by validation', write.ok === false, write.ok === false ? '' : 'it was ACCEPTED')
}

// ── Path 1: status must not run core.fsmonitor ──────────────────────────────
{
  const result = runAsPlugin(['status'])
  check('git status does not execute core.fsmonitor', !result.combined.includes(STATUS_MARKER), result.stderr.trim().slice(0, 80))
}

// ── Path 2: diff must not run the external driver ──────────────────────────
{
  const result = runAsPlugin(['diff', 'a.txt'])
  check('git diff does not execute the diff driver', !result.combined.includes(DIFF_MARKER), result.stderr.trim().slice(0, 80))
  check('the diff flags were injected', result.argv.includes('--no-ext-diff') && result.argv.includes('--no-textconv'), result.argv.join(' '))
}

// ── Control: without the mitigation the driver DOES run ────────────────────
// This proves the check above is measuring something, rather than passing
// because the hostile state was never armed.
{
  // No --no-ext-diff and no pinned keys: this is what the state looks like
  // without the mitigation, and it must run the program.
  const unhardened = run(['diff', 'a.txt'], { ...process.env })
  check(
    'control: an unhardened diff still runs the driver',
    unhardened.combined.includes(DIFF_MARKER),
    'the hostile state is not armed, so the checks above prove nothing',
  )

  const unhardenedStatus = run(['status'], { ...process.env })
  check('control: an unhardened status still runs core.fsmonitor', unhardenedStatus.combined.includes(STATUS_MARKER))
}

// Disarm: this script is a regression check, not a fixture for hostile state.
git(['config', '--local', '--unset', 'core.fsmonitor'])
git(['config', '--local', '--unset', 'diff.evil.command'])
git(['checkout', '--', 'a.txt'])
console.log('\nhostile repository state disarmed')

console.log(failures.length === 0 ? 'RESULT: both code-execution paths are closed' : `RESULT: ${failures.length} check(s) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
