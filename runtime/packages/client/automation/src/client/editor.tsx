/**
 * 自动化的新建与编辑表单。
 *
 * 提交前在本地校验必填项、密钥环境变量名与条件表单；有错误时把焦点交给错误摘要，摘要里的
 * 每一项都能把焦点送到对应控件。目标设备必须明确，界面不把投递交回控制平面的宿主执行。
 * 目标设备离线时给出提示：保存之后投递会以明确失败结束，控制平面不建立离线重发任务。
 * @module @chatdsh/client-automation/editor
 */

import { Button, ErrorNote, Field, ErrorSummary, Panel, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { useEffect, useMemo, useState } from 'react';
import { ConditionForm } from './condition.tsx';
import {
  createDefaultDraft,
  daylightNotice,
  draftErrors,
  draftToSpec,
  localDateTimeOf,
  type ScheduleDraft,
} from './schedule.ts';
import type { Loadable } from './loadable.ts';
import type { ScheduleSpec } from './schedule.ts';
import type {
  AutomationDraftInput,
  AutomationGateway,
  AutomationRecord,
  AutomationTrigger,
  DeviceSummary,
} from './types.ts';

/** 错误摘要的标识。 */
export const ERROR_SUMMARY_ID = 'chdsh-automation-error-summary';

/** 表单错误。 */
interface FormError {
  readonly fieldId: string;
  readonly message: string;
}

/** 表单属性。 */
export interface AutomationEditorProps {
  /** 数据入口。 */
  readonly gateway: AutomationGateway;
  /** 被编辑的记录；缺省为新建。 */
  readonly editing?: AutomationRecord;
  /** 执行节点。 */
  readonly devices: Loadable<readonly DeviceSummary[]>;
  /** 保存成功后的回调。 */
  readonly onSaved: (record: AutomationRecord, created: boolean) => void;
  /** 重新读取执行节点。 */
  readonly onDevicesReload: () => void;
  /** 取消编辑。 */
  readonly onCancel: () => void;
}

/** 密钥环境变量名的写法。 */
const SECRET_ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * 生成表单初值。
 * @param editing - 被编辑的记录。
 * @returns 表单取值与条件表单取值。
 */
function initialOf(editing?: AutomationRecord): {
  readonly name: string;
  readonly triggerKind: 'webhook' | 'schedule';
  readonly secretEnv: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly deviceId: string;
  readonly cwd: string;
  readonly presetId: string;
  readonly model: string;
  readonly draft: ScheduleDraft;
} {
  const draft = createDefaultDraft(editing?.spec?.timeZone);
  const spec = editing?.spec;
  return {
    name: editing?.name ?? '',
    triggerKind: editing?.trigger.kind === 'schedule' ? 'schedule' : 'webhook',
    secretEnv: editing?.trigger.kind === 'webhook' ? editing.trigger.secretEnv : '',
    prompt: editing?.action.prompt ?? '',
    enabled: editing?.enabled ?? true,
    deviceId: editing?.target?.deviceId ?? '',
    cwd: editing?.target?.cwd ?? '',
    presetId: editing?.target?.presetId ?? '',
    model: editing?.target?.model ?? '',
    draft: spec === undefined ? draft : { ...draft, ...draftOfSpec(spec) },
  };
}

/**
 * 把一种触发方式还原成表单取值。
 * @param spec - 触发方式。
 * @returns 表单里与时间方式相关的取值。
 */
function draftOfSpec(spec: ScheduleSpec): Partial<ScheduleDraft> {
  switch (spec.kind) {
    case 'once':
      return {
        mode: 'once',
        localDateTime: localDateTimeOf(spec.timeZone, spec.at),
        timeZone: spec.timeZone,
      };
    case 'interval':
      return { mode: 'repeat', repeat: 'interval', intervalSeconds: String(spec.everySeconds), timeZone: spec.timeZone };
    case 'daily':
      return { mode: 'repeat', repeat: 'daily', clock: spec.time, timeZone: spec.timeZone };
    case 'weekly':
      return { mode: 'repeat', repeat: 'weekly', clock: spec.time, weekdays: [...spec.weekdays], timeZone: spec.timeZone };
    case 'cron':
      return { mode: 'repeat', repeat: 'cron', expression: spec.expression, timeZone: spec.timeZone };
  }
}

/**
 * 自动化表单。
 * @param props - 数据入口、记录与回调。
 * @returns 面板。
 */
export function AutomationEditor({ gateway, editing, devices, onSaved, onDevicesReload, onCancel }: AutomationEditorProps) {
  const now = useMemo(() => Date.now(), []);
  const initial = useMemo(() => initialOf(editing), [editing]);
  const [name, setName] = useState(initial.name);
  const [triggerKind, setTriggerKind] = useState<'webhook' | 'schedule'>(initial.triggerKind);
  const [secretEnv, setSecretEnv] = useState(initial.secretEnv);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [deviceId, setDeviceId] = useState(initial.deviceId);
  const [cwd, setCwd] = useState(initial.cwd);
  const [presetId, setPresetId] = useState(initial.presetId);
  const [model, setModel] = useState(initial.model);
  const [draft, setDraft] = useState<ScheduleDraft>(initial.draft);
  const [errors, setErrors] = useState<readonly FormError[]>([]);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (errors.length === 0) return;
    document.getElementById(ERROR_SUMMARY_ID)?.focus();
  }, [errors]);

  const offline = devices.status === 'ready'
    ? devices.value.find((device) => device.id === deviceId)
    : undefined;
  const daylight = triggerKind === 'schedule' ? daylightNotice(draft, now) : undefined;

  const validate = (): FormError[] => {
    const found: FormError[] = [];
    if (name.trim() === '') found.push({ fieldId: 'chdsh-automation-name', message: '请填写自动化名称' });
    if (name.trim().length > 80) found.push({ fieldId: 'chdsh-automation-name', message: '自动化名称不超过 80 个字符' });
    if (triggerKind === 'webhook' && !SECRET_ENV_PATTERN.test(secretEnv.trim())) {
      found.push({ fieldId: 'chdsh-automation-secret-env', message: '填写大写字母、数字与下划线组成的环境变量名，例如 CHATDSH_WEBHOOK_SECRET' });
    }
    if (triggerKind === 'schedule') {
      for (const error of draftErrors(draft, now)) found.push({ fieldId: error.fieldId, message: error.message });
    }
    if (deviceId === '') found.push({ fieldId: 'chdsh-automation-device', message: '请选择执行设备；投递不会转交给控制平面执行' });
    if (prompt.trim() === '') found.push({ fieldId: 'chdsh-automation-prompt', message: '请填写交给会话的提示词' });
    if (prompt.length > 4000) found.push({ fieldId: 'chdsh-automation-prompt', message: '提示词不超过 4000 个字符' });
    return found;
  };

  const submit = (): void => {
    if (busy) return;
    const found = validate();
    setErrors(found);
    if (found.length > 0) {
      setFailure(undefined);
      return;
    }
    setBusy(true);
    setFailure(undefined);
    const spec = triggerKind === 'schedule' ? draftToSpec(draft, now) : undefined;
    const trigger: AutomationTrigger = triggerKind === 'webhook'
      ? { kind: 'webhook', secretEnv: secretEnv.trim() }
      : { kind: 'schedule', cron: spec !== undefined && spec.kind === 'cron' ? spec.expression : '' };
    const input: AutomationDraftInput = {
      name: name.trim(),
      trigger,
      prompt: prompt.trim(),
      enabled,
      target: {
        ...(deviceId === '' ? {} : { deviceId }),
        ...(offline === undefined ? {} : { deviceName: offline.name }),
        ...(cwd.trim() === '' ? {} : { cwd: cwd.trim() }),
        ...(presetId.trim() === '' ? {} : { presetId: presetId.trim() }),
        ...(model.trim() === '' ? {} : { model: model.trim() }),
      },
      ...(spec === undefined ? {} : { spec }),
      ...(editing?.revision === undefined ? {} : { revision: editing.revision }),
    };
    const call = editing === undefined
      ? gateway.create(input)
      : gateway.update(editing.id, input);
    call.then(
      (record) => {
        setBusy(false);
        gateway.noteAction(editing === undefined ? 'automation-create' : 'automation-edit', 'ok');
        onSaved(record, editing === undefined);
      },
      (error: unknown) => {
        setBusy(false);
        gateway.noteAction(editing === undefined ? 'automation-create' : 'automation-edit', 'failed');
        setFailure(error instanceof Error ? error.message : String(error));
      },
    );
  };

  if (devices.status === 'loading') return <Panel title={editing === undefined ? '新建自动化' : '编辑自动化'}><Skeleton rows={3} /></Panel>;

  return (
    <Panel
      title={editing === undefined ? '新建自动化' : `编辑自动化：${editing.name}`}
      subtitle="表单只登记业务记录与执行目标；定时执行由原会话运行时负责，界面不在控制平面建立定时任务。"
    >
      <ErrorSummary id={ERROR_SUMMARY_ID} errors={errors.map((error) => ({ fieldId: error.fieldId, message: error.message }))} />
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}

      <Field label="名称" error={errors.find((error) => error.fieldId === 'chdsh-automation-name')?.message} required>
        <input
          type="text"
          id="chdsh-automation-name"
          value={name}
          autoComplete="off"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Field>

      <fieldset className="chdsh-field">
        <legend>触发条件</legend>
        <div role="radiogroup" aria-label="触发条件">
          <label htmlFor="chdsh-automation-trigger-webhook">
            <input
              type="radio"
              id="chdsh-automation-trigger-webhook"
              name="chdsh-automation-trigger"
              checked={triggerKind === 'webhook'}
              onChange={() => setTriggerKind('webhook')}
            />
            webhook 投递
          </label>
          <label htmlFor="chdsh-automation-trigger-schedule">
            <input
              type="radio"
              id="chdsh-automation-trigger-schedule"
              name="chdsh-automation-trigger"
              checked={triggerKind === 'schedule'}
              onChange={() => setTriggerKind('schedule')}
            />
            定时触发
          </label>
        </div>
      </fieldset>

      {triggerKind === 'webhook' ? (
        <>
          <Field
            label="签名密钥的环境变量名"
            help="控制器按这个名字从运行环境读取密钥，与请求头 x-chatdsh-webhook-secret 逐字比较。界面只保存变量名，密钥值不经过页面。"
            error={errors.find((error) => error.fieldId === 'chdsh-automation-secret-env')?.message}
            required
          >
            <input
              type="text"
              id="chdsh-automation-secret-env"
              value={secretEnv}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setSecretEnv(event.currentTarget.value)}
            />
          </Field>
          <StatusLine>
            密钥环境变量缺失时控制器按未配置处理并返回明确失败；签名不匹配返回 401，不建立会话。
          </StatusLine>
        </>
      ) : (
        <>
          <ConditionForm draft={draft} errors={errors.filter((error) => error.fieldId !== 'chdsh-automation-name')} daylight={daylight} onChange={setDraft} />
          <StatusLine>
            这里只保存时间方式的业务记录；执行由原会话运行时按它自己的定时能力发生，控制平面不建立第二个调度器。
          </StatusLine>
        </>
      )}

      <Field
        label="执行设备"
        help="投递建立会话时必须有一个明确的执行设备。"
        error={errors.find((error) => error.fieldId === 'chdsh-automation-device')?.message}
        required
      >
        <select id="chdsh-automation-device" value={deviceId} onChange={(event) => setDeviceId(event.currentTarget.value)}>
          <option value="">请选择执行设备</option>
          {(devices.status === 'ready' ? devices.value : []).map((device) => (
            <option key={device.id} value={device.id}>
              {`${device.name}（${device.platform}${device.online ? '，在线' : '，离线'}）`}
            </option>
          ))}
        </select>
      </Field>
      {offline === undefined ? null : offline.online ? null : (
        <StatusLine>
          目标设备「{offline.name}」当前离线：保存之后投递会以明确失败结束，控制平面不建立离线重发任务。设备恢复在线后再由调用方重新投递。
        </StatusLine>
      )}

      <Field label="目标目录" help="省略时落在目标设备的默认目录。">
        <input type="text" id="chdsh-automation-cwd" value={cwd} autoComplete="off" onChange={(event) => setCwd(event.currentTarget.value)} />
      </Field>

      <Field label="助手或 preset" help="省略时使用执行设备的默认助手。">
        <input type="text" id="chdsh-automation-preset" value={presetId} autoComplete="off" onChange={(event) => setPresetId(event.currentTarget.value)} />
      </Field>

      <Field label="模型" help="省略时使用助手配置的模型。">
        <input type="text" id="chdsh-automation-model" value={model} autoComplete="off" onChange={(event) => setModel(event.currentTarget.value)} />
      </Field>

      <Field label="提示词" help="投递命中之后交给新会话的第一段文字。" error={errors.find((error) => error.fieldId === 'chdsh-automation-prompt')?.message} required>
        <textarea id="chdsh-automation-prompt" rows={4} value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} />
      </Field>

      <div className="chdsh-field">
        <label htmlFor="chdsh-automation-enabled">
          <input
            type="checkbox"
            id="chdsh-automation-enabled"
            checked={enabled}
            aria-describedby="chdsh-automation-enabled-help"
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
          保存后立即启用
        </label>
        <p id="chdsh-automation-enabled-help" className="chdsh-field__help">停用的记录保留配置，控制器不受理新的投递。</p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <Button id="chdsh-automation-save" tone="primary" disabled={busy} onClick={submit}>
          {busy ? '正在保存…' : editing === undefined ? '创建自动化' : '保存修改'}
        </Button>
        <Button id="chdsh-automation-cancel" onClick={onCancel}>取消</Button>
        {devices.status === 'failed' ? <Button id="chdsh-automation-devices-reload" onClick={onDevicesReload}>重新读取执行设备</Button> : null}
      </div>
      {devices.status === 'failed' ? <ErrorNote>执行设备不可用：{devices.error instanceof Error ? devices.error.message : String(devices.error)}</ErrorNote> : null}
    </Panel>
  );
}
