# @chatdsh/adapter

DSH（deepseek-harness）内部 API 的唯一接触面。ChatDSH 的插件不直接引用上游内部包，全部经由这一层。

## 为什么单独成库

上游是预发布节奏，2026-08-10 到 2026-10-17 共 36 个版本、67.5 天、平均 1.93 天一版。内部 API 的引用面越散，升级时要改的位置越多。这一层把引用面收在一个包里：

- 上游包名与导出：`Service`、`schema`、`Remote`、`TypertRemoteService`、`defineTool`、`defineDomain`、`SessionId` 等
- 事件名字符串：`AGENT_EVENTS`、`SESSION_EVENTS`、`APPROVAL_EVENTS`、`SESSION_EVENT_TYPES`
- `ctx` 服务名：`toolsOf`、`storageDomainOf`、`sessionsOf` 等取值函数
- 上游包名与行 id：`UPSTREAM_TOOL_ROWS`、`UPSTREAM_ROWS`、`UPSTREAM_CLIENT_UI`、`UPSTREAM_MCP_CLIENT` 等

单独成库的好处是它可以有自己的版本号：上游发新版时这一层跟一版，业务包按需跟进，两边的节奏不必绑在一起。

## 三条导出路径

`.` 是完整面，包含需要上游包的转出与取值函数。`./events` 只含事件名常量与纯函数，`./upstream` 只含上游包名与行 id——这两条路径都不引任何上游包，纯函数模块、浏览器侧代码与单元测试从它们取，才能脱离 DSH 安装单独加载。

## 上游包名的登记处

上游包名在业务代码与配置清单里出现时是字符串：补丁层按 `name` 匹配上游的行，名字写错时整条补丁被跳过，只是不生效；客户端插件的 `dsh.client.inject` 写错时面板永久停在 pending。这些名字集中登记在 `src/upstream.ts`，本仓库的 `scripts/check-upstream-names.mjs` 核对源码、补丁层与客户端清单里出现的每个上游包名都在登记处出现过。上游改名时改这一处，校验脚本指出其余需要跟着改的位置。

## 边界

这一层只做转出与薄封装，不实现业务逻辑。上游内部 API 的引用集中在这里，业务能力留在使用它的包里。

## 构建

```sh
node scripts/link-dsh-deps.mjs   # 把 DSH 安装里的依赖投影到 .dsh-deps，供类型检查解析
npm run build                     # 编译到 lib/
npm test                          # 事件名一致性
```

`link-dsh-deps.mjs` 需要能找到 DSH 安装：把它加进 `PATH`，或设置 `CHATDSH_DSH_INSTALL` 指向安装根目录。

## 版本约定

`engines.dsh` 与 `peerDependencies` 里的 DSH 包版本是精确版本，不是范围。这一层直接引用上游内部结构，版本必须逐一核对，升级时显式改版本号是有意的：它把升级从不可见的破坏动作变成一次显式、可测试的改动。

上游判定兼容性的规则是 `engines.dsh` 存在时它单独决定兼容性，peerDependencies 不参与；没有 `engines.dsh` 时才逐条检查 peerDependencies 里的 `@deepseek-ai/dsh*` 范围。判定用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。

ChatDSH 侧的业务包不采用这条严格规则：它们的 `engines.dsh` 写成 `>=0.2.1-rc.2 <0.3.0-0`，上游在 0.2.x 内发新版时不需要改动业务包；跨到 0.3.0 才需要一次显式回归。要跟上游保持同一版本范围的，只有这一层。
