import { Button, Dialog, EmptyState, ErrorNote, Field, List, Panel, Row, Skeleton, StatusLine, Toast } from '@chatdsh/core-ui-kit';
import { useEffect, useRef, useState } from 'react';
import {
  MemoryFailure,
  callRemote,
  failureOf,
  failureText,
  formatTimestamp,
  isServiceMissing,
  type Loadable,
  type MemoryRemoteFace,
  type MemoryWriteQueueView,
} from './face.ts';
import { useProblemFocus, type FormProblem } from './problems.ts';
import { noteAction } from './telemetry.ts';
/**
 * 未确认写入面板：只显示数量、时间与错误码，并提供按记录标识丢弃。
 *
 * 正文留在宿主侧，视图不返回也不显示；丢弃需要显式确认，记录不存在时给出明确结果。
 * @module @chatdsh/client-memory/writes-panel
 */

/** 面板属性。 */
export interface WritesPanelProps {
  /** 记忆服务面。 */
  readonly face: MemoryRemoteFace | undefined;
  /** 计数视图的加载状态。 */
  readonly state: Loadable<MemoryWriteQueueView>;
  /** 重新读取计数视图。 */
  readonly onReload: () => Promise<void>;
}

/**
 * 渲染未确认写入面板。
 * @param props - 服务面、加载状态与重新读取动作。
 * @returns 面板。
 */
export function WritesPanel({ face, state, onReload }: WritesPanelProps) {
  const [recordId, setRecordId] = useState('');
  const [problems, setProblems] = useState<readonly FormProblem[]>([]);
  const [dialog, setDialog] = useState<{ readonly id: string; readonly busy: boolean; readonly failure?: MemoryFailure } | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  useProblemFocus(problems);

  useEffect(() => {
    if (dialog === undefined) return;
    const timer = setTimeout(() => {
      document.getElementById('memory-discard-confirm')?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [dialog?.id]);

  /** 打开丢弃确认。 */
  function openDiscard(): void {
    if (recordId.trim() === '') {
      setProblems([{ fieldId: 'memory-discard-id', message: '记录标识不能为空' }]);
      return;
    }
    setDialog({ id: recordId.trim(), busy: false });
    setNotice(undefined);
  }

  /** 确认丢弃。 */
  async function discard(): Promise<void> {
    const current = dialog;
    if (current === undefined) return;
    setDialog({ ...current, busy: true, failure: undefined });
    if (face?.discardWrite === undefined) {
      noteAction('memory-write-discard', 'failed');
      setDialog({ ...current, busy: false, failure: new MemoryFailure('记忆服务没有提供丢弃未确认写入的接口') });
      return;
    }
    try {
      const discarded = await callRemote<boolean>('丢弃未确认写入', () => face.discardWrite!(current.id));
      if (discarded !== true) {
        noteAction('memory-write-discard', 'failed');
        setDialog({ ...current, busy: false, failure: new MemoryFailure('记录不存在或已经被处理') });
        return;
      }
      noteAction('memory-write-discard', 'ok');
      setDialog(undefined);
      setRecordId('');
      setNotice('已丢弃 1 条未确认写入记录');
      await onReload();
      heading.current?.focus();
    } catch (error) {
      noteAction('memory-write-discard', 'failed');
      setDialog({ ...current, busy: false, failure: failureOf(error) });
    }
  }

  if (state.status === 'loading') {
    return (
      <Panel title="未确认写入">
        <Skeleton rows={3} />
      </Panel>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <Panel title="未确认写入">
        <StatusLine tone="danger">未确认写入不可用：宿主没有注册记忆服务。</StatusLine>
        <EmptyState>记忆组合包加入 profile 的 bundles 列表之后才能查看待写入记录。</EmptyState>
      </Panel>
    );
  }
  if (state.status === 'failed') {
    return (
      <Panel title="未确认写入">
        <StatusLine tone="danger">
          {isServiceMissing(state.failure) ? '记忆未启用：宿主没有注册记忆服务' : '读取未确认写入失败'}：{failureText(state.failure)}
        </StatusLine>
        <p><Button onClick={() => void onReload()}>重新读取</Button></p>
      </Panel>
    );
  }
  const view = state.value;
  return (
    <Panel title="未确认写入" count={`${String(view.pendingCount)} 待处理`}>
      {notice === undefined ? null : <Toast onDismiss={() => setNotice(undefined)}>{notice}</Toast>}
      <h4 id="memory-writes-heading" ref={heading} tabIndex={-1}>待写入与废弃记录</h4>
      <StatusLine>视图只有数量、时间与错误码；正文留在宿主侧，不进入界面与遥测。</StatusLine>
      <List>
        <Row title="待写入任务" dot={view.pendingCount === 0 ? 'ok' : 'warn'} meta={`${String(view.pendingCount)} 项`} />
        <Row title="最早登记时刻" meta={view.oldestPendingAt === undefined ? '无' : formatTimestamp(view.oldestPendingAt)} />
        <Row title="已丢弃" meta={`${String(view.discardedCount)} 项`} />
        <Row
          title="最近错误码"
          dot={view.lastErrorCode === undefined ? 'idle' : 'danger'}
          meta={view.lastErrorCode === undefined ? '无' : view.lastErrorCode}
        />
      </List>
      <div className="chdsh-row__acts">
        <Button id="memory-queue-reload" onClick={() => { void onReload().then(() => { noteAction('memory-reload', 'ok'); }); }}>重新读取</Button>
      </div>
      <h4>丢弃一条未确认写入</h4>
      <form noValidate onSubmit={(event) => { event.preventDefault(); openDiscard(); }} aria-label="丢弃未确认写入">
        {problems.length === 0 ? null : (
          <div role="alert" className="chdsh-error">
            {problems.map((problem) => <p key={problem.fieldId}>{problem.message}</p>)}
          </div>
        )}
        <Field label="记录标识" required help="记录标识由宿主日志提供；视图不显示正文，也不显示标识。">
          <input
            id="memory-discard-id"
            value={recordId}
            onChange={(event) => { setRecordId(event.target.value); setProblems([]); }}
          />
        </Field>
        <Button id="memory-discard-open" type="submit">丢弃记录</Button>
      </form>
      <Dialog
        open={dialog !== undefined}
        title="确认丢弃未确认写入"
        description="丢弃之后这条写入不会送到记忆后端，登记随之删除。"
        onClose={() => setDialog(undefined)}
      >
        {dialog === undefined ? null : (
          <div data-dialog-kind="discard">
            {dialog.failure === undefined ? null : <ErrorNote>丢弃未被受理：{failureText(dialog.failure)}</ErrorNote>}
            <p>丢弃记录 {dialog.id}？</p>
            <div className="chdsh-row__acts">
              <Button id="memory-discard-confirm" tone="danger" onClick={() => void discard()} disabled={dialog.busy}>
                {dialog.busy ? '正在丢弃…' : '确认丢弃'}
              </Button>
              <Button onClick={() => setDialog(undefined)} disabled={dialog.busy}>取消</Button>
            </div>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}
