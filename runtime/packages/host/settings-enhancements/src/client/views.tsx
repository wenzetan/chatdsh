/**
 * 设置增强包的区段视图：逐字段保存状态、冲突处理、保存栏与插件清单。
 *
 * 区段从数据入口读一次设置文档，字段目录决定显示顺序；编辑只改草稿，保存时按命名空间带
 * 版本写入。宿主按版本拒绝时重新读文档，按字段列出用户编辑值与服务器当前值，用户可以逐
 * 字段采用服务器值或保留自己的编辑，再用最新版本重新提交。路径类字段按作用范围标注设备
 * 范围，不参与跨设备同步。
 * @module @chatdsh/host-settings-enhancements/views
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Badge, Button, EmptyState, ErrorNote, ErrorSummary, Field, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

import {
  checkDraft,
  GENERAL_FIELDS,
  patchOf,
  readingOf,
  readFieldValue,
  scopeOfField,
  textOfValue,
  RUNTIME_FIELDS,
} from './settings.ts';
import { applyMotionPreference } from './appearance.ts';
import { ENHANCEMENT_FIELDS, NAMESPACE_ID } from '../shared.ts';
import { capture, conflictOf, RESERVED_SHORTCUTS, type KeyEventLike } from './shortcuts.ts';
import { INSTALL_UNSUPPORTED_REASON } from './plugins.ts';
import {
  SettingsCallError,
  type BundleView,
  type FieldConflict,
  type FieldSpec,
  type FieldStatus,
  type PluginEntryView,
  type PluginGateway,
  type SettingsGateway,
  type SettingsLoad,
} from './types.ts';

/** 通用区段的显示名称。 */
export const GENERAL_SECTION_TITLE = '通用设置';

/** 运行区段的显示名称。 */
export const RUNTIME_SECTION_TITLE = '运行设置';

/** 插件区段的显示名称。 */
export const PLUGINS_SECTION_TITLE = '插件';

/** 一个字段在页面里的元素标识。 */
export function fieldIdOf(spec: FieldSpec): string {
  return `chdsh-setting-${spec.key.replace(/[^A-Za-z0-9]+/gu, '-')}`;
}

/** 保存状态的文案。 */
export function statusText(status: FieldStatus | undefined): string {
  if (status === undefined) return '';
  if (status.state === 'dirty') return '未保存';
  if (status.state === 'saving') return '保存中';
  if (status.state === 'saved') return '已保存';
  if (status.state === 'conflict') return '有冲突';
  if (status.state === 'failed') return status.message ?? '保存失败';
  return '';
}

/** 取一次失败的说明。 */
function messageOf(error: unknown): string {
  if (error instanceof SettingsCallError) return `${error.message}（${error.code}）`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 字段键对应的字段目录项。 */
function specOf(fields: readonly FieldSpec[], key: string): FieldSpec | undefined {
  return fields.find((spec) => spec.key === key);
}

/**
 * 未保存离开提示：有草稿时注册 `beforeunload`，页面内同时给出一条常驻说明。
 * @param dirty - 未保存字段数。
 */
export function useUnsavedGuard(dirty: number): void {
  useEffect(() => {
    if (dirty === 0) return undefined;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}

/** 区段的属性。 */
export interface SettingsSectionProps {
  /** 数据入口。 */
  readonly gateway: SettingsGateway;
  /** 标题。 */
  readonly title: string;
  /** 字段目录。 */
  readonly fields: readonly FieldSpec[];
  /**  标题下的说明。 */
  readonly subtitle?: string;
  /** 说明之后的附加内容。 */
  readonly children?: ReactNode;
  /** 界面动作的上报入口。 */
  readonly onAction?: (action: string, outcome: 'ok' | 'failed') => void;
}

/** 一个设置区段。 */
export function SettingsSection({ gateway, title, fields, subtitle, children, onAction }: SettingsSectionProps) {
  const [load, setLoad] = useState<SettingsLoad | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, FieldStatus>>({});
  const [conflicts, setConflicts] = useState<readonly FieldConflict[]>([]);
  const [summary, setSummary] = useState<readonly { fieldId: string; message: string }[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const summaryId = `chdsh-summary-${title}`;

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    gateway.load().then(
      (value) => {
        if (cancelled) return;
        setLoad(value);
        setDrafts({});
        setStatuses({});
        setConflicts([]);
        setSummary([]);
      },
      (failure: unknown) => {
        if (!cancelled) setError(messageOf(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gateway, reloadToken]);

  useEffect(() => {
    if (summary.length > 0) document.getElementById(summaryId)?.focus();
  }, [summary, summaryId]);

  const dirtyKeys = useMemo(
    () => fields.filter((spec) => {
      const state = statuses[spec.key]?.state;
      return state === 'dirty' || state === 'conflict';
    }).map((spec) => spec.key),
    [fields, statuses],
  );
  useUnsavedGuard(dirtyKeys.length);

  useEffect(() =>  {
    if (load === undefined) return;
    const motion = fields.find((spec) => spec.ns === NAMESPACE_ID && spec.field === ENHANCEMENT_FIELDS.motion);
    if (motion === undefined) return;
    const reading = readingOf(load, motion.ns);
    applyMotionPreference(textOfValue(reading === undefined ? undefined : readFieldValue(reading.value, motion.field)));
  }, [load, fields]);

  const valueOfField = (spec: FieldSpec): string => {
    const draft = drafts[spec.key];
    if (draft !== undefined) return draft;
    if (load === undefined) return '';
    const reading = readingOf(load, spec.ns);
    return textOfValue(reading === undefined ? undefined : readFieldValue(reading.value, spec.field));
  };

  const edit = (spec: FieldSpec, value: string): void => {
    if (spec.ns === NAMESPACE_ID && spec.field === ENHANCEMENT_FIELDS.motion) applyMotionPreference(value);
    setDrafts((previous) => ({ ...previous, [spec.key]: value }));
    setStatuses((previous) => ({ ...previous, [spec.key]: { state: 'dirty' } }));
    setSummary((previous) => previous.filter((entry) => entry.fieldId !== fieldIdOf(spec)));
  };

  const save = async (): Promise<void> => {
    if (load === undefined || busy) return;
    const invalid: { fieldId: string; message: string }[] = [];
    let hadFailure = false;
    const groups = new Map<string, { changes: Record<string, unknown>; keys: string[]; reading: NonNullable<ReturnType<typeof readingOf>> }>();
    for (const spec of fields) {
      const state = statuses[spec.key]?.state;
      if (state !== 'dirty' && state !== 'conflict') continue;
      const checked = checkDraft(spec, drafts[spec.key] ?? '');
      if (!checked.ok) {
        invalid.push({ fieldId: fieldIdOf(spec), message: checked.message });
        continue;
      }
      const reading = readingOf(load, spec.ns);
      if (reading === undefined) {
        invalid.push({ fieldId: fieldIdOf(spec), message: `宿主设置服务没有提供命名空间 ${spec.ns}` });
        continue;
      }
      const group = groups.get(spec.ns) ?? { changes: {}, keys: [], reading };
      group.changes[spec.field] = checked.value;
      group.keys.push(spec.key);
      groups.set(spec.ns, group);
    }
    if (invalid.length > 0) {
      setSummary(invalid);
      setStatuses((previous) => {
        const next = { ...previous };
        for (const entry of invalid) {
          const key = fields.find((spec) => fieldIdOf(spec) === entry.fieldId)?.key;
          if (key !== undefined) next[key] = { state: 'failed', message: entry.message };
        }
        return next;
      });
      return;
    }
    setSummary([]);
    setBusy(true);
    try {      for (const [ns, group] of groups) {
        setStatuses((previous) => {
          const next = { ...previous };
          for (const key of group.keys) next[key] = { state: 'saving' };
          return next;
        });
        try {
          const updated = await gateway.update(ns, patchOf(group.reading.value, group.changes), group.reading.revision);
          setLoad((previous) => previous === undefined ? previous : {
            ...previous,
            document: {
              writable: previous.document.writable,
              namespaces: previous.document.namespaces.map((entry) => entry.ns === ns ? updated : entry),
            },
          });
          setStatuses((previous) => {
            const next = { ...previous };
            for (const key of group.keys) next[key] = { state: 'saved' };
            return next;
          });
          setDrafts((previous) => {
            const next = { ...previous };
            for (const key of group.keys) delete next[key];
            return next;
          });
        } catch (failure) {
          hadFailure = true;
          if (failure instanceof SettingsCallError && failure.code === 'settings/conflict') {
            const fresh = await gateway.load();
            setLoad(fresh);
            const serverReading = readingOf(fresh, ns);
            const items: FieldConflict[] = [];
            for (const key of group.keys) {
              const spec = specOf(fields, key);
              if (spec === undefined) continue;
              items.push({
                key,
                userValue: drafts[key] ?? '',
                serverValue: textOfValue(serverReading === undefined ? undefined : readFieldValue(serverReading.value, spec.field)),
              });
            }
            setConflicts((previous) => [...previous.filter((entry) => !group.keys.includes(entry.key)), ...items]);
            setStatuses((previous) => {
              const next = { ...previous };
              for (const key of group.keys) next[key] = { state: 'conflict', message: '另一客户端已修改这个字段' };
              return next;
            });
            continue;
          }
          setStatuses((previous) => {
            const next = { ...previous };
            for (const key of group.keys) next[key] = { state: 'failed', message: messageOf(failure) };
            return next;
          });
          const failedSpec = specOf(fields, group.keys[0] ?? '');
          setSummary(failedSpec === undefined ? [] : [{ fieldId: fieldIdOf(failedSpec), message: messageOf(failure) }]);
        }
      }
    } finally {
      setBusy(false);
      onAction?.('settings-save', hadFailure ? 'failed' : 'ok');
    }
  };

  const reload = (): void => {
    onAction?.('settings-reload', 'ok');
    setDrafts({});
    setStatuses({});
    setConflicts([]);
    setSummary([]);
    setReloadToken((token) => token + 1);
  };

  const adoptServer = (conflict: FieldConflict): void => {
    const spec = specOf(fields, conflict.key);
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[conflict.key];
      return next;
    });
    setStatuses((previous) => ({ ...previous, [conflict.key]: { state: 'idle' } }));
    setConflicts((previous) => previous.filter((entry) => entry.key !== conflict.key));
    if (spec !== undefined) setSummary((previous) => previous.filter((entry) => entry.fieldId !== fieldIdOf(spec)));
  };

  const keepMine = (conflict: FieldConflict): void => {
    setStatuses((previous) => ({ ...previous, [conflict.key]: { state: 'dirty' } }));
    setConflicts((previous) => previous.filter((entry) => entry.key !== conflict.key));
  };

  const shortcutBindings = useMemo(() => {
    const bindings: Record<string, string> = {};
    for (const spec of fields) {
      if (spec.kind !== 'shortcut') continue;
      bindings[spec.key] = valueOfField(spec);
    }
    return bindings;
  }, [fields, drafts, load]);

  if (error !== undefined) {
    return (
      <Panel title={title}>
        <StatusLine tone="danger">设置读取失败：{error}</StatusLine>
        <p><Button onClick={reload}>重新读取</Button></p>
      </Panel>
    );
  }
  if (load === undefined) {
    return <Panel title={title}><Skeleton rows={4} /></Panel>;
  }

  const syncedCount = fields.filter((spec) => scopeOfField(load, spec).synced).length;
  const deviceCount = fields.length - syncedCount;
  const savedCount = Object.values(statuses).filter((status) => status.state === 'saved').length;
  const failedCount = Object.values(statuses).filter((status) => status.state === 'failed').length;

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      count={dirtyKeys.length === 0 ? '无未保存项' : `${String(dirtyKeys.length)} 项未保存`}
    >
      <p className="chdsh-panel__sub">
        设备 {load.sync.deviceId}；同步字段 {String(syncedCount)} 个，设备范围字段 {String(deviceCount)} 个不同步；
        不参与同步的字段共 {String(load.sync.filtered.total)} 个。
      </p>
      {children}
      <div id={summaryId} tabIndex={-1} data-chdsh-error-summary-host>
        {summary.length === 0 ? null : <ErrorSummary errors={[...summary]} />}
      </div>
      {conflicts.length > 0 ? (
        <ConflictPanel conflicts={conflicts} fields={fields} onAdopt={adoptServer} onKeep={keepMine} onResubmit={() => { void save(); }} />
      ) : null}
      <div data-chdsh-field-list>
        {fields.map((spec) => {
          const scope = scopeOfField(load, spec);
          return (
            <FieldRow
              key={spec.key}
              spec={spec}
              value={valueOfField(spec)}
              status={statuses[spec.key]}
              scope={scope}
              bindings={shortcutBindings}
              onChange={(value) => edit(spec, value)}
              onAction={onAction}
            />
          );
        })}
      </div>
      {dirtyKeys.length > 0 ? (
        <p role="status" aria-atomic="true" data-chdsh-unsaved>
          有 {String(dirtyKeys.length)} 个字段未保存，离开这个页面会丢失改动。
        </p>
      ) : null}
      <SaveBar
        dirty={dirtyKeys.length}
        saved={savedCount}
        failed={failedCount}
        conflicts={conflicts.length}
        busy={busy}
        onSave={() => { void save(); }}
        onReload={reload}
      />
    </Panel>
  );
}

/** 一个字段行。 */
function FieldRow({ spec, value, status, scope, bindings, onChange, onAction }: {
  readonly spec: FieldSpec;
  readonly value: string;
  readonly status: FieldStatus | undefined;
  readonly scope: { readonly scope: 'client' | 'device'; readonly synced: boolean };
  readonly bindings: Readonly<Record<string, string>>;
  readonly onChange: (value: string) => void;
  readonly onAction?: (action: string, outcome: 'ok' | 'failed') => void;
}) {
  const id = fieldIdOf(spec);
  const invalid = status?.state === 'failed' ? status.message : undefined;
  const help = (
    <>
      {spec.help === undefined ? null : <>{spec.help} </>}
      <span data-chdsh-scope={scope.scope}>{scope.synced ? '跨设备同步' : '设备范围，不同步'}</span>
      {spec.unit === undefined ? null : <>；单位 {spec.unit}</>}
    </>
  );
  const control = spec.kind === 'select' || spec.kind === 'boolean'
    ? (
      <select id={id} value={value} onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}>
        {spec.kind === 'boolean'
          ? [<option key="true" value="true">开</option>, <option key="false" value="false">关</option>]
          : (
            <>
              {spec.options?.some((option) => option.value === value) === false
                ? <option value={value}>{value === '' ? '未设置' : value}</option>
                : null}
              {spec.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </>
          )}
      </select>
    )
    : (
      <input
        id={id}
        type={spec.kind === 'number' ? 'number' : 'text'}
        value={value}
        readOnly={spec.kind === 'shortcut'}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    );
  return (
    <div className="chdsh-field" data-chdsh-field={spec.key}>
      <Field label={spec.label} help={help} error={invalid}>
        {control}
      </Field>
      {spec.kind === 'shortcut' ? (
        <ShortcutCapture spec={spec} value={value} bindings={bindings} onChange={onChange} onAction={onAction} />
      ) : null}
      <span data-chdsh-field-status={spec.key} data-state={status?.state ?? 'idle'}>
        {statusText(status)}
      </span>
    </div>
  );
}

/** 快捷键录入控件。 */
function ShortcutCapture({ spec, value, bindings, onChange, onAction }: {
  readonly spec: FieldSpec;
  readonly value: string;
  readonly bindings: Readonly<Record<string, string>>;
  readonly onChange: (value: string) => void;
  readonly onAction?: (action: string, outcome: 'ok' | 'failed') => void;
}) {
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const labelOf = (key: string): string => {
    const labels: Record<string, string> = {
      [`chatdsh-settings-enhancements.shortcutSend`]: '发送消息',
      [`chatdsh-settings-enhancements.shortcutNewline`]: '消息换行',
      [`chatdsh-settings-enhancements.shortcutCommand`]: '命令搜索',
    };
    return labels[key] ?? key;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setRecording(false);
      setNotice('已取消录入，快捷键保持原值。');
      return;
    }
    const result = capture(event as unknown as KeyEventLike);
    if (result === undefined) return;
    if (!result.ok) {
      setNotice(result.reason);
      onAction?.('shortcut-record', 'failed');
      return;
    }
    const conflict = conflictOf(result.combo, bindings, spec.key);
    if (conflict !== undefined) {
      setNotice(`与「${labelOf(conflict.key)}」冲突：${result.combo} 已经用于该动作，这次录入被拒绝。`);
      onAction?.('shortcut-record', 'failed');
      return;
    }
    onChange(result.combo);
    setRecording(false);
    setNotice(`已录入 ${result.combo}，保存后生效。`);
    onAction?.('shortcut-record', 'ok');
  };
  return (
    <div data-chdsh-shortcut={spec.key}>
      <button
        ref={buttonRef}
        type="button"
        className="chdsh-btn"
        aria-pressed={recording}
        onClick={() => {
          setRecording(true);
          setNotice('请按下要使用的组合键，按 Escape 取消。');
          buttonRef.current?.focus();
        }}
        onKeyDown={onKeyDown}
      >
        {recording ? '正在录入，请按键' : '录入快捷键'}
      </button>{' '}
      <button type="button" className="chdsh-btn" onClick={() => { setRecording(false); onChange(''); setNotice('已清除这个快捷键。'); }}>清除</button>
      <p role="status" aria-atomic="true" data-chdsh-shortcut-notice={spec.key}>
        {notice ?? `当前录入值：${value === '' ? '未设置' : value}。系统保留键：${RESERVED_SHORTCUTS.slice(0, 3).map((entry) => entry.combo).join('、')} 等。`}
      </p>
    </div>
  );
}

/** 冲突面板。 */
function ConflictPanel({ conflicts, fields, onAdopt, onKeep, onResubmit }: {
  readonly conflicts: readonly FieldConflict[];
  readonly fields: readonly FieldSpec[];
  readonly onAdopt: (conflict: FieldConflict) => void;
  readonly onKeep: (conflict: FieldConflict) => void;
  readonly onResubmit: () => void;
}) {
  return (
    <section className="chdsh-error-summary" role="alert" aria-label="设置冲突" data-chdsh-conflict>
      <h3>另一客户端已修改设置</h3>
      <p>下面每个字段给出你的编辑值与服务器当前值；逐字段选择之后可以再次提交，提交会带上最新版本。</p>
      <ul>
        {conflicts.map((conflict) => {
          const spec = fields.find((entry) => entry.key === conflict.key);
          return (
            <li key={conflict.key} data-chdsh-conflict-field={conflict.key}>
              <strong>{spec?.label ?? conflict.key}</strong>
              <span data-chdsh-conflict-user>我的编辑：{conflict.userValue === '' ? '（空）' : conflict.userValue}</span>
              {' / '}
              <span data-chdsh-conflict-server>服务器当前值：{conflict.serverValue === '' ? '（空）' : conflict.serverValue}</span>
              {' '}
              <Button onClick={() => onAdopt(conflict)}>采用服务器值</Button>{' '}
              <Button onClick={() => onKeep(conflict)}>保留我的</Button>
            </li>
          );
        })}
      </ul>
      <p data-chdsh-conflict-revision>冲突字段 {String(conflicts.length)} 个；再次提交使用这次重新读取得到的版本。</p>
      <Button tone="primary" onClick={onResubmit}>再次提交</Button>
    </section>
  );
}

/** 保存栏。 */
function SaveBar({ dirty, saved, failed, conflicts, busy, onSave, onReload }: {
  readonly dirty: number;
  readonly saved: number;
  readonly failed: number;
  readonly conflicts: number;
  readonly busy: boolean;
  readonly onSave: () => void;
  readonly onReload: () => void;
}) {
  return (
    <section aria-label="保存栏" data-chdsh-savebar style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px' }}>
      <StatusLine>
        未保存 {String(dirty)} 项；已保存 {String(saved)} 项；冲突 {String(conflicts)} 项；失败 {String(failed)} 项。
      </StatusLine>
      <Button tone="primary" onClick={onSave} disabled={busy || dirty === 0} data-chdsh-save>保存</Button>
      <Button onClick={onReload} disabled={busy} data-chdsh-reload>重新读取</Button>
    </section>
  );
}

/** 通用设置区段。 */
export function GeneralSettingsSection({ gateway, children, onAction }: { readonly gateway: SettingsGateway; readonly children?: ReactNode; readonly onAction?: (action: string, outcome: 'ok' | 'failed') => void }) {
  return (
    <SettingsSection
      gateway={gateway}
      title={GENERAL_SECTION_TITLE}
      fields={GENERAL_FIELDS}
      subtitle="语言、主题、字号、动效与快捷键；主题切换只替换令牌，快捷键录入不执行命令。"
      onAction={onAction}
    >
      {children}
    </SettingsSection>
  );
}

/** 运行设置区段。 */
export function RuntimeSettingsSection({ gateway, children, onAction }: { readonly gateway: SettingsGateway; readonly children?: ReactNode; readonly onAction?: (action: string, outcome: 'ok' | 'failed') => void }) {
  return (
    <SettingsSection
      gateway={gateway}
      title={RUNTIME_SECTION_TITLE}
      fields={RUNTIME_FIELDS}
      subtitle="外部程序、Agent 循环、子代理、检索与日志；路径类字段按设备保存，不跨设备同步。"
      onAction={onAction}
    >
      {children}
    </SettingsSection>
  );
}

/** 插件区段。 */
export function PluginsSection({ gateway, onAction }: { readonly gateway: PluginGateway; readonly onAction?: (action: string, outcome: 'ok' | 'failed') => void }) {
  const [state, setState] = useState<{ plugins: readonly PluginEntryView[]; bundles: readonly BundleView[] } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    gateway.load().then(
      (value) => {
        if (cancelled) return;
        setState(value);
        setError(undefined);
      },
      (failure: unknown) => {
        if (!cancelled) setError(messageOf(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gateway, reloadToken]);

  if (error !== undefined) {
    return (
      <Panel title={PLUGINS_SECTION_TITLE}>
        <StatusLine tone="danger">插件清单读取失败：{error}</StatusLine>
        <p><Button onClick={() => setReloadToken((token) => token + 1)}>重新读取</Button></p>
      </Panel>
    );
  }
  if (state === undefined) return <Panel title={PLUGINS_SECTION_TITLE}><Skeleton rows={3} /></Panel>;

  const normalized = query.trim().toLowerCase();
  const matches = (text: string): boolean => normalized === '' || text.toLowerCase().includes(normalized);
  const bundles = state.bundles.filter((bundle) => matches(bundle.name));
  const plugins = state.plugins.filter((plugin) => matches(plugin.title ?? plugin.moduleName) || matches(plugin.moduleName));
  const knownModules = new Set(state.plugins.map((plugin) => plugin.moduleName));
  const failed = state.plugins.filter((plugin) => plugin.fiberPhase === 'failed');

  const act = async (action: string, work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
      setReloadToken((token) => token + 1);
      setError(undefined);
      onAction?.(action, 'ok');
    } catch (failure) {
      setError(messageOf(failure));
      onAction?.(action, 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={PLUGINS_SECTION_TITLE} subtitle="清单来自宿主装载树；启停与卸载直接作用于本设备的组合。" count={`${String(state.plugins.length)} 行`}>
      <Field label="搜索插件" help="按包名或显示名称筛选；切换设备时重新读取，不使用旧清单。">
        <input id="chdsh-plugin-search" type="search" value={query} onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} />
      </Field>
      {failed.length > 0 ? (
        <ErrorNote>有 {String(failed.length)} 个插件行装载失败：{failed.map((plugin) => plugin.moduleName).join('、')}</ErrorNote>
      ) : null}
      <section aria-label="安装入口" data-chdsh-install>
        <h4>安装</h4>
        <Field label="插件包与版本" help={INSTALL_UNSUPPORTED_REASON}>
          <input id="chdsh-plugin-spec" type="text" placeholder="包名@版本" disabled />
        </Field>
        <Button disabled title={INSTALL_UNSUPPORTED_REASON}>安装</Button>
      </section>
      <h4>组合包</h4>
      {bundles.length === 0 ? <EmptyState>没有匹配的组合包。</EmptyState> : (
        <List>
          {bundles.map((bundle) => {
            const missing = bundle.rows.filter((row) => row.moduleName.startsWith('@chatdsh/') || row.moduleName.startsWith('@deepseek-ai/'))
              .filter((row) => !knownModules.has(row.moduleName));
            return (
              <Row
                key={bundle.name}
                title={<>{bundle.name} {bundle.version === undefined ? null : <span>· {bundle.version}</span>}</>}
                badge={bundle.enabled ? <Badge tone="ok">启用</Badge> : <Badge>停用</Badge>}
                meta={<>来源 {bundle.availability}；补丁行 {String(bundle.rows.length)} 条{missing.length > 0 ? `；依赖缺失 ${missing.map((row) => row.moduleName).join('、')}` : ''}{bundle.readOnlyReason === undefined ? '' : `；只读原因 ${bundle.readOnlyReason}`}</>}
                actions={(
                  <>
                    <Button disabled={busy || bundle.readOnlyReason !== undefined} onClick={() => { void act('plugin-toggle', () => gateway.setBundleEnabled(bundle.name, !bundle.enabled)); }}>
                      {bundle.enabled ? '停用组合包' : '启用组合包'} {bundle.name}
                    </Button>{' '}
                    {bundle.removable ? (
                      pendingRemoval === bundle.name ? (
                        <>
                          <Button tone="danger" disabled={busy} onClick={() => { setPendingRemoval(undefined); void act('plugin-remove', () => gateway.removeBundle(bundle.name)); }}>确认卸载 {bundle.name}</Button>{' '}
                          <Button onClick={() => setPendingRemoval(undefined)}>取消卸载 {bundle.name}</Button>
                        </>
                      ) : (
                        <Button tone="danger" disabled={busy} onClick={() => setPendingRemoval(bundle.name)}>卸载 {bundle.name}</Button>
                      )
                    ) : <Badge>不可卸载</Badge>}
                  </>
                )}
              />
            );
          })}
        </List>
      )}
      <h4>插件行</h4>
      {plugins.length === 0 ? <EmptyState>没有匹配的插件行。</EmptyState> : (
        <List>
          {plugins.map((plugin) => (
            <Row
              key={plugin.entryId}
              dot={plugin.fiberPhase === 'failed' ? 'danger' : plugin.enabled ? 'ok' : 'idle'}
              title={plugin.title ?? plugin.moduleName}
              badge={plugin.enabled ? <Badge tone="ok">启用</Badge> : <Badge>停用</Badge>}
              meta={<>{plugin.moduleName}；阶段 {plugin.fiberPhase ?? '未运行'}{plugin.readOnlyReason === undefined ? '' : `；只读原因 ${plugin.readOnlyReason}`}</>}
              actions={(
                <Button
                  disabled={busy || plugin.readOnlyReason !== undefined}
                  onClick={() => { void act('plugin-toggle', () => gateway.setPluginEnabled(plugin.entryId, !plugin.enabled)); }}
                >
                  {plugin.enabled ? '停用' : '启用'} {plugin.title ?? plugin.moduleName}
                </Button>
              )}
            />
          ))}
        </List>
      )}
      <p data-chdsh-plugin-count>装配清单 {String(state.plugins.length)} 行，组合包 {String(state.bundles.length)} 个。</p>
    </Panel>
  );
}
