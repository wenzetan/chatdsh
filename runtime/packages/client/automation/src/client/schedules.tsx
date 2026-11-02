/**
 * 原会话的定时任务入口与管理。
 *
 * 定时任务跟着原会话走：先选执行设备与会话，再从原会话所在的运行时读取任务。字段包含名称、
 * 提醒文本、互斥的时间方式、IANA 时区与启用状态；列表显示下次发生时间与时区。取消等于停用，
 * 删除需要二次确认。跨设备 fork 不会复制任务，设备恢复后重复任务只补最近一次，这些约束在
 * 界面上直接写明。
 * @module @chatdsh/client-automation/schedules
 */

import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  ErrorSummary,
  Field,
  List,
  Panel,
  Row,
  Skeleton,
  StatusLine,
} from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConditionForm } from './condition.tsx';
import {
  createDefaultDraft,
  daylightNotice,
  describeSpec,
  draftErrors,
  draftToSpec,
  formatInZone,
  localDateTimeOf,
  nextOccurrence,
  type DraftError,
  type ScheduleDraft,
} from './schedule.ts';
import type { Loadable } from './loadable.ts';
import type { AutomationGateway, DeviceSummary, ScheduleView, SessionsSnapshot } from './types.ts';

/** 表单错误摘要的标识。 */
export const SCHEDULE_ERROR_SUMMARY_ID = 'chdsh-automation-schedule-error-summary';

/** 面板属性。 */
export interface SchedulePanelProps {
  /** 数据入口。 */
  readonly gateway: AutomationGateway;
  /** 执行节点。 */
  readonly devices: Loadable<readonly DeviceSummary[]>;
  /** 按设备分组的会话。 */
  readonly sessions: Loadable<SessionsSnapshot>;
  /** 重新读取执行节点。 */
  readonly onDevicesReload: () => void;
  /** 重新读取会话。 */
  readonly onSessionsReload: () => void;
}

/**
 * 原会话定时任务面板。
 * @param props - 数据入口、执行节点与会话。
 * @returns 面板。
 */
export function SchedulePanel({ gateway, devices, sessions, onDevicesReload, onSessionsReload }: SchedulePanelProps) {
  const [deviceId, setDeviceId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [list, setList] = useState<Loadable<readonly ScheduleView[]>>({ status: 'loading' });
  const [editing, setEditing] = useState<ScheduleView | 'new' | undefined>(undefined);
  const [removing, setRemoving] = useState<ScheduleView | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const deviceSessions = sessions.status === 'ready'
    ? sessions.value.devices.filter((entry) => entry.deviceId === deviceId)
    : [];
  const currentDevice = devices.status === 'ready' ? devices.value.find((device) => device.id === deviceId) : undefined;

  const load = useCallback((): void => {
    if (deviceId === '' || sessionId === '') {
      setList({ status: 'ready', value: [] });
      return;
    }
    setList({ status: 'loading' });
    gateway.schedules(deviceId, sessionId).then(
      (value) => {
        setList({ status: 'ready', value });
        gateway.noteAction('schedule-reload', 'ok');
      },
      (error: unknown) => {
        setList({ status: 'failed', error });
        gateway.noteAction('schedule-reload', 'failed');
      },
    );
  }, [deviceId, sessionId, gateway]);

  useEffect(() => { load(); }, [load]);

  const toggle = (view: ScheduleView): void => {
    setNotice(undefined);
    gateway.updateSchedule({
      deviceId,
      sessionId,
      scheduleId: view.scheduleId,
      name: view.name,
      prompt: view.prompt,
      spec: view.spec,
      enabled: !view.enabled,
    }).then(
      (updated) => {
        gateway.noteAction('schedule-cancel', 'ok');
        setNotice(updated.enabled ? `已启用「${updated.name}」。` : `已停用「${updated.name}」，原会话不再按它发生提醒。`);
        load();
      },
      (error: unknown) => {
        gateway.noteAction('schedule-cancel', 'failed');
        setNotice(`启停失败：${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };

  return (
    <Panel
      title="原会话定时任务"
      subtitle="定时任务挂在原会话的运行时上：任务跟随原会话持久化，跨设备 fork 不复制任务，设备恢复后重复任务只补最近一次。"
    >
      {devices.status === 'loading' || sessions.status === 'loading' ? <Skeleton rows={2} /> : null}
      {devices.status === 'failed' ? (
        <>
          <ErrorNote>执行节点不可用：{devices.error instanceof Error ? devices.error.message : String(devices.error)}</ErrorNote>
          <Button id="chdsh-automation-schedules-devices-reload" onClick={onDevicesReload}>重新读取执行节点</Button>
        </>
      ) : null}
      {sessions.status === 'failed' ? (
        <>
          <ErrorNote>会话列表不可用：{sessions.error instanceof Error ? sessions.error.message : String(sessions.error)}</ErrorNote>
          <Button id="chdsh-automation-schedules-sessions-reload" onClick={onSessionsReload}>重新读取会话</Button>
        </>
      ) : null}

      <Field label="执行设备" help="定时任务只在原会话所在的设备上发生。">
        <select
          id="chdsh-automation-schedule-device"
          value={deviceId}
          onChange={(event) => {
            setDeviceId(event.currentTarget.value);
            setSessionId('');
            setEditing(undefined);
          }}
        >
          <option value="">请选择执行设备</option>
          {(devices.status === 'ready' ? devices.value : []).map((device) => (
            <option key={device.id} value={device.id}>
              {`${device.name}（${device.platform}${device.online ? '，在线' : '，离线'}）`}
            </option>
          ))}
        </select>
      </Field>
      {currentDevice === undefined || currentDevice.online ? null : (
        <StatusLine tone="danger" >
          {`设备「${currentDevice.name}」当前离线：任务保存在原会话里，设备恢复之后只补最近一次，不会按缺失的次数逐次补发。`}
        </StatusLine>
      )}

      <Field label="原会话" help="只有当前账号能看到的会话会出现在这里。">
        <select
          id="chdsh-automation-schedule-session"
          value={sessionId}
          onChange={(event) => {
            setSessionId(event.currentTarget.value);
            setEditing(undefined);
          }}
          disabled={deviceId === ''}
        >
          <option value="">请选择会话</option>
          {deviceSessions.flatMap((entry) => entry.sessions).map((session) => (
            <option key={session.sessionId} value={session.sessionId}>{session.title}</option>
          ))}
        </select>
      </Field>

      {deviceId === '' || sessionId === '' ? (
        <EmptyState>选定执行设备与会话之后，这里会列出该会话的定时任务。</EmptyState>
      ) : null}

      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}

      {deviceId !== '' && sessionId !== '' ? (
        <>
          {list.status === 'loading' ? <Skeleton rows={3} /> : null}
          {list.status === 'failed' ? (
            <>
              <ErrorNote>
                定时任务不可用：{list.error instanceof Error ? list.error.message : String(list.error)}
              </ErrorNote>
              <Button id="chdsh-automation-schedules-reload" onClick={load}>重新读取定时任务</Button>
            </>
          ) : null}
          {list.status === 'ready' && list.value.length === 0 ? (
            <EmptyState action={<Button id="chdsh-automation-schedule-new" tone="primary" onClick={() => setEditing('new')}>新建定时任务</Button>}>
              这条会话还没有定时任务。
            </EmptyState>
          ) : null}
          {list.status === 'ready' && list.value.length > 0 ? (
            <>
              <List>
                {list.value.map((view) => (
                  <Row
                    key={view.scheduleId}
                    dot={view.enabled ? 'ok' : 'idle'}
                    title={<span data-schedule-id={view.scheduleId}>{view.name}</span>}
                    badge={<Badge tone={view.enabled ? 'ok' : 'neutral'}>{view.enabled ? '已启用' : '已停用'}</Badge>}
                    meta={(
                      <>
                        {describeSpec(view.spec, Date.now())}
                        {` · 时区 ${view.spec.timeZone}`}
                        {view.nextRunAt === undefined ? ' · 下次发生时间由运行时计算' : ` · 下次发生 ${formatInZone(view.spec.timeZone, view.nextRunAt)}`}
                        {view.lastRunAt === undefined ? '' : ` · 上次发生 ${formatInZone(view.spec.timeZone, view.lastRunAt)}`}
                      </>
                    )}
                    actions={(
                      <>
                        <Button
                          id={`chdsh-automation-schedule-edit-${view.scheduleId}`}
                          aria-label={`编辑定时任务：${view.name}`}
                          onClick={() => setEditing(view)}
                        >
                          编辑
                        </Button>
                        <Button
                          id={`chdsh-automation-schedule-toggle-${view.scheduleId}`}
                          aria-label={`${view.enabled ? '停用' : '启用'}定时任务：${view.name}`}
                          onClick={() => toggle(view)}
                        >
                          {view.enabled ? '停用' : '启用'}
                        </Button>
                        <Button
                          id={`chdsh-automation-schedule-delete-${view.scheduleId}`}
                          tone="danger"
                          aria-label={`删除定时任务：${view.name}`}
                          onClick={() => setRemoving(view)}
                        >
                          删除
                        </Button>
                      </>
                    )}
                  />
                ))}
              </List>
              <Button id="chdsh-automation-schedule-new" onClick={() => setEditing('new')}>新建定时任务</Button>
            </>
          ) : null}
        </>
      ) : null}

      {editing === undefined ? null : (
        <ScheduleEditor
          key={editing === 'new' ? 'new' : editing.scheduleId}
          gateway={gateway}
          deviceId={deviceId}
          sessionId={sessionId}
          editing={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(view, created) => {
            setEditing(undefined);
            setNotice(created ? `已建立定时任务「${view.name}」。` : `已保存定时任务「${view.name}」。`);
            load();
          }}
        />
      )}

      {removing === undefined ? null : (
        <DeleteScheduleConfirm
          gateway={gateway}
          deviceId={deviceId}
          sessionId={sessionId}
          view={removing}
          onClose={() => setRemoving(undefined)}
          onDone={(message) => {
            setRemoving(undefined);
            setNotice(message);
            load();
          }}
        />
      )}
    </Panel>
  );
}

/** 表单错误。 */
interface FormError {
  readonly fieldId: string;
  readonly message: string;
}

/** 定时任务表单属性。 */
interface ScheduleEditorProps {
  readonly gateway: AutomationGateway;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly editing?: ScheduleView;
  readonly onClose: () => void;
  readonly onSaved: (view: ScheduleView, created: boolean) => void;
}

/**
 * 定时任务表单。
 * @param props - 数据入口、会话与被编辑的任务。
 * @returns 面板。
 */
function ScheduleEditor({ gateway, deviceId, sessionId, editing, onClose, onSaved }: ScheduleEditorProps) {
  const now = useMemo(() => Date.now(), []);
  const [name, setName] = useState(editing?.name ?? '');
  const [prompt, setPrompt] = useState(editing?.prompt ?? '');
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [draft, setDraft] = useState<ScheduleDraft>(() => {
    if (editing === undefined) return createDefaultDraft();
    const base = createDefaultDraft(editing.spec.timeZone);
    switch (editing.spec.kind) {
      case 'once':
        return { ...base, mode: 'once', localDateTime: localDateTimeOf(editing.spec.timeZone, editing.spec.at) };
      case 'interval':
        return { ...base, mode: 'repeat', repeat: 'interval', intervalSeconds: String(editing.spec.everySeconds) };
      case 'daily':
        return { ...base, mode: 'repeat', repeat: 'daily', clock: editing.spec.time };
      case 'weekly':
        return { ...base, mode: 'repeat', repeat: 'weekly', clock: editing.spec.time, weekdays: [...editing.spec.weekdays] };
      case 'cron':
        return { ...base, mode: 'repeat', repeat: 'cron', expression: editing.spec.expression };
    }
    return base;
  });
  const [errors, setErrors] = useState<readonly FormError[]>([]);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (errors.length === 0) return;
    document.getElementById(SCHEDULE_ERROR_SUMMARY_ID)?.focus();
  }, [errors]);

  const wanted = draftErrors(draft, now);
  const preview = wanted.length === 0 ? nextOccurrence(draftToSpec(draft, now), now) : undefined;
  const daylight = daylightNotice(draft, now);

  const submit = (): void => {
    if (busy) return;
    const found: FormError[] = [];
    if (name.trim() === '') found.push({ fieldId: 'chdsh-automation-schedule-name', message: '请填写定时任务名称' });
    if (prompt.trim() === '') found.push({ fieldId: 'chdsh-automation-schedule-prompt', message: '请填写提醒文本' });
    for (const error of wanted) found.push({ fieldId: error.fieldId, message: error.message });
    setErrors(found);
    if (found.length > 0) return;
    setBusy(true);
    setFailure(undefined);
    const spec = draftToSpec(draft, now);
    const call = editing === undefined
      ? gateway.createSchedule({ deviceId, sessionId, name: name.trim(), prompt: prompt.trim(), spec, enabled })
      : gateway.updateSchedule({
        deviceId,
        sessionId,
        scheduleId: editing.scheduleId,
        name: name.trim(),
        prompt: prompt.trim(),
        spec,
        enabled,
      });
    call.then(
      (view) => {
        setBusy(false);
        gateway.noteAction(editing === undefined ? 'schedule-create' : 'schedule-edit', 'ok');
        onSaved(view, editing === undefined);
      },
      (error: unknown) => {
        setBusy(false);
        gateway.noteAction(editing === undefined ? 'schedule-create' : 'schedule-edit', 'failed');
        setFailure(error instanceof Error ? error.message : String(error));
      },
    );
  };

  return (
    <Panel title={editing === undefined ? '新建定时任务' : `编辑定时任务：${editing.name}`}>
      <ErrorSummary id={SCHEDULE_ERROR_SUMMARY_ID} errors={errors.map((error) => ({ fieldId: error.fieldId, message: error.message }))} />
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}

      <Field error={errors.find((error) => error.fieldId === 'chdsh-automation-schedule-name')?.message} label="名称" required>
        <input
          type="text"
          id="chdsh-automation-schedule-name"
          value={name}
          autoComplete="off"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Field>

      <Field error={errors.find((error) => error.fieldId === 'chdsh-automation-schedule-prompt')?.message} label="提醒文本" required>
        <textarea
          id="chdsh-automation-schedule-prompt"
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />
      </Field>

      <ConditionForm draft={draft} errors={wanted as readonly DraftError[]} daylight={daylight} onChange={setDraft} />

      <p className="chdsh-field__help">
        夏令时跳过的本地时刻按跳过处理，重复的本地时刻只发生一次；设备恢复之后重复任务只补最近一次。
      </p>
      <p className="chdsh-field__help" data-schedule-preview>
        {preview === undefined ? '下次发生时间由原会话运行时按成熟解析库计算并回填。' : `按当前取值，下次发生在 ${formatInZone(draft.timeZone, preview)}。`}
      </p>

      <div className="chdsh-field">
        <label htmlFor="chdsh-automation-schedule-enabled">
          <input
            type="checkbox"
            id="chdsh-automation-schedule-enabled"
            checked={enabled}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
          保存后立即启用
        </label>
        <p className="chdsh-field__help">停用的任务保留在原会话里，运行时不再发生提醒。</p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <Button id="chdsh-automation-schedule-save" tone="primary" disabled={busy} onClick={submit}>
          {busy ? '正在保存…' : editing === undefined ? '建立定时任务' : '保存修改'}
        </Button>
        <Button id="chdsh-automation-schedule-cancel" onClick={onClose}>取消</Button>
      </div>
    </Panel>
  );
}

/** 删除定时任务的二次确认。 */
function DeleteScheduleConfirm({ gateway, deviceId, sessionId, view, onClose, onDone }: {
  readonly gateway: AutomationGateway;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly view: ScheduleView;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    gateway.removeSchedule({ deviceId, sessionId, scheduleId: view.scheduleId }).then(
      () => {
        setBusy(false);
        gateway.noteAction('schedule-delete', 'ok');
        onDone(`已删除定时任务「${view.name}」。`);
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error instanceof Error ? error.message : String(error));
        gateway.noteAction('schedule-delete', 'failed');
      },
    );
  };

  return (
    <Dialog
      open
      title="删除定时任务"
      description="删除之后这条任务不再发生提醒；原会话的记录与已有的消息都不受影响。"
      onClose={onClose}
    >
      <p>{`${view.name} · ${describeSpec(view.spec, Date.now())} · 时区 ${view.spec.timeZone}`}</p>
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <Button id="chdsh-automation-schedule-delete-cancel" onClick={onClose}>取消</Button>
        <Button id="chdsh-automation-schedule-delete-confirm" tone="danger" disabled={busy} onClick={confirm}>
          {busy ? '正在删除…' : '确认删除'}
        </Button>
      </div>
    </Dialog>
  );
}
