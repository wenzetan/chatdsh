# P03 交付报告

## 一、交付范围

`@chatdsh/client-remote` 已作为官方 DSH 客户端插件交付。浏览器侧产物同时服务官方 Web 端与官方 Desktop 端渲染进程，提供以下能力：

- 侧栏「远程设备」入口与主面板：设备列表、在线状态、最近活动时间、按设备归属的会话列表。
- 在线设备跳转：点击 `/d/<deviceId>/` 打开目标设备的官方 DSH 界面。
- 离线只读副本：读取 `/chatdsh/gateway/replica?sessionId=<id>`，按事件类型渲染只读对话。
- 本机继续：调用宿主真实的 `chatdshImport.fork`，创建继承 `parentSession` 的新本地会话。
- 对话顶部远程状态条：页面位于 `/d/<deviceId>/` 下时显示当前执行设备与「返回本机」链接。
- 设置区段：中继连接状态、本机设备标识、`controlUrl` 输入、一次性配对码配对、遥测开关状态。
- 遥测：复用 `chatdsh.client.remote.call`、`chatdsh.client.ui.action`、`chatdsh.client.error` 与 `chatdsh_client_errors_total`，并传播 W3C `traceparent`。

## 二、文件清单

### 新建包 `runtime/packages/client/remote/`

- `package.json`：声明包名、`main`、`./client` 子路径、`dsh.client`（`platform: "web"` 与上游包名注入边）、`chatdsh.telemetry` 与依赖。
- `tsconfig.json`：启用 `jsx: react-jsx`，补 `DOM`、`DOM.Iterable`，引用 `core/contracts` 与 `core/remote-client`。
- `src/index.ts`：宿主侧占位入口，提供 `apply` 与 `CLIENT_ENTRY`，让宿主插件加载器识别包身份。
- `src/client/index.tsx`：浏览器侧入口，注册主面板、侧栏入口、设置区段、对话顶部状态条，并挂载宿主导入服务的 Remote 贡献。
- `src/client/host-modules.d.ts`：声明宿主模块加载器提供的 `react`、`react/jsx-runtime`、slots、locale 与 layout 的最小类型面。
- `src/client/types.ts`：客户端上下文、Remote 调用、分叉输入输出与界面快照类型。
- `src/client/control-url.ts`：`controlUrl` 归一化与端点拼接，拒绝非 HTTP 协议、登录凭据、查询串与片段。
- `src/client/state.ts`：设备路径解析、宿主前缀生成、中继失败归类、错误码提取与相对时间单位。
- `src/client/model.ts`：设备与会话聚合排序、副本事件到只读视图的转换、完整回合判断与分叉记录整理。
- `src/client/api.ts`：中继与宿主端点请求封装，携带 `traceparent`，把失败保留为带状态码与错误码的异常。
- `src/client/telemetry.ts`：OTLP/HTTP JSON 发送器、`chatdsh.client.remote.call` span、界面动作与错误事件、错误计数。
- `src/client/import-service.ts`：用 `@chatdsh/core-remote-client` 构造 `chatdshImport/fork` 的客户端贡献，并解包 Remote 结果。
- `src/client/controller.ts`：面板状态机，负责设备与会话刷新、副本读取、本机继续、配对、地址保存、设置读取与过期响应防护。
- `src/client/storage.ts`：`controlUrl` 的本地保存；存储不可用时只在页面生命周期内保留。
- `src/client/locales.ts`：中文与英文字典。
- `src/client/format.ts`：错误码、相对时间与动作提示的界面文案格式化。
- `src/client/styles.ts`：界面样式，全部颜色、字号与圆角引用官方 CSS 变量，类名统一使用 `chatdsh-remote-` 前缀。
- `src/client/use-controller.ts`：React 组件订阅控制器快照的 Hook。
- `src/client/icon.tsx`：侧栏入口的 SVG 图标。
- `src/client/status-bar.tsx`：对话顶部远程执行状态条，仅在 `/d/<deviceId>/` 页面渲染。
- `src/client/panel.tsx`：主面板、设备列表、会话列表与只读副本视图。
- `src/client/settings.tsx`：设置区段。

### 新建单元测试

- `runtime/e2e/unit/client-remote-control-url.test.mjs`：地址归一化、协议、登录凭据、查询串、片段、无效地址与端点拼接。
- `runtime/e2e/unit/client-remote-overview.test.mjs`：设备与会话聚合、在线优先与最近活动排序、重复会话取舍、未登记设备补齐。
- `runtime/e2e/unit/client-remote-replica.test.mjs`：六类副本事件渲染、事件排序、完整回合判断与分叉记录信封。
- `runtime/e2e/unit/client-remote-state.test.mjs`：设备路径、宿主前缀、中继失败归类、错误码与相对时间单位。

### 工程接线

- `runtime/tsconfig.build.json`：加入 `packages/client/remote` 项目引用。
- `runtime/packages/bundle/chatdsh/package.json`：加入 `@chatdsh/client-remote: workspace:*`。
- `runtime/packages/bundle/chatdsh/cordis.patch.yml`：在 `insert` 末尾追加 `chatdsh-client-remote`，未禁用或覆写任何上游条目。
- `runtime/scripts/verify-plugin-install.mjs`：打包清单加入 `client/remote` 与 `core/remote-client`，必需产物加入对应 `lib`，组合包条目期望加入新条目，客户端模块核对加入 `@chatdsh/client-remote`。
- `dsh-adapter/src/upstream.ts`：登记客户端插件 `dsh.client.inject` 引用的七个官方包名，供 `check:upstream-names` 核对。

### 本地工作区链接

环境禁止运行 `pnpm install`，新包的 `pnpm pack` 与 `tsc` 需要工作区链接。以下链接已创建，均位于被 gitignore 的 `node_modules` 下，不属于提交内容：

- `runtime/packages/client/remote/node_modules/@chatdsh/core-contracts` → `runtime/packages/core/contracts`
- `runtime/packages/client/remote/node_modules/@chatdsh/core-remote-client` → `runtime/packages/core/remote-client`
- `runtime/packages/client/remote/node_modules/zod` → `runtime/node_modules/zod`
- `runtime/packages/bundle/chatdsh/node_modules/@chatdsh/client-remote` → `runtime/packages/client/remote`

## 三、官方客户端机制实测

### 槽位名

- `main`：keyed、root 作用域，由官方三栏布局声明，见 `dsh-client-ui-layout/src/client/index.ts:75` 与 `:197`；槽位目录见 `dsh-cordis-client-runner/src/client/slot-catalog.ts:2667`。本插件以 `key: 'chatdsh-remote'` 注册主面板。
- `sidebar.panellist`：list、root 作用域，由官方侧栏声明，见 `dsh-client-ui-sidebar/src/client/index.ts:91`；槽位目录见 `dsh-cordis-client-runner/src/client/slot-catalog.ts:4320`。本插件以同一个 `id` 注册侧栏入口，侧栏据此选择主面板。
- `settings.section`：list、root 作用域，由官方设置外壳声明，见 `dsh-client-ui-settings-general/src/client/index.ts:242` 与注册实例 `:266-267`；槽位目录见 `dsh-cordis-client-runner/src/client/slot-catalog.ts:3803`。本插件以 `id: 'chatdsh-remote'`、`order: 40` 注册设置区段。
- `conversation.header.leading`：single、root 作用域，由官方对话头部声明，见 `dsh-client-ui-conversation/src/client/apply.ts:437`；槽位目录见 `dsh-cordis-client-runner/src/client/slot-catalog.ts:1031`。本插件在此注册远程状态条。

### 服务名

模块导出的 `inject` 常量使用 cordis 服务名，本插件声明 `['slots', 'layout', 'locale', 'remote']`。实测出处：

- `ctx.slots`：官方渲染注册表，见 `dsh-client-ui-renderer/src/client/registry.ts:113`、`:476`、`:741`。
- `ctx.layout`：官方三栏布局控制器，`ctx.layout.selectPanel(id)` 在布局插件中提供；本插件的侧栏入口由官方侧栏负责选择主面板，未直接调用 `selectPanel`。
- `ctx.locale.register` 与 `ctx.locale.bind`：见 `dsh-client-locale/src/client/index.ts:403` 与 `:459`。
- `ctx.remote.$host` 与 `ctx.remote.$mount`：见 `dsh-api-gateway/src/client/index.ts:200` 与 `:214`。

### `dsh.client.inject` 的实际内容

官方包的 `package.json` 在 `dsh.client.inject` 里登记上游包名，作为模块加载与预取的依赖边；模块导出的 `inject` 常量登记 cordis 服务名，作为 fiber 注入列表。侧栏包的清单列出了 `@deepseek-ai/dsh-client-ui-renderer`、`@deepseek-ai/dsh-client-ui-layout` 等上游包名，侧栏源码导出 `['slots', 'layout', 'uiWorkspace', 'locale', 'shortcuts']`。插件管理器的源码在 `dsh-client-ui-plugin-manager/src/client/index.ts:86` 导出 `['slots', 'locale', 'remote', ...]`，它的清单同样使用上游包名。

本插件的实现按官方清单与官方源码分别填写两处：`package.json` 的 `dsh.client.inject` 使用七个上游包名，源码导出的 `inject` 使用四个 cordis 服务名。任务描述里把 `package.json` 的这一项写成了 cordis 服务名，实测结果与此不同；本地 `check:layering` 要求这一项是上游包名，`check:upstream-names` 要求这些包名在适配层登记，因此实现以实测与检查脚本为准。

### 宿主导入服务

- 宿主服务名为 `chatdshImport`，见 `runtime/packages/host/import/src/index.ts:109`。
- `fork` 端点由 `@Remote('fork')` 声明，见同文件 `:178`。
- 客户端没有上游生成器产物。本插件使用仓库现有的 `@chatdsh/core-remote-client` 手工构造 contribution，挂载到 `ctx.remote.chatdshImport`，再调用 `fork`。
- `ForkInput` 定义见 `runtime/packages/host/import/src/index.ts:47`，`ForkOutcome` 定义见 `:55`。浏览器发送 `records`、`sourceSessionId`、`sourceDeviceId`、`turnTo`、`importMode: 'full-prefix'`、`availableAttachmentIds: []`、`scheduledTasks: 0`、`sessionId` 与 `cwd`。
- `cwd` 取当前宿主 `ctx.remote.$host.home`；该值为空时退回源会话的 `cwd`。

## 四、数据接口与鉴权

- `GET /chatdsh/gateway/devices`
  - 响应：`{ devices: [{ id, name, platform, role, capabilities, online, lastSeenAt }] }`。
  - 路由与处理：`runtime/gateway/src/server.ts:138`、`:1484-1510`。
  - 鉴权：中继的公开读取路由，不需要令牌头。
- `GET /chatdsh/gateway/sessions`
  - 响应：`{ devices: [{ deviceId, name, platform, online, lastSeenAt, sessions: [{ sessionId, title, updatedAt, cwd, workspaceName, kind }] }] }`。
  - 路由与处理：`runtime/gateway/src/server.ts:1162-1179`，聚合逻辑在 `runtime/gateway/src/sessions.ts`。
  - 鉴权：中继的公开读取路由，不需要令牌头。
- `GET /chatdsh/gateway/replica?sessionId=<id>`
  - 响应：`{ sessionId, watermark, events: [{ seq, kind, time, bytes, payload }] }`。
  - `payload` 是完整会话事件信封 `{ type, seq, time, data }`。
  - 路由与处理：`runtime/gateway/src/server.ts:1516-1588`。
  - 鉴权：中继的公开读取路由，不需要令牌头。
- `POST /chatdsh/gateway/devices/pair`
  - 请求：`{ code, name, platform, role, capabilities }`。
  - 响应：`{ deviceId, token }`。
  - 路由与处理：`runtime/gateway/src/server.ts:1361-1445`。
  - 鉴权：要求中继配置 `CHATDSH_PAIRING_CODE`；未配置返回 404 `pairing-disabled`，配对码不匹配返回 401 `pairing-code-invalid`，角色或能力字段不合法返回 400。
- `GET /chatdsh/device/identity`
  - 响应：`{ deviceId }`。
  - 出处：`runtime/packages/host/device-link/src/index.ts:35` 与 `:96-108`。
  - 鉴权：只在 `CHATDSH_DEVICE_ID` 非空时注册；未配对时返回 404。
- `GET /chatdsh/telemetry/status`
  - 响应：遥测状态对象，至少包含 `enabled` 与 `reason`。
  - 出处：`runtime/packages/host/telemetry/src/endpoints.ts:13` 与 `:111`。
  - 鉴权：只允许回环来源；非回环返回 403 `loopback-only`。
- `POST /chatdsh/telemetry/browser`
  - 载荷：OTLP/HTTP JSON；请求头 `x-chatdsh-signal` 与 `x-chatdsh-csrf: 1`。
  - 关闭遥测时返回 404；浏览器侧发送器丢弃失败，不改变业务结果。
- `GET /chatdsh/gateway/events`：SSE 通知流，路由见 `runtime/gateway/src/server.ts:1589-1611`。本插件的设备与会话面板使用一次性读取，不订阅该流。
- `POST /chatdsh/gateway/notifications/*`：通知管理路由，由通知模块处理。本插件的设置区段不修改通知订阅。
- `POST /chatdsh/gateway/import`：中继侧复制副本事件并建立新的归属记录，路由见 `runtime/gateway/src/server.ts:1656-1700`。本插件的「在本机继续」不使用这个中继侧入口，调用的是宿主的 `chatdshImport.fork`。

### 事件负载

副本视图按 `kind` 读取 `payload.data`，字段形状来自官方会话包：

- `user/message`：`data.content` 的文本块。
- `assistant/message`：`data.message.content` 的文本块。
- `tool/call`：`data.name`、`data.arguments`、`data.callId`。
- `tool/result`：`data.message.content`、`data.message.isError` 与 `data.error`。
- `approval/asked`：`data.toolName`、`data.reason`、`data.callId`。
- `approval/decided`：`data.outcome`。

事件定义出处：`dsh-session/src/types.ts:287-390` 与 `dsh-user-approval/src/types.ts:44-60`。

## 五、部署形态

- `/d/<deviceId>/` 隧道页面：完整可用。文档来源是中继，`/chatdsh/gateway/*` 命中中继；`/d/<id>/chatdsh/device/identity`、`/d/<id>/chatdsh/telemetry/status` 与 `/d/<id>/chatdsh/telemetry/browser` 经设备前缀转发到目标设备的宿主；`ctx.remote.chatdshImport` 是目标设备的宿主服务，「在本机继续」在目标设备创建会话；「返回本机」链接到 `/`。
- 本机 DSH Web 界面与中继同源：可用。相对根路径同时命中本机宿主的中继路由。
- 本机 DSH Web 界面与中继不同源：插件正常加载，`/chatdsh/gateway/*` 在本机宿主上不存在，面板显示「中继未连接」。设置区段可以保存 `controlUrl`，但中继没有 CORS 响应头，浏览器跨来源读取会被拦截。可用做法是打开中继的 `/d/<deviceId>/` 页面，或者把中继放到同源反向代理后面。
- 官方 Desktop：同一份 `platform: "web"` 产物在 Desktop 渲染进程的模块图中加载。Desktop 打开中继的 `/d/<deviceId>/` 页面时与隧道页面一致。Desktop 使用本机 DSH 界面且中继位于另一来源时，受同样的跨来源限制。
- 中继根路径 `/`：这是中继自带的 PWA 页面，本插件的面板出现在 DSH 页面内部。状态条的「返回本机」指向这个根路径。
- 离线设备 `/d/<deviceId>/`：明确不支持。中继返回 409 `device-offline`，面板提供只读副本入口。
- 跨来源 `controlUrl` 且没有 CORS 或同源反向代理：明确不支持。

## 六、验收命令与原始结论

- `node_modules/.bin/tsc -b tsconfig.build.json --force`：退出码 0，无诊断输出。
- `pnpm --config.verify-deps-before-run=false build:client`：退出码 0，打包 `@chatdsh/client-pwa`、`@chatdsh/client-remote`、`@chatdsh/client-telemetry` 三个包。
- `pnpm --config.verify-deps-before-run=false check:telemetry`：退出码 0，核对 39 个 span、26 个 event 声明，检查 13 个包，其中 9 个声明了遥测面。
- `pnpm --config.verify-deps-before-run=false check:plugins`：退出码 0，插件 8 个、客户端插件 3 个、组合包 1 个。
- `pnpm check:upstream-names`：退出码 0，适配层登记 13 个上游包名。
- `pnpm --config.verify-deps-before-run=false check:layering`：退出码 0。
- `pnpm --config.verify-deps-before-run=false test`：168 个测试，167 个通过，1 个跳过，0 个失败。跳过项是已有的 TOTP 完整校验，原因是本机缺少 `otplib`。
- `pnpm --config.verify-deps-before-run=false verify:plugin-install`：退出码 0。官方 `web` profile 真实安装通过；`dump-config` 出现 8 个组合包条目且未改动上游条目；遥测开启时 `status.enabled=true`，关闭时 `status.enabled=false`、`reason=env`、浏览器上报端点返回 404；`__DSH_BOOT__` 中出现 `@chatdsh/client-telemetry`、`@chatdsh/client-pwa` 与 `@chatdsh/client-remote`，三者的 `/plugins/.../client.js` 产物均返回 200。
- 四个新增单元测试：19 个测试，19 个通过。

## 七、遥测

- 使用名称：
  - span `chatdsh.client.remote.call`，属性 `rpc.method`、`outcome`。
  - event `chatdsh.client.ui.action`，属性 `action`、`outcome`。
  - event `chatdsh.client.error`，属性 `error.type`、`error.code`。
  - metric `chatdsh_client_errors_total`，属性 `error_type`。
- 声明位置：`runtime/packages/client/remote/package.json` 的 `chatdsh.telemetry`；`runtime/docs/telemetry.md` 6.3 节已有同名登记；`check:telemetry` 已核对三处一致。
- 发送方式：OTLP/HTTP JSON，`POST` 到宿主遥测中继，请求头 `x-chatdsh-signal` 与 `x-chatdsh-csrf: 1`。页面位于 `/d/<deviceId>/` 下时，上报路径带设备前缀，经中继转发到目标设备宿主。
- 链路上下文：每次 `call` 生成 `00-<trace-id>-<span-id>-01`，客户端 span 使用同一组标识，HTTP 请求头携带 `traceparent`；中继的 `telemetry.withContext` 还原父上下文并创建子 span。
- 内容边界：不记录提示词、模型输出、工具参数与工具结果原文、会话正文、配对码、节点令牌、中继地址或 Cookie。配对令牌只在设置区段显示一次，不进入遥测，也不写入本地存储。

## 八、测试覆盖

- 地址归一化：空输入、末尾斜杠、反向代理前缀、非 HTTP 协议、登录凭据、查询串、片段、无效地址、端点拼接。
- 设备与会话聚合：在线设备优先、最近活动倒序、会话更新时间倒序、重复会话保留较新记录、未登记设备补齐、会话计数。
- 副本视图：六类事件的文本与字段提取、事件排序、未知事件过滤、完整回合判断、分叉记录信封。
- 状态判断：设备路径解析、宿主前缀、中继失败归类、错误码提取、相对时间单位。

## 九、遗留风险

- 跨来源 `controlUrl` 需要中继提供 CORS 响应头，或者部署在同源反向代理后面。当前中继没有 CORS 响应头，跨来源直接读取会被浏览器拦截。
- 配对动作不能在浏览器里写入设备的 `CHATDSH_NODE_TOKEN`。设置区段显示一次性令牌，操作者需要把它配置到设备环境。仓库里没有宿主侧配对写入端点。
- 「在本机继续」使用当前宿主主目录作为新会话工作目录，源会话的 `cwd` 作为后备。全局面板没有当前工作区绑定，操作者可能需要在分叉后重新选择目标工作区。
- `chatdshImport` 的客户端贡献是手工构造的。宿主导入包没有生成的 `./remote` 产物，当前形状由 `@chatdsh/core-remote-client` 与既有 `remote-contribution` 单元测试覆盖；上游 descriptor 形状变化时需要同步更新。
- 客户端插件的宿主侧入口是空实现。只安装 `@chatdsh/client-remote` 而没有 `@chatdsh/host-import` 时，「在本机继续」显示「本机导入服务不可用」。
- 遥测状态端点只允许回环来源。经非回环代理访问时返回 403，设置区段显示「不可用」；经中继设备前缀访问时，设备侧请求是回环来源，可以正常读取。
- 浏览器 `traceparent` 传播覆盖中继与宿主 HTTP 请求。`import.fork` 走 WebSocket 上的 Remote 调用，不携带这组 HTTP 头。
- `controlUrl` 保存在 `localStorage`。浏览器拒绝本地存储时，地址只在当前页面生命周期内保留。
- 本地 `pnpm pack` 依赖上文列出的 `node_modules` 工作区链接。它们被 gitignore 忽略，新检出后需要按正常安装流程重建。

## 十、官方机制差异记录

- `package.json` 的 `dsh.client.inject` 在官方包里登记上游包名，模块导出的 `inject` 常量登记 cordis 服务名。任务描述把 `package.json` 的这一项写成了 cordis 服务名。实现按官方清单与本地检查脚本填写：清单里是七个上游包名，源码里是 `slots`、`layout`、`locale`、`remote`。
- 宿主导入包没有生成的 `./remote` 产物。实现使用仓库已有的 `@chatdsh/core-remote-client` 构造客户端贡献，这是本仓库对自建 Remote 服务的既定机制，也是「在本机继续」实际调用的入口。
