import { Badge, Button, Dialog, EmptyState, ErrorNote, Field, List, Panel, Row, Skeleton, StatusLine, Toast } from '@chatdsh/core-ui-kit';
import { useEffect, useRef, useState } from 'react';
import {
  MemoryFailure,
  callRemote,
  failureOf,
  failureText,
  formatTimestamp,
  isServiceMissing,
  type Loadable,
  type MemoryGroupView,
  type MemoryRemoteFace,
  type MemoryWorkspaceRef,
} from './face.ts';
import { useProblemFocus, type FormProblem } from './problems.ts';
import { noteAction, type MemoryAction } from './telemetry.ts';
/**
 * 记忆组面板：列表、新建、重命名、关联工作区、解除关联与删除。
 *
 * 保存与删除都带 `revision`；版本过期时显示冲突说明并提供重新读取，重新读取之后保留已填
 * 内容并改用最新版本重试。解除关联只改映射，既有记忆保持原样。
 * @module @chatdsh/client-memory/groups-panel
 */

/** 弹窗种类。 */
type DialogKind = 'rename' | 'attach' | 'detach' | 'remove';

/** 弹窗状态。 */
interface DialogState {
  readonly kind: DialogKind;
  readonly group: MemoryGroupView;
  readonly workspace?: MemoryWorkspaceRef;
  readonly displayName: string;
  readonly deviceId: string;
  readonly path: string;
  readonly failure?: MemoryFailure;
  readonly busy: boolean;
  readonly problems: readonly FormProblem[];
}

/** 弹窗标题。 */
const DIALOG_TITLE: Record<DialogKind, string> = {
  rename: '重命名记忆组',
  attach: '关联工作区',
  detach: '解除工作区关联',
  remove: '删除记忆组',
};

/** 弹出层属性。 */
export interface GroupsPanelProps {
  /** 记忆服务面。 */
  readonly face: MemoryRemoteFace | undefined;
  /** 记忆组列表的加载状态。 */
  readonly state: Loadable<readonly MemoryGroupView[]>;
  /** 重新读取记忆组，返回最新列表。 */
  readonly onReload: () => Promise<readonly MemoryGroupView[] | undefined>;
}

/**
 * 渲染记忆组面板。
 * @param props - 服务面、加载状态与重新读取动作。
 * @returns 面板。
 */
export function GroupsPanel({ face, state, onReload }: GroupsPanelProps) {
  const [newName, setNewName] = useState('');
  const [newDevice, setNewDevice] = useState('');
  const [newPath, setNewPath] = useState('');
  const [createProblems, setCreateProblems] = useState<readonly FormProblem[]>([]);
  const [createFailure, setCreateFailure] = useState<MemoryFailure | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<DialogState | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  useProblemFocus(createProblems);

  // 弹窗打开后把焦点放到第一个可编辑控件或确认按钮；Dialog 自身在 showModal 时先聚焦关闭按钮。
  useEffect(() => {
    if (dialog === undefined) return;
    const timer = setTimeout(() => {
      if (dialog.kind === 'rename') document.getElementById('memory-group-name')?.focus();
      else if (dialog.kind === 'attach') document.getElementById('memory-group-device')?.focus();
      else document.getElementById('memory-group-confirm')?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [dialog?.kind]);

  /**
   * 焦点移动：弹窗关闭后回到触发按钮或列表标题。
   * @param target - 目标元素。
   */
  function focusHeading(): void {
    heading.current?.focus();
  }

  /** 打开一个弹窗。 */
  function openDialog(next: DialogState): void {
    setDialog(next);
    setNotice(undefined);
  }

  /** 关闭弹窗。 */
  function closeDialog(): void {
    setDialog(undefined);
  }

  /**
   * 执行一次记忆组变更。
   * @param action - 遥测动作名。
   * @param run - 实际调用。
   * @param success - 成功后的提示文字。
   * @param after - 成功后的焦点处理。
   */
  async function mutate(
    action: MemoryAction,
    run: (() => Promise<unknown>) | undefined,
    success: string,
    after: 'heading' | 'trigger' = 'trigger',
  ): Promise<void> {
    if (dialog !== undefined) setDialog({ ...dialog, busy: true, failure: undefined });
    try {
      await callRemote('保存记忆组', run);
      noteAction(action, 'ok');
      setDialog(undefined);
      setNotice(success);
      await onReload();
      setCreateProblems([]);
      setCreateFailure(undefined);
      if (after === 'heading') focusHeading();
    } catch (error) {
      noteAction(action, 'failed');
      const failure = failureOf(error);
      setDialog((current) => (current === undefined ? current : { ...current, busy: false, failure }));
    }
  }

  /** 新建记忆组。 */
  async function createGroup(): Promise<void> {
    const problems: FormProblem[] = [];
    if (newName.trim() === '') problems.push({ fieldId: 'memory-group-new-name', message: '显示名称不能为空' });
    if (newDevice.trim() === '') problems.push({ fieldId: 'memory-group-new-device', message: '设备标识不能为空' });
    if (!newPath.startsWith('/')) problems.push({ fieldId: 'memory-group-new-path', message: '工作区路径必须是绝对路径' });
    setCreateProblems(problems);
    if (problems.length > 0) return;
    if (face?.saveGroup === undefined) {
      setCreateFailure(new MemoryFailure('记忆服务没有提供保存记忆组接口'));
      noteAction('memory-group-create', 'failed');
      return;
    }
    setCreating(true);
    setCreateFailure(undefined);
    try {
      await callRemote<MemoryGroupView>('保存记忆组', () => face.saveGroup!({
        displayName: newName.trim(),
        workspaces: [{ deviceId: newDevice.trim(), path: newPath }],
      }));
      noteAction('memory-group-create', 'ok');
      setNotice(`已新建记忆组「${newName.trim()}」`);
      setNewName('');
      setNewPath('');
      await onReload();
      focusHeading();
    } catch (error) {
      setCreateFailure(failureOf(error));
      noteAction('memory-group-create', 'failed');
    } finally {
      setCreating(false);
    }
  }

  /** 弹窗里保存重命名或关联。 */
  async function saveDialog(): Promise<void> {
    const current = dialog;
    if (current === undefined) return;
    if (current.kind === 'rename') {
      if (current.displayName.trim() === '') {
        setDialog({ ...current, problems: [{ fieldId: 'memory-group-name', message: '显示名称不能为空' }] });
        return;
      }
      await mutate('memory-group-rename', face?.saveGroup === undefined ? undefined : () => face.saveGroup!({
        memoryGroupId: current.group.memoryGroupId,
        displayName: current.displayName.trim(),
        workspaces: current.group.workspaces,
        revision: current.group.revision,
      }), `已重命名记忆组「${current.displayName.trim()}」`);
      return;
    }
    if (current.kind === 'attach') {
      const problems: FormProblem[] = [];
      if (current.deviceId.trim() === '') problems.push({ fieldId: 'memory-group-device', message: '设备标识不能为空' });
      if (!current.path.startsWith('/')) problems.push({ fieldId: 'memory-group-path', message: '工作区路径必须是绝对路径' });
      if (problems.length > 0) {
        setDialog({ ...current, problems });
        return;
      }
      const workspace: MemoryWorkspaceRef = { deviceId: current.deviceId.trim(), path: current.path };
      await mutate('memory-group-attach', face?.saveGroup === undefined ? undefined : () => face.saveGroup!({
        memoryGroupId: current.group.memoryGroupId,
        displayName: current.group.displayName,
        workspaces: [...current.group.workspaces, workspace],
        revision: current.group.revision,
      }), `已关联工作区 ${workspace.deviceId} · ${workspace.path}`);
      return;
    }
    if (current.kind === 'detach' && current.workspace !== undefined) {
      const workspace = current.workspace;
      const run = face?.detachWorkspace === undefined
        ? undefined
        : () => face.detachWorkspace!(current.group.memoryGroupId, workspace, current.group.revision);
      if (dialog !== undefined) setDialog({ ...dialog, busy: true, failure: undefined });
      try {
        const updated = await callRemote<MemoryGroupView | undefined>('解除工作区关联', run);
        noteAction('memory-group-detach', 'ok');
        setDialog(undefined);
        setNotice(updated === undefined
          ? `已解除 ${workspace.path}，记忆组随之删除`
          : `已解除 ${workspace.deviceId} · ${workspace.path}`);
        await onReload();
        if (updated === undefined) focusHeading();
      } catch (error) {
        noteAction('memory-group-detach', 'failed');
        setDialog((active) => (active === undefined ? active : { ...active, busy: false, failure: failureOf(error) }));
      }
      return;
    }
    if (current.kind === 'remove') {
      const run = face?.removeGroup === undefined
        ? undefined
        : () => face.removeGroup!(current.group.memoryGroupId, current.group.revision);
      if (dialog !== undefined) setDialog({ ...dialog, busy: true, failure: undefined });
      try {
        await callRemote<boolean>('删除记忆组', run);
        noteAction('memory-group-remove', 'ok');
        setDialog(undefined);
        setNotice(`已删除记忆组「${current.group.displayName}」`);
        await onReload();
        focusHeading();
      } catch (error) {
        noteAction('memory-group-remove', 'failed');
        setDialog((active) => (active === undefined ? active : { ...active, busy: false, failure: failureOf(error) }));
      }
    }
  }

  /** 版本冲突后重新读取，并把最新 revision 带进弹窗。 */
  async function reloadForDialog(): Promise<void> {
    const current = dialog;
    if (current === undefined) return;
    noteAction('memory-reload', 'ok');
    const groups = await onReload();
    if (groups === undefined) return;
    const fresh = groups.find((group) => group.memoryGroupId === current.group.memoryGroupId);
    if (fresh === undefined) {
      setDialog(undefined);
      focusHeading();
      return;
    }
    setDialog({ ...current, group: fresh, failure: undefined, busy: false });
  }

  if (state.status === 'loading') {
    return (
      <Panel title="记忆组">
        <Skeleton rows={3} />
      </Panel>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <Panel title="记忆组">
        <StatusLine tone="danger">记忆组不可用：宿主没有注册记忆服务。</StatusLine>
        <EmptyState>记忆组合包加入 profile 的 bundles 列表之后才能建立工作区关联。</EmptyState>
      </Panel>
    );
  }
  if (state.status === 'failed') {
    return (
      <Panel title="记忆组">
        <StatusLine tone="danger">
          {isServiceMissing(state.failure) ? '记忆未启用：宿主没有注册记忆服务' : '读取记忆组失败'}：{failureText(state.failure)}
        </StatusLine>
        <p><Button onClick={() => void onReload()}>重新读取</Button></p>
      </Panel>
    );
  }
  const groups = state.value;
  return (
    <Panel title="记忆组" count={`${String(groups.length)} 组`}>
      {notice === undefined ? null : <Toast onDismiss={() => setNotice(undefined)}>{notice}</Toast>}
      <h4 id="memory-groups-heading" ref={heading} tabIndex={-1}>工作区与记忆组</h4>
      <StatusLine>
        记忆组用稳定标识关联工作区集合；召回读组 bank 与个人 bank，回合写入仍落在 acct。解除关联不删除既有记忆。
      </StatusLine>
      <div className="chdsh-row__acts">
        <Button id="memory-groups-reload" onClick={() => { void onReload().then(() => { noteAction('memory-reload', 'ok'); }); }}>重新读取</Button>
      </div>
      {groups.length === 0
        ? <EmptyState>还没有记忆组。为工作区建立记忆组之后，两台设备上的同一仓库共享召回范围。</EmptyState>
        : (
          <List>
            {groups.map((group) => (
              <Row
                key={group.memoryGroupId}
                dot="ok"
                title={(
                  <>
                    {group.displayName}
                    <Badge tone="neutral">revision {String(group.revision)}</Badge>
                    <Badge tone={group.entryCount === undefined ? 'warn' : 'ok'}>
                      {group.entryCount === undefined ? '条目数读取未完成' : `${String(group.entryCount)} 条`}
                    </Badge>
                  </>
                )}
                meta={(
                  <span data-group-id={group.memoryGroupId}>
                    memoryGroupId：{group.memoryGroupId} · 建立 {formatTimestamp(group.createdAt)} · 更新 {formatTimestamp(group.updatedAt)}
                    {group.workspaces.map((workspace) => (
                      <span key={`${workspace.deviceId}\u0000${workspace.path}`} style={{ display: 'block' }}>
                        工作区：{workspace.deviceId} · {workspace.path}{' '}
                        <Button data-group-action="detach" onClick={() => openDialog({
                          kind: 'detach',
                          group,
                          workspace,
                          displayName: group.displayName,
                          deviceId: '',
                          path: '',
                          busy: false,
                          problems: [],
                        })}>解除关联</Button>
                      </span>
                    ))}
                    {group.entryCount === undefined
                      ? <span style={{ display: 'block' }}>组内条目数依赖记忆服务的统计接口，读取到之前不显示为零条。</span>
                      : null}
                  </span>
                )}
                actions={(
                  <>
                    <Button data-group-action="rename" onClick={() => openDialog({
                      kind: 'rename',
                      group,
                      displayName: group.displayName,
                      deviceId: '',
                      path: '',
                      busy: false,
                      problems: [],
                    })}>重命名</Button>
                    <Button data-group-action="attach" onClick={() => openDialog({
                      kind: 'attach',
                      group,
                      displayName: group.displayName,
                      deviceId: '',
                      path: '',
                      busy: false,
                      problems: [],
                    })}>关联工作区</Button>
                    <Button data-group-action="remove" tone="danger" onClick={() => openDialog({
                      kind: 'remove',
                      group,
                      displayName: group.displayName,
                      deviceId: '',
                      path: '',
                      busy: false,
                      problems: [],
                    })}>删除</Button>
                  </>
                )}
              />
            ))}
          </List>
        )}
      <h4>新建记忆组</h4>
      <form noValidate onSubmit={(event) => { event.preventDefault(); void createGroup(); }} aria-label="新建记忆组">
        {createProblems.length === 0 ? null : (
          <div role="alert" className="chdsh-error">
            {createProblems.map((problem) => <p key={problem.fieldId}>{problem.message}</p>)}
          </div>
        )}
        {createFailure === undefined ? null : <ErrorNote>新建记忆组失败：{failureText(createFailure)}</ErrorNote>}
        <Field label="显示名称" required help="最长 80 个字符，仅用于显示；标识由宿主生成。">
          <input
            id="memory-group-new-name"
            value={newName}
            onChange={(event) => { setNewName(event.target.value); setCreateProblems([]); }}
            disabled={creating}
          />
        </Field>
        <Field label="设备标识" required help="工作区所在设备的标识，与路径共同确定一个工作区。">
          <input
            id="memory-group-new-device"
            value={newDevice}
            onChange={(event) => { setNewDevice(event.target.value); setCreateProblems([]); }}
            disabled={creating}
          />
        </Field>
        <Field label="工作区路径" required help="执行设备上的绝对路径。">
          <input
            id="memory-group-new-path"
            value={newPath}
            onChange={(event) => { setNewPath(event.target.value); setCreateProblems([]); }}
            disabled={creating}
          />
        </Field>
        <Button id="memory-group-create" type="submit" tone="primary" disabled={creating}>{creating ? '正在新建…' : '新建记忆组'}</Button>
      </form>
      <Dialog
        open={dialog !== undefined}
        title={dialog === undefined ? '记忆组操作' : DIALOG_TITLE[dialog.kind]}
        description={dialog === undefined
          ? undefined
          : dialog.kind === 'remove'
            ? '删除只移除映射，既有记忆保持原样。'
            : dialog.kind === 'detach'
              ? '解除关联只改映射，既有记忆保持原样。'
              : '保存之后新回合按新的召回范围读取。'}
        onClose={closeDialog}
      >
        {dialog === undefined ? null : (
          <div data-dialog-kind={dialog.kind}>
            {dialog.failure === undefined ? null : (
              <ErrorNote>
                {dialog.failure.code === 'revision-conflict'
                  ? `记忆组版本已过期，本次修改未保存（错误码 ${dialog.failure.code}）。重新读取之后可以按最新版本重试。`
                  : `操作未被受理：${failureText(dialog.failure)}`}
              </ErrorNote>
            )}
            {dialog.failure?.code === 'revision-conflict'
              ? <p><Button id="memory-group-conflict-reload" onClick={() => void reloadForDialog()}>重新读取（保留已填内容）</Button></p>
              : null}
            {dialog.kind === 'rename' ? (
              <Field label="显示名称" required error={dialog.problems[0]?.message}>
                <input
                  id="memory-group-name"
                  value={dialog.displayName}
                  onChange={(event) => setDialog({ ...dialog, displayName: event.target.value, problems: [] })}
                  disabled={dialog.busy}
                />
              </Field>
            ) : null}
            {dialog.kind === 'attach' ? (
              <>
                <Field label="设备标识" required>
                  <input
                    id="memory-group-device"
                    value={dialog.deviceId}
                    onChange={(event) => setDialog({ ...dialog, deviceId: event.target.value, problems: [] })}
                    disabled={dialog.busy}
                  />
                </Field>
                <Field label="工作区路径" required error={dialog.problems.find((problem) => problem.fieldId === 'memory-group-path')?.message}>
                  <input
                    id="memory-group-path"
                    value={dialog.path}
                    onChange={(event) => setDialog({ ...dialog, path: event.target.value, problems: [] })}
                    disabled={dialog.busy}
                  />
                </Field>
              </>
            ) : null}
            {dialog.kind === 'detach' && dialog.workspace !== undefined ? (
              <p>解除 {dialog.workspace.deviceId} · {dialog.workspace.path} 与「{dialog.group.displayName}」的关联？解除最后一个工作区时记忆组随之删除。</p>
            ) : null}
            {dialog.kind === 'remove' ? (
              <p>删除记忆组「{dialog.group.displayName}」（{dialog.group.memoryGroupId}）？关联映射会被移除，既有记忆保持原样。</p>
            ) : null}
            <div className="chdsh-row__acts">
              {dialog.kind === 'rename' || dialog.kind === 'attach'
                ? <Button id="memory-group-save" tone="primary" onClick={() => void saveDialog()} disabled={dialog.busy}>{dialog.busy ? '正在保存…' : '保存'}</Button>
                : dialog.kind === 'detach'
                  ? <Button id="memory-group-confirm" tone="primary" onClick={() => void saveDialog()} disabled={dialog.busy}>{dialog.busy ? '正在解除…' : '确认解除'}</Button>
                  : <Button id="memory-group-confirm" tone="danger" onClick={() => void saveDialog()} disabled={dialog.busy}>{dialog.busy ? '正在删除…' : '确认删除'}</Button>}
              <Button onClick={closeDialog} disabled={dialog.busy}>取消</Button>
            </div>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}
