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
 * @module dsh-plugin-git-tool/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-git-tool',
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
       * An unmatched route answers with an EMPTY body, and the first version read it
       * with `response.json()` — so the page showed the parser's message
       * ("Unexpected end of JSON input") instead of the actionable one ("the running
       * Host half predates this route; restart dsh web").
       *
       * @param status - the HTTP status.
       * @param text - the raw body.
       * @returns `{ ok: true, body }` or `{ ok: false, message }`.
       */
      function classifyProxyCheck(status, text) {
        if (typeof text !== 'string' || text.trim().length === 0) {
          return {
            ok: false,
            message: status === 404
              ? 'Host 侧没有这个检查路由（运行中的 Host 可能是重启前的版本），请重启 dsh web 后再试。'
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
        { id: 'read', label: '只读' },
        { id: 'write', label: '写操作' },
        { id: 'remote', label: '远程' },
        { id: 'settings', label: '策略与代理' },
      ]

      /**
       * The three verdicts the tool guard can reach, and what each one means.
       *
       * The ids are the values the Host accepts, so a label can be reworded without
       * touching the schema.
       */
      const GUARD_COPY = [
        { id: 'deny', label: '禁止（默认）', hint: '直接拒绝，并把可用的替代方式写进拒绝原因。' },
        { id: 'ask', label: '询问', hint: '弹出一次审批，由你当场决定。' },
        { id: 'allow', label: '允许', hint: '不拦截。这一项只保留在页面上以便解释，等于关闭该保护。' },
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
        {
          id: 'refuse-repo',
          label: '一票拒绝（默认）',
          hint: '仓库 .git/config 里出现任何危险键，本工具在该仓库拒绝执行任何命令。最省心，但含此类键的仓库会完全用不了这个工具。',
        },
        {
          id: 'refuse-affected',
          label: '只拒受影响的命令',
          hint: '仅当危险键会影响被请求的子命令时才拒绝。例如 alias.* 劫持不了 git 内建命令，因此不影响 status。',
        },
        {
          id: 'neutralize',
          label: '尽量中和，只拒无法中和的',
          hint: '已被钉死的键（core.pager、core.fsmonitor、credential.helper 等）继续正常工作；git 原生通配（filter.*、url.*.insteadOf 等）钉不死，仍然拒绝。',
        },
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
          nativeGitPolicy: GUARD_COPY.some((entry) => entry.id === section.nativeGitPolicy)
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
        const tagId = 'dsh-plugin-git-tool/settings.css'
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
          const [tab, setTab] = React.useState('read')
          /**
           * The last port test, rendered under the field.
           *
           * The host does the probing over a same-origin route: a cross-origin fetch
           * from the page to a proxy port is not a reliable test, and the answer has
           * to come from the same code the plugin will use before a remote operation.
           */
          const [portCheck, setPortCheck] = React.useState(null)
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
              .then((response) => response.text().then((text) => classifyProxyCheck(response.status, text)))
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
          const option = (field, checked, title, hint) =>
            React.createElement(
              'label',
              { key: field, className: 'git-tool-option' },
              React.createElement('input', {
                type: 'checkbox',
                checked,
                disabled: !canWrite,
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
              '勾选后，AI 才能在文件沙箱之外执行对应的 git 子命令（例如在会话工作区以外的仓库里提交）。未勾选的子命令会在命令启动前被插件拒绝，AI 收到的提示是「该操作未启用」，而不是「沙箱拒绝」。',
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
              React.createElement(
                'header',
                { className: 'git-tool-tierHead' },
                React.createElement('span', { className: 'git-tool-tierTitle' }, '执行策略'),
              ),
              option(
                'approveMutating',
                value.approveMutating !== false,
                '写操作前询问我',
                '对「写操作」和「远端 / 毁灭性操作」的每一次调用弹出审批，而不是只靠上面的勾选放行。建议保持开启。',
              ),
              React.createElement(
                'div',
                { className: 'git-tool-policy' },
                React.createElement(
                  'span',
                  { className: 'git-tool-itemName' },
                  '代理（插件只负责把你的代理拉起来，不管凭据）',
                ),
                React.createElement(
                  'label',
                  { className: 'git-tool-field' },
                  React.createElement('span', { className: 'git-tool-fieldLabel' }, '代理端口（127.0.0.1，0 = 关闭）'),
                  React.createElement('span', { className: 'git-tool-itemMeta' }, '填好后点下面的「测试这个端口」验证一下 —— 填错端口是这里最容易犯的错。'),
                  React.createElement('input', {
                    type: 'number',
                    min: 0,
                    max: 65535,
                    className: 'git-tool-input git-tool-inputPort',
                    disabled: !canWrite,
                    value: proxyDraft.proxyPort ?? String(value.proxyPort ?? CATALOG.defaults.proxyPort ?? 0),
                    onChange: (event) => setProxyDraft((previous) => ({ ...previous, proxyPort: event.target.value })),
                    onBlur: (event) => {
                      const parsed = Number.parseInt(event.target.value, 10)
                      const port = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 0
                      setProxyDraft((previous) => ({ ...previous, proxyPort: String(port) }))
                      writePolicy('proxyPort', port)
                    },
                  }),
                ),
                React.createElement(
                  'div',
                  { className: 'git-tool-field' },
                  React.createElement('span', { className: 'git-tool-fieldLabel' }, ''),
                  React.createElement(
                    'button',
                    { type: 'button', className: 'git-tool-testButton', onClick: checkPort },
                    portCheck !== null && portCheck.state === 'loading' ? '测试中…' : '测试这个端口',
                  ),
                ),
                portCheck === null
                  ? null
                  : React.createElement(
                    'p',
                    { className: portCheck.state === 'done' && portCheck.body.listening === true ? 'git-tool-itemMeta' : 'git-tool-tierWarn' },
                    portCheck.state === 'loading'
                      ? '正在测试 ' + String(proxyDraft.proxyPort ?? value.proxyPort ?? 0) + ' …'
                      : portCheck.state === 'failed'
                        ? '无法测试：' + portCheck.message
                        : portCheck.body.error !== undefined
                          ? '测试失败：' + portCheck.body.error
                          : portCheck.body.listening === true
                            ? '✓ 127.0.0.1:' + String(portCheck.body.port) + ' 上有服务在监听 —— 远程操作会直接使用它'
                              + (portCheck.body.effective === true ? '。' : '（注意：保存后才会用作当前端口。）')
                            : '✗ 127.0.0.1:' + String(portCheck.body.port) + ' 上没有服务。'
                              + (Array.isArray(portCheck.body.alternatives) && portCheck.body.alternatives.length > 0
                                ? '但检测到这些端口有服务：' + portCheck.body.alternatives.join('、') + ' —— 若那是你的代理，请把端口改成它。'
                                : portCheck.body.commandConfigured === true
                                  ? '设置里有启动命令，插件会在首次远程操作时拉起它并等待监听。'
                                  : '也没有配置启动命令，远程操作会被拒绝并提示。'),
                  ),
                React.createElement(
                  'label',
                  { className: 'git-tool-field' },
                  React.createElement('span', { className: 'git-tool-fieldLabel' }, '启动命令（在首次远程操作时执行一次）'),
                  React.createElement('input', {
                    type: 'text',
                    className: 'git-tool-input',
                    placeholder: '例如 my-proxy --port 7890',
                    disabled: !canWrite,
                    value: proxyDraft.proxyCommand ?? (value.proxyCommand ?? ''),
                    onChange: (event) => setProxyDraft((previous) => ({ ...previous, proxyCommand: event.target.value })),
                    onBlur: (event) => writePolicy('proxyCommand', event.target.value),
                  }),
                ),
                React.createElement(
                  'span',
                  { className: 'git-tool-itemMeta' },
                  '端口上已有代理在监听时直接使用它（不启动、也不停止它）；端口空闲时才执行启动命令；两者都没有则拒绝并说明。插件不注入任何凭据 —— 令牌留在你的代理里。',
                ),
                React.createElement('span', { className: 'git-tool-itemName' }, '原生 git（bash 里调用 git）'),
                GUARD_COPY.map((entry) =>
                  React.createElement(
                    'label',
                    { key: 'native-' + entry.id, className: 'git-tool-option' },
                    React.createElement('input', {
                      type: 'radio',
                      name: 'git-tool-native-git-policy',
                      checked: (value.nativeGitPolicy ?? CATALOG.defaults.nativeGitPolicy) === entry.id,
                      disabled: !canWrite,
                      onChange: () => writePolicy('nativeGitPolicy', entry.id),
                    }),
                    React.createElement(
                      'span',
                      { className: 'git-tool-itemBody' },
                      React.createElement('span', { className: 'git-tool-itemName' }, entry.label),
                      React.createElement('span', { className: 'git-tool-itemMeta' }, entry.hint),
                    ),
                  ),
                ),
                React.createElement(
                  'span',
                  { className: 'git-tool-itemMeta' },
                  'bash 里的 git 会绕过本插件的允许清单、参数闸门、配置审计与审批，所以默认拦截，并提示改用 git_exec。'
                    + '注意这是**参数文本匹配**（绝对路径与混淆写法可能绕过），它是一道策略闸门，不是安全边界。',
                ),
                React.createElement('span', { className: 'git-tool-itemName' }, '凭据/身份文件（read / write / edit / glob / grep）'),
                GUARD_COPY.map((entry) =>
                  React.createElement(
                    'label',
                    { key: 'paths-' + entry.id, className: 'git-tool-option' },
                    React.createElement('input', {
                      type: 'radio',
                      name: 'git-tool-path-guard-policy',
                      checked: (value.pathGuardPolicy ?? CATALOG.defaults.pathGuardPolicy) === entry.id,
                      disabled: !canWrite,
                      onChange: () => writePolicy('pathGuardPolicy', entry.id),
                    }),
                    React.createElement(
                      'span',
                      { className: 'git-tool-itemBody' },
                      React.createElement('span', { className: 'git-tool-itemName' }, entry.label),
                      React.createElement('span', { className: 'git-tool-itemMeta' }, entry.hint),
                    ),
                  ),
                ),
                React.createElement(
                  'label',
                  { className: 'git-tool-field' },
                  React.createElement('span', { className: 'git-tool-fieldLabel' }, '受保护的路径（逗号分隔）'),
                  React.createElement('input', {
                    type: 'text',
                    className: 'git-tool-input',
                    disabled: !canWrite,
                    value: proxyDraft.protectedPaths ?? (value.protectedPaths ?? []).join(', '),
                    onChange: (event) => setProxyDraft((previous) => ({ ...previous, protectedPaths: event.target.value })),
                    onBlur: (event) => writePolicy(
                      'protectedPaths',
                      event.target.value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0),
                    ),
                  }),
                ),
                React.createElement(
                  'span',
                  { className: 'git-tool-itemMeta' },
                  '命中判定：路径参数解析为绝对路径（跟随软链接）后与清单比较，**等于受保护文件、或包含它的目录**都算命中；bash 命令文本里出现路径或文件名也算命中。'
                    + '它拦得住"顺手读一下"，拦不住运行时拼出来的路径 —— 那需要沙箱层面遮蔽，属于 dsh 的职责，本插件不做。',
                ),
                React.createElement(
                  'span',
                  { className: 'git-tool-itemName' },
                  '本机凭据',
                ),
                option(
                  'useHostCredentials',
                  value.useHostCredentials === true,
                  '允许 git 读取本机凭据配置（否则插件无法推送）',
                  '关闭时：隐藏 ~/.gitconfig 与系统配置、清空 credential.helper —— 远程写操作一律失败（cannot read Username）。开启时：git 自己读取凭据助手，令牌不经过参数、审批提示或会话记录。',
                ),
                // Always shown, not only once it is on: the cost has to be readable
                // BEFORE the switch is flipped, which is the only moment it can inform
                // a decision. The colour only changes when the risk is live.
                React.createElement(
                  'p',
                  { className: value.useHostCredentials === true ? 'git-tool-tierWarn' : 'git-tool-itemMeta' },
                  '开启后会同时生效的：~/.gitconfig 里的一切 —— url.<base>.insteadOf 可以把某个主机重定向到别处（凭据可能被送到非预期的服务器），credential.helper 与 alias.* 是 git 会执行的程序。'
                    + '只在你信任这台机器的全局配置时开启。'
                    + '另外，令牌本身仍可被同 uid 的进程读取（dsh 的沙箱限制写入、不限制读取），所以这一项只解决"插件能不能推送"，不解决"令牌会不会被 AI 读到"。',
                ),
                React.createElement('span', { className: 'git-tool-itemName' }, '仓库配置出现危险键时'),
                POLICY_COPY.map((entry) =>
                  React.createElement(
                    'label',
                    { key: entry.id, className: 'git-tool-option' },
                    React.createElement('input', {
                      type: 'radio',
                      name: 'git-tool-dangerous-key-policy',
                      checked: (value.dangerousKeyPolicy ?? CATALOG.defaults.dangerousKeyPolicy) === entry.id,
                      disabled: !canWrite,
                      onChange: () => writePolicy('dangerousKeyPolicy', entry.id),
                    }),
                    React.createElement(
                      'span',
                      { className: 'git-tool-itemBody' },
                      React.createElement('span', { className: 'git-tool-itemName' }, entry.label),
                      React.createElement('span', { className: 'git-tool-itemMeta' }, entry.hint),
                    ),
                  ),
                ),
              ),
            ),
            React.createElement(
              'p',
              { className: 'git-tool-build' },
              '页面版本 ' + BUILD + '（与 lib/client.js 里的构建指纹对比；不一致说明浏览器仍在用旧 bundle，请强制刷新）',
            ),
            React.createElement(
              'p',
              { className: 'git-tool-note' },
              '本插件只负责“自己不放行、自己不成漏点”：拒绝 -c / --config-env 与切换仓库的全局选项，默认隐藏 ~/.gitconfig，钉死可钉的危险键，并在仓库配置出现危险键时拒绝执行。'
                + '它不负责机器级加固 —— dsh 的文件策略限制写入、不限制读取，本机可读文件对模型仍可读；那属于沙箱与密钥保管的问题，不是插件能解决的。',
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
        '.git-tool-policy{display:flex;flex-direction:column;gap:2px;margin-top:4px}',
        '.git-tool-field{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:8px}',
        '.git-tool-fieldLabel{flex:none;width:220px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}',
        '.git-tool-input{box-sizing:border-box;flex:1;min-width:0;height:28px;padding:0 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));border-radius:8px;font:inherit;font-size:12.5px}',
        '.git-tool-inputPort{flex:none;width:110px}',
        '.git-tool-testButton{flex:none;height:28px;padding:0 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:12.5px;cursor:pointer}',
        '.git-tool-testButton:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.git-tool-policy input[type="radio"]{flex:none;width:15px;height:15px;margin:8px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}',
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
      exports.classifyProxyCheck = classifyProxyCheck
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
