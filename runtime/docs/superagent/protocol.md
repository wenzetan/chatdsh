# Super-Agent 接口与权限协议

接口类型使用 [contracts.ts](contracts.ts)，持久语义使用 [storage.md](storage.md)。协议第一版为 `version=1`，不兼容主版本直接拒绝。未知字段由 Zod strict schema 拒绝，所有对象引用同时检查项目归属。

## 1. 传输与身份

用户入口为 `/chatdsh/gateway/projects/:projectId/superagent`，控制平面解析项目 owner，沿现有设备通道转发至 `/chatdsh/superagent/v1/projects/:projectId`。用户浏览器只访问控制平面，不持有运行时管理密钥。CLI 使用已有部署访问凭据连接同一入口。

控制平面先验证访问会话、Origin、CSRF 与设备在线，再以节点通道密钥签名转发。每台设备新增独立随机 256 位 `superagentCommandKey`，配对时通过已认证通道下发并保存在宿主私有目录，轮换沿用节点密钥版本与重叠期。该密钥不发送客户端、不进入 Worker 环境、不与普通工具共享。

转发头为 `x-chatdsh-sa-version`、`x-chatdsh-sa-key-id`、`x-chatdsh-sa-nonce`、`x-chatdsh-sa-issued-at`、`x-chatdsh-sa-signature`。签名使用 HMAC-SHA256，输入为 JSON 数组 `[version,deviceId,projectId,method,path,bodySha256,issuedAt,nonce,keyId]` 的 UTF-8 序列；数组值只能为规定的字符串和整数，使用标准 JSON 序列化。`path` 使用校验后的精确内部路径及查询字符串，不含代理前缀；转发与接收使用同一 URL 序列化结果。nonce 为 128 位随机值，30 秒有效，记录至 60 秒后回收；同一 nonce 再次出现直接拒绝。时间容差 5 秒；比较签名使用常量时间接口。请求摘要按原始 UTF-8 请求体字节计算，客户端在同一操作重试中保留精确字节。

接收端再次检查项目 owner、签名、nonce、过期、代次与对象权限。转发前剥离外部同名头；只有经过用户入口的请求才能获得 `human` 身份。Agent 工具调用走宿主进程内服务，actor 从实际会话登记取得。模型提交的 `role/sessionId/generation` 字段不会成为调用身份。普通 Typert Remote 不导出可直接授权、应用或恢复的方法。

所有 Super-Agent 写入口必须验证可撤销的用户访问凭据。普通部署采用匿名访问时，也需要通过桌面私有启动通道或既有用户登录入口建立这个访问会话，缺少凭据返回 permission-denied。Origin 与 CSRF 是附加检查，不能单独产生 human 身份。授权凭据只交给用户客户端，执行环境、模型上下文、普通工具和项目文件均无法取得该凭据。

访问会话复用网关现有 access/session 模块与系统认证契约。无密码部署由控制平面所在设备的启动器通过私有管理通道生成 128 位、60 秒、单次消费的 bootstrap ticket，桌面经受限 IPC 交给外壳，Web 启动入口经 URL fragment 交给用户；页面立即清除 fragment，再通过 `POST /chatdsh/gateway/access/superagent/bootstrap` 提交 `{ticket}` 兑换 HttpOnly 会话。成功返回 200 与访问会话元数据，失败使用系统认证错误。票据只存摘要，公共 HTTP 请求不能申请新票据。本机 CLI 经相同私有通道取得 Bearer 会话，远程客户端使用既有登录凭据；Unix 管理 socket 使用 0600 权限与对端用户检查，Windows 命名管道限定所有者 SID，执行角色无法访问。SA06 负责该用途的票据类型、兑换端点和真实拒绝验证，令牌生命周期继续采用系统访问会话规则。

启用前的项目身份注册由既有项目服务完成，失败保持普通模式可用。单机运行同样经过本机控制平面；缺少用户通道时，Agent 无法代替用户发出决定。项目进入接口不自动批准任何执行权限扩张。

## 2. 请求与返回

读取超时、写入受理超时、载荷和分页限制采用 `DEFAULT_LIMITS` 及系统通用限制。写操作 JSON 为 `{operationId,expectedRevision,request}`。`operationId` 使用现有 128 位操作标识 schema；revision 为非负安全整数，创建时为 0。控制平面和宿主都计算实际请求摘要，摘要只包含业务请求字节，不包含短期签名。

HTTP 200 返回已确认结果；202 返回已受理结果引用；409 表示冲突、恢复要求或结果未确认；400 输入非法；401/403 身份与权限拒绝；404 对象不存在；413/429/503/504 沿用容量、依赖和超时语义。所有业务响应使用 `Outcome<T>`，读取错误使用 `{error:{code,detail}}`，detail 禁止包含凭据与请求原文。同一操作同一摘要返回原结果，异摘要为 `operation-conflict`。连接中断不创建替代操作。

| HTTP 与相对路径 | 对应方法 | 输入、结果与状态校验 |
|---|---|---|
| GET `/` | getProject | ProjectView；不创建 Router |
| GET `/eligibility` | getEligibility | Eligibility；检测 Git 与执行能力，空仓库返回 empty |
| POST `/enter` | enter | 空 request；expectedRevision=0 可用于首次进入，存在时返回同一主会话 |
| PUT `/config` | configure | 完整 ProjectConfig；request.revision 等于 expectedRevision，服务端比较当前配置 revision 后增加版本；扩大权限由当前用户操作授权 |
| POST `/messages` | send | text、references、可选 goalId/targetTaskId；返回稳定 messageId 和 goalId；文本、目标归属和引用校验通过后才受理 |
| GET `/messages` | listMessages | 逻辑主会话真实用户及模型消息分页；保留 DSH 来源与顺序，任务状态单独显示 |
| GET `/goals` | listGoals | 当前目标与历史目标分页，返回累计模型用量、任务数量与有效额度 |
| GET `/tasks` | listTasks | cursor、state、limit；返回 Page，limit 默认 50、上限 200 |
| GET `/tasks/:taskId` | getTask | TaskView；包含等待原因和有效尝试 |
| GET `/artifacts/:artifactId` | getArtifact | 元数据和首段文件清单，完整清单通过 pages 读取 |
| GET `/artifacts/:artifactId/pages` | artifactPages | cursor、文件选择；UTF-8 展示上限按 artifactPageBytes；二进制返回受认证下载引用 |
| GET `/decisions` | listDecisions | 待处理决定，项目过滤、分页；用户正文只在认证结果内返回 |
| POST `/decisions` | decide | decisionId、scopeDigest、choice、可选 answer；比较决定 revision 与有效状态 |
| POST `/control` | control | taskIds、goalIds、includeRouter、pause/stop/resume、scopeDigest；比较项目 revision 和所选状态摘要 |
| POST `/reviews` | prepareReview | artifactIds、targetRef、commitMessage、action；返回准备操作引用，成果闭包、目标、动作与索引冻结后产生 ReviewView |
| POST `/artifacts/accept` | acceptArtifact | 仅无文件变更的报告；artifactIds、scopeDigest，比较项目及成果 revision，记录用户接受 |
| GET `/reviews/:reviewId` | getReview | ReviewView、差异分页引用与验证证据 |
| GET `/reviews/:reviewId/pages` | reviewPages | cursor、path、view；按 project/commit/staged 返回最终候选的真实文件差异，默认 project |
| POST `/apply` | apply | reviewId、manifestDigest、apply/apply_commit；比较 review revision 与实际目标状态 |
| GET `/applies/:applyId` | getApply | ApplyView 与实际阶段、冲突和恢复检查摘要 |
| POST `/applies/recover` | recoverApply | applyId、continue/restore_files/abort、inspectedDigest；比较 apply revision |
| GET `/operations/:operationId` | getOperation | 已确认、受理中、冲突或未确认；只查询原操作 |
| POST `/enable` | enable | scopeDigest；启用已经停用的同一项目主会话，保留原任务暂停与恢复决定 |
| POST `/disable` | disable | scopeDigest；用户已经处理活动任务，Router 与实际后台执行体确认停止后才执行 |
| GET `/events` | events | Last-Event-ID 或 cursor；SSE 业务事件，断开可以按游标重新订阅 |
| GET `/objects/:digest` | getObject | 按 object_links 验证本项目引用，流式读取成果、报告或证据；不接受文件系统路径 |

`enter` 是用户可写的取得或创建动作，不消费运行预算。`send` 的内容即用户对当前目标的执行授权，任务创建时保留 messageId 来源。`resume` 必须消费当前恢复、暂停或预算决定；无法用普通消息文本解除 recovery。`apply` 只消费就绪的 ReviewView，准备审阅和批准内部依赖均不产生项目文件写入授权。

## 3. 字段验证

| 字段 | 服务端约束 |
|---|---|
| ID、operationId、revision | 复用 core-contracts 已有 schema；对象归属以数据库为准 |
| Digest / scopeDigest | 小写 SHA-256 十六进制，64 字符；对象内容摘要采用原始字节 |
| GitOid | 按仓库 objectFormat 选择 40 或 64 个十六进制字符，使用 Git 验证对象类型；空基准显式 null |
| title / text / commitMessage | 标题最多 200 码位；消息不超过 maxMessageBytes；提交信息最多 64 KiB，保留原文 |
| targetRef | 使用当前 HEAD 对应的合法本地分支，用 Git 校验；detached HEAD 仅允许 action=apply、targetRef=HEAD；目标字段由用户界面取得 |
| artifactIds / taskIds / goalIds | 去重且最多 200 项；成果集合非空；control 在 includeRouter=true 或 goalIds 非空时允许 taskIds 为空；事务内检查同项目、依赖闭包、有效版本 |
| artifact path | 规范化的仓库相对路径；拒绝绝对路径、NUL、`..` 越界、引用目录和 Git 私有路径；大小写碰撞按目标卷检查 |
| Reference | 来源真实路径必须存在并是目录，目标相对路径不覆盖已跟踪代码、私有目录或其他引用；readOnly 必须为 true |
| model / assistant | 通过目标设备的实际目录验证提供方、模型、预设及所需能力 |
| prepareCommands / verifyCommands | 每项为非空 argv 数组；最多 64 项，每项编码后不超过 64 KiB；执行使用项目批准的范围 |
| resources / resourceIds | 配置最多 128 个唯一资源；任务最多选择 32 个已有 ID；范围为 project/device，禁止通过新 ID 绕过同名资源预留 |
| network | deny 通用；domains 用于 srt，network 用于已批准 Docker 网络；不支持的组合返回 network-policy-unsupported |
| ProjectConfig | 限制采用架构第四节范围；未知配置拒绝，禁止用缺省值掩盖无效输入 |

配置路径、Git 输出、提交格式和网络地址使用成熟库解析；Git 客户端使用 `simple-git`，JSON 使用原生解析，校验使用 Zod，地址规则复用 core-deployment。禁止按 Git 索引、Git 对象或差异文件格式自行编写解析器。

## 4. Agent 工具方法

工具名统一为 `chatdsh_superagent`，包含 `{method,args}`；方法目录按角色生成，服务端执行时再检查。

| 方法 | Router | Worker | 子代理 | 强制条件 |
|---|---|---|---|---|
| create_task | 允许 | 拒绝 | 拒绝 | 当前用户目标、同项目、队列额度、DAG 检查 |
| deliver | 允许 | 拒绝 | 拒绝 | 已有任务范围与当前代次，跨任务资料授权有效 |
| report | 允许 | 允许 | 允许 | Router 只能报告协调事实；执行角色只报告自身尝试 |
| request_dependency | 允许 | 允许 | 拒绝 | 创建 pending 决定，不能交付内容 |
| request_stop | 允许 | 拒绝 | 拒绝 | 当前用户来源消息、明确任务集合；宿主生成固定范围的用户确认卡片 |
| ask | 允许 | 允许 | 允许 | 创建具体问题，保留真实调用关联；子代理归入父任务 |
| spawn_child | 拒绝 | 允许 | 拒绝 | 父角色 worker、同 taskId、childDepth=1、名额与预算有效 |
| read | 允许 | 允许 | 允许 | Router 读本项目授权资源；执行角色读自身任务、已获准输入和登记参考资料 |

工具不能调用 decide、control、apply、recoverApply、configure 扩权、enable 或 disable。Router 可以根据来源用户消息请求创建停止确认卡片，来源 messageId 必须是当前用户未消费的输入；宿主固定目标与状态摘要，用户确认后执行。ask 的普通问题内容不能构造停止或其他副作用。用户按钮和结构化命令直接调用相应用户入口，不等待 Router 模型。

create_task 的 originMessageId 必须对应当前目标的初始用户消息，资源和依赖均逐项检查。send 未提供 goalId 时建立新目标；提供时追加到该目标，targetTaskId 存在时还必须属于同一目标。目标预算耗尽只能通过有效预算决定增加额度。模型文本、追问和普通配置读取均不能重置累计计数。

report 的 files 为当前执行目录中的成果路径集合，最多 100000 项。大型清单使用同目录 filesManifestPath，文件为最多 16 MiB 的标准 JSON 字符串数组，由受管文件辅助程序读取并使用 JSON.parse 验证；files 与 filesManifestPath 互斥，宿主保存校验后的不可变清单对象。reportText 不超过 maxMessageBytes，作为真实 Agent 报告保存。ready 必须提供文件清单或报告内容；scope、生产会话和验证状态由宿主取得。read 在权限检查后，可以把固定成果通过宿主交付到当前会话的只读 inputs 目录，返回本会话可访问的引用与摘要；该目录不共享其他任务的对象。spawn_child 先封存父任务的实际输入版本，再建立子代理，模型无法通过传入一个未登记摘要伪造输入快照。

已结束的目标保持只读，继续工作需要通过新用户消息建立新目标，界面保留前一目标的显式引用。enter 对既有 disabled 项目只返回原主会话，enable 使用当前项目 revision 和配置范围重新启用；它不会恢复旧任务或消费重启恢复决定。

prepareReview 固定所选 action；apply 的 action 必须相同。选择另一动作、修改提交信息或切换分支时重新准备并展示对应候选。应用模式执行项目验证；应用并提交模式还执行提交钩子、消息和作者身份检查，分别生成审阅摘要。

reviewPages 的 project 视图为实际工作文件 W 到 W' 的变化；commit 视图为 H 到 R，仅在 apply_commit 审阅提供；staged 视图为最终基准到最终索引，apply_commit 使用 R 到 I'，apply 使用 H 到 I。所有内容来自该审阅固定的对象，包含钩子与依赖的最终结果。原始 ArtifactFile 页面用于任务成果查看，成果审阅使用对应 reviewPages。

原生文件、命令、终端、浏览器和 MCP 工具都经过本项目 actor 与执行策略。Worker 和子代理不暴露主机桌面控制、会话创建与配置管理工具。需要网页研究时使用获准的网络工具；访问限制、凭据范围和外部写审批沿用项目实际策略。

## 5. 业务事件与并发

事件事务提交后才能发布。SSE 的 ID 为 `storeGeneration:eventId`，eventId 来自数据库追加事件。业务对象有独立 revision。重连只重新读取事件，用户写操作保持原幂等语义。游标属于旧数据库世代、已归档范围或未知项目时返回 `resync_required` 事件并关闭流；客户端读取完整状态与新游标后订阅。

`resync_required` 是 SSE 传输控制事件，负载为 `{reason:'generation'|'archived'|'project',projectId}`，不作为 StreamEvent 写入业务事件表。客户端传输适配器处理该事件并重新取得快照，业务事件迭代接口只产出已经校验的 StreamEvent。

订阅先在一致读事务中取得快照及游标，再从游标之后消费事件。事件重复按 ID 去重，客户端只接受当前设备、项目与更高对象 revision。事件不满足连续读取条件时重新读取对象，禁止以模型摘要替代状态。慢消费按系统事件缓冲上限终止，用户草稿和服务器任务保留。

列表同时受条目数量与 pageBytes 限制。MessageView.text 最多 messagePreviewBytes，textRef 指向完整真实内容，truncated 明确表示预览截断；长消息展开通过认证对象读取，内容不会被模型摘要替代。流式消息按有界片段推送并更新同一消息 revision，重连按 textRef 取得已持久化检查点。

## 6. 错误归属

`ERROR_CODES` 是完整业务码集合。git-required/git-bare/git-unreadable 用于仓库入口；executor-unavailable/isolation-unavailable/network-policy-unsupported 用于执行准备；owner-offline/owner-conflict/generation-stale 用于归属；revision-conflict/operation-conflict 用于并发；depth-exceeded/dependency-unapproved/dependency-cycle/permission-denied 用于权限；budget-exhausted/queue-full/resource-busy 用于资源；artifact-stale/review-stale/git-conflict/hook-failed/object-missing 用于成果；recovery-required/stop-unconfirmed/apply-unconfirmed 用于人工处理；其余输入或内部错误就地失败。

输入形状和字段错误使用 request-invalid，未分类的宿主异常使用 internal-error；两者保留出错阶段，禁止继续执行后续业务步骤。

各失败响应同时写入带 `error.type/error.code` 的遥测事件。业务错误 detail 可以包含受认证的文件定位信息，遥测只记录登记过的类型、阶段、结果与匿名标识。所有未确认错误都返回稳定操作引用，客户端先查询事实。
