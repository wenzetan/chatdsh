# ChatDSH 工作区

面向官方 DSH（deepseek-harness）的跨设备互联插件集与轻量中继服务端。用户直接使用官方 DSH 运行时与官方客户端（Web 端与 Desktop 端），通过 `dsh plugin add` 安装纯附加组合包 `@chatdsh/bundle`，配合自托管的轻量中继服务端实现公网跨设备切换、离线只读会话副本、本机恢复继续、白名单设置同步、审批通知推送与移动端 PWA 入口。

## 目录构成

| 目录 | 内容 |
|---|---|
| [`dsh-adapter/`](dsh-adapter/) | 适配层 `@chatdsh/adapter`：DSH 顶层稳定 API 的唯一接触面（7 个 peer 依赖） |
| [`runtime/`](runtime/) | 运行时侧工作区：3 个核心包、5 个宿主插件、3 个客户端插件、1 个纯附加组合包 `@chatdsh/bundle`、轻量中继服务端 `@chatdsh/gateway`、校验脚本、单元测试与技术文档 |
| [`refer_repos/`](refer_repos/) | 参考项目本地快照，不纳入版本管理 |

## 文档与交付入口

- 文档总纲与事实基线：[`runtime/docs/README.md`](runtime/docs/README.md)
- 目标架构设计：[`runtime/docs/architecture.md`](runtime/docs/architecture.md)
- 实现说明与工作包交付清单（P01–P06）：[`runtime/docs/implementation-guide.md`](runtime/docs/implementation-guide.md)
- 遥测信号清单与关闭规范：[`runtime/docs/telemetry.md`](runtime/docs/telemetry.md)
- 部署、运行、备份与升级：[`runtime/docs/deployment.md`](runtime/docs/deployment.md)
- DSH 兼容性与升级验证步骤：[`runtime/docs/compatibility.md`](runtime/docs/compatibility.md)
- 凭据与隐私防护：[`runtime/docs/secret-guard.md`](runtime/docs/secret-guard.md)
- 适配层说明：[`dsh-adapter/README.md`](dsh-adapter/README.md)

## 本机实测运行

前置条件：Node.js 22 及以上、pnpm 11.21.0、官方 DSH 基线 `0.2.2-rc.3`。以下命令在 `/workspace/chatdsh/runtime` 下执行。

```sh
node_modules/.bin/tsc -b tsconfig.build.json --force
pnpm --config.verify-deps-before-run=false build:client
```

启动轻量中继：

```sh
DSH_HOME=/srv/chatdsh \
CHATDSH_GATEWAY_HOST=127.0.0.1 \
CHATDSH_GATEWAY_PORT=3170 \
CHATDSH_PUBLIC_URL=https://relay.example.com \
CHATDSH_PAIRING_CODE='替换为随机口令' \
node gateway/lib/main.js
```

`GET /healthz` 返回 `{"ok":true,"service":"chatdsh-gateway",...}`。设备通过 `POST /chatdsh/gateway/devices/pair` 取得 `deviceId` 与 `token`，再把 `CHATDSH_CONTROL_URL`、`CHATDSH_DEVICE_ID`、`CHATDSH_NODE_TOKEN` 写入设备运行时环境。

常用环境变量：`DSH_HOME`、`CHATDSH_GATEWAY_HOST`、`CHATDSH_GATEWAY_PORT`、`CHATDSH_GATEWAY_DB`、`CHATDSH_PUBLIC_URL`、`CHATDSH_PAIRING_CODE`、`CHATDSH_PUSH_MODE`、`CHATDSH_ACCESS_MODE`、`CHATDSH_CONTROL_URL`、`CHATDSH_NODE_TOKEN`、`CHATDSH_DEVICE_ID`、`CHATDSH_VAPID_SUBJECT`、`CHATDSH_VAPID_PUBLIC_KEY`、`CHATDSH_VAPID_PRIVATE_KEY`、`CHATDSH_TELEMETRY`。完整清单、默认值与关闭行为见 [`runtime/docs/deployment.md`](runtime/docs/deployment.md) 第六节。

## 验收命令

以下命令在仓库根目录 `/workspace/chatdsh` 下执行。

```sh
cd runtime
node_modules/.bin/tsc -b tsconfig.build.json --force
pnpm --config.verify-deps-before-run=false build:client
pnpm --config.verify-deps-before-run=false check:telemetry
pnpm --config.verify-deps-before-run=false check:plugins
node scripts/check-upstream-names.mjs
pnpm --config.verify-deps-before-run=false check:layering
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false verify:device-link
pnpm --config.verify-deps-before-run=false verify:routing
pnpm --config.verify-deps-before-run=false verify:settings-sync
pnpm --config.verify-deps-before-run=false verify:approval-notify
pnpm --config.verify-deps-before-run=false verify:import
pnpm --config.verify-deps-before-run=false verify:receipt-sync
pnpm --config.verify-deps-before-run=false verify:multi-client
pnpm --config.verify-deps-before-run=false verify:mobile-telemetry
pnpm --config.verify-deps-before-run=false verify:plugin-install
node scripts/telemetry-probe.mjs
```

全部命令的实测结论与遗留风险见 `.worktrees/P06-REPORT.md`。

## 参考项目

`refer_repos/` 保存开发过程中的参考实现快照，登记处位于 [`runtime/refer-repos.json`](runtime/refer-repos.json)，不纳入版本管理。

```sh
node runtime/scripts/clone-refer-repos.mjs               # 拉取清单里的全部仓库
node runtime/scripts/clone-refer-repos.mjs --only dsh-Go # 只拉取指定仓库
node runtime/scripts/clone-refer-repos.mjs --list        # 打印清单
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
