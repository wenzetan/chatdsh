/**
 * 工具调用测试：选工具、填参数、执行确认、状态、耗时、结构化结果与完整结果。
 *
 * 调用走宿主的 `callMcpTool`：启用状态与工具目录由宿主判定，停用或不在目录里的服务器会被
 * 宿主拒绝，界面先把这条原因显示出来而不再发请求。参数按 JSON 对象提交，解析失败、类型不符
 * 或没有勾选执行确认时都不会调用工具。
 * @module @chatdsh/client-connectors/mcp
 */

import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, ScrollRegion, StatusLine } from '@chatdsh/core-ui-kit';

import { callDeniedReason, describeFailure, toolServerOf } from './state.ts';
import type { ConnectorStateView, ConnectorsGateway } from './types.ts';

/** 一次调用的结果。 */
interface CallOutcome {
  readonly isError: boolean;
  readonly content: string;
  readonly elapsedMs: number;
}

/** 工具调用测试的依赖。 */
export interface ToolTestProps {
  /** 数据入口。 */
  readonly gateway: ConnectorsGateway;
  /** 当前连接器的状态视图。 */
  readonly state: ConnectorStateView;
}

/** 工具调用测试。 */
export function ToolTest({ gateway, state }: ToolTestProps) {
  const denied = callDeniedReason(state);
  const [tool, setTool] = useState<string>(state.tools[0] ?? '');
  const [argsText, setArgsText] = useState('{}');
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<CallOutcome | undefined>(undefined);

  useEffect(() => {
    if (!state.tools.includes(tool)) setTool(state.tools[0] ?? '');
  }, [state.tools, tool]);

  const reject = (message: string): void => {
    setProblem(message);
    gateway.noteAction('connector.call', 'rejected');
  };

  const run = (): void => {
    if (running) return;
    if (denied !== undefined) {
      reject(denied);
      return;
    }
    if (tool === '') {
      reject('先选择要调用的工具。');
      return;
    }
    if (!confirmed) {
      reject('先勾选执行确认：这次调用会按当前权限真实执行。');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsText);
    } catch {
      reject('参数不是合法的 JSON，工具没有被调用。');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      reject('参数必须是 JSON 对象，工具没有被调用。');
      return;
    }
    setProblem(undefined);
    setRunning(true);
    const started = performance.now();
    gateway.callMcpTool(tool, parsed as Record<string, unknown>).then(
      (result) => {
        setOutcome({ isError: result.isError, content: result.content, elapsedMs: Math.round(performance.now() - started) });
        setRunning(false);
        gateway.noteAction('connector.call', 'ok');
      },
      (error: unknown) => {
        setProblem(describeFailure(error));
        setRunning(false);
        gateway.noteAction('connector.call', 'failed');
      },
    );
  };

  const server = toolServerOf(tool) ?? state.name;
  return (
    <section aria-label="工具调用测试">
      <StatusLine tone={denied === undefined ? 'muted' : 'danger'}>
        {denied === undefined
          ? `调用权限：连接器已启用，目录里有 ${String(state.tools.length)} 个工具，可以测试。`
          : denied}
      </StatusLine>
      <Field label="工具" help={tool === '' ? '目录里还没有工具。' : `服务器 ${server}`}>
        <select id="wp13-detail-tool" value={tool} onChange={(event) => setTool(event.target.value)}>
          {state.tools.length === 0 ? <option value="">没有可调用的工具</option> : null}
          {state.tools.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </Field>
      <Field
        label="参数"
        help={'按服务器声明的 schema 以 JSON 对象提交；宿主核对参数是对象，字段约束由服务器在执行时校验。'}
      >
        <textarea
          id="wp13-detail-args"
          rows={4}
          value={argsText}
          onChange={(event) => {
            setArgsText(event.target.value);
            setProblem(undefined);
          }}
        />
      </Field>
      <Field label="执行确认" help="勾选后才会真的调用工具；调用按当前权限与审批真实执行。">
        <input
          id="wp13-detail-confirm"
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
      </Field>
      <Button
        id="wp13-detail-call"
        tone="primary"
        disabled={denied !== undefined || running || !confirmed || tool === ''}
        onClick={run}
      >
        {running ? '正在调用' : '调用工具'}
      </Button>
      {denied === undefined ? null : <StatusLine>调用入口已按上面的原因停用。</StatusLine>}
      {problem === undefined ? null : <ErrorNote>{problem}</ErrorNote>}
      {outcome === undefined
        ? null
        : (
          <>
            <StatusLine tone={outcome.isError ? 'danger' : 'muted'}>
              <span id="wp13-call-status">
                {outcome.isError ? '状态：服务器返回错误' : '状态：调用成功'}
              </span>
              {` · 耗时 ${String(outcome.elapsedMs)} 毫秒 · 内容 ${String(outcome.content.length)} 个字符`}
            </StatusLine>
            <ScrollRegion label="结构化结果">
              <pre id="wp13-call-structured">
                {JSON.stringify({ content: outcome.content, isError: outcome.isError }, null, 2)}
              </pre>
            </ScrollRegion>
            <details id="wp13-call-full">
              <summary>完整结果</summary>
              <ScrollRegion label="完整结果">
                <pre>{outcome.content === '' ? '（服务器返回了空内容）' : outcome.content}</pre>
              </ScrollRegion>
            </details>
          </>
        )}
    </section>
  );
}
