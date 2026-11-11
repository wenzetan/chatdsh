# 系统完成设计

## 1. 契约范围与实施依据

本文件定义设备通信、安全、数据连续与跨组件契约。平台能力归属、提供方适配、绑定与生命周期采用[插件平台架构](plugin-platform.md)，基础形态遵循[目标形态](target-shape.md)，客户端遵循[完整交互规格](client-complete-spec.md)。实现任务采用[工作包](implementation-work-packages.md)，设计交付不改变[实际验收状态](acceptance.md)。

固定约束：单用户部署；每台执行设备一个运行时；会话 `deviceId/cwd` 创建后固定；设备日志为权威；控制平面保存只读副本；图形客户端每窗口一个活动设备 iframe；移动载体为 PWA。客户端离线仅保留草稿，恢复不自动发送。在线运行中的消息队列失联后暂停，用户确认后恢复。

项目级 Super-Agent 的完整开发契约采用[专项设计](superagent/README.md)。其任务、人工决定与应用日志属于执行设备权威数据，控制平面持有只读视图。普通用户消息离线规则继续生效；已经受理的设备侧任务具有独立生命周期，客户端关闭不取消任务，宿主中断后的继续执行由用户决定。

| 已核验实现 | 事实与目标差异 |
|---|---|
| [设备链路](<../gateway/src/device-link.ts>)、[设备宿主](<../packages/host/device-link/src/index.ts>) | 当前整包 Base64 请求与响应，宿主全量读取响应；目标流式多路复用、背压与取消 |
| [网关路由](<../gateway/src/server.ts>)、[WebSocket](<../gateway/src/websocket.ts>) | 当前设备前缀升级拒绝、帧处理为手写；目标采用成熟 ws 库 |
| [存储](<../gateway/src/store.ts>) | 当前缺少版本迁移；副本最大序号不能证明连续；目标事务连续追加与迁移登记 |
| [Hermes 客户端](<../../hermes-adapter/src/client.ts>)、[聊天宿主](<../packages/host/chat-hermes/src/index.ts>) | 当前只提交输入且批量回写事件；目标完整历史与即时事件、审批、取消统一运行接口 |
| [记忆宿主](../packages/host/memory/src/index.ts)、[Hindsight 适配器](../../hindsight-adapter/src/index.ts) | 现有自建召回与写入，目标由标准能力消费所选插件，原生操作能力分别验证 |
| [自动化](<../gateway/src/automation.ts>)、[推送](<../gateway/src/push.ts>) | 目标补齐真实目标执行、持久投递状态、Web Push 与慢消费控制 |

## 2. 设备通信与执行路由

### 2.1 协议和状态机

设备出站连接控制平面，使用 `ws` 的标准握手与帧实现。连接握手携带协议版本、节点令牌、deviceId、运行时版本、能力列表与连接代次。控制平面验证令牌所属设备、版本和角色；相同设备新代次替换旧连接，旧代次全部请求明确失败。

每个 WebSocket 消息承载一个 MessagePack 对象，统一使用 `@msgpack/msgpack` 编解码并通过共享 schema 验证；data.payload 为二进制数组，payloadLength 必须与数组字节数一致。禁止自行解析 WebSocket 或 MessagePack 字节协议。公共字段为 `version/type/channelId/generation/seq`，channelId 为连接内唯一 UUID，generation 为服务端签发的连接代次，seq 为非负安全整数。类型如下：

| 类型 | 必需字段 | 行为 |
|---|---|---|
| hello / welcome | version、deviceId、generation、limits | 建立唯一设备连接，未知主版本拒绝 |
| open | channelId、kind、method、path、headers、operationId | kind 为 http 或 websocket；目标只允许该设备回环运行时 |
| accepted | channelId、status、headers | HTTP 响应头或 WebSocket 升级成功；禁止提前声明业务完成 |
| data | channelId、seq、payloadLength | 单方向序号从零连续，数据长度不得超过额度 |
| credit | channelId、bytes | 消费完成后补充发送额度，按方向独立计量 |
| end | channelId、lastSeq | 正常半关闭；双方结束后释放通道 |
| cancel / cancelled | channelId、reason | 中断真实 HTTP、订阅或工具等待，确认资源已经释放 |
| reset | channelId、code | 终止单通道，错误包含稳定枚举 |
| ping / pong | generation、nonce | 维护连接活性，不承载业务内容 |

通道状态为 opening → active → half-closed → closed；任何非终态可以进入 cancelling 或 reset。未知通道、错误序号、超额发送立即 reset；持续协议违规关闭设备连接。连接断开结束全部通道，禁止自动重放写入。订阅重建使用已确认事件游标，写入使用 operationId 查询结果。

### 2.2 固定预算

每设备最多 128 个通道；每连接发送缓冲最多 8 MiB；每通道初始单向 credit 256 KiB，额度总和仍受连接预算约束；data.payload 最多 32 KiB，完整 MessagePack 消息最多 64 KiB；非数据控制消息最多 64 KiB。握手 10 秒，普通响应头 30 秒，流空闲 75 秒，心跳 30 秒，取消确认 2 秒。超时返回明确错误并关闭受影响通道。慢消费者先暂停上游读取，超过预算终止该通道，不阻塞其他设备。

`/d/:deviceId/` 同时代理静态资源、插件、HTTP API 与受允许的 WebSocket 升级。升级路径使用明确白名单。仅允许以单个 `/` 开始的相对路径，拒绝完整 URL、`//`、路径穿越及解码后越界。设备宿主解析后必须验证 origin 等于固定回环运行时 origin。外来 Cookie、Authorization、转发头全部移除，运行时凭据由设备插件添加。响应按设备前缀处理资源路径、跳转和 Cookie 路径，禁止泄露运行时令牌。

### 2.3 写操作与会话导航

所有写操作携带 128 位随机 operationId 与请求摘要；同标识同摘要返回已保存结果，异摘要返回 409。未确认结果返回 unconfirmed，客户端查询后再决定，不重复执行。创建会话使用 preparing/created/committed 状态，归属登记与设备创建之间失败可恢复；只有 committed 会话出现在可写列表。

iframe 导航消息包含版本、requestId、deviceId、sessionId；验证 origin、source 和 schema，握手后才接受导航。内容端返回 selected 或 rejected。旧代次响应丢弃；5 秒未确认显示打开失败，禁止把默认会话当作选中会话。跨设备卸载旧 iframe，草稿、侧栏和阅读位置由外壳保持。

## 3. 访问认证与安全边界

部署级访问凭据与节点令牌独立，无账号表。密码使用 Argon2id（内存 64 MiB、迭代 3、并行 1、随机盐 16 字节）；通行密钥使用成熟 WebAuthn 服务库，校验 RP ID、精确 origin、challenge、用户验证和签名。TOTP 使用成熟库，30 秒周期，允许前后各一个时间窗口，同一已接受时间片禁止重用。

访问会话令牌随机 256 位，服务器只存 SHA-256 摘要；HttpOnly、Secure、SameSite=Lax、Path=/，禁止 URL 长期令牌。绝对有效期 30 天，最后 7 天有活动可续期；危险操作要求 5 分钟内再次认证。密码失败按来源与部署双限流，5 次失败等待 5 分钟，后续逐次加倍至 1 小时。统一错误不泄露凭据配置细节。

配对码 128 位随机载荷，以二维码或可输入编码展示，5 分钟有效、单次事务消费，绑定角色和目标控制平面。节点令牌随机 256 位，仅建立时返回，服务器存摘要。每节点 90 天轮换，24 小时重叠窗口；撤销立即关闭链路和现有业务订阅，历史会话归属保留。恢复码生成 10 条独立高熵值，仅展示一次，单独存摘要并事务消费。

TOTP 密钥、可恢复服务凭据和备份密钥使用 AES-256-GCM 信封加密，随机 12 字节 nonce，AAD 包含部署、记录类型和版本；主密钥存系统安全存储或权限 0600 的独立文件。密钥版本入记录，轮换分批重加密，解密失败明确拒绝。PWA 的 WebCrypto 仅保护本地静态数据，XSS 防护仍依赖 CSP、成熟 HTML 清理、严格资源边界；不声称浏览器加密可以抵御同源恶意脚本。

私有 HTTP、SSE、WebSocket 和文件下载统一验证访问会话及对象范围；写入再验证 CSRF 与精确 Origin。浏览器 WebSocket 使用同源 HttpOnly 会话或有效 30 秒的一次性 ticket，ticket 不写日志。CSP 禁止任意脚本；外部 HTML 制品独立 sandbox，禁脚本、表单、同源身份与顶层导航。公开分享仅接受独立签名令牌，默认排除内部路径、工具参数、记忆和敏感元数据。

## 4. 持久化、迁移与连续副本

控制平面数据通过统一存储接口，默认 SQLite；设备日志默认 JSONL。Postgres 作为可替换实现，不隐式启用。接口包含事务、归属、操作幂等、设备、访问会话、设置 revision、自动化投递、分享、通知、用量、对象引用、迁移和备份记录。

目标新增持久记录如下，全部使用存储事务接口：

| 记录 | 唯一键与关键字段 |
|---|---|
| operations | operationId；requestDigest、deviceId、state、resultRef、createdAt、expiresAt；完成结果保留 30 天，未确认操作不得按时间直接删除 |
| access_sessions / credentials | tokenHash；createdAt、expiresAt、revokedAt、lastVerifiedAt；凭据按类型保存哈希或加密字段 |
| device_generations / pairing_codes | deviceId/generation；令牌摘要与撤销状态；配对摘要、角色、期限、consumedAt |
| replica_cursors / replica_outbox | sessionId/retentionGeneration；continuousSeq、digest；扫描范围与确认游标 |
| run_inbox | runId/eventId；seq、payloadRef、appliedAt；仅已应用且已归档事件可回收 |
| capability_operations | 设备侧 operationId；领域、提供方实例与版本、bindingRevision、requestDigest、nativeOperationId、state、resultRef；保留未确认结果 |
| notification_outbox / subscriptions | 业务关联键/客户端；state、tag、expiresAt；加密端点与推送材料 |
| backup_manifests / migration_jobs | jobId；schemaVersion、sourceDigest、targetDigest、checkpoint、state、manifestRef |

新增 `schema_migrations(version,checksum,applied_at)`；启动获取排他迁移锁，验证所有已应用校验和与目标版本。较新未知 schema 拒绝写入。迁移使用维护窗口：停止新写入、等待进行中事务、生成一致性备份、执行版本迁移、校验数据、原子切换。大数据复制使用持久检查点；中断重启先验证源和目标摘要，禁止覆盖不同目标。源数据保持只读，恢复使用经过验证的数据副本与配置编辑。

副本主键为 `(sessionId,seq)`，同时保存内容摘要。内部连续前缀从 -1 开始；同序号同摘要幂等确认，异摘要返回 409 `replica-content-conflict`，缺口返回 expectedSeq。事件、连续前缀、字节账本、通知 outbox 在同一事务提交，提交后才确认与广播。禁止使用最大序号代替连续性。

设备上报先保存持久补传意图，事件正文从权威日志读取。启动、重连及日志提交触发扫描，包括未打开的冷会话。每批最多 256 事件或 1 MiB；控制平面确认后推进游标。网络重试使用 1、2、4、8、16、30 秒加抖动，持久意图不丢弃。此重试只复制已提交日志，与用户离线发送完全独立。清理副本保存 retentionGeneration，旧补传不能无意重建已清理内容，显式重新获取创建新代次。

Postgres 使用事务、唯一约束与数据库级会话写入锁；专用连接持有 advisory lock，连接失效使旧句柄终止，追加再检查租约代次。`flush` 等待已提交耐久确认；seed/inherited、父关系、冷读、恢复、查询与删除均覆盖完整存储契约。数据库不可达不转移到本地后端。

## 5. 备份与数据生命周期

每天 03:00（部署 IANA 时区）生成加密一致性备份，保留每日 7 份、每周 4 份、每月 12 份；磁盘剩余不足预计备份两倍时明确停止并告警。SQLite 使用一致性备份接口，Postgres 使用原生一致性导出；JSONL 在完整提交边界建立检查点，对象按内容摘要固定。manifest 包含版本、schema、时间、数据域、对象长度和 SHA-256、外部服务边界、加密密钥版本。

控制平面、各设备日志、制品、配置与恢复所需密钥分别列入清单。外部 Hermes/Hindsight 需要单独备份结果引用，缺失时报告实际恢复边界。目标 RPO 为 24 小时；20 GiB 基准数据恢复目标 30 分钟。每月执行隔离恢复演练，验证日志连续、附件字节、归属、父关系及继续会话。

恢复只写入新隔离目录，默认禁止外部自动化和通知发送；校验与用户确认后切换，不覆盖现有数据根。密钥缺失、对象损坏或版本不兼容立即停止。恢复后轮换节点与访问凭据，推送订阅重新确认。

副本默认保留 90 天，软删除收件箱保留 30 天。清理预估与实际结果分别返回，权威日志和工作区文件不受副本清理影响。有效分享使用独立不可变快照，不依赖后续副本保留；附件逐项授权并按引用计数维护。永久删除明确列出日志、副本、对象、分享及恢复范围，不静默级联。

## 6. Hermes 完整历史运行桥接

DSH 日志始终是 ChatDSH 历史权威。每次发给 Hermes 的运行都携带当前有效的完整文本历史、稳定 system、第一条 user、会话标识、operationId 和历史摘要；禁止使用会话头覆盖请求历史。撤销与压缩依据 DSH 有效消息投影处理，读取历史必须分页至结束。跨执行体继承用户和助手文本，工具轨迹作为只读资料保留，不重新执行。

目标适配器契约为 `startHistoryRun({sessionId,operationId,messages,historyDigest,model,permissionContext})`，返回 `runId` 与异步事件流；另提供 `getRun(runId)`、`answerApproval(runId,requestId,decision)`、`cancelRun(runId)`。事件包含 `runId/eventId/seq/type/time/payload`，类型为 accepted、text.delta、tool.started、approval.asked、approval.decided、tool.completed、run.completed、run.failed、run.cancelled。每个运行恰好一个确定终态，重复事件按 runId/eventId 去重。审批到达立即追加并发布，绝不等到运行结束才显示。

现有 Hermes API 的完整历史与运行控制组合尚无验证证据。SYS05 必须交付受维护的历史运行桥接部署产物，适配真实 Hermes 的运行管理与历史注入；禁止直接改写已安装运行文件。桥接先通过完整历史、即时审批、runId 查询与服务端取消四项集成门禁，才能启用 Hermes 聊天能力。能力不满足时配置验证失败，不能将仅返回最终文本的接口作为完整能力启用。

运行事件先写入持久 inbox，再按单会话写者追加 DSH 日志并推进已应用游标。宿主重启从 inbox 和真实 run 查询恢复，防止已写日志后终止导致重复消息。执行体不可达时返回明确错误，服务端已经受理或结果未知时进入 unconfirmed 并查询原运行。禁止自动更换执行体和重放请求。停止请求必须终止同一 run 并取得终态，2 秒未确认显示停止未确认，继续查询且不宣称已停止。

首次 DSH 承载后保存持久 `historyMode=full`，fork 与恢复携带标记；后续每一轮 Hermes 均传完整历史，不能假设一次请求已经补入 Hermes 数据库。界面的本地执行标记读取执行来源元数据，不追加模型可见的解释消息。

## 7. 后端分派、记忆与自动化

标准能力按设备、项目与会话绑定提供方，使用 revision。工作会话保持所属设备的 DSH 执行。每个回合和已受理任务保存实际提供方、适配器版本、配置摘要与范围映射快照，活动操作继续使用原快照。需要重启的插件显示等待重启，真实装载完成后才发布可用状态。默认 provider/model/preset 第一轮后固定。

记忆的召回、写入与管理通过标准 `memory` 接口。原生插件负责抽取、存储和整理，平台适配器映射实际支持的操作和范围。自动召回与写入各自只有一个负责人，采用原生生命周期时不再生成平台摘要。普通会话与内部执行角色的隔离同时覆盖原生监听和后台任务，范围约束无法成立的组合不可启用。

平台操作记录保存原生关联标识和真实结果，不另建通用记忆抽取队列。原生幂等、取消和结果查询按操作分别声明，受理状态未知进入 unconfirmed。没有原生幂等能力时禁止自动重试。跨提供方切换不自动搬迁数据，共享依赖提供方的原生范围和同步能力。完整语义使用[标准记忆契约](plugin-platform.md#6-记忆标准接口)。

webhook 自动化固定 deviceId/cwd/preset，使用事件标识唯一约束、签名时间窗 5 分钟和持久执行状态。状态为 received→validated→dispatching→accepted→completed/failed/unconfirmed。签名校验使用成熟密码学接口和常量时间比较，体积上限 1 MiB；目标离线立即失败，不建立用户消息离线重发任务。已经受理的运行只查询原结果，人工重试沿原事件幂等语义执行。

定时任务只使用设备 `ctx.schedule`，跟随原会话持久化。单次、间隔、每日、每周、cron 互斥提交，IANA 时区及夏令时遵循宿主行为；重复任务恢复仅补最近一次遗漏。控制平面没有第二套调度器，fork 不复制定时任务。

## 8. 通知、PWA、桌面与插件

通知 outbox 在副本提交事务内登记，已读与审批决定分别记录。审批决定撤回同关联键待投递通知，使用稳定 tag 关闭可撤回通知。Web Push 使用成熟 web-push 库与 VAPID，载荷只含事件类别、匿名对象标识和导航目标，不含正文、路径、命令或凭据；过期端点 404/410 立即移除。系统通知只导航到经过访问认证的页面，不能直接批准工具。

PWA Service Worker 只缓存版本化静态资源，禁止缓存私有 API、认证、带分享令牌页面、记忆和工具结果。更新由用户确认激活，保留草稿，不停止设备上的回合。通知权限必须用户操作触发；系统回收后的送达时间由系统与推送服务决定，页面明确说明。扫码不可用时使用手动配对。离线保存草稿不建立 Background Sync 业务队列。

桌面采用 sandbox、contextIsolation，禁用 renderer Node，preload 只暴露 schema 约束的固定 IPC。校验发送窗口、origin、对象与平台能力，禁止任意命令和文件路径执行。每窗口一个设备 iframe，全部窗口共用运行时；授权控制状态由宿主统一广播。桌面控制持续展示目标、授权期限与立即中断，租约失效后禁止新动作。有副作用的注入不自动重试。更新包完整性与签名验证全部通过后方可安装，任务与草稿影响需要确认。

可选记忆与 PWA 使用独立组合包。停用不创建后端连接、SDK、扫描或订阅资源；运行中任务持有完成所需资源，停止接收新任务后有界释放。目标发行 profile 为 Web、桌面、CLI，Hermes 作为运行期能力。旧 Android、worker、Hermes 专属 profile 和控制平面调度器按明确删除子任务处理，保留配对、移动兼容入口与内部副本。

## 9. 部署与容量默认值

运行时仅绑定回环。生产控制平面使用受保护 HTTPS，允许受信任 Tailscale 入口或经客户端证书验证的指定设备网络地址；具体绑定约束采用[可达性规范](<reachability.md>)。禁止通配公网监听和未验证代理身份头。证书到期前 30 天告警，轮换支持现有连接自然结束；新连接仅使用有效证书。开发 HTTP 只允许显式开发配置与回环来源，不能成为生产安全策略。

| 边界 | 默认限制与失败行为 |
|---|---|
| 普通 JSON 请求 | 1 MiB，读取前校验长度，流读取中再次计数；超限 413 |
| 单次消息 | UTF-8 256 KiB；超限保留草稿并显示限制 |
| 单附件 / 单回合附件 | 25 MiB / 100 MiB；最多 10 个；分块流上传 |
| 录音 | 最长 10 分钟、最大 25 MiB；停止后用户确认上传 |
| 文本预览 / 工具展示 | 1 MiB / 256 KiB；更大内容提供完整下载或分页 |
| 列表分页 | 默认 50、最大 200 条；历史按事件与字节双限制读取 |
| 在线待处理消息 | 每会话 20 条，失联暂停；超限拒绝新增且保留输入 |
| SSE 客户端 | 每访问会话 4 条连接，单连接 1 MiB 缓冲；慢消费断开并给出续读入口 |
| 导出 / 备份并发 | 每部署各 1 个，显式有界队列 4 项；超限 429 |
| API 超时 | 读取 15 秒、写入受理 30 秒；已受理运行采用独立状态查询 |

容量基准为 4 核 CPU、8 GiB 内存、SSD、两台执行设备、10000 条会话摘要、每个长会话 50000 事件、20 个并发流、100 个长连接、设备 RTT 20ms、吞吐 100Mbps。模型首字和外部推送时延单独记录，不计入控制平面开销。

验收门槛：静态外壳冷加载 p95≤2秒；列表首屏 p95≤500ms；已连接设备事件代理附加延迟 p95≤100ms；本地输入反馈 p95≤50ms；大历史首段呈现 p95≤1秒；控制平面 RSS≤512MiB，当前活动客户端 RSS≤768MiB；100次设备切换后订阅和通道回到基线，稳定 RSS 增长≤10%。超限必须明确拒绝，不能通过静默丢弃事件满足预算。不同环境另登记容量结果，既定基准未通过保留未完成状态。

## 10. 遥测与完成门禁

全部对外动作使用统一遥测客户端，交付 span、失败事件、可聚合 `_total` 指标，并同步[遥测登记](<telemetry.md>)与包声明。失败包含 error.type/error.code，边界传播 traceparent。关闭来源任一生效即关闭，热切换不影响业务，不构造 SDK/exporter、不注册端点、不生成和传播 traceparent。遥测故障仅内部计数，禁止改变业务执行结果。

| 验收 | 必须同时满足 |
|---|---|
| AC-SYS01 | 真实数据迁移、校验和、版本拒绝、各阶段进程中断恢复，源数据不损坏 |
| AC-SYS02 | 超过内存上限的离线日志重启补齐；乱序/冲突拒绝；事务后通知；统计不重复 |
| AC-SYS03 | 销毁独立测试源后仅凭备份隔离恢复并继续会话；损坏与密钥缺失明确失败 |
| AC-SYS04 | 真实 Postgres 种子与恢复、跨进程唯一写者、flush 耐久、失租旧写入拒绝 |
| AC-SYS05 | Hermes→DSH→Hermes 两轮均保留历史；运行结束前审批可决定；取消真正停止同一运行 |
| AC-SYS06 | 合法提供方组合按声明热变更或等待重启，活动操作保持原绑定，生命周期唯一，不确定请求禁止重放，外部进程不被托管关闭 |
| AC-SYS07 | TLS/mTLS、Origin、配对撤销、独立装卸、默认轻量组合和真实发行全部验证 |
| AC-SYS08 | 本节固定预算与性能门槛、慢消费、超限、资源回收和用户实例隔离全部通过 |

完整命令、领域文件范围、依赖与证据结构使用[实施工作包](<implementation-work-packages.md>)第九节。真实平台缺失时记录具体未执行编号；禁止使用设计画板或替代服务宣称业务完成。

## 11. 文档职责映射

| 文档章节 | 使用本文件的契约 |
|---|---|
| [目标形态](<target-shape.md>)第四、十一、十二节 | 完整历史、运行期分派、未完成能力门禁 |
| [部署](<deployment.md>)第一、三、五节 | 可选外部 Hermes、安全绑定、迁移和恢复 |
| [执行体与记忆接入](hermes-integration.md) | 历史权威、实时审批取消与插件能力归属 |
| [移动协议](<mobile-protocol.md>)第一、四节 | 浏览器认证、短期 ticket、只保留离线草稿 |
| [客户端模块](<client-modules.md>)移动与命令行章节 | PWA 同源外壳、单 iframe、CLI 本机范围 |
| [桌面移动载体](<desktop-mobile.md>)配对、离线与电源章节 | 统一配对、草稿、设备本地电源与窗口安全 |
| [总体架构](<architecture.md>)组合、会话与认证章节 | 可选包装卸、写者边界、无账号表访问保护 |

上述文档中的已核验源码事实继续有效，目标细节使用本文件；实现状态只在实际证据完成后更新。
