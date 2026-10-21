# @chatdsh/forge-bridge

把外部系统的投递规范化成 ChatDSH 的自动化事件。控制平面的 webhook 路由用它把
GitHub 与通用投递收成同一种形状，再按事件标识去重。

## 接口

```ts
import { normalizeWebhook } from '@chatdsh/forge-bridge';

const event = normalizeWebhook({ headers: request.headers, body });
// { automationId: '', eventId, receivedAt, source: 'github' | 'generic', payload }
```

| 判定项 | 规则 |
|---|---|
| 来源 | 有 `x-github-event` 头为 `github`，否则 `generic` |
| 事件标识 | 优先取 `x-github-delivery` 头；缺省取请求体 SHA-256 的前 32 位十六进制 |
| 请求体 | 必须是 JSON 对象；为空、非 JSON、数组或 `null` 时抛 `WebhookInvalidError` |

`automationId` 由调用方按命中的记录填入，规范化阶段不知道记录。

## 验证

```bash
pnpm build && pnpm test
```
