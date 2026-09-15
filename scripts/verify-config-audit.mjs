/**
 * Verifies the repository-config audit against a REAL git binary.
 *
 * Why this exists: the first version asked git for
 * `config --local --includes --name-only -z`, which git 2.55 rejects with exit 129
 * ("no action specified" — `--name-only` requires `--list`). Because a failed read
 * is deliberately not a refusal, the gate was INERT: every call passed, and the
 * unit test happily passed too, since it asserted a substring of the command
 * rather than a command git accepts.
 *
 * So this script checks the two things a unit test cannot: that the command git is
 * asked to run actually runs, and that its real output is parsed into the keys the
 * verdict is made from — including keys that arrived through `[include]`, which a
 * plain `--local --list` hides while they still execute.
 *
 *   node scripts/verify-config-audit.mjs
 *
 * @module git-for-dsh/scripts/verify-config-audit
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONFIG_AUDIT_COMMAND, auditRepoConfig, buildEnv, parseConfigKeys } from '../src/git-catalog.js'

const repo = fileURLToPath(new URL('../.git-test-fixture/', import.meta.url))
if (!existsSync(repo)) {
  console.error(`the fixture repository is missing: ${repo}`)
  process.exit(2)
}

const configPath = `${repo}/.git/config`
const includePath = `${repo}/.git/audit-include`
const pristine = readFileSync(configPath, 'utf8')

const failures = []
const check = (label, condition, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${!condition && detail !== undefined ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

/**
 * Run the audit command the gate uses, against the real repository.
 * @returns the parsed keys, the exit code, and the raw stderr.
 */
function runAudit() {
  const argv = CONFIG_AUDIT_COMMAND.split(' ').slice(1)
  const result = spawnSync('git', argv, { cwd: repo, env: { ...process.env, ...buildEnv() }, encoding: 'utf8' })
  const stdout = result.stdout ?? ''
  return { keys: parseConfigKeys(stdout), status: result.status, stderr: result.stderr ?? '' }
}

const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

try {
  // ── 1. The command must actually run ──────────────────────────────────────
  const clean = runAudit()
  check('the audit command exits 0 (a rejected command would make the gate inert)', clean.status === 0, `exit ${clean.status}: ${clean.stderr.trim()}`)
  check('it reports the keys of this repository', clean.keys.includes('core.repositoryformatversion'), JSON.stringify(clean.keys.slice(0, 6)))
  check('a clean repository passes the audit', auditRepoConfig(clean.keys, 'status', 'refuse-repo').ok)

  // ── 2. A dangerous key written directly into .git/config ──────────────────
  writeFileSync(configPath, `${pristine}[alias]\n\tco = checkout\n`)
  const aliased = runAudit()
  check('a directly written key is seen', aliased.keys.includes('alias.co'), JSON.stringify(aliased.keys.filter((k) => k.startsWith('alias'))))
  check('and the default verdict refuses it', !auditRepoConfig(aliased.keys, 'status', 'refuse-repo').ok)

  // ── 3. The same key smuggled through [include] ────────────────────────────
  // This is the case a plain `--local --list` misses: the keys execute while
  // staying invisible to it.
  writeFileSync(includePath, "[core]\n\tfsmonitor = sh -c 'true'\n")
  writeFileSync(configPath, `${pristine}[include]\n\tpath = ${includePath}\n`)
  const included = runAudit()
  check('a key that arrived through [include] is seen', included.keys.includes('core.fsmonitor'), JSON.stringify(included.keys.filter((k) => k === 'core.fsmonitor')))
  check('and it is refused', !auditRepoConfig(included.keys, 'status', 'refuse-repo').ok)

  const withoutIncludes = spawnSync('git', ['config', '--local', '--list', '--name-only', '-z'], { cwd: repo, env: { ...process.env, ...buildEnv() }, encoding: 'utf8' })
  check(
    'control: without --includes the same key stays invisible',
    !parseConfigKeys(withoutIncludes.stdout ?? '').includes('core.fsmonitor'),
    'the include case is not actually a bypass, so this script proves nothing',
  )

  // ── 4. The configured verdicts differ as documented ───────────────────────
  const aliasOnly = auditRepoConfig(['alias.co'], 'status', 'refuse-affected')
  check('refuse-affected lets an unaffected subcommand through', aliasOnly.ok)
  const aliasDiff = auditRepoConfig(['diff.evil.command'], 'diff', 'refuse-affected')
  check('refuse-affected refuses the subcommand it affects', !aliasDiff.ok)
  const pinned = auditRepoConfig(['core.pager'], 'status', 'neutralize')
  check('neutralize allows a key the tool pins', pinned.ok)
  const wildcard = auditRepoConfig(['filter.evil.clean'], 'status', 'neutralize')
  check('neutralize still refuses a key it cannot pin', !wildcard.ok)
} finally {
  // The fixture is not a place to leave hostile state behind.
  writeFileSync(configPath, pristine)
  if (existsSync(includePath)) unlinkSync(includePath)
  const restored = git(['config', '--local', '--list', '--name-only', '-z'])
  const leaked = ['core.fsmonitor', 'alias.co', 'include.path'].filter((key) => parseConfigKeys(restored).includes(key))
  console.log(`\nfixture restored (${leaked.length === 0 ? 'no residual keys' : 'RESIDUAL: ' + leaked.join(', ')})`)
}

console.log(failures.length === 0 ? '\nRESULT: the audit runs, sees included keys, and applies each verdict' : `\nRESULT: ${failures.length} check(s) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
