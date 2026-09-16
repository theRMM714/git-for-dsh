/**
 * The git operation catalog: the single source of truth shared by the Host
 * plugin (which enforces it) and the Client plugin (which renders it as a
 * checkbox list).
 *
 * Nothing here is optional surface area. `ENFORCED_CONFIG`, `FORBIDDEN_GLOBAL`,
 * and `FORBIDDEN_DASH_C` are the security boundary: they stop a caller from
 * turning ANY allowed subcommand into arbitrary code execution through
 * `git -c ...` configuration injection, and `validateArgv` is the only place
 * that decision is made.
 *
 * @module git-for-dsh/git-catalog
 */

/**
 * Risk tier of one subcommand. The tier decides the default in the settings
 * UI and whether a call needs a per-call user approval when
 * `approveMutating` is on.
 *
 * - `read` — inspects the repository or the index; changes nothing. Default ON.
 * - `write` — changes the working tree, the index, or a local ref. Default OFF.
 * - `remote` — talks to a remote or rewrites/removes history. Default OFF.
 */
export const RISK = {
  read: 'read',
  write: 'write',
  remote: 'remote',
}

/** Every risk tier, in the order the settings UI renders them. */
export const RISK_ORDER = [RISK.read, RISK.write, RISK.remote]

/**
 * The complete catalog, grouped exactly as the settings UI groups it.
 *
 * Each operation declares how it accepts operands, and that declaration is what
 * `validateArgv` enforces:
 *
 * - `positional: true` — may carry free-form positional arguments (a revision, a
 *   remote name, a refspec).
 * - `filePaths: true` — may name files/directories; the settings page marks these
 *   as taking a `paths` argument.
 * - neither — flag-only. A trailing operand is refused, which is what closes the
 *   `git count-objects <operand>` class of inputs.
 */
export const CATALOG = [
  {
    group: 'Repository status and history',
    risk: RISK.read,
    title: '只读操作：仓库状态与历史',
    hint: '只读取仓库内容，不改动工作区、暂存区或引用。',
    operations: [
      {
        name: 'status',
        label: '工作区与暂存区状态',
        summary: 'Working-tree and index status.',
        positional: true,
      },
      {
        name: 'diff',
        label: '工作区 / 暂存区 / 提交之间的差异',
        summary: 'Diff of the working tree, the index, or two revisions.',
        positional: true,
      },
      {
        name: 'log',
        label: '提交历史',
        summary: 'Commit history.',
        positional: true,
      },
      {
        name: 'show',
        label: '查看某个提交、标签或对象',
        summary: 'One commit, tag, or blob.',
        positional: true,
      },
      {
        name: 'shortlog',
        label: '按作者汇总的提交列表',
        summary: 'Commits grouped by author.',
        positional: true,
      },
      {
        name: 'describe',
        label: '用可读名称描述提交',
        summary: 'Human-readable name for a commit.',
        positional: true,
      },
      {
        name: 'blame',
        label: '逐行显示最后修改的提交',
        summary: 'Line-by-line last-modifying commit.',
        filePaths: true,
      },
      {
        name: 'rev-parse',
        label: '解析引用、哈希与仓库路径',
        summary: 'Resolve refs, hashes, and repository paths.',
        positional: true,
      },
      {
        name: 'rev-list',
        label: '遍历可达提交',
        summary: 'Walk commits reachable from a revision.',
        positional: true,
      },
      {
        name: 'ls-files',
        label: '列出索引中的文件',
        summary: 'Files tracked in the index.',
        positional: false,
      },
      {
        name: 'ls-tree',
        label: '列出树对象内容',
        summary: 'Contents of a tree object.',
        positional: true,
      },
      {
        name: 'cat-file',
        label: '读取对象原始内容',
        summary: 'Raw content of a repository object.',
        positional: true,
      },
      {
        name: 'count-objects',
        label: '统计对象库大小',
        summary: 'Object-database size statistics.',
        positional: false,
      },
      {
        name: 'for-each-ref',
        label: '枚举所有引用',
        summary: 'Enumerate refs.',
        positional: true,
      },
      {
        name: 'reflog',
        label: '引用日志',
        summary: 'Reference log of HEAD or a branch.',
        positional: true,
      },
      {
        name: 'name-rev',
        label: '用符号名标识提交',
        summary: 'Name a revision symbolically.',
        positional: true,
      },
    ],
  },
  {
    group: 'Inspect refs, remotes, and configuration',
    risk: RISK.read,
    title: '只读操作：引用、远端与配置',
    hint: '只读取引用、远端信息与仓库配置；配置写入会被拒绝。',
    operations: [
      {
        name: 'branch',
        label: '列出 / 查看 / 新建 / 删除分支',
        summary: 'List, inspect, create, or delete branches.',
        positional: true,
      },
      {
        name: 'tag',
        label: '列出 / 新建 / 删除标签',
        summary: 'List, create, or delete tags.',
        positional: true,
      },
      {
        name: 'remote',
        label: '列出 / 新增 / 删除远端',
        summary: 'List, add, or remove remotes.',
        positional: true,
      },
      {
        name: 'config',
        label: '读取仓库配置（写入会被拒绝）',
        summary: 'Read repository configuration. Writes are refused.',
        positional: true,
      },
      {
        name: 'show-ref',
        label: '列出引用及其哈希',
        summary: 'List refs with their hashes.',
        positional: true,
      },
      {
        name: 'symbolic-ref',
        label: '读取或设置符号引用',
        summary: 'Read or set symbolic refs.',
        positional: true,
      },
    ],
  },
  {
    group: 'Change the working tree or the index',
    risk: RISK.write,
    title: '写操作（本地）',
    hint: '会改动工作区、暂存区或本地分支，可能丢弃未提交的改动。',
    operations: [
      {
        name: 'init',
        label: '初始化一个新的仓库',
        summary: 'Create an empty repository or reinitialise one.',
        positional: true,
      },
      {
        name: 'add',
        label: '把文件内容加入暂存区',
        summary: 'Stage file contents.',
        filePaths: true,
      },
      {
        name: 'mv',
        label: '移动或重命名已跟踪文件',
        summary: 'Move or rename a tracked file.',
        filePaths: true,
      },
      {
        name: 'rm',
        label: '删除已跟踪文件',
        summary: 'Remove a tracked file.',
        filePaths: true,
      },
      {
        name: 'restore',
        label: '恢复工作区或暂存区的文件',
        summary: 'Restore working-tree or index paths.',
        filePaths: true,
      },
      {
        name: 'commit',
        label: '把暂存内容记录为新提交',
        summary: 'Record staged changes as a new commit.',
        positional: true,
      },
      {
        name: 'merge',
        label: '把另一条历史线合并进来',
        summary: 'Join another line of history into the current branch.',
        positional: true,
      },
      {
        name: 'rebase',
        label: '把提交重放到新基点（重写历史）',
        summary: 'Replay commits onto another base. Rewrites history.',
        positional: true,
      },
      {
        name: 'cherry-pick',
        label: '把某个已有提交应用到这里',
        summary: 'Apply one existing commit here.',
        positional: true,
      },
      {
        name: 'revert',
        label: '新建一个提交来撤销之前的提交',
        summary: 'Create a commit that undoes an earlier commit.',
        positional: true,
      },
      {
        name: 'am',
        label: '应用邮箱格式的补丁',
        summary: 'Apply a mailbox of patches.',
        positional: true,
      },
      {
        name: 'apply',
        label: '把补丁应用到工作区',
        summary: 'Apply a patch to the working tree.',
        positional: true,
      },
      {
        name: 'reset',
        label: '移动 HEAD 或索引，会丢弃暂存内容',
        summary: 'Move HEAD or the index. Discards staged work.',
        positional: true,
      },
      {
        name: 'switch',
        label: '切换分支',
        summary: 'Switch branches.',
        positional: true,
      },
      {
        name: 'checkout',
        label: '切换分支或恢复文件',
        summary: 'Switch branches or restore paths.',
        positional: true,
      },
      {
        name: 'stash',
        label: '暂存或恢复未提交的改动',
        summary: 'Save or restore uncommitted changes.',
        positional: true,
      },
    ],
  },
  {
    group: 'Talk to a remote, or rewrite and clean history',
    risk: RISK.remote,
    title: '远端与毁灭性操作',
    hint: '会推送代码，或永久丢弃历史与未跟踪文件，通常无法撤销。',
    operations: [
      {
        name: 'clone',
        label: '克隆远端仓库到本地',
        summary: 'Clone a repository into a new directory.',
        positional: true, remote: true,
      },
      {
        name: 'fetch',
        label: '从远端下载对象与引用',
        summary: 'Download objects and refs from a remote.',
        positional: true, remote: true,
      },
      {
        name: 'pull',
        label: '拉取并整合远端分支',
        summary: 'Fetch and integrate a remote branch.',
        positional: true, remote: true,
      },
      {
        name: 'push',
        label: '更新远端引用，会公开你的提交',
        summary: 'Update remote refs. Publishes your commits.',
        positional: true, remote: true,
      },
      {
        name: 'ls-remote',
        label: '不克隆直接列出远端引用',
        summary: 'List refs on a remote without cloning.',
        positional: true, remote: true,
      },
      {
        name: 'clean',
        label: '删除未跟踪文件，无法恢复',
        summary: 'Delete untracked files. Unrecoverable.',
        positional: true,
      },
      {
        name: 'gc',
        label: '重新打包并清理对象库',
        summary: 'Repack and prune the object database.',
        positional: true,
      },
      {
        name: 'prune',
        label: '删除不可达对象',
        summary: 'Remove unreachable objects.',
        positional: true,
      },
      {
        name: 'filter-branch',
        label: '重写全部历史，破坏性强',
        summary: 'Rewrite all history. Destructive.',
        positional: true,
      },
    ],
  },
]

/** Flat lookup: operation name -> catalog entry, including its display group. */
export const OPERATIONS = (() => {
  const map = new Map()
  for (const group of CATALOG) {
    for (const operation of group.operations) map.set(operation.name, { ...operation, group: group.group, risk: group.risk })
  }
  return map
})()

/** Every catalog operation name, in catalog order. */
export const OPERATION_NAMES = Object.freeze([...OPERATIONS.keys()])

/** Operation names whose default is ON: the read tier. */
export const DEFAULT_ENABLED = Object.freeze(
  OPERATION_NAMES.filter((name) => OPERATIONS.get(name).risk === RISK.read),
)

/**
 * Global options that change WHICH repository or WHICH configuration git uses.
 * Any one of them turns an allowlisted subcommand into a way to read or write
 * another repository, or to inject configuration, so all are refused.
 *
 * `-c`/`--config-env` are refused separately ({@link FORBIDDEN_DASH_C}) because
 * they can also execute programs (`core.pager`, `core.hooksPath`, `alias.*`).
 */
export const FORBIDDEN_GLOBAL = Object.freeze([
  // '-C' is deliberately absent: after a subcommand it is `commit -C` (reuse a
  // message), and git rejects it as a global option in that position anyway.
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
  '--attr-source',
  // '--bare' is deliberately absent: it is `init --bare` / `clone --bare`.
  '--no-replace-objects',
  '--literal-pathspecs',
  '--no-literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--list-cmds',
])

/** Short forms of the refused global options, matched on their exact `=` prefix. */
const FORBIDDEN_GLOBAL_PREFIXES = Object.freeze([
  '--git-dir=',
  '--work-tree=',
  '--namespace=',
  '--exec-path=',
  '--config-env=',
  '--super-prefix=',
  '--attr-source=',
])

/**
 * Config-injection forms. `-c key=value` and `--config-env=key=ENVVAR` set
 * configuration for one invocation — the documented escape hatch that reaches
 * `alias.*` or `core.hooksPath`. The tool sets the configuration IT needs
 * through `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` in the child environment,
 * which the caller cannot touch, so nothing legitimate needs these flags.
 */
export const FORBIDDEN_DASH_C = Object.freeze(['-c', '--config-env'])

/**
 * Git configuration keys the tool forces for every invocation, expressed as
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` environment pairs.
 * Using the environment instead of `-c` keeps the flags refused above.
 */
export const ENFORCED_CONFIG = Object.freeze([
  { key: 'core.pager', value: 'cat' },
  { key: 'core.hooksPath', value: '/dev/null' },
  { key: 'credential.helper', value: '' },
  { key: 'advice.detachedHead', value: 'false' },
  /*
   * Keys that name a PROGRAM. Repository configuration is writable by anyone who
   * can write the repo, and a read-only subcommand consults these, so a config
   * file alone was enough to execute code through `git status` or `git diff`.
   * Each is pinned to a harmless value through the environment channel, which
   * outranks every config file.
   */
  { key: 'core.fsmonitor', value: 'false' },
  /*
   * `core.sshCommand` is deliberately NOT here any more. Pinning it to `false` made
   * SSH impossible through this tool, and a repository that only offers an SSH remote
   * then had no route at all. It is pinned through the ENVIRONMENT instead
   * (`GIT_SSH_COMMAND` in `buildEnv`), which outranks every config file and so keeps
   * the protection: no config can nominate the program git runs as ssh.
   */
  { key: 'core.gitProxy', value: 'false' },
])

/** Environment every invocation runs under: no prompts, no pager, no colour. */
export const BASE_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_ASKPASS: '',
  GIT_ADVICE: '0',
  PAGER: 'cat',
  NO_COLOR: '1',
  TERM: 'dumb',
})

/**
 * Options that name a PROGRAM for git to run — on the remote side for
 * `--upload-pack`/`--receive-pack`, or via `--exec`. They are refused for every
 * subcommand because each one is a direct command-execution primitive: the
 * named program runs on the local or remote host with git's own privileges.
 */
/**
 * Options that turn an external diff or textconv driver back on. This tool
 * disables both for diff-producing subcommands, so a caller must not be able to
 * undo that.
 */
const DRIVER_OPTIONS = Object.freeze(['--ext-diff', '--textconv'])

/**
 * Options whose meaning depends on the SUBCOMMAND.
 *
 * `-u` is `fetch`'s short alias for `--upload-pack` — it names a program — but it
 * is ALSO `git add -u` and `git commit -u`, everyday operations. A blanket refusal
 * turned the common case into a false one, so the refusal is scoped to the
 * subcommands where `-u` carries the program-naming meaning.
 *
 * This is the general shape of the mistake: a SHORT flag is ambiguous between a
 * global early option and the subcommand's own flag, so it must be judged with the
 * subcommand in hand.
 */
const SHORT_FLAG_SCOPES = Object.freeze({
  '-u': Object.freeze(['fetch', 'pull', 'ls-remote']),
  '-x': Object.freeze(['rebase']),
})

const EXEC_PROGRAM_OPTIONS = Object.freeze([
  '--upload-pack',
  '--receive-pack',
  '--exec',
])

/**
 * Reject one token that would move the invocation to another repository, name a
 * program for git to execute, or inject configuration.
 * @param token - one argument after the subcommand name.
 * @returns null when the token is acceptable, otherwise the refusal reason.
 */
/**
 * Whether a token is a URL that carries credentials.
 *
 * `scheme://user:secret@host/…` puts the secret into argv, and argv is shown in the
 * approval prompt and recorded in the session. A remote written this way would make
 * the tool itself the leak, so it is refused rather than gated.
 *
 * @param token - one argument.
 * @returns true when the argument embeds userinfo in a URL.
 */
export function isCredentialUrl(token) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@]*@/.test(token)
}

function forbiddenReason(token, subcommand) {
  if (isCredentialUrl(token)) {
    return (
      `the argument ${JSON.stringify(token.replace(/\/\/[^/?#@]*@/, '//<credentials>@'))} is refused: a URL with embedded credentials ` +
      'puts the secret into the approval prompt and the session log. Configure a credential helper instead, so git reads it without it passing through here'
    )
  }
  const bare = token.startsWith('--') && token.includes('=') ? token.slice(0, token.indexOf('=')) : token
  const scoped = SHORT_FLAG_SCOPES[bare]
  if (scoped !== undefined) {
    if (scoped.includes(subcommand)) {
      return `git option ${JSON.stringify(token)} is refused: for ${subcommand} it names a program for git to execute`
    }
    return null
  }
  if (EXEC_PROGRAM_OPTIONS.includes(bare)) {
    return `git option ${JSON.stringify(token)} is refused: it names a program for git to execute`
  }
  if (DRIVER_OPTIONS.includes(bare)) {
    return (
      `git option ${JSON.stringify(token)} is refused: it re-enables an external diff or textconv driver, ` +
      'which runs a program named by repository configuration'
    )
  }
  if (FORBIDDEN_GLOBAL.includes(token)) {
    return `git global option ${JSON.stringify(token)} is refused: it changes which repository or configuration the command acts on`
  }
  for (const prefix of FORBIDDEN_GLOBAL_PREFIXES) {
    if (token.startsWith(prefix)) return `git global option ${JSON.stringify(token)} is refused: it changes which repository or configuration the command acts on`
  }
  return null
}

/**
 * Validate one requested git invocation against the catalog.
 *
 * The rules, in order: the argv must be a non-empty array of strings; the first
 * token is the subcommand and must exist in the catalog; no later token may be
 * a repository-redirecting, program-naming, or config-injecting option; and
 * every non-flag token must be permitted by that operation's operand
 * declaration.
 *
 * A flag is any token starting with `-` and is allowed anywhere, because git
 * itself accepts options after positionals (`git commit file -m msg`). `--` stops
 * flag interpretation, so everything after it is positional. A SHORT flag is judged
 * with the subcommand in hand: `-c` after `switch` means "create" and `-u` after
 * `add` means "update", so neither is refused blanket-wise. The GLOBAL position —
 * the only one git honours them in — is blocked by the rule that the first argument
 * must be a catalog subcommand. A positional
 * token is allowed only when the operation declares `positional` or `filePaths`,
 * which is what keeps `git status --porcelain` (allowed, a flag) distinct from
 * `git count-objects bogus-operand` (refused).
 *
 * @param argv - the requested arguments AFTER the program name; `['status', '-s']`.
 * @returns `{ ok: true, operation, rest }` on acceptance, where `rest` is the
 *   argv with the subcommand removed; otherwise `{ ok: false, reason }`.
 */
export function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, reason: 'invalid arguments: expected a non-empty array of git arguments, for example ["status", "--short"]' }
  }
  if (argv.some((token) => typeof token !== 'string')) {
    return { ok: false, reason: 'invalid arguments: every git argument must be a string' }
  }
  const [name, ...rest] = argv
  if (name.startsWith('-')) {
    return { ok: false, reason: `invalid subcommand ${JSON.stringify(name)}: the first argument must be a git subcommand such as 'status', not an option` }
  }
  const operation = OPERATIONS.get(name)
  if (operation === undefined) {
    return { ok: false, reason: `unknown git subcommand ${JSON.stringify(name)}: it is not in this tool's operation catalog, so it can never be enabled` }
  }

  const positionalAllowed = operation.positional === true || operation.filePaths === true
  const form = FORM_RULES[name]
  let operands = 0
  let operandList = []
  let sawListingFlag = false
  let sawMutatingFlag = false
  let afterDoubleDash = false
  for (const token of rest) {
    if (isCredentialUrl(token)) {
      const leak = forbiddenReason(token, name)
      if (leak !== null) return { ok: false, reason: leak }
    }
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true
      continue
    }
    if (!afterDoubleDash) {
      const refusal = forbiddenReason(token, name)
      if (refusal !== null) return { ok: false, reason: refusal }
      if (token.startsWith('-') && token !== '-') {
        const bare = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
        if (form !== undefined) {
          if (form.forbiddenFlags !== undefined && form.forbiddenFlags.includes(bare)) {
            return { ok: false, reason: `${form.refusal} (Flag ${JSON.stringify(token)}.)` }
          }
          if (form.mutatingFlags !== undefined && form.mutatingFlags.includes(bare)) sawMutatingFlag = true
          if (form.listingFlags !== undefined && form.listingFlags.includes(bare)) sawListingFlag = true
        }
        continue
      }
    }
    operands += 1
    operandList = [...operandList, token]
    if (!positionalAllowed) {
      return {
        ok: false,
        reason:
          `git ${name} does not accept a trailing operand in this tool: ${JSON.stringify(token)} was refused. ` +
          'This subcommand is enabled for its flag-only forms. Use another allowlisted subcommand, or ask the user to extend this operation in the plugin settings.',
      }
    }
  }

  if (form !== undefined && form.refusedVerbs !== undefined && operandList.length > 0 && form.refusedVerbs.includes(operandList[0])) {
    return { ok: false, reason: `${form.refusal} (Verb ${JSON.stringify(operandList[0])}.)` }
  }
  if (form !== undefined && form.forbiddenFlags !== undefined && operands > form.maxOperands) {
    return { ok: false, reason: `${form.refusal} (Received ${String(operands)} operands.)` }
  }
  if (form !== undefined && form.maxOperands !== undefined && operands > form.maxOperands) {
    return {
      ok: false,
      reason:
        `git ${name} accepts at most ${String(form.maxOperands)} operand(s) in this tool: received ${String(operands)}. ` +
        'Its configuration-writing forms are not available here.',
    }
  }

  /*
   * Is this call state-changing? Three ways to say yes: a mutating flag, a mutating
   * leading verb, or an operand that the form only allows for listing.
   */
  const mutating =
    sawMutatingFlag ||
    (form !== undefined && form.mutatingVerbs !== undefined && operandList.length > 0 && form.mutatingVerbs.includes(operandList[0])) ||
    (form !== undefined && form.listingFlags !== undefined && operandList.length > 0 && !sawListingFlag)

  return { ok: true, operation, rest, mutating }
}

/**
 * Subcommands whose accepted FORM is narrower than their operand declaration.
 *
 * `config` is the reason this exists. It was classified read-only, and its
 * operand declaration allowed the two-operand form — which WRITES. Repository
 * configuration that names a program then runs it from a read-only subcommand,
 * so the write form had to go.
 *
 * `maxOperands` counts non-flag tokens; `forbiddenFlags` lists the flags that
 * write, edit, or redirect the file being read.
 */
const FORM_RULES = Object.freeze({
  /*
   * A configuration write is refused, not merely gated: it can name a program
   * (`core.fsmonitor`, `diff.<driver>.command`) that a LATER read-only operation
   * then executes. The audit catches that too, but this is the cheaper place to
   * stop it.
   */
  /*
   * `clone` carries its OWN -c/--config, which writes configuration into the new repository
   * and takes effect before anything is fetched. The global rule cannot see it: a global
   * option is only recognised before the subcommand. Those keys name programs that git runs
   * when it later reads that repository, and the audit only reads the one it runs in — so the
   * same keys refused everywhere else are refused here, in the subcommand's own position.
   */
  clone: Object.freeze({
    forbiddenFlags: Object.freeze(['-c', '--config', '--config-env']),
    refusal:
      'clone -c/--config writes configuration into the new repository before anything is fetched, and those keys can name programs. Clone first, then set configuration deliberately.',
  }),
  config: Object.freeze({
    refuseMutation: true,
    maxOperands: 1,
    forbiddenFlags: Object.freeze([
      '--unset',
      '--unset-all',
      '--add',
      '--replace-all',
      '--rename-section',
      '--remove-section',
      '--edit',
      '-e',
      '--set',
      '--file',
      '-f',
    ]),
    refusal:
      'git config is available only in its READ forms in this tool: at most one operand (the key), and none of the writing or file-selecting flags. '
      + 'A configuration write can name a program that a later read-only subcommand then executes, and -f/--file would read an arbitrary file.',
  }),

  /*
   * Listing is a read; naming a ref creates, moves or deletes one. The mutating
   * form is treated as WRITE risk, so it passes the same approval gate as every
   * other state-changing operation and its capability is preserved.
   */
  branch: Object.freeze({
    mutatingFlags: Object.freeze([
      '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy',
      '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream',
      '--edit-description', '--track', '--no-track',
    ]),
    listingFlags: Object.freeze(['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort']),
  }),

  tag: Object.freeze({
    mutatingFlags: Object.freeze([
      '-d', '--delete', '-a', '--annotate', '-s', '--sign', '-m', '--message',
      '-F', '--file', '-f', '--force', '-u', '--local-user', '-e', '--edit',
      '--create-reflog', '-v', '--verify',
    ]),
    listingFlags: Object.freeze(['-l', '--list', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged', '--format', '--sort', '-n']),
  }),

  remote: Object.freeze({
    /*
     * `remote` spells its mutations as a leading VERB, not as a flag, and the two
     * groups are not the same problem:
     *
     *  - These rewrite .git/config, so they are REFUSED, like a config write.
     *    `set-url` is the sharp one: it silently redirects where a later `push`
     *    goes, and that push's approval prompt shows the command, not the URL.
     *  - `prune`/`update` touch remote-tracking refs and the network, so they are
     *    the write tier: capability kept, approval required.
     */
    refusedVerbs: Object.freeze(['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches']),
    mutatingVerbs: Object.freeze(['prune', 'update']),
    maxOperands: 2,
    refusal:
      'git remote is available only in its READ forms in this tool (list, show, get-url). Its configuration-writing verbs - add, remove, rename, set-url, set-head, set-branches - rewrite .git/config, and set-url silently redirects where a later push goes.',
  }),
})

/**
 * Subcommands that can print a diff, and therefore consult a diff driver.
 *
 * `--no-ext-diff` disables `diff.external` and every `diff.<driver>.command`;
 * `--no-textconv` disables textconv filters. Both are single keys git resolves
 * from configuration the tool cannot fully pin (the driver keys are wildcards),
 * so the behaviour is switched off at the command instead.
 */
const DIFF_PRODUCING = Object.freeze(['diff', 'log', 'show'])

/** The flags that keep a diff from running a configured program. */
const NO_EXTERNAL_DIFF = Object.freeze(['--no-ext-diff', '--no-textconv'])

/**
 * Append the anti-driver flags to a diff-producing invocation.
 *
 * They are inserted directly after the subcommand rather than appended, because
 * git's option parser is more permissive before the first positional operand.
 *
 * @param argv - a validated argv, subcommand first.
 * @returns the argv to execute.
 */
export function hardenArgv(argv) {
  const [name, ...rest] = argv
  if (!DIFF_PRODUCING.includes(name)) return [...argv]
  // Respect an explicit `--`: the flags stay on the option side of it.
  const separator = rest.indexOf('--')
  if (separator === -1) return [name, ...NO_EXTERNAL_DIFF, ...rest]
  return [name, ...NO_EXTERNAL_DIFF, ...rest.slice(0, separator), ...rest.slice(separator)]
}

/**
 * Build the child environment for one invocation.
 *
 * The user-level and system config files are always hidden, and the keys in
 * {@link ENFORCED_CONFIG} are always pinned through the environment channel,
 * which outranks every config file.
 *
 * @param extraConfig - additional `GIT_CONFIG_KEY_n` pairs, applied last.
 * @returns a plain string map for the child process.
 */
export function buildEnv(options = {}) {
  const extraConfig = Array.isArray(options.extraConfig) ? options.extraConfig : []
  const hostCredentials = options.hostCredentials === true
  const env = { ...BASE_ENV }

  if (!hostCredentials) {
    env.GIT_CONFIG_GLOBAL = '/dev/null'
    env.GIT_CONFIG_SYSTEM = '/dev/null'
  }

  /*
   * The ssh program, pinned through the ENVIRONMENT — which outranks every config file,
   * so a repository still cannot nominate it. BatchMode forbids an interactive prompt
   * (the tool's own GIT_TERMINAL_PROMPT does not cover ssh), and accept-new trusts
   * github.com on first contact, which is the only way a headless push can proceed.
   */
  const sshCommand = typeof options.sshCommand === 'string' && options.sshCommand.trim().length > 0
    ? options.sshCommand.trim()
    : DEFAULT_SSH_COMMAND
  /*
   * The program path goes through a shell, so a path with spaces must be quoted —
   * "C:\Program Files\Git\usr\bin\ssh.exe" and the like would otherwise split.
   */
  /*
   * A Windows path becomes forward slashes, and the program is always quoted.
   *
   * GIT_SSH_COMMAND is parsed by a shell. Unquoted, every backslash in a Windows path is
   * eaten as an escape: C:\Windows\System32\OpenSSH\ssh.exe reached git as
   * C:WindowsSystem32OpenSSHssh.exe, which is the "command not found" this fixes. Inside
   * double quotes a backslash is literal, and Windows itself accepts forward slashes — so
   * both defences are applied and the path survives whichever shell parses it.
   *
   * The test is the SHAPE of the path rather than the platform, so a Windows path is
   * normalised even when the harness runs elsewhere (and the rule is testable anywhere).
   */
  const looksLikeWindowsPath = /^[a-zA-Z]:[\\/]/.test(sshCommand)
  const sshPath = looksLikeWindowsPath ? sshCommand.replace(/\\/g, '/') : sshCommand
  const sshProgram = `"${sshPath}"`
  env.GIT_SSH_COMMAND = `${sshProgram} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`

  /*
   * `credential.helper` is pinned ONLY while the machine's credentials are hidden.
   * Clearing it was what made every remote write impossible ("could not read
   * Username"), and it bought nothing in return: the credential file is readable by
   * the same uid either way, so the choice is between "this tool cannot use the
   * credential" and "this tool can, without the secret passing through argv or the
   * transcript".
   *
   * Every other pin stays: those keys name PROGRAMS, and nothing about credentials
   * requires letting a repository or a global file choose one.
   */
  const pins = hostCredentials ? ENFORCED_CONFIG.filter((pair) => pair.key !== 'credential.helper') : ENFORCED_CONFIG
  const pairs = [...pins, ...extraConfig]
  env.GIT_CONFIG_COUNT = String(pairs.length)
  pairs.forEach((pair, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = pair.key
    env[`GIT_CONFIG_VALUE_${index}`] = pair.value
  })
  return env
}

/**
 * Repository-configuration keys that name a PROGRAM, redirect where a command
 * goes, or pull in configuration from elsewhere.
 *
 * A repository can carry these in `.git/config`, and several of them are
 * consulted by subcommands that look read-only, so configuration alone was enough
 * to execute code through `git status` or `git diff` (both reproduced).
 * `affects` names the subcommands the key can influence; `null` means it can
 * influence any of them, which is the fail-closed default for a rule with no
 * narrow scope.
 *
 * Patterns, not literal names, because git resolves wildcards natively
 * (`filter.<driver>.clean`, `url.<base>.insteadOf`, `alias.<name>`).
 */
const DANGEROUS_CONFIG_RULES = Object.freeze([
  // Program-naming keys this tool also pins. Pinning neutralizes them; the audit
  // can additionally refuse, which is the default.
  { pattern: /^core\.pager$/, affects: null },
  { pattern: /^core\.editor$/, affects: null },
  { pattern: /^core\.fsmonitor$/, affects: null },
  { pattern: /^core\.sshcommand$/, affects: null },
  { pattern: /^core\.gitproxy$/, affects: null },
  { pattern: /^core\.hookspath$/, affects: null },
  { pattern: /^core\.askpass$/, affects: null },
  { pattern: /^core\.alternaterefscommand$/, affects: null },
  { pattern: /^core\.attributesfile$/, affects: ['status', 'diff', 'log', 'show', 'add', 'checkout', 'switch', 'restore', 'commit'] },
  { pattern: /^credential\..*helper$/, affects: ['fetch', 'pull', 'push', 'ls-remote', 'clone'] },
  { pattern: /^sequence\.editor$/, affects: ['rebase', 'commit', 'tag', 'am'] },
  { pattern: /^interactive\.difffilter$/, affects: ['add', 'commit'] },
  { pattern: /^gpg\..*program$/, affects: ['commit', 'tag', 'merge', 'rebase'] },

  // Wildcards this tool cannot pin, so the audit is the only defence.
  { pattern: /^alias\./, affects: [] },
  { pattern: /^filter\..*\.(clean|smudge|process)$/, affects: null },
  { pattern: /^diff\..*\.(command|textconv)$/, affects: ['diff', 'log', 'show'] },
  { pattern: /^diff\.external$/, affects: ['diff', 'log', 'show'] },
  { pattern: /^merge\..*\.driver$/, affects: ['merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'am'] },
  { pattern: /^url\..*\.insteadof$/, affects: ['fetch', 'pull', 'push', 'ls-remote', 'clone'] },
  { pattern: /^remote\..*\.(uploadpack|receivepack)$/, affects: ['fetch', 'pull', 'push', 'ls-remote', 'clone'] },
  { pattern: /^submodule\..*\.update$/, affects: ['clone', 'fetch', 'pull', 'checkout', 'switch', 'merge', 'rebase'] },

  // Configuration pulled in from somewhere else, possibly outside the repository.
  // `git config --local --list` HIDES included keys, so an audit that lists them
  // without `--includes` would miss exactly the values that execute: measured, an
  // included `core.fsmonitor` ran while staying invisible to `--local --list`.
  { pattern: /^include\.path$/, affects: null },
  { pattern: /^includeif\..*\.path$/, affects: null },
])

/**
 * The command the audit runs to read a repository's configuration.
 *
 * `--name-only` is only accepted together with `--list`; without it git exits 129
 * ("no action specified"), and because a failed read is deliberately not a refusal
 * the gate would be INERT while every test still passed. `--includes` is what makes
 * keys brought in by an `[include]` directive visible — they execute either way, and
 * a plain `--local --list` hides them.
 *
 * Measured against git 2.55; scripts/verify-config-audit.mjs re-checks that git
 * accepts it.
 */
export const CONFIG_AUDIT_COMMAND = 'git config --local --includes --list --name-only -z'

/**
 * The tiers the NATIVE GIT guard can be set to.
 *
 * `deny` and `restrict` both refuse, and differ in what counts as an invocation: deny
 * matches a mention, restrict matches only a command position. Naming both is the
 * point — the strictness is the operator's choice, not a hidden default.
 */
export const NATIVE_GIT_POLICIES = Object.freeze(['deny', 'restrict', 'ask', 'allow'])

/** The default for the native-git guard: refuse, on the broad match. */
export const DEFAULT_NATIVE_GIT_POLICY = 'deny'

/**
 * The three verdicts the tool guard can apply.
 *
 * `allow` keeps the guard installed but inert, which is how a user turns the feature
 * off without losing the settings page that explains it.
 */
export const GUARD_POLICIES = Object.freeze(['deny', 'ask', 'allow'])

/** What the guard does when nothing has been configured. */
export const DEFAULT_GUARD_POLICY = 'deny'

/**
 * The ssh program git runs, pinned through the environment.
 *
 * One definition, shared by the setting's default and the environment builder. A
 * non-Linux host points this somewhere else through the setting.
 */
export const DEFAULT_SSH_COMMAND = process.platform === 'win32'
  // Forward slashes on purpose: Windows accepts them, and they need no escaping.
  ? 'C:/Windows/System32/OpenSSH/ssh.exe'
  : '/usr/bin/ssh'

/** Extensions that name a shell script. */
const SHELL_SCRIPT_EXTENSIONS = Object.freeze(['.sh', '.bash', '.zsh', '.ksh', '.dash', '.ash'])

/**
 * Whether a file being written is a shell script.
 *
 * Judged from the path AND from the content the call already carries — never from disk.
 * The guard runs in the DSH process on every tool call, so a filesystem read there trades
 * a stall risk (entry 29) for a heuristic, while the content arrives for free in the
 * arguments.
 *
 * @param filePath - the target path, as the call wrote it.
 * @param content - the text being written, when the tool provides one.
 * @returns true when this looks like a shell script.
 */
export function isShellScriptTarget(filePath, content) {
  if (typeof filePath === 'string') {
    const lower = filePath.toLowerCase()
    if (SHELL_SCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true
  }
  if (typeof content === 'string') {
    // A shebang identifies a script whatever it is named.
    const firstLine = content.slice(0, 200).split('\n')[0] ?? ''
    if (/^#!.*\b(sh|bash|zsh|ksh|dash|ash)\b/.test(firstLine)) return true
  }
  return false
}

/**
 * Paths whose CONTENTS are the machine git credentials and identity.
 *
 * They are matched as whole paths against a path argument, and as text inside a
 * shell command. The first form is exact; the second is a substring test, and the
 * difference is stated plainly because it is the difference between a rule and a
 * boundary.
 */
/** The operator's own list starts EMPTY: the built-in groups below cover the known files. */
export const DEFAULT_PROTECTED_PATHS = Object.freeze([])

/** Whether the operator's own list is enforced. On by default; the list is kept when off. */
export const DEFAULT_PROTECTED_PATHS_ENABLED = true

/**
 * Credential files: the machine's stored secrets.
 *
 * Built in rather than user-entered, because this is the contents that must never reach the
 * model's context, and the agent never needs it — authentication is done by the git the
 * plugin runs itself. A leak here is a real leak, so the default tier is deny.
 */
export const CREDENTIAL_PATHS = Object.freeze(['~/.git-credentials', '~/.netrc', '~/.authinfo'])

/** The tier for the built-in credential files. */
export const DEFAULT_CREDENTIAL_POLICY = 'deny'

/**
 * Identity and configuration files.
 *
 * Lower stakes than credentials — a name, an email, a proxy — and the operator may
 * legitimately want the model to read or adjust them. Hence the default tier is ask.
 */
export const IDENTITY_PATHS = Object.freeze(['~/.gitconfig', '~/.config/git/config'])

/** The tier for the built-in identity and configuration files. */
export const DEFAULT_IDENTITY_POLICY = 'ask'

/**
 * The built-in blacklist rows.
 *
 * Everything starts unticked: a built-in row cannot be deleted, only opened, so the safe
 * state is the one that requires a deliberate act. `builtin` marks the rows the settings
 * page must not offer a delete button for.
 */
export const DEFAULT_PROTECTION_ROWS = Object.freeze([
  { path: '~/.git-credentials', read: false, write: false, ask: false, builtin: true },
  { path: '~/.netrc', read: false, write: false, ask: false, builtin: true },
  { path: '~/.authinfo', read: false, write: false, ask: false, builtin: true },
  { path: '~/.gitconfig', read: false, write: false, ask: false, builtin: true },
  { path: '~/.config/git/config', read: false, write: false, ask: false, builtin: true },
])

/** The built-in paths, for restoring a row the stored document dropped. */
export const BUILTIN_PROTECTION_PATHS = Object.freeze(DEFAULT_PROTECTION_ROWS.map((row) => row.path))

/**
 * How a path mentioned in a BASH command is judged.
 *
 *   heuristic   obvious reads count as reads, obvious writes as writes, everything else as a
 *               write — the conservative default
 *   write-only  any mention counts as a write, so reading a protected file needs the write
 *               box
 *
 * Either way this is a heuristic: the guard sees command text, not a file access.
 */
export const BASH_PATH_MODES = Object.freeze(['heuristic', 'write-only'])

/** The default bash judgement. */
export const DEFAULT_BASH_PATH_MODE = 'heuristic'

/** One row, normalized, with the boxes as strict booleans. */
function protectionRow(entry) {
  return {
    path: String(entry.path),
    read: entry.read === true,
    write: entry.write === true,
    ask: entry.ask === true,
    builtin: entry.builtin === true,
  }
}

/**
 * The blacklist rows for the stored settings.
 *
 * A stored `pathRules` list is taken as it is; otherwise the rows are built from the tier
 * settings, with the mapping stated rather than implied:
 *   credentials  deny → nothing ticked, ask → ask, allow → read+write
 *   identity     ask (its default) → ask, allow → read+write, deny → nothing
 *   the operator's list → one row per entry, NOTHING ticked
 *
 * The operator-list mapping is the deliberate behaviour change: the old "enabled" switch
 * cannot be expressed as boxes, so a list that was switched OFF arrives as denied rather
 * than as unenforced. It is the strict direction, and README says so.
 *
 * @param value - the stored settings section, or the composition entry.
 * @returns the rows: built-ins first (never missing), then the operator's own.
 */
export function migrateProtectionRows(value) {
  const byPath = new Map()
  // Only a NON-EMPTY list means the new shape is in use: an absent key validates to [], so
  // emptiness says nothing about the operator's intent (PITFALLS 35, fourth shape).
  const stored = Array.isArray(value?.pathRules) && value.pathRules.length > 0 ? value.pathRules : undefined
  for (const entry of stored ?? []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue
    if (entry.path.length === 0) continue
    byPath.set(entry.path, protectionRow(entry))
  }
  // Built-ins always exist: a stored document may open or close them, never lose them.
  for (const row of DEFAULT_PROTECTION_ROWS) {
    if (!byPath.has(row.path)) byPath.set(row.path, protectionRow(row))
  }
  if (stored !== undefined) {
    // Already in the new shape: keep the operator's own rows and their boxes as they are.
    return [...byPath.values()]
  }
  // Migrate the tiers. A tier counts only when it differs from its own default, because the
  // base object always carries a value (PITFALLS 35, third shape).
  const tierFor = (storedTier, fallback) => (typeof storedTier === 'string' ? storedTier : fallback)
  const apply = (paths, tier) => {
    for (const path of paths) {
      byPath.set(path, {
        path,
        read: tier === 'allow',
        write: tier === 'allow',
        ask: tier === 'ask',
        builtin: true,
      })
    }
  }
  apply(CREDENTIAL_PATHS, tierFor(value?.credentialPolicy, DEFAULT_CREDENTIAL_POLICY))
  apply(IDENTITY_PATHS, tierFor(value?.identityPolicy, DEFAULT_IDENTITY_POLICY))
  for (const path of Array.isArray(value?.protectedPaths) ? value.protectedPaths : []) {
    if (typeof path !== 'string' || path.length === 0 || byPath.has(path)) continue
    byPath.set(path, { path, read: false, write: false, ask: false, builtin: false })
  }
  return [...byPath.values()]
}

/**
 * Whether a shell command invokes git.
 *
 * A scan, not one regex: the character classes are easier to get right as
 * characters. A token matches when git sits between command separators, optionally
 * behind a path (/usr/bin/git) and optionally carrying .exe. digit, .gitignore,
 * my-git-script.sh, gitea and a directory named git-for-dsh do NOT match; a command
 * that merely MENTIONS git DOES, because this reads text and not a parse tree, and a
 * false refusal is the safer direction for a policy filter.
 *
 * @param command - the shell command text.
 * @returns true when a git invocation is visible in the text.
 */
export function containsNativeGit(command, spend = unboundedSteps) {
  if (typeof command !== 'string' || command.length === 0) return false
  // Separators that can sit where a command word begins or ends. A hyphen is NOT one
  // of them, which is what keeps my-git-script and git-for-dsh out. Codes in order:
  // space tab newline return ; & | ( ) < > $ = backtick doublequote singlequote.
  const separators = String.fromCharCode(32, 9, 10, 13, 59, 38, 124, 40, 41, 60, 62, 36, 61, 96, 34, 39)
  let index = 0
  while (index < command.length && spend(1)) {
    const found = command.indexOf('git', index)
    if (found === -1) return false
    index = found + 3
    const before = found === 0 ? '' : command[found - 1]
    // A leading slash is allowed here because the absolute form (/usr/bin/git) is a
    // command word; the WORD test below is what keeps a directory called
    // node_modules/git/ or git-for-dsh from matching.
    if (!(found === 0 || separators.includes(before) || before === '/')) continue
    // Read the whole word this occurrence begins, then judge the word, not the
    // three characters: that is also what catches git-credential-store, a helper
    // whose entire purpose is to print a credential.
    let end = found
    while (end < command.length && spend(1) && !separators.includes(command[end])) end += 1
    const word = command.slice(found, end).toLowerCase()
    const base = word.split('/').slice(-1)[0]
    if (base === 'git' || base === 'git.exe' || base.startsWith('git-credential')) return true
  }
  return false
}

/**
 * Whether one word is a command word for git.
 *
 * @param word - a bare word from a command line.
 * @returns true for `git`, a path ending in git, `git.exe`, or a `git-credential` helper.
 */
function isGitWord(word) {
  const base = word.split('/').slice(-1)[0].toLowerCase()
  return base === 'git' || base === 'git.exe' || base.startsWith('git-credential')
}

/**
 * How many steps one scan may take before it stops.
 *
 * Sized far above any real command: a few kilobytes of shell costs a few thousand steps, so
 * this only triggers on input the matcher was never written for. It exists because the
 * guard runs synchronously inside the DSH process — a scan that never returns does not slow
 * the harness down, it freezes it.
 */
export const SCAN_BUDGET = 2000000

/**
 * A shared step budget.
 *
 * @param limit - steps allowed.
 * @returns `{ spend, exhausted }`; `spend` returns false once the budget is gone, which is
 *   what lets a loop condition end the scan without throwing from deep inside it.
 */
export function createBudget(limit = SCAN_BUDGET) {
  let left = limit
  return {
    spend(steps = 1) {
      left -= steps
      return left > 0
    },
    exhausted() {
      return left <= 0
    },
  }
}

/** A budget that never runs out, for callers that do not need one. */
export function unboundedSteps() {
  return true
}

/** Characters that end a bare word. */
const WORD_BREAK = new Set([' ', '\t', '\r', '\n', ';', '&', '|', '(', ')', '{', '}', '`', '$', '"', "'", '<', '>'])

/** Characters after which a command may begin. */
const COMMAND_START = new Set([';', '&', '|', '(', ')', '{', '}', '`', '$', '\n'])

/**
 * Words that put the NEXT word in command position.
 *
 * `do` / `then` / `else` are shell keywords; the rest are wrappers. Without this list,
 * `sudo git push` would look like an argument and be missed.
 */
const COMMAND_PREFIXES = new Set(['sudo', 'env', 'command', 'nohup', 'xargs', 'nice', 'time', 'exec', 'do', 'then', 'else', '!'])

/**
 * Find the closing quote of the quote that starts at `at`.
 * @param command - the command text.
 * @param at - index of the opening quote.
 * @returns the index of the closing quote, or the end of the string.
 */
function findQuoteEnd(command, at, spend = unboundedSteps) {
  const quote = command[at]
  let index = at + 1
  while (index < command.length && spend(1)) {
    if (quote === '"' && command[index] === '\\') {
      index += 2
      continue
    }
    if (command[index] === quote) return index
    index += 1
  }
  return command.length
}

/**
 * Whether the text before a quote makes that quote a COMMAND STRING.
 *
 * `sh -c "git status"` is an invocation; a quoted argument that merely contains the
 * word is not.
 *
 * @param before - the command text up to the opening quote.
 * @returns true when the last word is `-c` or `--command`.
 */
function isCommandStringQuote(command, at) {
  // Backwards from the quote, skipping trailing whitespace, then comparing the word that
  // ends there. The old form copied everything before the quote for every quote in the
  // command, which is quadratic on a command full of quotes.
  let end = at
  while (end > 0 && ' \t\r\n'.includes(command[end - 1])) end -= 1
  if (end >= 2 && command.slice(end - 2, end) === '-c') return true
  if (end >= 9 && command.slice(end - 9, end) === '--command') return true
  return false
}

/**
 * Whether a shell command INVOKES git, judged by command position rather than by the
 * presence of the word.
 *
 * Quote-aware and recursive: a `-c` command string is scanned as a command of its own.
 * This is the `restrict` tier's matcher — it does not refuse a mere mention. The cost is
 * documented: a form that never presents git in a command position, such as
 * `A=1 git status` or a renamed binary, is missed.
 *
 * @param command - the shell command text.
 * @returns true when git appears where a shell would start a command.
 */
export function invokesGit(command, spend = unboundedSteps) {
  if (typeof command !== 'string' || command.length === 0) return false
  let atCommandStart = true
  let index = 0
  while (index < command.length && spend(1)) {
    const ch = command[index]
    if (ch === '"' || ch === "'") {
      const end = findQuoteEnd(command, index, spend)
      const quoted = command.slice(index + 1, end)
      // The budget is shared with the recursion, so nested command strings cannot buy
      // themselves a fresh allowance.
      if (isCommandStringQuote(command, index) && invokesGit(quoted, spend)) return true
      // A quoted argument is not a command position.
      atCommandStart = false
      index = end + 1
      continue
    }
    if (COMMAND_START.has(ch)) {
      atCommandStart = true
      index += 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      index += 1
      continue
    }
    /*
     * A redirection is a boundary, not a word.
     *
     * `<` and `>` end a bare word but are not command starts, so they are consumed here and
     * the scan continues. Handling them is required, not decorative: the word scan below stops
     * at them, and an unhandled character there leaves the index unmoved — which is an
     * unbounded loop, and this runs in the guard on every bash call.
     */
    if (ch === '<' || ch === '>') {
      atCommandStart = true
      index += 1
      continue
    }
    const start = index
    while (index < command.length && spend(1) && !WORD_BREAK.has(command[index])) index += 1
    /*
     * Belt and braces: whatever a future branch forgets, a pass over this loop consumes at
     * least one character. A guard that can hang the harness is worse than a guard that
     * misses a pattern.
     */
    if (index === start) {
      index += 1
      continue
    }
    const word = command.slice(start, index)
    if (atCommandStart) {
      if (isGitWord(word)) return true
      atCommandStart = COMMAND_PREFIXES.has(word)
    }
  }
  return false
}

/**
 * Whether a shell command TEXT names a protected path.
 *
 * The whole entry always counts, and so does the basename — but ONLY for a dotfile, whose
 * name is effectively unambiguous: `cat .gitconfig` is the relative form of
 * `cat ~/.gitconfig`, and refusing it is the point.
 *
 * A dotfile test rather than "any basename", because the basename comparison is a substring
 * comparison and plenty of basenames are ordinary words. `~/.config/git/config` has the
 * basename `config`, and matching that against command text refused every command containing
 * the word `config` — `git config …` and even `cat ~/.gitconfig` — against a built-in row
 * with nothing ticked. A guard that refuses ordinary work is worse than one that misses a
 * path spelled unusually, so everything else must appear as the full path.
 *
 * @param command - the shell command text.
 * @param protectedPaths - configured paths, possibly tilde-prefixed.
 * @returns true when the text names one of them.
 */
export function mentionsProtectedPath(command, protectedPaths) {
  if (typeof command !== 'string' || command.length === 0) return false
  for (const entry of protectedPaths) {
    if (command.includes(entry)) return true
    const base = entry.split('/').filter((part) => part.length > 0).slice(-1)[0]
    if (base !== undefined && base.startsWith('.') && base.length > 2 && command.includes(base)) return true
  }
  return false
}

/**
 * One containment predicate, so the file rule and the target rule cannot disagree.
 *
 * Compared by path SEGMENT, never as a string prefix: /work/app2 is not inside /work/app.
 * Windows compares case-insensitively, as its filesystem does.
 *
 * @param target - the path to test.
 * @param root - the path that must contain it.
 * @returns true when target is root or lies inside it.
 */
export function isPathInside(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string') return false
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const targetParts = fold(target).split(/[\\/]+/).filter((part) => part.length > 0)
  const rootParts = fold(root).split(/[\\/]+/).filter((part) => part.length > 0)
  if (rootParts.length === 0 || rootParts.length > targetParts.length) return false
  return rootParts.every((part, index) => part === targetParts[index])
}

/**
 * Whether a path argument reaches a protected file, directly or as its container.
 *
 * The ancestor case matters as much as the equal one: reading a DIRECTORY — or
 * grepping it — exposes every file inside it, so a path that CONTAINS a protected
 * file is refused too.
 *
 * @param candidate - the resolved absolute path argument.
 * @param protectedFiles - the resolved absolute protected paths.
 * @returns the protected path it reaches, or undefined.
 */
export function reachesProtectedPath(candidate, protectedFiles) {
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined
  for (const protectedPath of protectedFiles) {
    if (candidate === protectedPath) return protectedPath
    const prefix = candidate.endsWith('/') ? candidate : candidate + '/'
    if (protectedPath.startsWith(prefix)) return protectedPath
    // A file INSIDE a protected directory is protected too: a row may name a directory, and
    // without this only the directory itself was refused while every file in it went through.
    if (isPathInside(candidate, protectedPath)) return protectedPath
  }
  return undefined
}


/** The verdicts the audit can be configured to reach. */
export const CONFIG_POLICIES = Object.freeze(['refuse-repo', 'refuse-affected', 'neutralize', 'off'])

/** The default: any dangerous key refuses the whole call. */
export const DEFAULT_CONFIG_POLICY = 'refuse-repo'

/**
 * How hard the script check reads a shell script that is being written.
 *
 *   strict    refuse when the content mentions git at all
 *   restrict  refuse only when it actually invokes git, which barely misfires
 *   off       do not look at the content
 */
export const SCRIPT_CHECK_POLICIES = Object.freeze(['strict', 'restrict', 'off'])

/** What the script check does when nothing has been configured. */
export const DEFAULT_SCRIPT_CHECK_POLICY = 'strict'

/**
 * Where a git command is allowed to run.
 *
 *   workspace     only inside the session's own workspace (the default)
 *   allowlist     only inside the roots the operator listed
 *   unrestricted  anywhere (what this tool did before the choice existed)
 */
export const TARGET_SCOPES = Object.freeze(['workspace', 'allowlist', 'unrestricted'])

/** The default: the session's own workspace, and nothing else. */
export const DEFAULT_TARGET_SCOPE = 'workspace'

/**
 * Read the key names out of `git config --name-only -z` output.
 * @param text - the command's stdout.
 * @returns the key names, lowercased for matching, with duplicates removed.
 */
export function parseConfigKeys(text) {
  const keys = new Set()
  for (const raw of String(text).split('\u0000')) {
    const key = raw.trim()
    if (key.length > 0) keys.add(key.toLowerCase())
  }
  return [...keys]
}

/**
 * Judge one repository's configuration before a subcommand runs.
 *
 * @param keys - key names from {@link parseConfigKeys}.
 * @param subcommand - the subcommand about to run.
 * @param policy - one of {@link CONFIG_POLICIES}.
 * @returns `{ ok: true }`, or `{ ok: false, key, affects, reason }` naming the
 *   offending key and why it was refused.
 */
export function auditRepoConfig(keys, subcommand, policy = DEFAULT_CONFIG_POLICY) {
  if (policy === 'neutralize') {
    // Pinned keys are harmless (their values are overridden for every call), so
    // only the keys that cannot be pinned are still refused.
    for (const key of keys) {
      for (const rule of DANGEROUS_CONFIG_RULES) {
        if (!rule.pattern.test(key)) continue
        if (PINNED_KEYS.includes(key)) break
        return refuse(key, rule, subcommand)
      }
    }
    return { ok: true }
  }

  for (const key of keys) {
    for (const rule of DANGEROUS_CONFIG_RULES) {
      if (!rule.pattern.test(key)) continue
      if (policy === 'refuse-affected' && rule.affects !== null && !rule.affects.includes(subcommand)) break
      return refuse(key, rule, subcommand)
    }
  }
  return { ok: true }
}

/** The key names {@link ENFORCED_CONFIG} already overrides for every call. */
const PINNED_KEYS = Object.freeze(ENFORCED_CONFIG.map((pair) => pair.key))

/**
 * Build the refusal for one offending key.
 * @param key - the key found in the repository configuration.
 * @param rule - the rule that matched it.
 * @param subcommand - the subcommand that was about to run.
 * @returns the audit verdict.
 */
function refuse(key, rule, subcommand) {
  const scope = rule.affects === null ? 'any subcommand' : `subcommands: ${rule.affects.join(', ') || '(none)'}`
  return {
    ok: false,
    key,
    affects: rule.affects,
    reason:
      `the repository configuration sets ${JSON.stringify(key)}, which can name a program to execute, redirect where a command goes, or pull in configuration from elsewhere (it affects ${scope}). ` +
      `${JSON.stringify(subcommand)} was not run. Remove that key from .git/config, or relax the audit in the git tool settings (dangerousKeyPolicy).`,
  }
}

/** Quote one argv token for `/bin/sh`. */
export function shellQuote(token, dialect = process.platform === 'win32' ? 'pwsh' : 'sh') {
  if (token.length === 0) return "''"
  /*
   * The fast path leaves a token bare, so it may only admit characters every shell treats as
   * an ordinary word character. A comma is NOT one: PowerShell reads a bare comma as an array
   * separator, which is how `--pretty=%h,%s` could arrive as two arguments.
   */
  if (!token.includes(',') && /^[A-Za-z0-9_@%+=:./-]+$/.test(token)) return token
  // Inside single quotes both shells treat everything as literal; only the escape for an
  // embedded quote differs.
  const escaped = dialect === 'pwsh'
    ? token.replaceAll("'", "''")
    : token.replaceAll("'", `'\\''`)
  return `'${escaped}'`
}

/**
 * Compose the one-line command the shell executes.
 * @param argv - validated argv, subcommand first.
 * @returns the command line: a literal `git`, the subcommand, then quoted arguments.
 */
export function composeCommand(argv) {
  return ['git', ...argv].map(shellQuote).join(' ')
}

/**
 * The catalog as plain JSON data: what the settings page needs, and nothing
 * else. `scripts/build.mjs` serializes this into the client bundle, which is how
 * the checkbox page is generated from the enforced list instead of a hand copy.
 * @returns a lossless JSON structure: one entry per risk tier, in display order.
 */
export function describeCatalog() {
  return RISK_ORDER.map((risk) => {
    const groups = CATALOG.filter((group) => group.risk === risk)
    return {
      risk,
      title: groups[0]?.title ?? risk,
      hint: groups[0]?.hint ?? '',
      groups: groups.map((group) => ({
        group: group.group,
        operations: group.operations.map((operation) => ({
          name: operation.name,
          label: operation.label,
          summary: operation.summary,
          paths: operation.filePaths === true,
          positional: operation.positional === true,
        })),
      })),
    }
  })
}

/**
 * Flat rows for one risk tier, for callers that want a simple list.
 * @param risk - the tier to filter by.
 * @returns catalog entries of that tier, in catalog order.
 */
export function operationsOfRisk(risk) {
  return CATALOG.filter((group) => group.risk === risk).flatMap((group) => group.operations)
}
