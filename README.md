# git-for-dsh

## 免责声明：这是个人测试用的项目，使用这个项目出现任何问题，作者不负任何责任，如果同意再进行使用。

一个 DeepSeek Harness 插件：让 AI 能在**文件沙箱之外**执行 git 命令，同时由用户自己勾选「允许哪些 git 子命令」。

插件由两半组成，装一次即可：

- **Host 半**（`src/index.js`）注册模型可见的工具 `git_exec`，并实现四道闸门：用户的允许清单、参数闸门、配置写入闸门，以及执行环境硬化。
- **Client 半**（`src/client.js`）在「设置 → Git 工具」里渲染勾选页，用户在这里决定放行哪些子命令。

## 为什么需要它

为了更精准、安全地控制 AI 使用 git 指令的边界。

具体做法是**显式地不设沙箱**，改用**允许清单**作为安全边界：只有用户勾选过的子命令能启动进程，且参数必须通过参数闸门。

### 在 Windows 上还有一条更硬的理由

dsh 自带的交互式 bash 工具在 Windows 上基本起不来，报错通常是 `PTY shell exited during startup` 或 `terminal inspection is unsupported on platform win32`。原因有三层，都在 dsh 代码里可以查到：

- **进程检查器只实现到 Linux/macOS** —— 报错原文就在 `dsh-subprocess-local` 里；
- **交互式终端依赖 PTY** —— 报错原文在 `dsh-terminal-bash` 里；
- **Windows 的 ACL 沙箱以受限令牌隔离进程** —— `dsh-sandbox-windows-acl` 通过 FFI 直接调用 `createRestrictedToken`（带 restricting SID），而 MSYS 运行时需要创建共享内存映射，这类操作会被受限令牌拒绝。

**本插件的 `git_exec` 不走那条路**，因此不受这些限制：

- 它把命令交给 dsh 的 `ctx.shell` 执行**一次性命令**（`ctx.shell` 每个 host 只有一个实现；在 Windows 上由 win32 层换成 **pwsh** 那套，在 Linux/macOS 上是 bash 那套），**不使用交互式 PTY，也不依赖终端检查器**；
- 它以 `danger-full-access` 在沙箱**之外**运行 git，因此也不进入受限令牌沙箱。

换句话说，在 Windows 上它并不"绕道 Git Bash" —— 它走的是一条不撞上这些坑的路径，这一点可以通过本工具在 Windows 上正常推送/读取仓库直接验证。

**一条已知的细节**：命令要经过 host 的 shell 解析（Linux/macOS 上是 bash 那套，Windows 上是 pwsh 那套），因此参数**一律用单引号包裹** —— 这是两种 shell 的共同安全区（单引号内 `$`、反引号、反斜杠都不展开）。仅"参数里本身含单引号"时转义写法不同，插件按平台选择；含逗号的参数也会加引号，因为 PowerShell 会把裸逗号当成数组分隔符。

## 安装

本包装有**自带的补丁层**（`dsh.bundle.patch`）：装包即挂载，**不需要手改任何配置文件**。

```sh
# 从 npm（发布后）
dsh plugin --profile <profile> add git-for-dsh

# 或直接从 GitHub（构建产物 lib/ 已入库，因此不需要构建脚本，也就不需要 allowBuilds 放行）
dsh plugin --profile <profile> add github:theRMM714/git-for-dsh

# 或本地路径（开发时最省事：link 是符号链接，改完即生效）
dsh plugin --profile <profile> add /path/to/git-for-dsh
```

**更新**同为一条命令：

```sh
dsh plugin --profile <profile> update git-for-dsh
```

> 从 GitHub 安装/更新时，shell 里要能访问 github.com。若网络需要代理，先 `export HTTPS_PROXY=http://127.0.0.1:<端口>`。

安装做的事（`dsh plugin` 的职责）：pnpm 装包 → 把包加进 profile 的依赖 → **把声明了 `dsh.bundle` 的依赖并入 `dsh.profile.bundles` 层栈**。装载的行来自本包自带的 `cordis.patch.yml`：

```yaml
- insert:
    # The development brake: with DSH_GIT_TOOL_DISABLED=1 the row does not load …
    - id: tool-git
      name: git-for-dsh
      disabled: !!js process.env.DSH_GIT_TOOL_DISABLED === '1'
```

`disabled` 那一行的作用：设了 `DSH_GIT_TOOL_DISABLED=1` 时整行不加载，因此一个坏掉的插件只花掉一个环境变量，而不需要改文件（它只管**这一行**，见「恢复与回退」）。

若在 profile 自己的 `cordis.patch.yml` 里重述了同一 `id`，**用户层最后应用、按行覆盖**（不是冲突），所以想改这一行就在那里改。

重启 Profile 后：

- 模型获得 `git_exec` 工具；
- 设置面板出现「Git 工具」页，勾选即刻生效并持久化到 Profile 的 `settings.yaml`。

Host 半注册 `git-tool` 设置命名空间；Client 半通过 `ctx.get('settingsScope')` 绑定同一命名空间写入。**清单本身在构建时从 `src/git-catalog.js` 直接嵌进浏览器产物**（`scripts/build.mjs` 替换 `__GIT_TOOL_CATALOG__`），所以勾选页和 Host 的闸门读的是同一份清单，而浏览器不需要任何通往 Host 的运行时通道 —— 改完目录要重新 `npm run build` 并刷新页面。

设置页底部有一行「页面版本 `<构建指纹>`」（由 `scripts/build.mjs` 写入）。如果它与仓库里 `lib/client.js` 的指纹不一致，说明浏览器还在用旧的 bundle，强制刷新即可。

## 使用 `git_exec`

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `argv` | 是 | 程序名之后的 git 参数，第一个元素是子命令，例如 `["log", "--oneline", "-n", "20"]` |
| `paths` | 否 | 本次命令涉及的文件或目录，插件拼成 `git <子命令> … -- <路径>` |
| `description` | 是 | 一句话说明这条命令做什么，显示在界面上 |
| `workdir` | 否 | 工作目录；默认会话工作区，相对路径按会话工作区解析 |
| `timeoutMs` | 否 | 超时毫秒数；本地操作默认 120000，触及远端的操作默认 300000 |
| `justification` | 否 | 需要审批时提供的一句话理由 |

返回 `exitCode`、`signal`、`timedOut`、`operation`、`command`、`stdout`、`stderr`。

文件路径放在 `paths` 里，不要塞进 `argv`：插件会拼成 `git <子命令> … -- <路径>`，因此空格、通配符、以 `-` 开头的文件名都不需要转义。

工具描述与系统提示段都从当前允许清单实时生成，模型任何时刻都能看到自己能用哪些操作。

## 五道闸门与执行环境

### 1. 允许清单

`src/git-catalog.js` 是唯一事实来源，47 个操作按三个风险档位分组：

| 档位 | 含义 | 操作数 | 默认 |
| --- | --- | --- | --- |
| `read` | 只读仓库、索引、引用与配置 | 22 | 开启 |
| `write` | 改动工作区、暂存区或本地分支 | 16 | 关闭 |
| `remote` | 克隆、推送，或永久丢弃历史与未跟踪文件 | 9 | 关闭 |

未勾选的子命令在进程启动前就被拒绝，模型看到的是「该操作未启用」而不是「沙箱拒绝」，因此不会试图用别的方式绕过。

#### 只读档的「形式风险」

一个操作可以**列出来是只读、写进去是改状态**：`branch`、`tag`、`remote` 归在只读档，但它们的变更形式会创建引用、写 `.git/config`。因此判定按**形式**进行，分两类处理：

| 操作 | 只读形式 | 变更形式 | 处理 |
| --- | --- | --- | --- |
| `branch` | `branch`、`branch -a -v`、`branch --list <模式>` | `branch <名>`、`-d`、`-m` | 变更形式按**写档**，走审批 |
| `tag` | `tag`、`tag -l <模式>` | `tag <名>`、`-a`、`-d` | 同上 |
| `remote` | `remote`、`-v`、`show`、`get-url` | `prune`、`update` | 同上 |
| `remote` | — | `add`、`remove`、`rename`、`set-url`、`set-head`、`set-branches` | **直接拒绝**（写 `.git/config`） |
| `config` | `config <键>`、`--get`、`--list` | `config <键> <值>`、`--unset`、`-f` | **直接拒绝** |

`remote set-url` 与 `config` 同样是「拒绝」而不是「审批」，原因是它静默改变后续 push 的去向，而 push 的审批提示里只有命令，没有 URL。

### 2. 参数闸门

无论勾选了什么都不放行以下参数：

- `-c` / `--config-env` / `-C` / `--git-dir` / `--work-tree` / `--exec-path` / `--bare` 等 —— 配置注入或切换仓库，**但只在「全局位置」（第一个参数）拒绝**。经 git 2.55 验证，这些全局选项在子命令**之后**不再被 git 采纳（`git status -C <别的仓库>` 报 `unknown switch`），而那里它们往往是子命令自己的旗标：`switch -c`、`commit -C`、`add -u`、`init --bare`。一律拒绝会误伤日常操作。
- `--upload-pack` / `--receive-pack` / `--exec` —— 指定 git 要执行的程序，任何位置都拒绝。
- `-u` 按子命令判定：对 `fetch` / `pull` / `ls-remote` 它是 `--upload-pack` 的短形式（拒绝），对 `add` / `commit` / `push` 是普通旗标（放行）。

另有一条操作数规则：每个操作在目录里声明自己是否接受尾部操作数（`positional`）、是否接受文件路径（`filePaths`）。两者都没声明的（`count-objects`、`ls-files`、`ls-tree`、`for-each-ref`、`name-rev`）只允许带选项的形式。

### 3. 配置不能变成程序

只读操作会读取仓库配置，而配置里可以**指定要执行的程序**，这足以绕过整个允许清单：

~~~text
git config --local core.fsmonitor  "sh -c '…'"                     → git status 执行了它
git config --local diff.evil.command "sh -c '…'" + .gitattributes  → git diff 执行了它
~~~

`status` 和 `diff` 都是默认放行的只读操作，因此「只放行看状态」实际上等于给了代码执行能力。三处封堵：

- **`config` 只保留读取形式**：最多一个操作数，且不接受 `--unset` / `--add` / `--replace-all` / `--edit` / `-f` 等写入或选文件旗标。`git config user.name X` 会被拒绝。
- **指定程序的配置键被钉死**：`core.fsmonitor`、`core.gitProxy` 连同 `core.pager`、`core.hooksPath`、`credential.helper` 一起，通过环境变量注入（优先级高于任何配置文件）。**ssh 也在其中，但方式不同**：`GIT_SSH_COMMAND` 被钉成 `<ssh 程序> -o BatchMode=yes -o StrictHostKeyChecking=accept-new`，环境通道同样压过一切配置文件，所以仓库无法指定程序来当 ssh，而 SSH 传输仍然可用。
- **diff 类子命令强制带 `--no-ext-diff --no-textconv`**：`diff.<driver>.command` 是通配键，无法逐个钉死，因此在命令上关闭外部 diff 与 textconv。调用方传 `--ext-diff` / `--textconv` 会被拒绝，无法把它打开。

`scripts/verify-driver-hardening.mjs` 用真实 git 与一个恶意仓库验证这两条路径已关闭，**并且带控制组**（未加固时两个标记都必须出现），否则「没看到标记」可能只是没武装。

### 4. 仓库配置审计

前三项针对的是「键能被钉死」的情况。git 原生通配（`filter.<driver>.clean`、`url.<base>.insteadOf`、`alias.<name>`、`merge.<driver>.driver`）没有对应的单个环境键可以覆盖，钉不死就只能拒绝。

所以每次调用前先跑一次 `git config --local --includes --list --name-only -z`，命中危险键就按配置的裁定处理：

| 裁定（设置页文案） | 行为 |
| --- | --- |
| `refuse-repo`（一票拒绝，默认） | 该仓库里出现任何危险键，本工具在该仓库拒绝执行**任何**命令 |
| `refuse-affected`（只拒受影响） | 只拒「会被该键影响」的子命令（例如 `alias.*` 劫持不了 git 内建命令，不影响 `status`） |
| `neutralize`（尽量中和） | 已被钉死的键照常工作，只拒无法钉死的通配键 |
| `off`（关闭审计） | **关闭审计**：不检查仓库配置，因此也不为此多起一个 git 进程。危险键可以借此执行程序（`core.fsmonitor`、`diff.*.command`），只应在完全信任仓库时使用 |

这个命令有两条硬性要求：

- **必须带 `--includes`**。`git config --local --list` **看不到**由 `[include]` 引入的键，而它们照样生效：一个被 include 进来的 `core.fsmonitor` 能执行却对 `--local --list` 不可见。不带 `--includes` 的审计会恰好漏掉「会执行的那些」。
- **`--name-only` 必须与 `--list` 同用**。只写 `--name-only` 时 git 以 exit 129（`no action specified`）失败；而「读不到配置」按设计不算拒绝，于是闸门会完全空转。该命令在代码里只有一处定义，并由 `scripts/verify-config-audit.mjs` 用真实 git 复查它确实能跑、能看到 include 进来的键、三种裁定都正确（`off` 档不检查配置，因此不在此脚本范围内）。

审计也未必是「对抗 AI 的边界」—— 仓库配置就在工作区内，模型可以直接写它。它的价值在于**不管配置怎么来的，运行前都会被检查**：敌对仓库（clone 来、不是自己写的）尤其如此。

### 5. 执行环境

每次调用都固定为非交互，由 `buildEnv()` 通过环境变量注入（因此不需要放行 `-c`）：

- `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=''` —— 不等待终端输入。
- `core.pager=cat`、`GIT_EDITOR=true`、`GIT_SEQUENCE_EDITOR=true` —— 不分页、不打开编辑器。
- `core.hooksPath` 指向**平台空设备**（Windows 上为 `NUL`，其余为 `/dev/null`）—— 不运行仓库钩子。
- `credential.helper=` 清空，并且**默认**隐藏 `~/.gitconfig` 与系统配置（`GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` 指向平台空设备，Windows 上为 `NUL`）—— 用户级配置里的 `alias`、`url.insteadOf`、`credential.helper` 都不会生效。
- 子进程环境由 harness 擦除名字含 `KEY|PASSWORD|SECRET|TOKEN` 的变量。
- 默认取会话工作区作为工作目录，而不是 shell 自身的默认目录。

这两件事都随「允许 git 使用本机凭据」开关变化（见下文「本机凭据」）：**默认关闭**时如上；**开启**后本机与系统配置会恢复生效，`credential.helper` 也不再被清空。开关关闭是默认值，也是推荐值。

### 性能：审计结果按仓库配置状态缓存

一次 `git_exec` 会起**两个** git 进程：子命令本身，以及执行前的**仓库配置审计**。在 WSL 上进程启动是毫秒级开销，所以审计结果会缓存 —— 但**缓存键覆盖了判定所依赖的每一个输入**：

- 运行目录；
- 危险键策略；
- 仓库自身配置的**状态戳**（`mtime + size`，含 `config.worktree`）。

配置一改，戳就变，缓存自动失效；缓存里存的是**解析出的键名**，而**判定每次都按当前子命令重新计算**，所以不存在「缓存住的结论」。

两个边界是**写明**的：

1. **`[include]` 引入的文件**：它们的路径不额外问 git 就看不到（而问 git 正是缓存要省掉的调用），所以对**被 include 的文件**的修改由 **30 秒 TTL** 兜住，而不是立刻失效；
2. **worktree**（`.git` 是文件而非目录）：没有可监视的配置，于是**完全不缓存**（宁可每次都跑，也不缓存一个无法验证的东西）。

## 工具守卫：拦住「顺手用 bash 跑 git」和「顺手读凭据」

除了 git 的允许清单，插件还装了一个**工具守卫**（`tools/pre-execute` waterfall），对**每一次**工具调用做判定。原生 git 与凭据路径是两项独立设置，档位不同：原生 git 有四档，凭据路径有三档。

**原生 git** 有两档「拒绝」，差别在**判定宽度** —— 这是一个取舍，由用户选择：

| 档位 | 判定 | 代价 |
| --- | --- | --- |
| **禁止**（默认） | 命令里出现 git 调用就拒 | 安全，但**只是「提到」** git 也会被拒（例如 `echo "(关于 git)"`、含该词的脚本） |
| **限制** | 只在**命令位置**判定：命令开头、`; && \|\| \|` `$(` `(` 之后，或 `sudo`/`env`/`xargs`/`do` 等前缀之后；`sh -c "git …"` 会递归检查引号内 | **不误伤**，但可能漏掉生僻写法（`A=1 git status`、改名的二进制） |
| **询问** | 判定方式同「限制」，命中时弹一次审批 | — |
| **允许** | 不拦截 | — |

**目标范围**（三档，默认「仅工作区」）：`git_exec` 的目标目录由调用参数给出，在加这个闸门之前它**不受任何限制** —— 模型可以把 git 指向机器上的任何目录。三档分别是 **仅工作区**（目标必须落在本次会话的工作区内）、**指定路径**（必须落在你列出的某个根目录内；一个都没配时直接拒绝）、**无限制**（任何目录，即旧行为，需显式选择）。

三条比较规则各防一类失效：按**路径段**比较（`/work/app2` 不算在 `/work/app` 之内）、**先解析软链接**（否则工作区里一个指向 `/` 的链接就能走出去）、**Windows 上忽略大小写**。判定的是目标的**生效值** —— 省略 `workdir` 时它会默认成会话工作区。

**写入脚本时检查内容**（三档，默认「严格」）：`bash deploy.sh` 会把 git 调用藏在一个文件名后面，而判别器只看得到命令行。开启后，脚本在**写入时**就被判一次内容：内容已经在调用参数里，因此这个判定**不做任何文件系统访问**，命中时**拒绝这次写入**（脚本根本不会落地），而不是等它被执行时才拒。判多宽由**这个设置自己**的三档决定：**严格**（默认）在内容里**提到** git 时即命中，抓得住"只提了一句"的脚本，也难免误伤；**限制**只在**命令位置**出现时命中，基本不误伤；**关闭**则不判内容（脚本运行时的命令行判别仍然生效）。

这条保护的边界是：**以其他方式到来的脚本不被内容检查** —— 已存在的文件、由别的命令生成的文件、嵌套脚本、here-document、运行时才确定的解释器、或换一种语言调用 git，都看不到。它是一层启发式，不是保证。之所以不在执行 `bash script.sh` 时去读文件内容，是因为守卫跑在 dsh 进程里、对每一次工具调用同步执行，在那里做同步文件读取会拖住整个应用。

**凭据 / 身份文件**三档（**禁止**（默认）/ **询问** / **允许**）：判定 `read`/`write`/`edit`/`glob`/`grep` 的路径参数（解析为绝对路径、跟随软链接，**等于**或**包含**受保护文件），以及 bash 命令文本提到它。

默认保护 `~/.git-credentials` 与 `~/.gitconfig`，可在设置页修改。

**为什么拦 git**：`bash` 里的 git 绕过本插件的允许清单、参数闸门、配置审计与审批 —— 它读全局配置、跑未加固的环境。所以默认拒绝，并明确提示改用 `git_exec`。

**为什么拦凭据**：本机凭据文件对同 uid 可读（dsh 的沙箱限制写入、不限制读取），「AI 顺手读一下」是现实存在的路径。守卫关掉这条路，而插件内部的 git（沙箱外、不是工具调用）不受影响，推送照常。

### 如实说明它的强度

**这是一道策略闸门，不是安全边界。** 设置页上也是这么写的。

- 拦得住：`git status`、`/usr/bin/git log`、`cat ~/.git-credentials`、`read ~/.gitconfig`、`grep -r . ~` 这类**直接**写法；
- 拦不住：运行时拼出来的路径（`$(printf …)`、base64、变量拼接）、把命令写进脚本再执行、或任何**不经过工具**的通道。

真正的硬保证只有一条 —— **在沙箱里遮蔽这些文件**，那样沙箱内的一切（包括 `git credential fill`）都读不到。但**那是 dsh 沙箱的职责，本插件不去改 dsh 源码**，因此只如实标注强度。

守卫自身的设计约束：任何内部错误都 `next()`（放行），因为一个抛错的守卫会掐断会话里的每一次工具调用；代价是「坏掉的守卫看起来和平庸的守卫一样」，所以单元测试**直接驱动这个监听器**。

## 远程与凭据

### 代理：插件只负责把**你的**代理拉起来

远程操作需要出网，而本插件不碰凭据。它做的是「替你启动代理」这一件事，省掉在启动 dsh 前 `export HTTPS_PROXY=…`。

设置页两项：

| 设置 | 含义 |
| --- | --- |
| **端口** | `127.0.0.1` 上的端口；`0` 关闭本功能（那时 git 继承 dsh 进程已有的代理变量） |
| **启动命令** | 首次远程操作时执行一次，用来拉起代理 |

首次需要远程操作（`clone`/`fetch`/`pull`/`push`/`ls-remote`）时：

1. **端口已有代理在监听** → **直接用它**：给 git 注入 `HTTPS_PROXY`/`HTTP_PROXY`（并设 `NO_PROXY=127.0.0.1,localhost,::1`，免得代理请求被自己代理）。不启动、也不会停止它 —— 那是用户的进程；
2. **端口空闲 + 有启动命令** → 执行它，最多等 8 秒轮询端口，起来后同样注入；
3. **端口空闲 + 没有启动命令** → 拒绝并指出该填哪一项；
4. 启动后 8 秒仍未监听 → 杀掉进程、报出它的输出。

只有**由插件启动**的那个进程会在插件退出时被收掉（注册在本插件的 fiber 上）。

填完端口可以点旁边的「端口测试」：它由 Host 侧执行探测（不是浏览器去连），不仅回答「通不通」，还会**扫一遍常见代理端口并报告哪个在监听**。端口填错是这里最容易犯的错。

**本功能解决的是「出网」，不是「认证」。** 部分网络环境下直连 `github.com` 会 TCP 握手成功但 HTTPS 卡死（同一环境下 `api.github.com` 正常），经代理则可正常返回 `HTTP 200`。

**它与凭据的关系**：插件**不注入任何凭据**，令牌留在用户启动的那个代理里。这与「凭据永不进入 AI 上下文」是两件事：代理里有什么、放哪儿，仍由用户决定（见下文的边界说明）。

「启动命令」是一段会被执行的**受信配置** —— 只有用户能写它（模型的写权限被限制在会话工作区内，动不了 `settings.yaml`）。

### 本机凭据：默认隔离，可显式放开

设置页的「允许 git 使用本机凭据」开关（默认**关闭**）决定这个工具有没有认证能力：

| | 关闭（默认） | 开启 |
| --- | --- | --- |
| `~/.gitconfig` 与系统配置 | 隐藏 | **生效** |
| `credential.helper` | 清空（钉死为空） | 交给 git 自己读 |
| 钉死「指定程序」的键 | 全部生效 | **仍然全部生效** |
| 远程写操作（push） | 一律失败（`cannot read Username`） | 可以认证 |

开启之后的代价写在设置页上（**不必开启即可读到**）：

- `url.<base>.insteadOf` 可以把某个主机**重定向到别处** —— 凭据可能被送到非预期的服务器；
- `credential.helper` 与 `alias.*` 是 git 会**执行的程序**。

也就是说：默认隐藏全局配置时被压住的这些行为会一起回来。**只应在信任这台机器的全局配置时开启。**

开启这一项时，令牌不经过参数、审批提示与会话记录，因为 git 自己读取它。

**这一项不解决「令牌会不会被 AI 读到」。** 同一 uid 下 `git credential fill` 能直接取出令牌，同 uid 进程的环境变量也可读，而且模型还能用 `bash` 绕过本插件直接驱动 git。所以本工具能承诺的仍然只有一条：**它自己不读取、不传递、不存储凭据，也不把凭据写进参数、审批提示或会话记录**（URL 里内嵌凭据的形式已被拒绝）。真正的隔离只能来自沙箱之外的边界。

### 本插件的承诺，以及它的边界

本插件只承诺一件事：**它自己不读取、不传递、不存储凭据，也不成为泄漏路径**。

- `credential.helper` 被清空，`~/.gitconfig` 与系统配置默认隐藏；
- 子进程环境由 harness 擦除名字含 `KEY|PASSWORD|SECRET|TOKEN` 的变量；
- `git config -f <任意文件>` 被拒绝，因此不能用它去读仓库外的文件；
- 调用方无法用 `-c` / `--config-env` 把配置塞进来。

**它不做、也做不到的事**：dsh 的文件策略限制的是**写入**，不限制**读取**。在 `workspace-write` 下，工作区外的文件（含 `~/.git-credentials`）对模型仍然可读。因此「凭据永不进入 AI 上下文」**不可能由插件保证** —— 那取决于沙箱边界、以及由哪个 uid 持有密钥。本插件不管理 `~/.git-credentials`，也不建议把密钥托付给它保管。

远程认证建议走**外部代理**：在 DSH 进程环境里设置代理（例如 `HTTPS_PROXY=http://127.0.0.1:PORT`），git 会继承它并经由代理访问远端 —— `scrubbedParentEnv()` 明确保留代理变量，这条路不需要任何插件配置。

### 与 git 自带提示的差异

有些失败下 git 会建议去改配置，例如分叉历史时提示 `git config pull.rebase false`（是否出现取决于 git 版本）。**配置写入在本工具里被拒绝**，照提示做会再撞一次墙。等效的旗标都在允许清单里：

```sh
git pull --rebase origin main
git pull --no-rebase origin main
git pull --ff-only origin main
```

遇到「git 让你改配置」的提示时，先找该操作的对应旗标。

## 设置项一览

设置页「Git 工具」分为五个页签：**策略与代理**、**只读**、**写操作**、**远程**、**日志**。第一个页签放各项开关，后三个页签是按档位分组的操作清单。

| 分组 | 设置项 | 默认 | 作用 |
| --- | --- | --- | --- |
| 允许清单 | 只读 / 写操作 / 远程 三档勾选 | 只读档全开 | 勾选后 AI 才能执行对应子命令；每档还有全选开关，并显示 `已选/总数` |
| 插件 | 启用本插件 | 开 | 关闭后 `git_exec` 拒绝调用、工具守卫不再拦截，立即生效无需重启 |
| 审批 | `写操作前询问我`（设置页文案） | 开 | 写档与远程档的每次调用都弹审批，而不只靠勾选放行 |
| 闸门 | 原生 git | 禁止 | 禁止 / 限制 / 询问 / 允许 |
| 闸门 | 凭据与身份文件 | 禁止 | 禁止 / 询问 / 允许 |
| 闸门 | 受保护的路径 | `~/.git-credentials, ~/.gitconfig` | 逗号分隔 |
| 闸门 | 路径权限 | 内置五行，三项全不勾 | 每行一条路径，三个复选框：**读**／**写**＝静默放行，**询问**＝每次访问先问你（批准即放行该次），**三项都不勾＝静默禁止（不打扰你）**。内置行（凭据与身份文件）默认全不勾、**不可删除**、可随时修改；自己加的路径可删除。没有"整表开关"，停用某行＝清空它的勾选 |
| 闸门 | bash 里的路径判定 | 启发式 | 两选：**启发式**（明显读按读、明显写按写、其余按写＝保守兜底）或**一律按写**。守卫只能看到命令文本，所以这一层**本质是启发式**，不是文件访问事实 |
| 闸门 | 目标范围 | 仅工作区 | git 可以在哪里执行：仅工作区（默认）／指定路径（只在列出的根目录内）／无限制（机器上任何目录） |
| 闸门 | 写入脚本时检查内容 | 严格 | 三档：严格（提到即拒）／限制（只在命令位置判，基本不误伤）／关闭。写入时按参数内容判，不产生文件系统访问 |
| 闸门 | SSH 程序 | `/usr/bin/ssh` | 由 `GIT_SSH_COMMAND` 钉死；旁边有「探测」按钮 |
| 凭据 | 允许 git 使用本机凭据 | 关 | 开启后远程写操作可以认证，代价见上文 |
| 代理 | 端口 | `0`（关闭） | `127.0.0.1` 上的端口；旁边有「端口测试」按钮 |
| 代理 | 启动命令 | 空 | 首次远程操作时执行一次 |
| 仓库配置审计 | 出现危险配置键时 | 一票拒绝 | 一票拒绝 / 只拒受影响 / 尽量中和 / 关闭审计 |
| 诊断日志 | 写诊断日志 | 开 | 每次闸门判定记一行（含耗时） |
| 诊断日志 | 心跳行 | 关 | 每 5 秒一行，报出卡在半途的调用及其时长 |
| 诊断日志 | 日志路径 | 空 | 留空使用 `$DSH_HOME/git-for-dsh.log` |

### SSH：程序路径可以探测，不用自己填

设置页「闸门」分组里的 **SSH 程序** 旁边有个 **「探测」** 按钮：它会扫描 `$PATH` 加上常见位置（含 WSL 下的 Windows OpenSSH：`/mnt/c/Windows/System32/OpenSSH/ssh.exe`、Git for Windows 自带的那个），逐个验证**是否可执行**并取版本号，然后把**所有可用的候选列出来**，点一个就填进去。

- 探测**只在点击时运行** —— 它要访问文件系统，而「点击时访问」没问题、「每次调用都访问」会拖慢每一次工具调用；
- 一个都没找到时会明说：这台机器上 SSH 远端用不了，需要先装 OpenSSH（HTTPS 远端不受影响）；
- 需要这个选项的原因：程序路径由 `GIT_SSH_COMMAND` 钉死（配置改不了它），所以路径填错就等于 SSH 不可用 —— 而不同发行版/Windows 互操作下它的位置并不统一。

## 诊断与排障

### 诊断日志

默认开启，写在 `$DSH_HOME/git-for-dsh.log`（设置页可改路径或关掉）。在终端里盯着它：

```sh
tail -f ~/.dsh/git-for-dsh.log
```

记什么：

| 行 | 含义 |
| --- | --- |
| `activate` | 激活时的策略快照（开关、档位、代理、ssh 程序…） |
| `guard.enter` | 某次工具调用进入守卫，bash 调用附带命令前 60 个字符（脱敏后） |
| `guard.exit` | 守卫的判定与**耗时（毫秒）** |
| `guard.error` | 守卫自身出错（仍会放行，绝不断调用） |
| `tool.done` | 一次工具调用真正结束（失败时带 `failed=true`） |
| `git_exec.refused` | 因插件关闭而拒绝 |
| `heartbeat` | 心跳行（仅在开启该项时写入） |
| `log.cleared` | 日志被设置页清空 |

插件开关关闭时，守卫不再拦截，也不再写调用日志。

**两处可选项**：

- **心跳行**（默认**关闭**，与「写诊断日志」**互不影响**）：开启后每 5 秒写一行 `heartbeat n=… open=… openMs=…`，报出「当前有哪个调用卡在半途、卡了多久」，用于**把卡死定位到具体阶段**：没有它，「闲置时开始的卡死」与「调用中开始的卡死」在日志里长得一样。两个开关独立：只开心跳 = 存活探针（日志里只有心跳行）；只开调用日志 = 审计轨迹。
- **命令前缀**（始终记录）：`guard.enter` 会带上该次 bash 命令的**前 60 个字符**（脱敏后）。只写 `tool=bash` 看不出在跑什么，这一条是定位「哪条命令引发卡死」的唯一线索。

日志用**同步追加**写：这样「缺了一行」只可能是真的没写，而不是烂在缓冲里。它也是本插件里**唯一**碰文件系统的地方；日志路径默认放在 harness 状态旁边，而不是 Windows 盘上。超过 2MB 自动轮转为 `.1`（每 200 行检查一次大小）。

三条设计约束（都写进了 `src/log.js`）：**同步落盘**（一行写完才返回）、**出错只关日志**（绝不影响它正在记录的调用，但失败会报给宿主终端）、**只记长度与判定不记内容**（值长度上限 200 字符，并对凭据 URL 与令牌形状的字符串脱敏）。

### 诊断卡死：最后一行就是线索

`guard.enter` 与 `guard.exit` 是**两行**，所以

- 有 `enter` 没有 `exit` → 卡在**守卫内部**；
- 有 `exit` 之后没有下文 → 卡在**下游**（dsh 的工具派发、文件系统、Windows 侧）。

### 进程卡住时：只能从进程外动手

进程卡住时它救不了自己：设置页正是由被卡住的进程提供的，页面上的「重启」按钮会跟着一起死，进程内定时器同样无救。**只有另一个进程能动手**，所以仓库里带了 `tools/watchdog.sh`：

```sh
# 在 dsh 之外另开一个终端（必须，沙箱/进程外才能探到真实服务）
tools/watchdog.sh                      # 只探测并报告
DSH_RESTART_CMD='dsh web' tools/watchdog.sh --restart   # 卡住时 kill -9 并重启
```

它的探针是**对 dsh 自己的 web 服务发 HTTP 请求**：回答来自事件循环，所以请求超时说明循环没在跑。它**不依赖本插件**，因此在「插件就是元凶」的情况下照样有效。重启用的是 `kill -9` —— 事件循环被卡死时，JavaScript 写的信号处理器没有机会运行，**只有内核处理的信号能穿透**。

**守卫内部的扫描都有步数预算**：预算耗尽时守卫按**最严策略**拒绝并说明原因，而不是让宿主进程停住。定时器无法中断同步循环，所以只有循环自己会去查的计数器有效。预算设在**远高于任何真实命令**的量级，只有「这段代码没预料过的输入」才会触发。

**最后一道逃生口**：无论如何都要能不用插件启动 dsh ——

```sh
DSH_GIT_TOOL_DISABLED=1 dsh web    # 这一行启动时，本插件的组件行不会加载
```

（注意：设置页里的「启用本插件」开关是**软**开关 —— 它会让 `git_exec` 拒绝调用并停止守卫拦截，但组件行仍在管线里；上面这个环境变量才是**完全不加载**。）

### 运行开关：不用重启就能关掉插件

设置页最上面的「启用本插件」是一个**运行时开关**：

- **关闭**：`git_exec` 拒绝调用（并说明这是开关而不是允许清单问题），**工具守卫完全不再拦截**；
- **立即生效**，无需重启 —— 这是它的用途：做 A/B 对比。怀疑某次卡顿是插件造成的，就关掉它再试同样的操作；关掉还卡，就与插件无关。

（dsh 自带的 Cordis 面板只能管理**动态**插件，管不到 profile 加载的插件行，所以这个开关由本插件自己提供。）

## 审核与回退

Host 半默认对 `write` 与 `remote` 档位的每一次调用弹出审批，而不只依赖勾选（`approveMutating`）。设置页可关闭。

### 插件出问题时怎么恢复

插件崩了不应该让用户去删文件、也不应该让 dsh 起不来。三档手段，从轻到重：

1. **加一行环境变量**（前提：该行写了上面的 `disabled: !!js …`）。`DSH_GIT_TOOL_DISABLED=1` 启动即整行不加载，不用改任何文件，去掉变量就恢复。注意它只管**这一行**：Host 半自己已有兜底，Client 半也已能在读不到服务时降级成受限页面。

   ```sh
   DSH_GIT_TOOL_DISABLED=1 dsh --profile web
   ```

2. **删掉 patch 里的那三行**。`cordis.patch.yml` 的 `patchReload: live` 会在启动时重新读它；这一步不需要卸载依赖，`package.json` 与 `node_modules` 里的软链留着不影响。

3. **彻底卸载**。`dsh plugin --profile <profile> remove git-for-dsh` —— 它同时会把这个依赖从 `dsh.profile.bundles` 里摘掉（reconciler 按已安装状态对齐）。若曾在 profile 自己的 patch 里重述过该行，再删掉那一行。

**两层兜底**（都在代码里，不依赖用户记得用上面的开关）：

- Host 半的 `apply()` 把整段初始化包在 try/catch 里。初始化失败只在日志留下一行带原因的 `git-tool: activation failed …`，`git_exec` 不注册，会话照常可用。
- Client 半导出 `inject: ['slots', 'settingsScope']`（这是让激活等待服务就绪的机制），服务确实缺失时用 `ctx.get()` 可选读取并降级成不可写页面；**整个工厂体包在 try/catch 里**，求值失败就交出一个空操作的插件，而不是让这次插件加载失败。页面本身还套了 React error boundary。

## 开发

```sh
npm test       # 66 个断言：目录、闸门、环境、拼接、Host 集成、Client bundle 加载/降级/渲染
npm run build  # 把 src/ 拷贝到 lib/，package.json 指向 lib/
node scripts/verify-served-bundle.mjs <bundle>   # 用真实加载语义验证一个已构建/已服务的 bundle
node scripts/verify-driver-hardening.mjs         # 用真实 git + 恶意仓库验证两条代码执行路径已关闭（含控制组）
node scripts/verify-config-audit.mjs             # 用真实 git 验证审计命令能跑、能看到 include 进来的键、三种裁定正确

测试用夹具仓库位于 `.git-test-fixture/`（已加入 `.gitignore`）：3 个提交、1 个分支、1 个标签，用来在真实仓库上驱动工具而不污染工程本身。
```

`src/` 就是运行时产物：Host 半是普通 ESM，Client 半是手写的 client module bundle（`window.__ModuleLoader__.load({ id, factory })`，id 为包名）。因此本包**不需要任何打包工具**——Profile 里不必装构建链，Client 产物也可直接阅读。

`node_modules/` 里的 `@deepseek-ai/*` 是指向本机 DSH 安装的软链，仅供本地测试解析 peer 依赖；`lib/` 由 build 生成。两者都不入库。

### 布局预览

设置页的排版问题（挤在一起、两行并成一行）没法靠断言发现，得看。所以有一个离线预览：

```sh
node scripts/render-preview.mjs                 # 生成 .preview.html
DSH_SHELL_CSS=<shell 的 index-*.css> node scripts/render-preview.mjs   # 带上真实主题色
```

它用**构建产物里那个页面组件**渲染出真实 DOM，再套上 shell 的样式表，因此看到的就是页面长什么样，不需要登录、不需要浏览器会话。仓库里的 `git-tool-settings-preview.html` 是它的输出。

## 延伸阅读

- [PITFALLS.md](PITFALLS.md) —— 开发过程中踩过的坑，每条都写了「现象 / 根因 / 怎么判 / 怎么避 / 谁守着」。靠前的条目涉及让 dsh 起不来、让闸门空转、让设置页变成只读的问题，改动这个项目之前先读那篇。
- [DESIGN.md](DESIGN.md) —— 设计决策与取舍：为什么某个机制是这样做的、它换来什么、代价与边界在哪里。维护者改动前需要知道的背景都在这里。

## 文件布局

```
PITFALLS.md          踩过的坑：现象 / 根因 / 怎么判 / 怎么避 / 谁守着
DESIGN.md            设计决策与取舍、边界与代价
cordis.patch.yml     自带的补丁层：把本包作为一行插件挂进 profile
tools/watchdog.sh    进程外的看门狗：探测 dsh 的 web 服务，卡死时 kill -9 并重启
src/git-catalog.js   操作目录、参数闸门、环境构造、命令拼接
src/index.js         Host 半：git_exec 工具、设置命名空间、系统提示段、工具守卫、端口测试路由
src/client.js        Client 半：设置页 UI（勾选、策略、代理、日志）
src/log.js           诊断日志：同步追加、脱敏、2MB 轮转
src/proxy.js         代理端口探测与等待
scripts/build.mjs    把 src/ 拷贝到 lib/
scripts/render-preview.mjs        渲染离线布局预览
scripts/verify-served-bundle.mjs  用真实加载语义验证构建/服务的 bundle
scripts/verify-driver-hardening.mjs  真实 git + 恶意仓库验证代码执行路径已关闭（含控制组）
scripts/verify-config-audit.mjs      真实 git 验证审计命令与三种裁定（含对照）
test/git-catalog.test.mjs  目录、闸门、环境、拼接
test/host.test.mjs         Host 半集成（允许清单闸门、审批闸门、结果形状、兜底）
test/client.test.mjs       Client bundle 真实加载、服务声明完备性、错误兜底
test/log.test.mjs          诊断日志：两个开关、脱敏、轮转
test/proxy.test.mjs        代理端口探测、等待、环境注入
.git-test-fixture/         测试用的夹具仓库（已加入 .gitignore）
```
