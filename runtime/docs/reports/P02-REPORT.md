# P02 交付报告

## 协议实现要点

- 设备端建链后发送 `hello`，携带 `version: 2`、设备标识、平台、角色与 `['http','websocket']` 能力；收到 `welcome` 后校验版本、设备标识、代次与预算，版本不为 2 时按协议违规关闭连接。
- 心跳由两端共同维持：设备每 30 秒发送 `ping` 并回应控制平面的 `ping`，控制平面回应设备的 `ping`；任一侧超过 75 秒没有收到任何一帧就断开并按退避重连。
- HTTP 通道按 `open` → `accepted` → `data` → `end` 执行。请求体与响应体都流式处理，单个数据帧不超过 welcome 下发的 32 KiB；发送方向等待 `credit` 额度，接收方向在本地消费完成后补回额度。`cancel` 会中止本机请求并回 `cancelled`。
- 设备向本机运行时转发时改写 `Host` 与 `Origin` 为本机运行时地址，按路径补发 `credentialFor(credential, path)` 的 `dsh-auth-*` cookie；请求头里的 `traceparent` 与 `tracestate` 原样透传给本机运行时。响应头到达前的 401 会用新凭据重试一次，重试范围限于已经完整缓冲的请求体。
- WebSocket 通道在收到 `open(kind: 'websocket')` 后向本机运行时发起真实升级：沿用浏览器侧的 `Sec-WebSocket-Key` 与版本，去掉 `Sec-WebSocket-Extensions` 以避免压缩协商不一致，改写 `Host`/`Origin` 并补发 API cookie。升级成功后回 `accepted`（101 与响应头），之后在两个套接字之间原样转发字节；任一侧结束发 `end`，异常发 `reset`，取消与连接销毁都会释放本机套接字。
- 中继端 `/d/<deviceId>/*` 的升级事件改为调用 `DeviceLinkHub.handleDeviceUpgrade`。设备离线回 `409 device-offline`，非白名单路径回 `403 path-invalid`，升级失败回 `502 upgrade-rejected`；`chatdsh.gateway.device.proxy` 的 `outcome` 覆盖 `upgraded` 与各类拒绝。
- 既有升级拒绝分支把离线写成 `503 device-offline`、把路径拒绝码写成 `device-upgrade-path-rejected`，与实施指南的契约不一致；本次按契约收敛为 `409 device-offline` 与 `403 path-invalid`，白名单判定与通道协议保持不变。
- 中继端的缓冲请求转发顺序修正为“先发请求体与 `end`，再等待 `accepted`”。原顺序会卡死读取请求体后才回响应头的处理器；通道状态机同步允许半关闭状态接收响应头。这一修正保持既有帧语义与既有测试的期望。
- 遥测复用既有信号：`chatdsh.runtime.device.link`、`chatdsh.runtime.device.forward`、`chatdsh.runtime.device.rejected`、`chatdsh.runtime.device.forward.failed`、`chatdsh_runtime_device_links_total`、`chatdsh_runtime_device_forwards_total`、`chatdsh.gateway.device.proxy`、`chatdsh.gateway.device.rejected`、`chatdsh_gateway_device_proxies_total`。未记录帧载荷、cookie、令牌或请求体原文。

## 改动的文件

- 新增 `runtime/packages/host/device-link/src/protocol.ts`：版本 2 帧类型、预算与目标路径校验。
- 新增 `runtime/packages/host/device-link/src/credential.ts`：本机凭据换取与按路径选择。
- 新增 `runtime/packages/host/device-link/src/v2-channel.ts`：会话、HTTP 通道、WebSocket 通道、序号与额度。
- 新增 `runtime/packages/host/device-link/src/client.ts`：拨出连接、hello/welcome、心跳、重连与统计。
- 改写 `runtime/packages/host/device-link/src/index.ts`：插件生命周期接入新客户端，保留身份与自检端点。
- 修改 `runtime/gateway/src/device-link.ts`：设备心跳、升级结果类型、状态码契约、请求体发送顺序与半关闭状态。
- 修改 `runtime/gateway/src/server.ts`：接通 `/d/<deviceId>/*` 的 WebSocket 升级桥接与代理 span。
- 修改 `runtime/gateway/src/websocket.ts`：补齐升级拒绝状态短语。
- 修改 `runtime/gateway/src/index.ts`：导出升级结果类型。
- 新增 `runtime/e2e/unit/device-link-v2.test.mjs`：真实 SQLite、真实中继、真实设备端客户端的 7 项测试。
- 修改 `runtime/scripts/verify-device-link.mjs` 与 `runtime/scripts/verify-routing.mjs`：改用隔离 `DSH_HOME` 下的官方 `web` profile 与真实 `dsh plugin add` 安装 `@chatdsh/bundle`，新增 Remote mux 双向收发、非白名单 403、离线 409 与断开清理断言。
- 新增 `runtime/scripts/lib/dsh-runtime.mjs`、`runtime/scripts/lib/ports.mjs`、`runtime/scripts/lib/remote-mux.mjs`。
- 更新 `runtime/docs/implementation-guide.md` 的基线状态与 `runtime/docs/telemetry.md` 的 `chatdsh.runtime.device.rejected` 属性列。

## 验收结果

1. `node_modules/.bin/tsc -b tsconfig.build.json`
   - 退出码 2。
   - 仅剩两条既有错误：`packages/host/settings-sync/src/index.ts:191` 与 `:196` 的 cordis 事件类型不匹配。其余包编译干净。

2. `pnpm --config.verify-deps-before-run=false build:client`
   - 退出码 0。
   - 输出：`已打包 @chatdsh/client-pwa → lib/client.js`、`已打包 @chatdsh/client-telemetry → lib/client.js`、`客户端构建完成，处理 2 个包。`

3. `node --test e2e/unit/device-link-v2.test.mjs`
   - 退出码 0。
   - 7 项通过：版本 2 握手与 HTTP 分块/额度/凭据/Host/Origin；取消传播；`/api/remote.mux` 双向收发与断开清理；离线 409 与非白名单 403；welcome 版本 3 触发协议违规断开；心跳双向与失联断开；设备断开后浏览器隧道关闭。

4. `pnpm --config.verify-deps-before-run=false verify:device-link`
   - 退出码 0。
   - 两台真实 DSH 运行时在线、各自自检 200；两台经 `/d/<deviceId>/api/remote.mux` 完成真实 WebSocket 请求与回帧；非白名单路径 403 `path-invalid`；终止设备 A 后浏览器隧道关闭、设备显示离线、探测与 WebSocket 升级均回 409 `device-offline`；设备 B 仍在线且自检 200。

5. `pnpm --config.verify-deps-before-run=false verify:routing`
   - 退出码 0。
   - 两台真实运行时各自命中 `/d/A/` 与 `/d/B/`；未知设备 404 且不回退；无 `/d/` 前缀的请求 404；两台 Remote mux 双向收发通过；非白名单路径 403；终止设备 A 后隧道关闭、离线升级 409；设备 B 不受影响。

## 遗留风险

- `tsc -b` 仍因 `settings-sync` 的两条既有错误退出非零；该文件属于并行工作包，本次未修改。
- 既有 `e2e/unit/device-link.test.mjs` 与 `e2e/unit/device-routing.test.mjs` 仍因导入已删除的 `ShareStore` 失败；本次未修改这些文件，新增覆盖全部放在 `device-link-v2.test.mjs`。
- 中继 `/d/<deviceId>/*` 的普通 HTTP 前缀转发仍由 `proxyToDevice` 缓冲完整请求与响应；设备侧通道已经具备流式能力，端到端流式 HTTP 代理属于后续工作。
- 设备侧 401 重试只重放已经完整缓冲且不超过 1 MiB 的请求体；更大的流式上传在 401 时直接回传响应，不重试。
- `pnpm check:telemetry` 仍报告两条既有网关信号未登记：`chatdsh.gateway.mobile.pairing` 与 `chatdsh.gateway.push.deliver`；本次新增与修改的信号均已在包清单与文档登记。
