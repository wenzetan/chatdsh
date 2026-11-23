# P04 中继 PWA 入口与审批通知联动报告

## 一、交付文件与作用

| 文件 | 作用 |
|---|---|
| `runtime/gateway/src/pwa-page.ts` | 生成根路径 `/` 的单文件 PWA 页面。内联 HTML、深色样式、移动端布局与页面脚本；导出清单、Service Worker、离线页与图标路径常量；把视图、草稿与遥测纯函数序列化进页面脚本。 |
| `runtime/gateway/src/pwa-view.ts` | 副本事件到结构化时间线的视图模型；未知 kind 折叠；工具输出与消息正文截断；审批角标状态 reducer；按会话统计待审批条数。 |
| `runtime/gateway/src/pwa-drafts.ts` | IndexedDB 离线草稿。按会话标识生成键；记录校验；修订号递增；数据库版本升级计划；旧仓库迁移；真实内存实现 `MemoryDraftStore`。 |
| `runtime/gateway/src/pwa-telemetry.ts` | 浏览器侧遥测载荷构造。使用 `chatdsh.client.boot`、`chatdsh.client.ui.action`、`chatdsh.client.error` 与 `chatdsh_client_errors_total`，经同源 `POST /chatdsh/telemetry/browser` 上报。 |
| `runtime/gateway/src/browser-telemetry.ts` | 中继服务端的浏览器遥测中转端点。校验同源来源与 `x-chatdsh-csrf`，读取有上限的请求体，转发到本机遥测管道，失败分支写事件与计数。 |
| `runtime/gateway/src/server.ts` | 根路径页面改为调用 `renderPwaIndexHtml`；新增浏览器遥测路由与手机配对路由；审批决定按请求标识从副本解析调用标识后撤回；通知宿主默认投递方式跟随部署推送模式。 |
| `runtime/gateway/src/main.ts` | 向服务端注入浏览器遥测转发能力。 |
| `runtime/gateway/src/notifications/routes.ts` | 新增 `GET /chatdsh/gateway/notifications/vapid`，只返回公钥与 subject。 |
| `runtime/gateway/src/notifications/index.ts` | 通知宿主接受默认投递方式，并传给通知存储。 |
| `runtime/gateway/src/notifications/records.ts` | 通知存储在无设置记录时使用宿主提供的默认设置。 |
| `runtime/packages/core/diagnostics/src/client.ts` | 新增 `TelemetryClient.relay`，复用环境变量覆盖项与 OpenObserve Basic 认证转发 OTLP/HTTP JSON。 |
| `runtime/packages/host/telemetry/src/controller.ts` | 控制器中继方法委托给 `TelemetryClient.relay`，保持宿主端点行为一致。 |
| `runtime/packages/client/pwa/src/client/service-worker.ts` | 生成的 Service Worker 增加 `push` 与 `notificationclick` 处理：展示系统通知，点击打开对应设备页面。 |
| `runtime/docs/telemetry.md` | 登记浏览器遥测 span、拒绝事件与批次计数指标；补齐手机配对 span 的失败属性。 |
| `runtime/gateway/package.json` | 声明新增的浏览器遥测信号。 |
| `runtime/e2e/unit/gateway-p04-pwa.test.mjs` | 18 个单元测试：副本视图各分支、未知 kind、空列表、超长输出截断、审批角标 reducer、草稿键与版本迁移、内存存储、页面内联产物、浏览器遥测载荷与同源判定、Service Worker 推送。 |
| `runtime/scripts/verify-approval-notify.mjs` | 按真实通知批次事件形状断言审批提醒与撤回；失败详情打印收到的事件种类。 |
| `runtime/scripts/verify-mobile-telemetry.mjs` | 为网关子进程补 `DSH_HOME`，与其它验收脚本保持一致的隔离数据根。 |
| `runtime/scripts/verify-settings-sync.mjs` | 沿用工作树中已有的 `findFreePort` 引用与 `DSH_HOME` 修正。 |

## 二、副本事件真实 payload 字段与出处

设备侧副本上报在 `runtime/packages/host/push/src/continuity.ts` 的 `sendBatch` 中把每条会话事件映射为：

```text
{ seq, kind: event.type, time: event.time, payload: event.data }
```

中继接收形状是 `runtime/gateway/src/replica-continuity/store.ts` 的 `ReplicaEventInput`：

```text
{ seq: number, kind: string, time: number, payload: unknown }
```

因此 `payload` 就是上游 `SessionEvent.data`，没有额外的 `data` 包裹。页面视图按这一事实读取字段。

| kind | 真实 payload 字段 | 视图读取 | 上游出处 |
|---|---|---|---|
| `user/message` | `UserMessage`：`id`、`role: "user"`、`content: ContentBlock[]`、`source: MessageSource` | `content` 中的文本块；`source.kind` | `@deepseek-ai/dsh-session/src/types.ts` 的 `SessionEventMap["user/message"]`；`@deepseek-ai/dsh-llm/src/message.ts` 的 `UserMessage` 与 `MessageBase` |
| `assistant/message` | `turn`、`step`、`message: AssistantMessage`、`stream: AssistantStreamRecord[]`、`usage?: TokenUsage`、`interrupted?: true` | `message.content` 文本块；`message.source.provider` 与 `message.source.model`；`usage.inputTokens` 与 `usage.outputTokens`；`interrupted` | 同上 `types.ts`；`dsh-llm/src/message.ts` 的 `AssistantMessage`、`ModelMessageSource`；`dsh-llm/src/types.ts` 的 `TokenUsage` |
| `tool/call` | `turn`、`step`、`callId`、`name`、`arguments` | `name`、`callId`、`arguments`、`turn`、`step` | `dsh-session/src/types.ts` 的 `SessionEventMap["tool/call"]` |
| `tool/result` | `turn`、`step`、`message: ToolResultMessage`、`error?: { name, code, reason? }`、`meta?` | `message.content` 文本块；`message.toolCallId` 或 `message.source.callId`；`message.isError`；`error` | `dsh-session/src/types.ts` 的 `SessionEventMap["tool/result"]`；`dsh-llm/src/message.ts` 的 `ToolResultMessage` 与 `ToolMessageSource` |
| `approval/asked` | `id`、`toolName`、`callId?`、`reason?` | `id`、`toolName`、`callId`、`reason` | `@deepseek-ai/dsh-user-approval/src/types.ts` 的模块扩展 `SessionEventMap["approval/asked"]` |
| `approval/decided` | `id`、`outcome` | `id`、`outcome`；`outcome` 取 `allowed-once`、`rejected`、`cancelled`、`unavailable` | 同上 `SessionEventMap["approval/decided"]` 与 `ApprovalOutcome` |

未知 kind 保留原始事件对象，时间线中折叠为一行可展开条目，展开内容是该事件的原始 JSON。原始 JSON 同时放在副本区域底部默认收起的「原始事件」区。

## 三、页面结构与离线副本

页面仍由服务端生成单文件 HTML，不引入打包器与新依赖。样式、页面脚本与纯函数都在同一个响应体内。页面包含六个区域：

| 区域 | 内容 |
|---|---|
| 页头 | 产品名、中继版本、SSE 连接状态、审批待处理角标 |
| 已连接设备 | 设备名称、平台、在线点、`/d/<deviceId>/` 入口 |
| 会话与离线只读副本 | 按设备分组的会话、在线或离线标记、待审批条数、查看副本按钮 |
| 待审批 | 待审批会话、工具名、在线设备跳转入口 |
| 只读副本 | 副本状态、结构化时间线、原始事件折叠区、离线草稿输入区 |
| 审批提醒推送 | 推送订阅状态、开启与关闭按钮 |

副本区域顶部按设备在线状态显示「设备在线 · 只读副本」或「设备离线 · 只读副本」。时间线按序号渲染：

| kind | 展示 |
|---|---|
| `user/message` | 标题「你」，正文取文本内容，元信息显示来源与附件提示 |
| `assistant/message` | 标题「助手」，正文取文本内容，元信息显示提供方、模型、用量与中断状态 |
| `tool/call` | 标题「工具调用 · 工具名」，正文显示原始参数文本，元信息显示调用标识、回合与步骤 |
| `tool/result` | 标题「工具结果」或「工具结果 · 失败」，正文显示结果文本与错误身份、错误码、原因 |
| `approval/asked` | 标题「审批请求 · 工具名」，正文显示原因；存在对应决定时状态改为已决定并显示结果 |
| `approval/decided` | 标题「审批结果 · 结果」，正文显示关联工具与调用标识 |
| 其它 kind | 折叠为一行，展开显示原始 JSON |

「在本机继续」按钮调用真实路由 `POST /chatdsh/gateway/import`：

```text
请求：{ sourceSessionId: string, deviceId?: string, cwd?: string }
响应：{ sessionId, parentSession, watermark, imported }
```

中继读取源会话副本，创建带 `parentSession` 的新会话记录并复制事件。页面在成功后刷新会话列表并提示新会话标识。真实浏览器验收中点击该按钮后，会话列表出现第二条会话。

## 四、IndexedDB 草稿状态机

草稿数据库名为 `chatdsh-pwa-drafts`，当前版本为 2。对象仓库为 `drafts`，主键路径是 `key`，并按 `sessionId` 建立唯一索引。旧版本仓库名为 `draft`。

| 版本迁移 | 步骤 |
|---|---|
| `oldVersion === 0` | 创建 `drafts` 仓库与 `bySession` 索引 |
| `oldVersion === 1` | 创建 `drafts` 仓库，逐条把 `draft` 仓库记录迁移到 `drafts`，删除旧仓库 |
| `oldVersion >= 2` | 不创建、不迁移、不删除 |

草稿键为 `session:<sessionId>`。会话标识必须是长度不超过 200 的非空字符串。草稿记录包含 `key`、`sessionId`、`text`、`revision`、`updatedAt`。文本上限为 262144 个字符。保存空白内容会删除记录；每次有效保存把修订号加一。

页面状态机：

| 状态 | 触发 | 界面 | 存储 |
|---|---|---|---|
| 无草稿 | 打开副本 | 输入区为空，发送按钮禁用 | 无记录 |
| 输入中 | 输入事件 | 250 毫秒防抖后保存 | 写入 IndexedDB |
| 离线已保存 | 设备离线或浏览器离线且有文本 | 显示「草稿已保存，恢复连接后由你手动发送」，发送按钮禁用 | 保留记录 |
| 在线可发送 | 设备在线、浏览器在线且有文本 | 发送按钮启用，状态显示可发送 | 保留记录 |
| 清空 | 文本变为空白 | 显示草稿已清空 | 删除记录 |

页面不写待发队列，不在网络恢复时自动发送，也不在页面重新加载时自动提交。在线点击「发送」时，页面把草稿复制到剪贴板并打开对应设备的 `/d/<deviceId>/` 页面，草稿记录继续保留在 IndexedDB。中继当前没有向设备会话注入消息的路由，这一行为在「遗留风险」中说明。

真实浏览器验收写入文本「离线草稿内容」，界面出现「草稿已保存，恢复连接后由你手动发送」，发送按钮为禁用状态，IndexedDB 的 `drafts` 仓库读回同一文本。

## 五、SSE 与审批角标状态机

页面订阅 `GET /chatdsh/gateway/events`。中继从 `chatdsh-device` Cookie 或 `x-chatdsh-node-id` 请求头取得设备标识，调用 `push.subscribe(device.id, platform, response, origin)` 登记连接，每 15 秒写一条 `: ping` 注释。连接是设备作用域的，浏览器刷新后由 Cookie 保持同一设备标识。

中继下发的事件形状：

| kind | 字段 |
|---|---|
| `notification` | `items: [{ id, kind, title, summary?, preview?, deviceId?, sessionId?, objectId?, tag?, createdAt, readAt?, handledAt?, revocable }]`、`count`、`stage`、`mode` |
| `notification-read` | `ids`、`clientId`、`deviceId?`、`readAt`、`unread` |
| `notification-handled` | `ids`、`handledAt` |
| `notification-withdraw` | `ids`、`tags`、`sessionId?`、`objectId?`、`at` |
| `replica` | `sessionId`、`watermark`、`appended` |

审批角标 reducer 的转移：

| 事件 | 动作 |
|---|---|
| `notification` 中 `item.kind === "approval"` | 以 `sessionId + objectId` 为键加入条目；记录通知标识、工具名与设备标识 |
| `notification-withdraw` | 按通知标识删除；同时按会话标识、调用标识与 `approval-<callId>` 标签删除 |
| `notification-read` | 按通知标识删除 |
| `notification-handled` | 按通知标识删除 |
| `approval` | 以 `sessionId + callId` 为键加入条目 |
| `approval/decided` | 按会话标识与调用标识删除 |
| 其它事件 | 返回原状态 |

页头角标显示全部待审批条数；会话行显示该会话的待审批条数；待审批区域按在线状态提供 `/d/<deviceId>/` 入口。真实浏览器验收中，上报 `approval/asked` 后角标变为 1，上报 `approval/decided` 后角标隐藏。

审批撤回链路在 `runtime/gateway/src/server.ts` 中处理。`approval/asked` 的 payload 带 `id`、`toolName` 与 `callId`；`approval/decided` 的 payload 只带 `id` 与 `outcome`。中继收到决定事件后按 `id` 扫描该会话副本中的 `approval/asked`，解析出 `callId`，再调用 `push.withdraw(sessionId, callId)`，同时撤回离线队列与通知记录。

## 六、Web Push 路由与鉴权

| 方法与路径 | 请求 | 响应 | 鉴权与校验 |
|---|---|---|---|
| `GET /chatdsh/gateway/notifications/subscription?deviceId=` | 设备标识 | `{ state, permission, updatedAt, code? }`；状态取 `subscribed`、`expired`、`gone`、`unsubscribed` | 设备标识来自 `x-chatdsh-node-id` 头或查询参数 |
| `POST /chatdsh/gateway/notifications/subscription` | `{ deviceId, clientId, endpoint, keys: { p256dh, auth }, permission }` | 订阅视图 | 设备标识与客户端标识来自请求头、查询参数或请求体；`p256dh` 必须是 65 字节未压缩 P-256 公钥，`auth` 必须是 16 字节 |
| `DELETE /chatdsh/gateway/notifications/subscription?deviceId=` | 设备标识 | `{ removed }` | 设备标识来自请求头或查询参数 |
| `GET /chatdsh/gateway/notifications/settings` | 无 | 通知设置 | 无访问会话要求 |
| `PUT /chatdsh/gateway/notifications/settings` | 设置字段与 `revision` | 更新后的设置 | 版本冲突返回 409 |
| `POST /chatdsh/gateway/notifications/read` | `{ ids, clientId, deviceId? }` | 已读结果 | 通知标识 1 到 500 个 |
| `POST /chatdsh/gateway/notifications/handled` | `{ ids }` | `{ marked, unchanged }` | 通知标识 1 到 500 个 |
| `GET /chatdsh/gateway/notifications/vapid` | 无 | `{ publicKey, subject }` | 只返回公钥与 subject，私钥不离开服务端 |

页面在 `#push-state` 显示订阅状态。权限被拒绝时显示「通知权限已被拒绝，请在浏览器设置中允许」；订阅失败时显示「订阅失败：错误码」；关闭订阅失败时显示「关闭订阅失败：错误码」。页面调用 `navigator.serviceWorker.ready` 取得注册，使用 VAPID 公钥调用 `pushManager.subscribe`，把 `endpoint`、`keys.p256dh`、`keys.auth` 与 `permission` 提交到订阅路由。

Service Worker 的 `push` 处理解析通知批次，逐条调用 `self.registration.showNotification`。`notificationclick` 读取通知数据中的 `deviceId`，打开 `/d/<deviceId>/`，没有设备标识时打开根路径。

真实路由验收使用 Node 生成的 P-256 密钥对与 16 字节认证密钥，`POST` 订阅后 `GET` 读到 `subscribed`，`DELETE` 返回 `removed: 1`；VAPID 公钥解码后为 65 字节。

## 七、移动端布局

页面沿用现有深色 CSS 变量：`--bg`、`--panel`、`--line`、`--ink`、`--muted`、`--brand`、`--ok`、`--warn`、`--error`。窄屏规则在 `max-width: 720px` 时生效：

| 元素 | 窄屏行为 |
|---|---|
| `main` | 单列网格，左右内边距 12 像素 |
| `header` | 左右内边距 12 像素，保持吸顶 |
| 副本头部 | 纵向排列，操作按钮等宽换行 |
| 会话行 | 纵向排列，按钮占满整行 |
| 事件头 | 标题与元信息纵向排列 |
| 草稿区 | 吸底，底部内边距叠加 `env(safe-area-inset-bottom)` |

安全区适配覆盖 `body`、`header`、`main`、草稿区与提示条。页面主区域底部预留 140 到 150 像素，草稿吸底条不会遮挡时间线内容。按钮最小高度 36 像素，输入框宽度 100%，长文本与工具输出使用 `overflow-wrap: anywhere` 与滚动容器。

## 八、遥测接入

新增信号已同时写入源码调用、`runtime/gateway/package.json` 的 `chatdsh.telemetry` 与 `runtime/docs/telemetry.md` 第六节：

| 信号 | 名称 | 属性 |
|---|---|---|
| span | `chatdsh.gateway.browser.telemetry` | `action`、`outcome`、`count`、`error.type`、`error.code` |
| event | `chatdsh.gateway.browser.telemetry.rejected` | `action`、`outcome`、`error.type`、`error.code` |
| metric | `chatdsh_gateway_browser_telemetry_batches_total` | `outcome`、`error.code` |

浏览器侧复用已登记信号：

| 信号 | 使用位置 |
|---|---|
| `chatdsh.client.boot` | 页面启动，`module.count` 取 6，`outcome` 取 `ok` 或 `failed` |
| `chatdsh.client.ui.action` | `replica-open`、`replica-refresh`、`draft-save`、`draft-send`、`import-continue`、`sse-open`、`push-subscribe`、`push-unsubscribe` |
| `chatdsh.client.error` | 页面未捕获异常、请求失败、订阅失败、Service Worker 注册失败 |
| `chatdsh_client_errors_total` | 与 `chatdsh.client.error` 同步递增 |

同源中转端点 `POST /chatdsh/telemetry/browser` 的行为：

| 条件 | 状态码 | 处理 |
|---|---|---|
| 遥测关闭 | 404 | 返回 `telemetry-disabled` 与关闭原因 |
| 方法不是 `POST` | 405 | 记录拒绝事件与计数 |
| 缺少 `x-chatdsh-csrf: 1` | 403 | 记录拒绝事件与计数 |
| `Origin` 与公共来源不同 | 403 | 记录拒绝事件与计数 |
| 请求体超过 256 KB | 413 | 记录拒绝事件与计数 |
| 请求体为空 | 400 | 记录拒绝事件与计数 |
| 上游转发失败 | 502 | 记录失败事件与计数 |
| 上游接受 | 200 | 记录接受计数 |

`TelemetryClient.relay` 从环境变量覆盖项读取端点、组织、用户名与口令，按 `logs`、`traces`、`metrics` 选择 OpenObserve 路径，日志与追踪请求带 `stream-name`。载荷只包含动作名、结果、模块数量、错误类型与错误码，不记录提示词、模型输出、工具参数、工具结果、会话正文、凭据与地址。

## 九、验收命令与原始结论

以下命令均在 `/workspace/chatdsh/.worktrees/p04/runtime` 下执行。

| 命令 | 原始结论 | 退出码 |
|---|---|---|
| `node_modules/.bin/tsc -b tsconfig.build.json --force` | 无输出 | 0 |
| `pnpm --config.verify-deps-before-run=false build:client` | `已打包 @chatdsh/client-pwa → lib/client.js`、`已打包 @chatdsh/client-telemetry → lib/client.js`、`客户端构建完成，处理 2 个包。` | 0 |
| `pnpm --config.verify-deps-before-run=false check:telemetry` | `属性一致性核对了 40 个 span、27 个 event 声明。`、`遥测声明校验通过，检查了 12 个包，其中 8 个声明了遥测面。` | 0 |
| `pnpm --config.verify-deps-before-run=false check:plugins` | `插件 8 个、客户端插件 2 个、组合包 1 个、profile 0 个、纯库 0 个`、`插件契约检查通过` | 0 |
| `pnpm --config.verify-deps-before-run=false check:layering` | `分层依赖方向核对通过` | 0 |
| `pnpm --config.verify-deps-before-run=false test` | `tests 167`、`pass 166`、`fail 0`、`skipped 1`、`duration_ms 75785.936162` | 0 |
| `pnpm --config.verify-deps-before-run=false verify:mobile-telemetry` | `配对签发了设备令牌`、合法批次计数 `{"event":1,"span":1,"metric":1}`、未登记属性丢弃、邮箱、内网地址、未登记名称与无效令牌均被拒绝、`手机遥测上报验收通过` | 0 |
| `pnpm --config.verify-deps-before-run=false verify:approval-notify` | `通过：断言一：approval/asked 进副本后在线设备收到审批提醒`、`通过：断言二：approval/decided 撤回尚未投递的提醒，重连后不再补发`、`审批提醒与撤回验收通过` | 0 |
| `pnpm --config.verify-deps-before-run=false verify:receipt-sync` | `订阅 A 收到已读通知 1 条，订阅 B 收到 1 条`、`收到副本变更通知 3 条`、`已读同步验收通过` | 0 |
| `pnpm --config.verify-deps-before-run=false verify:multi-client` | `客户端 A 读到序号 [0,1,2]`、`客户端 B 读到序号 [0,1,2]`、`补齐后读到序号 [0,1,2,3,4]，水位 4`、`多客户端共存验收通过（覆盖副本一致性部分）` | 0 |
| `pnpm --config.verify-deps-before-run=false verify:plugin-install` | `官方 web profile 真实插件安装验收通过。`、`dump-config：7 个组合包条目全部出现，且没有改动上游条目`、`遥测开启：status.enabled=true；遥测关闭：status.enabled=false、reason=env、browser 上报 404`、`客户端模块：@chatdsh/client-telemetry 与 @chatdsh/client-pwa 的产物均返回 200` | 0 |

额外的真实浏览器验收使用 Chrome DevTools 协议，脚本位于 `runtime/.run/p04-cdp.mjs`，不进入版本管理。验收内容与原始结论：

| 项目 | 原始结论 |
|---|---|
| 页面加载 | `页面渲染长度 58667，未捕获异常 0，控制台错误 0` |
| 设备与会话 | `暂无已配对设备`、`p04-browser-sessiondevice-offline · 离线副本查看副本` |
| 副本时间线 | 7 个事件；`设备离线 · 只读副本`；包含「请检查这个仓库」「工具调用 · shell」「工具结果」「审批请求 · shell」「审批结果 · 已允许一次」「其他事件（custom/unknown）」 |
| 原始事件区 | `rawOpen: false`，默认收起 |
| 离线草稿 | `草稿已保存，恢复连接后由你手动发送`；发送按钮禁用；IndexedDB 读回「离线草稿内容」 |
| 本机继续 | 点击后出现「已创建本机继续的会话」，会话行数从 1 变为 2 |
| 审批角标 | `approval/asked` 后角标为 1；`approval/decided` 后角标隐藏 |
| VAPID 与订阅 | 公钥解码为 65 字节；`POST` 订阅后状态 `subscribed`；`DELETE` 返回 `removed: 1` |

## 十、遗留风险

| 风险 | 说明 |
|---|---|
| 在线草稿发送 | 中继没有向设备 DSH 会话注入消息的路由。页面在在线状态点击「发送」时复制草稿到剪贴板并打开 `/d/<deviceId>/`，草稿继续保留在 IndexedDB，由用户在官方设备页面确认发送。页面不写待发队列，不自动重发。 |
| 会话标题 | 设备上报的 `session/title` payload 是 `{ title }`，中继副本摘要的既有读取逻辑按 `{ data: { title } }` 取值，真实运行时可能回退到工作目录末段作为标题。P04 页面按中继返回的标题显示。 |
| 推送送达 | Web Push 的最终展示受浏览器权限、推送服务与系统通知设置影响。页面如实展示订阅状态与失败原因，服务端记录订阅过期与发送失败。 |
| 浏览器验收工具 | `google-chrome --dump-dom` 在 SSE 长连接存在时不会结束；本次使用 Chrome DevTools 协议读取真实 DOM 与异常。 |
