/**
 * Browser half of the git tool plugin, packaged as a client module bundle.
 *
 * WHY A HAND-WRITTEN BUNDLE: `dsh-client-modules` serves a client half as a
 * prebuilt artifact at `lib/client.js`, executed through
 * `window.__ModuleLoader__.load({ id, factory })`. Writing that wrapper by hand
 * keeps this package buildless while the format stays identical to what the
 * client build emits.
 *
 * WHAT THE PAGE DOES: it renders the settings page where the user ticks which
 * git operations the model may run. The operation list is EMBEDDED at build time
 * from the Host's own catalog (`{"catalog":[{"risk":"read","title":"只读操作：仓库状态与历史","hint":"只读取仓库内容，不改动工作区、暂存区或引用。","groups":[{"group":"Repository status and history","operations":[{"name":"status","label":"工作区与暂存区状态","summary":"Working-tree and index status.","paths":false,"positional":true},{"name":"diff","label":"工作区 / 暂存区 / 提交之间的差异","summary":"Diff of the working tree, the index, or two revisions.","paths":false,"positional":true},{"name":"log","label":"提交历史","summary":"Commit history.","paths":false,"positional":true},{"name":"show","label":"查看某个提交、标签或对象","summary":"One commit, tag, or blob.","paths":false,"positional":true},{"name":"shortlog","label":"按作者汇总的提交列表","summary":"Commits grouped by author.","paths":false,"positional":true},{"name":"describe","label":"用可读名称描述提交","summary":"Human-readable name for a commit.","paths":false,"positional":true},{"name":"blame","label":"逐行显示最后修改的提交","summary":"Line-by-line last-modifying commit.","paths":true,"positional":false},{"name":"rev-parse","label":"解析引用、哈希与仓库路径","summary":"Resolve refs, hashes, and repository paths.","paths":false,"positional":true},{"name":"rev-list","label":"遍历可达提交","summary":"Walk commits reachable from a revision.","paths":false,"positional":true},{"name":"ls-files","label":"列出索引中的文件","summary":"Files tracked in the index.","paths":false,"positional":false},{"name":"ls-tree","label":"列出树对象内容","summary":"Contents of a tree object.","paths":false,"positional":true},{"name":"cat-file","label":"读取对象原始内容","summary":"Raw content of a repository object.","paths":false,"positional":true},{"name":"count-objects","label":"统计对象库大小","summary":"Object-database size statistics.","paths":false,"positional":false},{"name":"for-each-ref","label":"枚举所有引用","summary":"Enumerate refs.","paths":false,"positional":true},{"name":"reflog","label":"引用日志","summary":"Reference log of HEAD or a branch.","paths":false,"positional":true},{"name":"name-rev","label":"用符号名标识提交","summary":"Name a revision symbolically.","paths":false,"positional":true}]},{"group":"Inspect refs, remotes, and configuration","operations":[{"name":"branch","label":"列出 / 查看 / 新建 / 删除分支","summary":"List, inspect, create, or delete branches.","paths":false,"positional":true},{"name":"tag","label":"列出 / 新建 / 删除标签","summary":"List, create, or delete tags.","paths":false,"positional":true},{"name":"remote","label":"列出 / 新增 / 删除远端","summary":"List, add, or remove remotes.","paths":false,"positional":true},{"name":"config","label":"读取仓库配置（写入会被拒绝）","summary":"Read repository configuration. Writes are refused.","paths":false,"positional":true},{"name":"show-ref","label":"列出引用及其哈希","summary":"List refs with their hashes.","paths":false,"positional":true},{"name":"symbolic-ref","label":"读取或设置符号引用","summary":"Read or set symbolic refs.","paths":false,"positional":true}]}]},{"risk":"write","title":"写操作（本地）","hint":"会改动工作区、暂存区或本地分支，可能丢弃未提交的改动。","groups":[{"group":"Change the working tree or the index","operations":[{"name":"init","label":"初始化一个新的仓库","summary":"Create an empty repository or reinitialise one.","paths":false,"positional":true},{"name":"add","label":"把文件内容加入暂存区","summary":"Stage file contents.","paths":true,"positional":false},{"name":"mv","label":"移动或重命名已跟踪文件","summary":"Move or rename a tracked file.","paths":true,"positional":false},{"name":"rm","label":"删除已跟踪文件","summary":"Remove a tracked file.","paths":true,"positional":false},{"name":"restore","label":"恢复工作区或暂存区的文件","summary":"Restore working-tree or index paths.","paths":true,"positional":false},{"name":"commit","label":"把暂存内容记录为新提交","summary":"Record staged changes as a new commit.","paths":false,"positional":true},{"name":"merge","label":"把另一条历史线合并进来","summary":"Join another line of history into the current branch.","paths":false,"positional":true},{"name":"rebase","label":"把提交重放到新基点（重写历史）","summary":"Replay commits onto another base. Rewrites history.","paths":false,"positional":true},{"name":"cherry-pick","label":"把某个已有提交应用到这里","summary":"Apply one existing commit here.","paths":false,"positional":true},{"name":"revert","label":"新建一个提交来撤销之前的提交","summary":"Create a commit that undoes an earlier commit.","paths":false,"positional":true},{"name":"am","label":"应用邮箱格式的补丁","summary":"Apply a mailbox of patches.","paths":false,"positional":true},{"name":"apply","label":"把补丁应用到工作区","summary":"Apply a patch to the working tree.","paths":false,"positional":true},{"name":"reset","label":"移动 HEAD 或索引，会丢弃暂存内容","summary":"Move HEAD or the index. Discards staged work.","paths":false,"positional":true},{"name":"switch","label":"切换分支","summary":"Switch branches.","paths":false,"positional":true},{"name":"checkout","label":"切换分支或恢复文件","summary":"Switch branches or restore paths.","paths":false,"positional":true},{"name":"stash","label":"暂存或恢复未提交的改动","summary":"Save or restore uncommitted changes.","paths":false,"positional":true}]}]},{"risk":"remote","title":"远端与毁灭性操作","hint":"会推送代码，或永久丢弃历史与未跟踪文件，通常无法撤销。","groups":[{"group":"Talk to a remote, or rewrite and clean history","operations":[{"name":"clone","label":"克隆远端仓库到本地","summary":"Clone a repository into a new directory.","paths":false,"positional":true},{"name":"fetch","label":"从远端下载对象与引用","summary":"Download objects and refs from a remote.","paths":false,"positional":true},{"name":"pull","label":"拉取并整合远端分支","summary":"Fetch and integrate a remote branch.","paths":false,"positional":true},{"name":"push","label":"更新远端引用，会公开你的提交","summary":"Update remote refs. Publishes your commits.","paths":false,"positional":true},{"name":"ls-remote","label":"不克隆直接列出远端引用","summary":"List refs on a remote without cloning.","paths":false,"positional":true},{"name":"clean","label":"删除未跟踪文件，无法恢复","summary":"Delete untracked files. Unrecoverable.","paths":false,"positional":true},{"name":"gc","label":"重新打包并清理对象库","summary":"Repack and prune the object database.","paths":false,"positional":true},{"name":"prune","label":"删除不可达对象","summary":"Remove unreachable objects.","paths":false,"positional":true},{"name":"filter-branch","label":"重写全部历史，破坏性强","summary":"Rewrite all history. Destructive.","paths":false,"positional":true}]}]}],"defaults":{"enabled":["status","diff","log","show","shortlog","describe","blame","rev-parse","rev-list","ls-files","ls-tree","cat-file","count-objects","for-each-ref","reflog","name-rev","branch","tag","remote","config","show-ref","symbolic-ref"],"approveMutating":true,"dangerousKeyPolicy":"refuse-repo","useHostCredentials":false,"nativeGitPolicy":"deny","pathGuardPolicy":"deny","protectedPaths":["~/.git-credentials","~/.gitconfig"],"scanScripts":true,"heartbeat":false,"sshCommand":"/usr/bin/ssh","pluginEnabled":true,"logEnabled":true,"logPath":"","proxyPort":0,"proxyCommand":""}}`, substituted by
 * `scripts/build.mjs`), so the page and the Host's gate read one list and the
 * browser needs no channel to the Host at all. Every tick is one field write on
 * the Host's `git-tool` settings namespace, so the allowlist applies to the
 * model's next step and survives a restart in the profile's `settings.yaml`.
 *
 * TWO FAILURE MODES THIS FILE IS BUILT TO SURVIVE — both observed in the field,
 * each one costing a broken plugin load until it was understood:
 *
 * 1. The two declaration lists are NOT alternatives.
 *
 *    `package.json`'s `dsh.client.inject` holds PACKAGE names, which order the
 *    module graph. This module's `inject` export holds SERVICE names, which make
 *    activation wait until those services exist. Omitting a service you read from
 *    this module's `inject` fails the load ("cannot get property \"slots\"
 *    without inject"); omitting the whole export instead RACES — the page can run
 *    before `settingsScope` is registered, degrade to an inert scope, and render
 *    every control disabled.
 *
 * 2. A throw while the module is being EVALUATED fails that plugin's load, and
 *    in practice surfaced as a broken page. The factory body therefore runs
 *    inside a try/catch that answers a no-op plugin, so a mistake in this file
 *    cannot take the plugin loader down with it.
 *
 * 3. An identifier that the page does not put in a bundle's scope is a
 *    ReferenceError, and inside a COMPONENT it throws at render time rather than
 *    at load — the plugin loads, and the page shows a failure card from the
 *    boundary. `host` is exactly that: it is provided to a dynamic Client
 *    Package, not to a composition-loaded client bundle ("host is not defined").
 *    This file therefore references only `React` (from `require`) and the
 *    values `apply` receives.
 *
 * `test/client.test.mjs` loads THIS file through the page's own module mechanism
 * and asserts both properties.
 *
 * @module git-for-dsh/client
 */
window.__ModuleLoader__.load({
  // Substituted with the package name at build time: the served module id IS the
  // package name, and two copies of one string drift.
  id: "git-for-dsh",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    try {
      // `require` resolves through the page's module table; the package's
      // `dsh.client.inject` has already ordered these ahead of this bundle.
      const React = require('react')
      require('@deepseek-ai/dsh-client-ui-settings')

      /**
       * The operation catalog and the default allowlist, embedded by the build
       * from `src/git-catalog.js` — the same source the Host enforces. Shape:
       * `{ catalog: [{ risk, title, hint, groups: [{ group, operations: [...] }] }], defaults }`.
       */
      const CATALOG = {"catalog":[{"risk":"read","title":"只读操作：仓库状态与历史","hint":"只读取仓库内容，不改动工作区、暂存区或引用。","groups":[{"group":"Repository status and history","operations":[{"name":"status","label":"工作区与暂存区状态","summary":"Working-tree and index status.","paths":false,"positional":true},{"name":"diff","label":"工作区 / 暂存区 / 提交之间的差异","summary":"Diff of the working tree, the index, or two revisions.","paths":false,"positional":true},{"name":"log","label":"提交历史","summary":"Commit history.","paths":false,"positional":true},{"name":"show","label":"查看某个提交、标签或对象","summary":"One commit, tag, or blob.","paths":false,"positional":true},{"name":"shortlog","label":"按作者汇总的提交列表","summary":"Commits grouped by author.","paths":false,"positional":true},{"name":"describe","label":"用可读名称描述提交","summary":"Human-readable name for a commit.","paths":false,"positional":true},{"name":"blame","label":"逐行显示最后修改的提交","summary":"Line-by-line last-modifying commit.","paths":true,"positional":false},{"name":"rev-parse","label":"解析引用、哈希与仓库路径","summary":"Resolve refs, hashes, and repository paths.","paths":false,"positional":true},{"name":"rev-list","label":"遍历可达提交","summary":"Walk commits reachable from a revision.","paths":false,"positional":true},{"name":"ls-files","label":"列出索引中的文件","summary":"Files tracked in the index.","paths":false,"positional":false},{"name":"ls-tree","label":"列出树对象内容","summary":"Contents of a tree object.","paths":false,"positional":true},{"name":"cat-file","label":"读取对象原始内容","summary":"Raw content of a repository object.","paths":false,"positional":true},{"name":"count-objects","label":"统计对象库大小","summary":"Object-database size statistics.","paths":false,"positional":false},{"name":"for-each-ref","label":"枚举所有引用","summary":"Enumerate refs.","paths":false,"positional":true},{"name":"reflog","label":"引用日志","summary":"Reference log of HEAD or a branch.","paths":false,"positional":true},{"name":"name-rev","label":"用符号名标识提交","summary":"Name a revision symbolically.","paths":false,"positional":true}]},{"group":"Inspect refs, remotes, and configuration","operations":[{"name":"branch","label":"列出 / 查看 / 新建 / 删除分支","summary":"List, inspect, create, or delete branches.","paths":false,"positional":true},{"name":"tag","label":"列出 / 新建 / 删除标签","summary":"List, create, or delete tags.","paths":false,"positional":true},{"name":"remote","label":"列出 / 新增 / 删除远端","summary":"List, add, or remove remotes.","paths":false,"positional":true},{"name":"config","label":"读取仓库配置（写入会被拒绝）","summary":"Read repository configuration. Writes are refused.","paths":false,"positional":true},{"name":"show-ref","label":"列出引用及其哈希","summary":"List refs with their hashes.","paths":false,"positional":true},{"name":"symbolic-ref","label":"读取或设置符号引用","summary":"Read or set symbolic refs.","paths":false,"positional":true}]}]},{"risk":"write","title":"写操作（本地）","hint":"会改动工作区、暂存区或本地分支，可能丢弃未提交的改动。","groups":[{"group":"Change the working tree or the index","operations":[{"name":"init","label":"初始化一个新的仓库","summary":"Create an empty repository or reinitialise one.","paths":false,"positional":true},{"name":"add","label":"把文件内容加入暂存区","summary":"Stage file contents.","paths":true,"positional":false},{"name":"mv","label":"移动或重命名已跟踪文件","summary":"Move or rename a tracked file.","paths":true,"positional":false},{"name":"rm","label":"删除已跟踪文件","summary":"Remove a tracked file.","paths":true,"positional":false},{"name":"restore","label":"恢复工作区或暂存区的文件","summary":"Restore working-tree or index paths.","paths":true,"positional":false},{"name":"commit","label":"把暂存内容记录为新提交","summary":"Record staged changes as a new commit.","paths":false,"positional":true},{"name":"merge","label":"把另一条历史线合并进来","summary":"Join another line of history into the current branch.","paths":false,"positional":true},{"name":"rebase","label":"把提交重放到新基点（重写历史）","summary":"Replay commits onto another base. Rewrites history.","paths":false,"positional":true},{"name":"cherry-pick","label":"把某个已有提交应用到这里","summary":"Apply one existing commit here.","paths":false,"positional":true},{"name":"revert","label":"新建一个提交来撤销之前的提交","summary":"Create a commit that undoes an earlier commit.","paths":false,"positional":true},{"name":"am","label":"应用邮箱格式的补丁","summary":"Apply a mailbox of patches.","paths":false,"positional":true},{"name":"apply","label":"把补丁应用到工作区","summary":"Apply a patch to the working tree.","paths":false,"positional":true},{"name":"reset","label":"移动 HEAD 或索引，会丢弃暂存内容","summary":"Move HEAD or the index. Discards staged work.","paths":false,"positional":true},{"name":"switch","label":"切换分支","summary":"Switch branches.","paths":false,"positional":true},{"name":"checkout","label":"切换分支或恢复文件","summary":"Switch branches or restore paths.","paths":false,"positional":true},{"name":"stash","label":"暂存或恢复未提交的改动","summary":"Save or restore uncommitted changes.","paths":false,"positional":true}]}]},{"risk":"remote","title":"远端与毁灭性操作","hint":"会推送代码，或永久丢弃历史与未跟踪文件，通常无法撤销。","groups":[{"group":"Talk to a remote, or rewrite and clean history","operations":[{"name":"clone","label":"克隆远端仓库到本地","summary":"Clone a repository into a new directory.","paths":false,"positional":true},{"name":"fetch","label":"从远端下载对象与引用","summary":"Download objects and refs from a remote.","paths":false,"positional":true},{"name":"pull","label":"拉取并整合远端分支","summary":"Fetch and integrate a remote branch.","paths":false,"positional":true},{"name":"push","label":"更新远端引用，会公开你的提交","summary":"Update remote refs. Publishes your commits.","paths":false,"positional":true},{"name":"ls-remote","label":"不克隆直接列出远端引用","summary":"List refs on a remote without cloning.","paths":false,"positional":true},{"name":"clean","label":"删除未跟踪文件，无法恢复","summary":"Delete untracked files. Unrecoverable.","paths":false,"positional":true},{"name":"gc","label":"重新打包并清理对象库","summary":"Repack and prune the object database.","paths":false,"positional":true},{"name":"prune","label":"删除不可达对象","summary":"Remove unreachable objects.","paths":false,"positional":true},{"name":"filter-branch","label":"重写全部历史，破坏性强","summary":"Rewrite all history. Destructive.","paths":false,"positional":true}]}]}],"defaults":{"enabled":["status","diff","log","show","shortlog","describe","blame","rev-parse","rev-list","ls-files","ls-tree","cat-file","count-objects","for-each-ref","reflog","name-rev","branch","tag","remote","config","show-ref","symbolic-ref"],"approveMutating":true,"dangerousKeyPolicy":"refuse-repo","useHostCredentials":false,"nativeGitPolicy":"deny","pathGuardPolicy":"deny","protectedPaths":["~/.git-credentials","~/.gitconfig"],"scanScripts":true,"heartbeat":false,"sshCommand":"/usr/bin/ssh","pluginEnabled":true,"logEnabled":true,"logPath":"","proxyPort":0,"proxyCommand":""}}

      /**
       * Turn the port-check response into either a report or a readable failure.
       *
       * An unmatched route answers with an EMPTY body, and the first version read it
       * with `response.json()` — so the page showed the parser's message
       * ("Unexpected end of JSON input") instead of the actionable one ("the running
       * Host half predates this route; restart dsh web").
       *
       * @param status - the HTTP status.
       * @param text - the raw body.
       * @returns `{ ok: true, body }` or `{ ok: false, message }`.
       */
      function classifyJsonResponse(status, text, notFoundHint) {
        if (typeof text !== 'string' || text.trim().length === 0) {
          return {
            ok: false,
            message: status === 404
              ? notFoundHint
              : 'Host 侧返回了空响应（HTTP ' + String(status) + '）。',
          }
        }
        try {
          return { ok: true, body: JSON.parse(text) }
        } catch {
          return { ok: false, message: 'Host 侧返回的不是 JSON（HTTP ' + String(status) + '）。' }
        }
      }

      /**
       * The page's tabs: one per risk tier, plus the strategy group.
       *
       * The tiers' ids are the catalogue's own risk names, so a tab and its section
       * cannot drift apart.
       */
      const TABS = [
        // Settings first: it is where a new user has to decide something, and the
        // operation lists are reference material they return to.
        { id: 'settings', label: '策略与代理' },
        { id: 'read', label: '只读' },
        { id: 'write', label: '写操作' },
        { id: 'remote', label: '远程' },
        { id: 'logs', label: '日志' },
      ]

      /**
       * The three verdicts the tool guard can reach, and what each one means.
       *
       * The ids are the values the Host accepts, so a label can be reworded without
       * touching the schema.
       */
      const GUARD_COPY = [
        { id: 'deny', label: '禁止', hint: '直接拒绝，并提示改用 git_exec。' },
        { id: 'ask', label: '询问', hint: '弹一次审批，由你当场决定。' },
        { id: 'allow', label: '允许', hint: '不拦截，等于关闭这项保护。' },
      ]

      /**
       * The native-git tiers.
       *
       * 禁止 and 限制 both refuse and differ in WHAT counts: the broad match treats a
       * mention as an invocation (safe, though it also refuses a command that merely
       * narrow one requires a command position (no false refusals, may miss an
       * obfuscated form). The operator picks which error they prefer.
       */
      const NATIVE_COPY = [
        { id: 'deny', label: '禁止', hint: '命令里出现 git 调用就拒绝。最安全，但只是"提到" git 也会被拒。' },
        { id: 'restrict', label: '限制', hint: '只在命令位置判定（开头、; && | $( 之后，或 sudo/env 等前缀之后）。不误伤，但可能漏掉生僻写法。' },
        { id: 'ask', label: '询问', hint: '命中时弹一次审批（判定方式同「限制」）。' },
        { id: 'allow', label: '允许', hint: '不拦截。' },
      ]

      /**
       * The same three verdicts for the credential paths.
       *
       * Separate hints on purpose: the alternative for a blocked READ is not
       * "use git_exec" — the tool reads the credential itself, and that is exactly why
       * the read is unnecessary.
       */
      const PATH_COPY = [
        { id: 'deny', label: '禁止', hint: '直接拒绝；认证由 git_exec 内部完成，不需要读凭据。' },
        { id: 'ask', label: '询问', hint: '弹一次审批，由你当场决定。' },
        { id: 'allow', label: '允许', hint: '不拦截，等于关闭这项保护。' },
      ]

      /**
       * The client services this half reads.
       *
       * These are SERVICE names and belong here; the package names that order the
       * module graph live in `package.json`'s `dsh.client.inject`. The two lists
       * are not alternatives — a shipped plugin (`dsh-client-ui-settings-general`)
       * carries both.
       *
       * Declaring them is what makes activation wait until they exist. Reading a
       * service with `ctx.get` and no declaration compiles, but it races: if the
       * settings domain has not registered `settingsScope` yet, the read answers
       * undefined and the page degrades to controls nobody can use.
       */
      const inject = ['slots', 'settingsScope']

      /**
       * This bundle's build id, substituted by `scripts/build.mjs`.
       *
       * It is shown on the page because a browser can keep an OLDER bundle in
       * memory until it is reloaded, which makes a fixed bug look present. The
       * stamp turns "is the page stale?" into a one-line check.
       */
      const BUILD = "bc0111210a81"

      /** Settings namespace, shared with the Host half. */
      const NAMESPACE = 'git-tool'

      /** Copy for the three containment levels the page presents. */
      const TIER_HELP = {
        read: '只读取仓库内容，不改动工作区、暂存区或引用。建议保持开启。',
        write: '会改动工作区、暂存区或本地分支，可能丢弃未提交的改动。',
        remote: '会推送代码，或永久丢弃历史与未跟踪文件，通常无法撤销。',
      }

      /** The one tier that gets an extra warning line. */
      const TIER_NOTE = {
        remote: '这一组最难撤销：push 会公开提交，clean / filter-branch / prune 会永久丢弃内容。',
      }

      /**
       * The three verdicts the repository-config audit can reach, in the order the
       * page presents them, each with the reason a reader needs to choose.
       */
      const POLICY_COPY = [
        { id: 'refuse-repo', label: '一票拒绝', hint: '仓库里有危险键就拒绝一切命令。最省心，但含此类键的仓库会完全用不了。' },
        { id: 'refuse-affected', label: '只拒受影响', hint: '仅当该键会影响这条子命令时才拒绝（alias.* 劫持不了内建命令，所以不影响 status）。' },
        { id: 'neutralize', label: '尽量中和', hint: '已钉死的键照常工作；钉不死的通配键（filter.*、url.*.insteadOf）仍然拒绝。' },
        { id: 'off', label: '关闭审计', hint: '完全不检查仓库配置。危险键可以借此执行程序（core.fsmonitor、diff.*.command），只在你完全信任仓库时使用。' },
      ]

      /**
       * Whether the Host accepts writes for this namespace right now.
       *
       * `status: 'unavailable'` means the client is not reading this namespace back
       * as its source of truth — memory persistence, which a non-loopback page uses.
       * Writes still reach the Host, so the controls stay usable; only the DISPLAY
       * cannot lean on the read-back. The fallback scope marks itself `inert`, and
       * that is the single case where the controls are disabled.
       */
      const writable = (snapshot) => snapshot.mode !== 'inert'

      /** One plain status card, used for every degraded state. */
      const message = (text) =>
        React.createElement(
          'div',
          { className: 'git-tool-page' },
          React.createElement('p', { className: 'git-tool-status' }, text),
        )

      /** A snapshot-only scope for a page whose settings service is unavailable. */
      const inertScope = (reason) => {
        const snapshot = { status: 'unavailable', value: undefined, revision: undefined, writable: false, mode: 'inert' }
        return {
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
          set: () => Promise.reject(new Error(reason)),
          unset: () => Promise.reject(new Error(reason)),
          mutate: () => Promise.reject(new Error(reason)),
        }
      }

      /**
       * Read one client service WITHOUT declaring it.
       *
       * `ctx.get(name)` is the optional-read form the Guard allows; the direct
       * `ctx.<name>` form is the one it rejects. Every call site goes through
       * this helper so this plugin has no service declaration to get wrong.
       *
       * @param ctx - client root context.
       * @param name - service key.
       * @returns the service, or undefined when this page does not expose it.
       */
      const service = (ctx, name) => {
        try {
          return ctx.get(name)
        } catch {
          return undefined
        }
      }

      /**
       * Explain why writes are unavailable, in the page's own status line.
       *
       * A disabled control with no reason is what made this page look broken
       * instead of diagnosable, so the state is always named.
       *
       * @param snapshot - the scope snapshot the page rendered.
       * @returns a short reason for the reader.
       */
      function describeUnavailable(snapshot) {
        if (snapshot.mode === 'memory') {
          return '当前页面不以本机模式连接 Host，改动不会持久化。'
        }
        return 'Host 未暴露 git-tool 命名空间，或读取尚未完成。'
      }

      /**
       * Narrow the namespace section into the value this page renders.
       *
       * Supplying a decoder is what keeps the controls ENABLED. Without one, the
       * scope validates the section against the schema it received over the wire
       * and reports `undefined` when that fails, which leaves the scope stuck
       * below \`ready\` forever — every control renders disabled with no error
       * shown. Decoding here is tolerant on purpose: a missing or malformed field
       * falls back to a sane value rather than disabling the page.
       *
       * @param section - the wire section for the `git-tool` namespace.
       * @returns the value the page reads, never undefined for an object section.
       */
      function decodeSection(section) {
        if (section === null || typeof section !== 'object' || Array.isArray(section)) {
          return {
            enabled: [...CATALOG.defaults.enabled],
            approveMutating: true,
            dangerousKeyPolicy: CATALOG.defaults.dangerousKeyPolicy,
            useHostCredentials: CATALOG.defaults.useHostCredentials === true,
            nativeGitPolicy: CATALOG.defaults.nativeGitPolicy,
            pluginEnabled: CATALOG.defaults.pluginEnabled !== false,
            logEnabled: CATALOG.defaults.logEnabled !== false,
            heartbeat: CATALOG.defaults.heartbeat === true,
            logPath: CATALOG.defaults.logPath,
            scanScripts: CATALOG.defaults.scanScripts !== false,
            sshCommand: CATALOG.defaults.sshCommand,
            pathGuardPolicy: CATALOG.defaults.pathGuardPolicy,
            protectedPaths: [...CATALOG.defaults.protectedPaths],
            proxyPort: CATALOG.defaults.proxyPort,
            proxyCommand: CATALOG.defaults.proxyCommand,
          }
        }
        return {
          enabled: Array.isArray(section.enabled)
            ? section.enabled.filter((name) => typeof name === 'string')
            : [...CATALOG.defaults.enabled],
          approveMutating: section.approveMutating !== false,
          dangerousKeyPolicy: POLICY_COPY.some((entry) => entry.id === section.dangerousKeyPolicy)
            ? section.dangerousKeyPolicy
            : CATALOG.defaults.dangerousKeyPolicy,
          useHostCredentials: section.useHostCredentials === true,
          // NATIVE_COPY, not GUARD_COPY: the native-git tiers have one more entry
          // (restrict) than the credential-path ones, and checking the wrong table
          // silently replaced a valid choice with the default.
          pluginEnabled: section.pluginEnabled !== false,
          logEnabled: section.logEnabled !== false,
          heartbeat: section.heartbeat === true,
          logPath: typeof section.logPath === 'string' ? section.logPath : CATALOG.defaults.logPath,
          scanScripts: section.scanScripts !== false,
          sshCommand: typeof section.sshCommand === 'string' && section.sshCommand.length > 0
            ? section.sshCommand
            : CATALOG.defaults.sshCommand,
          nativeGitPolicy: NATIVE_COPY.some((entry) => entry.id === section.nativeGitPolicy)
            ? section.nativeGitPolicy
            : CATALOG.defaults.nativeGitPolicy,
          pathGuardPolicy: GUARD_COPY.some((entry) => entry.id === section.pathGuardPolicy)
            ? section.pathGuardPolicy
            : CATALOG.defaults.pathGuardPolicy,
          protectedPaths: Array.isArray(section.protectedPaths)
            ? section.protectedPaths.filter((entry) => typeof entry === 'string')
            : [...CATALOG.defaults.protectedPaths],
          proxyPort: Number.isInteger(section.proxyPort) && section.proxyPort >= 0 && section.proxyPort <= 65535
            ? section.proxyPort
            : CATALOG.defaults.proxyPort,
          proxyCommand: typeof section.proxyCommand === 'string' ? section.proxyCommand : CATALOG.defaults.proxyCommand,
        }
      }

      /**
       * Insert the page stylesheet, preferring the runtime's own bookkeeping.
       *
       * `styles` is a builtin of the DYNAMIC client evaluator; a bundle loaded from
       * a composition does not receive it. So it is used when present (the runtime
       * then disposes the tag with the plugin) and otherwise the tag is inserted
       * directly, which is self-contained and needs no ambient value.
       *
       * @returns a disposer removing the tag.
       */
      function insertStyles() {
        const owner = typeof styles === 'undefined' ? undefined : styles
        if (owner !== undefined && typeof owner.insert === 'function') return owner.insert(CSS)

        const document = globalThis.document
        if (document === undefined || document.head === undefined) return () => {}
        const tagId = "git-for-dsh" + '/settings.css'
        const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']')
        if (existing !== null) return () => existing.remove()
        const tag = document.createElement('style')
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }

      /**
       * Subscribe a component to a scope snapshot.
       * @param scope - the bound namespace scope.
       * @returns the current snapshot, re-rendered after every accepted change.
       */
      function useScopeSnapshot(scope) {
        const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot())
        React.useEffect(() => {
          const sync = () => setSnapshot(scope.getSnapshot())
          sync()
          return scope.subscribe(sync)
        }, [])
        return snapshot
      }

      /**
       * Register the settings page.
       * @param ctx - client root context.
       */
      function apply(ctx) {
        // The stylesheet is inserted by THIS bundle. The `styles` builtin is
        // part of the DYNAMIC client evaluator's scope (it is passed as a
        // parameter there), and a composition-loaded bundle is not evaluated that
        // way — so relying on it, or on `ctx.get('styles')` (which answers
        // undefined because it is not a service), is what shipped a completely
        // unstyled page. A tag this bundle inserts itself works either way.
        ctx.effect(() => insertStyles(), 'git-tool: settings styles')

        // Declared in `inject`, so this resolves before apply runs. The lookup
        // and the inert fallback are kept as a net: they should be unreachable,
        // and reaching one means the declaration and the runtime disagree.
        const binder = service(ctx, 'settingsScope')
        const scope =
          binder !== undefined && typeof binder.bind === 'function'
            ? binder.bind({ namespace: NAMESPACE, decode: decodeSection })
            : inertScope('设置服务未挂载（settingsScope 服务缺失），页面只能显示当前状态。')

        const GitSettingsPage = () => {
          const snapshot = useScopeSnapshot(scope)
          /** The user's latest choice, so the control reflects it immediately. */
          const [draft, setDraft] = React.useState(null)
          /** The last write failure, so a refusal is visible instead of silent. */
          const [writeError, setWriteError] = React.useState(null)
          /**
           * The proxy fields are edited as TEXT and written on blur: a write per
           * keystroke would queue a settings mutation for every character.
           */
          const [proxyDraft, setProxyDraft] = React.useState({})
          /** Which tab is showing. Everything else stays mounted but hidden. */
          const [tab, setTab] = React.useState('settings')
          /**
           * The last port test, rendered under the field.
           *
           * The host does the probing over a same-origin route: a cross-origin fetch
           * from the page to a proxy port is not a reliable test, and the answer has
           * to come from the same code the plugin will use before a remote operation.
           */
          const [portCheck, setPortCheck] = React.useState(null)
          /**
           * The log view: `{ state, body, message }`.
           *
           * Read on demand rather than polled — the operator opens the tab when they
           * want to look, and a timer would keep the page busy while a hang is being
           * investigated.
           */
          const [logView, setLogView] = React.useState(null)
          /**
           * The ssh programs the host found: `{ state, body, message }`.
           *
           * Detected on demand, never at render time and never per tool call — the probe
           * touches the filesystem, which is fine on a click and a hazard anywhere else.
           */
          const [sshProbe, setSshProbe] = React.useState(null)
          const probeSsh = () => {
            setSshProbe({ state: 'loading' })
            Promise.resolve()
              .then(() => fetch('/git-tool/ssh-check', { headers: { accept: 'application/json' } }))
              .then((response) => response.text().then((text) => classifyJsonResponse(
                response.status,
                text,
                'Host 侧还没有 ssh 探测路由（运行中的 Host 可能是重启前的版本），请重启 dsh web。',
              )))
              .then((verdict) => {
                if (!verdict.ok) throw new Error(verdict.message)
                setSshProbe({ state: 'done', body: verdict.body })
              })
              .catch((error) => setSshProbe({
                state: 'failed',
                message: error !== null && typeof error === 'object' && typeof error.message === 'string'
                  ? error.message
                  : String(error),
              }))
          }

          const readLog = (action) => {
            setLogView({ state: 'loading' })
            const query = action === 'clear' ? '?action=clear' : '?tail=300'
            Promise.resolve()
              .then(() => fetch('/git-tool/log' + query, { headers: { accept: 'application/json' } }))
              .then((response) => response.text().then((text) => classifyJsonResponse(
                response.status,
                text,
                'Host 侧还没有日志路由（运行中的 Host 可能是重启前的版本），请重启 dsh web。',
              )))
              .then((verdict) => {
                if (!verdict.ok) throw new Error(verdict.message)
                setLogView({ state: 'done', body: verdict.body })
              })
              .catch((error) => setLogView({
                state: 'failed',
                message: error !== null && typeof error === 'object' && typeof error.message === 'string'
                  ? error.message
                  : String(error),
              }))
          }
          const checkPort = () => {
            const parsed = Number.parseInt(String(proxyDraft.proxyPort ?? value.proxyPort ?? 0), 10)
            setPortCheck({ state: 'loading' })
            Promise.resolve()
              .then(() => fetch('/git-tool/proxy-check?port=' + String(Number.isInteger(parsed) ? parsed : 0), {
                headers: { accept: 'application/json' },
              }))
              /*
               * Read the text first, and classify it here.
               *
               * The first version called response.json() directly. An unmatched route
               * answers with an EMPTY body, so the page showed the parser's message —
               * "Unexpected end of JSON input" — which says nothing about the actual
               * situation: the route is not registered because the running Host half
               * predates it. A restart is the fix, and the page has to say so.
               */
              .then((response) => response.text().then((text) => classifyJsonResponse(
                response.status,
                text,
                'Host 侧没有这个检查路由（运行中的 Host 可能是重启前的版本），请重启 dsh web 后再试。',
              )))
              .then((verdict) => {
                if (!verdict.ok) throw new Error(verdict.message)
                setPortCheck({ state: 'done', body: verdict.body })
              })
              .catch((error) => setPortCheck({
                state: 'failed',
                message: error !== null && typeof error === 'object' && typeof error.message === 'string'
                  ? error.message
                  : String(error),
              }))
          }

          const catalog = CATALOG
          const tiers = Array.isArray(catalog.catalog) ? catalog.catalog : []
          const allNames = tiers.flatMap((tier) =>
            (tier.groups || []).flatMap((group) => (group.operations || []).map((operation) => operation.name)),
          )
          // The draft wins while it lasts: in memory persistence the snapshot never
          // carries the value, so without this a toggle would visually snap back
          // even though the Host accepted the write.
          const value = draft ?? snapshot.value ?? {}
          const enabled = Array.isArray(value.enabled) ? value.enabled : (catalog.defaults || {}).enabled || []
          const enabledSet = new Set(enabled)
          const canWrite = writable(snapshot)

          /**
           * Write one namespace field, showing the choice at once and reporting a
           * refused write rather than reverting in silence.
           * @param field - the namespace field to write.
           * @param next - the value the user chose.
           */
          const writePolicy = (field, next) => {
            setDraft({ ...value, [field]: next })
            setWriteError(null)
            Promise.resolve(scope.set(field, next)).catch((error) => {
              setWriteError(error instanceof Error ? error.message : String(error))
            })
          }

          const writeEnabled = (nextSet) => {
            writePolicy(
              'enabled',
              allNames.filter((name) => nextSet.has(name)),
            )
          }
          const toggle = (name, on) => {
            const next = new Set(enabled)
            if (on) next.add(name)
            else next.delete(name)
            writeEnabled(next)
          }
          const namesOf = (tier) =>
            (tier.groups || []).flatMap((group) => (group.operations || []).map((operation) => operation.name))
          const setTier = (tier, on) => {
            const next = new Set(enabled)
            for (const name of namesOf(tier)) {
              if (on) next.add(name)
              else next.delete(name)
            }
            writeEnabled(next)
          }

          const status =
            snapshot.status === 'loading'
              ? '正在读取已保存的配置…（读取完成前控件不可改）'
              : snapshot.status === 'unavailable'
                ? '改动会立即生效（本次会话），但本页面不读取 Host 的持久化配置：' + describeUnavailable(snapshot)
                : '已启用 ' + enabledSet.size + ' / ' + allNames.length + ' 项操作。'

          /** One boolean option row, written through the same scope. */
          /** A group heading inside the settings tab. */
          const group = (title) =>
            React.createElement('h4', { className: 'git-tool-groupTitle' }, title)

          /**
           * One labelled setting: title on the left, control and its note on the right.
           *
           * `data-writes` marks the controls that change the settings document, which
           * is what has to follow `canWrite`; the port test does not write anything and
           * must stay usable even when the document cannot be saved.
           */
          const row = (title, control, note) =>
            React.createElement(
              'div',
              { className: 'git-tool-row' },
              React.createElement('span', { className: 'git-tool-rowTitle' }, title),
              React.createElement(
                'div',
                { className: 'git-tool-rowBody' },
                control,
                note === undefined || note === null
                  ? null
                  : React.createElement('span', { className: 'git-tool-rowNote' }, note),
              ),
            )

          /**
           * A three-way selector: segmented buttons, with the ACTIVE choice's hint
           * beneath. Three radio rows each carrying two lines of prose took three
           * times the height for the same information.
           */
          const segmented = (field, copy, current) => {
            const active = copy.find((entry) => entry.id === current) ?? copy[0]
            return React.createElement(
              'div',
              { className: 'git-tool-rowBody' },
              React.createElement(
                'div',
                { className: 'git-tool-seg' },
                copy.map((entry) =>
                  React.createElement(
                    'button',
                    {
                      key: entry.id,
                      type: 'button',
                      className: 'git-tool-segItem' + (entry.id === active.id ? ' is-active' : ''),
                      disabled: !canWrite,
                      'data-writes': 'true',
                      onClick: () => writePolicy(field, entry.id),
                    },
                    entry.label,
                  ),
                ),
              ),
              React.createElement('span', { className: 'git-tool-rowNote' }, active.hint),
            )
          }

          /** A collapsed explanation: the detail stays reachable without owning the page. */
          const details = (summary, text) =>
            React.createElement(
              'details',
              { className: 'git-tool-details' },
              React.createElement('summary', { className: 'git-tool-summary' }, summary),
              React.createElement('p', { className: 'git-tool-detailText' }, text),
            )

          const option = (field, checked, title, hint) =>
            React.createElement(
              'label',
              { key: field, className: 'git-tool-option' },
              React.createElement('input', {
                type: 'checkbox',
                checked,
                disabled: !canWrite,
                'data-writes': 'true',
                onChange: (event) => writePolicy(field, event.target.checked),
              }),
              React.createElement(
                'span',
                { className: 'git-tool-itemBody' },
                React.createElement('span', { className: 'git-tool-itemName' }, title),
                React.createElement('span', { className: 'git-tool-itemMeta' }, hint),
              ),
            )

          return React.createElement(
            'div',
            { className: 'git-tool-page' },
            React.createElement('h3', { className: 'git-tool-title' }, 'Git 工具：允许 AI 执行的操作'),
            React.createElement(
              'p',
              { className: 'git-tool-lead' },
              '勾选后 AI 才能在会话沙箱之外执行对应的 git 子命令；未勾选的在进程启动前就被拒绝，提示为「该操作未启用」。',
            ),
            React.createElement('p', { className: 'git-tool-status' }, status),
          writeError === null
            ? null
            : React.createElement('p', { className: 'git-tool-tierWarn' }, '写入失败：' + writeError),
            React.createElement(
              'div',
              { className: 'git-tool-tabs', role: 'tablist' },
              TABS.map((entry) => {
                const group = entry.id === 'settings' ? undefined : tiers.find((tier) => tier.risk === entry.id)
                const names = group === undefined ? undefined : namesOf(group)
                const on = names === undefined ? undefined : names.filter((name) => enabledSet.has(name)).length
                return React.createElement(
                  'button',
                  {
                    key: entry.id,
                    type: 'button',
                    className: 'git-tool-tab' + (tab === entry.id ? ' is-active' : ''),
                    role: 'tab',
                    'aria-selected': tab === entry.id,
                    onClick: () => setTab(entry.id),
                  },
                  entry.label + (on === undefined ? '' : ` ${String(on)}/${String(names.length)}`),
                )
              }),
            ),
            tiers.map((tier) => {
              const names = namesOf(tier)
              const on = names.filter((name) => enabledSet.has(name)).length
              const state = on === 0 ? 'off' : on === names.length ? 'on' : 'partial'
              return React.createElement(
                'section',
                { key: tier.risk, className: 'git-tool-tier', 'data-tier': tier.risk, hidden: tab !== tier.risk },
                React.createElement(
                  'header',
                  { className: 'git-tool-tierHead' },
                  React.createElement(
                    'label',
                    { className: 'git-tool-tierToggle' },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: state === 'on',
                      disabled: !canWrite,
                      ref: (node) => {
                        if (node !== null) node.indeterminate = state === 'partial'
                      },
                      onChange: (event) => setTier(tier, event.target.checked),
                    }),
                    React.createElement('span', { className: 'git-tool-tierTitle' }, tier.title || tier.risk),
                  ),
                  React.createElement('span', { className: 'git-tool-tierCount' }, on + '/' + names.length),
                ),
                TIER_HELP[tier.risk] === undefined
                  ? null
                  : React.createElement('p', { className: 'git-tool-tierHint' }, TIER_HELP[tier.risk]),
                TIER_NOTE[tier.risk] === undefined
                  ? null
                  : React.createElement('p', { className: 'git-tool-tierWarn' }, TIER_NOTE[tier.risk]),
                React.createElement(
                  'ul',
                  { className: 'git-tool-list' },
                  (tier.groups || []).flatMap((group) =>
                    (group.operations || []).map((operation) =>
                      React.createElement(
                        'li',
                        { key: operation.name, className: 'git-tool-item' },
                        React.createElement(
                          'label',
                          { className: 'git-tool-itemLabel' },
                          React.createElement('input', {
                            type: 'checkbox',
                            checked: enabledSet.has(operation.name),
                            disabled: !canWrite,
                            onChange: (event) => toggle(operation.name, event.target.checked),
                          }),
                          React.createElement(
                            'span',
                            { className: 'git-tool-itemBody' },
                            React.createElement('code', { className: 'git-tool-itemName' }, 'git ' + operation.name),
                            React.createElement(
                              'span',
                              { className: 'git-tool-itemMeta' },
                              operation.label || operation.summary || '',
                            ),
                            operation.paths === true
                              ? React.createElement(
                                  'span',
                                  { className: 'git-tool-itemMeta' },
                                  '接受 paths 参数，例如 paths: ["src"]',
                                )
                              : null,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              )
            }),
            React.createElement(
              'section',
              { className: 'git-tool-tier', hidden: tab !== 'settings' },

              group('插件'),
              option(
                'pluginEnabled',
                value.pluginEnabled !== false,
                '启用本插件',
                '关闭后：git_exec 拒绝调用，工具守卫完全不再拦截。立即生效，无需重启 —— 用来做 A/B 对比（例如判断某次卡顿是不是插件造成的）。',
              ),

              group('审批'),
              option(
                'approveMutating',
                value.approveMutating !== false,
                '写操作前询问我',
                '写档与远程档的每次调用都弹审批，而不只靠勾选放行。',
              ),

              group('闸门'),
              row(
                '原生 git',
                segmented('nativeGitPolicy', NATIVE_COPY, value.nativeGitPolicy ?? CATALOG.defaults.nativeGitPolicy),
              ),
              row(
                '凭据与身份文件',
                segmented('pathGuardPolicy', PATH_COPY, value.pathGuardPolicy ?? CATALOG.defaults.pathGuardPolicy),
              ),
              row(
                '受保护的路径',
                React.createElement('input', {
                  type: 'text',
                  className: 'git-tool-input',
                  disabled: !canWrite,
                  'data-writes': 'true',
                  placeholder: '~/.git-credentials, ~/.gitconfig',
                  value: proxyDraft.protectedPaths ?? (value.protectedPaths ?? []).join(', '),
                  onChange: (event) => setProxyDraft((previous) => ({ ...previous, protectedPaths: event.target.value })),
                  onBlur: (event) => writePolicy(
                    'protectedPaths',
                    event.target.value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0),
                  ),
                }),
                '逗号分隔',
              ),
              row(
                '检查脚本内容',
                option(
                  'scanScripts',
                  value.scanScripts !== false,
                  '读取 bash 所执行脚本的内容',
                  '堵住 bash deploy.sh 这类把 git 藏进脚本的写法。也可能误伤：脚本里只是"提到" git 时会被拒。',
                ),
              ),
              row(
                'SSH 程序',
                React.createElement(
                  'div',
                  { className: 'git-tool-inline' },
                  React.createElement('input', {
                    type: 'text',
                    className: 'git-tool-input',
                    disabled: !canWrite,
                    'data-writes': 'true',
                    placeholder: '/usr/bin/ssh',
                    value: proxyDraft.sshCommand ?? (value.sshCommand ?? CATALOG.defaults.sshCommand),
                    onChange: (event) => setProxyDraft((previous) => ({ ...previous, sshCommand: event.target.value })),
                    onBlur: (event) => writePolicy('sshCommand', event.target.value),
                  }),
                  React.createElement(
                    'button',
                    { type: 'button', className: 'git-tool-testButton', onClick: probeSsh },
                    sshProbe !== null && sshProbe.state === 'loading' ? '探测中…' : '探测',
                  ),
                ),
                'git 走 SSH 时使用它（由 GIT_SSH_COMMAND 钉死，配置改不了它）。不确定填什么就点「探测」。',
              ),
              sshProbe === null
                ? null
                : React.createElement(
                  'div',
                  { className: 'git-tool-probeList' },
                  sshProbe.state === 'failed'
                    ? React.createElement('span', { className: 'git-tool-tierWarn' }, '探测失败：' + sshProbe.message)
                    : sshProbe.state === 'loading'
                      ? React.createElement('span', { className: 'git-tool-rowNote' }, '正在查找本机的 ssh…')
                      : sshProbe.body.error !== undefined
                        ? React.createElement('span', { className: 'git-tool-tierWarn' }, '探测失败：' + sshProbe.body.error)
                        : sshProbe.body.candidates.filter((candidate) => candidate.executable).length === 0
                          ? React.createElement(
                            'span',
                            { className: 'git-tool-tierWarn' },
                            '这台机器上没找到可执行的 ssh。SSH 远端暂时用不了，需要先安装 OpenSSH；HTTPS 远端不受影响。',
                          )
                          : sshProbe.body.candidates
                            .filter((candidate) => candidate.executable)
                            .map((candidate) => React.createElement(
                              'button',
                              {
                                key: candidate.path,
                                type: 'button',
                                className: 'git-tool-probeItem',
                                disabled: !canWrite,
                                onClick: () => writePolicy('sshCommand', candidate.path),
                              },
                              React.createElement(
                                'span',
                                { className: 'git-tool-probePath' },
                                candidate.path === (value.sshCommand ?? '') ? '✓ ' : '',
                              ),
                              candidate.path,
                              candidate.version.length > 0
                                ? React.createElement('span', { className: 'git-tool-probeNote' }, candidate.version)
                                : null,
                            )),
                ),
              details(
                '挡得住什么、挡不住什么',
                '原生 git：命令文本里出现 git 调用（含 /usr/bin/git、git.exe、$(git …)、git-credential-*）即拦截，并在原因里指明改用 git_exec。'
                  + '凭据路径：路径参数解析为绝对路径（跟随软链接）后比较，等于受保护文件、或包含它的目录都算命中；命令文本里出现路径或文件名也算。'
                  + '两者都是参数文本匹配 —— 拦得住直接写法，拦不住运行时拼出来的路径或写进脚本的命令，因此是策略闸门而非安全边界。'
                  + '硬保证需要在沙箱里遮蔽这些文件，那属于 dsh 的职责，本插件不做。',
              ),

              group('凭据'),
              option(
                'useHostCredentials',
                value.useHostCredentials === true,
                '允许 git 使用本机凭据',
                '关闭：远程写操作一律失败。开启：git 自己读取凭据助手，令牌不经过参数、审批提示或会话记录。',
              ),
              details(
                '开启后会同时生效的（代价）',
                '~/.gitconfig 里的一切 —— url.<base>.insteadOf 可以把某个主机重定向到别处（凭据可能被送到非预期的服务器），credential.helper 与 alias.* 是 git 会执行的程序。'
                  + '只在你信任这台机器的全局配置时开启。'
                  + '另外，令牌本身仍可被同 uid 的进程读取（dsh 的沙箱限制写入、不限制读取），所以这一项只解决“插件能不能推送”，不解决“令牌会不会被 AI 读到”。',
              ),

              group('代理'),
              row(
                '端口',
                React.createElement(
                  'div',
                  { className: 'git-tool-inline' },
                  React.createElement('input', {
                    type: 'number',
                    min: 0,
                    max: 65535,
                    className: 'git-tool-input git-tool-inputPort',
                    disabled: !canWrite,
                    'data-writes': 'true',
                    value: proxyDraft.proxyPort ?? String(value.proxyPort ?? CATALOG.defaults.proxyPort ?? 0),
                    onChange: (event) => setProxyDraft((previous) => ({ ...previous, proxyPort: event.target.value })),
                    onBlur: (event) => {
                      const parsed = Number.parseInt(event.target.value, 10)
                      const port = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 0
                      setProxyDraft((previous) => ({ ...previous, proxyPort: String(port) }))
                      writePolicy('proxyPort', port)
                    },
                  }),
                  React.createElement(
                    'button',
                    { type: 'button', className: 'git-tool-testButton', onClick: checkPort },
                    portCheck !== null && portCheck.state === 'loading' ? '测试中…' : '端口测试',
                  ),
                ),
                '127.0.0.1；0 = 关闭',
              ),
              portCheck === null
                ? null
                : React.createElement(
                  'p',
                  { className: portCheck.state === 'done' && portCheck.body.listening === true ? 'git-tool-rowNote' : 'git-tool-tierWarn' },
                  portCheck.state === 'loading'
                    ? '正在测试 ' + String(proxyDraft.proxyPort ?? value.proxyPort ?? 0) + ' …'
                    : portCheck.state === 'failed'
                      ? '无法测试：' + portCheck.message
                      : portCheck.body.error !== undefined
                        ? '测试失败：' + portCheck.body.error
                        : portCheck.body.listening === true
                          ? '✓ 127.0.0.1:' + String(portCheck.body.port) + ' 上有服务在监听，远程操作会直接使用它。'
                          : '✗ 127.0.0.1:' + String(portCheck.body.port) + ' 上没有服务。'
                            + (Array.isArray(portCheck.body.alternatives) && portCheck.body.alternatives.length > 0
                              ? '检测到这些端口有服务：' + portCheck.body.alternatives.join('、') + ' —— 若那是你的代理，请改端口。'
                              : portCheck.body.commandConfigured === true
                                ? '已配置启动命令，首次远程操作时插件会拉起它。'
                                : '也没有配置启动命令，远程操作会被拒绝。'),
                ),
              row(
                '启动命令',
                React.createElement('input', {
                  type: 'text',
                  className: 'git-tool-input',
                  disabled: !canWrite,
                  'data-writes': 'true',
                  placeholder: '例如 my-proxy --port 7890',
                  value: proxyDraft.proxyCommand ?? (value.proxyCommand ?? ''),
                  onChange: (event) => setProxyDraft((previous) => ({ ...previous, proxyCommand: event.target.value })),
                  onBlur: (event) => writePolicy('proxyCommand', event.target.value),
                }),
                '首次远程操作时执行一次',
              ),
              details(
                '代理的工作方式',
                '端口已有服务在监听：直接使用它，不启动也不停止（那是你的进程）。端口空闲：执行启动命令，最多等 8 秒；仍没起来就杀掉并报出输出。'
                  + '两者都没有：拒绝并说明。插件只负责拉起你的代理，不注入任何凭据 —— 令牌留在你的代理里。',
              ),

              group('仓库配置审计'),
              row(
                '出现危险配置键时',
                segmented('dangerousKeyPolicy', POLICY_COPY, value.dangerousKeyPolicy ?? CATALOG.defaults.dangerousKeyPolicy),
              ),
            ),
            React.createElement(
              'section',
              { className: 'git-tool-tier', hidden: tab !== 'logs' },
              group('诊断日志'),
              option(
                'logEnabled',
                value.logEnabled !== false,
                '写诊断日志',
                '每次闸门判定记一行（含耗时），流式写入、脱敏、超过 2MB 自动轮转。卡死前最后一行就是线索，所以默认开启。',
              ),
              option(
                'heartbeat',
                value.heartbeat === true,
                '心跳行',
                '默认关闭。开启后每 5 秒写一行，并报出"当前有哪个调用卡在半途、卡了多久"——调查卡死时打开它，平时关着。与「写诊断日志」互不影响：只开心跳时日志里只有心跳行。',
              ),
              row(
                '日志路径',
                React.createElement('input', {
                  type: 'text',
                  className: 'git-tool-input',
                  disabled: !canWrite,
                  'data-writes': 'true',
                  placeholder: '留空使用默认路径',
                  value: proxyDraft.logPath ?? (value.logPath ?? ''),
                  onChange: (event) => setProxyDraft((previous) => ({ ...previous, logPath: event.target.value })),
                  onBlur: (event) => writePolicy('logPath', event.target.value),
                }),
                (value.logPath ?? '').length > 0 ? '当前：' + value.logPath : '当前：默认（$DSH_HOME/git-for-dsh.log）',
              ),
              React.createElement(
                'div',
                { className: 'git-tool-inline' },
                React.createElement(
                  'button',
                  { type: 'button', className: 'git-tool-testButton', onClick: () => readLog('read') },
                  logView !== null && logView.state === 'loading' ? '读取中…' : '刷新',
                ),
                React.createElement(
                  'button',
                  { type: 'button', className: 'git-tool-testButton', onClick: () => readLog('clear') },
                  '清空日志',
                ),
                React.createElement(
                  'span',
                  { className: logView !== null && logView.state === 'failed' ? 'git-tool-tierWarn' : 'git-tool-rowNote' },
                  logView === null
                    ? '点「刷新」读取；清空会让文件从零开始。'
                    : logView.state === 'loading'
                      ? '读取中…'
                      : logView.state === 'failed'
                        ? '读取失败：' + logView.message
                        : logView.body.error !== undefined
                          ? '读取失败：' + logView.body.error
                          : (logView.body.cleared === true ? '已清空 ' : '') + String(logView.body.lines.length) + ' 行'
                            + (logView.body.truncated === true ? '（只显示末尾）' : '')
                            + (logView.body.enabled === false ? '；日志当前是关闭的' : ''),
                ),
              ),
              React.createElement(
                'pre',
                { className: 'git-tool-log' },
                logView === null || logView.body === undefined || logView.body.lines === undefined
                  ? ''
                  : logView.body.lines.join('\n'),
              ),
              details(
                '如果这个页面点不动了',
                '进程卡住时这个页面会跟着一起没有响应 —— 因为它正是由那个进程提供的，页面上的任何按钮都救不了它。'
                  + '这时代码里的一切都无能为力，需要外面动手：在另一个终端运行 '
                  + 'tools/watchdog.sh（只探测并报告），或 '
                  + 'DSH_RESTART_CMD="dsh web" tools/watchdog.sh --restart（探测到卡死后 kill -9 并重启）。'
                  + '它探测的是 dsh 自己的 web 服务，所以不依赖本插件。'
                  + '另外，无论如何都能用 DSH_GIT_TOOL_DISABLED=1 dsh web 完全跳过本插件启动。',
              ),
              details(
                '日志里有什么、没有什么',
                '记：插件激活时的策略快照、每一次工具调用的 enter/exit 与判定结果和耗时、插件关闭与拒绝的原因。'
                  + '不记：命令原文、凭据（那里只记长度与命中的规则名，凭据 URL 额外脱敏）。',
              ),
            ),
            React.createElement(
              'p',
              { className: 'git-tool-build' },
              '页面版本 ' + BUILD + '（与 lib/client.js 对比；不同则强制刷新）',
            ),
            React.createElement(
              'p',
              { className: 'git-tool-note' },
              '本插件只负责“自己不放行、自己不成漏点”。机器级加固（沙箱、密钥保管）不在其范围内：dsh 的文件策略限制写入、不限制读取，本机可读文件对模型仍可读。',
            ),
          )
        }

        /** React error boundary: a broken page costs a card, not the panel. */
        class Boundary extends React.Component {
          constructor(props) {
            super(props)
            this.state = { error: null }
          }

          static getDerivedStateFromError(error) {
            return { error: error instanceof Error ? error.message : String(error) }
          }

          render() {
            if (this.state.error !== null) {
              return message('Git 工具设置页渲染失败（插件内部错误，不影响其余功能）：' + this.state.error)
            }
            return this.props.children
          }
        }

        const slots = service(ctx, 'slots')
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          // No slot ledger on this page: there is nothing to attach to, and
          // nothing that should fail this plugin's load over it.
          return
        }
        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: 'git-tool',
              order: 30,
              label: () => 'Git 工具',
            },
            () => React.createElement(Boundary, null, React.createElement(GitSettingsPage, null)),
          ),
        )
      }

      /* @git-tool-css-begin */
      /**
       * Page stylesheet.
       *
       * Layout follows the settings panel's own conventions rather than bare
       * divs: a row is a flex line whose control is vertically centred against a
       * 32px minimum title line, and the row's title and explanation are two
       * stacked lines separated by colour and leading. Writing this as one
       * inline run is what made the strategy card read as a wall of text.
       *
       * Colours are theme tokens only, so light and dark both come out right.
       */
      const CSS = [
        '.git-tool-page{display:flex;flex-direction:column;gap:16px;width:100%;max-width:860px;color:var(--dsw-alias-label-primary)}',
        '.git-tool-tabs{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:2px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
        '.git-tool-tab{appearance:none;margin:0;padding:6px 12px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:8px;font:inherit;font-size:13px;line-height:18px;cursor:pointer}',
        '.git-tool-tab:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.git-tool-tab.is-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}',
        // `.git-tool-tier` sets display:flex, which beats the user-agent rule for
        // [hidden]; without this the panels would never actually hide.
        '.git-tool-tier[hidden]{display:none}',
        '.git-tool-title{margin:0;font-size:15px;font-weight:600;line-height:22px}',
        '.git-tool-lead{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
        '.git-tool-status{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',

        /* One card per risk tier, plus the strategy card (no data-tier). */
        '.git-tool-tier{display:flex;flex-direction:column;gap:10px;padding:14px 16px 16px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:12px}',
        '.git-tool-tier[data-tier="write"]{border-color:var(--dsw-alias-border-l2)}',
        '.git-tool-tier[data-tier="remote"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1))}',

        /* Card header: control, title, count. */
        '.git-tool-tierHead{display:flex;align-items:center;gap:10px;min-height:32px}',
        '.git-tool-tierToggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer}',
        '.git-tool-tierTitle{font-size:14px;font-weight:600;line-height:20px}',
        '.git-tool-tierCount{margin-left:auto;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}',
        '.git-tool-tierHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:19px}',
        '.git-tool-tierWarn{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:12.5px;line-height:19px}',

        /* Operation grid: two columns of compact rows. */
        '.git-tool-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 14px;margin:0;padding:0;list-style:none}',
        '.git-tool-item{min-width:0}',

        /*
         * A row is: control, then a body that stacks a title over its
         * explanation. `flex:1` plus `min-width:0` lets long copy wrap instead
         * of overflowing, and `line-height` on both lines is what keeps them
         * visually distinct when the row is narrow.
         */
        '.git-tool-itemLabel,.git-tool-option{display:flex;align-items:flex-start;gap:8px;min-height:32px;padding:6px 8px;border-radius:8px;cursor:pointer}',
        '.git-tool-itemLabel:hover,.git-tool-option:hover{background:var(--dsw-alias-bg-layer-1)}',
        '.git-tool-itemBody{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
        // Both text lines are `display:block` so the title and its explanation
        // stay on separate lines even if some other sheet sets span display.
        '.git-tool-itemName{display:block;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}',
        '.git-tool-itemMeta{display:block;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;overflow-wrap:anywhere}',

        /* Strategy rows are full-width, so they get a little more room. */
        '.git-tool-option{margin-top:2px}',
        '.git-tool-groupTitle{margin:6px 0 -2px;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}',
        '.git-tool-row{display:flex;align-items:flex-start;gap:12px;padding:7px 0;border-top:.5px solid var(--dsw-alias-border-l1)}',
        '.git-tool-row:first-of-type{border-top:none}',
        '.git-tool-rowTitle{flex:none;width:132px;padding-top:5px;font-size:12.5px;line-height:18px}',
        '.git-tool-rowBody{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px}',
        '.git-tool-rowNote{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.git-tool-inline{display:flex;align-items:center;gap:8px}',
        '.git-tool-seg{display:inline-flex;padding:2px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:9px}',
        '.git-tool-segItem{appearance:none;margin:0;padding:3px 12px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:7px;font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
        '.git-tool-segItem:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
        '.git-tool-segItem.is-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}',
        '.git-tool-segItem:disabled{cursor:not-allowed;opacity:.55}',
        '.git-tool-details{margin:2px 0 0}',
        '.git-tool-summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.git-tool-summary:hover{color:var(--dsw-alias-label-primary)}',
        '.git-tool-detailText{margin:6px 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px}',
        '.git-tool-input{box-sizing:border-box;flex:1;min-width:0;height:28px;padding:0 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));border-radius:8px;font:inherit;font-size:12.5px}',
        '.git-tool-inputPort{flex:none;width:110px}',
        '.git-tool-testButton{flex:none;height:28px;padding:0 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:12.5px;cursor:pointer}',
        '.git-tool-testButton:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.git-tool-segItem:focus-visible{outline:1.5px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.git-tool-probeList{margin:4px 0 0;display:flex;flex-direction:column;gap:4px}',
        '.git-tool-probeItem{display:flex;align-items:baseline;gap:8px;width:100%;padding:6px 10px;text-align:left;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;cursor:pointer}',
        '.git-tool-probeItem:hover:enabled{border-color:var(--dsw-alias-brand-primary)}',
        '.git-tool-probeItem:disabled{cursor:default;opacity:.6}',
        '.git-tool-probePath{flex:0 0 auto}',
        '.git-tool-probeNote{color:var(--dsw-alias-label-secondary);font-size:11px}',
        '.git-tool-log{margin:4px 0 0;padding:10px 12px;max-height:420px;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-all}',
        '.git-tool-option>.git-tool-itemBody{gap:4px}',
        '.git-tool-option .git-tool-itemMeta{line-height:18px}',
        '.git-tool-option .git-tool-itemName{font-family:inherit;font-size:13px;font-weight:500;line-height:19px}',

        '.git-tool-note{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px}',
        '.git-tool-build{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}',
        '.git-tool-page input[type="checkbox"]{flex:none;width:15px;height:15px;margin:8px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}',
        '.git-tool-page input[type="checkbox"]:disabled{cursor:not-allowed}',
        '@media (width <= 680px){.git-tool-list{grid-template-columns:minmax(0,1fr)}}',
      ].join('')
      /* @git-tool-css-end */

      // Exported for the suite: this classification is where the "Unexpected end of
      // JSON input" defect lived, and it cannot regress if a test calls it.
      exports.classifyJsonResponse = classifyJsonResponse
      exports.inject = inject
      exports.apply = apply
      exports.message = message
      exports.inertScope = inertScope
    } catch (error) {
      // Evaluation failed. Answer a plugin that does nothing, rather than letting
      // the throw fail this plugin's load and surface as a broken page.
      const detail = error instanceof Error ? error.message : String(error)
      // Guarded: this is the fail-safe path, so it must not itself depend on a
      // global being present.
      if (typeof console !== 'undefined') console.error('git-tool client half failed to initialise:', detail)
      exports.apply = () => {}
    }

    return module.exports
  },
})
