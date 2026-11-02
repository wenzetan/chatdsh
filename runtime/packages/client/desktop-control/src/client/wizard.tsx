/**
 * 权限向导。
 *
 * 申请之前把用途、作用范围、期限与每一项系统授权摆出来，逐项确认之后才发起系统授权请求；
 * 任一项被拒绝就结束这次申请，并给出对应平台的系统设置入口。平台不受支持时只说明缺口，
 * 不提供申请入口。
 * @module @chatdsh/client-desktop-control/wizard
 */

import { Badge, Button, Field, List, Row, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ControlCallError } from './gateway.ts';
import { DURATION_CHOICES, ERROR_LABELS, type ControlGateway, type ControlState, type ControlTelemetry, type PendingView, type SettingsEntryView } from './types.ts';
import { browserTelemetry } from './telemetry.ts';

/** 向导属性。 */
export interface PermissionWizardProps {
  /** 数据入口。 */
  readonly gateway: ControlGateway;
  /** 界面动作遥测。 */
  readonly telemetry?: ControlTelemetry;
}

/** 把异常换成一句说明。 */
function explain(error: unknown): string {
  if (error instanceof ControlCallError) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return ERROR_LABELS['control-failed'] as string;
}

/**
 * 桌面控制权限向导。
 * @param props - 数据入口与遥测。
 * @returns 向导内容。
 */
export function PermissionWizard({ gateway, telemetry = browserTelemetry }: PermissionWizardProps): ReactElement {
  const [state, setState] = useState<ControlState | undefined>(undefined);
  const [pending, setPending] = useState<PendingView | undefined>(undefined);
  const [denial, setDenial] = useState<readonly SettingsEntryView[] | undefined>(undefined);
  const [granted, setGranted] = useState<string | undefined>(undefined);
  const [checks, setChecks] = useState<Readonly<Record<string, boolean>>>({});
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const [purpose, setPurpose] = useState('由模型在当前会话里操作屏幕，完成你交代的任务。');
  const [scopeKind, setScopeKind] = useState<'region' | 'window'>('window');
  const [applicationId, setApplicationId] = useState('notepad.exe');
  const [windowId, setWindowId] = useState('main');
  const [displayId, setDisplayId] = useState('1');
  const [originX, setOriginX] = useState('0');
  const [originY, setOriginY] = useState('0');
  const [width, setWidth] = useState('1280');
  const [height, setHeight] = useState('720');
  const [minutes, setMinutes] = useState(DURATION_CHOICES[0]?.minutes ?? 5);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await gateway.state();
      setState(next);
      setPending(next.pending);
    } catch (error) {
      setFailure(explain(error));
    }
  }, [gateway]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 组装作用范围。 */
  const scopeOf = () => (scopeKind === 'region'
    ? {
      kind: 'region' as const,
      displayId,
      x: Number.parseInt(originX, 10),
      y: Number.parseInt(originY, 10),
      width: Number.parseInt(width, 10),
      height: Number.parseInt(height, 10),
    }
    : { kind: 'window' as const, applicationId, windowId });

  const begin = async (): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    setDenial(undefined);
    setGranted(undefined);
    try {
      const created = await gateway.request({ scope: scopeOf(), durationMs: minutes * 60_000, purpose });
      setPending(created);
      setChecks({});
      telemetry.action('control-request', 'ok');
    } catch (error) {
      setFailure(explain(error));
      telemetry.action('control-request', 'failed');
    } finally {
      setBusy(false);
    }
  };

  const confirmItem = async (itemId: string, confirmed: boolean): Promise<void> => {
    if (pending === undefined) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const answer = await gateway.confirm({ requestId: pending.requestId, itemId, confirmed });
      setState(answer.state);
      if (answer.result.denied === true) {
        setDenial(answer.result.settings ?? []);
        setPending(undefined);
        telemetry.action('control-deny', 'failed');
        return;
      }
      if (answer.result.granted === true) {
        setPending(undefined);
        setGranted(answer.result.lease?.leaseId);
        telemetry.action('control-grant', 'ok');
        return;
      }
      setPending(answer.result.pending ?? pending);
      telemetry.action('control-confirm', 'ok');
    } catch (error) {
      setFailure(explain(error));
      telemetry.action('control-confirm', 'failed');
    } finally {
      setBusy(false);
    }
  };

  if (state === undefined) {
    return (
      <section id="chdsh-control-wizard" className="chdsh-control-wizard" aria-label="桌面控制授权">
        <StatusLine>{failure ?? '正在读取桌面控制状态…'}</StatusLine>
      </section>
    );
  }

  const capability = state.capability;
  const available = capability.supported && capability.available;

  return (
    <section id="chdsh-control-wizard" className="chdsh-control-wizard" aria-label="桌面控制授权">
      <header>
        <h3 className="chdsh-panel__title">桌面控制授权</h3>
        <StatusLine>{capability.notice}</StatusLine>
      </header>

      <div id="chdsh-control-capability" data-supported={capability.supported === true ? 'yes' : 'no'}>
        {capability.gaps.length === 0 ? null : (
          <ul className="chdsh-control-wizard__gaps">
            {capability.gaps.map((gap) => <li key={gap.code}>{gap.detail}</li>)}
          </ul>
        )}
        <List>
          {state.requirements.map((requirement) => (
            <Row
              key={requirement.id}
              dot={state.permissions[requirement.id] === true ? 'ok' : 'warn'}
              title={requirement.label}
              badge={<Badge tone={state.permissions[requirement.id] === true ? 'ok' : 'warn'}>
                {state.permissions[requirement.id] === true ? '已授权' : '未授权'}
              </Badge>}
              meta={<span>
                {requirement.purpose}
                {requirement.note === undefined ? '' : ` ${requirement.note}`}
                {requirement.settingsPath === undefined ? '' : ` 系统设置：${requirement.settingsPath}`}
              </span>}
            />
          ))}
        </List>
      </div>

      {available ? (
        <div className="chdsh-control-wizard__fields" role="group" aria-labelledby="chdsh-control-form-title">
          <h4 id="chdsh-control-form-title">申请之前确认三件事</h4>
          <Field label="用途" required help="这一段会写进审计记录，说明模型为什么需要操作屏幕。">
            <textarea id="chdsh-control-purpose" rows={2} value={purpose} onChange={(event) => setPurpose(event.target.value)} />
          </Field>
          <div className="chdsh-control-wizard__row" role="radiogroup" aria-label="作用范围">
            <label>
              <input
                type="radio"
                name="chdsh-control-scope"
                id="chdsh-control-scope-window"
                checked={scopeKind === 'window'}
                onChange={() => setScopeKind('window')}
              />
              目标窗口
            </label>
            <label>
              <input
                type="radio"
                name="chdsh-control-scope"
                id="chdsh-control-scope-region"
                checked={scopeKind === 'region'}
                onChange={() => setScopeKind('region')}
              />
              屏幕区域
            </label>
          </div>
          {scopeKind === 'window' ? (
            <div className="chdsh-control-wizard__row">
              <Field label="应用标识" required help="例如 notepad.exe 或 com.apple.Safari。">
                <input id="chdsh-control-app" value={applicationId} onChange={(event) => setApplicationId(event.target.value)} />
              </Field>
              <Field label="窗口标识" required>
                <input id="chdsh-control-window" value={windowId} onChange={(event) => setWindowId(event.target.value)} />
              </Field>
            </div>
          ) : (
            <div className="chdsh-control-wizard__row">
              <Field label="显示器" required>
                <input id="chdsh-control-display" value={displayId} onChange={(event) => setDisplayId(event.target.value)} />
              </Field>
              <Field label="左上角横坐标" required>
                <input id="chdsh-control-x" value={originX} onChange={(event) => setOriginX(event.target.value)} />
              </Field>
              <Field label="左上角纵坐标" required>
                <input id="chdsh-control-y" value={originY} onChange={(event) => setOriginY(event.target.value)} />
              </Field>
              <Field label="宽度" required>
                <input id="chdsh-control-width" value={width} onChange={(event) => setWidth(event.target.value)} />
              </Field>
              <Field label="高度" required>
                <input id="chdsh-control-height" value={height} onChange={(event) => setHeight(event.target.value)} />
              </Field>
            </div>
          )}
          <Field label="授权期限" required help="到期自动失效，期间可以暂停或立即中断。">
            <select id="chdsh-control-duration" value={minutes} onChange={(event) => setMinutes(Number.parseInt(event.target.value, 10))}>
              {DURATION_CHOICES.map((choice) => <option key={choice.minutes} value={choice.minutes}>{choice.label}</option>)}
            </select>
          </Field>
          <StatusLine>中断方法：指示条上的「立即结束」按钮，随时可用。</StatusLine>
          <div>
            <Button id="chdsh-control-begin" tone="primary" disabled={busy} onClick={() => void begin()}>开始逐项确认</Button>
          </div>
        </div>
      ) : (
        <StatusLine tone="danger">当前环境不提供申请入口：{capability.notice}</StatusLine>
      )}

      {pending === undefined ? null : (
        <div id="chdsh-control-pending" className="chdsh-control-wizard__fields" role="group" aria-label="逐项确认" data-request-id={pending.requestId}>
          <h4>逐项确认</h4>
          <StatusLine>全部确认之后才会发起系统授权请求。</StatusLine>
          <ul className="chdsh-control-wizard__items">
            {pending.items.map((item) => (
              <li key={item.id} className="chdsh-control-wizard__item" data-item-id={item.id} data-confirmed={item.confirmed === true ? 'yes' : 'no'}>
                <input
                  type="checkbox"
                  id={`chdsh-control-check-${item.id}`}
                  checked={item.confirmed === true || checks[item.id] === true}
                  disabled={item.confirmed === true}
                  onChange={(event) => setChecks({ ...checks, [item.id]: event.target.checked })}
                />
                <div className="chdsh-control-wizard__item-text">
                  <label className="chdsh-control-wizard__item-title" htmlFor={`chdsh-control-check-${item.id}`}>
                    {item.title}
                  </label>
                  <span className="chdsh-control-wizard__item-detail">{item.detail}</span>
                </div>
                <div className="chdsh-control-bar__acts">
                  <Button
                    id={`chdsh-control-confirm-${item.id}`}
                    disabled={busy || item.confirmed === true || checks[item.id] !== true}
                    onClick={() => void confirmItem(item.id, true)}
                  >
                    {item.confirmed === true ? '已确认' : '确认这一项'}
                  </Button>
                  <Button
                    id={`chdsh-control-deny-${item.id}`}
                    tone="danger"
                    disabled={busy || item.confirmed === true}
                    onClick={() => void confirmItem(item.id, false)}
                  >
                    拒绝
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {denial === undefined ? null : (
        <div id="chdsh-control-denial" role="group" aria-label="授权被拒绝">
          <StatusLine tone="danger">这次授权被拒绝，没有留下租约。</StatusLine>
          <p>可以在系统设置里打开对应权限之后再申请：</p>
          <ul id="chdsh-control-settings" className="chdsh-control-settings">
            {denial.map((entry) => (
              <li key={entry.id}>
                {entry.label}：
                {entry.path === undefined ? <span>{entry.note ?? '这个平台没有对应的设置页面'}</span> : <code>{entry.path}</code>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {granted === undefined ? null : (
        <div id="chdsh-control-granted" role="group" aria-label="授权结果">
          <StatusLine>授权完成，租约 {granted} 生效中；指示条会一直显示目标、时长与中断按钮。</StatusLine>
        </div>
      )}

      {failure === undefined ? null : <p className="chdsh-error" role="alert">{failure}</p>}
    </section>
  );
}
