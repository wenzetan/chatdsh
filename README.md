# @chatdsh/adapter

DSH（deepseek-harness）内部 API 的唯一接触面。ChatDSH 的插件不直接引用上游内部包，全部经由这一层。

## 为什么单独成库

上游是预发布节奏，2026-08-10 到 2026-10-17 共 36 个版本、67.5 天、平均 1.93 天一版。内部 API 的引用面越散，升级时要改的位置越多。这一层把引用面收在一个包里：

- 上游包名与导出：`Service`、`schema`、`Remote`、`TypertRemoteService`、`defineTool`、`defineDomain`、`SessionId` 等
- 事件名字符串：`AGENT_EVENTS`、`SESSION_EVENTS`、`APPROVAL_EVENTS`、`SESSION_EVENT_TYPES`
- `ctx` 服务名：`toolsOf`、`storageDomainOf`、`sessionsOf` 等取值函数

单独成库的好处是它可以有自己的版本号：上游发新版时这一层跟一版，业务包按需跟进，两边的节奏不必绑在一起。

## 两条导出路径

`.` 是完整面，包含需要上游包的转出与取值函数。`./events` 只含事件名常量与纯函数，不引任何上游包——纯函数模块与单元测试从这条路取，才能脱离 DSH 安装单独加载。

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

`engines.dsh` 与 `peerDependencies` 里的 DSH 包版本是精确版本，不是范围。上游的预发布版本只在同一 `[主版本,次版本,修订版本]` 元组内匹配语义版本范围，`^0.2.1-rc.2` 不会匹配 `0.2.2-rc.1`。因此升级 DSH 时这一层要显式改版本号，这是有意的：它把升级从不可见的破坏动作变成一次显式、可测试的改动。
