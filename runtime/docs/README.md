# 文档总纲

本文件是 ChatDSH 全部技术文档的入口，规定权威顺序、事实基线与实施委派路径。

## 一、权威顺序

同一事实在多份文档中出现时，以下表指定文档为准，其余文档引用不复述。

| 事实类别 | 权威文档 | 说明 |
|---|---|---|
| 总体架构、插件形态、中继职责与边界 | [architecture.md](architecture.md) | 纯附加 `@chatdsh/bundle`、Web 与 Desktop 共用机制、轻量中继与 PWA 边界 |
| 面向执行者的实现说明与工作包交付 | [implementation-guide.md](implementation-guide.md) | P01–P06 工作包的范围、文件清单、接口契约、遥测接入与验收命令 |
| 遥测信号清单、上下文传播与关闭开关 | [telemetry.md](telemetry.md) | 第六节信号清单与 `check-telemetry.mjs` 构建检查一一比对 |
| 上游 DSH 版本基线与升级验证步骤 | [compatibility.md](compatibility.md) | 依赖版本策略、真实官方 profile 安装验证与升级流程 |
| 单机与家庭服务器部署、环境变量、备份与升级 | [deployment.md](deployment.md) | 中继启动、设备配对、反向代理与 TLS、VAPID、遥测开关、数据目录与 DSH 升级步骤 |
| 凭据与隐私防护 | [secret-guard.md](secret-guard.md) | 提交与推送钩子规则 |
| 提交信息格式模板 | [prompts/git-commit-message.md](prompts/git-commit-message.md) | Gitmoji + Conventional Commits + 中英双语模板 |

## 二、事实基线

| 项 | 当前值 | 核对方式 |
|---|---|---|
| DSH 内核（本机基线） | `0.2.2-rc.3` | `dsh --version` |
| DSH peer 依赖约束 | `>=0.2.0-0`（Cordis `>=4.0.0`，Schemastery `>=3.18.0`） | [dsh-adapter/package.json](../../dsh-adapter/package.json) |
| 适配层包 | 1 个（`@chatdsh/adapter`） | [dsh-adapter/](../../dsh-adapter/) |
| 运行时核心包 | 3 个（`contracts`、`diagnostics`、`remote-client`） | `ls runtime/packages/core/` |
| 宿主平面插件 | 5 个（`telemetry`、`device-link`、`push`、`import`、`settings-sync`） | `ls runtime/packages/host/` |
| 客户端插件 | 3 个（`telemetry`、`pwa`、`remote`） | `ls runtime/packages/client/` |
| 组合包 | 1 个（`@chatdsh/bundle`，纯 `insert` 附加） | `ls runtime/packages/bundle/` |
| 轻量中继服务端 | 1 个（`@chatdsh/gateway`） | [runtime/gateway/](../gateway/) |
| 运行时形态 | 官方 DSH Web 端与官方 Desktop 端（零自定义 profile、零自建桌面外壳） | [architecture.md](architecture.md) |

## 三、委派实施阅读顺序

接手具体实现任务的 agent 按以下顺序读取文档后直接执行对应工作包：

1. 阅读 [AGENTS.md](../../AGENTS.md)，掌握语言、编码、测试与遥测强制约束。
2. 阅读 [architecture.md](architecture.md)，确认插件边界、依赖方向与中继协议。
3. 阅读 [implementation-guide.md](implementation-guide.md)，定位所负责工作包（P01–P06）的精确文件清单、契约、遥测要求与验收命令。
4. 若涉及新增遥测信号，阅读 [telemetry.md](telemetry.md) 第五至九节并同步登记第六节清单与包内 `chatdsh.telemetry`。
5. 若涉及部署、运行、环境变量或升级，阅读 [deployment.md](deployment.md) 并按其中的顺序执行。

## 附：工作包执行报告

P01–P06 的执行报告收录在 [reports/](reports/)，记录每个工作包改动的文件、验收命令与原始结论，供评审时逐条核对。
