/**
 * Verifies the null device against a REAL git for Windows.
 *
 * Why this exists: git-for-dsh hides two things behind a null device —
 * the user/system configuration (GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM) and the
 * repository hook lookup (core.hooksPath) — and it names that device NUL on
 * Windows, /dev/null elsewhere (NULL_DEVICE in git-catalog.js). No unit test
 * exercises the NUL branch, and a device name is exactly the kind of value a unit
 * test can only assert as a string: "the env says NUL" is not "git git behaves".
 *
 * So this script drives the real binary with the real buildEnv() output and checks
 * the four things only a real git can answer:
 *
 *   1. does git read the device as an empty file (config hiding, --file NUL)?
 *   2. is it equivalent to /dev/null for git for Windows?
 *   3. does core.hooksPath=NUL actually suppress a hook that WOULD otherwise run?
 *   4. can anything in a worktree take the name over — a real file named NUL,
 *      which libuv happily creates, or a repo-local core.hooksPath?
 *
 * Every child gets fd-backed stdio rather than pipes, so this script also runs
 * inside a sandbox that denies named pipes.
 *
 * Two checks need git for Windows to fork MSYS2 sh.exe (the failing-hook control
 * and a local clone). A sandbox that denies named pipes stops sh.exe from creating
 * its signal pipe; those two are reported as "skip" and the script exits 2 instead
 * of pretending they passed.
 *
 *   node scripts/verify-nul-device.mjs [--lib <path to git-catalog.js>] [--keep]
 *
 * @module git-for-dsh/scripts/verify-nul-device
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/*
 * Windows only, and it says so instead of failing: off win32 the null device is /dev/null — a
 * name git treats as an ordinary path — so the hook-suppression and file-injection checks would
 * report failures that say nothing about the plugin. Exit 2 is the same "not fully verified"
 * code this script already uses for its skips.
 */
if (process.platform !== 'win32') {
  console.error('verify-nul-device: needs Windows; on ' + process.platform + ' the null device is /dev/null, so there is nothing here to verify (exit 2)')
  process.exit(2)
}

const flag = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1] === '--keep' ? undefined : process.argv[index + 1]
}
const keep = process.argv.includes('--keep')

const libPath = path.resolve(flag('--lib') ?? process.env.GIT_FOR_DSH_LIB ?? path.join(here, '..', 'src', 'git-catalog.js'))
if (!fs.existsSync(libPath)) {
  console.error('cannot find ' + libPath + ' — pass --lib <path to git-for-dsh/src/git-catalog.js>')
  process.exit(2)
}
const catalog = await import('file:///' + libPath.replace(/\\/g, '/'))

/* ── scratch: an isolated HOME, a hook that blocks, and a real repository ──── */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-verify-'))
const homeDir = path.join(scratch, 'home')
const repoDir = path.join(scratch, 'repo')
const hookDir = path.join(scratch, 'hooks')
const cloneDir = path.join(scratch, 'clone')
const initDir = path.join(scratch, 'init')
const sentinel = path.join(scratch, 'HOOK-RAN')
const markerFile = path.join(homeDir, '.gitconfig')
const outFile = path.join(scratch, '.stdout')
const errFile = path.join(scratch, '.stderr')
for (const dir of [homeDir, repoDir, hookDir, initDir]) fs.mkdirSync(dir, { recursive: true })

/* One marker key in an isolated user-level config, so "was the user config read?"
 * is answerable without touching (or printing) the machine's own file. */
fs.writeFileSync(markerFile, '[marker]\n\tvalue = from-user-config\n')
const isolatedHome = {
  HOME: homeDir,
  USERPROFILE: homeDir,
  HOMEDRIVE: path.parse(homeDir).root.slice(0, 2),
  HOMEPATH: homeDir.slice(2),
}

/* A pre-commit hook that proves it ran (sentinel) and blocks the commit. */
const hookBody = '#!/bin/sh\necho ran > "' + sentinel.replace(/\\/g, '/') + '"\nexit 1\n'
fs.writeFileSync(path.join(hookDir, 'pre-commit'), hookBody)
const defaultHook = path.join(repoDir, '.git', 'hooks', 'pre-commit')

/** Run git with fd-backed stdio (no pipes) and a hard timeout. */
function git(args, { env = {}, cwd = repoDir, timeout = 30_000 } = {}) {
  const out = fs.openSync(outFile, 'w')
  const err = fs.openSync(errFile, 'w')
  const started = Date.now()
  const child = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', out, err],
    windowsHide: true,
    timeout,
  })
  fs.closeSync(out)
  fs.closeSync(err)
  return {
    args,
    code: child.status,
    timedOut: child.error?.code === 'ETIMEDOUT',
    spawnError: child.error?.code,
    ms: Date.now() - started,
    out: fs.readFileSync(outFile, 'utf8'),
    err: fs.readFileSync(errFile, 'utf8'),
  }
}

/**
 * Delete a file whose NAME is a Windows device name. existsSync lies about these
 * (libuv reports ENOENT for NUL), so the plain path is tried first and the \\?\
 * long-path form — the only spelling that reaches the real file — is the fallback.
 */
function removeDeviceNamed(target) {
  try { fs.rmSync(target, { force: true }) } catch { /* not reachable this way */ }
  try { fs.unlinkSync('\\\\?\\' + path.resolve(target)) } catch { /* already gone */ }
}

/** git for Windows runs hooks and some transports through sh.exe, which needs a signal pipe. */
const shBlocked = (run) => /couldn't create signal pipe/i.test(run.err)
const FORBIDDEN = /NUL|Invalid argument|Permission denied|not found|is not a valid|fatal:/i

const failures = []
const skipped = []
let checks = 0
const check = (label, condition, detail) => {
  checks += 1
  if (condition) return console.log('  ok   ' + label)
  failures.push(label)
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
}
const skip = (label, detail) => {
  checks += 1
  skipped.push(label)
  console.log('  skip ' + label + (detail === undefined ? '' : ' — ' + detail))
}
const detail = (run) => 'exit=' + run.code + (run.timedOut ? ' TIMED OUT' : '')
  + (run.spawnError ? ' spawn=' + run.spawnError : '') + ' err=' + JSON.stringify(run.err.trim().slice(0, 200))

const fatal = (message) => {
  console.error('setup failed: ' + message)
  console.log('\nRESULT: no verdict — the fixture could not be built')
  process.exit(2)
}

console.log('NUL device vs git for Windows')
console.log('  platform ' + process.platform + '  node ' + process.version + '  lib ' + libPath)

/* ── 1. what the plugin actually produces on this platform ─────────────────── */
console.log('\n── 1. the value git-for-dsh ships for this platform ─────────────────')
const nullDevice = catalog.NULL_DEVICE
const env = catalog.buildEnv()
const version = git(['--version'], { cwd: scratch })
check('git is reachable', version.code === 0 && /^git version/.test(version.out), detail(version))
console.log('  info ' + version.out.trim())
check('NULL_DEVICE is NUL on win32', process.platform !== 'win32' || nullDevice === 'NUL', 'NULL_DEVICE=' + JSON.stringify(nullDevice))
check('buildEnv() pins user+system config and core.hooksPath at the device',
  env.GIT_CONFIG_GLOBAL === nullDevice && env.GIT_CONFIG_SYSTEM === nullDevice
    && env.GIT_CONFIG_KEY_1 === 'core.hooksPath' && env.GIT_CONFIG_VALUE_1 === nullDevice,
  'GIT_CONFIG_GLOBAL=' + env.GIT_CONFIG_GLOBAL + ' GIT_CONFIG_SYSTEM=' + env.GIT_CONFIG_SYSTEM
    + ' core.hooksPath=' + env.GIT_CONFIG_VALUE_1)

/* ── 2. the device as NODE sees it (git sees something else) ───────────────── */
console.log('\n── 2. the device as node sees it ────────────────────────────────────')
/*
 * libuv refuses to open the reserved device name for READING — stat and read both
 * fail with ENOENT — while its WRITE path creates a REAL FILE called NUL in the
 * working directory (it reaches the filesystem through the \\?\ long-path form,
 * where reserved names are not special). Neither fact is about git, but both
 * matter: any node-side check of the device is wrong, and the file libuv can
 * create is the injection fixture for section 8.
 */
const nodeView = {}
{
  const dir = path.join(scratch, 'node-view')
  fs.mkdirSync(dir, { recursive: true })
  const cwd = process.cwd()
  process.chdir(dir)
  const probe = (fn) => { try { return fn() } catch (error) { return 'ERR ' + error.code } }
  nodeView.existsSync = probe(() => fs.existsSync('NUL'))
  nodeView.statSync = probe(() => { fs.statSync('NUL'); return 'ok' })
  nodeView.readFileSync = probe(() => fs.readFileSync('NUL', 'utf8'))
  nodeView.dosDeviceRead = probe(() => fs.readFileSync('\\\\.\\NUL', 'utf8'))
  nodeView.write = probe(() => { fs.writeFileSync('NUL', 'created-by-libuv\n'); return 'ok' })
  nodeView.realFileCreated = fs.readdirSync(dir).some((name) => /^nul$/i.test(name))
  removeDeviceNamed(path.join(dir, 'NUL'))
  nodeView.cleaned = fs.readdirSync(dir).length === 0
  process.chdir(cwd)
}
check('node cannot READ the device (existsSync false, stat/read ENOENT)',
  nodeView.existsSync === false && nodeView.statSync === 'ERR ENOENT' && nodeView.readFileSync === 'ERR ENOENT',
  JSON.stringify(nodeView))
check('the DOS form reads as empty, and a node WRITE creates a real file named NUL',
  nodeView.dosDeviceRead === '' && nodeView.write === 'ok' && nodeView.realFileCreated === true && nodeView.cleaned === true,
  JSON.stringify(nodeView))

/* ── 3. user-level config: hidden, and equivalent to /dev/null ─────────────── */
console.log('\n── 3. GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM ─────────────────────────')
const withHome = (overlay) => ({ ...overlay, ...isolatedHome })
const control = git(['config', '--get', 'marker.value'], { env: withHome({ GIT_CONFIG_GLOBAL: markerFile }), cwd: scratch })
const viaNul = git(['config', '--get', 'marker.value'], { env: withHome(env) })
const viaDevNull = git(['config', '--get', 'marker.value'], { env: withHome({ ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }) })
check('control: an un-hidden user config IS read',
  control.code === 0 && control.out.trim() === 'from-user-config', detail(control) + ' out=' + JSON.stringify(control.out.trim()))
check('GIT_CONFIG_GLOBAL=NUL hides the user config, no error',
  viaNul.code !== 0 && viaNul.out.trim() === '' && !FORBIDDEN.test(viaNul.err), detail(viaNul))
check('NUL and /dev/null are equivalent for git for Windows',
  viaNul.code === viaDevNull.code && viaNul.out.trim() === viaDevNull.out.trim(),
  'NUL exit=' + viaNul.code + ' /dev/null exit=' + viaDevNull.code)
const systemOnly = { ...env }
delete systemOnly.GIT_CONFIG_NOSYSTEM
const systemRun = git(['config', '--list', '--show-origin'], { env: withHome(systemOnly), cwd: scratch })
check('GIT_CONFIG_SYSTEM=NUL is accepted on its own (no NOSYSTEM shortcut)',
  systemRun.code === 0 && !FORBIDDEN.test(systemRun.err), detail(systemRun))

/* ── 4. hooks: is the suppression real, or merely quiet? ───────────────────── */
console.log('\n── 4. core.hooksPath=NUL ────────────────────────────────────────────')
fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n')
const init = git(['init', '-q', '-b', 'main'], { cwd: repoDir })
const seed = [
  git(['config', 'user.name', 'nul verify'], { cwd: repoDir }),
  git(['config', 'user.email', 'nul@example.invalid'], { cwd: repoDir }),
  git(['add', '-A'], { cwd: repoDir }),
  git(['commit', '-q', '-m', 'base'], { cwd: repoDir }),
]
if (init.code !== 0 || seed.some((run) => run.code !== 0)) fatal('could not build the scratch repository: ' + detail(init) + ' ' + seed.map(detail).join(' '))

/* Installed only now: the seed commit above must not be blocked by it. */
fs.writeFileSync(defaultHook, hookBody)
const pinnedWithoutHooks = {
  ...env, GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat',
  GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'advice.detachedHead', GIT_CONFIG_VALUE_2: 'false',
}
fs.rmSync(sentinel, { force: true })
const hookControl = git(['commit', '--allow-empty', '-m', 'control'], { env: withHome(pinnedWithoutHooks), cwd: repoDir })
if (shBlocked(hookControl)) {
  skip('control: the failing hook runs and blocks the commit', 'sh.exe could not start in this sandbox: ' + JSON.stringify(hookControl.err.trim().slice(0, 120)))
} else {
  check('control: the failing hook runs and blocks the commit',
    hookControl.code !== 0 && fs.existsSync(sentinel), detail(hookControl) + ' sentinel=' + fs.existsSync(sentinel))
}

fs.rmSync(sentinel, { force: true })
const hookNul = git(['commit', '--allow-empty', '-m', 'nul'], { env: withHome(env), cwd: repoDir })
check('the NUL pin suppresses that same hook (commit succeeds, hook does not run)',
  hookNul.code === 0 && !hookNul.timedOut && !fs.existsSync(sentinel) && !FORBIDDEN.test(hookNul.err),
  detail(hookNul) + ' sentinel=' + fs.existsSync(sentinel) + ' (' + hookNul.ms + 'ms)')

fs.rmSync(sentinel, { force: true })
git(['config', 'core.hooksPath', hookDir.replace(/\\/g, '/')], { cwd: repoDir })
const adversarial = git(['commit', '--allow-empty', '-m', 'adversarial'], { env: withHome(env), cwd: repoDir })
check('a repo-local core.hooksPath cannot beat the NUL pin',
  adversarial.code === 0 && !fs.existsSync(sentinel), detail(adversarial) + ' sentinel=' + fs.existsSync(sentinel))
const origin = git(['config', '--show-origin', '--get', 'core.hooksPath'], { env: env, cwd: repoDir })
check('the delivered value reports as the environment channel, not a file',
  origin.out.trim() === nullDevice || /command line/.test(origin.out), JSON.stringify(origin.out.trim()))
git(['config', '--unset', 'core.hooksPath'], { cwd: repoDir })

/* ── 5. the device as a config file, read and written ──────────────────────── */
console.log('\n── 5. the device as a config file name ─────────────────────────────')
const fileRead = git(['config', '--file', nullDevice, '--list'], { env: {}, cwd: repoDir })
check('git config --file NUL reads as an empty config',
  fileRead.code === 0 && fileRead.out.trim() === '' && !FORBIDDEN.test(fileRead.err), detail(fileRead))
const globalWrite = git(['config', '--global', 'marker.wrote', 'yes'], { env: withHome(env), cwd: repoDir })
check('a write aimed at the pinned location cannot land in a real file',
  !fs.readFileSync(markerFile, 'utf8').includes('wrote') && fs.readdirSync(homeDir).length === 1,
  'git exit=' + globalWrite.code + ' err=' + JSON.stringify(globalWrite.err.trim().slice(0, 120)) + ' home=' + JSON.stringify(fs.readdirSync(homeDir)))

/* ── 6. the whole subcommand surface, under the pinned env ─────────────────── */
console.log('\n── 6. real subcommands under the pinned env ─────────────────────────')
const readOnly = [
  ['status', '--porcelain'], ['log', '--oneline', '-n', '5'], ['diff', '--stat'], ['show', '--stat', '--oneline', 'HEAD'],
  ['rev-parse', '--git-dir'], ['rev-list', '--count', 'HEAD'], ['ls-files'], ['ls-tree', 'HEAD'], ['cat-file', '-t', 'HEAD'],
  ['for-each-ref'], ['count-objects', '-v'], ['reflog', 'show', '-n', '3'], ['name-rev', 'HEAD'], ['show-ref'],
  ['symbolic-ref', 'HEAD'], ['branch', '--list'], ['tag', '--list'], ['remote', '-v'], ['shortlog', '-sn'],
  ['describe', '--tags', '--always'], ['config', '--list'], ['fsck', '--no-progress'], ['stash', 'list'], ['clean', '-n'],
  ['grep', '-n', 'a', '--', 'a.txt'],
]
const noisy = readOnly.map((args) => ({ run: git(args, { env: withHome(env), cwd: repoDir }), label: args.join(' ') }))
  .filter(({ run }) => run.code !== 0 || run.timedOut || FORBIDDEN.test(run.err))
check('all ' + readOnly.length + ' read-only subcommands run cleanly',
  noisy.length === 0, noisy.map(({ run, label }) => label + ' ' + detail(run)).join(' | ').slice(0, 400))

fs.writeFileSync(path.join(repoDir, 'b.txt'), 'b\n')
const writes = [
  git(['add', '-A'], { env: withHome(env), cwd: repoDir }),
  git(['commit', '-q', '-m', 'smoke write'], { env: withHome(env), cwd: repoDir }),
  git(['tag', 'nul-smoke'], { env: withHome(env), cwd: repoDir }),
]
check('write subcommands (add/commit/tag) run cleanly',
  writes.every((run) => run.code === 0 && !FORBIDDEN.test(run.err)), writes.map((run) => run.args[0] + ' ' + detail(run)).join(' | '))

const initRun = git(['init', '-q', '-b', 'main'], { env: withHome(env), cwd: initDir })
check('git init succeeds (hook templates, empty repo)', initRun.code === 0 && !FORBIDDEN.test(initRun.err), detail(initRun))

const cloneRun = git(['clone', '-q', repoDir.replace(/\\/g, '/'), cloneDir.replace(/\\/g, '/')], { env: withHome(env), cwd: scratch, timeout: 60_000 })
if (shBlocked(cloneRun)) {
  skip('a local clone succeeds', 'sh.exe could not start in this sandbox: ' + JSON.stringify(cloneRun.err.trim().slice(0, 120)))
} else {
  check('a local clone succeeds', cloneRun.code === 0 && fs.existsSync(path.join(cloneDir, 'a.txt')) && !cloneRun.timedOut && !FORBIDDEN.test(cloneRun.err), detail(cloneRun))
}

/* ── 7. adversarial: a REAL file named NUL inside the worktree ─────────────── */
console.log('\n── 7. a real file named NUL in the worktree ────────────────────────')
/*
 * The shipped value is the bare word NUL — a RELATIVE name. If git resolved it
 * against the working directory instead of the Win32 device namespace, anyone able
 * to plant a file called NUL in a worktree (libuv can, as section 2 shows) would be
 * feeding the tool a configuration file: the pin would become an injection point.
 */
const stray = path.join(repoDir, 'NUL')
fs.writeFileSync(stray, '[marker]\n\tvalue = from-stray-file\n[core]\n\thooksPath = ' + hookDir.replace(/\\/g, '/') + '\n')
const strayExists = fs.readdirSync(repoDir).some((name) => /^nul$/i.test(name))
fs.rmSync(sentinel, { force: true })
const strayMarker = git(['config', '--get', 'marker.value'], { env: withHome(env), cwd: repoDir })
const strayCommit = git(['commit', '--allow-empty', '-m', 'stray'], { env: withHome(env), cwd: repoDir })
check('a real file named NUL is created and does not hijack the pinned device',
  strayExists && strayMarker.out.trim() === '' && strayCommit.code === 0 && !fs.existsSync(sentinel),
  'strayFileCreated=' + strayExists + ' markerRead=' + JSON.stringify(strayMarker.out.trim())
    + ' commit=' + strayCommit.code + ' sentinel=' + fs.existsSync(sentinel))
const strayAdd = git(['add', '-A'], { env: withHome(env), cwd: repoDir })
console.log('  info git refuses to index such a file: add -A ' + detail(strayAdd))
removeDeviceNamed(stray)
check('the fixture is left clean', !fs.readdirSync(repoDir).some((name) => /^nul$/i.test(name)))

/* ── result ────────────────────────────────────────────────────────────────── */
if (!keep) fs.rmSync(scratch, { recursive: true, force: true })
else console.log('\nscratch kept at ' + scratch)
const skips = skipped.length === 0 ? '' : ' (' + skipped.length + ' skipped: ' + skipped.join('; ') + ')'
if (failures.length > 0) {
  console.log('\nRESULT: ' + failures.length + ' of ' + checks + ' checks FAILED' + skips)
  process.exit(1)
}
if (skipped.length > 0) {
  console.log('\nRESULT: ' + checks + ' checks, no failures, ' + skipped.length + ' not observable here' + skips)
  process.exit(2)
}
console.log('\nRESULT: NUL works with ' + version.out.trim() + ' — config hidden, hooks suppressed, nothing hijacked')
process.exit(0)
