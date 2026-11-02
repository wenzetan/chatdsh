/**
 * 通知中心的界面。
 *
 * 三个分区共用一条面板：通知列表、投递设置、权限与订阅。列表支持过滤、分页、已读与业务
 * 已处理，打开通知只把业务目标交给外壳跳转；设置携带版本号保存，冲突时提示重新读取；
 * 权限与订阅分区给出浏览器权限、订阅失效与验证通知的两段结果。已读与已处理各有一枚徽标，
 * 界面不提供任何审批动作。
 * @module @chatdsh/client-notifications/panel
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  ErrorSummary,
  Field,
  Panel,
  Row,
  Skeleton,
  StatusLine,
  Tabs,
} from '@chatdsh/core-ui-kit';
import type { CenterState, NotificationCenter } from './center.ts';
import type { NotificationGateway } from './gateway.ts';
import type { NotificationTelemetry } from './telemetry.ts';
import type { SystemNotifier } from './system.ts';
import {
  DELIVERY_MODE_LABELS,
  FILTER_LABELS,
  KIND_LABELS,
  NOTIFICATION_FILTERS,
  PERMISSION_LABELS,
  PRIVACY_LABELS,
  PRIVACY_LEVELS,
  SUBSCRIPTION_LABELS,
  type DeliveryMode,
  type NavigationTarget,
  type NotificationPermissionState,
  type NotificationSettings,
  type NotificationView,
  type PrivacyLevel,
  type ProbeOutcome,
  type SettingsDraft,
  type SubscriptionView,
} from './types.ts';

/** 面板属性。 */
export interface NotificationsPanelProps {
  /** 列表状态机。 */
  readonly center: NotificationCenter;
  /** 数据入口。 */
  readonly gateway: NotificationGateway;
  /** 系统通知面。 */
  readonly notifier: SystemNotifier;
  /** 遥测面。 */
  readonly telemetry?: NotificationTelemetry;
  /** 当前聚焦的会话；聚焦静默按它判断。 */
  readonly focusedSession?: string;
  /** 打开业务页面的动作。 */
  readonly onOpenSession?: (target: NavigationTarget) => void;
}

/** 分区标识。 */
type SectionId = 'list' | 'settings' | 'delivery';

/** 把毫秒时间戳写成界面上的时刻。 */
function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 通知中心面板。
 * @param props - 状态机、数据入口、系统通知面与遥测。
 * @returns 面板。
 */
export function NotificationsPanel(props: NotificationsPanelProps) {
  const [section, setSection] = useState<SectionId>('list');
  return (
    <Panel title="通知中心" subtitle="已读与已处理分开记录，阅读通知不会改变审批决定；打开通知只跳转到对应业务页面。">
      <Tabs
        label="通知中心分区"
        selectedId={section}
        onSelect={(id) => setSection(id as SectionId)}
        items={[
          { id: 'list', label: '通知列表', content: <NotificationList {...props} /> },
          { id: 'settings', label: '投递设置', content: <NotificationSettingsForm {...props} /> },
          { id: 'delivery', label: '权限与订阅', content: <NotificationDeliveryPanel {...props} /> },
        ]}
      />
    </Panel>
  );
}

/**
 * 通知列表：过滤、分页、已读、业务已处理与打开。
 * @param props - 面板属性。
 * @returns 列表分区。
 */
function NotificationList({ center, telemetry, focusedSession, onOpenSession }: NotificationsPanelProps) {
  const [state, setState] = useState<CenterState>(center.snapshot());
  const [device, setDevice] = useState(state.deviceId);
  const [session, setSession] = useState(state.sessionId);
  const [since, setSince] = useState(state.since);
  const [until, setUntil] = useState(state.until);
  const [localNotice, setLocalNotice] = useState<string | undefined>(undefined);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => center.subscribe(setState), [center]);
  useEffect(function firstLoad() {
    void center.reload();
  }, [center]);

  const open = useCallback((item: NotificationView) => {
    const result = center.open(item.id);
    if (result.kind === 'navigate') {
      telemetry?.navigate({
        ...(result.target.deviceId === undefined ? {} : { deviceId: result.target.deviceId }),
        sessionId: result.target.sessionId,
        attempt: 1,
        outcome: 'ok',
      });
      setLocalNotice(`正在打开关联会话：${result.target.sessionId}。`);
      onOpenSession?.(result.target);
      return;
    }
    telemetry?.navigate({
      ...(item.deviceId === undefined ? {} : { deviceId: item.deviceId }),
      ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
      attempt: 1,
      outcome: 'blocked',
      error: { name: 'NavigationBlocked', code: result.kind === 'missing' ? 'notification-missing' : 'session-missing' },
    });
    setLocalNotice(result.message);
  }, [center, onOpenSession, telemetry]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-notify-open]') ?? [])];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(buttons.length - 1, index + 1)
          : Math.max(0, index - 1);
    buttons[next]?.focus();
  }, []);

  const markRead = useCallback((ids: readonly string[]): void => {
    void center.markRead(ids).then(
      (result) => telemetry?.action('notification-read', result.marked > 0 ? 'ok' : 'unchanged'),
      (error: unknown) => {
        telemetry?.action('notification-read', 'failed');
        telemetry?.failure(error);
      },
    );
  }, [center, telemetry]);

  const markHandled = useCallback((ids: readonly string[]): void => {
    void center.markHandled(ids).then(
      (result) => telemetry?.action('notification-handled', result.marked > 0 ? 'ok' : 'unchanged'),
      (error: unknown) => {
        telemetry?.action('notification-handled', 'failed');
        telemetry?.failure(error);
      },
    );
  }, [center, telemetry]);

  return (
    <div>
      <div role="group" aria-label="通知过滤" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'flex-end' }}>
        {NOTIFICATION_FILTERS.map((filter) => (
          <Button
            key={filter}
            id={`wp22-filter-${filter}`}
            aria-pressed={state.filter === filter}
            onClick={() => center.setFilter(filter)}
          >
            {FILTER_LABELS[filter]}
          </Button>
        ))}
        <Field label="设备">
          <input id="wp22-filter-device" value={device} onChange={(event) => setDevice(event.target.value)} placeholder="全部设备" />
        </Field>
        <Field label="会话">
          <input id="wp22-filter-session" value={session} onChange={(event) => setSession(event.target.value)} placeholder="全部会话" />
        </Field>
        <Field label="起始日期">
          <input id="wp22-filter-since" type="date" value={since} onChange={(event) => setSince(event.target.value)} />
        </Field>
        <Field label="结束日期">
          <input id="wp22-filter-until" type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
        </Field>
        <Button id="wp22-filter-apply" onClick={() => {
          const ok = center.applyFilters({ deviceId: device, sessionId: session, since, until });
          if (!ok) setLocalNotice('起始日期晚于结束日期，请调整时间范围。');
        }}>应用过滤</Button>
        <Button id="wp22-refresh" onClick={() => void center.reload()}>刷新</Button>
        <Button id="wp22-read-all" disabled={state.busy || state.items.length === 0} onClick={() => { void center.markAllRead().then((result) => telemetry?.action('notification-read-all', result.marked > 0 ? 'ok' : 'unchanged'), (error: unknown) => { telemetry?.action('notification-read-all', 'failed'); telemetry?.failure(error); }); }}>
          全部已读
        </Button>
      </div>
      <StatusLine>
        <span id="wp22-counts">{`未读 ${String(state.unread)} 条，已处理 ${String(state.handled)} 条，当前过滤：${FILTER_LABELS[state.filter]}`}</span>
      </StatusLine>
      {state.notice === undefined ? null : <StatusLine><span id="wp22-notice">{state.notice}</span></StatusLine>}
      {localNotice === undefined ? null : <StatusLine><span id="wp22-local-notice">{localNotice}</span></StatusLine>}

      {state.status === 'loading' ? <Skeleton rows={3} /> : null}
      {state.status === 'failed' ? (
        <div>
          <ErrorNote><span id="wp22-failure">{state.failure}</span></ErrorNote>
          <Button id="wp22-reload" onClick={() => void center.reload()}>重新加载</Button>
        </div>
      ) : null}
      {state.status === 'ready' && state.items.length === 0 ? (
        <EmptyState action={<Button id="wp22-empty-refresh" onClick={() => void center.reload()}>刷新</Button>}>
          当前过滤条件下没有通知。
        </EmptyState>
      ) : null}

      {state.items.length === 0 ? null : (
        <ul id="wp22-list" ref={list} className="chdsh-list" aria-label="通知列表" onKeyDown={onKeyDown}>
            {state.items.map((item) => (
              <Row
                key={item.id}
                dot={item.readAt === undefined ? 'warn' : 'ok'}
                title={(
                  <>
                    <button
                      type="button"
                      id={`wp22-open-${item.id}`}
                      data-notify-open={item.id}
                      className="chdsh-btn"
                      aria-label={`打开通知：${item.title}`}
                      onClick={() => open(item)}
                    >
                      {item.title}
                    </button>
                    <Badge tone={item.readAt === undefined ? 'warn' : 'neutral'}>{item.readAt === undefined ? '未读' : '已读'}</Badge>
                    <Badge tone={item.handledAt === undefined ? 'neutral' : 'ok'}>{item.handledAt === undefined ? '未处理' : '已处理'}</Badge>
                  </>
                )}
                meta={`${KIND_LABELS[item.kind]} · ${item.deviceId ?? '未关联设备'} · ${formatTime(item.createdAt)}${item.sessionId === undefined ? '' : ` · 会话 ${item.sessionId}`}`}
                actions={(
                  <>
                    <Button
                      id={`wp22-read-${item.id}`}
                      aria-label={`标记已读：${item.title}`}
                      disabled={state.busy}
                      onClick={() => markRead([item.id])}
                    >
                      标记已读
                    </Button>
                    <Button
                      id={`wp22-handled-${item.id}`}
                      aria-label={`标记已处理：${item.title}`}
                      disabled={state.busy}
                      onClick={() => markHandled([item.id])}
                    >
                      标记已处理
                    </Button>
                  </>
                )}
              />
            ))}
        </ul>
      )}

      {state.nextCursor === undefined ? null : (
        <Button id="wp22-load-more" disabled={state.loadingMore} onClick={() => { void center.loadMore(); }}>
          {state.loadingMore ? '正在读取后续页' : '读取更多'}
        </Button>
      )}
      <StatusLine>{focusedSession === undefined ? '当前没有聚焦会话。' : `当前聚焦会话：${focusedSession}`}</StatusLine>
    </div>
  );
}

/** 设置表单的字段错误。 */
interface SettingsError {
  readonly fieldId: string;
  readonly message: string;
}

/**
 * 投递设置：隐私级别、投递模式、阈值与开关。
 * @param props - 面板属性。
 * @returns 设置分区。
 */
function NotificationSettingsForm({ gateway, telemetry }: NotificationsPanelProps) {
  const [settings, setSettings] = useState<NotificationSettings | undefined>(undefined);
  const [draft, setDraft] = useState<SettingsDraft | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<readonly SettingsError[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [conflictRevision, setConflictRevision] = useState<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const adopt = useCallback((value: NotificationSettings) => {
    setSettings(value);
    setDraft({
      deliveryMode: value.deliveryMode,
      firstStageSeconds: value.firstStageSeconds,
      secondStageSeconds: value.secondStageSeconds,
      onTurnEnd: value.onTurnEnd,
      onApproval: value.onApproval,
      messagePreview: value.messagePreview,
      quietWhenFocused: value.quietWhenFocused,
      privacy: value.privacy,
    });
    setErrors([]);
    setConflictRevision(undefined);
  }, []);

  const load = useCallback(() => {
    setFailure(undefined);
    setNotice(undefined);
    void gateway.readSettings().then(
      (value) => adopt(value),
      (error: unknown) => setFailure(`读取通知设置失败：${error instanceof Error ? error.message : String(error)}。`),
    );
  }, [adopt, gateway]);

  useEffect(function loadOnce() {
    load();
  }, [load]);

  /* 焦点落到冲突之后的重新读取入口与校验失败的错误摘要：两者都由状态驱动， */
  /* 在提交之后触发，避免渲染还没完成就调用聚焦。 */
  const conflictHost = useRef<HTMLDivElement>(null);
  const summaryHost = useRef<HTMLDivElement>(null);

  useEffect(function focusOnConflict() {
    if (conflictRevision === undefined) return;
    conflictHost.current?.querySelector<HTMLButtonElement>('#wp22-settings-reload')?.focus();
  }, [conflictRevision]);

  useEffect(function focusOnErrors() {
    if (errors.length === 0) return;
    summaryHost.current?.querySelector<HTMLElement>('#wp22-settings-errors')?.focus();
  }, [errors]);

  if (failure !== undefined) {
    return (
      <div>
        <ErrorNote><span id="wp22-settings-failure">{failure}</span></ErrorNote>
        <Button id="wp22-settings-load" onClick={load}>重新读取</Button>
      </div>
    );
  }
  if (settings === undefined || draft === undefined) return <Skeleton rows={3} />;

  const patch = (partial: Partial<SettingsDraft>): void => setDraft({ ...draft, ...partial });

  const validate = (): readonly SettingsError[] => {
    const found: SettingsError[] = [];
    if (!Number.isInteger(draft.firstStageSeconds) || draft.firstStageSeconds < 0 || draft.firstStageSeconds > 300) {
      found.push({ fieldId: 'wp22-settings-first', message: '第一阶段等待取 0 到 300 秒的整数。' });
    }
    if (!Number.isInteger(draft.secondStageSeconds) || draft.secondStageSeconds < 1 || draft.secondStageSeconds > 3600) {
      found.push({ fieldId: 'wp22-settings-second', message: '第二阶段等待取 1 到 3600 秒的整数。' });
    }
    if (draft.deliveryMode === 'two-stage' && draft.secondStageSeconds <= draft.firstStageSeconds) {
      found.push({ fieldId: 'wp22-settings-second', message: '第二阶段等待必须大于第一阶段等待。' });
    }
    return found;
  };

  const save = async (): Promise<void> => {
    const found = validate();
    setErrors(found);
    if (found.length > 0) {
      telemetry?.action('notification-settings-save', 'failed');
      return;
    }
    setSaving(true);
    setNotice(undefined);
    try {
      const result = await gateway.saveSettings(draft, settings.revision);
      if (result.ok) {
        adopt(result.settings);
        setNotice(`设置已保存，版本 ${String(result.settings.revision)}。`);
        telemetry?.action('notification-settings-save', 'ok');
      } else {
        setConflictRevision(result.current.revision);
        setNotice(undefined);
        telemetry?.action('notification-settings-save', 'conflict');
      }
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}。`);
      telemetry?.action('notification-settings-save', 'failed');
      telemetry?.failure(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <StatusLine><span id="wp22-settings-revision">{`当前版本 ${String(settings.revision)}，最近写入 ${formatTime(settings.updatedAt)}`}</span></StatusLine>
      {notice === undefined ? null : <StatusLine><span id="wp22-settings-saved">{notice}</span></StatusLine>}
      {conflictRevision === undefined ? null : (
        <div ref={conflictHost}>
          <ErrorNote>
            <span id="wp22-settings-conflict">{`设置已被其他客户端修改，服务端版本为 ${String(conflictRevision)}；请重新读取后再保存。`}</span>
          </ErrorNote>
          <Button id="wp22-settings-reload" onClick={load}>重新读取设置</Button>
        </div>
      )}
      <div ref={summaryHost}>
        <ErrorSummary id="wp22-settings-errors" errors={errors} />
      </div>

      <Field label="系统通知内容" help="默认只显示产品与事件类型；摘要与消息原文按级别出现。">
        <select id="wp22-settings-privacy" value={draft.privacy} onChange={(event) => patch({ privacy: event.target.value as PrivacyLevel })}>
          {PRIVACY_LEVELS.map((level) => (
            <option key={level} value={level}>{`${PRIVACY_LABELS[level]}（${level}）`}</option>
          ))}
        </select>
      </Field>

      <fieldset>
        <legend>投递模式</legend>
        <label htmlFor="wp22-settings-mode-all-at-once">
          <input
            id="wp22-settings-mode-all-at-once"
            type="radio"
            name="wp22-delivery-mode"
            checked={draft.deliveryMode === 'all-at-once'}
            onChange={() => patch({ deliveryMode: 'all-at-once' as DeliveryMode })}
          />
          {DELIVERY_MODE_LABELS['all-at-once']}
        </label>
        <label htmlFor="wp22-settings-mode-two-stage">
          <input
            id="wp22-settings-mode-two-stage"
            type="radio"
            name="wp22-delivery-mode"
            checked={draft.deliveryMode === 'two-stage'}
            onChange={() => patch({ deliveryMode: 'two-stage' as DeliveryMode })}
          />
          {DELIVERY_MODE_LABELS['two-stage']}
        </label>
      </fieldset>

      <Field label="第一阶段等待（秒）" error={errors.find((item) => item.fieldId === 'wp22-settings-first')?.message}>
        <input
          id="wp22-settings-first"
          type="number"
          min={0}
          max={300}
          value={draft.firstStageSeconds}
          onChange={(event) => patch({ firstStageSeconds: Number.parseInt(event.target.value, 10) })}
        />
      </Field>
      <Field label="第二阶段等待（秒）" error={errors.find((item) => item.fieldId === 'wp22-settings-second')?.message}>
        <input
          id="wp22-settings-second"
          type="number"
          min={1}
          max={3600}
          value={draft.secondStageSeconds}
          onChange={(event) => patch({ secondStageSeconds: Number.parseInt(event.target.value, 10) })}
        />
      </Field>

      <div>
        <label htmlFor="wp22-settings-turn-end">
          <input id="wp22-settings-turn-end" type="checkbox" checked={draft.onTurnEnd} onChange={(event) => patch({ onTurnEnd: event.target.checked })} />
          回合结束时通知
        </label>
        <label htmlFor="wp22-settings-approval">
          <input id="wp22-settings-approval" type="checkbox" checked={draft.onApproval} onChange={(event) => patch({ onApproval: event.target.checked })} />
          审批提出时通知
        </label>
        <label htmlFor="wp22-settings-preview">
          <input id="wp22-settings-preview" type="checkbox" checked={draft.messagePreview} onChange={(event) => patch({ messagePreview: event.target.checked })} />
          系统通知展示消息预览
        </label>
        <label htmlFor="wp22-settings-quiet">
          <input id="wp22-settings-quiet" type="checkbox" checked={draft.quietWhenFocused} onChange={(event) => patch({ quietWhenFocused: event.target.checked })} />
          当前会话聚焦时静默
        </label>
      </div>

      <Button id="wp22-settings-save" disabled={saving} onClick={() => { void save(); }}>
        {saving ? '正在保存设置' : '保存设置'}
      </Button>
    </div>
  );
}

/**
 * 权限与订阅：浏览器通知权限、订阅状态与验证通知的两段结果。
 * @param props - 面板属性。
 * @returns 权限与订阅分区。
 */
function NotificationDeliveryPanel({ gateway, notifier, telemetry }: NotificationsPanelProps) {
  const [permission, setPermission] = useState<NotificationPermissionState>(notifier.permission());
  const [subscription, setSubscription] = useState<SubscriptionView | undefined>(undefined);
  const [support, setSupport] = useState<string | undefined>(undefined);
  const [probe, setProbe] = useState<ProbeOutcome | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const loadSubscription = useCallback(() => {
    void gateway.readSubscription().then(
      (value) => setSubscription(value),
      (error: unknown) => setNotice(`读取订阅状态失败：${error instanceof Error ? error.message : String(error)}。`),
    );
  }, [gateway]);

  useEffect(function loadOnce() {
    loadSubscription();
    void notifier.subscriptionSupport().then((result) => {
      setSupport(result.supported ? undefined : result.reason);
    });
  }, [loadSubscription, notifier]);

  const requestPermission = async (): Promise<void> => {
    const result = await notifier.requestPermission();
    setPermission(result);
    telemetry?.action('notification-permission-request', result === 'granted' ? 'ok' : 'failed');
  };

  const saveSubscription = async (): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const created = await notifier.subscribe();
      if (!created.ok) {
        setSupport(created.reason);
        setNotice(created.reason);
        telemetry?.action('notification-subscription-save', 'failed');
        return;
      }
      const view = await gateway.saveSubscription(created.input);
      setSubscription(view);
      setSupport(undefined);
      setNotice(`订阅已保存，状态 ${SUBSCRIPTION_LABELS[view.state]}。`);
      telemetry?.action('notification-subscription-save', 'ok');
    } catch (error) {
      setNotice(`保存订阅失败：${error instanceof Error ? error.message : String(error)}。`);
      telemetry?.action('notification-subscription-save', 'failed');
      telemetry?.failure(error);
    } finally {
      setBusy(false);
    }
  };

  const removeSubscription = async (): Promise<void> => {
    setBusy(true);
    try {
      const removed = await gateway.removeSubscription();
      setNotice(`已退订 ${String(removed.removed)} 条订阅。`);
      loadSubscription();
      telemetry?.action('notification-subscription-remove', 'ok');
    } catch (error) {
      setNotice(`退订失败：${error instanceof Error ? error.message : String(error)}。`);
      telemetry?.action('notification-subscription-remove', 'failed');
      telemetry?.failure(error);
    } finally {
      setBusy(false);
    }
  };

  const sendProbe = async (): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await gateway.sendProbe();
      setProbe(result);
      telemetry?.action('notification-probe', result.probe.result === 'failed' ? 'failed' : 'ok');
    } catch (error) {
      setProbe(undefined);
      setNotice(`验证通知发送失败：${error instanceof Error ? error.message : String(error)}。`);
      telemetry?.action('notification-probe', 'failed');
      telemetry?.failure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StatusLine>
        <span id="wp22-permission-state">{`系统通知权限：${PERMISSION_LABELS[permission]}（${permission}）`}</span>
      </StatusLine>
      <Button id="wp22-permission-request" disabled={busy} onClick={() => { void requestPermission(); }}>
        请求浏览器通知权限
      </Button>
      {permission === 'denied' ? (
        <ErrorNote>
          <span id="wp22-permission-denied">浏览器拒绝了系统通知权限。可以在浏览器的站点设置里允许通知，然后重新请求；通知中心不依赖系统通知，仍然可以查看、标记已读与打开业务页面。</span>
        </ErrorNote>
      ) : null}
      {permission === 'unsupported' ? <StatusLine><span id="wp22-permission-unsupported">当前环境没有系统通知接口，通知中心继续可用。</span></StatusLine> : null}

      <StatusLine>
        <span id="wp22-subscription-state">
          {`订阅状态：${SUBSCRIPTION_LABELS[subscription?.state ?? 'unsubscribed']}（${subscription?.state ?? 'unsubscribed'}）`}
          {subscription === undefined || subscription.code === undefined ? '' : `，失效码 ${subscription.code}`}
          {`，权限 ${PERMISSION_LABELS[subscription?.permission ?? permission]}`}
          {subscription === undefined ? '' : `，最近更新 ${formatTime(subscription.updatedAt)}`}
        </span>
      </StatusLine>
      {support === undefined ? null : <StatusLine><span id="wp22-subscription-note">{support}</span></StatusLine>}
      <div role="group" aria-label="订阅操作">
        <Button id="wp22-subscription-save" disabled={busy} onClick={() => { void saveSubscription(); }}>保存订阅</Button>
        <Button id="wp22-subscription-reload" disabled={busy} onClick={loadSubscription}>重新读取订阅</Button>
        <Button id="wp22-subscription-remove" disabled={busy} onClick={() => { void removeSubscription(); }}>退订当前设备</Button>
      </div>

      <Button id="wp22-probe-send" disabled={busy} onClick={() => { void sendProbe(); }}>发送验证通知</Button>
      <StatusLine>
        <span id="wp22-probe-accepted">
          {probe === undefined
            ? '服务已受理：尚未发送验证通知'
            : `服务已受理：${probe.probe.result === 'failed' ? `未受理（${probe.probe.code ?? '未知原因'}）` : '已受理'}${probe.probe.acceptedAt === undefined ? '' : `，受理时刻 ${formatTime(probe.probe.acceptedAt)}`}`}
        </span>
      </StatusLine>
      <StatusLine>
        <span id="wp22-probe-received">
          {probe === undefined
            ? '系统实际接收：尚未发送验证通知'
            : `系统实际接收：${probe.probe.receivedAt === undefined ? '尚未收到（接收结果由系统通知处理器回报）' : `已接收，接收时刻 ${formatTime(probe.probe.receivedAt)}`}`}
        </span>
      </StatusLine>
      {notice === undefined ? null : <StatusLine><span id="wp22-probe-notice">{notice}</span></StatusLine>}
    </div>
  );
}
