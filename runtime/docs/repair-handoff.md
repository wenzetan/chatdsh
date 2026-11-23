# 合入前修复交接文档（R01–R03）

本文件用于向执行修复的子代理委派 `refactor/capability-integration` 分支合入 `main` 前的三项收口修复。每项修复相互独立，可并行派发；全部完成并通过总验收后再合并至 `main`。

执行修复必须严格遵守 [AGENTS.md](../../AGENTS.md) 全部约束：fast-fail、禁止 mock 或假实现绕过验证、禁止读写 `/tmp`、禁止用 Git 回滚代码、禁止以脚本程序化编辑源码、所有行为变更同步完成遥测与真实运行测试。

---

## R01：本机同源中继代理（打通直开官方 Web 与 Desktop 端访问跨源中继）

### 问题背景

`@chatdsh/client-remote` 当前在浏览器侧直接对配置的 `controlUrl` 发起 `fetch`（[api.ts](../packages/client/remote/src/client/api.ts)），而中继服务端不输出 CORS 响应头。用户经中继地址（如 `https://relay.example.com/d/<deviceId>/`）访问时同源可用；当用户在本机直接打开官方 Desktop 客户端或本机 `http://127.0.0.1:3080` 并填入远程中继地址时，浏览器会拦截跨源请求，导致设备列表、会话列表、离线只读副本与节点配对全部不可用。

### 涉及文件

- [runtime/packages/host/device-link/src/index.ts](../packages/host/device-link/src/index.ts)
- 新增 `runtime/packages/host/device-link/src/relay-proxy.ts`
- [runtime/packages/client/remote/src/client/api.ts](../packages/client/remote/src/client/api.ts)
- [runtime/packages/client/remote/src/client/controller.ts](../packages/client/remote/src/client/controller.ts)
- [runtime/packages/client/remote/src/client/control-url.ts](../packages/client/remote/src/client/control-url.ts)
- [runtime/e2e/unit/device-link.test.mjs](../e2e/unit/device-link.test.mjs) 与客户端远程面板对应单元测试

### 实现契约

1. **宿主侧同源中继转发端点（`host-device-link`）**
   只要本地 `webServer` 存在，即无条件注册以下四个只允许白名单路径的代理端点（即使尚未配置 `CHATDSH_NODE_TOKEN` 也要注册，以便用户先在界面里完成首次配对）：
   - `GET /chatdsh/device/relay/devices` -> 转发至 `<target>/chatdsh/gateway/devices`
   - `GET /chatdsh/device/relay/sessions` -> 转发至 `<target>/chatdsh/gateway/sessions`
   - `GET /chatdsh/device/relay/replica?sessionId=<id>` -> 转发至 `<target>/chatdsh/gateway/replica?sessionId=<encodeURIComponent(id)>`（校验 `sessionId` 非空）
   - `POST /chatdsh/device/relay/pair` -> 转发至 `<target>/chatdsh/gateway/devices/pair`（请求体上限 64 KiB）

2. **目标中继地址解析与安全校验**
   - 仅接受回环来源地址（`127.0.0.1`、`::1`、`::ffff:127.0.0.1`），非回环返回 `403 loopback-only`。
   - `POST /chatdsh/device/relay/pair` 校验请求头 `x-chatdsh-csrf: 1`，缺失或错误返回 `403 csrf-required`。
   - 目标中继地址优先读取请求头 `x-chatdsh-control-url`，缺失或为空时回退 `this.config.controlUrl`；两者均空返回 `400 control-url-required`。
   - 对目标地址执行严格校验：只允许 `http:` 与 `https:` 协议，拒绝内嵌凭据（`@`）、查询串与片段，非法地址返回 `400 control-url-invalid`。
   - 仅转发上述四个固定目标路径，禁止透传任意路径或任意上游响应 Cookie；请求与响应透传 `traceparent` 与 `tracestate`；超时 8000 毫秒，上游不可达返回 `502 relay-unreachable`，超时返回 `504 relay-timeout`。
   - 严禁将配对码或返回的节点 `token` 写入日志与遥测属性。

3. **客户端调用路由（`@chatdsh/client-remote`）**
   - `controlUrl` 为空（同源经中继页面访问）时，继续直接请求同源 `/chatdsh/gateway/*`。
   - `controlUrl` 非空且与当前 `location.origin` 不同源（直开本机 `dsh web` 或官方 Desktop 客户端）时，`RemoteGateway` 改为请求本机同源宿主代理 `${hostBase}/chatdsh/device/relay/*`，并在请求头附带 `x-chatdsh-control-url: <controlUrl>`（`pair` 附带 `x-chatdsh-csrf: 1`）。
   - 页面打开远程设备（点击在线设备的「打开远程」）仍直接跳转 `${controlUrl}/d/<deviceId>/`。

4. **遥测接入**
   - 复用 `@chatdsh/host-device-link` 已登记信号 `chatdsh.runtime.device.forward`、`chatdsh.runtime.device.forward.failed` 与 `chatdsh_runtime_device_forwards_total`（通过属性区分 `outcome`、`method`、`http.status_code`、`error.type`、`error.code`），若新增任何信号名称须同步登记到 `package.json` 与 [telemetry.md](telemetry.md) 第六节。

### 验收命令与通过标准

```bash
cd /workspace/chatdsh/runtime
pnpm build && pnpm build:client
pnpm check:telemetry && pnpm check:plugins && pnpm check:upstream-names && pnpm check:layering
pnpm test
pnpm verify:plugin-install
```

必须包含以下新增真实测试断言：
- 单元测试覆盖回环来源校验（非回环 403）、非法 `x-chatdsh-control-url` 拒绝（400）、`pair` 缺少 CSRF 头拒绝（403）、四个白名单接口转发成功与超时返回 504、`traceparent` 透传以及遥测关闭态不传播 `traceparent`。
- 真实跨端口集成验证：本机 DSH 运行时（端口 A）与轻量中继（端口 B，无 CORS 头）分别监听不同端口，客户端在端口 A 同源下通过 `/chatdsh/device/relay/*` 成功完成设备列表、会话列表、离线副本读取与节点配对。

---

## R02：解除 `host-device-link` 与 `host-push` 对 `chatdshTelemetry` 的强依赖

### 问题背景

[host/device-link/src/index.ts](../packages/host/device-link/src/index.ts)（`static inject = ['webServer', 'chatdshTelemetry']`）与 [host/push/src/index.ts](../packages/host/push/src/index.ts)（`static inject = ['sessionPersistence', 'chatdshTelemetry']`）将遥测服务写成了必填依赖。若用户单独安装业务插件而未安装 `@chatdsh/host-telemetry`，业务插件无法激活，违背 [AGENTS.md](../../AGENTS.md)「遥测不得成为功能开关」以及 [dsh-adapter/src/services.ts](../../dsh-adapter/src/services.ts) 中 `telemetryOf` 按名可选读取的既定设计。

### 涉及文件

- [runtime/packages/host/device-link/src/index.ts](../packages/host/device-link/src/index.ts)
- [runtime/packages/host/device-link/src/client.ts](../packages/host/device-link/src/client.ts)
- [runtime/packages/host/device-link/src/v2-channel.ts](../packages/host/device-link/src/v2-channel.ts)
- [runtime/packages/host/push/src/index.ts](../packages/host/push/src/index.ts)
- [runtime/packages/host/push/src/continuity.ts](../packages/host/push/src/continuity.ts)
- 对应单元测试文件

### 实现契约

1. **可选依赖声明**：核对本机 `@deepseek-ai/cordis` 类型定义（`runtime/.dsh-deps/@deepseek-ai/cordis`），将两个服务的 `static inject` 改为只强制声明必需业务服务并将 `chatdshTelemetry` 设为可选（例如 `static inject = { required: ['webServer'], optional: ['chatdshTelemetry'] }` 或对应 Cordis 4.x 精确声明形状）。
2. **惰性读取遥测实例**：
   - `DeviceLinkClientOptions.telemetry` 与 `DeviceLinkSessionOptions.telemetry` 支持传入 `ChatdshTelemetry | (() => ChatdshTelemetry | undefined)`；`host/device-link` 传入 `() => telemetryOf<ChatdshTelemetry>(this.ctx)`，每次建链、重连、收到转发请求或记录失败时动态读取当前生效的遥测实例。
   - `ReplicaContinuity` 构造选项同样支持 `ChatdshTelemetry | (() => ChatdshTelemetry | undefined)`；`host/push` 传入 `() => telemetryOf<ChatdshTelemetry>(this.ctx)`，每次 `sendBatch` 与 `recordWatermark` 动态读取遥测实例。
3. **无遥测与迟到加载均成立**：
   - 未安装 `@chatdsh/host-telemetry` 时，两个业务插件正常激活，长连接转发与副本上报功能完整可用。
   - 同时安装 `@chatdsh/host-telemetry`（无论加载先后顺序）时，转发 span（`chatdsh.runtime.device.forward`）与上报 span（`chatdsh.sync.event.push`）正常产出并保持 `traceparent` 贯通。

### 验收命令与通过标准

```bash
cd /workspace/chatdsh/runtime
pnpm build
pnpm check:telemetry && pnpm check:plugins && pnpm check:layering
pnpm test
pnpm verify:device-link && pnpm verify:routing && pnpm verify:plugin-install
```

必须新增两组真实测试断言：
- 在真实 Cordis 容器中仅注册 `webServer` / `sessionPersistence`（不注册 `chatdshTelemetry`），断言 `ChatdshDeviceLinkService` 与 `ChatdshPushService` 均立即激活且业务路径完整成功。
- 在业务插件激活之后再延迟提供 `chatdshTelemetry` 服务，断言后续触发的设备转发与副本上报均记录到真实的 span 与计数器。

---

## R03：副本上报保留 `surfaceOp` 与 `sourceEventSeqs`，同步 `pwa-view.ts` 双形状解析

### 问题背景

1. [host/push/src/continuity.ts](../packages/host/push/src/continuity.ts) 的 `sendBatch` 仅发送 `payload: event.data`，丢弃了事件信封上的 `surfaceOp`（尤其是上下文压缩产生的 `{ op: 'replace', startSeq, endSeq }`）与 `sourceEventSeqs`。异机从副本分叉恢复经过压缩的长会话时，旧消息与压缩摘要会被按 `append` 叠加。
2. [gateway/src/pwa-view.ts](../gateway/src/pwa-view.ts) 的 `payloadOf` 目前只读取裸对象，尚未同步其余四处（`client/remote/model.ts`、`gateway/sessions.ts`、`gateway/store.ts`、`host/import/seed.ts`）已经统一的双形状解包规则。

### 涉及文件

- [runtime/packages/host/push/src/continuity.ts](../packages/host/push/src/continuity.ts)
- [runtime/gateway/src/pwa-view.ts](../gateway/src/pwa-view.ts)
- [runtime/packages/host/import/src/seed.ts](../packages/host/import/src/seed.ts)（核对保留 `replace` 与 `sourceEventSeqs`）
- [runtime/e2e/unit/import-seed.test.mjs](../e2e/unit/import-seed.test.mjs)
- [runtime/e2e/unit/client-complete-sys02-continuity.test.mjs](../e2e/unit/client-complete-sys02-continuity.test.mjs)
- PWA 时间线对应单元测试文件

### 实现契约

1. **上报完整事件信封**：[host/push/src/continuity.ts](../packages/host/push/src/continuity.ts) 的 `sendBatch` 在构造上报批次时，将 `payload` 构造为包含事件信封元数据的完整对象：
   ```ts
   payload: {
     type: event.type,
     seq: Number(event.seq),
     time: event.time,
     data: event.data,
     ...(surfaceOp === undefined ? {} : { surfaceOp }),
     ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
   }
   ```
   核对中继连续性接收端（`gateway/src/replica-continuity/http.ts` 与 `gateway/src/server.ts`）及既有测试，确保批次字节估算、哈希校验与幂等去重均基于新载荷稳定成立。
2. **统一 `pwa-view.ts` 双形状解包**：将 [gateway/src/pwa-view.ts](../gateway/src/pwa-view.ts) 的 `payloadOf` 更新为与 `client/remote/src/client/model.ts:dataOf` 一致的解包逻辑：当 `payload` 为对象、含字符串 `type` 且自身拥有对象类型 `data` 属性时返回 `payload.data`，否则返回 `payload` 本身；确保历史裸数据副本与新上报信封副本渲染结果逐字段一致。
3. **核验分叉种子保留压缩语义**：确认 `buildSeed` 遇到信封中带有 `surfaceOp: { op: 'replace', startSeq, endSeq }` 与 `sourceEventSeqs` 的事件时原样透传，不降级覆盖为 `'append'`。

### 验收命令与通过标准

```bash
cd /workspace/chatdsh/runtime
pnpm build && pnpm build:client
pnpm test
pnpm verify:import && pnpm verify:multi-client && pnpm verify:receipt-sync && pnpm verify:approval-notify
```

必须新增以下回归用例：
- `host-push` 上报携带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 与 `sourceEventSeqs` 的事件后，中继副本存储完整保留这些字段。
- `host-import` 对上述副本调用 `buildSeed` 与 `planFork`，断言产出的种子保留精确的 `replace` 对象与 `sourceEventSeqs`。
- `pwa-view.ts` 的 `buildReplicaTimeline` 对同一组事件的「信封形状」与「裸数据形状」输出完全一致的时间线条目与审批角标状态。

---

## 合入 `main` 前总核对清单

R01–R03 全部合并回 `refactor/capability-integration` 后，执行一次全量验收再合入 `main`：

```bash
cd /workspace/chatdsh/dsh-adapter && pnpm build && pnpm test
cd /workspace/chatdsh/runtime
node_modules/.bin/tsc -b tsconfig.build.json --force
pnpm --config.verify-deps-before-run=false build:client
pnpm --config.verify-deps-before-run=false check:telemetry
pnpm --config.verify-deps-before-run=false check:plugins
node scripts/check-upstream-names.mjs
pnpm --config.verify-deps-before-run=false check:layering
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false verify:plugin-install
pnpm --config.verify-deps-before-run=false verify:device-link
pnpm --config.verify-deps-before-run=false verify:routing
pnpm --config.verify-deps-before-run=false verify:settings-sync
pnpm --config.verify-deps-before-run=false verify:approval-notify
pnpm --config.verify-deps-before-run=false verify:import
pnpm --config.verify-deps-before-run=false verify:receipt-sync
pnpm --config.verify-deps-before-run=false verify:multi-client
pnpm --config.verify-deps-before-run=false verify:mobile-telemetry
```

全部退出码为 0 后：
1. 切换到 `main` 并使用 `--no-ff` 合并 `refactor/capability-integration`，合并提交信息严格遵循 [git-commit-message.md](prompts/git-commit-message.md) 的中英双语格式。
2. 删除已合并的临时工作分支（`work/p01` 至 `work/p05` 及本次修复分支）。
