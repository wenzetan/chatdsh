# Super-Agent 存储、状态迁移与恢复

数据库结构以 [schema.sql](schema.sql) 为准，字段语义和应用阶段使用 [contracts.ts](contracts.ts)。业务实现使用 `node:sqlite`，Super-Agent 运行基线 Node 至少 24.0；一条同步写连接通过命令队列串行执行，事务使用 `BEGIN IMMEDIATE`。数据库路径为设备数据根 `superagent/state.sqlite`，与任务执行目录分别授权。

## 1. 写入职责

| 数据 | 唯一写入者 | 写入要求 |
|---|---|---|
| projects/configurations/router_runs | 宿主项目与协调服务 | 配置按 revision 追加；有效 Router 唯一；owner 与真实目录不可由 Agent 改写 |
| tasks/task_waits/attempts/agent_sessions | Engine 命令服务 | 当前代次与 revision 比较成功后更新；人工等待原因只能由对应决定消除 |
| messages/goals | 用户输入服务与 DSH 事件适配器 | 用户消息关联真实 send 操作；模型消息关联 Router 会话与事件序号；目标保存累计额度 |
| operations/decisions/applies | 用户命令入口与应用服务 | 用户身份由认证入口提供；操作摘要与授权对象绑定 |
| artifacts/objects/review_artifacts | 成果服务 | 内容先持久保存，摘要校验成功后建立不可变关联 |
| outbox/deliveries | 投递服务 | 先保存意图，再执行，获得实际回执后确认 |
| events | Engine 同事务追加 | 提交后发布；客户端断开不丢失业务事件 |
| reservations/processes | 执行服务 | 分配前预留；失败、未知和实际释放分别记录 |

DSH 权威会话日志由其 Agent 生命周期单写者写入。宿主不在活动 Agent 之外构造并发日志写句柄。业务状态存储、DSH 日志与文件系统没有共同事务，依靠持久意图和实际结果核验连接。

## 2. 统一事务顺序

每个命令执行：认证 actor 并核验项目归属和当前调用权限；计算请求摘要并查询原操作；已有操作在摘要和访问范围匹配后直接返回原状态。只有首次操作继续校验当前代次、对象范围与 revision，再在一个事务内写入业务状态、事件和 outbox；提交后通知 outbox 执行器。历史操作回放不会因后续 revision 增长而重新执行或被当作首次写入。外部网络、文件复制、Git 操作与模型调用均在事务外执行。

首次操作建立 operations accepted。重复相同 ID 与相同字节摘要返回既有状态或结果；不同摘要返回 operation-conflict。有效的客户端重复请求使用新的传输 nonce，业务 operationId 保持不变。未确认操作 expires_at 必须为空；普通已确认操作结果保留至少 30 天，之后保留 ID 与摘要墓碑，防止旧操作重新执行。

project.revision 用于项目身份、配置与启停控制，任务进度和消息片段更新各自对象 revision。消息追加在项目版本检查通过的同一事务中分配 position，不因并行任务每次进度变化而使输入自动过期。

带 revision 的对象使用条件更新比较当前 revision；具有 generation 的执行对象还要比较当前 generation，影响行数为零立即拒绝。每次更新增加 revision。projects.generation 表示所属设备的执行代次，router_runs.generation 表示 Router 代次，tasks.generation 与 attempts.generation 表示任务尝试代次，三者分别递增。切换 Router 模型只更新 Router 代次，不使正在执行的 Worker 失效；设备重启或接管更新项目执行代次并进入恢复等待。模型 actor 按角色匹配当前 Router 或 attempts、agent_sessions，以及当前项目执行权。数据库约束与触发器负责基础身份、层级、唯一性和 DAG，Engine 负责授权内容与状态图。

messages.position 由项目单写事务分配递增整数，分页和展示按此排序。用户消息、初始目标、输入投递意图及消息事件在同一事务中登记；初始消息的 goal_id 在事务内关联新建目标。模型消息身份由真实 source_session_id 与起始 source_seq 唯一确定，流式文本检查点更新 text_ref、state 与 revision。适配器只接收 DSH 的真实文本事件，重复事件不再次追加；中断输出保留 interrupted，业务通知保存在独立事件中。DSH 日志提交与业务检查点之间中断时，按来源序号重新读取日志并更新原消息。

目标以首条用户消息作为 goalId。追问保存原 goal_id；根任务 origin_message_id 关联该目标，创建事务同时增加 tasks_created。每次模型预留同时核对目标累计额度、任务额度和并发额度，Router 请求也有目标预留。goals 的终态由全部任务和未处理决定的真实结果计算，模型回复结束不自动完成目标。

## 3. 对象与授权摘要

对象使用 SHA-256 按原始内容寻址。元数据写入前执行文件 fsync，宿主将暂存对象原子重命名到对象目录并同步父目录；数据库随后建立 object_links。数据库事务失败会留下无引用对象，由只读扫描确认无引用后回收。缺失或摘要不符的对象直接拒绝读取和应用。

artifacts 保存 attempt_id、producer_session_id 和 scope。内部快照及子代理输出只用于同任务，task-output 才能进入跨任务依赖和项目审阅。latestArtifactId 查询只选择 task-output；内部版本不会使执行中的根任务自动进入待审阅状态。

成果与审阅清单使用有界 JSON 分页对象，根对象保存总数、输入和分页摘要引用；每页不超过 pageBytes，全部页面通过 object_links 关联原拥有者。审阅分别固定项目写入、提交内容与最终暂存状态的文件页面，避免把原 Worker 差异直接用作最终应用差异。

业务 JSON 对象采用“首次写入的精确 UTF-8 字节”作为摘要依据，数据库保留相同对象字节，后续授权引用该摘要；不要求调用端自行重建同一 JSON。授权对象包括具体任务、版本、用途、策略版本和有效期。决定表 payload 用于展示，scope_digest 关联不可变对象，用来校验实际授权。

dependencies 只有在 allowed 决定覆盖该 producer、artifact 摘要与 consumerTaskIds 时才能写入。SQL 约束还会拒绝不同项目、错误生产任务与循环依赖。撤销决定更新 state 并给消费任务增加等待原因，读取端每次使用前重新校验。已经纳入不可变成果的旧输入保留来源与撤销标记，应用准备重新检查授权。

## 4. 启动与用户恢复

宿主先取得数据库进程级排他锁，校验 schema_migrations，再将所有活动 Router、attempt 和 agent 标为 interrupted。对原 preparing/running/queued 任务增加 recovery 等待原因，原 waiting 任务保留已有原因并在存在中断执行时增加 recovery；review/completed/cancelled 保持对应状态。

原 pending/running outbox 中会启动 Agent、投递执行输入或应用文件的动作全部 held；读取、通知与只读副本复制可以继续。清单记录原尝试、输入接收状态、后台进程、未确认应用和资源预留。重启前未完成的用户授权操作不被视为新一轮恢复授权。

执行器重连先核验进程身份：Unix 使用 pid、启动时间与进程组及受管 helper 身份；Windows Docker 使用容器 ID、创建时间和标签。正常关闭时终止所拥有的进程树。异常残留如果仍在执行，宿主先停止受管执行并展示实际确认结果；不能确定归属的进程只展示问题，禁止按裸 PID 误杀。确认前无新的输入和模型调用。

用户恢复选择生成新的 scope_digest，记录任务、当前旧尝试和实际资源状态。允许后结束旧尝试并建立新尝试，原目录保留作输入与证据；新目录从已确认停止的旧工作内容封存版本建立。代码基准和逻辑 effectiveBaseTree 继续采用该任务原记录，恢复 seed 只恢复工作内容，不把此前修改排除在最终成果差异之外。新执行会话继承真实历史与任务事实，调度关联指向新尝试；重新投递原未读输入时使用原 delivery ID，避免重复进入历史。已读输入不作为新用户请求重放。主机结果或权限版本发生变化时重新生成清单。

恢复清单单独包含 Router。control 的 includeRouter 指定是否恢复协调执行，允许只选择 Router。没有根任务的项目也能明确恢复 Router；新消息先保存为输入，不会隐式释放重启前 held 的执行动作。用户可以只恢复所选任务，其他任务与 Router 保持等待，报告由宿主保存并直接展示。

## 5. 应用日志与中断处理

应用阶段的具体文件算法见 [execution.md](execution.md)第五节。数据库 applies 和 apply_files 保存每个写入阶段、前后内容与文件模式，实际文件证据在对象库中。数据库进度不能单独证明文件已经完成，恢复时逐项核对实际内容。

| 观察到的事实 | 允许的处理 |
|---|---|
| 文件等于 before，阶段未开始 | 继续需要用户恢复授权；尚未发生的写入可以中止 |
| 文件等于 after，阶段尚未确认 | 补充已发生事实，保留恢复等待；禁止重复覆盖 |
| 文件既不同于 before 也不同于 after | 标记冲突，显示实际文件变化，用户处理后产生新检查摘要 |
| 索引符合原始或候选版本 | 记录实际位置；继续前取得用户授权 |
| 分支指向 candidate_commit | 记录已发布事实；验证树、文件与暂存意图后结束原操作，不创建重复提交 |
| 分支被其他操作更新 | 标记冲突，不移动该分支；显示应用记录与当前实际引用 |

用户选择 restore_files 时，仅恢复实际仍等于本操作 after 的文件，内容来自 before 对象。文件被外部编辑过时拒绝自动恢复该文件。索引恢复也要求当前摘要等于本操作记录的候选摘要。已经发布的提交保留；需要后续内容修复时建立明确的文件修改与新成果。用户选择 abort 只停止未发生阶段并保留实际记录，不能把部分写入标成全部未发生。

## 6. 迁移、索引与备份

第一版 schema 只由迁移服务安装，校验和使用 schema.sql 的 SHA-256。迁移以维护窗口执行，停止新命令、生成一致备份、校验 SQL、执行迁移并验证外键。未知较新版本拒绝写入。已有 projects_store 保持原路径键和普通接口兼容，增加 projectId/defaultMode 字段与持久身份映射；启用入口将相同 UUID 注册到本数据库，双存储衔接使用 stable operationId。只有注册完成后返回可写 Super-Agent。

任务查询使用项目、状态和创建时间索引；消息使用项目与 position；事件使用项目与递增事件 ID。列表游标是不透明对象，内容包含筛选摘要、最后排序键和 store generation，使用标准 JSON 加 Base64URL 编码并校验，页大小受协议限制。复制只读业务事件和成果摘要到控制平面，设备数据库仍为执行权威。副本缺失时返回实际可读范围，禁止据此建立新的活动 Router。

备份使用 SQLite 一致备份接口，同时固定 DSH 日志检查点、成果对象、apply before/after 对象、配置和所有未完成任务的必要代码。在线写入在检查点之外继续，清单固定所包含的事件范围。对象回收必须检查数据库外键、object_links、未完成 outbox、依赖和活动备份引用。受理中、待决定、未确认数据没有按时间强制删除路径。

恢复建立新的 store generation，轮换用户命令密钥，清除旧 nonce，所有活动执行进入恢复等待。参考目录重新验证真实路径及权限，不复制参考内容来掩盖缺失。损坏对象、缺少恢复文件、Git 对象缺失或未知 schema 均明确失败。
