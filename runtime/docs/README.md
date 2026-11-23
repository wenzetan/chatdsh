# 文档总纲

本目录收录 ChatDSH 当前架构、部署运行、遥测规范、上游兼容性与隐私防护的权威文档。

## 一、权威文档索引

同一事实在多份文档中出现时，以下表指定文档为准。

| 主题 | 文档 | 说明 |
|---|---|---|
| 总体架构与模块边界 | [architecture.md](architecture.md) | 仅追加组合包 `@chatdsh/bundle`、Web 与 Desktop 共用机制、轻量中继与手机端 PWA 边界 |
| 部署、运行、备份与升级 | [deployment.md](deployment.md) | 中继启动、设备配对、反向代理与 TLS、VAPID、环境变量全清单、数据目录备份与 DSH 升级步骤 |
| 遥测规范与信号清单 | [telemetry.md](telemetry.md) | 信号命名规范、上下文传播边界、关闭开关与第六节信号登记表（由 `check-telemetry.mjs` 强制比对） |
| 上游兼容性与升级流程 | [compatibility.md](compatibility.md) | `@chatdsh/adapter` 依赖版本策略、官方 profile 真实安装验收与升级步骤 |
| 凭据与隐私防护 | [secret-guard.md](secret-guard.md) | 提交与推送钩子、规则扩展与误报处理 |
| 提交信息模板 | [prompts/git-commit-message.md](prompts/git-commit-message.md) | Gitmoji + Conventional Commits + 中英双语提交信息规范 |

## 二、当前构成基线

| 项 | 当前值 | 核对方式 |
|---|---|---|
| 官方 DSH 基线 | `0.2.2-rc.3` | `dsh --version` |
| DSH peer 依赖约束 | `>=0.2.0-0`（Cordis `>=4.0.0`，Schemastery `>=3.18.0`） | [dsh-adapter/package.json](../../dsh-adapter/package.json) |
| 适配层包 | 1 个（`@chatdsh/adapter`） | [dsh-adapter/](../../dsh-adapter/) |
| 运行时核心包 | 3 个（`contracts`、`diagnostics`、`remote-client`） | `ls runtime/packages/core/` |
| 宿主插件 | 5 个（`telemetry`、`device-link`、`push`、`import`、`settings-sync`） | `ls runtime/packages/host/` |
| 客户端插件 | 3 个（`telemetry`、`pwa`、`remote`） | `ls runtime/packages/client/` |
| 组合包 | 1 个（`@chatdsh/bundle`，仅 `insert` 追加） | `ls runtime/packages/bundle/` |
| 轻量中继服务端 | 1 个（`@chatdsh/gateway`） | [runtime/gateway/](../gateway/) |
| 运行载体 | 官方 DSH Web 客户端与官方 Desktop 客户端 | [architecture.md](architecture.md) |
