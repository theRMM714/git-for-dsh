# 踩坑记录

这个文件收集本项目**实际踩过**的坑：每条都写清「现象 / 根因 / 怎么判 / 怎么避 / 谁守着」。

它和 `README.md` 的分工：README 描述**现在的设计**，这里记录**为什么长成这样**，以及再动它时容易掉进哪里。

按危险程度排序：前面几条曾经让 dsh 起不来、让闸门空转、或让页面变成只读。

---

## 1. 客户端半的两份声明**不是二选一**

这一条前后错了两个方向，最终以真实事故收场，所以先讲结论：

> `package.json` 的 `dsh.client.inject` 装**包名**（模块图顺序）；
> 模块导出的 `inject` 装**服务名**（让激活等到服务就绪）。
> **两份都要写**，官方插件 `dsh-client-ui-settings-general` 就是两份都写。

### 第一错：读到未声明的服务 → 整个插件加载失败

**现象**：

```
Failed to load plugins
git-for-dsh
failed to apply loader entry 199c02e5 (git-for-dsh): cannot get property "slots" without inject
```

**根因**：模块导出的是 `inject: ['settingsScope', ...]`，而代码里读了 `ctx.slots`。Cordis Guard 对**未声明的服务属性读取**直接抛错，而 `apply` 在页面启动流程里执行 → 整个插件加载失败。

### 第二错（更隐蔽）：把声明整个删掉 → 设置页永久只读

**现象**：插件加载正常、工具可用、日志干净，但设置页**所有控件禁用**。

**根因**：我据此推断"任何声明都会让包被永久 parked"，于是**删掉了整个 `exports.inject`**，全部改用 `ctx.get`。`ctx.get` 确实不会触发 Guard、也确实能优雅降级 —— 但它**同时丢掉了顺序保证**：

```text
apply 可能在 @deepseek-ai/dsh-client-ui-settings 注册 settingsScope 之前执行
  → ctx.get('settingsScope') 返回 undefined
  → 页面退化成 inert scope
  → 控件全部禁用（表现为"禁止用户修改配置"）
```

而那个"声明会 parked"的推断**从未被验证，且被官方插件直接否定**。

### 怎么避

- **服务名写进模块导出的 `inject`**（这是让激活等待服务的唯一机制）；
- **包名写在 `package.json` 的 `dsh.client.inject`**（模块图顺序）；
- `ctx.get` 只作为"这个环境可能没有它"的**额外**保险，不能替代声明。

### 谁守着（这次刻意写死了）

- `test/client.test.mjs` 断言 `exports.inject` **恰好等于** `['slots', 'settingsScope']`；
- `scripts/verify-served-bundle.mjs` 断言声明覆盖实际读取的服务。

**注意这两条断言原来写的是反的** —— 它们要求 `inject` **不存在**，等于把 bug 焊死。*断言也可能在表达错误的设计；修 bug 时要一并修断言。*

---

## 2. 服务必须声明：`ctx.get` 会**静默**返回 undefined

**现象**：插件看起来完全正常 —— 工具能用、页面能开、日志没有任何错误 —— 但**设置页的复选框全部禁用**（读起来就是"禁止用户修改配置"）。

**根因**：Host 半读全局配置用 `ctx.get('settings')`，但**没有在 `inject` 里声明 `settings`**。cordis 对未声明服务用 `ctx.get()` 读取时返回 `undefined`，**不报错**。于是注册设置命名空间那一段被整段跳过：命名空间不存在 → 客户端拿不到 → 只读。

**怎么判**：这一条最难在于"没有任何错误"。判据是问 Host 要事实：

```
registered      : true/false      ← 命名空间到底在不在
settings.writable: true
```

**怎么避**：**要用就直接声明**（`inject: [...]`）；`ctx.get()` 只作为"这个环境可能没有它"的可选回退。

**谁守着**：`test/host.test.mjs` 的 ctx 是代理，读取**未声明且实际存在**的服务会**抛错**。把 bug 重新引入 → 29 个断言失败。

---

## 3. 浏览器半可能仍在使用**旧 bundle**

**现象**：刚修完的 bug"又出现了"，怎么看都像没修。

**根因**：客户端 bundle 是页面加载时取回的模块。页面不重新加载，浏览器就一直用内存里的旧版本 —— 而症状与新修的 bug 一模一样。

**怎么判**：设置页底部有一行 **`页面版本 <构建指纹>`**（由 `scripts/build.mjs` 写入，例如 `2026-09-15 12:07Z/5dcab9b4`）。和仓库里 `lib/client.js` 里的指纹对比：**不一致就是页面旧了，强制刷新即可**。

**怎么避**：改完客户端先 `npm run build`，再强制刷新；报障时先要那一行版本号。

---

## 4. `host` 不在客户端 bundle 的作用域里

**现象**：插件**能加载**，但设置页显示"渲染失败：host is not defined"。

**根因**：`host`（以及 `styles`）是**动态 Client 求值器**的作用域参数 —— 那边是 `new Function('React','console','styles','host',…)`。composition 加载的 bundle 只从 `require` 拿到模块，**没有这些标识符**。

注意它**不是加载期错误而是渲染期错误**：`apply()` 里不碰它就不报，组件一渲染才炸。

**怎么避**：客户端半只引用 `React`（来自 `require`）和 `apply` 收到的参数。需要向 Host 要数据时，用构建期嵌入（本项目就是这么做的）或 `ctx.get` 到的服务，而不是 `host.call`。

**教训**：我当时用"把 `styles`/`host` 注入作用域"的 harness 验证，所以脚本里能跑、页面里炸。**harness 给的作用域必须与真实运行环境一致**。

---

## 5. `styles` 不是服务，样式表要自己插

**现象**：设置页**完全没有样式** —— 没有卡片、没有边框、勾选框和文字之间连间距都没有。

**根因**：我把样式表交给 `ctx.get('styles')` 去插。但 `styles` **不是 Cordis 服务**，而是一个调用方拥有的作用域内建值 → `ctx.get('styles')` 永远 `undefined` → 我自己的守卫"没有就跳过"把整段插入**静默跳过**了。

**怎么避**：bundle **自己**插 `<style>`（`document.head.appendChild`），`styles` 只在恰好存在时优先用。

**谁守着**：`test/client.test.mjs` 装一个假 `document`，断言 `apply` 后**恰好追加 1 个 style 标签**，且标签里含卡片规则与两行规则；渲染检查也会跑真实组件。

---

## 6. memory 持久化 ≠ 不可写

**现象**：复选框禁用，状态行说"本次会话内可改，但不会保存"。用户理解为"权限被禁"。

**根因**：两层错误叠加：

1. `scope.mutate()` **永远**走 `remote.settings.mutate`，**写入照样送到 Host**。`persistence: 'memory'` 只表示"客户端不把这个命名空间读回来当真相源"（非 loopback 页面会这样），**不代表不可写**。我把两者当成一回事，于是 `writable = status==='ready' && writable===true` 在 memory 模式下必然为假 → 全部控件禁用。**这是我造成的，不是环境限制。**
2. 即使能点，memory 模式快照里没有值，勾选后下一次渲染会**弹回未勾选**。

**怎么避**：可用性判据只排除"真的拿不到服务"的情况（`mode: 'inert'`）；页面用本地 `draft` 作为显示源，保证勾选立刻反映；写入失败要**显示出来**而不是静默回退。

**谁守着**：`test/client.test.mjs` 的三条断言：memory 模式不得禁用、只有 inert 才禁用、以及 `controlRows` 递归收集控件行。

---

## 7. 审计命令必须能被 git 接受，否则闸门**空转**

**现象**：配置审计全绿，但**什么都没做** —— 每次调用都放行。

**根因**：我让 git 跑 `config --local --includes --name-only -z`。git 2.55 直接 **exit 129**（`error: no action specified` —— `--name-only` 必须与 `--list` 同用）。而"读不到配置"按设计**不算拒绝**（非仓库目录本来就无配置可读）。两个设计叠在一起 → 闸门永远读不到东西、永远放行。

**更糟的是测试**：单元测试只断言"命令字符串里含 `--includes`" —— 命令根本跑不起来，测试照样绿。

**怎么避**：

- 命令写成 `git config --local --includes --list --name-only -z`；
- 命令**只有一处定义**（`CONFIG_AUDIT_COMMAND`），闸门、单元测试、验证脚本共用，不再各写一份；
- 用**真实 git** 验证它能跑。

**谁守着**：`scripts/verify-config-audit.mjs` 第一条就是"命令 exit 0（一个被拒绝的命令会让闸门空转）"。

**通用教训**：单元测试**测不出**"命令本身无效"。凡是把字符串交给外部程序的闸门，都要有一个真实调用它的验证。

---

## 8. `--local --list` 看不到 `[include]` 进来的键

**现象**：仓库配置里一行 `[include] path = /任意绝对路径`，危险键**照样生效**，但审计看不到。

**根因**：`git config --local --list` **默认不展开 include**；`--includes` 才展开。（实测：被 include 的 `core.fsmonitor` 能执行，而 `--local --list` 对它显示 0 次。）

**怎么避**：审计必须带 `--includes`；本项目还把 `include.path` / `includeif.*.path` **本身**列为危险键 —— include 能把**机器上任意路径**的配置拉进来，且默认不可见。

**谁守着**：`verify-config-audit.mjs` 里有对照：**不带 `--includes` 时同一个键不可见**（这个对照项是必要的，否则"看得到"可能只是碰巧）。

---

## 9. 插件里的 `config` 闸门**不是**对抗 AI 的边界

**现象**：以为禁止了 `git config` 写入就堵住了配置注入。实际上仓库配置在**工作区内**，模型可以直接写那个文件。

**根因**：dsh 的文件策略限制的是**写入范围**，而仓库就在允许写入的工作区里。`git config` 只读化挡的是"**工具自己成为写入口**"，对"绕过工具直接改文件"无效。

**怎么避**：真正承重的是**命令级加固** —— 钉死 `core.fsmonitor`/`core.sshCommand`/`core.gitProxy` 等键 + diff 类强制 `--no-ext-diff --no-textconv`。它的性质是"**不管配置怎么来的都生效**"，因此直接写文件也绕不过。审计是补充（覆盖钉不死的通配键）。

**谁守着**：`scripts/verify-driver-hardening.mjs` 先**直接改 `.git/config`** 注入恶意键，再对比未加固/加固两种运行 —— 并带控制组。

---

## 10. 验证必须有控制组，否则"没看到标记"可能只是没武装

这一条踩了**三次**，每次都差点得出错误结论：

| 场景 | 假象 | 真相 |
| --- | --- | --- |
| 用双引号写 `core.fsmonitor` | "未加固也不执行 → 加固无效" | git 解析时吃掉引号，注入**根本没生效** |
| `execFileSync` 只在失败时返回 stderr | "程序没有执行" | 标记打在 stderr 上，成功时**看不到** |
| 首次 include 测试用相对路径 | "--list 也不显示 → 无盲区" | 路径没解析成功，include **压根没生效** |

**怎么避**：凡是"某个危险行为没有发生"的结论，都必须先证明**在加固前它确实会发生**。本项目三个验证脚本都带控制组。

---

## 11. 测试替身必须照实，否则缺陷会漏过去

夹具比真实实现宽松，就会把 bug 藏起来。已知的四处：

| 替身 | 真实的形状 | 宽松的后果 |
| --- | --- | --- |
| Host 侧 `SettingsScope` | 只有 `get`/`watch`/`update`/`replace` | 写成 `subscribe`/`set`（那是浏览器侧 API）→ 假绿 |
| `ctx` 服务读取 | 读未声明服务**抛错** | 漏掉"声明缺失 → 命名空间没注册 → 只读页面" |
| `ctx.shell.resolve({})` | 省略 workdir 回落到**进程** cwd，不是会话工作区 | 在生产里跑到错的仓库 |
| `ctx.approval` | 有 `overrideOf(session)`，插件靠它解释"策略 never" | 错误文案断言失效 |

另外：Host 测试要用 `applyUnguarded`（无兜底的入口），否则 `apply()` 的兜底会把"夹具坏了"变成"工具未注册"，把真实原因藏起来。

---

## 12. 审批策略和沙箱模式被预设**绑在一起**

**现象**：选了"完全权限"，结果审批策略变成 `never`，于是"写操作前询问我"不再弹提示、直接自动拒绝；用户以为是自己没设对，或者以为是插件在阻止。

**根因**：`dsh-permission-presets` 把两者绑成**同一条预设**：

| 预设 | 沙箱 | 审批 |
| --- | --- | --- |
| `workspace-write` | workspace-write | **ask** |
| `danger-full-access` | danger-full-access | **never** |

默认表里**没有**"完全权限 + 仍弹审批"的组合。

**怎么避**：知道这是**两条独立旋钮**被一条预设同时拨动。要测写档：把会话预设切到 `workspace-write`（= 受限沙箱 + ask）—— **这不影响插件的 git**，因为插件对自己的 git 调用显式指定了沙箱外执行；预设只影响 `bash`/`read`/`write` 等工具。或者关掉插件里的"写操作前询问我"，靠允许清单 + 审计 + 参数闸门三层。

**注意**：审批策略按**会话**记录（写在会话日志里），新会话回到部署默认 `ask`。

---

## 13. 沙箱不管读取 —— 凭据不能靠插件保护

**现象**：以为"隐藏 `~/.gitconfig`、清空 `credential.helper`"就守住了凭据。

**根因**：dsh 的三种文件策略（`read-only`/`workspace-write`/`danger-full-access`）描述的都是**写入范围**。**读取不受这份策略约束**：实测在 `workspace-write` 下，工作区外的文件（含 `~/.git-credentials`）对模型仍然可读。

顺带两个实测结论：

- 强制注入的 `credential.helper=''` **确实**压住全局的 `store`（带控制组验证）—— 所以"允许读取用户级 git 配置"这个开关**换不来凭据能力**，只会让整份全局配置变得可读（用假 token 模拟验证过 token 会进入上下文）。这个开关因此被移除。
- `git config -f <任意文件>` 可以定向读仓库外的文件，因此被列为禁止形式。

**怎么避**：把"凭据不进 AI 上下文"当作**机器级/沙箱级**问题，而不是插件问题。本插件的承诺只有一条：**它自己不读取、不传递、不存储凭据，也不成为漏点**。至于密钥该由哪个 uid 持有、要不要放进模型看不到的命名空间，那是部署方的决定。

---

## 14. 客户端 bundle 是手写的，格式不能猜

**现象**：客户端半整个不生效，或加载报错。

**根因**：客户端半由 `dsh-client-modules` 作为**预构建产物**服务：`window.__ModuleLoader__.load({ id, factory })`，`id` 必须是**包名**，`factory` 接收 `require` 并返回 `module.exports`。写错 id、用 ESM `import`、用 JSX 都会失败。

**怎么避**：照 `src/client.js` 的骨架写（无打包器、可直接阅读）；`require` 只能请求包，跨插件协作走 Cordis 服务。

**谁守着**：`test/client.test.mjs` 用真实 `__ModuleLoader__` 执行源码，并断言"恰好注册一个模块且 id 等于包名"。

---

## 15. 插件为什么对 git 显式指定 `danger-full-access`

**现象**：在会话沙箱里 `git init` 失败，报 `[sandbox: file access denied …]`。

**根因（实测）**：部署策略是 `workspace-write`，而它的 workspace root 是**进程 cwd**（`ctx.shell.resolve({}).workdir`），**不是会话工作区**。于是工作区里的 `.git` 也可能落在允许范围之外。

**怎么避**：插件对每次 git 调用显式传 `sandboxPermissions: { mode: 'danger-full-access', workspaceRoot }`，并由允许清单 + 参数闸门 + 配置审计 + 逐次审批替代沙箱作为约束；同时**自己**把 workdir 解析成会话工作区（不能依赖 shell 的默认值）。

**注意**：这一条只影响**插件自己的 git**。会话切到 `workspace-write` 预设不会妨碍它。

## 20. 跨激活的模块级可变状态

**现象**：代理功能的集成测试里，"端口一直起不来时必须拒绝"那条**没有拒绝** —— 因为上一条测试已经启动过代理，模块级标志还留着"已启动"，于是这次直接跳过探测与启动就放行了。

**根因**：把代理状态写成了**模块级**变量：

```js
const proxyState = { started: false, process: undefined }   // 错误：全局共享
```

它在**每次激活**之间共享。一个插件会被再次激活（重载、多会话），而"我启动过哪个进程"是**那一次激活**的事实；而且停止进程的 disposer 只属于一个 fiber。

**怎么避**：凡是"这一次激活拥有的东西"（进程、句柄、缓存、订阅），都建在 `setup()` 里，由闭包带给使用者，并由该 fiber 的 `ctx.effect` 负责回收。模块级只放**只读常量**。

**谁守着**：`test/host.test.mjs` 的 "host plugin: the operator proxy" 一组 —— 特别是最后两条：一条证明"起了代理并注入环境变量"，紧接一条证明"起不来时必须拒绝并杀掉进程"。**顺序本身就是检查**：如果状态跨激活泄漏，第二条会静默放行。

---

## 19. 只读档的三个写原语：分类不等于形式

**现象**（端到端实测）：`branch <名>`、`tag <名>`、`remote add` 都属于**只读档**，于是它们在**没有任何审批**的情况下创建了引用、写入了 `.git/config`。

**根因**：允许清单按**操作名**分类，而一个操作的只读性和它的**形式**有关 —— `branch` 列出分支是只读，`branch <名>` 是创建引用。目录里只记了前者。

**怎么避**：给这类操作补"形式规则"，并按性质分成两种处理：

| 变更形式 | 碰什么 | 处理 | 理由 |
| --- | --- | --- | --- |
| `branch <名>` / `tag <名>` / `remote prune` | 引用、网络 | **写档 + 审批** | 保留能力，与其它改状态的操作走同一道闸门 |
| `remote add/remove/rename/set-url` | `.git/config` | **直接拒绝** | 与 `config` 写入同类；`set-url` 静默改变后续 push 的去向，而那次 push 的审批提示里没有 URL |

**谁守着**：`test/git-catalog.test.mjs` 的 "a read-tier operation can have a mutating FORM"（断言只读形式 `mutating=false`、变更形式 `mutating=true`、配置类动词被拒），以及 `test/host.test.mjs` 里"变更形式触发审批、列出形式不触发"两条。

**教训**：**分类（tier）与形式（form）是两个维度**。只按操作名分档，就会给"只读操作"配一个能写状态的入口。

---

## 16. 短选项不能一律拒绝：`-c` / `-C` / `-u` 的含义取决于子命令

**现象**（端到端实测时一次性暴露三条）：

```
git switch -c newbranch   → 被拒（这里的 -c 是「创建」）
git commit -C HEAD        → 被拒（这里的 -C 是「复用提交信息」）
git add -u                → 被拒（这里的 -u 是「更新已跟踪文件」）
```

**根因**：把关卡写成"凡 token 等于 `-c`/`-C`/`-u` 一律拒绝"，用来挡全局的配置注入。但**全局选项只在子命令之前才被 git 采纳** —— 用 git 2.55 实测：

| 形式 | 结果 |
| --- | --- |
| `git -c core.pager=evil status` | 真正的注入形式（在子命令**之前**） |
| `git status -c core.pager=evil` | `error: unknown switch 'c'` —— git 自己就拒了 |
| `git status -C <另一个仓库>` | `error: unknown switch 'C'` —— **不会**重定向 |
| `git status --git-dir=<另一个>/.git` | `error: unknown option` —— **不会**重定向 |

也就是说：子命令**之后**的短选项只可能是该子命令自己的旗标（或 git 自己会拒的未知项）。原来那层拒绝**既无保护作用、又误伤日常操作**。而真正危险的位置（子命令之前）已经被"第一个参数必须是目录里的子命令"这条规则封住了。

**怎么避**：

- 短选项必须**带着子命令**判断：`-u` 只对 `fetch`/`pull`/`ls-remote` 才是 `--upload-pack`（指定程序），对 `add`/`commit`/`push` 是普通旗标；
- `-c` / `-C` / `--bare` 不再出现在"子命令之后"的拒绝表里（`switch -c`、`commit -C`、`init --bare` 都是合法用法）；
- 只在**全局位置**（第一个 token）拒绝这些名字。

**谁守着**：`test/git-catalog.test.mjs` 的 "a short flag means what the SUBCOMMAND says it means" 一组断言：既断言合法用法放行，也断言全局位置仍然拒绝。

**注**：这一条和客户端 `inject` 那条是同一个教训 —— **单元测试没有覆盖真实调用方式，是端到端测试先暴露的**。修好后要把旧断言一并改掉（它们原来断言的是错误规则）。

---

## 17. `pull` 分叉时 git 给的建议正是插件拒绝的那条路

**现象**：本地与远端历史分叉时 `git pull` 失败，git 的提示是：

```
hint:   git config pull.rebase false  # merge
```

而 `git config` 的写入形式**被插件拒绝**（见第 9 条）。照提示做会再撞一次墙。

**怎么避**：改用**同等效力的旗标**，它们都在允许清单里：

```sh
git pull --rebase origin main
git pull --no-rebase origin main
git pull --ff-only origin main
```

**这也说明插件的一个取舍**：把配置写入收成只读，代价是"git 让你改配置"这类提示不再可直接执行，必须换成命令行旗标。遇到这种情况，先看该操作有没有对应旗标，而不是去改配置。

---

## 18. 没有凭据时远程写操作失败，是**设计**而非 bug

**现象**：

```
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

**根因**：插件无条件隐藏 `~/.gitconfig` 与系统配置，并清空 `credential.helper`。因此 git 拿不到 `store` 这类凭据助手，也无法交互式索要用户名。

**这是刻意的**：本插件的承诺是"自己不读取、不传递、不存储凭据"。远程认证应由**外部代理**完成（在 DSH 进程环境里设 `HTTPS_PROXY=…`，git 会继承，因为 `scrubbedParentEnv()` 保留代理变量）。

**判据**：只读的远程操作（`ls-remote`、`fetch`、`clone` 公开仓库）**正常**；写操作（`push`）失败在"读不到用户名"。这说明凭据通道被隔离生效了，而不是网络或插件坏了。

---

## 21. 盲替换改错调用点 → 闸门静默失效

**现象**：审计**不再运行**。测试报 `the audit must run`、以及四条"危险键必须拒绝"变成 `Missing expected rejection`。

**根因**：我给 git 子进程的环境加参数时，用同一段文本去做替换：

```js
env: buildEnv(),
```

这段文本在文件里有**两处** —— 一处是运行 git 的地方（该带设置），另一处是**审计**内部。而审计函数的参数 `policy` 是**危险键策略字符串**，不是设置对象，于是 `policy.current.useHostCredentials` 抛 `TypeError`，被审计自己的 `catch` 当成"这个目录没有配置可读"吞掉 → 返回 `null` → **一切放行**。

**两个教训**：

1. **替换必须有唯一锚点。** 用一行在文件里可能出现多次的短文本做定点修改，等于在赌；要带上足以唯一的上下文，改完立刻回读确认。
2. **`catch` 会把"我的编码错误"伪装成"正常情况"。** 审计的 fail-open 是对的（shell 不可用、非仓库目录），但它**分不清**"读不到配置"和"我自己抛错了"。现在参数类型在 `try` **之外**先校验，类型不对直接抛 —— 那是本文件的 bug，不该被吞。

**谁守着**：`test/host.test.mjs` 的 `host plugin: the repository-config audit` 六条 —— 它们**正是**这次报出问题的那组。这也说明"闸门类"测试必须断言**拒绝发生了**，而不只是断言命令跑通了。

---

## 22. `String.replace` 会解释替换文本里的 `$`

**现象**：改一个文件时，整个文件被拼接错乱 —— 插入点后面出现了文件**开头**的内容，语法直接报错。

**根因**：用字符串做替换时，替换文本里的 `$&`、`` $` ``、`$'`、`$1` 都是**特殊模式**（"匹配之前的全部内容"、"匹配之后的全部内容"、捕获组）。我的插入文本是正则的字符类，里面有 `$` 紧跟引号 —— 于是 `$'` 把**文件剩余部分**插了进来。

**怎么避**：替换文本里可能有 `$` 时，**用替换函数**：

```js
s.replace(anchor, () => inserted)   // 逐字插入，不做任何解释
```

**谁守着**：没有自动守卫 —— 这是纪律问题。改完**必须回读或 `node --check`**。

---

## 23. "末尾统一落盘"的脚本，中途失败会丢掉全部改动

**现象**：脚本报告前几步 `ok`，然后因某个锚点缺失而退出 —— 结果**前面那些"成功"的步骤一个都没生效**。我因此三次丢失改动（导入丢了、设置项丢了、函数丢了），并因为"报错说前几步 ok"而误判文件状态。

**根因**：脚本把 `let s` 在内存里依次替换，最后才 `writeFileSync`。中途 `process.exit(1)` → 内存里的改动全部丢弃。

**怎么避**：**每步立即落盘**（每步 `read → replace → write`），让失败点之前的改动保持有效；锚点缺失时明确报出是哪一步。

**代价与配套**：立即落盘意味着失败后文件是"部分应用"状态。所以配套要求是：**每步的锚点必须唯一**，失败后先 `git diff` 看清楚再继续（`git checkout --` 可回到干净基线）。

---

## 24. 同 uid 下：环境变量与 fd 可读，内存不可读

给"凭据只放在内存里"这种设计判死刑的一组实测（同一 uid，非父子进程）：

| 通道 | 可读？ |
| --- | --- |
| `/proc/<pid>/environ` | **可读** —— 所以"用环境变量把令牌递给 git"会泄漏 |
| `/proc/<pid>/fd/<n>`（别人打开的 fd） | **可读** —— 所以"用继承的管道/文件描述符递令牌"也会泄漏 |
| `/proc/<pid>/mem` | 不可读（Yama `ptrace_scope=1` 之类拦下了） |

**结论**：本机上，只要凭据要交给另一个进程，那个交接通道就是同 uid 可读的。**唯一**能给出硬保证的是"沙箱内根本看不到该文件"（挂载遮蔽），而那属于 dsh 沙箱的职责。

**为什么记下来**：这条把一大类看起来聪明的方案一次排除掉（内存保管、环境变量注入、fd 传递、socket 拉取），省得重新推演一遍。

---

## 25. `ctx.tools.guard` 动态插件够不到，`tools/pre-execute` 可以

**现象**：按 Inspect 目录写的 `ctx.tools.guard(fn)` 在动态插件里报 `is not a function`。

**根因**：**动态插件拿到的是受限服务表面**。实测 `Object.keys(ctx.tools)` 只有 `register, schemas, get`；`guard`、`restrict`、`presentAs`、`executionMode`、`execute` 全都不在。

**怎么避**：用 `tools/pre-execute` —— 它是**事件**（waterfall），`ctx.on` 就能监听，决定类型是：

```ts
{ kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
```

**两个必须记住的限制**：

1. **工具管道只能放行/拒绝/询问，不能改写参数** —— 所以"拦截 bash 里的 git 然后路由到插件"在工具层做不到。
2. **守卫的错误会被自己吞掉**：一个抛错的守卫如果继续抛，会掐断会话里的**每一次**工具调用，所以必须 `try/catch` 后 `next()`。代价是**坏掉的守卫看起来和平庸的守卫一样** —— 因此单元测试要**直接驱动这个监听器**（实测中就是它抓出了"函数没落盘、守卫抛 ReferenceError 却静默放行"）。

---

