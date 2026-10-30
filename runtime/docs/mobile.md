# Android 客户端

Android 应用以上游 [Clarklevis1995/dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile) 为基础。源码分三层放在 [`mobile/`](../mobile)：`base/` 是上游 Android 子树的原样快照，`overlay/` 是本仓库的适配，`android/` 是合成出的构建目录且不进版本管理。上游的协议解码、事件折叠、会话状态机与界面结构因此可以持续跟随，升级流程见 [`mobile/README.md`](../mobile/README.md)。

## 接入流程

1. 首次启动填写控制平面地址与配对码，或直接粘贴控制平面下发的配对载荷。
2. 配对走两条等价路径：`POST /chatdsh/gateway/mobile/pair`，或按上游客户端的习惯用子协议 `dsh-pair.<code>` 连 `/ws/mobile` 并收到 `paired` 帧。两条路径都只保存令牌的 SHA-256 摘要。
3. 应用把设备令牌写入 Android Keystore；之后每次启动调用 `GET /chatdsh/gateway/mobile/session`，用令牌换取运行时的带令牌路径。
4. 应用用原生 HTTP 客户端访问带令牌路径，控制平面完成登录并下发会话 cookie。
5. 业务通道是 `/ws/mobile`：控制平面在 WebSocket 升级阶段校验设备令牌，通过后转发到运行时插件。会话列表、创建会话、发送消息与实时事件都沿用上游插件协议。
6. 令牌失效时回到配对页；运行时未就绪时显示重试入口。
7. 遥测经控制平面端点 `POST /chatdsh/telemetry/mobile` 上报，设备令牌鉴权，关闭遥测后端点返回 404。

配对与取启动路径的失败分支都会写 `chatdsh.gateway.mobile.rejected` 事件并累加 `chatdsh_mobile_pairings_total` 或 `chatdsh_mobile_sessions_total`。WebSocket 升级被拒绝时写 `chatdsh.gateway.mobile.upgrade.rejected` 并累加 `chatdsh_mobile_upgrades_total`。设备管理端点 `GET /chatdsh/gateway/mobile/devices` 与 `DELETE /chatdsh/gateway/mobile/devices?id=<deviceId>` 使用网页身份，吊销后同一令牌在 HTTP 与 WebSocket 上同时失效。

控制平面配对只在设置 `CHATDSH_PAIRING_CODE` 时开放，未配置时返回 404。手机设备会同时登记到设备表，平台记为 `android`。

## 控制平面、运行时与插件

手机只与控制平面通信。控制平面既是配对与设备令牌的唯一签发方，也是业务通道的唯一入口；运行时不对外监听，运行时内的移动网关插件只在本机回环上提供 `/ws/mobile`。

| 环节 | 承担方 | 说明 |
|---|---|---|
| 填写控制平面地址与配对码 | 手机 | 手工输入，二维码可由控制平面下发的配对内容承载 |
| 配对与设备令牌签发 | 控制平面 | `POST /chatdsh/gateway/mobile/pair`，令牌只存 SHA-256 摘要 |
| 换取运行时启动路径 | 控制平面 | `GET /chatdsh/gateway/mobile/session` |
| 会话列表、建会话、发消息 | 运行时 | 经控制平面反代到 `/api` 的单次 RPC |
| 实时会话事件与审批回放 | 运行时插件 | 经控制平面反代的 `/api/remote.mux` 与 `/ws/mobile` |
| 设备吊销 | 控制平面 | `DELETE /chatdsh/gateway/mobile/devices?id=<deviceId>`，吊销后 HTTP 与 WebSocket 同时拒绝 |

插件在 `profiles/chatdsh-web` 里以 `dsh-plugin-mobile-gateway` 依赖挂载，配置见该 profile 的 `cordis.patch.yml`。插件自身的设备鉴权关闭（`requireAuth: false`），因为唯一入口是控制平面，鉴权在控制平面完成；插件也不开独立局域网监听（`lanEnabled: false`）。插件的设备与状态文件通过 `dshHomePath` 落在数据根下，缺省会写到用户主目录，只读环境下会导致整行不激活。

`session-query-sqlite` 这一行在插件包与本 profile 的补丁层里各出现一次。实测最终生效的是本 profile 的配置（`openAt: startup`），数据根下会生成 `session-index.sqlite`；插件包里的 `:memory:` 与 `first-search` 没有覆盖它。

两条验收命令：

```bash
cd runtime
node scripts/check-mobile-plugin.mjs      # 挂载配置的静态核对
node scripts/verify-mobile-channel.mjs    # 真实控制平面 + 托管运行时 + 真实插件，走完配对、取路径、鉴权升级、吊销
```

## 网络出口

ClashMi、EasyTier 与 ZeroTier 都以 Android VPN 形式接入。Android 的按应用代理会把新安装应用排除在 VPN 默认路由之外，表现为浏览器能访问 `192.0.2.10`，应用的原生 socket 却从 Wi-Fi 地址出网。

设置页还提供 `ClashMi 代理` 输入框。填写 ClashMi 的混合代理端口（常见为 `127.0.0.1:7890`）后，OkHttp 的 HTTP 与 WebSocket 都经该 HTTP 代理出网，ClashMi 再按分流规则转发到 ZeroTier。代理留空时使用 VPN 套接字绑定。

原生客户端不依赖 WebView 的网络进程。`NetworkRoute` 枚举带有 `TRANSPORT_VPN` 的网络，把 OkHttp 的 `SocketFactory` 与 `Dns` 绑定到该网络，HTTP 与 WebSocket 都从 VPN 接口出网。没有活动 VPN 时保持系统默认选择。

## 与上游的代码边界

上游的仓库结构里，协议解码、事件折叠、会话状态机、投影与历史同步都在 `shared/`，界面结构在 `androidApp/`。这些整体保留，本仓库不改。分界如下：

| 事项 | 归属 |
|---|---|
| DSH 协议解码、事件折叠、会话状态机、投影与历史同步 | 上游 `shared/` |
| 界面结构、Compose 组件、导航、会话页与设置页 | 上游 `androidApp/` |
| 控制平面配对与设备令牌保存 | 上游 `AndroidMultiGatewayStore` 与 `shared/` 传输层，配对在控制平面的 WebSocket 通道上完成；HTTP 配对契约的原生客户端是新增的 `ControlPlanePairing.kt` |
| 配色令牌与深浅色映射 | 本仓库接管 `DshTheme.kt` |
| 移动端遥测上报 | 本仓库新增 `MobileTelemetry.kt` |
| 构建、签名、版本号、产物分发 | 本仓库 `scripts/` |

接管文件与新增文件在 `mobile/overlay/manifest.json` 里逐条登记，并记下被接管文件对应的上游原文摘要。分层原因与上游升级流程见 [`mobile/README.md`](../mobile/README.md)。

## 界面规范

App 按 [`ui-baseline-design.md`](ui-baseline-design.md) 的令牌实现，颜色集中在接管后的 `DshTheme.kt` 里的 `DshColors`：

| 用途 | 令牌 |
|---|---|
| 画布、一级面板、二级面板、代码块 | `Canvas` `#0e0e10`、`Panel` `#17181c`、`PanelRaised` `#1b1d22`、`Code` `#121317` |
| 结构线与控件边框 | `Line` `#24262c`、`LineStrong` `#30333b` |
| 文字层级 | `InkPrimary` `#f3f5f9`、`Ink` `#c7ccd6`、`Muted` `#9aa1ad`、`Faint` `#858d9a` |
| 品牌与状态 | `Brand` `#4d6bfe`、`BrandFill` `#3d56e8`、`Success` `#3fb37f`、`Warning` `#e8b04b`、`Danger` `#ff7b7b` |
| 用户消息 | `Bubble` `#2e3f9e`、`BubbleInk` `#e6eaff` |

亮色取值在 `DshColors.Light` 里，与暗色保持同一语义映射。上游页面继续使用它原有的名字（`DshColors.Ocean`、`DshColors.Ink`、`DshColors.Success` 等），这些名字现在指向同一套设计令牌，因此换配色不需要逐个页面改。

## 构建

```bash
cd runtime
node scripts/build-android.mjs
```

构建固定使用 `assembleRelease`。签名密钥在首次构建时生成到 `.run/android-signing/chatdsh-release.keystore`，后续构建复用它，保证覆盖安装。构建脚本会依次做四件事：

1. 读取 `mobile/android/version.properties` 的版本号与 versionCode。
2. 调用 `mobile/android/gradlew assembleRelease`。
3. 把产物复制成 `.run/apk/chatdsh<版本号>.apk`。
4. 确保 APK 下载服务在 `CHATDSH_APK_BIND` 指定的地址上运行，并打印下载地址。

命名规则固定为 `chatdsh<版本号>.apk`，例如 `chatdsh0.4.0.apk`。每次构建完成后必须把下列形式的地址交给使用者：

```
http://<CHATDSH_APK_BIND>:8099/chatdsh<版本号>.apk
```

下载服务单独启动时：

```bash
CHATDSH_APK_BIND=192.0.2.10 node scripts/serve-apk.mjs --port 8099
```

它绑定 `CHATDSH_APK_BIND` 给出的地址（缺省只监听回环），提供 `.run/apk` 下的 APK 与一个列出全部产物的首页。构建脚本检测到服务未运行时会自动拉起。

## 版本与验收

`mobile/version.properties` 是版本号的唯一来源，Gradle 的 `versionName` 与 `versionCode` 都从它读取；合成时它被复制到构建目录根部。

```bash
# 核对包名、版本号与签名
/opt/android-sdk/build-tools/35.0.0/aapt dump badging .run/apk/chatdsh0.4.0.apk
/opt/android-sdk/build-tools/35.0.0/apksigner verify --print-certs .run/apk/chatdsh0.4.0.apk

# 核对下载地址可访问
curl -I http://192.0.2.10:8099/chatdsh0.4.0.apk   # 地址按 CHATDSH_APK_BIND 的取值替换
```

三条端到端验收命令，全部使用真实控制平面、托管运行时与真实插件：

```bash
node scripts/check-mobile-plugin.mjs      # 插件挂载配置的静态核对
node scripts/verify-mobile-channel.mjs    # 配对、取路径、鉴权升级、配对子协议、吊销
node scripts/verify-mobile-telemetry.mjs  # 遥测批次接收、属性丢弃与内容边界
```

单元层面，控制平面的配对、取启动路径、设备管理与遥测中转由 `e2e/unit/gateway-mobile-telemetry.test.mjs` 覆盖；上游分层与升级流程由 `scripts/check-mobile-upstream.mjs` 与 `scripts/sync-mobile-base.mjs --check` 覆盖。
