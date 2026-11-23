# ChatDSH 运行时工作区

本目录包含面向官方 DSH（Web 端与 Desktop 端）的纯附加插件集 `@chatdsh/bundle`、轻量中继服务端 `@chatdsh/gateway`、共享核心包、校验脚本与文档。

## 文档入口

- 总纲与构成基线：[`docs/README.md`](docs/README.md)
- 总体架构：[`docs/architecture.md`](docs/architecture.md)
- 部署、运行、备份与升级：[`docs/deployment.md`](docs/deployment.md)
- 遥测规范与信号清单：[`docs/telemetry.md`](docs/telemetry.md)
- 升级与兼容验证：[`docs/compatibility.md`](docs/compatibility.md)
- 凭据与隐私防护：[`docs/secret-guard.md`](docs/secret-guard.md)

## 前置条件

- Node.js 22 及以上
- pnpm 11.21.0
- 官方 DSH `@deepseek-ai/dsh`，本机基线 `0.2.2-rc.3`

## 构建与校验

新检出的仓库：

```sh
cd ../dsh-adapter
pnpm install
node scripts/link-dsh-deps.mjs
pnpm build
pnpm test

cd ../runtime
pnpm install
node scripts/link-dsh-deps.mjs
pnpm build
pnpm build:client
```

依赖已经预装的环境使用以下命令：

```sh
node_modules/.bin/tsc -b tsconfig.build.json --force
pnpm --config.verify-deps-before-run=false build:client
pnpm --config.verify-deps-before-run=false check:telemetry
pnpm --config.verify-deps-before-run=false check:plugins
node scripts/check-upstream-names.mjs
pnpm --config.verify-deps-before-run=false check:layering
pnpm --config.verify-deps-before-run=false test
```

## 启动轻量中继（默认 Docker Compose）

在仓库根目录执行一行命令：

```sh
cd ..
bash scripts/relay-up.sh
```

首次运行会询问对外域名（必填）并自动生成随机配对口令保存到 `.env`（下次复用），拉起容器后输出一行设备接入命令。再次打印该命令执行：

```sh
bash scripts/relay-up.sh --print-join-command
```

## 一行命令安装插件并配对设备

在设备上粘贴中继启动后输出的一行命令：

```sh
bash scripts/device-join.sh --relay https://relay.example.com --code '<中继配对口令>'
```

后续在同一设备上重启只需执行 `bash scripts/device-join.sh`。完整容器、反向代理与直接进程运行说明见 [`docs/deployment.md`](docs/deployment.md)。

## 环境变量

| 变量 | 默认值 | 行为 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 中继与设备运行时的数据根 |
| `CHATDSH_GATEWAY_HOST` | `127.0.0.1` | 中继监听地址 |
| `CHATDSH_GATEWAY_PORT` | `3170` | 中继监听端口 |
| `CHATDSH_GATEWAY_DB` | `$DSH_HOME/gateway/gateway.sqlite` | 中继 SQLite 路径 |
| `CHATDSH_PUBLIC_URL` | 未设置 | 对外精确 origin；监听通配地址时必填 |
| `CHATDSH_PAIRING_CODE` | 未设置 | 节点与手机配对口令；缺失时配对端点返回 404 |
| `CHATDSH_PUSH_MODE` | `two-stage` | 只有 `all-at-once` 切换为一次性投递 |
| `CHATDSH_PUSH_ESCALATION_MS` | `120000` | 两阶段投递的升级等待时间 |
| `CHATDSH_ACCESS_MODE` | `disabled` | `disabled` 允许受信任网络直接进入；`required` 要求访问口令认证 |
| `CHATDSH_VERSION` | `0.1.0` | 中继版本 |
| `CHATDSH_PWA_VERSION` | `CHATDSH_VERSION` 的值 | PWA 版本 |
| `CHATDSH_ENVIRONMENT` | `local` | 遥测部署环境 |
| `CHATDSH_VAPID_SUBJECT` | `mailto:chatdsh@localhost` | Web Push subject |
| `CHATDSH_VAPID_PUBLIC_KEY` | 未设置 | 65 字节未压缩 P-256 公钥的 base64url |
| `CHATDSH_VAPID_PRIVATE_KEY` | 未设置 | P-256 私钥标量的 base64url |
| `CHATDSH_CONTROL_URL` | 设备长连接与设置同步为空；会话上报在未设置时为 `http://127.0.0.1:3170` | 中继地址 |
| `CHATDSH_NODE_TOKEN` | 空 | 节点令牌，只从环境变量读取 |
| `CHATDSH_DEVICE_ID` | 设备长连接为空；会话上报与设置同步为 `local` | 本设备标识 |
| `CHATDSH_PUSH_INTENT_DB` | `$DSH_HOME/push/replica-intents.sqlite` | 副本补传意图数据库 |
| `CHATDSH_TELEMETRY` | 未设置 | 取 `off` 时关闭遥测 |
| `DSH_TELEMETRY_DISABLED` | 未设置 | 取非空值时关闭遥测 |
| `CHATDSH_TELEMETRY_ENDPOINT` | `http://127.0.0.1:5080` | OTLP/HTTP 根地址，别名 `OO_URL` |
| `CHATDSH_TELEMETRY_ORG` | `default` | OTLP 组织，别名 `OO_ORG` |
| `CHATDSH_TELEMETRY_USER` | 未设置 | HTTP Basic 用户名，别名 `OO_USER` |
| `CHATDSH_TELEMETRY_PASSWORD` | 未设置 | HTTP Basic 口令，别名 `OO_PASS` |
| `CHATDSH_TELEMETRY_DEBUG` | 未设置 | 取 `1` 时进入调试模式 |
| `CHATDSH_TELEMETRY_TRACE_SAMPLE_RATIO` | `1` | 追踪采样比例 |

全部变量、默认值与关闭行为见 [`docs/deployment.md`](docs/deployment.md) 第六节。

## 验收命令一览

```sh
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
node scripts/telemetry-probe.mjs
```

`verify:*` 脚本启动真实中继、真实官方 `web` profile 与真实 SQLite；`verify:plugin-install` 会执行真实的 `dsh plugin --profile web add`。

## 环境注意事项

- **依赖预装环境**：本机依赖已经就位，运行 `pnpm` 脚本时使用 `pnpm --config.verify-deps-before-run=false <script>`。依赖存储位于只读盘时不要执行 `pnpm install`。
- **`GIT_CONFIG_COUNT` 环境变量**：部分环境注入不完整的 `GIT_CONFIG_COUNT` 会导致 `git` 退出，执行命令前可使用 `env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git <子命令>`。
- **隐私钩子**：`core.hooksPath` 属于本地配置，克隆后需运行 `bash scripts/install-hooks.sh`，并确保本机已安装 `gitleaks` 与 `python3`。
