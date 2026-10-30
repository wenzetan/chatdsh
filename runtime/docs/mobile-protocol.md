# 移动端接入协议

这份文档固定 Android 原生客户端与后续 iOS 客户端共用的网络协议。平台实现可以不同，请求形状、认证顺序与事件折叠必须一致。

## 一、认证顺序

| 步骤 | 请求 | 结果 |
|---|---|---|
| 配对 | `POST /chatdsh/gateway/mobile/pair`，JSON `{code, deviceName, platform}` | `{token, deviceId, name, platform, bootPath}` |
| 取启动路径 | `GET /chatdsh/gateway/mobile/session`，请求头 `x-chatdsh-device-token: <token>` 或 `Authorization: Bearer <token>` | `{deviceId, name, platform, bootPath}` |
| 换运行时会话 | `GET <控制平面地址><bootPath>` | 303 跳转并下发 `dsh-auth-*` cookie |
| 设备管理 | `GET /chatdsh/gateway/mobile/devices`，`DELETE /chatdsh/gateway/mobile/devices?id=<deviceId>` | `{devices:[{id,name,platform,createdAt,lastSeenAt,revokedAt?}]}`、`{revoked:true}` |

设备令牌是长期凭据，只在配对响应里出现一次，服务端只保存 SHA-256 摘要。控制平面地址由用户填写，Android 与 iOS 都允许 `http` 与 `https`，生产入口应使用 HTTPS。

### 配对载荷与 WebSocket 配对

除了上面的 HTTP 配对，控制平面还提供两条与运行时插件同形的路径，让上游客户端不需要改协议代码。

`GET /chatdsh/gateway/mobile/pairing` 返回一份配对载荷：

```json
{ "encoded": "<Base64URL>", "payload": { "version": 2, "publicUrl": "ws://<控制平面>/ws/mobile", "pairingCode": "<code>", "expiresAt": 1793088161253 }, "expiresAt": 1793088161253 }
```

`encoded` 是 `payload` 的 Base64URL 编码，与运行时插件下发的载荷同形（`version` 为 2、`publicUrl` 是 WebSocket 地址、`expiresAt` 以毫秒计），客户端可以直接交给上游的 `GatewayPairingPayloadParser`。

WebSocket 配对：连 `/ws/mobile` 时把一次性配对码放进子协议 `dsh-pair.<code>`，握手成功后收到

```json
{ "kind": "paired", "token": "<设备令牌>", "device": { "id": "<deviceId>", "name": "<名称>" } }
```

随后同一条连接上继续收到运行时插件的 `hello` 帧，配对到此完成，业务帧在连接上直接可用。客户端在手动配对期间不会重连，配对连接必须活到 `hello` 到达。之后的每次重连都不带配对码，改为在 `Authorization: Bearer` 或 `x-chatdsh-device-token` 里带设备令牌连 `/ws/mobile`。

手机带来的配对码与设备令牌由控制平面消费，转发到运行时插件时会被移除：插件只在本机回环上接受控制平面的连接，它自己的设备鉴权按设计关闭，插件把每条桥接连接都当成控制平面这一个客户端。配对码错误或已过期回 401 `pairing-code-invalid`，未配置配对码回 404 `pairing-disabled`，运行时拒绝升级时回 502 `runtime-upgrade-rejected` 并撤销刚写入的设备。

业务通道与配对的拒绝都会写事件并计数：升级阶段拒绝写 `chatdsh.gateway.mobile.upgrade.rejected`（配对路径写 `chatdsh.gateway.mobile.rejected`），计数指标是 `chatdsh_mobile_upgrades_total`。

设备管理端点使用网页身份，与其它控制平面接口一致；吊销立即生效，同一令牌的下一次 `mobile/session` 与 WebSocket 升级都返回 401。

## 二、单次 RPC

运行时 API 走 `/api` 的 HTTP POST 通道。请求体固定为：

```json
{
  "type": "client-request",
  "rpcId": "<uuid>",
  "method": "session/list",
  "payload": { "args": { } }
}
```

响应体固定为：

```json
{
  "type": "server-response",
  "rpcId": "<uuid>",
  "result": { "ok": true, "value": { } }
}
```

失败时 `result.ok` 为 `false`，`result.error` 带 `code`、`message` 与 `details`。

### 使用到的端点

| 端点 | `args` | 成功值 |
|---|---|---|
| `session/list` | `{"_request":{}}` | `{items:[{sessionId,updatedAt,running,cwd,projections:{values:{title}}}]}` |
| `session/create` | `{"request":{}}` | `{sessionId,agentPreset?}` |
| `session/prompt` | `{"request":{requestId,sessionId,mode:"queue",content:[{type:"text",text}]}}` | `{accepted:true}` |

`session/prompt` 的 `requestId` 由客户端生成 UUID，用于把接受结果和持久化的用户消息对应起来。

## 三、遥测上报

移动端不持有 OpenObserve 凭据，[`telemetry.md`](telemetry.md) 6.7 节登记的移动端信号经控制平面端点 `POST /chatdsh/telemetry/mobile` 中转。请求头带 `x-chatdsh-device-token: <token>` 或 `Authorization: Bearer <token>`，令牌与 `mobile/session` 相同。

请求体是批量载荷，单批最多 64 条、256 KB，单条最多 16 KB：

```json
{
  "records": [
    { "signal": "span", "name": "chatdsh.mobile.connect", "durationMs": 320, "attributes": { "attempt": 1, "outcome": "ok" } },
    { "signal": "event", "name": "chatdsh.mobile.keystore", "attributes": { "action": "write", "outcome": "ok" } },
    { "signal": "metric", "name": "chatdsh_mobile_offline_queue_depth", "value": 3, "attributes": {} }
  ]
}
```

`signal` 取 `event`、`span`、`metric`。span 的 `durationMs` 以毫秒计，控制平面把它写成 span 的 `duration` 属性；指标的 `value` 按名称取单位，`chatdsh_mobile_connect_seconds` 用秒，`chatdsh_mobile_offline_queue_depth` 是当前条数。成功响应为 `{"accepted":true,"counts":{...},"dropped":{...}}`，`dropped` 统计未登记属性键的条数；这些键不会转发，控制平面把它们计入 `chatdsh_telemetry_dropped_total`。

| 状态码 | `error` | 触发条件 |
|---|---|---|
| 400 | `invalid-json`、`invalid-payload`、`empty-batch`、`invalid-signal`、`invalid-name` 等 | 请求体或记录形状不合法 |
| 401 | `device-token-required`、`device-token-invalid` | 未带令牌或令牌无效、已吊销 |
| 404 | `telemetry-disabled` | 控制平面遥测关闭 |
| 413 | `payload-too-large`、`batch-too-large`、`record-too-large` | 超出体积或条数上限 |
| 422 | `forbidden-attribute`、`email`、`phone`、`credential`、`internal-address`、`hostname`、`value-too-long` | 命中内容边界 |
| 429 | `too-many-batches` | 单台设备每分钟超过 60 批 |
| 503 | `queue-full` | 控制平面中转队列已满 |

记录名只接受 6.7 节登记的七个名称：`chatdsh.mobile.startup`、`chatdsh.mobile.connect`、`chatdsh.mobile.push.deliver`、`chatdsh.mobile.queue.replay`、`chatdsh.mobile.keystore`、`chatdsh_mobile_connect_seconds`、`chatdsh_mobile_offline_queue_depth`。属性键只接受 `chatdsh.surface`、`chatdsh.component`、`chatdsh.instance.id`、`chatdsh.version`、`deployment.environment`、`session.id`、`workspace.id`、`turn`、`step`、`tool.name`、`mcp.method`、`provider`、`model`、`request.id`、`error.type`、`error.code`、`outcome`、`device.kind`、`attempt`、`kind`、`count`、`action`。`chatdsh.surface=mobile` 与 `device.kind=mobile` 由控制平面补写，客户端传同键也会被覆盖。

遥测关闭时端点返回 404，移动端按 `telemetry.enabled=false` 停止采集，行为与开启时一致。

## 四、会话事件流

WebSocket 地址为 `/api/remote.mux`。连接时带上运行时会话 cookie。打开一个会话流发送：

```json
{
  "type": "open",
  "streamId": "<uuid>",
  "endpoint": "session/follow",
  "payload": {
    "args": {
      "request": {
        "address": { "kind": "session", "sessionId": "<id>" },
        "assistantStream": true,
        "maxMessages": 200
      }
    }
  }
}
```

服务端按 `item` 帧返回值：

| `value.type` | 内容 |
|---|---|
| `snapshot` | `records` 是历史事件数组，`cursor` 是当前水位 |
| `event` | 一条新的会话事件 |
| `assistant-stream` | 助手流式片段 |

`end` 表示流结束，`error` 表示流失败。客户端关闭时发送：

```json
{ "type": "cancel", "streamId": "<uuid>" }
```

## 五、事件折叠

客户端只展示可读消息，事件原文保留会话语义：

| 事件 | 折叠结果 |
|---|---|
| `user/message`，`data.source.kind == "user"` | 用户消息，拼接 `content` 里的 `text` 块 |
| `assistant/message` | 助手消息，拼接 `data.message.content` 里的 `text` 块 |
| `turn/end` 且 `data.reason.kind == "error"` | 错误消息，取 `data.reason.error.message` |
| `approval/asked` | 系统提示，展示工具名与原因 |
| `tool/call` | 系统提示，展示工具名 |

`agent/inbox/spliced`、`system/message` 等内部事件不进入聊天列表，避免把运行时上下文和技能目录当成用户消息。

## 六、平台实现边界

协议实现不得依赖 WebView。Android 使用 OkHttp 的原生 socket，并把 `SocketFactory` 与 `Dns` 绑定到 VPN 网络；iOS 使用 URLSession 与 `URLSessionWebSocketTask`，网络绑定由 NetworkExtension 或系统 VPN 路由承担。两端都实现同一组请求、响应与事件折叠。

Android 的平台无关部分在 `mobile/android/app/src/main/java/com/chatdsh/mobile/core`，平台部分在同级的 `NetworkRoute`、`MainActivity` 与 `ChatActivity`。
