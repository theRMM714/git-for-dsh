# git-for-dsh 适配 DSH 0.1.7-rc.2 · 实施计划

> **本文件是阶段性工作账本，不是长期文档。** 全部阶段销账后应删除；长期状态由 README / DESIGN / PITFALLS 承载，历史由 git 承载。

当前 DSH：`0.1.7-rc.2`
当前状态：插件在 0.1.7-rc.2 上**激活即抛错**（`settings.register is not a function`），`git_exec` 完全不可用，客户端条目永久 `pending`。
本文档的做法与验收标准沿用 `llm-for-dsh/llm-updata.md` 已验证过的那一套。

---

## 一、目标与验收标准

**目标**：去掉 `DSH_GIT_TOOL_DISABLED` 后，插件能激活、`git_exec` 可用、设置页可交互、改动即时生效。

| # | 验收项 | 判据 |
| --- | --- | --- |
| V1 | web boot 无未激活条目 | 页面不再出现 `Failed to load plugins / waiting for service` |
| V2 | `git_exec` 可用 | 模型能调用它并拿到真实 git 结果（本地读 + 一次远端操作） |
| V3 | 设置页出现且可交互 | 「Git 工具」页渲染档位、允许清单、路径保护、代理、日志等控件 |
| V4 | 改动即时生效 | 勾选/取消下一次工具调用即生效，无需重启 |
| V5 | 配置持久化 | 重启 DSH 后设置保留（经 profile 的 Cordis patch） |
| V6 | 4 条同源路由可用 | `proxy-check` / `config-check` / `ssh-check` / `log` 均返回 200 |
| V7 | 构建与测试 | `scripts/build.mjs --check` 通过；测试全绿 |

---

## 二、根因（实证）

### 1. 与 llm-for-dsh 同源：设置模型换了

```
git-tool: activation failed ... Cause: TypeError: settings.register is not a function
    at bindPolicy (git-for-dsh/lib/index.js:517:26)
```

`dsh-settings` 的方法集已变为 `configure / invalidate / prepareDocument / describe / update / replace / mutate / write / schema`，**`register` 不复存在**。客户端侧的 `settingsScope` 在全部约 290 个包里**零命中**。

### 2. git-for-dsh 独有：条目标识对不上

新模型**按 profile 条目 id 寻址**：`describe()` 返回的描述符里 `ns === entry.options.id`（`dsh-settings/lib/index.js:432,443`），文档也写明「Forms keyed by unique profile entry ids」。

而本插件：

| 位置 | 当前值 | 应为 |
| --- | --- | --- |
| `cordis.patch.yml` 行 id | `tool-git` | （事实来源） |
| `src/index.js:88` `NAMESPACE` | `git-tool` | `tool-git` |
| `src/client.js:263` `NAMESPACE` | `git-tool` | `tool-git` |

**不对齐就永远找不到自己的表单。** 这是 llm-for-dsh 没有的问题。

### 3. git-for-dsh 独有的第二个坑：4 条 web 路由被静默跳过

`src/index.js:1546` 用 `ctx.get('webServer')` 取服务；激活早于该服务注册时拿到 `undefined`，于是 `1548 / 1578 / 1653 / 1680` 四条路由**一条都没注册**，且不报错。与 llm-for-dsh 已修的 E1 同一缺陷。

### 4. 开发环境的 dsh 落后两个版本 —— 这才是开发期看不出问题的原因

本插件的 `node_modules/@deepseek-ai/*` 全是指向 **WSL** 安装的符号链接：

```
cordis -> /home/admin/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis
```

而 WSL 里的 dsh 是 **`0.1.5-rc.1`**，其实测结果是 `volatile=undefined`（**没有 `.volatile()`**）；部署端（Windows）已经是 **`0.1.7-rc.2`**。

于是：**代码按旧设置模型写、按旧模型测，部署环境却已经换成新模型**。这是"本地一切正常、升上去就崩"的直接原因，也是本计划必须先把两侧版本对齐的理由。

### 5. 测试套件是 POSIX-only

在 Windows 上跑会假失败：`sits beside the harness state, not on a Windows drive`、`^/usr/bin/ssh -o BatchMode=yes` 等断言写死了 POSIX。**测试必须在 WSL 里跑。**

---

## 三、新契约参考（实现依据）

| 用途 | 新写法 | 样板 |
| --- | --- | --- |
| 可编辑字段 | `z.boolean().default(false).volatile()` | `dsh-agent-default-model/lib/index.js:21-25` |
| 实时读值 | `config.<field>.get()` | 同上 `:39-43` |
| 宿主写入 | `ctx.get('configEditor').edit(ctx.fiber.entry, change)`（`change(current, inherited) => next`） | `dsh-config-editor/lib/index.js:58-63` |
| 关掉自动表单 | `ctx.inject(['settings'], c => c.effect(() => c.settings.configure({ auto: false }, ctx.fiber)))` | `dsh-client-ui-conversation/lib/index.js:23-25` |
| 读描述符（旧 `describe` 兼容） | `ctx.settings.describe()` 仍返回**数组**，元素含 `ns / value / base / user / revision / autoGenerate` | `dsh-settings/lib/index.js:413-463` |
| 客户端取表单 | `ctx.configForms.get('<条目id>')` | `dsh-client-ui-settings/lib/client.js:1305-1316` |
| 按宿主服务注册 | `ctx.configForms.whileServed(['<条目id>'], register)` | 同上 `:1317-1349` |
| 可选 webServer 子作用域 | `ctx.inject(['webServer'], webCtx => webCtx.effect(() => webCtx.webServer.register(route)))` | `dsh-client-connection/lib/index.js:820-843` |

**好消息**：旧 `settings.describe()` 的返回形状（数组 + `.ns` + `.user`）在新模型里**仍然成立**，`retiredKeys` 只需改 id 比较。

---

## 四、范围

**改**
- `src/index.js` — 设置层、条目标识、4 条路由
- `src/client.js` — 设置页绑定层（**不动 UI 结构与样式**）
- `cordis.patch.yml` — 仅在需要时
- 测试、`README.md` / `DESIGN.md` / `PITFALLS.md`

**不改**
- git 的闸门逻辑：允许清单、参数闸门、配置审计、脚本检查、路径保护三组
- `src/proxy.js`、`src/log.js`、`src/git-catalog.js` 的判定逻辑（`composeCommand` 的方言机制**本阶段不动**，见 §七 G12）
- 执行路径：继续走 `ctx.shell`（已评估过「不用 shell」的方案，本次不做，理由见 §八）

**设计决定（关键，直接影响工作量）**

新模型**没有 `scope.watch`**，配置变更只能按需读。而 `policy.current` 在 `src/index.js` 里有 **35 处引用**（33 处读取）。为了不让 33 个读取点全部改写，`state` 上的 `current` 改为 **getter + 按快照身份记忆化**：

```js
let cachedRaw, cachedPolicy
const readPolicy = () => {
  const raw = readConfig(config)          // 每个成员 .get()
  if (raw.enabled !== cachedRaw?.enabled || /* …逐字段比较，或直接比引用 */) { … }
  return cachedPolicy
}
```

即：`policy.current` 保持**属性读法**不变，内部只有当某个引用的快照换了对象时才重新 `normalizePolicy`。这样热路径（守卫每次工具调用）不会退化成每次都全量归一化。

---

## 五、阶段划分与销账规则

| 阶段 | 内容 | 产物 | 状态 |
| --- | --- | --- | --- |
| 0 | 基线与准备 | 基线记录、本文件 | ☐ |
| 1 | 宿主半适配 | 设置层 + 条目标识 + 4 条路由 | ✔ 已完成 |
| 2 | 客户端半迁移 | `configForms` 绑定 | ✔ 已完成 |
| 3 | 真机验收 | V1–V7 实测 | ☐ |
| 4 | 缺陷审计与清理 | §七 的 G 组 | ☐ |
| 5 | 文档同步与销账 | 三份文档定稿、删除本文件 | ☐ |

**销账规则**（同 llm-for-dsh）
1. 每阶段结束更新本表并在 §七 标记对应条目。
2. 先测试后销账：`build --check` + 测试通过，否则不得标记完成。
3. 实测证据追加到「证据」小节，不写进长期文档。
4. 新发现的问题登记到 §七 的 G 组末尾，另行排期，不混入当前阶段。
5. 阶段 4 每条必须有结论（已修 / 不改并说明理由 / 转为长期项）。

---

## 六、阶段任务

### 阶段 0 · 基线与准备

- [ ] 记录基线：激活报错原文、4 条路由 404、条目标识不一致
- [ ] 确认新契约（已完成，见 §三）
- [ ] 确认客户端半的 `settingsScope` 用法（已完成：`src/client.js:251` 声明、`:500-504` 绑定）

**基线数据**
- 宿主激活报错：`TypeError: settings.register is not a function`（`bindPolicy`，`src/index.js:517`）
- 客户端：`inject = ['slots','settingsScope']`，条目永久 pending
- 条目标识：行 id `tool-git` ≠ 代码常量 `git-tool`
- 路由常量：`/git-tool/proxy-check` `:756`、`/git-tool/config-check` `:779`、`/git-tool/ssh-check` `:782`、`/git-tool/log` `:963`
- **WSL 环境**：发行版 `archlinux`（默认）、用户 `admin`、node `v24.20.0`（nvm；非登录 shell 需显式补 PATH）
- **WSL 的 dsh：`0.1.5-rc.1`（落后）**，schemastery 无 `.volatile()`
- WSL 侧实测：137 项中 136 通过，唯一失败是 `TypeError: field.volatile is not a function`——由 WSL dsh 过旧所致
- Windows 侧实测：9 项失败，其中 8 项是 POSIX 断言假失败、1 项是坏链接导致的 `ERR_MODULE_NOT_FOUND`

### 阶段 1 · 宿主半

> **前置条件（需授权）**：把 WSL 的 dsh 从 `0.1.5-rc.1` 升到 `0.1.7-rc.2`。否则 `.volatile()` 不存在，改完的代码在开发环境里跑不起来，测试也无从验证。

- [x] **升级 WSL 的 dsh 到 0.1.7-rc.2**（已完成，见 G17）
- [x] `NAMESPACE` 由 `git-tool` 改为 `tool-git`（与行 id 对齐）
- [x] `name` 导出与行 id 对齐
- [x] `Config` 全部 19 个字段**统一**标 `.volatile()`（用一处包装，杜绝"加字段忘标记"）
- [x] 新增 `readConfig` / `sameConfig`
- [x] `state.current` 改为 getter + 按引用身份记忆化 → **33 个读取点一行未改**
- [x] 删除 `settings.register` / `scope.get()` / `scope.watch()` / `settings.update()`
- [x] `state.update` / `state.resetSection` 改走 `configEditor.edit(entry, change)`
- [x] `retiredKeys` 沿用 `describe()`（新形状兼容），id 随 `NAMESPACE` 修正
- [x] `inject` 移除 `settings`（改为可选子作用域），无设置服务仍激活
- [x] 4 条路由改用 `ctx.inject(['webServer'], …)`，标签同步为 `tool-git: …`
- [x] 测试同步 + 构建 + 全绿 → **225/225 通过（在 WSL 内）**，`build --check` 通过

**阶段 1 证据**
- WSL 的 dsh 由 `0.1.5-rc.1` 升到 `0.1.7-rc.2`，`volatile=function` 可用
- 夹具改造：假 `settings` 由 `register/scope/watch` 改为 `configure/describe`；配置改为**闭包引用**（`setSettings` 只需重新赋值）；补 `ctx.inject`（settings + webServer 两个子作用域）与 `ctx.fiber`
- 8 条平台相关断言在 Windows 上会假失败 → **本仓库的测试必须在 WSL 里跑**（已记入 §十）

### 阶段 2 · 客户端半

- [x] `inject` 改为 `['slots','configForms']`；`NAMESPACE` 改为 `tool-git`
- [x] 绑定改为 `ctx.configForms.get(NAMESPACE)`，注册包进 `whileServed([NAMESPACE], publish)`
- [x] `inertScope` 保留为降级分支，原因文案改为 `configForms`
- [x] **J1**：抽出 `fallbackSection()`，两个分支改为「先铺 fallback 再覆盖」，`guardErrorPolicy` 补进 fallback **与**校验分支
- [x] **J2/J15**：`build.mjs` 的 `defaults` 补 `guardErrorPolicy`，并新增**防漂移测试**（`Config` 每个字段都必须有嵌入默认值）
- [x] **J3**：`verify-served-bundle.mjs` 的 `inject` 断言、裸读清单、假 service、场景列表与断言全部迁移
- [x] **J4**：客户端 `NAMESPACE` 与 slot id 统一为 `tool-git`
- [x] **J6**：`segmented` 的四个 tier 键对齐宿主的 `tierIds` 键（`guardError/nativeGit/scriptCheck/config`）
- [x] **J7/J8**：删除死表 `GUARD_COPY`/`PATH_COPY`；取消未被引用的 `exports.message`/`exports.inertScope`，改为导出 `decodeSection` 供测试
- [x] `test/client.test.mjs` 同步；`decodeSection` 的用例改为直接调用导出
- [x] 构建 + 测试全绿 → **226/226（WSL 内）**，`build --check` 通过，**verify 26/26 通过**

**未做（留阶段 4）**
- 路由路径改名（`/git-tool/*` → `/tool-git/*`）需客户端与宿主同改，另行决定（J5）
- UI 结构与样式一行未动（符合既定约定）

**阶段 2 证据**
- `verify-served-bundle.mjs`：26/26 检查通过（含 `declares slots and configForms`、`requests the tool-git form`）
- 防漂移测试**当场抓到一处真实不一致**（`pathRules` 在嵌入目录里叫 `protectionRows`）——确认为**有意的投影**后在测试里写明映射，而不是掩盖
- 客户端不再出现 `settingsScope`

### 阶段 3 · 真机验收

- [ ] 移除 `DSH_GIT_TOOL_DISABLED`，重启 `dsh web`
- [ ] V1 `web boot` 无未激活条目
- [ ] V2 `git_exec` 可调用（一次本地读 + 一次远端操作）
- [ ] V3 设置页出现且可交互
- [ ] V4 改动即时生效
- [ ] V5 重启后保留
- [ ] V6 4 条路由均 200

**证据**：（阶段 3 完成后填写）

### 阶段 4 · 缺陷审计与清理

- [ ] **全面审计**：README / DESIGN / PITFALLS 与代码不符处、死代码、仓库卫生（本插件根目录暂无 `.tmp-*`）
- [ ] 处理 §七 G12（Windows 理由的口径）
- [ ] 逐条销账

### 阶段 5 · 文档同步与销账

- [ ] README「安装 / 使用 / 为什么需要它 / 已知限制」按新模型与新 id 重写
- [ ] DESIGN 补入 0.1.7-rc.2 的契约核对结论；「决策：不做 Git Bash」一节补上本次复评结论
- [ ] PITFALLS 校准
- [ ] 全部阶段销账后删除本文件

---

## 七、缺陷清单

状态：`待处理` / `进行中` / `已修` / `不改（附理由）`

### G 组 · 适配相关（本计划主线）

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| G1 | `src/index.js:517` | `settings.register` 已不存在，宿主半激活即抛错（`bindPolicy`） | 待处理 |
| G2 | `src/index.js:519-526` | `scope.get()` / `scope.watch()` 已不存在；新模型无 watch，需改为按需读 | 待处理 |
| G3 | `src/index.js:527` | `settings.update(NAMESPACE, patch)` 已不存在，改走 `configEditor.edit` | 待处理 |
| G4 | `src/index.js:534` | `settings.replace(NAMESPACE, {})` 已不存在（重置功能） | 待处理 |
| G5 | `src/index.js:88`、`src/client.js:263` | 常量 `git-tool` 与行 id `tool-git` 不一致，新模型按条目 id 寻址 | 待处理 |
| G6 | `src/client.js:251` | `inject` 依赖已消失的 `settingsScope`，页面永久 pending | 待处理 |
| G7 | `src/client.js:500-504` | `settingsScope.bind({namespace, decode})` 绑定方式已不存在 | 待处理 |
| G8 | `src/index.js:1546,1578,1653,1680` | `ctx.get('webServer')` 在服务未就绪时拿到 undefined，**4 条路由全部静默跳过** | 待处理 |
| G9 | `src/index.js:85` | `inject` 中的 `settings` 需按新模型复核（保留？） | 待处理 |

### H 组 · 需在阶段 4 审计确认

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| G12 | `README.md`「在 Windows 上还有一条更硬的理由」 | 把不可用归因于「交互式 bash 工具起不来」，而实测真正的阻塞是**沙箱内 git 的远端操作被命名管道限制拒绝**（`cannot create standard input pipe for remote-https`）。理由需按实测改口径 | 待处理 |
| G13 | 全仓 | 阶段 4 的全面缺陷审计（文档与代码不符、死代码、仓库卫生） | 待处理 |
| G17 | 开发环境 | WSL 的 dsh 是 `0.1.5-rc.1`，其 schemastery **无 `.volatile()`**；部署端 0.1.7-rc.2。**开发/部署版本落差是本次故障没被发现的直接原因** | ✔ 已升级到 `0.1.7-rc.2` |
| G18 | `src/index.js` | 日志与部分提示仍用 `git-tool` 前缀，路由路径也仍是 `/git-tool/*`。标识已统一为 `tool-git`，日志标签与路由路径是否跟随需单独决定（路由改名要同步客户端） | 待处理 |
| G19 | `src/index.js:150-169, 293-299` | 三处**孤立注释块**（描述已不存在的字段）；另 `proxyPort` 的注释与其字段之间被 `useHostCredentials` 的注释隔开 | 待处理 |

### I 组 · 本次明确不做（附理由）

| # | 事项 | 理由 |
| --- | --- | --- |
| G14 | 「检测 + 勾选 → 改走 Git Bash」 | 见 §八：收益未测量、解析层由 1 变 2、MSYS 会改参数、`where bash` 在装了 WSL 的机器上会拿到 WSL 的 bash。DESIGN.md:156-173 已否决过同一提案 |
| G15 | 「不用 shell」：`ctx.subprocess` + argv | **方向正确但不做**（使用者确认当前无具体失败案例）。DESIGN.md:173 已把它记为将来的正确方向；`ctx.subprocess` 的 `argv` 明确标注 `Never shell-interpreted here`，且 `dsh-base` 已挂载该服务 |

### J 组 · 代码审计发现（`src/client.js` / `scripts` / `tests`，只读审计，已逐条复核）

| # | 位置 | 问题 | 严重度 | 归属阶段 |
| --- | --- | --- | --- | --- |
| J1 | `src/client.js` `decodeSection` | 两分支都漏 `guardErrorPolicy`，而渲染处会读它 → 存过 `allow` 的 profile 刷新后显示 `ask`。已抽 `fallbackSection()` 并补校验分支，测试改为回归守护 | 高 | ✔ 已修（阶段 2） |
| J2 | `scripts/build.mjs` `serializeCatalog` | 嵌入浏览器的 `defaults` 手工重述宿主默认值，已与 schema 漂移（缺 `guardErrorPolicy`） | 高 | ✔ 已修（阶段 2） |
| J3 | `scripts/verify-served-bundle.mjs` | 断言 `inject` 含 `settingsScope`，阶段 2 改完必然失败。已迁移断言、裸读清单、假 service 与全部场景 | 高 | ✔ 已修（阶段 2） |
| J4 | `src/client.js` | 客户端 `NAMESPACE` 与 slot id 仍用 `'git-tool'` | 高 | ✔ 已修（阶段 2） |
| J5 | `client.js:545,567,588` vs `index.js:839,862,865,1046` | 4 条路由路径客户端**硬编码**、宿主另有常量、测试再硬编码一遍（**三份**） | 中 | 阶段 4 |
| J6 | `client.js` `segmented` 调用 | 四个 tier 键用了字段名而非宿主的 `tierIds` 键，分段顺序退回客户端副本 | 中 | ✔ 已修（阶段 2） |
| J7 | `client.js` | `GUARD_COPY`、`PATH_COPY` 无任何读取点 | 低 | ✔ 已删（阶段 2） |
| J8 | `client.js` 导出块 | `exports.message` / `exports.inertScope` 无外部调用方。已取消导出，改为导出测试所需的 `decodeSection` | 低 | ✔ 已修（阶段 2） |
| J9 | `client.js:382,415` | `scanScripts` 被解码但页面从不渲染/写入 | 低 | 仅记录 |
| J10 | `client.js:669-699` | config-check 两条请求用 `response.json()` 并吞掉真实错误（统一报「无法连接宿主」），与 `classifyJsonResponse` 的其余用法不一致 | 中 | 阶段 4 |
| J11 | `client.js:1159,1165` vs `index.js:855,858,889-892` | Windows ssh 路径知识**写三份** | 中 | 阶段 4 |
| J12 | `client.js:637-642` | `writePolicy` 的文档注释孤立在 `addPendingPath` 上方 | 低 | 阶段 4 |
| J13 | `scripts/render-preview.mjs:28-37` | React 桩缺 `useMemo`，而 `client.js:623-628` 会调用 → **预览校验已失效** | 中 | 阶段 4 |
| J14 | `test/client.test.mjs:95,164,201,209-214` | 未使用的桩与 recorder 字段；`styles`/`react/jsx-runtime` 从不被 require | 低 | 阶段 4 |
| J15 | `scripts/build.mjs` | 嵌入的 catalog/defaults 与宿主 schema 无漂移测试。已新增：`Config` 每个字段都必须有嵌入默认值（写明 `pathRules → protectionRows` 这处有意投影） | 高 | ✔ 已修（阶段 2） |
| **J16** | `client.js` `segmented` | **阶段 2 自己引入的回归**：同一个 `field` 参数既当宿主 tier 键（`tiersFor`）又当配置字段名（`writePolicy`）。J6 把四处改成宿主键后，点击**写到了 Host 不存在的字段**上被拒绝，四个分段控件**静默失效**（使用者截图反馈）。已拆成 `segmented(field, tierKey, copy, current)`，并新增「每个分段控件写入的字段都必须被 Host 声明」的测试 | **高** | ✔ 已修（阶段 2 补正） |

> 宿主半（`src/index.js`、`src/git-catalog.js`）的独立审计已完成，发现见下方 K 组。
### K 组 · 代码审计发现（`src/index.js` / `src/git-catalog.js`，只读审计，已逐条复核）

| # | 位置 | 问题 | 严重度 | 归属阶段 |
| --- | --- | --- | --- | --- |
| K1 | `index.js` 守卫 catch | `guardFailureVerdict(current.…)` 里 `current` 未定义。守卫抛错时 catch 自身再抛 `ReferenceError` 逃出监听器——正是该处注释声称要避免的"拖垮每次调用"。已改 `policy.current`，并新增**驱动监听器**的用例（反向验证：把 bug 放回去，该用例即以 `ReferenceError: current is not defined` 失败） | **高** | ✔ 已修（阶段 4） |
| K2 | `index.js` 基名提取 | 用 `split('/')` 取基名，而 `absoluteProtectedPath` 返回**原生平台路径**（Windows 为反斜杠）→ Windows 上基名恒等于整条路径、`protectedNames` 恒不命中，`realpathSync` 的符号链接回退**永不执行**（凭据文件漏判）。已抽出 `git-catalog.lastPathSegment`（按 `/[\\/]+/` 切分）并在三处使用，配跨分隔符单测 | **高** | ✔ 已修（阶段 4） |
| K3 | `index.js:2348` | 整行 re-export 无任何导入者（各测试都直接 import `git-catalog.js`） | 低 | 阶段 4 |
| K4 | `git-catalog.js:1067-1071` | `if`/`else` 两分支返回同一表达式 | 低 | 阶段 4 |
| K5 | `git-catalog.js:426` | `FORBIDDEN_DASH_C` 只在注释里被引用，真正拦截在 `FORBIDDEN_GLOBAL:395` 与 `FORBIDDEN_GLOBAL_PREFIXES:414` | 低 | 阶段 4 |
| K6 | `index.js:47, 37` | `DEFAULT_PROTECTION_ROWS` / `GUARD_POLICIES` 导入后未作值使用 | 低 | 阶段 4 |
| K7 | `git-catalog.js:709` | `refuseMutation: true` 全仓无读取 | 低 | 阶段 4 |
| K8 | `index.js:1343` | `typeof text === 'string'` 恒真（1336 已保证） | 低 | 阶段 4 |
| K9 | `index.js:1343` 区、`git-catalog.js:154-155` | `scanScripts` 旧布尔/迁移/日志字段与第二个 read 分组的 title/hint 已无渲染点 | 低 | 阶段 4（**需先判定是否有意保留**：PITFALLS 35 记录了迁移语义） |
| K10 | `index.js:621-630, 660-664, 679-688, 733-737, 999-1003, 1096-1116, 1406-1416, 1610-1616, 1720-1723`；`git-catalog.js:479-484, 515-520, 1011-1020` | **无后继声明的孤儿 JSDoc**（与 G19 同源） | 中 | 阶段 4 |
| K11 | `git-catalog.js` / `index.js` | 零外部引用的导出：`isCredentialUrl` / `RISK_ORDER` / `FORBIDDEN_GLOBAL` / `BASE_ENV` / `SCAN_BUDGET` / `unboundedSteps`；`shellQuote` 与 `applyUnguarded` 仅测试引用 | 低 | 阶段 4（降内部 / 仅记录） |
| K12 | `git-catalog.js:1110` vs `1123` | 同一"git 词"判定写两份，切分 `/[\\/]/` 与 `'/'` 不一致 | 中 | 阶段 4 |
| K13 | `git-catalog.js:654-664` | `operands > maxOperands` 判两遍 | 低 | 阶段 4 |
| K14 | `index.js:1087` vs `1219`（及 `:1373,1375`） | `~/` 展开 + `resolvePath` 重复实现；循环内重复 `operands.join(' ')` | 低 | 阶段 4 |
| K15 | `git-catalog.js:1451` | `refuse()` 返回的 `affects` 无消费者 | 低 | 阶段 4 |
| K16 | `git-catalog.js:1202, 1459` | 注释与签名不符：`@param before` 实为 `(command, at)`；`shellQuote` 写 `/bin/sh` 却有 pwsh 方言 | 低 | 阶段 4 |

**审计结论（两份报告共同确认）**
- **未发现 import 环**：`index → {git-catalog, proxy, log}`；`client.js` 只在运行时 `require` 页面模块。
- **未发现跨模块可变全局**：cache 与 proxy 每次激活新建。
- 最主要的耦合问题是**同一知识写多份**：设置命名空间（G5/J4）、4 条路由路径（J5/K-耦合2）、Windows ssh 路径（J11）、`--config-env`/`-c` 字面量（K-耦合4）。


---

## 八、风险与对策

| 风险 | 对策 |
| --- | --- |
| `policy.current` 33 个读取点 | 用 getter + 快照身份记忆化，读取点不改写；只改 2 个赋值点 |
| 记忆化失效导致守卫读到旧策略 | 记忆化键必须是**引用快照的身份**，不是时间；`.get()` 在值未变时返回同一对象 |
| `resetSection` 在新模型无法表达 | 先查 `configEditor.edit(entry, () => ({}))` 是否等价；不等价就让路由如实报告「不支持」，不假装可用 |
| 条目标识改名影响已存配置 | 旧 `settings.yaml` 的 `git-tool` 分节由 DSH 的 `settings.yaml.imported` 机制接管；README 说明 |
| 4 条路由的路径含 `/git-tool/` | 路由路径与设置条目 id 无耦合；**是否改名另行决定**（改动涉及客户端同步），本阶段只修「注册不上」 |
| 客户端半约 3000 行 | 只换绑定层，UI 与样式不动，与 llm-for-dsh 同一手法 |
| **开发/部署 dsh 版本落差** | 本插件在 WSL 开发（`0.1.5-rc.1`）、在 Windows 部署（`0.1.7-rc.2`）。**必须先把 WSL 升到同一版本**，否则改完无法验证。长期应把两侧版本对齐纳入常规 |

---

## 九、提交切分

1. `feat: 宿主半适配 0.1.7-rc.2 设置模型与条目 id`（阶段 1）
2. `feat: 客户端设置页迁移到 configForms`（阶段 2）
3. `chore: 缺陷审计与清理`（阶段 4，可再拆）

推送仅在需要真机验证时进行；其余只做本地提交。

---

## 十、流程约定

1. 每阶段结束：`node scripts/build.mjs` → `--check` → 测试 → 更新本文件 → 本地提交。
2. 测试若受沙箱影响（`mkdtemp` 被拒），把 `TEMP`/`TMP` 指向工作区目录——`llm-for-dsh` 上已验证过的做法。
3. 阶段 3 需移除环境变量并重启 DSH，属真机操作，由使用者执行或明确授权。
4. 不擅自扩大范围：执行路径改造（G14/G15）不在本计划内；UI 结构不动。
5. 本文件在阶段 5 结束后删除，不进入长期文档集。
