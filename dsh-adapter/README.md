# @chatdsh/adapter

DSH（deepseek-harness）内部 API 的唯一接触面。ChatDSH 全部宿主插件通过本包访问 DSH 顶层稳定服务、会话类型、事件名与白名单设置命名空间，不直接引用上游内部包。

## 依赖边界

仅声明 7 个 DSH 顶层 peer 依赖，使用开放 semver 区间 `>=0.2.0-0`（`@deepseek-ai/cordis` 为 `>=4.0.0`，`@deepseek-ai/schemastery` 为 `>=3.18.0`），不锁定精确预发布版本：

- `@deepseek-ai/cordis`
- `@deepseek-ai/schemastery`
- `@deepseek-ai/dsh-client-connection`
- `@deepseek-ai/dsh-host-webserver`
- `@deepseek-ai/dsh-session`
- `@deepseek-ai/dsh-session-persistence`
- `@deepseek-ai/dsh-typert-protocol`

## 三条导出路径

- `.`：完整导出面（框架基类、会话类型、服务取值函数、事件名与上游包名）。
- `./events`：纯常量事件名与会话事件类型名，零上游运行时依赖。
- `./upstream`：上游基础包与白名单设置同步模块名登记处，零上游运行时依赖。

## 构建与测试

```sh
pnpm install
node scripts/link-dsh-deps.mjs
pnpm build
pnpm test
```
