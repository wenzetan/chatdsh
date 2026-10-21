# @chatdsh/hermes-adapter

把 Hermes 的 `api_server`（OpenAI 兼容服务与运行接口）翻译成 ChatDSH 的聊天后端契约
`ChatBackend`。这个包只做协议翻译，不含业务判断，也不重试。

## 接口

```ts
import { createHermesChatBackend } from '@chatdsh/hermes-adapter';

const backend = createHermesChatBackend({
  baseUrl: 'http://127.0.0.1:8642',
  apiKeyEnv: 'HERMES_API_KEY',
  requestTimeoutMs: 5000,
  approvalTimeoutMs: 300000,
});
```

| 契约动作 | Hermes 接口 |
|---|---|
| `createRun` | `POST /v1/runs`，带 `X-Hermes-Session-Id` |
| `streamEvents` | `GET /v1/runs/{run_id}/events`，逐行翻译 SSE |
| `respondApproval` | `POST /v1/runs/{run_id}/approval` |
| `steer` | `POST /v1/runs/{run_id}/steer` |
| `stop` | `POST /v1/runs/{run_id}/stop` |
| `health` | `GET /health` |

## 真实协议

联调 `deploy/compose.yaml` 起的 Hermes 时确认了两处形状，与最初的实现不同：

- 发起运行的请求体用 `input` 字段，写成 `message` 会得到 400 `invalid_request_error`；
- 事件流的数据是 `{ event, run_id, seq, ... }`，事件名在 `event` 字段里，文本增量在 `delta` 字段；`run.completed` 表示结束。适配器同时认旧的 `{ type, ... }` 形状。

## 错误

非 2xx 一律抛 `HermesError`，字段 `operation`、`status`、`code`。审批应答收到 409 时
`code` 为 Hermes 返回的 `approval_not_pending` 或 `approval_not_active`，表示 Hermes
侧已解决，上层不得重试；429 表示限流，`status` 保留原值。

## 验证

```bash
pnpm build && pnpm test
```
