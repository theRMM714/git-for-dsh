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
 * from the Host's own catalog (`__GIT_TOOL_CATALOG__`, substituted by
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
  id: __GIT_TOOL_PACKAGE__,
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
      const CATALOG = __GIT_TOOL_CATALOG__

      /**
       * Turn the port-check response into either a report or a readable failure.
       *
       * An unmatched route answers with an EMPTY body, so the body is classified before
       * it is parsed: the page reports the actionable cause (the running Host half predates
       * this route; restart dsh web) rather than the parser's message.
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
      /**
       * Whether a stored value names a tier the HOST still accepts.
       *
       * Read the same way as the options themselves: the embedded ids decide, and the copy
       * table stands in for a build without them. A value the Host no longer declares is
       * therefore not quietly swapped for the client's own idea of the default.
       *
       * Declared here, beside the tables, because the decode and the render both use it.
       */
      const isKnownTier = (field, value, copy) => (CATALOG.defaults.tierIds?.[field] ?? copy.map((entry) => entry.id)).includes(value)

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
      /** A built-in row, reset to the defaults this build ships. */
      /** The same-origin route that reports the configuration health and resets it. */
      const CONFIG_CHECK_ROUTE = '/git-tool/config-check'

      const builtinRows = (rows) => (rows ?? []).map((row) => ({ ...row, builtin: true }))

      /** Whether this path is one of the built-in rows. */
      const isBuiltinRow = (path) => (CATALOG.defaults.protectionRows ?? []).some((row) => row.path === path)

      /**
       * Whether a row offers a delete button. Built-in rows do not.
       *
       * Takes the row as it is, because rows arrive in two shapes: one from the settings
       * document (which may carry `builtin`) and one from the draft a write produces (which
       * never does). The path decides, so both shapes answer the same.
       *
       * @param rule - a blacklist row.
       * @returns true when the operator may remove it.
       */
      const rowIsDeletable = (rule) => !(rule.builtin === true || isBuiltinRow(rule.path))

      /** A row as the settings document stores it: the boxes, and nothing derived. */
      const storableRow = (row) => ({ path: row.path, read: row.read === true, write: row.write === true, ask: row.ask === true })

      /** How a path named in a bash command is judged. Stated as a heuristic, because it is. */
      /** What the guard does when IT fails. Two options, because both are defensible. */
      const GUARD_ERROR_COPY = [
        { id: 'ask', label: '询问我', hint: '守卫出错时先问你，由你决定这一次放不放行。默认：缺陷不会静默。' },
        { id: 'allow', label: '静默放行', hint: '守卫出错时照旧放行，只写一行诊断日志 —— 适合你已知道并接受某个缺陷时。' },
      ]
      const BASH_MODE_COPY = [
        { id: 'heuristic', label: '启发式', hint: '明显的读命令按读算，明显的写命令按写算，其余一律按写算（保守兜底）。' },
        { id: 'write-only', label: '一律按写', hint: '任何提到该路径的命令都按写算，所以读一个只勾了「读」的文件也会被拒。' },
      ]

      /** Where git may run. The default is the session's own workspace. */
      const TARGET_COPY = [
        {
          id: 'workspace',
          label: '仅工作区',
          hint: '只能在本次会话的工作区内执行。默认值，也是最保守的一档。',
        },
        {
          id: 'allowlist',
          label: '指定路径',
          hint: '只能在下面列出的根目录内执行（含其子目录）。',
        },
        {
          id: 'unrestricted',
          label: '无限制',
          hint: '可以在机器上任何目录执行 —— 包括你不希望它接触的仓库。请明确知道自己在放开什么。',
        },
      ]

      /** The script check's tiers, in the order the control shows them. */
      const SCRIPT_COPY = [
        {
          id: 'strict',
          label: '严格',
          hint: '脚本内容里只要**提到** git 就拒绝写入。抓得住"只是提了一句"的脚本，也就难免误伤。',
        },
        {
          id: 'restrict',
          label: '限制',
          hint: '只有内容里**真的在命令位置调用 git** 才拒绝（引号、注释、字符串里的提及不算）。基本不误伤。',
        },
        {
          id: 'off',
          label: '关闭',
          hint: '不检查脚本内容。写入不受影响，运行时的命令行判别仍然生效。',
        },
      ]

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
      const BUILD = __GIT_TOOL_BUILD__

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
            scriptCheckPolicy: CATALOG.defaults.scriptCheckPolicy,
            targetScope: CATALOG.defaults.targetScope,
            targetPaths: [...(CATALOG.defaults.targetPaths ?? [])],
            scanScripts: CATALOG.defaults.scanScripts !== false,
            sshCommand: CATALOG.defaults.sshCommand,
            pathRules: builtinRows(CATALOG.defaults.protectionRows),
            bashPathMode: CATALOG.defaults.bashPathMode ?? 'heuristic',
            proxyPort: CATALOG.defaults.proxyPort,
            proxyCommand: CATALOG.defaults.proxyCommand,
          }
        }
        return {
          enabled: Array.isArray(section.enabled)
            ? section.enabled.filter((name) => typeof name === 'string')
            : [...CATALOG.defaults.enabled],
          approveMutating: section.approveMutating !== false,
          dangerousKeyPolicy: isKnownTier('config', section.dangerousKeyPolicy, POLICY_COPY)
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
          targetScope: isKnownTier('targetScope', section.targetScope, TARGET_COPY)
            ? section.targetScope
            : CATALOG.defaults.targetScope,
          targetPaths: Array.isArray(section.targetPaths)
            ? section.targetPaths.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            : [...(CATALOG.defaults.targetPaths ?? [])],
          scriptCheckPolicy: isKnownTier('scriptCheck', section.scriptCheckPolicy, SCRIPT_COPY)
            ? section.scriptCheckPolicy
            : CATALOG.defaults.scriptCheckPolicy,
          scanScripts: section.scanScripts !== false,
          sshCommand: typeof section.sshCommand === 'string' && section.sshCommand.length > 0
            ? section.sshCommand
            : CATALOG.defaults.sshCommand,
          nativeGitPolicy: isKnownTier('nativeGit', section.nativeGitPolicy, NATIVE_COPY)
            ? section.nativeGitPolicy
            : CATALOG.defaults.nativeGitPolicy,
          pathRules: Array.isArray(section.pathRules) && section.pathRules.length > 0
            ? section.pathRules.map((row) => ({
              path: String(row.path),
              read: row.read === true,
              write: row.write === true,
              ask: row.ask === true,
              // Recomputed here rather than stored: which rows are built in is a property of
              // this build, not of the operator's document.
              builtin: isBuiltinRow(row.path),
            }))
            : builtinRows(CATALOG.defaults.protectionRows),
          bashPathMode: BASH_MODE_COPY.some((entry) => entry.id === section.bashPathMode)
            ? section.bashPathMode
            : (CATALOG.defaults.bashPathMode ?? 'heuristic'),
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
        const tagId = __GIT_TOOL_PACKAGE__ + '/settings.css'
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
          /**
           * Add the pending path as a row with every box empty.
           *
           * Shared by the button and by Enter. A path already listed is not added twice, and the
           * input is cleared either way. Reads the draft, so it must run in this scope.
           */
          const addPendingPath = () => {
            const path = (proxyDraft.newPath ?? '').trim()
            if (path.length === 0) return
            const rows = (value.pathRules ?? []).map(storableRow)
            if (!rows.some((row) => row.path === path)) {
              writePolicy('pathRules', [...rows, { path, read: false, write: false, ask: false }])
            }
            setProxyDraft((previous) => ({ ...previous, newPath: '' }))
          }

          /**
       * The configuration health, as the Host reports it.
       *
       * null means not asked yet; an object carries either the retired key names or an error.
       * The answer cannot be computed here: the page sees a validated section, so a retired key
       * is indistinguishable from a current one.
       */
      const [configHealth, setConfigHealth] = React.useState(null)

      /** Ask the Host which keys the current schema no longer knows. */
      const checkConfiguration = () => {
        fetch(CONFIG_CHECK_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => setConfigHealth({
            retired: Array.isArray(payload.retired) ? payload.retired.filter((key) => typeof key === 'string') : [],
            error: typeof payload.error === 'string' ? payload.error : undefined,
          }))
          .catch(() => setConfigHealth({ retired: [], error: '无法连接宿主' }))
      }

      /**
       * Write an empty section, which falls back to the base and the defaults.
       *
       * Destructive by intent: it is the one action that removes the retired keys, and it also
       * removes every customisation, so the row says so beside the button.
       */
      const resetConfiguration = () => {
        fetch(CONFIG_CHECK_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (typeof payload.error === 'string') setConfigHealth({ retired: [], error: payload.error })
            else checkConfiguration()
          })
          .catch(() => setConfigHealth({ retired: [], error: '无法连接宿主' }))
      }

      // Asked once, when the page appears: the answer changes only when the settings file or
      // the schema does.
      React.useEffect(() => {
        checkConfiguration()
      }, [])

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
          /**
           * The tiers of one field, in the order the HOST accepts them.
           *
           * The copy table supplies the wording; the embedded ids supply which tiers exist and
           * in what order. A tier added on one side and not the other therefore becomes visible
           * — an unknown id is shown as its own id — instead of silently missing from the page.
           * Without embedded ids the table's own order stands, so this is inert until the build
           * provides them.
           */
          const tiersFor = (field, copy) => {
            const ids = CATALOG.defaults.tierIds?.[field]
            if (!Array.isArray(ids) || ids.length === 0) return copy
            return ids.map((id) => copy.find((entry) => entry.id === id) ?? { id, label: id, hint: '' })
          }

          const segmented = (field, copy, current) => {
            const options = tiersFor(field, copy)
            const active = options.find((entry) => entry.id === current) ?? options[0]
            return React.createElement(
              'div',
              { className: 'git-tool-rowBody' },
              React.createElement(
                'div',
                { className: 'git-tool-seg' },
                options.map((entry) =>
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
                '路径黑名单',
                React.createElement(
                  'div',
                  { className: 'git-tool-ruleList' },
                  (value.pathRules ?? []).map((rule) => React.createElement(
                    'div',
                    { key: rule.path, className: 'git-tool-ruleRow' },
                    React.createElement('span', { className: 'git-tool-rulePath' }, rule.path),
                    ...[['read', '读'], ['write', '写'], ['ask', '询问']].map(([box, label]) => React.createElement(
                      'label',
                      { key: box, className: 'git-tool-ruleBox' },
                      React.createElement('input', {
                        type: 'checkbox',
                        disabled: !canWrite,
                        'data-writes': 'true',
                        checked: rule[box] === true,
                        onChange: (event) => writePolicy('pathRules', (value.pathRules ?? []).map(
                          (other) => storableRow(other.path === rule.path ? { ...other, [box]: event.target.checked } : other),
                        )),
                      }),
                      label,
                    )),
                    rowIsDeletable(rule)
                      ? React.createElement('button', {
                        type: 'button',
                        className: 'git-tool-testButton',
                        disabled: !canWrite,
                        onClick: () => writePolicy('pathRules', (value.pathRules ?? []).filter((other) => other.path !== rule.path).map(storableRow)),
                      }, '删除')
                      : React.createElement('span', { className: 'git-tool-ruleNote' }, '内置'),
                  )),
                  React.createElement(
                    'div',
                    { className: 'git-tool-inline' },
                    React.createElement('input', {
                      type: 'text',
                      className: 'git-tool-input',
                      disabled: !canWrite,
                      'data-writes': 'true',
                      placeholder: '再加一条路径，例如 /home/me/private',
                      value: proxyDraft.newPath ?? '',
                      onChange: (event) => setProxyDraft((previous) => ({ ...previous, newPath: event.target.value })),
                      // Enter is the same intent as the button; nothing happens on blur, so
                      // looking away no longer commits anything.
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') addPendingPath()
                      },
                    }),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'git-tool-testButton',
                        disabled: !canWrite,
                        onClick: addPendingPath,
                      },
                      '添加',
                    ),
                  ),
                ),
                '每行一条路径：勾「读」或「写」＝静默放行，勾「询问」＝每次访问先问你，三项都不勾＝静默禁止（不打扰你）。内置行不可删除。',
              ),
              row(
                '守卫自身出错时',
                segmented('guardErrorPolicy', GUARD_ERROR_COPY, value.guardErrorPolicy ?? CATALOG.defaults.guardErrorPolicy),
                '守卫是闸门的关键，所以它的缺陷不该隐形：默认把这次调用交给你裁决，而不是静默放行。',
              ),
              row(
                'bash 里的路径判定',
                segmented('bashPathMode', BASH_MODE_COPY, value.bashPathMode ?? CATALOG.defaults.bashPathMode),
                '守卫只能看命令文本，所以这一层本质是启发式：明显读按读、明显写按写、其余按写。',
              ),
              row(
                '配置体检',
                React.createElement(
                  'div',
                  { className: 'git-tool-inline' },
                  React.createElement(
                    'span',
                    { className: 'git-tool-ruleNote' },
                    configHealth === null
                      ? '检查中…'
                      : configHealth.error !== undefined
                        ? '无法检查：' + configHealth.error
                        : configHealth.retired.length === 0
                          ? '配置文件与当前版本一致'
                          : '配置文件里有 ' + String(configHealth.retired.length) + ' 个已退役的键：' + configHealth.retired.join('、'),
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'git-tool-testButton',
                      disabled: !canWrite,
                      onClick: resetConfiguration,
                    },
                    '一键初始化',
                  ),
                ),
                '一键初始化会写回全部默认值：你所有自定义设置都会丢失，包括黑白名单、目标范围与审批相关选项。',
              ),
              row(
                '原生 git',
                segmented('nativeGitPolicy', NATIVE_COPY, value.nativeGitPolicy ?? CATALOG.defaults.nativeGitPolicy),
              ),
              row(
                '目标范围',
                segmented('targetScope', TARGET_COPY, value.targetScope ?? CATALOG.defaults.targetScope),
                'git 可以在哪里执行。工作区之外的操作在「仅工作区」下会被拒绝。',
              ),
              (value.targetScope ?? CATALOG.defaults.targetScope) === 'allowlist'
                ? row(
                  '允许的根目录',
                  React.createElement('textarea', {
                    className: 'git-tool-input',
                    rows: 4,
                    disabled: !canWrite,
                    'data-writes': 'true',
                    placeholder: '/home/me/work\n/mnt/d/projects',
                    value: proxyDraft.targetPaths ?? (value.targetPaths ?? []).join('\n'),
                    onChange: (event) => setProxyDraft((previous) => ({ ...previous, targetPaths: event.target.value })),
                    onBlur: (event) => writePolicy(
                      'targetPaths',
                      event.target.value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
                    ),
                  }),
                  '一行一个根目录；目标目录必须落在其中某一个之内（含子目录）。',
                )
                : null,
              row(
                '写入脚本时检查内容',
                segmented('scriptCheckPolicy', SCRIPT_COPY, value.scriptCheckPolicy ?? CATALOG.defaults.scriptCheckPolicy),
                '写 shell 脚本（.sh/.bash 或 shebang）时先看内容，命中就拒绝写入，脚本不会生成。不读磁盘，所以不拖慢调用；'
                  + '由别的方式（heredoc、pull、其它工具）落地的脚本不会被预检。',
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
                            '没找到可执行的 ssh（检查了 ' + String(sshProbe.body.checked ?? 0) + ' 个位置'
                              + (sshProbe.body.nativeWindows === true
                                ? '。Windows 自带的 OpenSSH 通常在 C:\\\\Windows\\\\System32\\\\OpenSSH\\\\ssh.exe，'
                                  + '直接把路径填进上面的输入框即可'
                                : (sshProbe.body.platform === 'linux' && sshProbe.body.windowsMounts === 0
                                  ? '，且看不到 Windows 盘'
                                  : ''))
                              + '）。SSH 远端暂时用不了：可以在 WSL 里装 openssh，或者把上面「SSH 程序」直接填成你 Windows 侧 '
                              + 'ssh.exe 的路径（例如 C:\\Windows\\System32\\OpenSSH\\ssh.exe 对应的 /mnt/... 路径）。'
                              + 'HTTPS 远端不受影响。',
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
                            + (logView.body.exists === false ? '；文件还不存在（还没写过日志，或写入失败了）' : '')
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
        '.git-tool-ruleList{margin:4px 0 0;display:flex;flex-direction:column;gap:6px}',
        '.git-tool-ruleRow{display:flex;align-items:center;gap:10px;padding:6px 10px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:8px}',
        '.git-tool-rulePath{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all}',
        '.git-tool-ruleBox{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}',
        '.git-tool-ruleNote{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85}',
        '.git-tool-ruleList .git-tool-inline{gap:8px}',
        '.git-tool-ruleList .git-tool-input{flex:1 1 auto;min-width:0;box-sizing:border-box}',
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
      exports.rowIsDeletable = rowIsDeletable
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
