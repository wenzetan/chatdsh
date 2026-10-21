# 剩余五项实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成架构重新设计剩下的五项：两个同级适配器目录、三个宿主插件与对应客户端面板、自动化子系统、上游表面与升级工具，使每项都有实现、测试、文档与可复现的验收命令。

**Architecture:** 适配器目录把外部服务（Hermes、Hindsight）的 HTTP 细节收在一处，宿主插件只依赖契约与适配器；自动化由控制平面的 webhook 入口、宿主侧的自动化执行与客户端的自动化面板三段组成；上游表面检查与升级工具放在 `runtime/scripts`，对照适配层登记表核对上游安装。

**Tech Stack:** TypeScript 5.9（`tsc -b` 项目引用）、Node.js 22+ 内置 `node:test`、`node:sqlite`、pnpm 10.33.0、DSH 0.2.1-rc.2、React 19（浏览器侧插件）、OTLP/HTTP（遥测）。

**Spec:** `runtime/docs/architecture.md` 第 2.14、4.3、4.6、4.7、4.8 节；`runtime/docs/hermes-integration.md` 第二、三、五、七节；`runtime/docs/telemetry.md` 第四、六、七节；`runtime/docs/upstream-capabilities.md`。

## Global Constraints

- 每个包的包名前缀等于角色目录：`packages/core/<name>` → `@chatdsh/core-<name>`，`packages/host/<name>` → `@chatdsh/host-<name>`，依此类推。每个角色包声明 `engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`。
- 业务包只从 `@chatdsh/adapter` 取上游能力；模块增强写真实上游包名。
- 服务名约定：宿主平面唯一遥测出口 `@chatdsh/host-telemetry`；各端复用 `@chatdsh/core-diagnostics`。
- 新增或修改能力时，同一提交交付遥测：每类信号都要在包 `package.json` 的 `chatdsh.telemetry` 与 `runtime/docs/telemetry.md` 第六节两处登记；未登记的信号让 `pnpm check:telemetry` 失败。
- 失败分支优先补遥测：拒绝、超时、降级、冲突、限流都必须可查询。
- 遥测内容边界：不记录提示词、模型输出、工具参数与结果原文、文件内容、凭据、Cookie、`Authorization`、请求体原文、邮箱、手机号、真实姓名、主机名与内网地址。
- 遥测关闭时：不构造 SDK 对象、不创建 socket、不生成或传播 `traceparent`。
- 适配器与脚本不允许 `try/catch` 包裹 `import`；出错就地抛出。
- 统一使用 `pnpm` 10.33.0（`/root/.cache/node/corepack/v1/pnpm/10.33.0/bin/pnpm.cjs`）；锁文件只能由 pnpm 实际更新。
- 验证命令统一从 `runtime/` 运行：`pnpm build`、`pnpm build:client`、`pnpm test`、`pnpm check:telemetry`、`pnpm check:plugins`、`pnpm check:upstream-names`、`pnpm check:profiles`、`pnpm check:layering`、`pnpm check:capabilities`。
- 遥测属性键必须先在 `packages/core/diagnostics/src/redact.ts` 的 `DECLARED_KEYS` 里登记，否则非调试模式下会被丢弃。
- 提交信息格式：`<emoji> <type>(<scope>): <中文描述> / <English description>`。
- 新增上游包名、行 id 与事件名时，先在 `dsh-adapter/src/upstream.ts` 或 `dsh-adapter/src/events.ts` 登记。

## Review Focus

- Hermes 返回 409（审批已解决）与 429（限流）时，适配器必须给出可区分的结果；上层不能重试 409。
- Hindsight 不可达时，适配器既不能返回空结果冒充成功，也不能把写入悄悄丢掉；调用方要拿到明确的不可用。

---

## 第一部分：同级适配器目录

### Task 1: 建立 `hermes-adapter` 同级目录与聊天后端契约实现

**Files:**
- Create: `/workspace/chatdsh/hermes-adapter/package.json`
- Create: `/workspace/chatdsh/hermes-adapter/tsconfig.json`
- Create: `/workspace/chatdsh/hermes-adapter/src/index.ts`
- Create: `/workspace/chatdsh/hermes-adapter/src/client.ts`
- Create: `/workspace/chatdsh/hermes-adapter/test/chat-backend.test.mjs`

**Interfaces:**
- Consumes: `@chatdsh/core-contracts` 的 `ChatBackend`、`ChatRunRequest`、`ChatRunHandle`、`ChatRunEvent`、`BackendCallContext`、`BackendHealth`、`ApprovalChoice` 类型（已存在，见 `packages/core/contracts/src/chat-backend.ts`、`services.ts`、`approval.ts`）。
- Produces:
  - `createHermesChatBackend(config: HermesConfig): ChatBackend`，`HermesConfig` 为 `{ baseUrl: string; apiKeyEnv?: string; requestTimeoutMs: number; approvalTimeoutMs: number }`。
  - `HermesError`，字段 `operation: 'create-run' | 'stream' | 'approval' | 'steer' | 'stop' | 'health'`、`status?: number`、`code: string`（409 时 `code` 为 `approval-not-pending`）。
  - `capabilities(): readonly string[]` 返回 `['approval', 'steer', 'events']`。

- [ ] **Step 1: 写失败的测试**

```js
// hermes-adapter/test/chat-backend.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHermesChatBackend, HermesError } from '../lib/index.js';

function fakeHermes(handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    handler(request, response, Buffer.concat(chunks).toString('utf8'));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('createRun 返回 run_id', async () => {
  const server = await fakeHermes((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/runs');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ run_id: 'run-1' }));
  });
  const backend = createHermesChatBackend({ baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 2000, approvalTimeoutMs: 2000 });
  try {
    const handle = await backend.createRun({ sessionId: 'chat-1', text: '你好' }, {});
    assert.equal(handle.runId, 'run-1');
  } finally {
    server.close();
  }
});

test('审批应答 409 映射为 approval-not-pending', async () => {
  const server = await fakeHermes((request, response) => {
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'approval_not_pending' }));
  });
  const backend = createHermesChatBackend({ baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 2000, approvalTimeoutMs: 2000 });
  try {
    await assert.rejects(
      backend.respondApproval('run-1', 'req-1', 'allowed-once', {}),
      (error) => error instanceof HermesError && error.status === 409 && error.code === 'approval-not-pending',
    );
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test hermes-adapter/test/chat-backend.test.mjs`
Expected: FAIL，`Cannot find module '../lib/index.js'`

- [ ] **Step 3: 写实现**

`package.json` 字段：`name: "@chatdsh/hermes-adapter"`、`type: "module"`、`main: "lib/index.js"`、`exports` 含 `.` 与 `./package.json`、`license: "MIT"`、`dependencies` 只有 `@chatdsh/core-contracts: "workspace:*"`、`devDependencies.typescript: "5.9.3"`、`scripts.build: "tsc -b tsconfig.build.json"`、`scripts.test: "node --test 'test/*.test.mjs'"`。

`tsconfig.json` 与 `tsconfig.build.json` 仿 `dsh-adapter`：`extends` 自身 `tsconfig.base.json`（复制 `dsh-adapter/tsconfig.base.json` 的 compilerOptions），`references` 指向 `../runtime/packages/core/contracts`。

`src/client.ts` 导出 `HermesClient`：`createRun(sessionId, text)` 发 `POST /v1/runs`，请求体 `{ session_id, message }`，返回 `{ runId: body.run_id }`；`streamEvents(runId)` 用 `fetch` 读 `GET /v1/runs/{runId}/events`，按行切分 `data: ` 前缀的 SSE 行并 `JSON.parse`，把 `{ type: 'text', text }`、`{ type: 'approval.request', request_id, title, choices }`、`{ type: 'finish', reason }`、`{ type: 'error', code }` 翻译成契约的 `ChatRunEvent`；`respondApproval(runId, requestId, choice)` 发 `POST /v1/runs/{runId}/approval`，请求体 `{ request_id, choice }`；`steer` 与 `stop` 各发对应接口；`health()` 发 `GET /health`，非 2xx 时返回 `{ ok: false }`。

`src/index.ts` 导出 `createHermesChatBackend(config)`：`capabilities()` 返回固定列表，`health` 包一层带超时的 fetch，其余方法委托 `HermesClient`，非 2xx 一律抛 `HermesError`，409 的 `code` 取响应体 `error` 字段，缺省 `approval-not-pending`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd hermes-adapter && node /root/.cache/node/corepack/v1/pnpm/10.33.0/bin/pnpm.cjs build && node --test 'test/*.test.mjs'`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add hermes-adapter
git commit -m "✨ feat(hermes): 新建 Hermes 适配器目录 / add standalone Hermes adapter"
```

### Task 2: 建立 `hindsight-adapter` 同级目录并让 `host-memory` 改为依赖它

**Files:**
- Create: `/workspace/chatdsh/hindsight-adapter/package.json`
- Create: `/workspace/chatdsh/hindsight-adapter/tsconfig.json`
- Create: `/workspace/chatdsh/hindsight-adapter/tsconfig.build.json`
- Create: `/workspace/chatdsh/hindsight-adapter/src/index.ts`
- Create: `/workspace/chatdsh/hindsight-adapter/test/memory-backend.test.mjs`
- Modify: `runtime/packages/host/memory/package.json`
- Modify: `runtime/packages/host/memory/src/client.ts`
- Modify: `runtime/packages/host/memory/src/index.ts:1-20`
- Modify: `runtime/scripts/verify-memory.mjs:9-30`

**Interfaces:**
- Consumes: `MemoryBackend`、`MemoryQuery`、`MemoryHit`、`MemoryWrite`、`BackendCallContext`、`BackendHealth` 类型。
- Produces:
  - `createHindsightMemoryBackend(config: HindsightConfig): MemoryBackend`，`HindsightConfig` 为 `{ baseUrl: string; apiKeyEnv?: string; requestTimeoutMs: number; maxTokens: number }`。
  - `HindsightUnavailableError`（`name === 'HindsightUnavailableError'`）。
  - `recall(query)` 按 `query.banks` 顺序逐 bank 调用并去重；`write(entry)` 返回 `void`，失败抛 `HindsightUnavailableError`。
- 兼容层：`runtime/packages/host/memory` 保留导出的 `createMemoryClient`、`MemoryUnavailableError`，改为从 `@chatdsh/hindsight-adapter` 重导出。

- [ ] **Step 1: 写失败的测试**

```js
// hindsight-adapter/test/memory-backend.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHindsightMemoryBackend, HindsightUnavailableError } from '../lib/index.js';

test('recall 按 bank 顺序请求并按文本去重', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results: [{ id: `hit-${seen.length}`, text: '同一段记忆', type: 'world' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const backend = createHindsightMemoryBackend({ baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 2000, maxTokens: 512 });
  try {
    const hits = await backend.recall({ banks: ['t:1:ws:2', 'acct:3'], text: '蓝鲸' }, {});
    assert.deepEqual(seen, ['/v1/default/banks/t%3A1%3Aws%3A2/memories/recall', '/v1/default/banks/acct%3A3/memories/recall']);
    assert.equal(hits.length, 1);
  } finally {
    server.close();
  }
});

test('服务返回 503 时写入抛 HindsightUnavailableError', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const backend = createHindsightMemoryBackend({ baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 2000, maxTokens: 512 });
  try {
    await assert.rejects(
      backend.write({ bank: 'acct:3', text: '一段记忆' }, {}),
      (error) => error instanceof HindsightUnavailableError,
    );
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test hindsight-adapter/test/memory-backend.test.mjs`
Expected: FAIL，缺少 `../lib/index.js`

- [ ] **Step 3: 写实现**

`src/index.ts` 承载现有 `runtime/packages/host/memory/src/client.ts` 的请求逻辑：`/version` 探活、`POST /v1/default/banks/{bank}/memories/recall`、`POST /v1/default/banks/{bank}/memories`。差异：导出 `createHindsightMemoryBackend` 实现 `MemoryBackend` 接口，`recall` 用 `MemoryQuery.banks` 并按文本去重（复用一份本地 `dedupe` 函数，不导入 runtime 的包），`write` 把 `MemoryWrite.bank/text/metadata` 映射成现有请求体，`health` 返回 `{ ok }`，`capabilities()` 返回 `['recall', 'write', 'operation-id']`。凭据从 `process.env[apiKeyEnv]` 读取并发 `Authorization: Bearer`。

`runtime/packages/host/memory/package.json` 增加 `"@chatdsh/hindsight-adapter": "link:../../../../hindsight-adapter"`；`src/client.ts` 改为 `export { createHindsightMemoryBackend as createMemoryClient, HindsightUnavailableError as MemoryUnavailableError }` 并保留 `RecallOptions`/`WriteOptions` 类型别名，`ChatdshMemoryService` 的调用不变。

- [ ] **Step 4: 运行测试与运行期校验**

Run: `cd hindsight-adapter && node /root/.cache/node/corepack/v1/pnpm/10.33.0/bin/pnpm.cjs build && node --test 'test/*.test.mjs'`，再在 `runtime/` 运行 `pnpm build` 与 `node scripts/verify-memory.mjs`。
Expected: 两条命令均退出码 0；`verify-memory.mjs` 打印探活、写入与召回结果。

- [ ] **Step 5: 更新文档与校验脚本**

`runtime/docs/architecture.md:253` 删去「当前尚未创建」，改写为两个目录已建立并说明各自依赖方向：`hermes-adapter` 只依赖 `@chatdsh/core-contracts`，`hindsight-adapter` 只依赖 `@chatdsh/core-contracts`，`runtime/packages/host/memory` 依赖 `hindsight-adapter`。`runtime/scripts/check-layering.mjs` 增加两段：同级目录不得依赖任何 `@chatdsh/core-*` 以外的自建包。

- [ ] **Step 6: 全量验证并提交**

Run: `cd runtime && pnpm build && pnpm test && pnpm check:layering && pnpm check:profiles`
Expected: 全部退出码 0。

```bash
git add hermes-adapter hindsight-adapter runtime/packages/host/memory runtime/docs/architecture.md runtime/scripts/check-layering.mjs
git commit -m "✨ feat(hindsight): 新建 Hindsight 适配器目录 / add standalone Hindsight adapter"
```

---

## 第二部分：三个宿主插件与客户端面板

### Task 3: `host/model-provider`

**Files:**
- Create: `runtime/packages/host/model-provider/{package.json,tsconfig.json,cordis.patch.yml,src/index.ts,src/client.ts}`
- Create: `runtime/packages/client/model-provider/{package.json,tsconfig.json,src/index.ts,src/client/index.tsx}`
- Create: `runtime/e2e/unit/model-provider.test.mjs`
- Modify: `runtime/tsconfig.build.json`
- Modify: `runtime/packages/bundle/hosted/cordis.patch.yml`
- Modify: `runtime/profiles/chatdsh-{web,desktop,worker}/package.json`
- Modify: `runtime/docs/telemetry.md` 第 6.2 节
- Modify: `runtime/docs/architecture.md` 4.3 与 4.6 节、4.4 节的实现清单

**Interfaces:**
- Consumes: `BackendRegistry`（`@chatdsh/core-backends`）、`ModelProviderInfo`、`ChatdshTelemetry`。
- Produces:
  - `resolveModelProvider(input: { provider: string; baseUrl: string; apiKeyEnv?: string; headers?: Record<string,string>; models?: readonly string[] }): ModelProviderInfo`，缺 `provider` 或 `baseUrl` 时抛出 `model-provider/invalid`。
  - 服务 `ctx.chatdshModelProviders`，Remote 命名空间 `chatdshModelProviders`，方法 `list(): ModelProviderInfo[]`、`status(): { available: boolean; providers: number }`。
  - 遥测：span `chatdsh.runtime.model.provider.resolve`，属性 `provider`、`outcome`；event `chatdsh.runtime.model.provider.failed`，属性 `provider`、`error.type`、`error.code`；metric `chatdsh_model_provider_resolutions_total`，属性 `provider`、`outcome`。

- [ ] **Step 1: 写失败的测试**

```js
// runtime/e2e/unit/model-provider.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelProvider } from '../../packages/host/model-provider/lib/client.js';

test('合法输入补全展示名', () => {
  assert.deepEqual(resolveModelProvider({ provider: 'gateway', baseUrl: 'http://127.0.0.1:20128/v1' }), {
    provider: 'gateway',
    displayName: 'gateway',
    baseUrl: 'http://127.0.0.1:20128/v1',
  });
});

test('缺少 provider 时抛出 error.code 为 model-provider/invalid', () => {
  assert.throws(
    () => resolveModelProvider({ provider: '', baseUrl: 'http://127.0.0.1:20128/v1' }),
    (error) => error.code === 'model-provider/invalid',
  );
});

test('缺 baseUrl 时抛出 error.code 为 model-provider/invalid', () => {
  assert.throws(
    () => resolveModelProvider({ provider: 'gateway', baseUrl: '' }),
    (error) => error.code === 'model-provider/invalid',
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test runtime/e2e/unit/model-provider.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写实现**

`src/client.ts` 是纯函数模块（零 DSH 依赖），导出 `resolveModelProvider`、`ModelProviderError` 与 `GATEWAY_PROVIDER`（`'gateway'`）。校验顺序固定：`provider` 非空且匹配 `/^[a-z][a-z0-9-]*$/`，`baseUrl` 以 `http://` 或 `https://` 开头。校验失败抛 `ModelProviderError`，`code` 为 `'model-provider/invalid'`，`message` 写明缺哪一项或哪一项不合法。

`src/index.ts` 是宿主插件：`export const name = 'chatdsh-model-provider'`、`inject = ['llm']`，注册服务 `chatdshModelProviders`（继承 `TypertRemoteService`）。构造时把配置里的 `providers` 数组逐项过 `resolveModelProvider`，存入 `Map`。`@Remote('list')` 返回 `[...map.values()]`；`@Remote('status')` 返回 `{ available: map.size > 0, providers: map.size }`。每次解析包在 `runSpan('chatdsh.runtime.model.provider.resolve', { provider }, …)` 里，失败补 `event('chatdsh.runtime.model.provider.failed', { provider, 'error.type', 'error.code' })` 与 `counter('chatdsh_model_provider_resolutions_total').add(1, { provider, outcome: 'failed' })`。

`cordis.patch.yml` 插入行 `chatdsh-model-provider`，默认 `providers: []`。

客户端面板 `packages/client/model-provider` 仿 `client-assistants`：设置页区段 id `chatdsh-model-provider`，order 46，通过 Remote `chatdshModelProviders.status()` 读数量，无提供方时显示「还没有模型提供方」。

- [ ] **Step 4: 注册依赖与遥测声明**

`host/model-provider/package.json` 的 `chatdsh.telemetry` 写 `events: ["chatdsh.runtime.model.provider.failed"]`、`spans: ["chatdsh.runtime.model.provider.resolve"]`、`metrics: ["chatdsh_model_provider_resolutions_total"]`，`dependencies` 为 `@chatdsh/adapter`、`@chatdsh/core-contracts`、`@chatdsh/core-backends`。`runtime/docs/telemetry.md` 6.2 节追加三行（span/event/metric）。`runtime/tsconfig.build.json` 加两个包；`runtime/packages/bundle/hosted/cordis.patch.yml` 加 `chatdsh-model-provider` 行；三个 profile 的 `package.json` 各加 `@chatdsh/host-model-provider` 与 `@chatdsh/client-model-provider`，路径 `link:../../packages/host/model-provider` 与 `link:../../packages/client/model-provider`。

- [ ] **Step 5: 验证**

Run: `cd runtime && pnpm build && pnpm build:client && node --test e2e/unit/model-provider.test.mjs && pnpm check:telemetry && pnpm check:plugins && pnpm check:profiles`
Expected: 全部退出码 0。

- [ ] **Step 6: 提交**

```bash
git add runtime/packages/host/model-provider runtime/packages/client/model-provider runtime/e2e/unit/model-provider.test.mjs runtime/tsconfig.build.json runtime/packages/bundle/hosted/cordis.patch.yml runtime/profiles runtime/docs
git commit -m "✨ feat(model): 增加模型提供方宿主插件与面板 / add model provider plugin and panel"
```

### Task 4: `host/context-insights`

**Files:**
- Create: `runtime/packages/host/context-insights/{package.json,tsconfig.json,cordis.patch.yml,src/index.ts,src/summarize.ts}`
- Create: `runtime/packages/client/context-insights/{package.json,tsconfig.json,src/index.ts,src/client/index.tsx}`
- Create: `runtime/e2e/unit/context-insights.test.mjs`
- Modify: `runtime/tsconfig.build.json`、`runtime/packages/bundle/hosted/cordis.patch.yml`、三个 profile、`runtime/docs/telemetry.md` 6.2 节、`runtime/docs/architecture.md` 4.3 与 4.6 节

**Interfaces:**
- Consumes: 会话索引投影 `chatdshSessionIndex`、用量投影 `chatdshUsage`、`sessionProjectionsOf`、`sessionsOf`。
- Produces:
  - `summarizeContext(input: { events: number; inputTokens: number; outputTokens: number; windowTokens: number }): ContextInsight`，`ContextInsight` 为 `{ usedRatio: number; level: 'ok' | 'warn' | 'critical'; remainingTokens: number }`。
  - 服务 `ctx.chatdshContextInsights`，Remote `chatdshContextInsights`，方法 `insight(sessionId: string): ContextInsight`、`all(): Record<string, ContextInsight>`。
  - 遥测：span `chatdsh.runtime.context.insight`，属性 `session.id`、`outcome`；metric `chatdsh_context_usage_ratio`，属性 `level`（取值 `ok`/`warn`/`critical`）。

- [ ] **Step 1: 写失败的测试**

```js
// runtime/e2e/unit/context-insights.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeContext } from '../../packages/host/context-insights/lib/summarize.js';

test('低于七成视为 ok', () => {
  assert.deepEqual(summarizeContext({ events: 10, inputTokens: 100, outputTokens: 50, windowTokens: 1000 }), {
    usedRatio: 0.15,
    level: 'ok',
    remainingTokens: 850,
  });
});

test('七成到九成视为 warn', () => {
  assert.equal(summarizeContext({ events: 10, inputTokens: 600, outputTokens: 200, windowTokens: 1000 }).level, 'warn');
});

test('九成以上视为 critical', () => {
  assert.equal(summarizeContext({ events: 10, inputTokens: 900, outputTokens: 50, windowTokens: 1000 }).level, 'critical');
});

test('窗口为零时就地抛出', () => {
  assert.throws(() => summarizeContext({ events: 0, inputTokens: 0, outputTokens: 0, windowTokens: 0 }), /窗口/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test runtime/e2e/unit/context-insights.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写实现**

`src/summarize.ts` 纯函数：`usedRatio = (inputTokens + outputTokens) / windowTokens`，`level` 按 `< 0.7`、`< 0.9`、其余三档，`remainingTokens = max(0, windowTokens - inputTokens - outputTokens)`；`windowTokens <= 0` 抛 `new Error('上下文窗口必须大于零')`。

`src/index.ts` 宿主插件：`inject = ['sessionProjections', 'sessions']`，服务名 `chatdshContextInsights`。`insight(sessionId)` 取会话，分别读 `chatdshSessionIndex` 与 `chatdshUsage` 两个投影的状态，窗口取配置 `windowTokens`（默认 131072），调 `summarizeContext`，包在 `chatdsh.runtime.context.insight` span 里；会话不存在时抛错（不返回默认值）。`all()` 遍历 `sessionsOf(ctx).list()`。

客户端面板 `client-context-insights` 用侧栏席位 `sidebar.panellist`，条目名 `chatdsh.context-insights`，显示「上下文占用 xx%」与三档颜色文字。

- [ ] **Step 4: 注册依赖、遥测声明与装配**

`package.json` 依赖 `@chatdsh/adapter`、`@chatdsh/core-contracts`；遥测声明写入三个信号名，并在 `docs/telemetry.md` 6.2 节逐行登记（span 属性 `session.id`、`outcome` 已在第五节上下文属性里，无需新增键）。在 `packages/core/diagnostics/src/redact.ts` 的 `DECLARED_KEYS` 里追加 `'level'` 与 `'window.tokens'`。其余装配与 Task 3 相同。

- [ ] **Step 5: 验证**

Run: `cd runtime && pnpm build && pnpm build:client && node --test e2e/unit/context-insights.test.mjs && pnpm check:telemetry && pnpm check:plugins`
Expected: 全部退出码 0。

- [ ] **Step 6: 提交**

```bash
git add runtime/packages/host/context-insights runtime/packages/client/context-insights runtime/e2e/unit/context-insights.test.mjs runtime/packages/core/diagnostics/src/redact.ts runtime/tsconfig.build.json runtime/packages/bundle/hosted/cordis.patch.yml runtime/profiles runtime/docs
git commit -m "✨ feat(context): 增加上下文占用洞察 / add context usage insights"
```

### Task 5: `host/skills`

**Files:**
- Create: `runtime/packages/host/skills/{package.json,tsconfig.json,cordis.patch.yml,src/index.ts,src/registry.ts}`
- Create: `runtime/packages/tool/skill-manage/{package.json,tsconfig.json,src/index.ts}`
- Create: `runtime/packages/client/skills/{package.json,tsconfig.json,src/index.ts,src/client/index.tsx}`
- Create: `runtime/e2e/unit/skills.test.mjs`
- Modify: `runtime/tsconfig.build.json`、`runtime/packages/preset/chat/cordis.patch.yml`、`runtime/packages/bundle/hosted/cordis.patch.yml`、三个 profile、`runtime/docs/telemetry.md` 6.2 与 6.3 节、`runtime/docs/architecture.md` 4.3 与 4.6 节

**Interfaces:**
- Consumes: `skillsOf(ctx)`（`SkillRegistry`）、`defineTool`。
- Produces:
  - `createSkillCatalog(entries: readonly SkillEntry[]): SkillCatalog`，`SkillEntry` 为 `{ id: string; name: string; description: string; source: 'builtin' | 'workspace' | 'user' }`；`SkillCatalog.list(): SkillEntry[]`、`SkillCatalog.enable(id)`、`SkillCatalog.disable(id)`、`SkillCatalog.enabled(): SkillEntry[]`。
  - 服务 `ctx.chatdshSkills`，Remote `chatdshSkills`，方法 `list()`、`toggle(id, enabled)`、`catalog(): { total: number; enabled: number }`。
  - 工具 `skill_manage`：参数 `{ id: string; enabled: boolean }`，返回 `{ id, enabled }`。
  - 遥测：span `chatdsh.runtime.skill.toggle`，属性 `skill.id`、`enabled`、`outcome`；metric `chatdsh_skill_toggles_total`，属性 `enabled`、`outcome`；工具侧沿用 6.3 节的 `chatdsh.tool.execute`。

- [ ] **Step 1: 写失败的测试**

```js
// runtime/e2e/unit/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillCatalog } from '../../packages/host/skills/lib/registry.js';

test('目录按来源列出并默认全部启用', () => {
  const catalog = createSkillCatalog([
    { id: 'tdd', name: '测试驱动', description: '先写测试', source: 'builtin' },
    { id: 'repo', name: '仓库规则', description: '项目约定', source: 'workspace' },
  ]);
  assert.deepEqual(catalog.list().map((entry) => entry.id), ['tdd', 'repo']);
  assert.equal(catalog.enabled().length, 2);
});

test('停用后从启用列表移除，未知标识就地抛出', () => {
  const catalog = createSkillCatalog([{ id: 'tdd', name: '测试驱动', description: '先写测试', source: 'builtin' }]);
  catalog.disable('tdd');
  assert.equal(catalog.enabled().length, 0);
  assert.throws(() => catalog.disable('missing'), /未知技能/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test runtime/e2e/unit/skills.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写实现**

`src/registry.ts` 纯函数目录：内部用 `Map<string, { entry, enabled }>`；`list()` 按输入顺序返回副本；`enable`/`disable` 命中未知标识抛 `new Error('未知技能：' + id)`；`enabled()` 过滤。重复 `id` 在构造时抛 `new Error('技能标识重复：' + id)`。

`src/index.ts` 宿主插件：`inject = ['skills']`，构造时从 `skillsOf(ctx)` 读出已注册技能，映射成 `SkillEntry` 初始目录，注册服务 `chatdshSkills`；`toggle` 改变目录并包 span，同时补 event（成功 `outcome=ok`、失败 `outcome=failed` 并带 `error.type`）与计数器。

`packages/tool/skill-manage/src/index.ts` 仿 `tool-artifact`：`name: 'skill_manage'`，`inject = ['tools', 'chatdshSkills']`，参数 `id`（string，必填）与 `enabled`（boolean，必填），调用服务 `toggle` 后返回结果，渲染一行文本。

客户端面板 `client-skills` 用设置页区段 id `chatdsh-skills`，order 47，列出技能名与来源，显示启用数量。

- [ ] **Step 4: 注册依赖、遥测声明与装配**

`host/skills` 的 `chatdsh.telemetry` 写 `spans: ["chatdsh.runtime.skill.toggle"]`、`metrics: ["chatdsh_skill_toggles_total"]`、`events: []`（`error.type` 走 span 属性）；`tool/skill-manage` 的 `chatdsh.telemetry` 写 `spans: ["chatdsh.tool.execute"]`（若工具执行包装由宿主完成则留空并说明）。在 `docs/telemetry.md` 6.2 节登记 span 与 metric，6.3 节无需新增。`runtime/packages/preset/chat/cordis.patch.yml` 挂载 `@chatdsh/tool-skill-manage`。

- [ ] **Step 5: 验证**

Run: `cd runtime && pnpm build && pnpm build:client && node --test e2e/unit/skills.test.mjs && pnpm check:telemetry && pnpm check:plugins && pnpm check:composition`
Expected: 全部退出码 0；组合检查四个 profile 全部通过。

- [ ] **Step 6: 提交**

```bash
git add runtime/packages/host/skills runtime/packages/tool/skill-manage runtime/packages/client/skills runtime/e2e/unit/skills.test.mjs runtime/tsconfig.build.json runtime/packages/preset/chat/cordis.patch.yml runtime/packages/bundle/hosted/cordis.patch.yml runtime/profiles runtime/docs
git commit -m "✨ feat(skills): 增加技能目录宿主插件与面板 / add skill catalog plugin and panel"
```

---

## 第三部分：自动化子系统

### Task 6: 契约类型与 `forge-bridge` 同级目录

**Files:**
- Create: `runtime/packages/core/contracts/src/automation.ts`
- Modify: `runtime/packages/core/contracts/src/index.ts:1-20`
- Create: `/workspace/chatdsh/forge-bridge/{package.json,tsconfig.json,tsconfig.build.json,src/index.ts,test/normalize.test.mjs}`

**Interfaces:**
- Produces:
  - 契约类型 `AutomationTrigger`（`{ kind: 'webhook'; secretEnv: string } | { kind: 'schedule'; cron: string }`）、`AutomationAction`（`{ kind: 'start-session'; workspaceId?: string; prompt: string }`）、`AutomationRecord`（`{ id; accountId; name; trigger; action; enabled; createdAt }`）、`AutomationEvent`（`{ automationId; eventId; receivedAt; source: 'github' | 'generic' }`）。
  - `forge-bridge` 导出 `normalizeWebhook(input: { headers: Record<string,string|undefined>; body: string }): AutomationEvent`，`source` 判定：有 `x-github-event` 头时为 `github`，否则 `generic`；`eventId` 取 `x-github-delivery` 头，缺省用请求体的 SHA-256 前 32 位十六进制；请求体不是 JSON 对象时抛 `WebhookInvalidError`（`code: 'automation/webhook-invalid'`）。

- [ ] **Step 1: 写失败的测试**

```js
// forge-bridge/test/normalize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebhook, WebhookInvalidError } from '../lib/index.js';

test('GitHub 头决定来源与事件标识', () => {
  const event = normalizeWebhook({
    headers: { 'x-github-event': 'push', 'x-github-delivery': 'delivery-1' },
    body: JSON.stringify({ ref: 'refs/heads/main' }),
  });
  assert.equal(event.source, 'github');
  assert.equal(event.eventId, 'delivery-1');
  assert.equal(typeof event.receivedAt, 'number');
});

test('缺少投递头时按请求体摘要生成事件标识', () => {
  const event = normalizeWebhook({ headers: {}, body: JSON.stringify({ hello: 'world' }) });
  assert.equal(event.source, 'generic');
  assert.match(event.eventId, /^[0-9a-f]{32}$/);
});

test('非 JSON 对象就地抛错', () => {
  assert.throws(() => normalizeWebhook({ headers: {}, body: 'not-json' }), (error) => error instanceof WebhookInvalidError);
  assert.throws(() => normalizeWebhook({ headers: {}, body: '[]' }), (error) => error instanceof WebhookInvalidError);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test forge-bridge/test/normalize.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写实现**

`runtime/packages/core/contracts/src/automation.ts` 只放类型与常量 `AUTOMATION_EVENT_SOURCES = ['github', 'generic'] as const`，`index.ts` 追加 `export * from './automation.ts';`。

`forge-bridge/src/index.ts` 用 `node:crypto` 的 `createHash` 生成摘要，先 `JSON.parse` 再检查 `typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)`。`receivedAt` 取 `Date.now()`。包清单与 `hindsight-adapter` 同构，依赖只有 `@chatdsh/core-contracts`。

- [ ] **Step 4: 验证并提交**

Run: `cd forge-bridge && node /root/.cache/node/corepack/v1/pnpm/10.33.0/bin/pnpm.cjs build && node --test 'test/*.test.mjs'`，再 `cd runtime && pnpm build`。
Expected: 退出码 0。

```bash
git add runtime/packages/core/contracts forge-bridge runtime/docs/architecture.md
git commit -m "✨ feat(automation): 增加自动化契约与 forge 桥 / add automation contracts and forge bridge"
```

### Task 7: 网关 webhook 路由与容器编排

**Files:**
- Create: `runtime/gateway/src/automation.ts`
- Modify: `runtime/gateway/src/store.ts`（`GatewayStore` 构造函数里建表）
- Modify: `runtime/gateway/src/server.ts:45-60`（路由分类）与请求处理分支
- Modify: `runtime/gateway/package.json`（遥测声明与依赖）
- Create: `runtime/e2e/unit/automation-webhook.test.mjs`
- Modify: `runtime/docs/telemetry.md` 6.1 节
- Create: `dev/docker/compose.automation.yaml`

**Interfaces:**
- Consumes: `normalizeWebhook`（`@chatdsh/forge-bridge`）、`GatewayStore`、`ChatdshTelemetry`。
- Produces:
  - 路由 `POST /chatdsh/gateway/webhook/{automationId}`：先按 `AutomationStore.get(id)` 查记录（不存在 404 `automation-not-found`），再比对请求头 `x-chatdsh-webhook-secret` 与 `process.env[record.trigger.secretEnv]`（不等 401 `webhook-unauthorized`），重复 `eventId` 返回 202 `{ duplicate: true }`，否则写入 `automation_events` 并返回 202 `{ accepted: true }`。
  - `AutomationStore`：`create(record)`、`get(id)`、`list(accountId)`、`recordEvent(event)`、`hasEvent(automationId, eventId)`。
  - 表：`automations(id text primary key, account_id text not null, name text not null, trigger text not null, action text not null, enabled integer not null, created_at integer not null)`、`automation_events(automation_id text not null, event_id text not null, received_at integer not null, source text not null, primary key (automation_id, event_id))`。
  - 遥测：span `chatdsh.gateway.webhook`，属性 `automation.id`、`outcome`；event `chatdsh.gateway.webhook.rejected`，属性 `reason`、`error.code`；metric `chatdsh_webhook_receipts_total`，属性 `outcome`。

- [ ] **Step 1: 写失败的测试**

```js
// runtime/e2e/unit/automation-webhook.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AutomationStore } from '../../gateway/lib/automation.js';

test('store 建表后可写入并查到自动化记录', () => {
  const store = new AutomationStore(new DatabaseSync(':memory:'));
  store.create({ id: 'a1', accountId: 'acct', name: '构建通知', trigger: { kind: 'webhook', secretEnv: 'HOOK_SECRET' }, action: { kind: 'start-session', prompt: '总结这次构建' }, enabled: true, createdAt: 1 });
  assert.equal(store.get('a1').name, '构建通知');
  assert.deepEqual(store.list('acct').map((record) => record.id), ['a1']);
});

test('同一 eventId 只记录一次', () => {
  const store = new AutomationStore(new DatabaseSync(':memory:'));
  store.create({ id: 'a1', accountId: 'acct', name: '构建通知', trigger: { kind: 'webhook', secretEnv: 'HOOK_SECRET' }, action: { kind: 'start-session', prompt: '总结这次构建' }, enabled: true, createdAt: 1 });
  assert.equal(store.recordEvent({ automationId: 'a1', eventId: 'e1', receivedAt: 1, source: 'github' }), true);
  assert.equal(store.recordEvent({ automationId: 'a1', eventId: 'e1', receivedAt: 2, source: 'github' }), false);
  assert.equal(store.hasEvent('a1', 'e1'), true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd runtime && node --test e2e/unit/automation-webhook.test.mjs`
Expected: FAIL，`gateway/lib/automation.js` 不存在。

- [ ] **Step 3: 写实现**

`gateway/src/automation.ts` 导出 `AutomationStore`、`AutomationRecord`、`AutomationEvent`（类型从 `@chatdsh/core-contracts` 取）；`recordEvent` 用 `INSERT OR IGNORE` 后比较 `changes` 判断是否首次；`trigger`、`action` 以 JSON 文本存储，读取时 `JSON.parse`。`gateway/src/server.ts` 的 `routeOf` 增加 `if (path.startsWith('/chatdsh/gateway/webhook/')) return 'webhook'`，并在请求处理里按上述顺序校验后返回；`telemetry.runSpan('chatdsh.gateway.webhook', …)` 包住整段，拒绝分支补 `event('chatdsh.gateway.webhook.rejected', { reason, 'error.code' })` 与计数器。

`gateway/package.json` 增加依赖 `@chatdsh/forge-bridge: "workspace:*"`，遥测声明追加 span、event、metric 三个名字；`docs/telemetry.md` 6.1 节逐行登记。

`dev/docker/compose.automation.yaml` 定义 `automation-runner` 服务：复用 `dev/docker/Dockerfile`，`command` 指向一个长驻的 `node runtime/gateway/lib/main.js` 与 `depends_on: dsh-runtime condition: service_healthy`，端口映射 `13171:3171`，环境变量只列名称（`CHATDSH_GATEWAY_TOKEN`、`CHATDSH_WEBHOOK_SECRET`），值由 `dev/.env` 提供；`volumes` 挂接 `../.run/automation:/data`。

- [ ] **Step 4: 验证**

Run: `cd runtime && pnpm build && node --test e2e/unit/automation-webhook.test.mjs && pnpm check:telemetry && pnpm check:plugins`
Expected: 全部退出码 0。

- [ ] **Step 5: 提交**

```bash
git add runtime/gateway runtime/e2e/unit/automation-webhook.test.mjs runtime/docs/telemetry.md dev/docker/compose.automation.yaml
git commit -m "✨ feat(gateway): 增加 webhook 自动化路由 / add webhook automation routes"
```

### Task 8: `client/automation` 面板

**Files:**
- Create: `runtime/packages/client/automation/{package.json,tsconfig.json,src/index.ts,src/client/index.tsx}`
- Create: `runtime/e2e/unit/automation-panel.test.mjs`
- Modify: `runtime/tsconfig.build.json`、三个 profile、`runtime/docs/architecture.md` 4.6 节

**Interfaces:**
- Consumes: Remote `chatdshGatewayAutomation`（由控制平面暴露的列表与启停方法；Task 7 的 `AutomationStore.list` 通过网关 `/chatdsh/gateway/automations` 返回）。
- Produces:
  - `formatAutomationSummary(records: readonly AutomationRecord[]): string`，无记录时返回 `'还没有自动化'`，否则 `` `${records.filter((r) => r.enabled).length}/${records.length} 个自动化已启用` ``。
  - 设置页区段 id `chatdsh-automation`，order 48。
  - 遥测：event `chatdsh.client.ui.action`（沿用 6.5 节，属性 `action`、`outcome`），action 取 `automation-toggle`。

- [ ] **Step 1: 写失败的测试**

```js
// runtime/e2e/unit/automation-panel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAutomationSummary } from '../../packages/client/automation/lib/index.js';

test('空列表给出一句话', () => {
  assert.equal(formatAutomationSummary([]), '还没有自动化');
});

test('按启用数统计', () => {
  assert.equal(formatAutomationSummary([
    { id: 'a1', enabled: true },
    { id: 'a2', enabled: false },
  ]), '1/2 个自动化已启用');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test runtime/e2e/unit/automation-panel.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写实现**

`src/index.ts` 导出 `formatAutomationSummary` 与宿主侧空 `apply()`；`src/client/index.tsx` 仿 `client-assistants`，从 `ctx.remote.chatdshGatewayAutomation.list()` 读记录，每行一个启停按钮，点击调 `toggle(id, next)` 并补 `event('chatdsh.client.ui.action', { action: 'automation-toggle', outcome })` 到浏览器侧遥测队列（复用 `client-telemetry` 的 `RELAY_PATH`，失败不打断界面）。

- [ ] **Step 4: 验证并提交**

Run: `cd runtime && pnpm build && pnpm build:client && node --test e2e/unit/automation-panel.test.mjs && pnpm check:plugins && pnpm check:layering`
Expected: 全部退出码 0。

```bash
git add runtime/packages/client/automation runtime/e2e/unit/automation-panel.test.mjs runtime/tsconfig.build.json runtime/profiles runtime/docs/architecture.md
git commit -m "✨ feat(automation): 增加自动化面板 / add automation panel"
```

---

## 第四部分：上游表面与升级工具

### Task 9: `check-upstream-surface.mjs`

**Files:**
- Create: `runtime/scripts/check-upstream-surface.mjs`
- Modify: `runtime/package.json`（新增 `check:surface`）
- Create: `runtime/docs/compatibility.md`

**Interfaces:**
- Consumes: `dsh-adapter/lib/upstream.js` 的 `UPSTREAM_PACKAGE_NAMES`、`UPSTREAM_ROWS`、`UPSTREAM_TOOL_ROWS`、`UPSTREAM_AGENT_ROWS`、`UPSTREAM_BUNDLES`；DSH 安装目录（`DSH_BIN` 同目录的 `node_modules/@deepseek-ai`）。
- Produces:
  - 退出码 0 表示：登记表中的每个包在 DSH 安装里存在；补丁层里每个 `id:` 与 `name:` 成对出现且 `name` 属于登记表；`runtime/docs/upstream-capabilities.md` 的每一行都能在补丁层或登记表里找到来源。
  - 失败时逐行打印 `路径: 说明`，退出码 1。

- [ ] **Step 1: 写失败的脚本骨架**

脚本先只做第一项检查（包存在性），运行后应因为缺少 `UPSTREAM_PACKAGE_NAMES` 导出而失败，证明脚本真的在读适配层。

- [ ] **Step 2: 运行确认失败**

Run: `cd runtime && node scripts/check-upstream-surface.mjs`
Expected: exit 1，提示缺少 `UPSTREAM_PACKAGE_NAMES`

- [ ] **Step 3: 写实现**

用 `readdirSync` 扫 DSH 的 `node_modules/@deepseek-ai`，得到实装包集合；读适配层 `lib/upstream.js` 的导出；三处比对按 Interfaces 里列的三项。补丁层扫描范围与 `check-upstream-names.mjs` 相同（`packages/**/cordis.patch.yml`、`profiles/**/cordis.patch.yml`、`e2e/profiles/**/cordis.patch.yml`）。能力清单解析沿用 `check-capabilities.mjs` 的表格正则。输出固定三行统计：`实装包 N 个，登记 M 个`、`补丁行 K 个`、`能力清单 R 行`。

- [ ] **Step 4: 写 `docs/compatibility.md`**

文档分三节：兼容矩阵（DSH 版本、已验证的 dsh-tui 版本、四个 profile 的通过状态）、登记表职责（哪些名字归适配层管、改了要跑哪个脚本）、升级步骤（先改适配层，再跑 `check:upstream-names`、`check:surface`、`check:composition`，最后回归 `pnpm test` 与 `verify-*` 脚本）。内容取自 `docs/architecture.md` 第 4.1.1 节与 `docs/acceptance.md` 第十九项，不重复展开证据。

- [ ] **Step 5: 验证并提交**

Run: `cd runtime && node scripts/check-upstream-surface.mjs && pnpm check:upstream-names && pnpm check:capabilities`
Expected: 三条退出码 0，打印三行统计。

```bash
git add runtime/scripts/check-upstream-surface.mjs runtime/package.json runtime/docs/compatibility.md
git commit -m "✨ feat(upstream): 增加上游表面检查与兼容文档 / add upstream surface check and compatibility doc"
```

### Task 10: `upgrade-dsh.mjs`

**Files:**
- Create: `runtime/scripts/upgrade-dsh.mjs`
- Modify: `runtime/package.json`（新增 `upgrade:dsh`）
- Modify: `runtime/docs/compatibility.md`（升级步骤指向脚本）

**Interfaces:**
- Consumes: `DSH_BIN`（缺省 `dsh`）、`--dry-run` 参数。
- Produces:
  - `--dry-run`：只打印计划，不写文件，退出码 0。
  - 实际执行时按顺序做五步：读当前 `dsh --version`；改 `dsh-adapter/package.json` 的 `engines.dsh` 与 7 个精确版本 peer；改 `dsh-adapter/src/upstream.ts` 的 `UPSTREAM_BUNDLES`（若改名）；运行 `dsh-adapter` 的 `npm run build`；运行 `runtime` 的 `pnpm build` 与 `pnpm check:upstream-names`。任一步失败即停并打印已完成的步骤。
  - 版本号来源：`--to <version>` 参数，缺省取 `dsh --version` 的输出。

- [ ] **Step 1: 写失败的验证用例**

Run: `cd runtime && node scripts/upgrade-dsh.mjs --dry-run`
Expected: FAIL，脚本不存在。

- [ ] **Step 2: 写实现**

用 `readFileSync`/`writeFileSync` 改两个文件，改动用正则定位到行并替换版本字面量，改前读原值，改后 `JSON.parse` 校验 `package.json`。`spawnSync` 依次跑子命令，`stdio: 'inherit'`。`--to` 缺省时用 `execFileSync(dshBin, ['--version'])` 的输出去掉换行。打印的每一步前面带 `[n/5]`。

- [ ] **Step 3: 验证**

Run: `cd runtime && node scripts/upgrade-dsh.mjs --dry-run`
Expected: 打印五步计划与当前版本 `0.2.1-rc.2`，退出码 0，`git status` 无改动。

- [ ] **Step 4: 提交**

```bash
git add runtime/scripts/upgrade-dsh.mjs runtime/package.json runtime/docs/compatibility.md
git commit -m "✨ feat(upstream): 增加 DSH 升级脚本 / add DSH upgrade script"
```

---

## 第五部分：收尾

### Task 11: 全量与真实运行验证

**Files:**
- Modify: `runtime/docs/acceptance.md`（各项状态与结果）
- Modify: `runtime/docs/next-steps.md`（分布数字与剩余观察点）
- Modify: `runtime/docs/architecture.md`（目标结构表去掉「尚未创建」）

- [ ] **Step 1: 跑全量静态与构建验证**

Run: `cd runtime && pnpm build && pnpm build:client && pnpm test && pnpm check:telemetry && pnpm check:plugins && pnpm check:upstream-names && pnpm check:profiles && pnpm check:layering && pnpm check:capabilities && pnpm check:surface`
Expected: 全部退出码 0。

- [ ] **Step 2: 跑组合与真实运行验证**

Run: `cd runtime && node scripts/check-composition.mjs`；再依次运行 `verify-telemetry-sync.mjs`、`verify-memory.mjs`、`verify-client-asset.mjs --profile chatdsh-web --package @chatdsh/client-projects`。
Expected: 四项退出码 0。

- [ ] **Step 3: 按证据更新验收文档**

`acceptance.md` 的组合成立性、插件契约、上游契约一致性三节按 Step 1 与 Step 2 的输出更新数字与结果；`next-steps.md` 的顶部分布重新统计；`architecture.md:253` 改为已创建。

- [ ] **Step 4: 提交**

```bash
git add runtime/docs
git commit -m "📝 docs: 更新验收状态与目标结构 / update acceptance status and target structure"
```

## 执行顺序与并行许可

- Task 1 与 Task 2 可以并行，二者互不引用。
- Task 3、Task 4、Task 5 可以并行，前提是先完成 Task 1 与 Task 2。
- Task 6 与 Task 7 有先后依赖：Task 7 使用 Task 6 的 `normalizeWebhook`。
- Task 8 依赖 Task 7 的路由。
- Task 9 与 Task 10 可以并行，且与其它任务互不冲突。
- Task 11 必须最后执行。
