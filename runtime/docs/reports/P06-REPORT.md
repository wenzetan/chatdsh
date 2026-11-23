# P06 全链路验收与部署文档报告

## 主工作树基线

基线日志为 `runtime/.run/main-all-verify.log`，生成时间 2026-11-23 14:07。结果为 TSC、BUILD、CT、CP、CU、CL、TEST、VDL、VRT、VAN、VIM、VRS、VMC、VMT、VPI 全部退出码 0，只有 VSS 退出码 1。

原始失败片段：

```text
$ node scripts/verify-settings-sync.mjs
端口：控制平面 20180、设备 A 20181、设备 B 20182
通过：控制平面已监听 → 200
通过：控制平面接受白名单命名空间的写入 → 200
通过：白名单之外的命名空间被拒绝 → 400 {"error":"namespace-not-whitelisted"}
配对 device-a：deviceId=...
失败：device-a 运行时已启动 → 运行时已退出（1）
Error: dsh: profile "chatdsh-web" does not exist; create it with 'dsh plugin --profile chatdsh-web add <package>'
VSS=1
```

修复后 `verify:settings-sync` 退出码 0，基线中的其余命令仍为 0。本轮新增的 `verify:mobile-telemetry` 真实 OTLP 导出断言、`traceparent` 贯通脚本、浏览器冒烟与设备 B 真实导入分叉也全部退出码 0。

## 一、改动文件与作用

### 代码

| 文件 | 作用 |
|---|---|
| `runtime/packages/client/remote/src/client/model.ts` | `dataOf` 同时接受完整信封与裸数据；真实设备上报的 `payload: event.data` 不再得到空字段 |
| `runtime/gateway/src/sessions.ts` | 客户端会话分页 SQL 用 `COALESCE` 同时读取 `$.data.title` 与 `$.title` |
| `runtime/gateway/src/store.ts` | 会话摘要的 `titleOfPayload` 同时接受信封与裸数据，修复 `/chatdsh/gateway/sessions` 的标题回退到 cwd 末段的问题 |
| `runtime/packages/host/import/src/seed.ts` | 种子构造同时接受两种 payload 形状；裸数据用外层 `seq`／`kind`／`time` 还原信封；对话面事件补回 `surfaceOp: "append"` |
| `runtime/packages/host/import/src/fork.ts` | 字符统计与工具调用标识改用统一的 payload 解包函数 |
| `runtime/packages/host/device-link/src/v2-channel.ts` | 半关闭等待本地请求就绪后再执行，修复慢凭据下 POST 请求体被提前结束丢弃的竞态 |
| `runtime/packages/host/device-link/src/index.ts` | 把 `chatdshTelemetry` 加入服务依赖，设备侧转发 span 在真实运行时中生效 |
| `runtime/packages/host/push/src/index.ts` | 把 `chatdshTelemetry` 加入服务依赖，副本上报 span 在真实运行时中生效 |

### 验收脚本

| 文件 | 作用 |
|---|---|
| `runtime/scripts/lib/remote-mux.mjs` | Remote mux 探测改为合法的 `job/list` 流式调用，返回请求原文与全部回帧 |
| `runtime/scripts/verify-device-link.mjs` | 断言真实 `item` 帧里的 `{type:"rows",jobs:[...]}` |
| `runtime/scripts/verify-routing.mjs` | 同上，两台设备分别完成真实 Remote 调用 |
| `runtime/scripts/verify-settings-sync.mjs` | 改用 `installRuntimeProfile` 与官方 `--profile web`；新增设备侧非白名单拒绝、冲突与字段合并断言 |
| `runtime/scripts/verify-mobile-telemetry.mjs` | 移除悬空 profile 链接与失效的运行时托管变量；加入真实 OTLP 接收端并断言中转 span 已导出 |

### 测试

| 文件 | 新增覆盖 |
|---|---|
| `runtime/e2e/unit/client-remote-replica.test.mjs` | 保留信封 fixture，新增裸数据形状的只读视图与完整回合判断 |
| `runtime/e2e/unit/client-complete-wp03-pagination.test.mjs` | 新增裸 `{title}` payload 的标题查询用例 |
| `runtime/e2e/unit/service-contracts.test.mjs` | 新增裸数据标题的会话聚合用例 |
| `runtime/e2e/unit/import-seed.test.mjs` | 新增裸数据种子、`surfaceOp` 补回与日志事件不携带标记的用例 |
| `runtime/e2e/unit/device-link-v2.test.mjs` | 新增慢凭据下 POST 请求体完整转发的回归用例 |

### 文档

| 文件 | 作用 |
|---|---|
| `runtime/docs/deployment.md` | 新建：单机与家庭服务器部署、环境变量全清单、配对、PWA 与设备前缀、VAPID、反向代理与 TLS、遥测开关、数据备份、DSH 升级 |
| `README.md` | 增加部署文档入口、本机实测运行步骤、环境变量摘要与验收命令 |
| `runtime/README.md` | 增加真实构建命令、启动与配对示例、环境变量表、验收命令一览、部署文档入口 |
| `runtime/docs/README.md` | 把 `deployment.md` 登记进权威文档表与阅读顺序 |

## 二、任务零：验收脚本指向已删除 profile

### 失败根因

`runtime/scripts/verify-settings-sync.mjs` 在 `homes[index]/profiles/chatdsh-web` 建立符号链接，目标指向已经删除的 `runtime/profiles/chatdsh-web`，随后以 `dsh --profile chatdsh-web` 启动设备运行时。符号链接是悬空的，官方 `dsh` 报告 profile 不存在并以退出码 1 结束。

### 修复前后

| 项目 | 修复前 | 修复后 |
|---|---|---|
| profile 来源 | 悬空符号链接指向已删除目录 | `installRuntimeProfile(home)` 内部执行真实的 `dsh plugin --profile web add @chatdsh/bundle` |
| 启动参数 | `--profile chatdsh-web` | `--profile web` |
| 断言数量 | 控制平面接收、控制平面拒绝、设备 A 上报、设备 B 应用 | 保留上述断言，新增设备侧非白名单拒绝、任何设备 home 层不出现该写入、过期版本冲突、同命名空间双字段合并 |
| 退出码 | 1 | 0 |

修复后的三条语义断言与补充断言原文：

```text
通过：断言三：设备 A 的设置变更上报到控制平面 → {"namespace":"agent-default-model","key":"model","value":"\"chatdsh-sync-1795416493996\"","updatedAt":1795416494756}
通过：断言四：设备 B 的 home 层补丁文件写入了同一设置 → - id: client-locale ⏎   name: '@deepseek-ai/dsh-client-locale' ⏎   config: ⏎     language: zh-CN ⏎ - id: agent-default-model ⏎   name: '@deepseek-ai/dsh-agent-default-model' ⏎   config: ⏎     model: chatdsh-sync-1795416493996
通过：断言五：设备侧拒绝白名单之外的命名空间 → 400 {"outcome":"rejected","code":"permission-denied","reason":"namespace-device-scope"}
通过：断言五：白名单之外的设置没有进入任何设备的 home 层 → A=false B=false
通过：断言六：过期版本写入返回冲突并给出当前值 → 409 {"outcome":"conflict","conflict":{"section":"models","scope":"client","changedAt":1795416494756,"currentRevision":1,"fields":[{"field":"model","sensitive":false,"userValue":"stale-model","serverValue":"chatdsh-sync-1795416493996"}]},"revision":1,"values":{"provider":"deepseek-official","model":"chatdsh-sync-1795416493996"}}
通过：断言六：控制平面接受同一命名空间的第二个字段 → 200
通过：断言六：同一命名空间的两个字段按接收时刻合并到设备 B → - id: agent-default-model ⏎   name: '@deepseek-ai/dsh-agent-default-model' ⏎   config: ⏎     model: chatdsh-sync-1795416493996 ⏎     provider: provider-1795416495298
设置白名单同步验收通过
```

### 移动端遥测脚本

`verify-mobile-telemetry.mjs` 原先在 `HOME/harness/profiles/chatdsh-web` 建立同样的悬空链接，并传入 `CHATDSH_RUNTIME_*`。当前中继主进程没有托管运行时的代码路径，这些变量与链接都是失效配置。移除后脚本仍以真实中继进程、真实 SQLite 和真实配对流程运行。

该脚本原先只在注释里提到 OTLP 接收端，实际没有接收端。本轮加入真实 HTTP 接收端，并断言 `chatdsh.gateway.mobile.telemetry` span 被导出：

```text
合法批次被接收，计数 {"event":1,"span":1,"metric":1}
中转 span 已导出：{"traceId":"b22bca3138822574610f71d7e9a79960","spanId":"3c071369119d6988","name":"chatdsh.gateway.mobile.telemetry"}
手机遥测上报验收通过
```

## 三、任务一：副本 payload 形状缺陷

真实设备上报路径 `runtime/packages/host/push/src/continuity.ts` 写入 `payload: event.data`，payload 是事件数据本身。处理方式如下。

| 位置 | 最终处理 |
|---|---|
| `client/remote/src/client/model.ts` 的 `dataOf` | payload 为对象且 `type` 为字符串并且自身有 `data` 属性时按信封解包，否则把 payload 当数据本身 |
| `gateway/src/sessions.ts` 的分页 SQL | 用 `CASE` 与 `COALESCE` 先取 `$.data.title`，再取 `$.title`，两者都要求 JSON 类型为 text 且非空；排序仍取最新 `session/title` |
| `gateway/src/store.ts` 的 `titleOfPayload` | payload 内 `data` 为对象时取其 `title`，否则取 payload 自身的 `title` |
| `gateway/src/pwa-view.ts` | 该文件已经直接读取 `event.payload`，不存在信封假设，本轮未改动 |
| `host/import/src/seed.ts` | 裸数据用外层 `seq`／`kind`／`time` 还原信封；信封数据核对内外序号；可进入对话面的五类事件补回 `surfaceOp: "append"` |
| `host/import/src/fork.ts` | 字符统计与工具调用标识通过 `replicaDataOf` 解包，两种形状一致处理 |

新增用例：

```text
✔ 副本事件按类型转成只读视图
✔ 裸数据形状的副本事件按类型转成只读视图
✔ 裸数据形状也能找出最后一个完整回合
✔ 标题、路径末段、删除状态与业务未读在数据库查询中保持准确
✔ 中继存储读写真实 SQLite 并聚合会话列表
✔ 裸数据被还原成种子
✔ 对话面事件补回 append 标记，日志事件不携带该标记
```

真实设备 B 的导入分叉结果：

```text
通过：设备 A 上报裸数据副本 → 200 {"written":5,"watermark":4}
通过：设备 A 离线后 PWA 读取完整副本 → 200 {"sessionId":"a417f72d-8991-4684-9658-db6416a7e60b","watermark":4,"events":[{"seq":0,"kind":"session/title","time":1795416568104,"payload":{"title":"跨设备副本标题"}},{"seq":2,"kind":"user/message","payload":{"id":"p06-user-1","role":"user","content":[{"type":"text","text":"请检查这个仓库"}],"source":{"kind":"user"}}}]}
通过：控制平面会话列表读取裸数据标题 → {"sessionId":"a417f72d-8991-4684-9658-db6416a7e60b","title":"跨设备副本标题"}
通过：设备 B 的真实 chatdshImport/fork 建立带 parentSession 的会话 → 200 {"result":{"ok":true,"value":{"sessionId":"4743fa8a-f346-4b20-a644-d471483418b4","cwd":"/workspace/chatdsh/runtime","parentSession":"a417f72d-8991-4684-9658-db6416a7e60b","estimate":{"eventCount":5,...,"replay":{"toolCalls":0,...}}}}
通过：设备 B 的会话列表出现分叉会话与父会话 → 200 {"items":[{"sessionId":"4743fa8a-f346-4b20-a644-d471483418b4","parentSessionId":"a417f72d-8991-4684-9658-db6416a7e60b",...}]}
副本离线浏览与本机继续验收通过
```

## 四、任务二：Remote mux 真实成功调用

### 协议核对

`runtime/.dsh-deps/@deepseek-ai/dsh-api-gateway/src/stream-protocol.ts` 定义客户端帧为 `open`／`item`／`end`／`cancel`，服务端帧为 `item`／`error`／`end`。服务端不存在 `type: "result"`。一元方法通过 HTTP `POST /api/<endpoint>` 的 `client-request`／`server-response` 信封调用；`/api/remote.mux` 只承载流式方法。`settings/describe` 是一元方法，经 mux 打开时返回 `gateway/signature-invalid`。

本轮改用官方流式方法 `job/list`。请求参数按生成描述符的线名 `request` 包装：

```json
{"type":"open","streamId":"chatdsh-probe","endpoint":"job/list","payload":{"args":{"request":{"sessionId":"chatdsh-probe"}}}}
```

设备侧成功回帧：

```json
{"type":"item","streamId":"chatdsh-probe","value":{"type":"rows","jobs":[]}}
```

断言检查 `terminal.type === "item"`、`value.type === "rows"` 且 `value.jobs` 是数组。`job/list` 是持续流，没有自然结束帧，探测在收到首个 `item` 后关闭套接字。

两个脚本的最终断言原文：

```text
通过：device-a 的 Remote mux 双向收发 → {"request":{"type":"open","streamId":"chatdsh-probe","endpoint":"job/list","payload":{"args":{"request":{"sessionId":"chatdsh-probe"}}}},"frames":[{"type":"item","streamId":"chatdsh-probe","value":{"type":"rows","jobs":[]}}]}
通过：device-b 的 Remote mux 双向收发 → {"request":{"type":"open","streamId":"chatdsh-probe","endpoint":"job/list","payload":{"args":{"request":{"sessionId":"chatdsh-probe"}}}},"frames":[{"type":"item","streamId":"chatdsh-probe","value":{"type":"rows","jobs":[]}}]}
```

## 五、六场景验收

### 场景一：真实官方 profile 安装

命令：`pnpm --config.verify-deps-before-run=false verify:plugin-install`

退出码：0

```text
官方 web profile 真实插件安装验收通过。
dump-config：8 个组合包条目全部出现，且没有改动上游条目
遥测开启：status.enabled=true；遥测关闭：status.enabled=false、reason=env、browser 上报 404
客户端模块：@chatdsh/client-telemetry、@chatdsh/client-pwa、@chatdsh/client-remote 的产物均返回 200
```

### 场景二：双设备配对与远程转发

命令：`pnpm --config.verify-deps-before-run=false verify:device-link`

退出码：0

```text
通过：两台设备的在线状态都是 true
通过：device-a 的 Remote mux 双向收发 → ... "value":{"type":"rows","jobs":[]}
通过：device-b 的 Remote mux 双向收发 → ... "value":{"type":"rows","jobs":[]}
通过：非白名单 WebSocket 路径回 403 → 403 {"error":"path-invalid"}
通过：设备被终止后浏览器隧道关闭 → 已关闭
通过：设备 A 的探测返回 409 → 409 {"error":"device-offline"}
通过：设备 A 离线时 WebSocket 升级返回 409 → 409 {"error":"device-offline"}
通过：设备 B 仍然可以自检 → {"deviceId":"...","online":true,"status":200}
设备长连接验收通过
```

命令：`pnpm --config.verify-deps-before-run=false verify:routing`

退出码：0

```text
通过：经 /d/A/ 落到设备 A → 200 {"ok":true,"service":"chatdsh-device-link"}
通过：经 /d/B/ 落到设备 B → 200 {"ok":true,"service":"chatdsh-device-link"}
通过：未知设备不回退到默认运行时 → 404 {"error":"device-not-found"}
通过：没有 /d/ 前缀的请求不被转发到任何设备 → 404
通过：非白名单 WebSocket 路径回 403 → 403 {"error":"path-invalid"}
通过：设备离线时 /d/A/ 返回 409 → 409
通过：设备离线时 WebSocket 升级返回 409 → 409 {"error":"device-offline"}
通过：设备 B 不受影响 → 200
按设备分派验收通过
```

### 场景三：副本上报、离线浏览与本机继续

命令：`pnpm --config.verify-deps-before-run=false verify:import`

退出码：0

```text
导入结果：200 {"sessionId":"0730890d-b61c-4b1f-b436-6a92bc6ce90c","parentSession":"abcdef01-2345-6789-abcd-ef0123456789","watermark":2,"imported":3}
新会话副本序号：[0,1,2]，水位 2
归属记录：cwd=/work/b parent=abcdef01-2345-6789-abcd-ef0123456789
会话导入验收通过
```

命令：`pnpm --config.verify-deps-before-run=false verify:receipt-sync`

退出码：0

```text
上报已读：200
订阅 A 收到已读通知 1 条，订阅 B 收到 1 条
收到副本变更通知 3 条
已读同步验收通过
```

命令：`pnpm --config.verify-deps-before-run=false verify:multi-client`

退出码：0

```text
客户端 A 读到序号 [0,1,2]
客户端 B 读到序号 [0,1,2]
补齐后读到序号 [0,1,2,3,4]，水位 4
重复上报后台并：[0,1,2,3,4]
序号 4 的字节数：4
多客户端共存验收通过（覆盖副本一致性部分）
```

补充真实进程验收：`node .run/p06-fork-verify.mjs`

退出码：0

```text
通过：设备 A 上报裸数据副本 → 200 {"written":5,"watermark":4}
通过：设备 A 已离线 → 已离线
通过：设备 A 离线后 PWA 读取完整副本 → 200 ... "payload":{"role":"user","content":[{"type":"text","text":"请检查这个仓库"}]}
通过：控制平面会话列表读取裸数据标题 → {"title":"跨设备副本标题"}
通过：设备 B 的真实 chatdshImport/fork 建立带 parentSession 的会话 → 200 ...
通过：设备 B 的会话列表出现分叉会话与父会话 → 200 ...
副本离线浏览与本机继续验收通过
```

该脚本位于 `runtime/.run/`，不进入版本库。它启动真实中继、两台真实官方 `web` profile，设备 A 上报裸数据后离线，设备 B 通过真实 `chatdshImport/fork` 一元 Remote 调用建立带 `parentSession` 的会话。

### 场景四：白名单设置跨设备同步

命令：`pnpm --config.verify-deps-before-run=false verify:settings-sync`

退出码：0

关键输出见本文「任务零」一节的断言三至断言六。结论包括：白名单设置从设备 A 上报到控制平面并写入设备 B 的 home 层；设备侧拒绝白名单之外的命名空间，两个设备的 home 层都没有该写入；过期版本写入返回 409；同一命名空间的 `model` 与 `provider` 两个字段按接收时刻合并到同一条补丁行。

### 场景五：审批提醒与自动撤回

命令：`pnpm --config.verify-deps-before-run=false verify:approval-notify`

退出码：0

```text
通过：断言一：approval/asked 进副本后在线设备收到审批提醒 → {"kind":"approval","summary":"审批：bash：等待审批：bash","objectId":"call-...","revocable":true}
通过：断言二：approval/decided 撤回尚未投递的提醒，重连后不再补发 → 重连后收到 0 条审批提醒，撤回的那条没有补发
审批提醒与撤回验收通过
```

### 场景六：遥测双态

命令：`pnpm --config.verify-deps-before-run=false verify:mobile-telemetry`

退出码：0

```text
配对签发了设备令牌
合法批次被接收，计数 {"event":1,"span":1,"metric":1}
中转 span 已导出：{"traceId":"b22bca3138822574610f71d7e9a79960","spanId":"3c071369119d6988","name":"chatdsh.gateway.mobile.telemetry"}
未登记属性被丢弃并计数
邮箱 被拒绝，原因 email
内网地址 被拒绝，原因 internal-address
未登记名称 被拒绝，原因 invalid-name
无效令牌被拒绝
手机遥测上报验收通过
```

命令：`node scripts/telemetry-probe.mjs`

退出码：0

```text
通过 logs probe_id=355bbfaf4847198b
通过 traces probe_id=355bbfaf4847198b
通过 metrics probe_id=355bbfaf4847198b
```

补充跨中继与设备链路验收：`node .run/p06-traceparent.mjs`

退出码：0

```text
通过：带 traceparent 的设备转发请求成功 → 200
通过：同一 trace id 贯通中继与设备侧转发 span → {"traceId":"c67693af21bdbf7ef4c4993d95f36050","gateway":{"traceId":"c67693af21bdbf7ef4c4993d95f36050","spanId":"52a156aa76e10f65","name":"chatdsh.gateway.device.proxy"},"runtime":{"traceId":"c67693af21bdbf7ef4c4993d95f36050","spanId":"ebc5471516fcc2fa","name":"chatdsh.runtime.device.forward"}}
通过：关闭遥测的中继已监听 → 200
通过：关闭遥测时浏览器上报端点返回 404 → 404
通过：关闭遥测时没有产生新的 OTLP 导出 → 17 → 17
遥测双态与 traceparent 贯通验收通过
```

该脚本使用真实 OTLP 接收端与两台真实官方 `web` profile，关闭态验证了上报端点 404 与零新增导出。

## 六、浏览器冒烟

脚本：`runtime/.run/p06-browser-smoke.mjs`（不进入版本库）

命令：`node .run/p06-browser-smoke.mjs`

退出码：0

```text
通过：侧栏入口存在
通过：远程设备主面板渲染 → {"present":true,"text":"Remote devices and sessions\nRelay not connected\nRefresh\n\nReason: This page has no relay endpoints\n\nDevices\n\nNo paired devices\n\nSessions\n\nNo synced sessions","remoteNodes":14}
通过：设置区段渲染 → {"present":true,"text":"Remote device settings\nRelay connection\nRelay not connected\nLocal device identity\nNot paired\nTelemetry\nReading\nRelay address\nLeave empty to use the current document origin\nSave address\nRead again\nOne-time pairing code\nPair"}
原始结论：{"sidebarReady":true,"panelReady":true,"settingsReady":true,"exceptions":[],"consoleErrors":[]}
```

官方界面语言为英文，侧栏入口的无障碍标签为 `Remote devices`，设置区段标题为 `Remote device settings`。页面由真实官方 `web` profile 提供，`@chatdsh/client-remote` 的侧栏入口、主面板与设置区段都真实挂载。未捕获异常 0 条，控制台错误 0 条。Desktop 渲染进程未在本机单独启动，复用的是同一份 `platform: "web"` 客户端产物。

## 七、部署与运行文档

新建 `runtime/docs/deployment.md`，内容覆盖：

- Node.js 22 及以上、pnpm 11.21.0、DSH 基线 `0.2.2-rc.3` 与构建顺序。
- 中继启动、健康检查、配对码、设备配对与手机配对。
- `/` PWA、`/d/<deviceId>/`、`/api/remote.mux`、SSE 与 VAPID 路由。
- 中继、设备宿主、遥测与副本连续性进程的全部 `CHATDSH_*` 变量、默认值与缺省行为。
- VAPID 自动生成与自带密钥的格式。
- Nginx 反向代理、TLS、WebSocket 升级、SSE 缓冲、请求体上限与公共 origin。
- 遥测开关、关闭后的行为与 OpenObserve 探针。
- 数据目录、备份与恢复步骤。
- `upgrade-dsh.mjs` 升级流程与升级后的 profile 复核。
- 常见状态码。

环境变量清单从 `gateway/src/store.ts`、`gateway/src/server.ts`、`gateway/src/notifications/records.ts`、`gateway/src/replica-continuity/server.ts`、`packages/core/diagnostics/src/config.ts`、`packages/host/*/src` 与 `packages/client/*/src` 逐项核对。文档中的默认值与缺省行为按实现填写。

根 `README.md` 增加部署入口、本机实测构建命令、启动与配对示例、常用环境变量与完整验收命令。`runtime/README.md` 增加真实构建与校验命令、启动与配对示例、环境变量表、验收命令一览与部署文档入口。`runtime/docs/README.md` 把 `deployment.md` 加入权威文档表与阅读顺序第 5 项。

## 八、验收命令总表

| 命令 | 退出码 | 结论 |
|---|---:|---|
| `node_modules/.bin/tsc -b tsconfig.build.json --force` | 0 | 无诊断输出 |
| `pnpm --config.verify-deps-before-run=false build:client` | 0 | 打包 3 个客户端包 |
| `pnpm --config.verify-deps-before-run=false check:telemetry` | 0 | 核对 40 个 span、27 个 event，检查 13 个包 |
| `pnpm --config.verify-deps-before-run=false check:plugins` | 0 | 插件 8 个、客户端插件 3 个、组合包 1 个 |
| `node scripts/check-upstream-names.mjs` | 0 | 适配层登记 13 个上游包名 |
| `pnpm --config.verify-deps-before-run=false check:layering` | 0 | 分层依赖方向核对通过 |
| `pnpm --config.verify-deps-before-run=false test` | 0 | 191 项，190 通过，1 跳过，0 失败 |
| `pnpm --config.verify-deps-before-run=false verify:device-link` | 0 | 两台设备、Remote mux、403、409 全部通过 |
| `pnpm --config.verify-deps-before-run=false verify:routing` | 0 | `/d/A/`、`/d/B/`、404、403、409 全部通过 |
| `pnpm --config.verify-deps-before-run=false verify:settings-sync` | 0 | 白名单传播、非白名单拒绝与不传播、冲突与字段合并全部通过 |
| `pnpm --config.verify-deps-before-run=false verify:approval-notify` | 0 | 审批提醒与撤回全部通过 |
| `pnpm --config.verify-deps-before-run=false verify:import` | 0 | 控制平面复制副本并建立 `parentSession` |
| `pnpm --config.verify-deps-before-run=false verify:receipt-sync` | 0 | 两个订阅都收到已读与副本变更通知 |
| `pnpm --config.verify-deps-before-run=false verify:multi-client` | 0 | 两端序列一致、补齐与重复上报行为正确 |
| `pnpm --config.verify-deps-before-run=false verify:mobile-telemetry` | 0 | 配对、批次计数、丢弃、拒绝与真实 OTLP 导出全部通过 |
| `pnpm --config.verify-deps-before-run=false verify:plugin-install` | 0 | 8 个组合包条目、三个客户端产物 200、遥测双态通过 |
| `node scripts/telemetry-probe.mjs` | 0 | logs、traces、metrics 三类信号写入并查询回来 |
| `node .run/p06-fork-verify.mjs` | 0 | 裸数据副本、设备 A 离线读取、设备 B 真实导入分叉通过 |
| `node .run/p06-traceparent.mjs` | 0 | 中继与设备侧同一 trace id 贯通，关闭态 404 与零导出通过 |
| `node .run/p06-browser-smoke.mjs` | 0 | 侧栏入口、主面板、设置区段渲染，异常与错误为 0 |

完整单元测试的跳过项是已有的 TOTP 完整校验，原因是本机缺少 `otplib`。

## 九、遗留风险

| 风险 | 说明 |
|---|---|
| Remote mux 只承载流式方法 | 一元方法通过 HTTP `/api/<endpoint>` 调用；mux 对一元方法返回 `gateway/signature-invalid`。验收脚本使用官方流式方法 `job/list`，没有使用 `type: "result"`，因为协议中没有该帧类型 |
| `job/list` 探测为空集合 | 探测使用不存在的会话标识，`registry.list` 返回空数组。断言覆盖调用成功、帧结构与字段类型，不覆盖非空作业行 |
| 副本写入路径 | 场景三的补充脚本通过 `/chatdsh/gateway/replica` 直接写入并携带设备 A 标识，覆盖中继接收、存储、离线读取与设备 B 导入；没有从设备 A 的真实会话事件监听器触发宿主 push。宿主 push 的监听、补传意图与重试由现有单元测试覆盖 |
| 压缩事件的替换标记 | 设备上报只发送 `event.data`，信封层的 `surfaceOp` 与 `sourceEventSeqs` 不会进入副本。种子构造为普通消息补回 `append`；如果原事件是 `replace` 压缩操作，重建时会按 `append` 处理。正常消息与工具结果不受影响 |
| 设备长连接与会话上报的遥测服务依赖 | 两个插件把 `chatdshTelemetry` 加入服务依赖，组合包总是安装 `@chatdsh/host-telemetry`。只单独安装 `@chatdsh/host-device-link` 或 `@chatdsh/host-push` 而不安装遥测插件时，插件不会激活；遥测关闭时服务仍存在，功能不受影响 |
| `verify:mobile-telemetry` 不启动设备运行时 | 该脚本验证中继的移动端遥测接入与导出，不涉及设备侧插件。移除的 `CHATDSH_RUNTIME_*` 与悬空链接在当前中继主进程中没有执行路径；真实官方 profile 由 `verify:plugin-install`、`verify:device-link`、`verify:settings-sync` 与浏览器冒烟覆盖 |
| Desktop 渲染进程 | 浏览器冒烟使用官方 Web 端。Desktop 使用同一份 `platform: "web"` 客户端产物，本轮未单独启动 Desktop 窗口 |
| 跨来源 `controlUrl` | 中继没有 CORS 响应头，跨来源读取需要同源反向代理。部署文档给出的反向代理方案覆盖这一场景 |
| TOTP 完整校验 | 本机缺少 `otplib`，该测试保持跳过，与基线一致 |
| 测试数据目录 | `runtime/.run/` 下的临时 DSH_HOME 与验收脚本数据在进程退出后保留到下一次清理；它们不进入版本库 |
