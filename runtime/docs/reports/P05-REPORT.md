# P05 交付报告

## 契约精简

删除 `packages/core/contracts/src` 下 20 个废弃领域文件：

`memory-backend.ts`、`memory-groups.ts`、`chat-backend.ts`、`model-backend.ts`、`mcp.ts`、`artifacts.ts`、`artifact-versions.ts`、`automation.ts`、`automation-delivery.ts`、`data-management.ts`、`exports.ts`、`shares.ts`、`tool-tiers.ts`、`questions.ts`、`approvals.ts`、`approval.ts`、`assembly.ts`、`services.ts`、`coverage.ts`、`message-sources.ts`。

删除前用 `rg` 核对了 `packages/`、`gateway/`、`e2e/`、`scripts/`，排除 `refer_repos/` 与 `node_modules/`，保留源码与测试没有引用这些模块的导出。`index.ts` 只保留 16 个留存领域文件；`primitives.ts` 移除已删除自动化路由的 cron 解析登记；契约包的 `package.json` 移除 `@deepseek-ai/dsh-llm` peer 依赖并更新描述。

## 失败项与修法

- **settings-sync 的 loader 事件类型**：适配层只转出了 `Context` 类型，没有加载 `@deepseek-ai/cordis-plugin-loader` 的 `declare module '@deepseek-ai/cordis'` 声明合并，`Events` 里没有 `loader/config-update` 与 `loader/volatile-update`。适配层改为 `export type { Loader } from '@deepseek-ai/cordis-plugin-loader'` 并在 `peerDependencies` 登记该包，两处监听与定时扫描行为保持不变。

- **遥测清单缺两条信号**：源码真实发出 `chatdsh.gateway.mobile.pairing` 与 `chatdsh.gateway.push.deliver` 两个 span，`docs/telemetry.md` 第六节与 `gateway/package.json` 的 `chatdsh.telemetry.spans` 没有登记。按 6.1 表格补登记（触发点与必需属性分别为 `outcome`、`device.kind` 与 `outcome`），并在包声明里补两个名称。

- **插件契约检查扫描不存在的目录**：脚本无条件扫描 `e2e/profiles`、`profiles`、`desktop`，这些目录已随第一阶段裁剪删除；同时仍扫描 `packages/tool` 与 `packages/preset`。改为只扫描存在的根目录，移除工具包与预设扫描；保留组合包 patch 文件存在、客户端插件 `platform`/`inject`/`./client` 导出、客户端产物 `lib/client.js` 存在、角色目录包名、组合包依赖存在与客户端插件被组合包覆盖等断言。

- **上游包名检查失败**：`message-sources.ts` 引用 `@deepseek-ai/dsh-llm` 做声明合并，该文件属于 P05 删除清单。删除该文件并移除契约包对应的 peer 依赖后检查通过。

- **分层检查的角色表过期**：脚本仍要求 `packages/tool` 与 `packages/preset`，host 角色允许已删除的 hindsight/hermes 适配器，gateway 允许已删除的 forge-bridge。角色表改为 `core`、`host`、`client`、`bundle`；gateway 只允许 `@chatdsh/core-*`；删除同级适配器目录检查。

- **ShareStore 导入失败**：`gateway/src/store.ts` 已没有 `ShareStore`，分享能力随第一阶段裁剪移除。十个测试装配改用真实 `GatewayStore`、`ReplicaStore`、`ReceiptStore`、`SettingsStore`、`PushQueue`；删除 `share` 与已移除的 `runtimeUrl`、`llmGateway`、`bootstrapSecret`、`runtime` 字段；在测试装配里把 `DSH_HOME` 指向本次 `tempHome`，避免写入只读的 `/root/.dsh`。`wp23` 另外移除了对已删除 `gateway/lib/mobile-channel.js` 的导入与对应手机通道用例。

- **服务契约测试导入已删除包**：测试导入已删除的 `packages/host/memory/lib/index.js`。重写为保留包的契约断言：服务静态依赖、核心 schema、诊断开关与脱敏、链路上下文、设备链路令牌与凭据、导入种子与分叉计划、真实 SQLite 中继存储、设置同步白名单与意图库路径。

- **wp29 设置同步测试无法启动中继**：测试导入已删除的 `gateway/lib/runtime.js` 的 `findFreePort`，中继子进程没有设置 `DSH_HOME`，访问主密钥写到只读的 `/root/.dsh/access`。测试内实现空闲端口查找；中继子进程增加独立 `DSH_HOME`；移除 `CHATDSH_RUNTIME_URL`。两台设备继续使用真实 `host-settings-sync` 实例与独立数据根，版本、白名单、竞争写入、新设备继承断言保留。

- **sys02 连续副本测试引用已删除队列**：测试引用已删除的 `packages/client/conversation/lib/queue/queue.js`，并引用错误的 `gateway/lib/storage/sqlite.js` 路径。删除会话队列导入与相关断言；SQLite 模块路径改为 `gateway/lib/replica-continuity/sqlite.js`；补传、幂等、乱序拒绝、保留代次与视图脱敏断言保留。

- **wp22 通知测试依赖已删除的客户端模块**：浏览器侧用例依赖已删除的 `packages/client/notifications/src` 与 `@chatdsh/core-ui-kit`，服务侧用例也通过已删除的客户端 gateway/center 调用通知接口。服务侧用例改为直接请求真实通知 HTTP 路由 `/chatdsh/gateway/notifications`，保留分页、过滤、已读幂等、已处理、设置三档隐私与冲突、订阅与验证通知、SSE 撤回断言；删除浏览器页面用例与页面构建代码。

## 验收结果

- `pnpm --config.verify-deps-before-run=false build`：退出码 0；输出 `$ tsc -b tsconfig.build.json`。
- `pnpm --config.verify-deps-before-run=false build:client`：退出码 0；输出 `客户端构建完成，处理 2 个包。`。
- `pnpm --config.verify-deps-before-run=false check:telemetry`：退出码 0；输出 `遥测声明校验通过，检查了 12 个包，其中 8 个声明了遥测面。`。
- `pnpm --config.verify-deps-before-run=false check:plugins`：退出码 0；输出 `插件契约检查通过`。
- `pnpm --config.verify-deps-before-run=false check:upstream-names`：退出码 0；输出 `上游包名收拢检查通过`。
- `pnpm --config.verify-deps-before-run=false check:layering`：退出码 0；输出 `分层依赖方向核对通过`。
- `pnpm --config.verify-deps-before-run=false test`：退出码 0；输出 `tests 142`、`pass 141`、`fail 0`、`skipped 1`。
- `node_modules/.bin/tsc -b tsconfig.build.json --force`：退出码 0；没有错误输出。

## 剩余风险

- `scripts/verify-settings-sync.mjs`、`scripts/verify-device-link.mjs`、`scripts/verify-routing.mjs`、`scripts/verify-approval-notify.mjs` 仍从已删除的 `gateway/lib/runtime.js` 取 `findFreePort`，并面向已删除的 `profiles/chatdsh-*` 架构；这些脚本不在 P05 的七条验收命令内，属于 P02/P06 的验收脚本重写范围。
- 浏览器侧通知面板的验收随 `packages/client/notifications` 删除而移除；通知服务端路由、投递、订阅与 Web Push 仍有 wp21 与 wp22 的服务侧断言覆盖。
- 保留契约 `settings.ts` 的 `SETTINGS_SECTIONS` 仍列出 `memory`、`automation`、`share` 等设置区段。该文件在 P05 的保留清单内，本次没有改动其枚举。
- `tsc -b --clean` 不会删除已从源码移除的模块对应的旧 `lib` 产物；本次已清理 20 个废弃契约模块的旧产物，当前 `packages/core/contracts/lib` 与源码一一对应。
- `runtime/pnpm-workspace.yaml` 保留了上一轮加入的 `verifyDepsBeforeRun: false`，用于非主工作树的依赖状态检查；七条验收命令仍显式传入 `--config.verify-deps-before-run=false`。
