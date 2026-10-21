# 上游能力的处置清单

本文件逐项登记上游能力在本项目里的处置。`scripts/check-capabilities.mjs` 核对本文件的「禁用」一列与各补丁层的实际状态一致：标为禁用而补丁层未禁用的、补丁层禁用而未标为禁用的，都算失败。

处置取值：`保留` 表示按上游默认挂载；`禁用` 表示在补丁层关掉；`受限挂载` 表示保留但改了配置或只挂在部分形态；`可选未装` 表示上游有该包、本项目当前不装；`实验性` 表示上游标注为实验能力，缺失时必须显式失败。

## 一、按行 id 登记的能力

| 行 id | 包 | 处置 | 说明 |
|---|---|---|---|
| `agent-loop` | `@deepseek-ai/dsh-agent-loop` | 保留 | agent 循环 |
| `subagent` | `@deepseek-ai/dsh-subagent` | 保留 | 子代理接缝，命名提供方注册表 |
| `subagent-spawn-in-process` | `@deepseek-ai/dsh-subagent-spawn-in-process` | 保留 | 进程内新建子代 |
| `subagent-fork-in-process` | `@deepseek-ai/dsh-subagent-fork-in-process` | 保留 | 进程内分叉子代 |
| `tool-subagent` | `@deepseek-ai/dsh-tool-subagent` | 保留 | 委托工具 |
| `tool-subagent-control` | `@deepseek-ai/dsh-tool-subagent-control` | 保留 | 子代理控制工具 |
| `schedule` | `@deepseek-ai/dsh-schedule` | 保留 | 宿主级定时任务 |
| `tool-schedule` | `@deepseek-ai/dsh-tool-schedule` | 保留 | 定时任务工具 |
| `skill` | `@deepseek-ai/dsh-skill` | 保留 | 技能目录 |
| `skill-filesystem` | `@deepseek-ai/dsh-skill-filesystem` | 保留 | 文件系统技能来源 |
| `tool-skill` | `@deepseek-ai/dsh-tool-skill` | 保留 | 技能加载工具 |
| `mcp-client` | `@deepseek-ai/dsh-mcp-client` | 保留 | MCP 客户端，连接器按记录同步成该行 |
| `sandbox` | `@deepseek-ai/dsh-sandbox` | 保留 | 进程沙箱接缝 |
| `sandbox-local` | `@deepseek-ai/dsh-sandbox-local` | 保留 | 本地沙箱后端 |
| `sandbox-policy` | `@deepseek-ai/dsh-sandbox-policy` | 保留 | 沙箱策略解析 |
| `subprocess` | `@deepseek-ai/dsh-subprocess` | 保留 | 子进程接缝 |
| `subprocess-local` | `@deepseek-ai/dsh-subprocess-local` | 保留 | 本地子进程后端 |
| `session-query-sqlite` | `@deepseek-ai/dsh-session-query-sqlite` | 受限挂载 | 打开时机改回 `startup`，会话列表与检索依赖它 |
| `agent-preset-registry` | `@deepseek-ai/dsh-agent-preset-registry` | 受限挂载 | 默认预设改为 `chatdsh` |
| `spill-policy` | `@deepseek-ai/dsh-spill-policy` | 受限挂载 | worker 形态把落盘阈值调低 |
| `tool-result-pruner` | `@deepseek-ai/dsh-compaction-tool-result-pruner` | 受限挂载 | worker 形态把裁剪阈值调高 |
| `session-persistence-jsonl` | `@deepseek-ai/dsh-session-persistence-jsonl` | 受限挂载 | 默认会话日志后端；切换到 Postgres 组合包时禁用 |
| `chatdsh-telemetry` | `@chatdsh/host-telemetry` | 受限挂载 | worker 形态没有 Web 服务器与设置面，该行在此形态禁用 |
| `chatdsh-assistants` | `@chatdsh/host-assistants` | 受限挂载 | worker 形态没有预设注册表，该行在此形态禁用 |
| `deepseek-account` | `@deepseek-ai/dsh-deepseek-account-platform` | 禁用 | 绑定 DeepSeek 平台账号，账号由控制平面承担 |
| `llm-deepseek-account` | `@deepseek-ai/dsh-llm-deepseek-account` | 禁用 | 同上，整链关掉 |
| `account-controller` | `@deepseek-ai/dsh-api-account-controller` | 禁用 | 同上 |
| `ui-settings-account` | `@deepseek-ai/dsh-client-ui-settings-account` | 禁用 | 同上 |
| `web-deepseek-api` | `@deepseek-ai/dsh-web-deepseek-api` | 禁用 | 同上 |
| `web-search-deepseek` | `@deepseek-ai/dsh-web-search-deepseek` | 禁用 | 同上 |
| `optional-ralph` | `@deepseek-ai/dsh-tool-ralph` | 禁用 | dsh-tui 0.16.1 的补丁层按 id 关闭 `tool-ralph`，该行由可选组合包 `@deepseek-ai/dsh-experimental-ralph-bundle` 插入；cli 形态挂载该组合包只为满足补丁目标，整组关闭 |

「禁用」一列必须与补丁层一致：`deepseek-account`、`llm-deepseek-account`、`account-controller`、`ui-settings-account`、`web-deepseek-api`、`web-search-deepseek` 六行在 web 与 desktop 形态由补丁层关掉，六个包互相引用，必须整链处理，只停其中几行会留下失败的 fiber。

## 二、可选未装的上游组合包

| 包 | 用途 | 装入方式 |
|---|---|---|
| `@deepseek-ai/dsh-subagent-codex` | 委托给 Codex | 列进 profile 的 `dsh.profile.bundles` |
| `@deepseek-ai/dsh-subagent-claude-code` | 委托给 Claude Code | 同上 |
| `@deepseek-ai/dsh-subagent-acp` | 委托给任意 ACP 代理 | 同上 |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | 委托给 DSH SDK 代理 | 同上 |

外部子代由 `dsh-subagent` 统一管理：只执行一次，不保留本地子会话，不接受后续追问；进程内 spawn 与 fork 子代可以继续对话。四类子代共享准入、取消、归属与发现。

## 三、实验性能力

| 行 id | 包 | 处置 | 说明 |
|---|---|---|---|
| `worktree` | `@deepseek-ai/dsh-experimental-worktree` | 实验性 | `ctx.worktrees.create` 创建具名工作树并切换会话目录；该包只创建不回收，失败可能保留产物 |

使用纪律：该能力缺失时任务显式失败并说明原因，不回退到共享检出；工作树的回收由控制平面按留存期负责，回收前确认没有未提交改动。

## 四、开关手段

补丁层按行 id 写 `disabled: true` 是最直接的手段；会话平面的可见范围由 preset 的行列表与 `ctx.tools.restrict` 收敛；运行期可变的偏好走上游设置页的行；形态差异由 `dsh.profile.bundles` 的列表决定。

新增或调整处置时先改本文件，再改补丁层，最后跑 `node scripts/check-capabilities.mjs`。
