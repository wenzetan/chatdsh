# 聊天后端与记忆接入

本文件设计 ChatDSH 的聊天后端与记忆后端。两者各自是可选插件，彼此独立：Hermes 承载聊天时可省略，Hindsight 承载记忆时可省略，四种组合都成立。工作会话始终由 DSH 自己的 agent 执行，不随聊天后端变化。

事实基线：Hermes 0.21.7 安装在 `/usr/local/lib/hermes-agent/`（Python，systemd 用户单元 `hermes-gateway.service`，OpenAI 兼容服务在 `:8642`），Hindsight 是独立服务（`127.0.0.1:8889`），DSH 为 `@deepseek-ai/dsh` 0.2.1-rc.2。Hermes 的记忆提供方在 `plugins/memory/` 下按目录分发，`memory.provider` 选中其中一个，内置存储在 `memory.provider` 取空值时启用，二者由 `agent/memory_manager.py` 的 `MemoryManager` 统一驱动。

## 一、开关模型

两个独立的开关决定运行形态，控制平面持有它们的值并下发给运行时。

`chatBackend` 取 `hermes` 或 `dsh`。取 `hermes` 时聊天会话由 Hermes 承载，取 `dsh` 时聊天会话由 DSH 自己的 agent 执行。

`memoryBackend` 取 `hindsight`、`hermes` 或 `none`。取 `hindsight` 时记忆由外部 Hindsight 服务承载，取 `hermes` 时记忆由 Hermes 内置记忆承载（只在 `chatBackend` 为 `hermes` 时可选），取 `none` 时记忆功能不启用。

两个开关互相独立，不互相推导。`chatBackend` 为 `hermes` 时 `memoryBackend` 可以是 `hermes`、`hindsight` 或 `none`；`chatBackend` 为 `dsh` 时 `memoryBackend` 只能是 `hindsight` 或 `none`，因为 Hermes 内置记忆依附于 Hermes 承载的聊天会话，Hermes 不承载聊天时它无从产生。

关闭某个后端属于正常配置：它不留下失败的服务、不产生告警日志、不占端口，界面把对应能力显示为「未启用」并给出启用入口，理由在第二节与第三节写明。

## 二、聊天后端

### 2.1 Hermes 承载（`chatBackend: hermes`）

Hermes 提供三条可用通道。

`api_server` 是 `:8642` 上那个 OpenAI 兼容服务的本体，它本身就是 `gateway/platforms/` 下的一个渠道适配器。它的路由表里有对话与审批的完整接口：

| 用途 | 接口 |
|---|---|
| 对话 | `POST /v1/chat/completions`、`POST /v1/responses`、`POST /api/sessions/{id}/chat` |
| 发起运行 | `POST /v1/runs` |
| 运行事件流 | `GET /v1/runs/{run_id}/events` |
| 审批应答 | `POST /v1/runs/{run_id}/approval` |
| 干预与终止 | `POST /v1/runs/{run_id}/steer`、`POST /v1/runs/{run_id}/stop` |
| 复用真实会话 | 请求头 `X-Hermes-Session-Id` |

`api_server.py:83-88` 注册了这些路由，`:107-110` 的 `_approval_event_choices` 产出可回传的选项，`:113` 起构造 `approval.request` 事件，第 70 行的能力表里 `run_approval_response`、`approval_events`、`tool_progress_events` 都为真。

在 Hermes 侧写平台插件是另一种形态：`plugin.yaml` 声明 `kind: platform`，`adapter.py` 实现 `connect`、`disconnect`、`send`、`get_chat_info` 四个方法并在 `register(ctx)` 里调 `ctx.register_platform(...)`，核心代码零改动。本机已有生产实例（`homeassistant` 插件）。

**核心对话与审批走 `api_server`**：接口现成、ChatDSH 侧不需要服务端口、审批有正规接口、`X-Hermes-Session-Id` 让会话真相留在 Hermes。

**主动推送走平台插件**：Hermes 的全部主动产出（cron、通知、其他渠道转来的内容、看板提醒）都由 `DeliveryRouter.deliver` 按目标解析后调适配器的 `send()`。`delivery.py:125` 的目标格式是 `"origin" | "local" | "<platform>" | "<platform>:<chat_id>[:<thread_id>]"`，cron 任务创建时绑定 origin。投递本身由 Hermes 的持久账本包裹：`/root/.hermes/state.db` 的 `delivery_obligations` 表记录 `state`、`attempts`、`owner_pid`、`owner_started_at`、`last_error`，四态语义写在 `gateway/delivery_ledger.py` 的模块说明里（pending 直接重投、attempting 表示崩溃于等待中可能已送达所以带可见标记重投、failed 是重启重试边界、delivered 修剪），尝试上限 3 次、过期回收 24 小时。

`delivery.py:66` 的 `resolve_delivery_transport` 是「具体原生适配器优先」，relay 只在其 `fronts_platform` 匹配时接管。relay 用在被代理方无法被直连的场景，ChatDSH 有可达端点时用不到它。

主动推送在首期就做，因此 ChatDSH 侧要提供一个接收端点（SSE 加 POST，见[可达性](reachability.md) 第七节的内部链路）供适配器连接与投递。

### 2.2 DSH 承载（`chatBackend: dsh`）

聊天会话直接由运行时里的 DSH agent 执行，与工作会话共用同一套会话存储、投影与工具运行时。差别只在于会话归属：聊天会话的 `cwd` 指向专用聊天目录、归属表里 `workspaceId` 留空，因此它不构成工作区，也不参与工作区隔离与项目指令。

聊天会话在 DSH 承载下使用 `chatdsh` preset（会话平面插件见[架构设计](architecture.md) 4.5 节），工具与工作会话一致。

DSH 承载不依赖任何外部服务，是这条形态能够「无 Hermes 也能对话」的原因。它的取舍是没有 Hermes 的多渠道接入、定时任务与看板能力，这些能力只在 Hermes 承载时存在。

## 三、记忆后端

### 3.1 接入层与存储层的分离

记忆分成两层，两层由不同的组件承担。

**存储层**是真正保存与检索记忆的地方，只有两种：外部 Hindsight 服务，或 Hermes 内置记忆。两者都不由 ChatDSH 实现，ChatDSH 不重新发明记忆存储。

**接入层**是 `@chatdsh/host-memory`，它负责三件事：在 `agent/pre-step` 里按当前问题发起召回并注入；在回合结束后按会话去重与节流，用 `ctx.llm` 生成适合长期记忆的摘要，写入存储层；按工作区与会话类型决定召回与写入哪些 bank。它不持有记忆数据，只做编排与规则。

`memoryBackend` 选中的是存储层。接入层在存储层为 `hindsight` 时启用，在存储层为 `hermes` 时由 Hermes 内部的记忆提供方接管聊天会话的记忆，接入层只处理 DSH 执行的工作会话，在存储层为 `none` 时整体不启用。

### 3.2 Hindsight 独立部署（`memoryBackend: hindsight`）

Hindsight 由用户自行部署，ChatDSH 不打包它、不托管它的进程、不替用户启动容器。`@chatdsh/host-memory` 在这个后端下本质是一个配置层加定期摘要处理：它提供 Hindsight 的连接配置、bank 命名规则与探活，按规则把会话摘要写进记忆，按规则召回并注入。用户填好 Hindsight 的地址与凭据、把服务跑起来，记忆就生效；服务不可达时插件报告不可用，记忆功能显示为「未启用（Hindsight 不可达）」，不静默退化成本地假记忆。

Hindsight 的部署形态由用户决定，可以是本机、可以是另一台机器。单机部署时的实测参数记在[部署形态与兼容接缝](deployment.md)第八节：嵌入模型经 OmniRoute 用 `sfc/Qwen/Qwen3-Embedding-8B`（4096 维），超过 pgvector 的 HNSW 上界 2000，因此数据库要用带 `vchord` 扩展的 Postgres（`tensorchord/vchord-postgres:pg18-v1.1.1`，`shared_preload_libraries=vchord,vector`），配 `HINDSIGHT_API_DATABASE_URL` 与 `HINDSIGHT_API_VECTOR_EXTENSION=vchord`，就绪判定用 `GET /version` 返回 200。

接入层需要的配置项：服务地址、凭据、嵌入模型与维度、`bank_id_template` 的取值、`mirror_to_own_bank` 开关、额外召回 bank 的优先级。这些配置由控制平面写入 `@chatdsh/host-memory` 的配置行，凭据走环境变量名引用，不作为配置值落盘。

### 3.3 Hermes 内置记忆（`memoryBackend: hermes`）

Hermes 自带一套内置记忆存储，`memory.provider` 取空值、`default`、`builtin` 或 `none` 时启用（`agent/memory_provider.py:44` 的 `CORE_MEMORY_PROVIDER_SENTINELS`）。它由 `MemoryManager` 驱动，与外部记忆提供方并列：内置存储恒在第一位，外部提供方最多一个，两者互不阻塞，任一提供方失败只记录日志不影响另一方（`agent/memory_manager.py:391` 起的类说明）。

内置存储只覆盖 Hermes 承载的聊天会话。它的生命周期挂在 `MemoryManager` 上：`initialize`、`prefetch`、`sync_turn`、`shutdown` 加可选钩子，按回合同步。Hermes 不承载聊天时这套存储不产生任何内容，因此 `memoryBackend: hermes` 只在 `chatBackend: hermes` 时可选。

这个后端不要求用户部署任何额外服务，是「有 Hermes 无 Hindsight」时记忆仍可用的原因。它的取舍是记忆只存在于 Hermes 侧，DSH 执行的工作会话看不到它，除非另外启用 Hindsight 作为工作会话的记忆后端。

### 3.4 记忆插件的规则

接入层与 Hermes 内置记忆遵循同一套 bank 命名与召回规则，使两者在同时启用时能共享同一批记忆。

**Hindsight 的隔离通道。** 真正生效的只有两条：bank 是唯一硬分区键（路径段 `/v1/default/banks/{bank_id}/…`，bank 之间不共享索引、不共享整合队列、不能跨 bank 排序），tags 参与召回与列举过滤。metadata 不参与过滤，`RecallRequest` 的字段是 `query`、`types`、`prefer_observations`、`budget`、`max_tokens`、`trace`、`query_timestamp`、`include`、`tags`、`tags_match`、`tag_groups`、`min_scores`、`temporal_window`，没有 user、platform、session 或 metadata 维度。

**不重新发明配置面。** 本机安装的 Hindsight 插件已经提供多 bank 配置：`bank_id_template` 支持 `{profile}`、`{workspace}`、`{project}`、`{platform}`、`{user}`、`{session}` 占位符；`mirror_to_own_bank` 表示模板解析到别的 bank 时也写入自己的 bank；`additional_banks` 可写可召回、按优先级；`recall_additional_banks` 只召回；`trusted_project_dirs` 配合仓库内 `.hindsight/config.toml` 让仓库自选 bank 且默认拒绝改写。召回按写入 bank 再按追加召回 bank 的顺序并发查询、按文本去重合并，额外 bank 失败进入五分钟冷却而不影响主 bank。

**bank 划分与召回规则**：

| 会话场景 | 召回 | 写入 |
|---|---|---|
| 聊天（无工作区） | `acct:<accountId>` | `acct:<accountId>` |
| 私有工作区 | `t:<tenantId>:ws:<memoryGroupId>` 加 `acct:<accountId>` | `acct:<accountId>` |
| 共享工作区 | `t:<tenantId>:ws:<memoryGroupId>` 加当前用户自己的 `acct:<accountId>` | `t:<tenantId>:ws:<memoryGroupId>` |

`memoryGroupId` 默认等于 `workspaceId`。用户把两个工作区关联成记忆组之后，两者共用同一个组标识，这使跨设备的两份检出（例如同一个仓库在两台机器上各一份克隆）共享记忆，而会话归属、项目指令与会话列表仍按各自的工作区记录。

多租户下 bank 名还要带租户维度，否则不同租户的标识会相撞。写入不跨 bank 镜像。

这套规则与 ChatGPT 的实际行为对应：项目外可用账号记忆；私有项目内账号记忆可用而引用限于项目内；共享项目强制 project-only。差别在于它用「干脆不用账号记忆」实现共享项目的隔离，这里用「只叠加当前用户自己的账号 bank」，因为 bank 按账号分区，每个人的召回只查自己那一个，别人的记忆不会进入他的上下文。

**私有工作区转为共享时不迁移记忆。** 转共享之后，作者仍能带着自己的历史工作，新成员只能看到转共享之后沉淀的内容，这一点要在界面里说明。

**工作会话向记忆回流的路径。** 回合结束后按会话去重与节流，用 `ctx.llm` 生成适合长期记忆的摘要（compaction 的摘要目标是让对话继续，不直接复用），交给存储层写入。写入 Hindsight 时走带 `operation_id` 的异步路径：`RetainRequest` 的 `operation_id` 是客户端提供的 UUID，用同一标识重提交会返回原操作且不产生新工作，配套有 `GET /v1/default/banks/{bank_id}/operations` 与 `POST .../operations/{operation_id}/retry`。把 UUID 与游标一起持久化，写入失败时按同一 UUID 重试，避免重新抽取。本机现有的 `openclaw-memory-bridge.py` 不携带该标识、还有 6000 字符整段截断与 1200 字符单条截断、跳过压缩事件、并把游标一次推进到本批最后一条，这几处不要继承。

**工作会话从记忆召回。** 在 `agent/pre-step` 里按当前问题向存储层发起召回。注入位置要选定一条通道：注入进表面就进入持久化转录，界面上可见；要保持转录干净原文就用表面 `replace` 覆盖当前轮的用户消息节点。Hermes 的做法是把召回文本追加在当前轮用户消息之后、持久化转录保留干净原文，两边要做到「看到的内容一致」必须先统一通道选择。

召回失败的降级是「本轮无记忆」继续，并在界面提示；写入失败进本地待写队列按 `operation_id` 重试。多 bank 召回要给出预算分配规则：每个 bank 各自带 `max_tokens`，固定优先级拼接会让工作区记忆永远排在账号记忆之后，应当按 bank 给出配额。

**管理界面**直接接 Hindsight 的读接口：`/memories/list`、`/memories/{id}`、`/graph`、`/audit-logs`。删除与整合两个写动作要有授权边界，写入仍交给接入层或 Hermes，避免两条写入路径冲突。

**删除项目时的记忆处理。** 删除工作区默认不动记忆，账本保留为审计记录。确认框里另有一个下拉选项，默认「不跟踪」，可改为「上报项目废弃」：选中之后控制平面把项目名、路径与废弃时间交给记忆写入路径，写入一条记忆，进当前用户的账号 bank。这条记忆的内容是该项目已废弃、此前的方案与结论不再沿用。

它的价值在于召回时的判断：项目删掉之后，记忆里关于它的经验仍然存在，若不标记，后续会话可能把这些经验当成仍然有效的指导。标记之后，召回能把「已经废弃的方案」与「仍在用的方案」分开。

## 四、四种组合

两个开关的合法组合与各自的能力如下。工作会话始终由 DSH 执行，表格里的「聊天」指 `chatBackend` 决定的聊天会话，「记忆」指 `memoryBackend` 决定的能力。

| 组合 | `chatBackend` | `memoryBackend` | 聊天由谁执行 | 记忆 |
|---|---|---|---|---|
| 一 | `dsh` | `hindsight` | DSH agent | 全部 DSH 会话经 Hindsight |
| 二 | `dsh` | `none` | DSH agent | 不启用 |
| 三 | `hermes` | `hermes` | Hermes | 仅聊天会话，走 Hermes 内置存储 |
| 四 | `hermes` | `hindsight` | Hermes | 聊天走 Hermes 的 Hindsight 提供方，工作会话走接入层，共用 bank |

**组合一：无 Hermes，有 Hindsight。** 聊天由 DSH 承载，工作会话也由 DSH 执行，两者都经 `@chatdsh/host-memory` 召回并写入 Hindsight。接入层此时是纯配置层加定期摘要处理：用户部署 Hindsight、填连接配置，插件按 bank 规则把会话摘要写进记忆、按问题召回注入。Hermes 相关的渠道、审批桥接、定时任务都不加载，界面不出现 Hermes 的入口。

**组合二：无 Hermes，无 Hindsight。** 聊天与工作会话都由 DSH 执行，记忆功能不启用。`@chatdsh/host-memory` 不加载，界面不出现记忆管理、工作区记忆组关联等入口（这些入口在记忆不可用时本就不展示，见[架构设计](architecture.md) 第八节）。这是最轻的形态，只需要 DSH 内核与本地存储，不依赖任何外部服务。

**组合三：有 Hermes，无 Hindsight。** 聊天由 Hermes 承载，记忆走 Hermes 内置存储，只覆盖聊天会话。DSH 执行的工作会话没有记忆能力，界面在记忆设置里说明这一范围限制。这个组合不要求用户部署任何额外服务，Hermes 与 DSH 装好即可。

**组合四：有 Hermes，有 Hindsight。** 聊天由 Hermes 承载，Hermes 的记忆提供方配置为 Hindsight（`memory.provider: hindsight`，这是 Hermes `plugins/memory/` 下的一个目录），聊天记忆写进 Hindsight 的 bank；工作会话由 DSH 执行，经接入层写入同一批 Hindsight bank。两边的 bank 命名规则一致，因此账号 bank 与工作区 bank 在聊天与工作之间是同一份记忆。这是功能最完整的组合。

**组合切换通过修改配置完成，不迁移已有数据。** 从组合二切到组合一只是填 Hindsight 配置并加载插件；从组合一切到组合三要把 `chatBackend` 改为 `hermes` 并把 `memoryBackend` 改为 `hermes`，已有聊天会话仍在 DSH 侧，新聊天会话由 Hermes 承载；从一个记忆后端切到另一个时，旧后端的记忆不自动搬进新后端，界面在切换前说明这一点，需要保留的历史由用户在新后端里重新沉淀或手工导入。会话日志本身不属于记忆，切换不影响会话内容。

**记忆不可用时的界面呈现。** `memoryBackend` 为 `none` 时，记忆管理页显示「记忆未启用」与两个启用入口（启用 Hindsight、启用 Hermes 内置记忆，后者在 `chatBackend` 为 `hermes` 时可选）。`memoryBackend` 为 `hindsight` 而 Hindsight 探活失败时，显示「Hindsight 不可达」并给出地址与最近一次探活结果，召回降级为「本轮无记忆」，写入进本地待写队列。

## 五、Hermes 渠道在 DSH 侧的实现

本节只在 `chatBackend: hermes` 时适用。

### 事件承载

渠道会话里的消息、审批、状态都落在会话事件里。自定义状态用 `appendPluginRecord`，它写入的记录带 `ignorable: true`、类型名须匹配 `plugin:<小写段>`、冷读路径放行、随 fork 与 resume 一起搬运。上游仓库里那条「只有 `packages/experimental/` 下的生产源码才可调用」的限制是仓库内部的校验脚本，已发布的 npm 包里没有该脚本。这类记录在会话格式迁移中可能被丢弃，因此只承载可以丢失的状态。

需要被内核语义消费的事件才走类型清单补丁，首期不需要。

### 代写一条外部回复

外部系统产生的一条助手回复落成事件序列是：

`turn/start` → `step/start` →（`request/header`）→ `assistant/message`（携带 `surfaceOp: 'append'`）→ `step/end` → `turn/end`

`assistant/message` 的 data 为 `{ turn, step, message, stream, usage? }`。`message` 的校验要求：`id` 是非空字符串、`role === 'assistant'`、`source.kind === 'model'` 且 `source.provider` 与 `source.model` 都是非空字符串、`content` 是数组；它禁止携带 `sourceEventSeqs`。`stream` 只需是数组，空数组合法。`step/start` 与 `turn/start` 决定回合边界投影是否建立。

`message.id` 最容易漏，它同时是投影与表面折叠的去重键，必须由控制平面生成并在重放时保持不变。

`source.provider` 与 `source.model` 在 Hermes 侧没有逐条来源——`messages` 表只有 `role`、`content`、`tool_calls`、`timestamp`、`token_count` 等列，`model` 与 `billing_provider` 在 `sessions` 表上是会话级的。因此代写时把来源写成可辨识的值：`provider: 'hermes'`、`model: 'hermes-0.21.7'`，并在用量账本里按来源区分，避免把 Hermes 的产出记成某个上游模型的消耗。

`request/header` 在这一场景下不可省：`userQuestions` 投影的定时判定读它，缺它会得到空视图。渠道会话若要用到该投影，头部里必须声明带 `timeout` 参数的 `ask_user_question` schema。

写入方式按会话状态二选一：会话有活动 Agent 时用该活体会话的 `Session.append`，再配合 `ctx.sessions.flush(session)` 取耐久屏障；会话没有活动 Agent 时走存储层 `ctx.sessionPersistence.open(id, 'write')` 取写句柄，`read()` 读现有日志、`append([...])` 追加、`flush()` 落盘、`close()` 释放。写句柄是单写者所有权，已有活跃所有者时会以 `SessionAlreadyOwnedError` 拒绝；「是否有活跃 agent」在两次调用之间会变化，因此外部写入要以会话为单位串行化，冲突时退避重试，避免降级到另一条路径。

外部写入要带业务幂等键（Hermes 的 `run_id` 加消息标识），写入前扫描尾部窗口去重。运行时在 append 之后、向 Hermes 确认完成之前崩溃时，重试不会产生两条内容相同的助手回复。

### 会话映射

渠道会话的 ChatDSH 会话编号与 Hermes 的 `session_key` / `chat_id` 一一对应。`SessionSource` 的字段同时喂养四件事：回复路由、系统提示的上下文块、cron 的 origin 绑定、会话键的生成。字段定义在 `/usr/local/lib/hermes-agent/gateway/session.py:65-100`。

取值：`platform` 取我们注册的平台名；`chat_id` 取 ChatDSH 的会话编号，这意味着每条 ChatDSH 会话在 Hermes 侧都是一个独立会话；`chat_name` 取会话标题；`user_id` 取账号编号；`user_name` 取账号显示名；`chat_type` 取 `channel`；`scope_id` 留空（它只在 Slack 平台进入会话键，其余平台只作记录）。

`build_session_key` 的布局是 `<ns>:<platform>:<chat_type>[:<slack scope_id>][:<chat_id>][:<thread_id>][:<user>]`（`session.py:691`）。`chat_type` 影响三处：会话键的第三个槽位与是否带参与者段（`dm` 且带 `chat_id` 时不加参与者，非 `dm` 时默认按 `group_sessions_per_user` 加）、`is_shared_multi_user_session` 的判定（`dm` 恒为非共享）、以及显示描述。

`chat_type` 取 `channel`，`group_sessions_per_user` 的取值与工作区的私有共享标记对应：私有工作区取 `true`，同频道的每个成员各有一条独立 Hermes 会话；共享工作区取 `false`，成员共用一条会话，彼此看得到同一段对话。

### 审批在 DSH 的呈现

`ctx.approval.request` 与 `ctx.userQuestions` 都不适用于渠道会话：前者要求已开启的回合，后者虽然不检查回合，但 `askTimed` 要求传入注册表中精确存活的顶层根 agent，而渠道会话没有活动 Agent；它的投影只折叠工具名恰为 `ask_user_question` 的调用，还要求该工具的定时形态被 `request/header` 记录；`continued` 状态只能由工具返回 pending 载荷或会话恢复补写产生；`answer()` 又只对 `continued` 的问题有效。

审批卡片改为自建四层，全部跟随渠道会话。

**事件层**：`@chatdsh/host-approval` 用 `appendPluginRecord` 往渠道会话写 `plugin:` 记录，载荷含 Hermes 的 `run_id`、`request_id`、可选值列表、命令摘要、状态迁移与最终结果。

**投影层**：注册一个自建投影键（`chatdshApprovals`），折叠这些记录。`SessionProjectionMap` 是可合并接口，值必须是纯 JSON 以便投影缓存持久化，因此刷新后可以从缓存重建卡片。

**渲染层**：`@chatdsh/client-approval` 按投影键把审批记录列在设置页的区段里，供查看与人工接管。会话流里的审批卡片由宿主自带的 `ui-approval` 承担，渠道会话的审批记录不进入那条流。

**应答层**：客户端调自建 Remote 方法 → 宿主插件 → `POST /v1/runs/{run_id}/approval`。请求体要带 `request_id`；同一 run 内可以有多个待处理审批，缺 `request_id` 时只能整组解决。

选项取值是 `once`、`session`、`always`、`deny` 四个小写字符串，别名只有 `approve`、`approved`、`allow` 映射到 `once`。room 授权的运行把可选范围收窄为 `once` 与 `deny`，且必须携带精确 `request_id`、禁止整组解决，否则返回 `invalid_approval_scope` 或 `approval_request_required`。

超时由 Hermes 决定，默认 300 秒（`tools/approval_context.py` 的 `_get_approval_timeout`，可用 `approvals.timeout` 覆盖），超时后自动拒绝。ChatDSH 侧按同一时长关闭卡片；回传收到 409（`approval_not_pending` 或 `approval_not_active`）表示 Hermes 侧已解决，按已失效落定且不重试；解决结果写进归属表供冷读重建。

## 六、对话转工作

ChatGPT 的做法是在同一个对话里切换形态，DSH 的机制不同：**agent preset 只在会话仍然空白时可换**，`openTurnStartSeq !== null || lastTurn > 0` 时抛 `agent-preset/locked`。所以形态转换必须新建会话。

对话转工作有两种来源，做法不同。

**从 Hermes 聊天转工作。** 聊天不构成工作区（它的 `cwd` 指向专用聊天目录、归属表里 `workspaceId` 留空），转工作意味着新会话第一次获得 `workspaceId`。官方 `SessionController.fork` 不能完成这件事：`SessionForkRequest` 只有 `sessionId`、`atSeq`、`allowMigration`，新会话的 `cwd` 继承源会话，`forkWorkspace(source.header)` 也按源会话所在工作区解析。跨工作区的转工作要用同一批原语自己组装：

1. 从 Hermes 取出聊天历史；
2. 转成合法的 DSH 事件序列（`user/message` 与 `assistant/message` 交替，配上回合与步骤边界）；
3. 用 `buildForkSeed` 或等价方式构造种子；
4. `ctx.agents.create({ sessionId, seed, inheritedEventCount, meta: { cwd: 目标工作区根, parentSession, isSeeded: true, agentPreset: 'chatdsh-work' }, setup })`；
5. 调目标工作区的 `attachSession(childId)`。

**从 DSH 聊天转工作。** 聊天与工作都由 DSH 执行时，聊天会话本身就是一份 DSH 会话日志，转工作只需在同一份日志上以 `buildForkSeed` 构造种子、在新工作区里 `ctx.agents.create` 并 `attachSession`，不需要从 Hermes 取历史。历史前缀已经是合法事件，`parentSession` 指向源聊天会话即可。

种子的硬性要求：事件为无损 JSON、`seq` 从 0 连续、每条通过表面契约校验。`session/end-seed` 的继承标记只能由 `Session` 构造函数与 `buildForkSeed` 创建，历史必须整段作为前缀交进去，中途插标记会让此后所有收尾事件被当作种子历史。`parentSession` 只做字符串类型检查，血缘的唯一性与可解析性由控制平面保证，用 `hermes:<chat_id>` 或源会话编号这类追溯标识即可。

从 Hermes 取历史时有三处约束必须处理。`GET /api/sessions/{id}/messages` 默认取 `latest` 页、上限 500 条，并且固定传 `include_ancestors=True`，压缩轮换之后一次返回的是多个父会话拼接的结果；要按 `after_id` 做键集分页、按会话分别建段、显式选择 `include_inactive=False` 与 `include_compacted=False`，并把「历史被截断」作为可呈现的状态。Hermes 支持撤销轮次（`rewind_session` 做软删除，`sessions` 表有 `rewind_count`），默认读取会把被撤销的消息排除，因此取种子时必须明确这一取值，否则会把用户已经撤销的轮次当成有效历史。

种子之外的序号关系：`buildForkSeed` 的返回值是「继承前缀 + 前缀之外的合成闭合事件」，合成事件已占 `boundary + 1` 起的序号，因此第一条新事件的序号取持久化日志当前末端。

**转工作的缓存代价要显式声明。** 从 Hermes 聊天转来时，聊天会话由 Hermes 执行，实际请求的前缀由 Hermes 组装，DSH 侧记录的会话事件不参与模型调用，所以这件事无法通过调整 DSH 侧的记录内容改变。能延续下来的是种子里带的两样：`request/header` 让模型选择基线延续，每条 `assistant/message` 的 `stream` 里的 `ReplayEnvelope` 让助手消息的原生块可以重放——后者只在目标适配器实例同时持有历史供应方与目标供应方时可用，跨执行体的场景拿不到。从 DSH 聊天转来时，前缀本就是 DSH 事件，首轮仍需重建上游提示词缓存，但后续轮次在同一会话内可以命中。

声明写在 seed 落位之后，作为新会话的第一条新事件，因此不计入 `inheritedEventCount`（那个值只数被复制的源事件）。内容写清三件事：本会话由哪个聊天会话转工作而来；继承的历史前缀与当前工作会话的系统提示不一致，因此这段历史不享受上游提示词缓存；首轮请求是冷启动，本会话内部从第二轮起恢复正常。

用 `developer/message` 承载这条声明要注意它的可见性：`projectToolUpdates` 在路由未声明 `toolUpdate` 时会把全部 developer 消息删掉，即使进入保留分支也只有 id 命中 `history.updates` 的消息被逐块保留。`toolUpdate` 只有 pi-ai 的 anthropic-messages（`in-history`）与 openai-completions（`addition-only`）会声明，自建适配器转发到 OmniRoute 时必须显式声明它，否则这条声明对模型完全不可见且被静默丢弃。

**目标工作区是共享的时候要拦。** 把私人聊天整段转入共享工作区会把内容带进其他成员可见的上下文。做法是转工作前检查目标工作区的私有与共享标记，共享时要求确认并只导入用户勾选的区间。

## 七、生命周期与降级

**Hermes 的生命周期由控制平面托管，只在 `chatBackend: hermes` 时启动。** Hindsight 由用户自行部署，控制平面只探活不托管进程；`memoryBackend: hindsight` 时控制平面持有 Hindsight 的地址与探活结果，探活失败按记忆降级处理。

`chatBackend: dsh` 时控制平面不启动 Hermes 实例、不分配端口、不探活，界面不出现 Hermes 相关状态。`memoryBackend: hermes` 依赖 Hermes 存活，因此它在 `chatBackend: hermes` 时才合法，此时 Hermes 的启停与聊天能力绑定。

启动顺序按开关展开：取锁、初始化数据目录、读取密钥、启动控制平面、控制平面探活 Hindsight（`memoryBackend: hindsight` 时）、按配置拉起 Hermes（`chatBackend: hermes` 时）、由控制平面拉起运行时、轮询回环端口直到健康、打开浏览器。停止时先停运行时与 Hermes，再停控制平面。

降级路径逐项显式定义。

`chatBackend: hermes` 而 Hermes 不可用：聊天能力不可用，工作会话不受影响，审批推送不会产生，界面显示 Hermes 不可用与重启入口。这是 Hermes 作为可选依赖的必然结果。

`memoryBackend: hindsight` 而 Hindsight 不可达：召回返回空、写入进本地待写队列，界面显示记忆降级，工作会话与聊天照常。

`memoryBackend: hermes` 而 Hermes 不可用：聊天本身不可用，记忆随之不可用，二者是同一个依赖。

`chatBackend: dsh`：不存在 Hermes 降级，因为不依赖 Hermes；`memoryBackend: none` 时也不存在记忆降级，因为记忆未启用。

## 八、调试环境

开发调试时，dsh 运行时、Hermes 与 Hindsight 各自跑在独立容器里，宿主上已经在跑的实例不受影响。容器侧的端口是 dsh 13080、Hermes 18642、Hindsight 18889，只绑定宿主回环地址；模型网关沿用宿主上的 20128，容器内用 `host.docker.internal:20128` 访问。

编排文件与变量清单在 [`dev/`](../dev/)，说明见 [dev/README.md](../dev/README.md)。容器里的数据根、依赖与缓存都在容器卷内，调试时的改动不会落到宿主环境。

## 九、首期之后

主动推送之外的其他渠道内容注入、Hermes 侧的账号与 profile 划分随团队版扩大、记忆管理界面的写权限、记忆后端之间的导入工具（把一个后端的记忆批量搬进另一个）。
