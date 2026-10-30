# 验收状态

逐项对照[架构文档第十二节](architecture.md)的验收方式，记录当前状态与复现命令。状态只有三种：**通过**（有可复现的证据）、**部分**（有实现但缺少一项必要条件）、**未触及**（依赖本机不具备的基础设施）。

复现前先准备环境：

```bash
export PATH=/usr/local/nvm/versions/node/v24.19.0/bin:$PATH
export DSH_HOME=/workspace/chatdsh/runtime/.run/dsh-home
node scripts/link-dsh-deps.mjs
./node_modules/.bin/tsc -b tsconfig.build.json
node scripts/build-client.mjs
node scripts/sync-profiles.mjs
```

## 一、组合成立性

**通过。** `node scripts/check-composition.mjs` 对每个 profile 检查退出码、警告输出与条目 id 唯一性，并附带核对配置模式文档能否产出。四个 profile 全部通过。

```bash
node scripts/check-composition.mjs
```

最近一次结果：

```
chatdsh-cli：通过（条目 117 个，重复 0 个，配置模式文档 有，投影警告 12 条）
chatdsh-desktop：通过（条目 222 个，重复 0 个，配置模式文档 有，投影警告 11 条）
chatdsh-hermes：通过（条目 222 个，重复 0 个，配置模式文档 有，投影警告 11 条）
chatdsh-web：通过（条目 223 个，重复 0 个，配置模式文档 有，投影警告 11 条）
```

`chatdsh-cli` 挂载了 `@deepseek-ai/dsh-experimental-ralph-bundle`。dsh-tui 0.16.1 的补丁层按 id 关闭 `tool-ralph`，该行由这个可选组合包插入；补丁目标缺失时启动器会打印 `patch: entry "tool-ralph" not found`。profile 的补丁层再把整组 `optional-ralph` 关闭，命令行形态不暴露重复执行能力。

配置模式导出（`--dump-config-schema`）在当前上游版本上总会返回非零并打印投影限制的警告，内置 profile 同样如此；检查判定的是模式文档能否产出。

## 二、插件契约

**通过。** 自建包都声明了 `engines.dsh`；客户端插件声明了 `dsh.client`，产物经 `./client` 子路径提供。清单声明这一半有脚本可查：

```bash
node scripts/check-plugin-contract.mjs
```

```
插件 31 个、客户端插件 13 个、组合包 8 个、profile 9 个、纯库 0 个
插件契约检查通过
```

这一轮新增的包是 `host/model-provider`、`host/context-insights`、`host/skills`、`tool/skill-manage`、`client/model-provider`、`client/context-insights`、`client/skills`、`client/automation`，另有同级的 `hermes-adapter`、`hindsight-adapter` 与 `forge-bridge`。它们的接口与验收命令见 [兼容性与升级](compatibility.md) 与对应包的源码注释。

检查四类声明：插件包的 `engines.dsh`、客户端插件的 `dsh.client` 与 `./client` 子路径、组合包的 `dsh.bundle.patch` 及其指向的文件是否存在、profile 的 `dsh.profile.bundles`。

`dsh plugin --profile chatdsh-web add` 没有实际跑过——本部署的包以工作区链接形式安装，不是从登记处拉取。

## 三、工具可见性

**部分。** 宿主平面注册的工具进入预设的行列表，三档 preset 的 `plugins` 按档位列出工具行：聊天档只有网页抓取、任务清单与会话检索；工作档是默认档，文件、命令与自建产出类七项齐备；全量档在工作档之上补子代理、工作树、定时与浏览器操作。浏览器操作只挂在全量档，由用户显式选用该档位。这一层由契约检查覆盖：

```bash
node scripts/check-plugin-contract.mjs
```

```
工具 8 个；预设挂载 7 个：tool-artifact、tool-project、tool-share、tool-connector、tool-research、tool-image、tool-browser
插件契约检查通过
```

`ctx.tools.restrict` 与预设差异移除工具这两条没有验证：需要一次真实的会话与模型调用。

## 四、桌面控制

**未触及。** 两层的共同前提是 `@deepseek-ai/dsh-computer-use` 与 native 提供方，本机没有安装；Linux 层要求宿主挂载后核对 59 个工具与三档白名单，真机层要求 Windows x64 与 macOS 14 及以上。

## 五、客户端插件

**部分。** 产物可取回、条目图包含自建包、界面里出现自建内容这三条都有脚本化证据。

```bash
node scripts/verify-client-asset.mjs --profile chatdsh-web --package @chatdsh/client-projects
node scripts/verify-client-ui.mjs
```

十三个客户端包都能在模块图里找到并取回产物。界面验收用真实 Chrome 走完首次进入的流程（欢迎页、密钥页、工作区页），在预设选择页断言自建预设的说明文字出现——这一条已经成立。

面板本身的渲染没有断言成功：没有模型凭据时界面停在「选择一个工作区」，进不到主界面，侧栏与设置页都不渲染。脚本把这一步记为「未进入主界面，面板渲染未断言」，不作为失败条件。

客户端插件的 `inject` 有两处，语义不同：`package.json` 的 `dsh.client.inject` 写模块包名、管模块图排序；浏览器产物导出的 `inject` 写服务名、是运行时真正等待的依赖。两处都写错会让面板永久停在 pending。

### 5.1 主题插件与桌面壳

**通过（Web 层与 Windows 桌面壳均实测）。** 界面基础设计以客户端主题插件 `@chatdsh/client-theme` 进入运行时：它把 `ui-design/tokens.css` 的令牌与一段把 `--dsw-alias-*` 映射到 `--chatdsh-*` 的样式挂到文档上，并注册一个 `chatdsh` 主题方案。两套配色随上游 `data-ds-dark-theme` 同步到 `data-color-scheme`。

```bash
node scripts/verify-theme-ui.mjs
```

在真实 Chrome 的首屏断言样式节点已挂载、令牌解析为设计取值、上游别名已映射、两套配色可来回切换，全部通过。

Windows 桌面端为 `runtime/desktop/electron` 的 Electron 壳，编排逻辑在 `launch.mjs`，主进程在 `main.mjs`。真机验收在 Windows 主机上运行：

```bash
node scripts/verify-desktop-shell-win.mjs
```

它启动壳、拉起 `chatdsh-desktop` 运行时、在渲染进程里读取计算样式，核对画布 `#0e0e10`、面板 `#17181c`、品牌 `#4d6bfe`、成功/警告/危险三色、正文 13px、上游别名映射与设计字体族，并确认首次进入流程推进到自建预设（`ChatDSH 工作` / `ChatDSH 聊天`）与自建面板（`项目`、`上下文`）。该验收已在 `homedesktop`（Windows 11 x64、全局 `dsh` 0.2.1-rc.2）上通过。

壳的 Linux 侧编排与窗口也单独验过（`scripts/verify-desktop-shell.mjs`，用 xvfb 提供显示）。

桌面主进程与浏览器两侧都接入了遥测。浏览器侧由主题插件在安装时上报一次界面动作；主进程把启动三阶段、运行时编排与电源阻止编成 OTLP 交同一个中继。实测两端各产生六次中继尝试，未接线时为一次。

首次进入不再被模型凭据卡住：没有凭据时也能走完预设选择并进入主界面，自建面板按设计渲染；真实模型回合仍需要一份可用的提供方配置。

自建客户端面板按界面基础设计重做：新增共享组件包 `@chatdsh/core-ui-kit`，面板外壳、列表行、徽标、按钮、进度条、骨架与空/失败状态都只引用设计令牌；样式由主题插件随令牌一起注入。十二个面板（项目、上下文、制品、助手、模型提供方、技能、记忆、设备、分享、连接器、审批、自动化）的初始帧都由这套组件渲染。回归测试 `e2e/unit/panel-design.test.mjs` 逐个打包并服务端渲染，断言出现 `chdsh-panel`、`chdsh-skeleton`，且产物 HTML 不含十六进制或 rgba 颜色字面值。Windows 真机自检额外断言 DOM 里出现 `chdsh-*` 类名与面板外壳（实测 `kitNodes=7`、`kitPanels=2`）。

### 5.2 自建模型提供方

**通过（用本地 OpenAI 兼容替身实测；真实提供方用同一脚本复核）。** Web 与桌面 profile 支持用环境变量直接接入 OpenAI 兼容提供方，不依赖 `DEEPSEEK_API_KEY`：

```bash
export CHATDSH_PROVIDER_URL=https://provider.example/v1   # 基地址，含 /v1，不含 /chat/completions
export CHATDSH_PROVIDER_API_KEY=...                        # 密钥值，只留在进程环境
export CHATDSH_PROVIDER_MODEL=...                          # 模型 id
node scripts/verify-provider-chat.mjs
```

脚本启动真实 Chrome，走完首次进入流程，断言主界面显示该模型，发送一句话并等待助手回复；同时确认请求以 `Authorization: Bearer <密钥>` 发往 `${CHATDSH_PROVIDER_URL}/chat/completions`。三项变量齐全时默认模型切到 `chatdsh` 路由，缺省仍走控制平面网关（Web）或 `deepseek-official`（桌面）。可选变量 `CHATDSH_PROVIDER_NAME` 指定展示名，`CHATDSH_PROVIDER_API` 指定协议（默认 `openai-completions`）。

本地替身链路实测结果：

```
提供方端点：http://127.0.0.1:19999/v1
模型：test-model
主界面已显示自建提供方的模型
助手回复已到达界面
自建模型提供方端到端验收通过
```

### 5.3 Windows 安装器

**通过（Windows 11 真机）。** 单文件安装器 `ChatDSH-Setup-0.1.0-x64.exe` 在
`homedesktop` 上完成了解压安装、快捷方式创建与启动。安装后的客户端进入主界面，显示
自建面板与自建模型 `command-code/xiaomi/mimo-v2.6-flash`，发送「计算 123456+1」后
收到助手回复 `123457`。安装器把 `win-unpacked` 放进 `%LOCALAPPDATA%\Programs\ChatDSH`，
后续启动不再重复解压；`profile` 由主进程在数据根里建目录联接后交给随包 DSH 加载。


### 5.4 启动日志与端口顺延

**通过。** 启动页显示运行时最近 8 行输出与「已等待 Ns」，失败时显示异常正文、日志文件
路径和「打开本次日志」按钮；托盘菜单可打开本次日志与日志目录。桌面壳把运行时
stdout/stderr 写到 `%APPDATA%\chatdsh-desktop-shell\logs\desktop-<时间戳>.log`。

端口占用时自动顺延：在 `3151` 上起一个占位服务后跑桌面壳验收，日志记录
`端口 3151 被占用，顺延到 3152`，运行时就绪地址与断言都落在 `3152`。故意指定不存在的
DSH 入口时，启动页截图里能看到失败异常、完整日志路径和日志面板。

Windows 真机复核：在 `homedesktop` 上占住 `127.0.0.1:3080` 后启动安装版客户端，日志写入
`%APPDATA%\chatdsh-desktop-shell\logs\desktop-<时间戳>.log`，其中记录
`端口 3080 被占用，顺延到 3081`；运行时页面实际落在 `http://127.0.0.1:3081/`，随后发送
「计算 123456+1」收到 `123457`。


### 5.5 客户端经控制平面接入

**通过（Web 与桌面壳实测）。** 桌面壳启动控制平面，控制平面以配置的 DSH 入口拉起运行时并等待启动地址；桌面壳用启动口令调用 `/chatdsh/gateway/bootstrap` 换取运行时的带令牌路径，再把窗口指向控制平面。页面、API 与 `/api/remote.mux` 的 WebSocket 升级都经同一个反代，反代改写 `Host`、`Origin` 与 `Referer`，并把控制平面的设备 cookie 与运行时的会话 cookie 一起返回浏览器。

```bash
node --test e2e/unit/gateway-client-integration.test.mjs
node scripts/verify-desktop-shell.mjs --port 3124
```

第一条断言启动口令的鉴权顺序、设备 cookie、`Host`/`Origin` 改写、自动化启停落库与 WebSocket 升级转发；第二条用真实 Electron 壳、真实控制平面与真实运行时验证窗口地址落在控制平面上，页面可访问且桌面桥正常。控制平面自身的托管运行时就绪与退出回收见 `gateway/src/runtime.ts`，信号登记在 [telemetry.md](telemetry.md) 第六节。

### 5.6 Android 客户端

**通过（release APK 已构建并核对）。** Android 载体以上游 [Clarklevis1995/dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile) 为基础，源码分三层：`mobile/base` 是上游子树快照，`mobile/overlay` 是本仓库的适配，`mobile/android` 是合成出的构建目录（不进版本管理）。上游的协议解码、事件折叠、会话状态机与界面结构因此可以持续跟随，本仓库只维护真正不同的部分，分层与升级流程见 [Android 客户端](mobile.md)。

手机只与控制平面通信：配对码在控制平面换成设备令牌，每次启动用令牌换运行时的带令牌路径，业务通道是运行时的 `/ws/mobile`。控制平面在 WebSocket 升级阶段校验设备令牌后转发，插件只接受本机回环直连；配对载荷由控制平面按上游客户端的格式下发，客户端不需要改协议代码。令牌只存 SHA-256 摘要，设备吊销后 HTTP 与 WebSocket 同时拒绝。

```bash
node scripts/build-android.mjs
/opt/android-sdk/build-tools/35.0.0/aapt dump badging .run/apk/chatdsh0.4.0.apk
/opt/android-sdk/build-tools/35.0.0/apksigner verify --print-certs .run/apk/chatdsh0.4.0.apk
cd runtime && node scripts/verify-mobile-channel.mjs
cd runtime && node scripts/verify-mobile-telemetry.mjs
```

实测 `applicationId` 为 `com.clarklevis.dsh.android`，`versionName` 为 `0.4.0`（`versionCode` 13），release 包使用项目自有签名证书 `CN=ChatDSH`，签名校验通过。手机业务通道的验收由 `verify-mobile-channel.mjs` 用真实控制平面、托管运行时与真实插件完成：配对签发令牌、令牌换启动路径、未带令牌的升级被拒绝、配对子协议返回 `paired` 帧、带令牌的升级收到 `hello`（协议 3、21 项能力）、吊销后 HTTP 与 WebSocket 同时拒绝。遥测上报的验收由 `verify-mobile-telemetry.mjs` 完成：合法批次按信号分组计数、未登记属性计入丢弃、邮箱与内网地址与未登记名称被拒绝并给出原因、无效令牌返回 401。APK 下载服务监听 `CHATDSH_APK_BIND` 指定的地址与 8099 端口（缺省只监听回环），产物命名为 `chatdsh<版本号>.apk`。

## 六、存储替换

**未触及。** 当前只有 JSONL 一种会话日志后端，`bundle-storage-jsonl` 显式钉住 `session-persistence-jsonl`。

需要一份 Postgres 实现与对应的存储组合包。条件满足后：造一个 Postgres 实例，把存储组合包换掉，跑一遍「创建会话 → 重启运行时 → 按编号恢复并继续追加」，核对事件序号连续、没有重写；再把旧 JSONL 日志按 `seq` 顺序导入一次，确认导入后行为一致。

## 七、协议接入

**部分。** 创建会话、恢复会话与投影落盘有端到端证据。验收 profile 用独立的数据根，先建立链接再运行：

```bash
ln -sfn /workspace/chatdsh/runtime/e2e/profiles/chatdsh-acp /workspace/chatdsh/runtime/.run/verify-home/profiles/chatdsh-acp
DSH_HOME=/workspace/chatdsh/runtime/.run/verify-home node scripts/verify-acp.mjs --profile chatdsh-acp --cwd /workspace/chatdsh/runtime
```

脚本断言会话落盘后，投影缓存里存在全部 `chatdsh*` 投影单元（会话索引、用量、审批），并打印它们的值。

## 八、设备与路由

**通过。** 单账号形态下没有账号表、没有身份头部，请求的去向由设备归属决定：登记过的执行节点用节点令牌建立长连接，`/d/<deviceId>/` 前缀指向该设备，未登记的设备按不存在处理，没有前缀的请求仍走配置的运行时。

```bash
node scripts/verify-routing.mjs
```

```
通过：控制平面已监听 → 200
端口：控制平面 3190、设备 A 3191、设备 B 3192
通过：device-a 运行时已启动 → http://127.0.0.1:3191/
通过：device-b 运行时已启动 → http://127.0.0.1:3192/
通过：两台设备的长连接都已建立 → 两台都在线
通过：经 /d/A/ 落到设备 A → 200 {"ok":true,"service":"chatdsh-device-link"}
通过：经 /d/B/ 落到设备 B → 200 {"ok":true,"service":"chatdsh-device-link"}
通过：未知设备不回退到默认运行时 → 404 {"error":"device-not-found"}
通过：没有 /d/ 前缀的请求仍走默认运行时 → {"runtime":"default","path":"/probe"}
通过：杀掉设备 A 后它显示离线 → 已离线
通过：设备离线时 /d/A/ 返回 409 → 409
通过：设备 B 不受影响 → 200
按设备分派验收通过
```

两台真实 `dsh` 运行时各以节点令牌连上控制平面。默认通道用一个自报名字的替身服务承接，用来证明设备路由没有取代默认反代；未知设备的请求明确失败，不回退。

同一件事在两种形态的真实实例上也验过：

```bash
node scripts/verify-routing-live.mjs
```

```
控制平面已就绪：http://127.0.0.1:3191
实例 a 已启动：http://127.0.0.1:3192/
实例 b 已启动：http://127.0.0.1:3193/
通过：两台设备的长连接都已建立
设备 a 两次：096685c8461c/200 与 096685c8461c/200
设备 b 一次：f7bdf60ed4dd/200
通过：两台设备的首页都取到了
通过：同一设备的两次请求落到同一实例
通过：两台设备的请求落到不同实例
双设备分派验收通过
```

两个 `dsh` 实例各用独立数据根，分别以 `chatdsh-web` 与 `chatdsh-desktop` 形态启动（后者多启用一个侧栏面板，页面内联的启动条目因此不同）。同一设备的两次请求指纹一致、两台设备的指纹不同，说明反代确实按设备分派到了各自的实例。

架构文档还要求「在 A 里改插件清单与工作区路径，B 不受影响」，这一条没有验。实例各自的 `$DSH_HOME` 决定了配置与存储相互独立，但要验证「改一个实例的清单」还需要一个能修改单实例清单并观察到生效的手段：`--patch` 覆盖层不参与 `dsh --dump-config` 的装配，带着它启动也观察不到某个插件被禁用的迹象（见「已知限制」）。

### 8.1 旧库迁移

删除账号层改变了控制平面库的形状，旧库必须能原地迁移。验收脚本先造一份旧形态的库：`accounts` 表、十张表上的 `account_id` 列与引用它的索引、按账号分行的额度账本、主键里含账号列的 MCP 两张表；然后用这份库真实启动一次控制平面，做读写，最后直接打开库文件核对。

```bash
node scripts/verify-account-migration.mjs
```

```
旧库已生成：/workspace/chatdsh/runtime/.run/account-migration-1793363742985/gateway.sqlite
控制平面已用旧库启动：http://127.0.0.1:3192
通过：旧会话归属读到了
通过：旧会话归属保留了设备标识 → node-legacy
通过：旧会话归属保留了工作目录 → /work/legacy
通过：旧执行节点读到了且显示离线
通过：旧手机设备读到了
通过：旧自动化读到了
通过：旧 MCP 全局注册读到了
通过：旧 MCP 端点与凭据变量名读到了
通过：旧已读回执读到了
通过：旧分享链接仍可打开 → 200
通过：向旧会话追加副本成功 → {"written":1,"watermark":2}
通过：旧副本事件与新事件按序号连续 → [0,1,2]
通过：新已读回执写入成功 → 200
通过：新分享写入成功 → 200
通过：迁移后的额度读数是两个账号之和 → 402 {"error":{"code":"quota-exceeded","message":"额度不足"}}
通过：accounts 表已删除 → sessions,devices,replica_events,replica_watermarks,shares,push_queue,read_receipts,mobile_devices,node_devices,automations,llm_quota,mcp_servers,mcp_endpoints,automation_events
通过：所有表都不再有 account_id 列 → 
通过：没有索引引用 account_id → 
通过：llm_quota 并成一行且用量求和 → [{"key":"quota","used":420}]
通过：mcp_servers 重建后保留记录 → [{"name":"legacy-mcp"}]
通过：push_queue 的旧记录保留并补齐了新列 → [{"id":"push-legacy","stage":0}]
通过：迁移后的库可以再次启动（迁移幂等） → 
旧库迁移验收通过
```

迁移在一个事务里完成，重复执行是空操作。SQLite 不允许删除被索引或被主键引用的列，所以先删引用 `account_id` 的索引；主键里含账号列的两张 MCP 表与额度账本改为重建表再搬数据，额度按求和并成 `quota` 一行。旧库里两个账号的用量是 300 与 120，上限配成 400，迁移后的模型入口因此返回 402；任一账号的用量被丢掉，这条断言就会放行到上游。

## 九、聊天与记忆后端

**部分。** 记忆接入层的召回、写入、降级与召回注入有真实服务证据（Hindsight 在本机运行）：

```bash
node scripts/verify-memory.mjs
```

```
Hindsight 地址：http://127.0.0.1:8889
探活：可用
写入：{"items":1}（17645 毫秒）
召回：4 条
  - 蓝鲸的体长记录为三十米。
召回注入段：会话工作目录 "/workspace/chatdsh"，召回 bank t:default:ws:%2Fworkspace%2Fchatdsh、acct:local
会话 52119e9d-… 事件 29 个，模型请求 2 次
system 消息：1 条，长度为 2567 字
第一轮请求：消息 6 条，召回 1 条
第二轮请求：消息 9 条，召回 2 条
前缀比对：第一轮 29257 字节，第二轮开头 29257 字节，逐字节一致
记忆后端与召回注入验收通过
```

探活、写入、召回三段都走真实的 Hindsight。写入用同步方式，耗时约 18 秒——异步写入只要几十毫秒但整合完成后才可召回，验收里用同步换取确定性。

第二段起一个加载 `chatdsh-memory` 的 ACP 会话，连续两轮提问触发召回，再读该会话的 JSONL 日志核对注入方式：召回走 `agent/pre-step` 追加一条用户消息，`system` 因此只有开头一条；第二轮请求的消息前缀与第一轮逐字节一致，新增内容只出现在末尾。这一段需要测试模型网关的凭据（`CHATDSH_TEST_GATEWAY_API_KEY`），缺凭据时明确失败，`--skip-session` 只跑第一段并打印跳过原因。

本机 Hindsight 一次召回实测 21 到 23 秒，组合包的 `requestTimeoutMs` 因此设为 60000：五秒会让每次召回都走降级分支，记忆功能等于不可用。

```bash
node --test e2e/unit/memory.test.mjs
```

`chatBackend: hermes` 的组合没有验证，需要 Hermes 实例。

## 十、保活与强制不休眠

**未触及。** 强制不休眠与托盘常驻都只在 Windows 上实现，本机是 Linux。

需要一台 Windows 主机。条件满足后：开启强制不休眠，让机器空闲超过系统睡眠阈值，`powercfg /requests` 里应当出现本程序的 `SYSTEM` 与 `DISPLAY` 请求且机器不睡眠；关闭设置后两条请求消失。托盘常驻下关闭窗口进程仍在、通知照常；选择退出后进程消失、通知停止。

## 十一、推送

**部分。** 分级投递、离线队列与升级时刻在 `gateway/src/push.ts` 已实现，推送中枢自己按间隔扫描到期未处理的第一段通知并推给全部在线设备。缺的是真实客户端上的阈值表现，以及[架构文档第八节](architecture.md)列的三处：审批提醒、撤回、移动端后台通知。

```bash
# 两段式通知（阈值设小便于观察）
CHATDSH_PUSH_ESCALATION_MS=2000 node gateway/lib/main.js
```

## 十二、多客户端共存

**部分。** 事件流一致与已读同步有脚本化证据：

```bash
node scripts/verify-multi-client.mjs      # 两端读同一副本，序列一致、补齐正确、重复上报幂等
node scripts/verify-receipt-sync.mjs      # 一端上报已读，另一端收到带新水位的通知
```

```
客户端 A 读到序号 [0,1,2]
客户端 B 读到序号 [0,1,2]
补齐后读到序号 [0,1,2,3,4]，水位 4

上报已读：200
已读记录：[{"deviceId":"device-a","readUpToSeq":3,…}]
订阅 A 收到已读通知 1 条，订阅 B 收到 1 条
```

回执按设备标识区分；两个订阅在验收里用不同的设备标识，记录分得开。副本追加事件时也会向在线的其他设备广播一条 `kind: "replica"` 的通知，这是跨端实时一致性的数据来源——审批的 `approval/decided` 随会话事件进入副本，其他设备据此刷新后投影里已经没有待处理条目。

副本层的一面已经验过：同一序号带不同内容再来一次时先到者胜（`verify-multi-client.mjs` 里序号 4 的字节数保持 4，没有被后来的 99 覆盖），重复上报也不产生重复记录。会话层的「两端同时提交消息时两条都保留」需要一次真实回合，没有验。仍缺的：审批在另一端的呈现——`client-approval` 把审批记录列在设置页的区段里，客户端订阅了推送并在收到通知后刷新，但设置页要进主界面才能打开，无法观察两端的同一条记录是否同步；以及「通知先到最近活跃的一台，超过阈值才推给全部在线设备」在真实客户端上的阈值表现。

## 十三、远程执行节点

**未触及。** 本机只有一个执行节点。

需要第二台设备，或同一台机器上第二个独立的执行节点进程。条件满足后：从 B 把聊天转成落在 A 目录上的工作会话，核对 `deviceId` 与 `cwd` 写入后不可改；在 B 发消息由 A 执行并写 A 本地的会话日志，事件流回到 B；A 离线时该会话只读且明确报设备离线。

## 十四、跨设备会话

**部分。** 副本的按序号连续、断线补齐、只读镜像有证据（副本查询接口与分享快照）；控制平面侧的导入也有：

```bash
node scripts/verify-import.mjs
```

```
导入结果：200 {"sessionId":"4b9f3e03-9141-4736-b81e-7e370ee286ee","parentSession":"abcdef01-2345-6789-abcd-ef0123456789","watermark":2,"imported":3}
新会话副本序号：[0,1,2]，水位 2
归属记录：cwd=/work/b parent=abcdef01-2345-6789-abcd-ef0123456789
会话导入验收通过
```

导入在控制平面上建一条带 `parentSession` 的新会话，从源会话的副本复制事件，取请求里的工作目录与当前设备标识。源设备是否在线不参与这一步——读的是控制平面保存的副本，因此「源设备离线时导入仍可用」成立。

没有做的部分：客户端侧的「只读打开」界面与输入框禁用。

运行时侧已经具备恢复能力，装进 `bundle-hosted` 后挂在每个 profile 上（配置树里能看到 `chatdsh-import` 这一行，启动零激活警告）：

- `chatdshImport.seedOf(records)`：把控制平面副本还原成会话种子，六个单测覆盖
- `chatdshImport.restore({ sessionId, sourceSessionId, cwd, records })`：调 `ctx.sessions.create(id, { seed, meta: { cwd, parentSession, createdAt } })` 建本地会话

`restore` 没有端到端验证。远端方法的调用通道走客户端 SDK（`ctx.remote.<service>.<method>`），在浏览器页面里发起，命令行无法直接构造——查过 `dsh-typert-protocol`、`dsh-api-remotes`、`dsh-host-webserver` 的产物，都没有暴露可直接 `curl` 的 HTTP 路由。要验证它，需要一个能进到主界面的客户端，在页面上下文里调一次。环境里缺模型凭据，界面停在密钥页之前，因此这一条停在「类型层面接线正确、运行时装配完成」。

## 十五、会话副本

**通过。**

```bash
curl -s "http://127.0.0.1:3170/chatdsh/gateway/replica?sessionId=<id>"
```

返回按 `seq` 连续的事件、水位与事件本体；设备重连时按水位补齐。

## 十六、扩展包

**部分。** 安装与卸载、连接器的加载器行同步都有脚本化证据；界面出现面板这一条没有。

扩展包的装卸：

```bash
node scripts/extensions.mjs install packages/bundle/storage-postgres --profile chatdsh-web
node scripts/extensions.mjs remove  @chatdsh/bundle-storage-postgres --profile chatdsh-web
```

装与卸对称：一次往返之后 profile 的 `dependencies` 回到装卸前的指纹，`bundles` 回到原来的项数。安装时会读组合包的补丁层，把其中引用的自建插件一并补进依赖；卸载时收回这些依赖，别的在装组合包还在用的保留。

连接器把记录同步成加载器行：

```bash
node scripts/verify-telemetry-sync.mjs
```

```
运行时已启动
收到 1 个 trace 请求、1 个 log 请求
请求体里出现 chatdsh.connectors.sync：是
请求体里出现同步日志：是，connectors synced create=1 update=0 remove=0
```

数据根里预置一条启用的连接器记录，启动时同步依次做了「读记录、算计划、建行」，日志正文给出了三类动作的条数——创建 1 条、更新 0 条、删除 0 条。这条链路此前只有单元测试覆盖 `planMcpSync`，从没在运行时里执行过。

没有验证的部分：界面上出现连接器面板、MCP 服务器连上之后其工具以 `mcp__` 前缀进入工具目录（需要一次真实的 MCP 连接与能进主界面的客户端）。

MCP 连接本身已经验过：

```bash
node scripts/verify-mcp-connection.mjs
```

```
运行时已启动
探针收到的请求：["server/discover","initialize","notifications/initialized","tools/list"]
MCP 连接验收通过
```

数据根里放一条指向探针服务器的连接器记录（`e2e/fixtures/mcp-probe.mjs`，stdio 上的 JSON-RPC），启动后 MCP 客户端依次发起发现、握手、初始化通知与工具列表拉取。这条链路从「记录存在」一直到「服务器被真实调用」都通了；剩下没验的是拉回来的工具是否以 `mcp__` 前缀出现在模型可见的工具目录里，那要一次能进主界面的会话。

```bash
node scripts/extensions.mjs list    --profile chatdsh-web
node scripts/extensions.mjs install packages/bundle/storage-postgres --profile chatdsh-web
node scripts/extensions.mjs remove  @chatdsh/bundle-storage-postgres --profile chatdsh-web
```

安装后 `bundles` 从 4 项变 5 项，配置树里 `spill-policy` 的 `maxInlineTokens` 从 12500 变成组合包声明的 4000，导入警告为空；卸载后回到 12500，条目数与组合检查恢复原样。脚本按真实路径计算依赖的相对路径——数据根里的 profile 是符号链接，用链接路径算会多出一级。

界面出现面板与 MCP 工具以 `mcp__` 前缀进入目录这两条没有验证：前者需要浏览器，后者需要一次真实的 MCP 服务器连接。

## 十七、登录与两步验证

**未触及。** 控制平面目前只有 `authMode` 为 `tailscale` 一种形态，应用级登录与两步验证所需的字段与实现都没有。

需要通行密钥与登录配置的存储。条件满足后：`authMode` 为 `local` 时未经应用登录的请求在反代前被拒绝且不进入运行时；注册通行密钥后换域名需要重新注册；`twoFactor` 为 `totp` 时错误验证码连续失败达到阈值后锁定；设备会话 30 天有效，到期前 7 天内任一操作顺延 30 天，单台设备失效不影响其他设备。

## 十八、端到端

**通过。** 端到端验收用真实进程与真实依赖，不用替身：

```bash
export PATH=/usr/local/nvm/versions/node/v24.19.0/bin:$PATH
node scripts/verify-llm-router-live.mjs
```

模型主链路是这一轮新增的端到端项：

```
控制平面模型入口通过：200，可见文本 4 个字符，结束原因 stop
非流式上游通过：可见文本 4 个字符，结束原因 stop
路由器模型调用通过：可见文本 4 个字符，结束原因 stop，上游请求增加 1 次
运行时装配通过：http://127.0.0.1:3099/，路由器插件无激活告警
额度拒绝通过：402，错误码 quota-exceeded，上游请求未增加
模型主链路验收通过
```

这条脚本做五件事：起一个观测代理记录发往测试模型网关的请求数；起控制平面，断言入口把流式上游响应翻译成 DSH 分块并带回可见文本与 `stop`；让代理强制上游返回非流式 JSON，断言入口同样翻译出可见文本；用路由器导出的适配器走完整链路完成一次真实模型调用；最后把控制平面换到额度耗尽的实例，断言 402、`quota-exceeded`，且上游请求数不增加。凭据只从 `deploy/.env` 或环境变量读，脚本不打印请求体与模型输出原文。

控制平面入口与路由器另有单元验收：

```bash
node --test e2e/unit/gateway-llm-http.test.mjs
node --test e2e/unit/llm-router.test.mjs
```

它们覆盖真实 HTTP 入口的鉴权顺序与额度前置检查、请求结构到 OpenAI 消息的翻译、上游增量到 DSH 分块的翻译、额度守卫的单一读数、错误码映射，以及路由器服务的 `static inject` 与配置校验。

## 十九、上游契约一致性

**部分。** 三处直接依赖上游内部结构的实现已修正并加了针对性用例；上游包名与版本声明已收拢到适配层，脚本可查；其余接触面尚未逐项核验。

修掉的三处：

**审批的应答关联键。** 上游 `approval/request` 水位事件带的是 `agent`、`toolName`、`callId`、`reason`，没有 `id`——`id` 只存在于会话日志的 `approval/asked` 与 `approval/decided` 两条审计事件里，由审批服务在提出问题时生成，请求方看不到。原先的等待表用 `request.id` 作键，所有请求都落在空字符串上，客户端的应答永远打不中，`takeOver` 模式实际不可用。现在关联键取 `callId`，这是上游明确保证的稳定关联点；没有 `callId` 的请求按失败关闭处理，与上游「没有应答器即失败关闭」的语义一致。

```bash
node --test e2e/unit/approval-answer.test.mjs
```

**审批的待处理列表读面。** 投影的折叠是按会话驱动的，事件本身不带会话标识，原先从事件里取会话标识永远取不到，`pending` 与 `stats` 两个远端方法因此恒返回空。现在改从投影注册表的读面取状态，重启后恢复的会话也会在第一次读取时折叠出来。

**连接器的加载器条目标识。** 加载器在条目缺标识时自己生成一个随机值，生成出来的标识与同步计划里的对不上：下一轮同步会把同一台服务器当成新的再建一次，停用的连接器也永远匹配不到要移除的旧行。现在建行时显式给出标识。

```bash
node --test e2e/unit/connector-mcp.test.mjs
```

顺带修掉的两处接口误用：`host-import` 与 `host-connectors` 把计数器声明成「带属性即计数」，实际契约是取到句柄后调 `add`，这两个指标此前从未加过数；`host-memory` 的召回耗时记在累加计数器上，改为分布记录。

**上游包名的收拢。** 上游包名在源码与配置清单里出现时是字符串：补丁层按 `name` 匹配上游的行，名字写错时整条补丁被跳过，只是不生效；客户端插件的 `dsh.client.inject` 写错时面板永久停在 pending。这些名字原先散落在三个插件的源码、八份补丁层与八份客户端清单里，上游改名时要逐处排查。现在全部登记在适配层的 `UPSTREAM_PACKAGE_NAMES`，脚本核对各处出现的上游包名都在登记处出现过；适配层的单元测试再核对登记的包在 DSH 安装里真实存在。

```bash
node scripts/check-upstream-names.mjs
```

```
适配层登记的上游包名 36 个
上游包名收拢检查通过
```

**版本声明的收敛。** 上游判定兼容性时 `engines.dsh` 单独决定结果，peerDependencies 不参与。三十五个业务包的 `engines.dsh` 原先各自写精确版本 `0.2.1-rc.2`，上游每次发版都要改三十五个文件；现在统一写成 `>=0.2.1-rc.2 <0.3.0-0`，上游在 0.2.x 内发新版时业务包不需要改动。业务包也不再声明上游包的 peer 依赖——它们不直接 import 上游包，这些引用已经全部经由适配层转出，留在清单里只会在升级时多出要改的位置。唯一保留的例外是模块增强：`import type {} from '@deepseek-ai/dsh-session-projection'` 这类写法必须写真实包名才能挂到上游接口上，因此 `host-approval`、`core-session-index`、`host-usage` 三个包保留对应的 peer 声明。

适配层自身的 `engines.dsh` 与 peer 依赖仍写精确版本：它直接引用上游内部结构，版本要逐一核对。升级上游时的顺序是：先改适配层的版本声明与实现，跑适配层的测试，再按新内核版本回归 `runtime` 的验收脚本。

尚未核验的部分：宿主平面插件对上游事件名、`ctx` 服务名与内置行 id 的依赖面还没有逐项核验，升级上游版本时这些引用是首要风险点。

## 已知限制

**补丁覆盖层与配置转储的关系。** `dsh --patch <文件>` 是顶层选项（`--help` 里可见，位置要在应用参数之前）。但 `dsh --dump-config` 装配时只合入各组合包与 profile 的补丁层（`dsh-app-boot` 里是 `applyEntryPatches([], structuredClone(layers.flat()))`），不含 overlay——给 `tool-web` 写 `disabled: true` 之后转储没有任何变化，也没有警告。用转储核对覆盖层会得到假阴性，覆盖层是否生效只能在运行时观察，而当前还没找到合适的观察点。

**Hermes 承载聊天的验证边界。** `bundle-chat-hermes` 与 `host-chat-hermes` 已建立：组合包通过 `check-composition`（chatdsh-hermes 215 条），事件形状通过上游 `materializeAppendBatch` 与 `validateStoredEvents` 校验。`send` 的服务层写入已由 `e2e/unit/hermes-send.test.mjs` 覆盖：真实 Cordis 上下文、真实 JSONL 会话持久化、真实 Hermes 测试容器，断言两轮发送的 12 条事件与序号连续。Remote 方法经页面上下文的调用已经打通：`e2e/fixtures/client-remote-bridge` 手写自建服务的 descriptor 并 `$mount`，再用 `ctx.inject(['remote.chatdshHermesChat'])` 暴露命名空间；`scripts/verify-hermes-send-page.mjs` 在页面上下文创建会话并调用 `send`，断言 6 条事件与助手文本。产品客户端插件也按同一方案接入了各自的贡献，见下一条。

**记忆的自动写入优先使用模型摘要，模型不可用时退回规则抽取。** 插件在 `turn/end` 后读本回合的 user/message 与 assistant/message；配置 `summaryProvider` 与 `summaryModel` 时用 `ctx.llm.stream` 生成摘要，流式块同时兼容 `text` 与 `delta` 字段，输出按 4000 字符截断。调用失败或输出为空时退回 `composeTurnMemory`，并记录 `chatdsh.memory.degraded`（`operation: turn-summary`）；两个字段都缺省时保持规则抽取。同一会话的同一回合只写一次，写入链路与 bank 选择不变。真实回合已验证：`chatdsh-acp-live` 跑一次 prompt 后，Hindsight 文档的 `original_text` 是模型摘要而不是带「用户：」「助手：」前缀的规则文本，`acct:local` bank 收到写入并进入整合。

**共享工作区的记忆写入已接通。** 项目记录增加了 `shared` 标记，`project` 工具的 `set` 可以写入；回合写入时按 cwd 读项目记录，把 `shared` 传给 `banksFor`，共享工作区写组 bank，私有工作区写账号 bank。

**自建 Remote 面板已接通客户端贡献。** 新增 `@chatdsh/core-remote-client` 构造器，九个产品客户端插件在 `apply` 里手写 descriptor、`$mount` 后用 `ctx.inject` 等命名空间就绪再注册面板。`scripts/verify-remote-namespaces.mjs` 在真实页面里断言十个自建命名空间全部挂载，并对每个命名空间做一次只读调用，全部返回成功。审批、制品、助手、连接器等服务的 `remove` 与 Remote 命名空间服务自带方法冲突，宿主导出名改为 `delete`。

**客户端面板与网关 HTTP 分支有自动化覆盖。** 客户端面板已补上真实点击交互：`scripts/verify-connector-toggle-ui.mjs` 在设置页连接器区段点击「停用」，断言界面变成「（已停用）」且存储记录同步；设置页各面板的远程结果按 `{ ok, value }` 解包，模型提供方、技能、连接器区段均能渲染。网关的 webhook 路由由 `gateway-webhook-http.test.mjs` 覆盖鉴权顺序与落库，自动化启停、设备 cookie、`Host`/`Origin` 改写与 WebSocket 升级由 `gateway-client-integration.test.mjs` 覆盖。服务层的依赖注入由 `e2e/unit/service-contracts.test.mjs` 守住，它抓出过 `host/context-insights` 与 `host/model-provider` 漏写 `static inject`。

**主题插件契约不在本次验收范围。** [theme-plugin-contract.md](theme-plugin-contract.md) 定义了一套 `ctx.theme` 服务与主题插件的接入方式（`ctx.theme.register`、`ctx.theme.overrideTokens`、`theme/change` 事件、呈现适配器注入 CSS 变量）。架构文档第十二节没有对应条目，代码里也没有实现这套运行时。它描述的是可选能力的扩展点：启用时要先实现 `ctx.theme` 运行时与呈现适配器，再按该契约写主题插件。

**与部署文档的接缝差距。** [deployment.md](deployment.md) 第三节列出的是「必须从第一天就做对」的接缝。当前实现有几处尚未按最终形态落地：

- 登录配置还没有实现，`authMode` 只有 `tailscale` 一种取值。
- 时间戳存整数毫秒，文档要求 UTC ISO 8601 文本。换 Postgres 时两种格式要先统一才能迁移。
- 副本的 90 天不活跃回收没有实现；副本用量的三维统计（工作区、会话、设备）与按维度清理入口也没有。

这几条在单机自托管下不影响使用——没有登录层就不需要那些凭据字段，不换 Postgres 也不需要格式统一。它们会在启用登录层或切换存储后端时变成一次数据迁移。

**模型凭据。** 本机没有 `DEEPSEEK_API_KEY`；模型调用验收走宿主上的测试模型网关，密钥来自 `deploy/.env` 的 `CHATDSH_TEST_GATEWAY_API_KEY`，不依赖 DeepSeek 平台账号。

**浏览器驱动。** 本机装有 Chrome，可以通过调试协议驱动；第五项的界面验收用它走完了首次进入流程并断言了自建预设。缺的是 Playwright 一类的完整界面自动化，以及能进主界面的真实回合。

## 二十、模型主链路与额度

**通过。** `@chatdsh/host-llm-router` 把控制平面的模型入口注册成 DSH 的模型适配器，`stream()` 入口做额度检查；控制平面新增 `POST /chatdsh/gateway/llm`，读 SQLite 额度账本，把 DSH 请求翻译成 OpenAI 兼容请求，并把上游 SSE 翻译回 DSH 分块。

```bash
node scripts/verify-llm-router-live.mjs
```

最近一次结果：

```
控制平面模型入口通过：200，可见文本 4 个字符，结束原因 stop
路由器模型调用通过：可见文本 4 个字符，结束原因 stop，上游请求增加 1 次
运行时装配通过：http://127.0.0.1:3099/，路由器插件无激活告警
额度拒绝通过：402，错误码 quota-exceeded，上游请求未增加
模型主链路验收通过
```

上游响应按 `content-type` 分流：`text/event-stream` 逐帧翻译，`application/json` 整段翻译成同样的一组分块，其余类型回 502 并保留上游原文。`e2e/unit/gateway-llm-http.test.mjs` 覆盖三种分支。上游非 2xx 的响应按原状态码、原 `content-type` 与原响应体回传给调用方，入口不解析也不重组错误体。`e2e/unit/gateway-llm-http.test.mjs` 断言 402 的响应体与 `content-type` 原样到达，`e2e/unit/llm-router.test.mjs` 断言 `LlmUpstreamError` 带 `body`、`contentType` 与 `upstreamCode`，消息里是上游原文；`code` 只用于重试与遥测分支。

额度拒绝有两条独立证据。控制平面侧由 `e2e/unit/gateway-llm-http.test.mjs` 断言 402、`quota-exceeded` 与上游请求数为零；运行时侧由 `e2e/unit/llm-router.test.mjs` 断言 `LlmQuotaError` 同时带 `QUOTA` 与 `quota-exceeded`，且在发出请求之前抛出。上游返回 402、429 或额度类错误码时映射成 `QUOTA`，不进入可恢复失败的重试路径。

额度账本落在控制平面的 `llm_quota` 表，只有一行读数，进程重启不丢。启动初值由 `CHATDSH_LLM_QUOTA_USED` 给出，上限由 `CHATDSH_LLM_QUOTA_LIMIT` 给出，留空表示不限制。

运行时装配的回归点：路由器服务把 `llm` 写在 `static inject` 上，`e2e/unit/llm-router.test.mjs` 断言这条依赖清单。

## 二十一、MCP 服务端

**通过。** `@chatdsh/host-mcp-server` 把宿主工具目录暴露为 MCP 服务端。协议入口是一条独立的 HTTP 路由 `/mcp`，用 Bearer 令牌鉴权，不经过 `remoteAccess.decide()`；工具目录按调用方的会话归属过滤后再暴露，工具执行交给同一个 `ctx.tools` 注册表。

```bash
node scripts/verify-mcp-server.mjs
```

最近一次结果：

```
运行时已启动：http://127.0.0.1:3095/
MCP 握手通过：协议版本 chatdsh，工具 1 个
MCP 工具调用通过：返回 50 个字符
MCP 服务端验收通过
```

这条脚本起一个真实的 `chatdsh-web` 运行时并打开协议入口，用标准 MCP 客户端完成握手、列举与调用，同时断言没有令牌的请求返回 401。协议层另有单元验收：

```bash
node --test e2e/unit/mcp-server.test.mjs
```

它覆盖初始化协商、工具目录列举、工具调用、未鉴权拒绝、未知方法与未知工具的错误码、按作用域与会话过滤目录，以及标准 MCP 客户端的完整握手。协议 schema 与版本常量复用 `@modelcontextprotocol/core`，不另写一份。

默认关闭。打开时配置 `enabled: true`、`path` 与 `tokenEnv`；令牌缺失时插件在构造阶段抛出，运行时会报告这一行未激活，不会留下半个可用的协议入口。

## 二十二、MCP 接入

**通过。** MCP 接入把外部 MCP 服务的能力接进执行器。协议细节不由本项目实现：`@chatdsh/host-connectors` 只做配置分发，连接、握手、工具注册与重连交给 DSH 原生的 `dsh-mcp-client` 插件。

配置是全局注册的。控制平面的 `mcp_servers` 记录本机部署有哪些 MCP，`mcp_endpoints` 按设备保存连接参数。任一设备上报的服务器其他设备都能读到，因此 A 端配置的 MCP 在 B 端也看得见；同一台服务器在不同设备上可以是不同的连接方式。

```bash
node scripts/verify-mcp-registry.mjs
```

最近一次结果：

```
设备 A 上报通过：注册 1 台服务器，端点 1 段
设备 B 读取与上报通过：同一服务器 2 段端点，设备 device-a、device-b
按记录真实接入通过：2 个工具（resolve-library-id、query-docs）
单设备移除通过：另一段端点保留，全局注册仍在
MCP 注册表验收通过
```

这条脚本起真实控制平面，用两台设备标识上报与读取，再用设备 B 的记录经标准 MCP 客户端真实连接 context7 并列举工具。另有单元验收：

```bash
node --test e2e/unit/gateway-mcp-registry.test.mjs
node --test e2e/unit/mcp-config.test.mjs
```

覆盖全局注册、按设备端点、覆盖式上报、单设备移除后全局注册的保留与清理、凭据只存环境变量名，以及 VSCode `mcp.json` 格式的解析与端点转加载器配置。

配置格式沿用 VSCode 的 `mcp.json`：

```json
{
  "servers": {
    "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" },
    "notes": { "type": "stdio", "command": "npx", "args": ["-y", "notes-mcp"], "credentialEnv": "NOTES_TOKEN" }
  }
}
```

启用状态与凭据值都不进控制平面：是否接入由各端自己决定，凭据只同步环境变量名，值留在各端环境里。某台服务器在 A 端能连、B 端因网络条件连不上时，B 端记录仍在，工具目录里没有它的工具，其他端不受影响。

**MCP 服务端设计保留、默认关闭。** `@chatdsh/host-mcp-server` 把本执行器的工具目录暴露给外部程序，当前没有消费方，`chatdsh-web` 的补丁层把它设为 `enabled: false`。协议层与验收命令见第二十一节。

## 二十三、客户端外壳

**通过。** 控制平面在根路径返回自建的外壳页面，左栏聚合全部设备的会话，右栏是一个 iframe。页面与脚本都由控制平面自己托管，不依赖任何运行时的前端产物；设备全部离线时外壳照常打开，左栏照常列出会话并标出离线。

```bash
node scripts/verify-shell.mjs
```

最近一次结果：

```text
端口：控制平面 20160、设备 A 20161、设备 B 20162
通过：控制平面已监听 → 200
配对 device-a：deviceId=6db80d06-719c-4ad1-8f6b-dcc2ca773c2c
配对 device-b：deviceId=c357437e-e350-4d87-862a-77d7d7f1a960
通过：device-a 运行时已启动 → http://127.0.0.1:20161
通过：device-b 运行时已启动 → http://127.0.0.1:20162
通过：两台设备的长连接都已建立 → 两台都在线
通过：两台设备各建一条真实会话并改名 → A=session-54438dc6-ecfd-4b47-8a1c-3e32e6ed4bee、B=session-a412c303-c3a4-4d0a-959c-6869e912d4d3
通过：聚合会话列表从副本的标题事件取到标题 → A=外壳验收甲会话、B=外壳验收乙会话
通过：控制平面根路径返回自建外壳页面 → 200，346 字符
通过：外壳脚本由控制平面托管 → 200，10938 字节
通过：断言一：左栏出现两台设备 → 左栏设备：device-b、device-a
通过：断言二：左栏列出两台设备各自的会话
通过：断言三：点设备 A 的会话后右栏 iframe 的 src 指向 /d/<A>/ → /d/6db80d06-719c-4ad1-8f6b-dcc2ca773c2c/
通过：右栏 iframe 的目标页可取到运行时的索引页 → 状态 200，40959 字符
通过：按设备取插件清单返回组合包与插件行 → 200，组合包 23 个、插件行 226 条
通过：杀掉设备 A 后它显示离线
通过：断言四：杀掉 A 后重新打开外壳，A 标为离线且会话仍在列表里 → device-a：离线，会话 1 条
通过：设备离线时插件清单端点返回 409 device-offline → 409 {"error":"device-offline"}
客户端外壳验收通过
```

这条脚本起真实控制平面、两台真实 `dsh --profile chatdsh-web` 运行时与一台真实 Chrome。会话是设备侧真实创建的，标题用 `session/rename` 写进设备日志，再经副本上报流到控制平面。断言覆盖四项界面结论，另加三条端点证据：右栏目标页取得 200 的运行时索引页、插件清单取回真实组合包与插件行、设备离线时插件清单端点返回 409。

单元层面覆盖聚合的标题兜底与排序、根路径的页面与启动路径分流、插件清单的在线、离线与未知设备三条分支：

```bash
node --test e2e/unit/gateway-shell.test.mjs
```

插件清单的两个端点是实测确认的：`pluginManager/listBundles` 与 `pluginManager/listPlugins`，由 `dsh-plugin-manager` 登记在 Typert 的 Remote 映射里，未带运行时凭据时返回 401，端点不存在时返回 404。

界面上的两处限制：同一台设备内切换会话仍会重载 iframe（`postMessage` 通道未做），`/d/<deviceId>/api/remote.mux` 的 WebSocket 升级仍回 501，右栏的 Remote 走 HTTP 通道。

### 23.1 外壳交互

**通过。** 外壳补齐了跨设备写的两个选项、离线遮罩与输入框禁用、工作区按显示名合并、新建会话选设备与目录。

```bash
node scripts/verify-shell-interactions.mjs
```

最近一次结果：

```text
通过：断言一：同名工作区跨设备合并成一个节点（含两台设备的位置） → 工作区节点：shared；同名节点的位置数 2
通过：断言二：选中设备 A 的会话后右栏 iframe 指向 /d/<A>/ → {"src":"/d/d800165e-f738-445c-bd5e-c87d2f12ca0d/","overlayHidden":true,...}
通过：断言三：设备离线时右栏出现离线遮罩且输入框 disabled → {"src":"","overlayHidden":false,"inputDisabled":true,"overlayText":"device-a：设备离线"}
通过：断言四：设备恢复在线后遮罩消失、iframe 重新加载 → {"src":"/d/d800165e-.../","overlayHidden":true,...}
通过：断言五：新建会话后控制平面出现归属记录且 deviceId 正确 → {"sessionId":"session-c8c21fa9-...","deviceId":"da060e23-...",...}
外壳交互验收通过
```

两台设备的会话工作目录末段同名（`shared`），左栏因此把它们合并成一个工作区节点，节点下列出两台设备各自的一条会话。「在远程继续」把右栏指向该会话所在设备（deviceId 不变）；「在本机继续」调 `POST /chatdsh/gateway/import` 在默认运行时上 fork 出新会话，`cwd` 与 `deviceId` 是本机、`parentSession` 指向源会话；默认运行时没有登记为设备时该动作显示为不可用并说明原因。设备离线时右栏不加载 iframe，改为遮罩并在遮罩里放一个带 `disabled` 的输入框。

新建会话的目录在本形态下由用户手动输入：设备运行时的目录列举端点需要额外的界面凭据与交互，外壳先以手动输入路径交付，界面里写明这一点。前缀反代在控制平面到设备这一跳不带浏览器的 `Origin`、`Referer`、`Sec-Fetch-*` 头部，设备运行时的 `Host`/`Origin` 可信判定因此不会把外壳发出的同源请求当成跨源拒绝。

## 二十四、设置同步

**通过。** 设置按白名单命名空间跨设备同步：控制平面按命名空间存值与接收时刻，设备上报变更、接收推送后写本机 home 层补丁文件。

```bash
node scripts/verify-settings-sync.mjs
```

最近一次结果：

```text
通过：控制平面接受白名单命名空间的写入 → 200 {"namespace":"client-locale","key":"language","updatedAt":...}
通过：白名单之外的命名空间被拒绝 → 400 {"error":"namespace-not-whitelisted"}
通过：两台设备的长连接都已建立 → 两台都在线
通过：在设备 A 上改了 agent-default-model 的 model → 200 ... {"ok":true,...}
通过：断言三：设备 A 的设置变更上报到控制平面 → {"namespace":"agent-default-model","key":"model","value":"\"chatdsh-sync-...\"","updatedAt":...}
通过：断言四：设备 B 的 home 层补丁文件写入了同一设置 → - id: agent-default-model ⏎ name: '@deepseek-ai/dsh-agent-default-model' ⏎ config: ⏎ model: chatdsh-sync-...
设置白名单同步验收通过
```

白名单是五个命名空间：`agent-default-model`、`client-locale`、`client-ui-chat`、`client-product-analytics`、`agent-preset-registry`。白名单之外的命名空间（例如 `bash-local` 的 `cwd`、电源策略、工作区路径）不被接受，返回 400。设备侧插件监听 `loader/config-update` 与 `loader/volatile-update`，并按间隔扫描一次，把任何来源的白名单变更比对快照后上报；接收推送后按 id 合并写进 `$DSH_HOME/cordis.patch.yml`。冲突用最后写入者胜，时间取控制平面的接收时刻。

## 二十五、审批提醒与撤回

**通过。** 控制平面在副本上报里识别审批审计事件：`approval/asked` 推一条 `kind: approval` 的提醒，`approval/decided` 撤回尚未投递的同一会话同一关联键的提醒。

```bash
node scripts/verify-approval-notify.mjs
```

最近一次结果：

```text
通过：控制平面已监听 → 200
通过：断言一：approval/asked 进副本后在线设备收到审批提醒 → {"kind":"approval","sessionId":"session-...","toolName":"bash","callId":"call-..."}
通过：断言二：approval/decided 撤回尚未投递的提醒，重连后不再补发 → 重连后收到 0 条审批提醒，撤回的那条没有补发
审批提醒与撤回验收通过
```

脚本起真实控制平面与真实 SSE 订阅：在线时收到审批提醒；先让设备离线、把另一条审批提醒推进离线队列，再上报 `approval/decided`，设备重连后那条被撤回的提醒不再补发。审批的作答本身在右栏 iframe 里自然成立，这条只补「用户没打开那个会话时」的提醒；移动端后台通知仍未实现。
