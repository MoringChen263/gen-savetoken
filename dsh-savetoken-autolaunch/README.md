# dsh-savetoken-autolaunch

> 用户提问时自动节约 token 消耗，最大程度保护用户的余额的 DSH 插件。

它做到这件事的方式很直接：在 Host 的 `agent/pre-step`（发模型请求前的最后一道闸门）里**拒绝这一步**，于是这一轮**根本不会发出模型请求**——0 token。同一时刻它会用系统默认浏览器打开《原神》官方下载页，并在后台下载官方 PC 安装器。

安装器是米哈游官方签名的 `yuanshen_setup_<日期>.exe`（约 223 MiB），运行它之后由官方启动器负责下载完整客户端。插件**不会**自己去抓取完整客户端（那是 80 GB 级别的分卷包），避免在你没同意的情况下吃掉磁盘和带宽。

## 触发条件

监听 Host 的 `agent/pre-step`（每次要发模型请求之前的最后一道闸门），并且**只对来源为真实用户的消息**生效：

- 批次里存在 `message.source.kind === 'user'` 才算"提问"；插件自己注入的消息（`kind: 'plugin'`，例如 repeat-tool-reminder 的提醒）会被跳过，正常继续。
- 默认**每次提问都触发**（`oncePerSession: false`、`cooldownMs: 0`）。想要"每会话只弹一次"，把这两个打开即可。
- 触发后默认**拒绝这一步**（`stopTurn: true`）：DSH 的 loop 收到 `{kind:'reject'}` 后会走 `turnEnds = { kind: 'blocked' }` 并且**不启动 step**，也就是根本不发模型请求——这一轮 0 token。日志里会写 `stopping the turn before any model request (0 tokens spent)`。
- 任何异常都**失败开放**（fail open）：插件内部出错时照常 `next()`，绝不把提问吞掉。

## 默认行为

1. 用系统默认浏览器打开 `https://ys.mihoyo.com/download/`。
2. 向官方端点 `https://api-takumi.mihoyo.com/event/download_porter/link/ys_cn/official/pc_backup` 取当前安装器地址（302 跳转到官网 `autopatchcn.yuanshen.com`），流式下载到 `%USERPROFILE%\Downloads\genshin-desktop\`。
3. 在 `agent/pre-step` 里返回 `{kind:'reject'}`，这一轮不发模型请求、不消耗 token。
4. 全过程写入 `%USERPROFILE%\Downloads\genshin-desktop\genshin-autolaunch.log`。

下载支持 `Range` 断点续传：文件已存在时从断点继续，已完整时直接记录 `already complete`。

## 配置

在 **profile 的 `cordis.patch.yml`** 里覆盖任意默认值：

```yaml
- id: savetoken-autolaunch
  name: dsh-savetoken-autolaunch
  config:
    stopTurn: true             # 触发后结束这一轮，模型不被调用（0 token）
    openBrowser: true
    download: installer        # installer = 下载官方安装器；none = 只开浏览器
    oncePerSession: false      # true = 每个会话只弹一次
    cooldownMs: 0              # 两次触发的最小间隔（毫秒）
    targetDir: 'D:\Games\genshin-setup'
    progressStepPercent: 5
    dryRun: false              # true = 只写日志，不开浏览器、不下载、也不拦截
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关，`false` 时连监听都不注册 |
| `stopTurn` | `true` | 拒绝这一步，模型不被调用（不消耗 token） |
| `openBrowser` | `true` | 是否打开浏览器 |
| `downloadPageUrl` | 官方下载页 | `openBrowser` 打开的地址 |
| `download` | `installer` | `installer` 下载官方安装器，`none` 只开页面 |
| `installerEndpoint` | 官方 porter 端点 | 每次触发时用它换取最新安装器直链 |
| `targetDir` | `<home>/Downloads/genshin-desktop` | 下载目录 |
| `oncePerSession` | `false` | 每个会话只触发一次 |
| `cooldownMs` | `0` | 跨会话的最小触发间隔 |
| `progressStepPercent` | `5` | 每下载百分之几记一条日志 |
| `logFile` | `<targetDir>/genshin-autolaunch.log` | 日志文件 |
| `dryRun` | `false` | 演练模式，只写日志 |

### 生效时机（重要）

profile 的**配置**改动会立刻重组插件树；但**代码**改动不会。`hmr.root: []` 表示模块监听是关的，ESM 缓存不会失效——实测改完 `lib/index.js` 之后触发的重组仍然执行旧模块（日志里是旧版本号），只有**换包名**（模块 URL 变了）才会立刻加载新代码。所以：

- 只改 `config:` → 立刻生效；
- 改了 `lib/index.js` → **需要重启一次 DSH**。

日志里 `applied:` 那行带 `v` 前缀（如 `v1.2.1 applied:`）就能确认跑的是哪一版代码。

## 分发给别人

那个「添加插件」对话框接受三种输入：**包名**、**GitHub 仓库地址**、**本地目录路径**。对应三条路。

### 方式 A — 包名（最省事，需要先发布一次）

现在输入 `dsh-savetoken-autolaunch` 只会报 `not-found`，因为它还没发布。这个包名**目前没被占用**（npmjs 和中国大陆镜像源都返回 404），发布一次之后所有人都能用包名安装。

发布（只需做一次，需要 npmjs.com 账号）：

```powershell
cd D:\dshwork\dsh-savetoken-autolaunch
npm adduser --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/ --access public
```

`--registry` 不能省：本机 npm 默认指向 `registry.npmmirror.com`，那是**只读镜像**，发布必须打到 npmjs。

发布后收件人在对话框里只填一行：

```
dsh-savetoken-autolaunch
```

安装源选「中国大陆镜像源」也行——npmmirror 会在几分钟内自动同步 npmjs 的新包；如果立刻装报 `not-found`，先切回官方源再试，或等几分钟。

**升级**：对话框自己写了「暂不支持自动更新」。所以要么在图里卸载后重装新版，要么 bump `version` 再 `npm publish`，对方卸载→安装。

### 方式 B — GitHub 仓库地址

```powershell
cd D:\dshwork\dsh-savetoken-autolaunch
git init
git add -A
git commit -m "dsh-savetoken-autolaunch 1.2.1"
git remote add origin https://github.com/<你>/dsh-savetoken-autolaunch.git
git push -u origin main
```

收件人在对话框里填 `github:<你>/dsh-savetoken-autolaunch`（或仓库的 HTTPS 地址）。安装器会先用 `git ls-remote` 探测可达性，所以仓库必须公开。

### 方式 C — 本地目录路径（完全离线）

把 `dsh-savetoken-autolaunch-1.2.1.zip` 发给对方（Windows 双击即可解压，不需要 7-Zip），解压得到 `dsh-savetoken-autolaunch` 文件夹，然后在对话框里填**这个文件夹的完整路径**：

```
D:\下载\dsh-savetoken-autolaunch
```

填的是**文件夹**（里面有 `package.json` 的那一层），不是压缩包本身。

### 命令行等价做法

```powershell
dsh plugin --profile desktop add dsh-savetoken-autolaunch                # 方式 A
dsh plugin --profile desktop add github:你/dsh-savetoken-autolaunch      # 方式 B
dsh plugin --profile desktop add link:D:\下载\dsh-savetoken-autolaunch   # 方式 C
```

三种方式装完，管理器都会**自动选中**这个 bundle（`Installation enables a new bundle by default`），不需要手改 `dsh.profile.bundles`。

### 给收件人的提醒

装完之后，**每次提问都会打开浏览器下载官方安装器，并且默认会把这一轮直接结束掉——模型不会回答、不消耗 token**。不想被拦就把它配置里的 `stopTurn` 设成 `false`（照样弹浏览器，但保留回答）。

装完确认：

```powershell
dsh plugin --profile desktop list                 # 依赖里有 dsh-savetoken-autolaunch
Get-Content "$env:USERPROFILE\Downloads\genshin-desktop\genshin-autolaunch.log" -Tail 3   # 应出现 "applied"
```

## 安装与卸载

本插件已安装进 `desktop` profile：`profiles/desktop/node_modules/dsh-savetoken-autolaunch`
是指向本目录的**目录联接（junction）**，所以直接改这里就等于改运行中的插件。

安装（等价于当前状态）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-savetoken-autolaunch" `
  -Target "D:\dshwork\dsh-savetoken-autolaunch"
# 再把 "dsh-savetoken-autolaunch" 追加到 profiles/desktop/package.json 的 dsh.profile.bundles
```

卸载：从 `dsh.profile.bundles` 去掉该名字，然后删除 node_modules 里的联接（不删要保留源码的话就别删本目录）。

临时关闭而不卸载：在 profile 的 `cordis.patch.yml` 里加

```yaml
- id: savetoken-autolaunch
  name: dsh-savetoken-autolaunch
  disabled: true
```

## 开启与关闭

**默认开启。** 本插件的 bundle patch 里的 insert 行不带 `disabled`，所以只要这个 bundle 被选中就是挂载并按默认配置运行；而且 DSH 插件管理器"Installation enables a new bundle by default"——用 `dsh plugin add` 或 Plugins 页装上之后会自动选中，不需要再手动打开。

关闭有四档，从"只是不想让它弹"到"彻底移除"：

| 方式 | 做法 | 效果与生效时机 |
| --- | --- | --- |
| ① DSH 侧边栏 **Plugins** 页的开关（推荐） | 点开关即可，不用碰文件 | 走插件管理器服务，文档明确"Direct Plugin Manager operations apply without waiting for file events" |
| ② profile 的 `cordis.patch.yml` 加 `disabled: true` | 见上一节 | 即①写进去的同一处；按 DSH 文档属于"配置变更即重组"，但**本机实测**我手改 YAML 时没有立刻反映到运行中的实例（只有第一次改 `package.json` 的 bundles 列表时观察到热加载），稳妥起见请当作"重启后生效" |
| ③ 插件自己的配置 `enabled: false` | 在 `config:` 里加 | 连事件监听都不注册；同样建议重启后确认 |
| ④ 彻底卸载 | 从 `dsh.profile.bundles` 去掉名字，删掉 node_modules 里的联接 | 不再加载 |

关闭/卸载时会做两件事：**中止本实例正在进行的下载**，并往日志写一行

```
[2026-...Z] v1.2.1 disposed (disabled or removed); aborted 1 download(s)
```

所以日志里能直接看出开关有没有生效。

⚠️ 这里有个踩过的坑：**`apply` 返回一个函数当 disposer 是不生效的**。实测连续 5 次重新挂载都没有触发过卸载日志，改用 `ctx.on('dispose', …)` 才被调用。如果你自己写插件，别用返回函数那种写法。

注意这条要等模块重新加载（重启 DSH）才会出现在运行中的实例上——`applied:` 那行如果没有 `v` 前缀，说明跑的还是最早期加载的代码。

## 验证

```powershell
D:\nodejs\node.exe test\harness.mjs      # 62 项离线检查：触发规则、pre-step 拒绝、配置、下载管道
D:\nodejs\node.exe test\live-check.mjs   # 真实链路：开浏览器、解析直链、真下载一个小文件
npm pack --pack-destination ..           # 打出发行包
D:\nodejs\node.exe test\consumer-probe.mjs ..\dsh-savetoken-autolaunch-1.2.1.tgz
                                         # 消费端验证：装进干净项目，用裸包名 import
```

`harness.mjs` 把浏览器、网络、下载目录全部注入替身，因此可以在不打扰你的前提下跑完。
`live-check.mjs` 会**真的弹出一次浏览器**，并真的向官方域名发一次请求。
`consumer-probe.mjs` 证明别人拿到 tgz 之后能装、能按 `exports` 正常解析。

## 对 token 的影响

**这一轮 0 token。** 插件在 `agent/pre-step` 返回 `{kind:'reject'}`，DSH 的 loop 收到后走 `turnEnds = { kind: 'blocked' }` 并且**不启动 step**——不组装请求、不调用模型，因此这一整轮没有任何 token 消耗（也就没有 KV cache 写入）。这就是它"保护余额"的方式。

它自身不注册工具、不注册 prompt 段、也不通过 `agent.inject()` / `agent.followup()` 往会话里塞内容，所以除此之外不会给任何请求增加 token。

代价必须说清楚：**模型因此不会回答这一轮的提问**。想保留回答就把 `stopTurn` 设成 `false`——那时它只是一个"打开浏览器 + 下载安装器"的插件，token 消耗回归正常。

## 已知边界

- 本模块只 import Node 内置模块。运行中的 Host 是 `0.2.0-rc.2`，而 profile 的 `node_modules` 里还躺着 `0.1.0-rc.6` 的旧包，导入任何 `@deepseek-ai/*` 都可能加载到第二份不匹配的库；因此配置默认值写在 `resolveConfig()` 里，而不是 schemastery schema。
- Host 端插件在进程内执行，不受工作区文件沙箱限制，所以它写 `%USERPROFILE%\Downloads` 不需要额外授权。
- 触发只在 Host 收到用户消息时发生；重启 DSH 后模块会重新加载。
