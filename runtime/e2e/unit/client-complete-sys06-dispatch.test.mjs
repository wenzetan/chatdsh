// SYS06 的发送时分支验收。
//
// 真实 HTTP 与真实 SSE：Hermes 契约服务监听真实端口，受理、幂等重放、状态查询与事件流都由
// 它应答。检查四件事：每次发送按当时配置选择；活动回合沿用发出时固定的选择；受理前明确
// 不可达时同一会话交给 DSH 并记录完整历史桥需求；受理状态不确定时只查询原运行，绝不向
// DSH 重放。
//
// 运行：node --test e2e/unit/client-complete-sys06-dispatch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import {
  delay,
  flattenLogs,
  flattenMetrics,
  flattenTraces,
  startCollector,
  startHermesServer,
  telemetryClientFor,
} from './client-complete-sys06-support.mjs';

const { BackendSettingsStore } = await import('../../gateway/lib/backends/settings.js');
const { BackendRouter } = await import('../../gateway/lib/backends/router.js');
const { createHermesHistoryRunBridge, historyDigestOf } = await import('../../../hermes-adapter/lib/index.js');

const SYSTEM = '你是 ChatDSH 的聊天助手。';

/** 组织一份完整历史。 */
function historyOf(operationId, messages) {
  return { operationId, messages, system: SYSTEM, historyDigest: historyDigestOf(SYSTEM, messages) };
}

test('发送时选择、活动回合固定、不可达降级与不确定只查询', async () => {
  const collector = await startCollector();
  const telemetry = telemetryClientFor(collector, '@chatdsh/gateway');
  const home = tempHome('sys06-dispatch');
  const store = new BackendSettingsStore({ dataRoot: home, telemetry, hermesConfigured: () => true });
  const dshCalls = [];
  const dsh = {
    async dispatch(request) {
      dshCalls.push(request);
      return { accepted: true };
    },
  };

  const servers = [];
  const openServer = async (options) => {
    const server = await startHermesServer(options);
    servers.push(server);
    return server;
  };
  const hermes = await openServer();
  const bridge = createHermesHistoryRunBridge({
    baseUrl: hermes.url,
    requestTimeoutMs: 400,
    approvalTimeoutMs: 2000,
    stopConfirmMs: 500,
    stopPollMs: 50,
  });
  const router = new BackendRouter({
    settings: { current: () => store.current() },
    telemetry,
    dsh,
    hermes: bridge,
  });

  try {
    // 一、聊天由 DSH 承载：不触碰 Hermes。
    await store.save({ revision: 0, chatBackend: 'dsh', memoryBackend: 'none' });
    const first = await router.dispatch({ sessionId: 's1', turn: 1, text: '交给 DSH' });
    assert.equal(first.chatBackend, 'dsh');
    assert.equal(first.memoryBackend, 'none');
    assert.equal(first.executionSource, 'dsh');
    assert.equal(first.outcome, 'dsh');
    assert.equal(first.revision, 1);
    assert.equal(first.historyBridgeRequired, false);
    assert.equal(dshCalls.length, 1);
    assert.equal(hermes.requests.length, 0, 'DSH 承载时不做 Hermes 探活');

    // 二、配置热切换到 Hermes：活动回合不被改变。
    await store.save({ revision: 1, chatBackend: 'hermes', memoryBackend: 'hindsight' });
    const pinned = await router.dispatch({ sessionId: 's1', turn: 1, text: '活动回合的第二次发送' });
    assert.equal(pinned.pinned, true);
    assert.equal(pinned.outcome, 'dsh');
    assert.equal(pinned.revision, 1, '活动回合沿用发出时的修订号');
    assert.equal(pinned.executionSource, 'dsh');
    assert.equal(dshCalls.length, 1, '活动回合不会重新分派');
    assert.equal(hermes.requests.length, 0, '活动回合不会触发新的探活');

    // 三、新回合采用新配置，并把完整历史送达 Hermes。
    assert.equal(router.endTurn('s1', 1), true);
    const messages = [
      { role: 'user', text: '第一轮' },
      { role: 'assistant', text: '第一轮的回答' },
      { role: 'user', text: '第二轮' },
    ];
    const second = await router.dispatch({
      sessionId: 's1',
      turn: 2,
      text: '第二轮',
      history: historyOf('op-s1-2', messages),
    });
    assert.equal(second.outcome, 'hermes-accepted');
    assert.equal(second.executionSource, 'hermes');
    assert.equal(second.revision, 2);
    assert.equal(second.historyMode, 'full');
    assert.equal(second.historyBridgeRequired, true);
    assert.equal(second.memoryEnabled, true);
    assert.equal(typeof second.runId, 'string');
    assert.ok(hermes.requests.some((request) => request.method === 'POST' && request.url === '/v1/runs'));
    const admitted = hermes.state.runs.get(second.runId);
    assert.equal(admitted.body.input, '第二轮');
    assert.deepEqual(admitted.body.conversation_history, [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '第一轮的回答' },
    ]);

    // 真实 SSE：事件流按序号连续到达并以终态结束。
    const events = [];
    for await (const event of bridge.streamRun(second.runId)) events.push(event);
    assert.ok(events.some((event) => event.type === 'text.delta' && event.text === '你好'));
    assert.ok(events.some((event) => event.type === 'run.completed'));

    // 四、受理前明确不可达：同一会话交给 DSH，并记录完整历史桥需求。
    await hermes.close();
    await store.save({ revision: 2, chatBackend: 'hermes', memoryBackend: 'hermes' });
    const degraded = await router.dispatch({
      sessionId: 's2',
      turn: 1,
      text: '离线的一轮',
      history: historyOf('op-s2-1', [{ role: 'user', text: '离线的一轮' }]),
    });
    assert.equal(degraded.outcome, 'degraded-dsh');
    assert.equal(degraded.executionSource, 'dsh-fallback');
    assert.equal(degraded.reason, 'unreachable');
    assert.equal(degraded.historyMode, 'full');
    assert.equal(degraded.historyBridgeRequired, true);
    assert.equal(degraded.memoryBackend, 'hermes');
    assert.equal(degraded.memoryEnabled, false, 'Hermes 不可达时内置记忆随之不可用');
    assert.equal(degraded.probe.reachable, false);
    const fallbackCall = dshCalls.at(-1);
    assert.equal(fallbackCall.executionSource, 'dsh-fallback');
    assert.equal(fallbackCall.historyMode, 'full');
    assert.equal(fallbackCall.historyBridgeRequired, true);
    assert.equal(router.historyModeOf('s2'), 'full');

    // 五、Hermes 恢复后，同一会话的下一轮携带完整历史。
    const restarted = await openServer({ port: hermes.port });
    assert.equal(router.endTurn('s2', 1), true);
    const recovered = await router.dispatch({
      sessionId: 's2',
      turn: 2,
      text: '恢复的一轮',
      history: historyOf('op-s2-2', [
        { role: 'user', text: '离线的一轮' },
        { role: 'assistant', text: '离线一轮的 DSH 回答' },
        { role: 'user', text: '恢复的一轮' },
      ]),
    });
    assert.equal(recovered.outcome, 'hermes-accepted');
    assert.equal(recovered.historyBridgeRequired, true);
    const recoveredRun = restarted.state.runs.get(recovered.runId);
    assert.deepEqual(recoveredRun.body.conversation_history, [
      { role: 'user', content: '离线的一轮' },
      { role: 'assistant', content: '离线一轮的 DSH 回答' },
    ]);

    // 六、全部合法组合逐个热切换：活动回合沿旧值，新回合取新值。
    const combinations = [
      { chatBackend: 'dsh', memoryBackend: 'none' },
      { chatBackend: 'dsh', memoryBackend: 'hindsight' },
      { chatBackend: 'hermes', memoryBackend: 'none' },
      { chatBackend: 'hermes', memoryBackend: 'hindsight' },
      { chatBackend: 'hermes', memoryBackend: 'hermes' },
    ];
    for (const combination of combinations) {
      await store.save({ revision: store.current().revision, ...combination });
      const sessionId = `matrix-${combination.chatBackend}-${combination.memoryBackend}`;
      const history = historyOf(`op-${sessionId}`, [{ role: 'user', text: '组合验证的一轮' }]);
      const decision = await router.dispatch({
        sessionId,
        turn: 1,
        text: '组合验证的一轮',
        ...(combination.chatBackend === 'hermes' ? { history } : {}),
      });
      assert.equal(decision.chatBackend, combination.chatBackend);
      assert.equal(decision.memoryBackend, combination.memoryBackend);
      assert.equal(decision.revision, store.current().revision);
      assert.equal(decision.executionSource, combination.chatBackend === 'dsh' ? 'dsh' : 'hermes');
      assert.equal(decision.memoryEnabled, combination.memoryBackend !== 'none');

      // 活动回合里把配置改回最轻形态，再发送同一回合：选择与修订号都不变，也不新增请求。
      const requestsBefore = restarted.requests.length;
      await store.save({ revision: store.current().revision, chatBackend: 'dsh', memoryBackend: 'none' });
      const pinnedAgain = await router.dispatch({
        sessionId,
        turn: 1,
        text: '活动回合里的再次发送',
        ...(combination.chatBackend === 'hermes' ? { history } : {}),
      });
      assert.equal(pinnedAgain.pinned, true);
      assert.equal(pinnedAgain.revision, decision.revision);
      assert.equal(pinnedAgain.executionSource, decision.executionSource);
      assert.equal(pinnedAgain.outcome, decision.outcome);
      assert.equal(restarted.requests.length, requestsBefore, '活动回合不再发起受理');
      assert.equal(router.endTurn(sessionId, 1), true);
    }

    // 七、受理状态不确定：只查询原运行，绝不交给 DSH。
    await store.save({ revision: store.current().revision, chatBackend: 'hermes', memoryBackend: 'hermes' });
    const hanging = await openServer({ mode: 'hang-first' });
    const slowBridge = createHermesHistoryRunBridge({
      baseUrl: hanging.url,
      requestTimeoutMs: 300,
      approvalTimeoutMs: 1000,
    });
    const cautious = new BackendRouter({
      settings: { current: () => store.current() },
      telemetry,
      dsh,
      hermes: slowBridge,
    });
    const dshBefore = dshCalls.length;
    const uncertain = await cautious.dispatch({
      sessionId: 's3',
      turn: 1,
      text: '可能已经受理的一轮',
      history: historyOf('op-s3-1', [{ role: 'user', text: '可能已经受理的一轮' }]),
    });
    assert.equal(uncertain.outcome, 'unconfirmed');
    assert.equal(uncertain.reason, 'running');
    assert.equal(dshCalls.length, dshBefore, '受理不确定时禁止向另一执行体重放');
    assert.equal(hanging.state.runs.size, 1, '同一操作标识只产生一个运行');
    const submissions = hanging.requests.filter((request) => request.method === 'POST' && request.url === '/v1/runs');
    assert.ok(submissions.length >= 2, '查询用同一幂等键再次提交原操作');
    assert.equal(new Set(submissions.map((request) => request.key)).size, 1, '查询不生成新的操作标识');
    assert.ok(
      hanging.requests.some((request) => request.method === 'GET' && request.url === `/v1/runs/${uncertain.runId}`),
      '查询原运行状态',
    );

    // 再次发送同一回合仍然只查询。
    const again = await cautious.dispatch({ sessionId: 's3', turn: 1, text: '再次发送' });
    assert.equal(again.outcome, 'unconfirmed');
    assert.equal(dshCalls.length, dshBefore);

    // 运行到达终态之后才落定，且仍不向 DSH 重放。
    hanging.setStatus('run-1', 'completed', '完成了这一轮');
    const resolved = await cautious.resolveUnconfirmed('s3');
    assert.equal(resolved.outcome, 'hermes-accepted');
    assert.equal(resolved.runStatus, 'completed');
    assert.equal(dshCalls.length, dshBefore);

    // 八、没有周期性健康轮询：空闲一段时间后请求数不变；诊断显示最近一次发送的实际情况。
    const idleCount = hanging.requests.length;
    await delay(1200);
    assert.equal(hanging.requests.length, idleCount, '空闲时不应有任何探活请求');
    const last = cautious.record().last();
    assert.equal(last.sessionId, 's3');
    assert.equal(last.outcome, 'hermes-accepted');
    assert.equal(last.runStatus, 'completed');
    assert.equal(last.executionSource, 'hermes');

    // 九、遥测：选择、探活、降级与失败的 span、事件与计数。
    await telemetry.flush(2000);
    const traces = flattenTraces(collector.records().traces);
    const logs = flattenLogs(collector.records().logs);
    const metrics = flattenMetrics(collector.records().metrics);
    assert.ok(
      traces.some((span) => span.name === 'chatdsh.runtime.chat.dispatch' && span.attributes['chat.backend'] === 'dsh'),
      'DSH 分派 span',
    );
    assert.ok(
      traces.some((span) => span.name === 'chatdsh.runtime.chat.dispatch' && span.attributes['chat.backend'] === 'hermes'),
      'Hermes 分派 span',
    );
    assert.ok(
      traces.some((span) => span.name === 'chatdsh.dependency.probe' && span.attributes.outcome === 'ok'),
      '送达探活 span',
    );
    assert.ok(
      traces.some((span) => span.name === 'chatdsh.dependency.probe' && span.attributes.outcome === 'unreachable'),
      '不可达探活 span',
    );
    const failures = logs.filter((log) => log.name === 'chatdsh.chat.hermes.run.failed');
    assert.ok(failures.some((log) => log.attributes['error.code'] === 'unreachable'));
    assert.ok(failures.some((log) => log.attributes['error.code'] === 'acceptance-unknown'));
    assert.ok(
      logs.some((log) => log.name === 'chatdsh.memory.degraded' && log.attributes.operation === 'backend-select'),
      'Hermes 不可达时内置记忆降级事件',
    );
    const runs = metrics.filter((metric) => metric.name === 'chatdsh_chat_hermes_runs_total');
    assert.ok(runs.some((metric) => metric.attributes.outcome === 'accepted'));
    assert.ok(runs.some((metric) => metric.attributes.outcome === 'degraded-dsh'));
    assert.ok(runs.some((metric) => metric.attributes.outcome === 'unconfirmed'));
    assert.ok(
      metrics.some((metric) => metric.name === 'chatdsh_dependency_probe_failures_total' && metric.attributes.dependency === 'hermes'),
      '探活失败计数',
    );
  } finally {
    for (const server of servers) await server.close();
    await telemetry.shutdown();
    await collector.close();
  }
});
