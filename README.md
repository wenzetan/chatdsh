# ChatDSH

中文 | [English](README.EN.md)

ChatDSH 是面向官方 DSH（DeepSeek Harness）的跨设备互联插件集与自托管轻量中继服务端。用户直接使用官方 DSH 运行时与官方客户端（Web 端与 Desktop 端），通过标准插件命令安装仅追加的组合包 `@chatdsh/bundle`，配合自托管的轻量中继服务端 `@chatdsh/gateway`，即可实现公网跨设备访问、离线只读会话副本、本机恢复继续、白名单偏好设置同步、审批提醒推送与手机端 PWA 入口。

![ChatDSH 系统架构](assets/architecture.zh.jpg)

## 核心能力

- **仅追加插件交付**：`@chatdsh/bundle` 仅通过 `cordis.patch.yml` 的 `insert` 规则追加自有插件，保留上游 DSH 原生配置完整结构。全部客户端插件遵循 `platform: "web"` 契约，同一份产物同时运行在官方 Web 端与官方 Desktop 端。
- **出站多路复用隧道**：内网设备通过 `@chatdsh/host-device-link` 主动向中继服务端发起出站 WebSocket 连接（v2 帧协议，单连接最多 128 条并发逻辑通道，支持流量控制、心跳保活与代次替换），经 `/d/<deviceId>/*` 与 `/d/<deviceId>/api/remote.mux` 实时访问目标设备的官方 DSH 界面与流式接口。
- **本机同源中继代理**：浏览器跨来源访问中继时，由设备宿主侧回环白名单代理转发中继接口，自动剥离敏感头字段并校验 CSRF 标记，同时完整透传链路上下文。
- **离线只读副本与本机继续**：各设备本地 `$DSH_HOME` 始终保存权威会话日志。`@chatdsh/host-push` 持久化补传意图并按顺序上报完整事件信封至中继 SQLite；设备离线时可随时浏览只读时间线，并通过 `@chatdsh/host-import` 在当前设备恢复或分叉继续会话。
- **白名单偏好同步**：`@chatdsh/host-settings-sync` 仅同步 5 个通用偏好命名空间（默认模型、界面语言、聊天视图、分析开关、预设注册表），本机路径与设备运行参数留在各自设备上。
- **手机端 PWA 与审批推送**：中继根路径 `/` 内置可安装的移动端 PWA，聚合在线设备状态、会话列表、只读副本与 IndexedDB 离线草稿；副本出现审批请求时通过 SSE 与 Web Push 推送提醒，审批完成后自动撤回同键待投递提醒。
- **统一可观测性**：内置基于 OpenTelemetry 的遥测管道（默认对接本机 OpenObserve），支持 W3C `traceparent` 跨端链路传播，并提供环境变量、设置文件、启动参数与运行期热开关等多种即刻关闭入口。

## 项目结构

| 目录 | 说明 |
|---|---|
| [`dsh-adapter/`](dsh-adapter/) | 适配层 `@chatdsh/adapter`：聚合上游 DSH 7 个直接 `peerDependencies` 与 13 个登记包名，作为业务插件访问 DSH 内部 API 的唯一边界 |
| [`runtime/packages/core/`](runtime/packages/core/) | 共享核心包：`@chatdsh/core-contracts`、`@chatdsh/core-diagnostics`、`@chatdsh/core-remote-client` |
| [`runtime/packages/host/`](runtime/packages/host/) | 设备宿主插件：`telemetry`、`device-link`、`push`、`import`、`settings-sync` |
| [`runtime/packages/client/`](runtime/packages/client/) | 客户端插件：`telemetry`、`pwa`、`remote`（支持官方 Web 端与 Desktop 端） |
| [`runtime/packages/bundle/chatdsh/`](runtime/packages/bundle/chatdsh/) | 组合包 `@chatdsh/bundle`，供 `dsh plugin add` 一步装入全部宿主与客户端插件 |
| [`runtime/gateway/`](runtime/gateway/) | 独立运行的轻量中继服务端 `@chatdsh/gateway`，提供设备隧道、前缀转发、只读副本、推送中枢、白名单设置同步与手机端 PWA |
| [`runtime/docs/`](runtime/docs/) | 架构设计、部署运维、遥测规范、兼容性与隐私防护文档 |
| [`runtime/scripts/`](runtime/scripts/) | 构建脚本、静态检查、上游升级验证与端到端验收脚本 |
| [`runtime/e2e/unit/`](runtime/e2e/unit/) | 单元测试与回归测试 |

## 快速开始

### 推荐方式：由 AI Agent 协助完成部署与接入

推荐直接将本项目交给具备终端执行能力的 AI Agent（如官方 DSH、Claude Code、Codex 等），发送以下指令按 [`runtime/docs/agent-deploy-guide.md`](runtime/docs/agent-deploy-guide.md) 逐步完成部署：

```text
请先阅读 runtime/docs/agent-deploy-guide.md，按其中的流程帮我部署 ChatDSH 中继服务端并接入本机 DSH。
```

AI Agent 会严格按以下流程协作执行：

1. **网络与穿透环境探测**：自动检查宿主机网卡、Tailscale / Cloudflare Tunnel / FRP / WireGuard 等内网穿透工具及现有反向代理端口，再结合本机实际情况向你询问必填的对外域名与联网方式。
2. **中继容器部署与网络指引**：调用 `bash scripts/relay-up.sh` 以 Docker Compose 拉起中继容器（首次自动生成随机配对口令并按 `0600` 权限持久化复用），探测公网连通性；若需配置反向代理或穿透规则，先展示完整变更并征得同意后再操作。
3. **代劳安装 DSH 插件与持久服务确认门禁**：主动询问是否需要代劳在本机安装 `@chatdsh/bundle` 并完成配对接入；确认代劳后先检查是否存在由 `systemd`（`systemctl`）、`launchd`、`pm2`、`supervisord` 等托管的持久化 DSH 服务。发现持久服务时，必须先列出服务文件路径、拟注入的 `EnvironmentFile` 变更及重启影响，取得你的明确同意后再修改服务文件与重启。

### 手动命令行部署

#### 1. 环境要求

- 中继宿主机：Docker 与 Docker Compose、Bash 与 `curl`（无需在宿主机安装 Node.js）
- 接入设备：Node.js 22 及以上、pnpm 11.21.0、官方 DSH（`@deepseek-ai/dsh`，当前验证基线 `0.2.2-rc.3`）

#### 2. 一行命令启动中继服务端（Docker Compose）

```sh
bash scripts/relay-up.sh
```

首次运行时脚本会通过命令行询问中继对外域名（必填，例如 `relay.example.com` 或 `https://relay.example.com`），检查 `.env` 是否已配置配对口令，未配置时自动生成高熵随机口令并保存（文件权限 `0600`，下次运行自动复用），随后通过 [`docker-compose.yml`](docker-compose.yml) 构建并拉起中继容器。

容器就绪后，脚本会自动探测公网域名连通性（尚未配置域名解析或反向代理时输出明确的 DNS 与反向代理指向 `http://127.0.0.1:3170` 指引），并打印一条可在任意设备上复制执行的一行接入命令。后续如需再次查看该命令，在中继宿主机执行：

```sh
bash scripts/relay-up.sh --print-join-command
```

生产环境建议在宿主机通过 Nginx、Caddy 或 Tailscale Serve 等前置网关向 `127.0.0.1:3170` 转发流量并终止 TLS（配置示例见 [`runtime/docs/deployment.md`](runtime/docs/deployment.md)）。

#### 3. 一行命令在设备安装插件、配对并启动 DSH

如果是首次从本仓库源码安装，先完成一次本地构建：

```sh
cd dsh-adapter && pnpm install && node scripts/link-dsh-deps.mjs && pnpm build && cd ../runtime && pnpm install && node scripts/link-dsh-deps.mjs && pnpm build && pnpm build:client && cd ..
```

随后直接粘贴上一步中继启动后输出的一行命令：

```sh
bash scripts/device-join.sh --relay https://relay.example.com --code '<上一步输出的配对口令>'
```

该命令自动完成三件事：将 `@chatdsh/bundle` 安装到官方 `web` profile、向中继完成配对并将设备凭据保存到 `$DSH_HOME/chatdsh-device.env`（权限 `0600`）、以配对凭据启动官方 DSH。后续在同一设备重启只需执行 `bash scripts/device-join.sh`。

连接成功后，可通过中继地址 `/` 使用手机端 PWA，通过 `/d/<deviceId>/` 直接进入对应在线设备的官方 DSH 界面，或在本地官方客户端侧栏打开「远程设备」面板。

## 文档导航

- 文档总纲与构成基线：[`runtime/docs/README.md`](runtime/docs/README.md)
- 总体架构与模块边界：[`runtime/docs/architecture.md`](runtime/docs/architecture.md)
- 部署、环境变量、VAPID、备份与升级：[`runtime/docs/deployment.md`](runtime/docs/deployment.md)
- AI Agent 自动化部署与接入指南：[`runtime/docs/agent-deploy-guide.md`](runtime/docs/agent-deploy-guide.md)
- 遥测规范与信号登记清单：[`runtime/docs/telemetry.md`](runtime/docs/telemetry.md)
- 上游 DSH 兼容性与升级验证：[`runtime/docs/compatibility.md`](runtime/docs/compatibility.md)
- 凭据与隐私防护钩子：[`runtime/docs/secret-guard.md`](runtime/docs/secret-guard.md)
- 适配层包说明：[`dsh-adapter/README.md`](dsh-adapter/README.md)
- 运行时工作区说明：[`runtime/README.md`](runtime/README.md)

## 验证与开发注意事项

在 `runtime/` 目录下运行完整编译、静态检查、单元测试与九条端到端验收脚本：

```sh
cd runtime
node_modules/.bin/tsc -b tsconfig.build.json --force
pnpm --config.verify-deps-before-run=false build:client
pnpm --config.verify-deps-before-run=false check:telemetry
pnpm --config.verify-deps-before-run=false check:plugins
node scripts/check-upstream-names.mjs
pnpm --config.verify-deps-before-run=false check:layering
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false verify:plugin-install
pnpm --config.verify-deps-before-run=false verify:device-link
pnpm --config.verify-deps-before-run=false verify:routing
pnpm --config.verify-deps-before-run=false verify:settings-sync
pnpm --config.verify-deps-before-run=false verify:approval-notify
pnpm --config.verify-deps-before-run=false verify:import
pnpm --config.verify-deps-before-run=false verify:receipt-sync
pnpm --config.verify-deps-before-run=false verify:multi-client
pnpm --config.verify-deps-before-run=false verify:mobile-telemetry
```

环境注意事项：

- **依赖预装环境**：运行 `pnpm` 命令时可附加 `--config.verify-deps-before-run=false` 跳过锁文件校验。
- **`GIT_CONFIG_COUNT` 变量**：部分托管环境注入不完整的 `GIT_CONFIG_COUNT` 会导致 `git` 退出，执行命令时可使用 `env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git <子命令>`。
- **隐私防护钩子**：克隆仓库后在 `runtime/` 目录运行 `bash scripts/install-hooks.sh` 启用提交与推送前敏感信息检查。

## 参考项目与致谢

### 上游框架与开源基础

感谢以下开源项目与基础设施为 ChatDSH 提供底层运行时、插件系统、可观测性与构建能力：

- **[DeepSeek Harness (`@deepseek-ai/dsh`)](https://www.npmjs.com/package/@deepseek-ai/dsh)** 与 **Cordis 插件框架**：提供核心代理运行时、会话持久化、官方 Web/Desktop 客户端与插件加载机制。
- **[OpenTelemetry](https://opentelemetry.io/)** 与 **[OpenObserve](https://openobserve.ai/)**：提供标准 OTLP 日志、链路追踪、指标协议与轻量级本地观测存储。
- **[Zod](https://zod.dev/)** 与 **[esbuild](https://esbuild.github.io/)**：提供跨组件契约校验与客户端插件打包。

### 生态参考项目

感谢以下 DSH 生态与开源项目的探索与实践，它们在桌面端集成、移动端交互、远程隧道与多包工程组织等方面为 ChatDSH 的架构取舍提供了宝贵参考。本地参考快照登记于 [`runtime/refer-repos.json`](runtime/refer-repos.json)（不纳入版本管理）：

```sh
node runtime/scripts/clone-refer-repos.mjs               # 拉取清单中的全部参考仓库
node runtime/scripts/clone-refer-repos.mjs --only dsh-Go # 拉取指定仓库
node runtime/scripts/clone-refer-repos.mjs --list        # 查看清单
```

| 目录 | 上游 | 作用 |
|---|---|---|
| `dataelement_dsh-desktop` | [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) | Electron 桌面端构建与权限核对 |
| `anywhere-labs_dsh-desktop` | [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | 多包工作区与通道更新核对 |
| `Clarklevis1995_dsh-mobile` | [Clarklevis1995/dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile) | 移动端客户端与内核职责划分 |
| `Clarklevis1995_dsh-plugin-mobile-gateway` | [Clarklevis1995/dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway) | 移动网关插件接入方式 |
| `saya-ch_dsh-mobile` | [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) | 浏览器侧独立 npm 包形态与窄屏抽屉布局 |
| `shaobeichen_dsh-pocket` | [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket) | 轻量客户端反向代理与插槽注册 |
| `kelai141_dsh-mobile-apk` | [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) | 移动设备本地运行环境核对 |
| `dsh-Go` | [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) | 远程连接协议与插件界面边界核对 |
| `ds-harness-remote` | [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) | 主机常驻远程隧道、多路复用流与端到端加密对照 |
| `ZCode` | [zai-org/ZCode](https://github.com/zai-org/ZCode) | 多包仓库组织方式 |
| `rea_workbuddy` | 无远端 | 协议与认证对照材料，本地快照 |
