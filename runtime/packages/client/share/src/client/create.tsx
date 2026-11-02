/**
 * 创建分享：选择源会话、内容范围、公开文本、逐项附件与有效期，预览之后生成链接。
 *
 * 生成之前必须先看预览：预览由控制平面按公开页的同一套过滤规则算出来，界面逐项呈现过滤
 * 计数、脱敏计数、排除项与回合清单。内容范围用宿主侧的四种方式：会话全部、指定回合集合、
 * 完整回合边界与截止上界。附件逐项授权，未勾选的附件不进入分享包。
 * @module @chatdsh/client-share/create
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ErrorNote, Field, Panel, StatusLine } from '@chatdsh/core-ui-kit';
import { copyText, type CopyOutcome } from './copy.ts';
import { attachmentSizeLabel, SharePreviewPanel } from './preview.tsx';
import {
  attachmentCandidatesOf,
  describeBytes,
  describeExpiryAt,
  formatTime,
  shareUrlOf,
  TTL_OPTIONS,
  turnRangesOf,
  type TurnRange,
} from './share.ts';
import type { Loadable } from './loadable.ts';
import type {
  ReplicaEvent,
  SessionsSnapshot,
  ShareCreatedView,
  ShareGateway,
  SharePreview,
  ShareRange,
  ShareSelection,
} from './types.ts';

/** 内容范围的方式，与宿主侧的四种范围一一对应。 */
type ScopeMode = ShareRange['mode'];

/** 当前阶段。 */
type Stage = 'form' | 'preview' | 'created';

/** 创建面板属性。 */
export interface CreateSharePanelProps {
  readonly gateway: ShareGateway;
  readonly sessions: Loadable<SessionsSnapshot>;
  /** 创建成功之后通知外层刷新记录。 */
  readonly onCreated: () => void;
}

/** 会话选项的扁平结构。 */
interface SessionOption {
  readonly sessionId: string;
  readonly title: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly online: boolean;
}

/** 已读取的副本。 */
interface LoadedReplica {
  readonly sessionId: string;
  readonly events: readonly ReplicaEvent[];
}

/** 范围方式的可读名称。 */
const MODE_LABELS: Readonly<Record<ScopeMode, string>> = {
  session: '会话全部',
  turns: '指定回合集合',
  range: '完整回合边界',
  bound: '截止上界',
};

/** 范围方式的说明。 */
const MODE_HELP: Readonly<Record<ScopeMode, string>> = {
  session: '快照覆盖建立时副本里的全部完整回合。',
  turns: '逐项勾选要公开的完整回合，回合可以不相邻。',
  range: '选择起始回合与结束回合，区间内的完整回合进入快照。',
  bound: '选择截止到的完整回合，该回合及之前的完整回合进入快照。',
};

/** 尚未读取副本时使用的事件列表。 */
const NO_EVENTS: readonly ReplicaEvent[] = [];

/** 把聚合结果摊平成选项。 */
function optionsOf(snapshot: SessionsSnapshot): SessionOption[] {
  const out: SessionOption[] = [];
  for (const device of snapshot.devices) {
    for (const session of device.sessions) {
      out.push({
        sessionId: session.sessionId,
        title: session.title,
        deviceId: device.deviceId,
        deviceName: device.name,
        online: device.online,
      });
    }
  }
  return out;
}

/** 只保留落在给定回合里的副本事件。 */
function eventsInTurns(events: readonly ReplicaEvent[], turns: readonly TurnRange[]): ReplicaEvent[] {
  if (turns.length === 0) return [];
  return events.filter((event) => turns.some((turn) => event.seq >= turn.startSeq && event.seq <= turn.endSeq));
}

/** 复选框一行的样式。 */
const CHOICE_LABEL = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  minHeight: '44px',
  padding: '6px 2px',
  color: 'var(--chatdsh-ink-2)',
  fontSize: 'var(--cdh-fs-13)',
  overflowWrap: 'anywhere',
  cursor: 'pointer',
} as const;
const CHOICE_GROUP = { border: '1px solid var(--chatdsh-line-2)', borderRadius: 'var(--cdh-r1)', margin: '0 0 12px', padding: '8px 12px', minWidth: 0 } as const;
const CHOICE_LEGEND = { padding: '0 4px', color: 'var(--chatdsh-ink)', fontWeight: 600, fontSize: 'var(--cdh-fs-13)' } as const;
const CHOICE_LIST = { listStyle: 'none', margin: '4px 0 0', padding: 0, maxHeight: '240px', overflowY: 'auto' } as const;
const HELP_TEXT = { margin: '0 0 6px', color: 'var(--chatdsh-muted)', fontSize: 'var(--cdh-fs-12)', overflowWrap: 'anywhere' } as const;
const URL_INPUT = {
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  minHeight: '44px',
  padding: 'var(--cdh-s2)',
  border: '1px solid var(--chatdsh-line-2)',
  borderRadius: 'var(--cdh-r1)',
  background: 'var(--chatdsh-panel)',
  color: 'var(--chatdsh-ink)',
  fontFamily: 'var(--cdh-font-mono)',
  fontSize: 'var(--cdh-fs-12)',
  overflowWrap: 'anywhere',
} as const;

/**
 * 创建分享面板。
 * @param props - 数据入口、会话与成功回调。
 * @returns 面板。
 */
export function CreateSharePanel({ gateway, sessions, onCreated }: CreateSharePanelProps) {
  const [sessionId, setSessionId] = useState('');
  const [mode, setMode] = useState<ScopeMode>('session');
  const [chosenTurns, setChosenTurns] = useState<ReadonlySet<number>>(new Set());
  const [fromTurn, setFromTurn] = useState('');
  const [toTurn, setToTurn] = useState('');
  const [boundTurn, setBoundTurn] = useState('');
  const [includeUserText, setIncludeUserText] = useState(true);
  const [includeAssistantText, setIncludeAssistantText] = useState(true);
  const [chosenAttachments, setChosenAttachments] = useState<ReadonlySet<string>>(new Set());
  const [ttlId, setTtlId] = useState('day');
  const [stage, setStage] = useState<Stage>('form');
  const [loaded, setLoaded] = useState<LoadedReplica | undefined>(undefined);
  const [preview, setPreview] = useState<SharePreview | undefined>(undefined);
  const [previewSelection, setPreviewSelection] = useState<ShareSelection | undefined>(undefined);
  const [previewAt, setPreviewAt] = useState(0);
  const [created, setCreated] = useState<ShareCreatedView | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [copyState, setCopyState] = useState<CopyOutcome | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [loadingReplica, setLoadingReplica] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const fallbackInput = useRef<HTMLInputElement>(null);

  const options = sessions.status === 'ready' ? optionsOf(sessions.value) : [];
  const selected = options.find((option) => option.sessionId === sessionId);
  const events = loaded?.sessionId === sessionId ? loaded.events : NO_EVENTS;
  const turns = useMemo(() => turnRangesOf(events), [events]);
  const completeTurns = turns.filter((turn) => turn.complete);

  /** 当前范围方式选中的回合。 */
  const scopedTurns = useMemo((): readonly TurnRange[] => {
    if (mode === 'session') return turns;
    if (mode === 'turns') return turns.filter((turn) => turn.complete && chosenTurns.has(turn.turn));
    if (mode === 'range') {
      const from = Number.parseInt(fromTurn, 10);
      const to = Number.parseInt(toTurn, 10);
      if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return [];
      return turns.filter((turn) => turn.complete && turn.turn >= from && turn.turn <= to);
    }
    const bound = turns.find((turn) => turn.complete && String(turn.turn) === boundTurn);
    if (bound === undefined) return [];
    return turns.filter((turn) => turn.complete && turn.turn <= bound.turn);
  }, [mode, turns, chosenTurns, fromTurn, toTurn, boundTurn]);

  /** 当前范围内可以被逐项授权的附件。 */
  const candidates = useMemo(
    () => attachmentCandidatesOf(eventsInTurns(events, scopedTurns)),
    [events, scopedTurns],
  );

  // 结果出现之后把焦点放到分享地址上，键盘用户可以直接选中或复制。
  useEffect(() => {
    if (stage !== 'created') return;
    const input = urlInput.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [stage]);

  // 复制被拒绝时把焦点放到替代文本上，用户按键就能整段选中。
  useEffect(() => {
    if (copyState === undefined || copyState.ok) return;
    fallbackInput.current?.select();
  }, [copyState]);

  /** 选定会话之后先读副本：回合清单与附件候选都来自这份副本。 */
  const loadReplica = (target: string): void => {
    setSessionId(target);
    setLoaded(undefined);
    setChosenTurns(new Set());
    setChosenAttachments(new Set());
    setFromTurn('');
    setToTurn('');
    setBoundTurn('');
    setFailure(undefined);
    setStage('form');
    if (target === '') return;
    setLoadingReplica(true);
    gateway.replica(target).then(
      (snapshot) => {
        setLoadingReplica(false);
        setLoaded({ sessionId: target, events: snapshot.events });
        const ranges = turnRangesOf(snapshot.events);
        const complete = ranges.filter((range) => range.complete);
        const last = complete[complete.length - 1];
        if (last !== undefined) {
          setChosenTurns(new Set([last.turn]));
          setFromTurn(String(complete[0]?.turn ?? last.turn));
          setToTurn(String(last.turn));
          setBoundTurn(String(last.turn));
        }
      },
      (error: unknown) => {
        setLoadingReplica(false);
        setFailure(`读取副本失败：${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };

  /** 组装本次分享的范围。 */
  const rangeOf = (): ShareRange => {
    if (mode === 'session') return { mode: 'session' };
    if (mode === 'turns') {
      const chosen = [...chosenTurns].sort((left, right) => left - right);
      if (chosen.length === 0) throw new Error('请至少勾选一个完整回合');
      return { mode: 'turns', turns: chosen };
    }
    if (mode === 'range') {
      const from = Number.parseInt(fromTurn, 10);
      const to = Number.parseInt(toTurn, 10);
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error('请选择起始回合与结束回合');
      if (to < from) throw new Error('结束回合不能早于起始回合');
      return { mode: 'range', turnFrom: from, turnTo: to };
    }
    const bound = completeTurns.find((turn) => String(turn.turn) === boundTurn);
    if (bound === undefined) throw new Error('请选择截止到的完整回合');
    return { mode: 'bound', upToSeq: bound.endSeq };
  };

  /** 组装本次分享的公开选择。 */
  const selectionOf = (): ShareSelection => ({
    includeUserText,
    includeAssistantText,
    attachmentIds: candidates.filter((candidate) => chosenAttachments.has(candidate.id)).map((candidate) => candidate.id),
  });

  /** 提交之前的本地校验。 */
  const check = (): ShareRange | undefined => {
    if (sessionId === '') {
      setFailure('请先选择源会话');
      return undefined;
    }
    if (!includeUserText && !includeAssistantText) {
      setFailure('至少要公开用户消息或助手消息中的一种');
      return undefined;
    }
    try {
      return rangeOf();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  /** 请求预览并进入预览阶段。 */
  const openPreview = (): void => {
    if (busy) return;
    const range = check();
    if (range === undefined) return;
    const selection = selectionOf();
    setBusy(true);
    setFailure(undefined);
    setCopyState(undefined);
    gateway.preview({ sessionId, range, ...selection }).then(
      (answer) => {
        setBusy(false);
        setPreview(answer);
        setPreviewSelection(selection);
        setPreviewAt(Date.now());
        setStage('preview');
        gateway.noteAction('share-preview', 'ok');
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error instanceof Error ? error.message : String(error));
        gateway.noteAction('share-preview', 'failed');
      },
    );
  };

  /** 提交创建。 */
  const submit = (): void => {
    if (busy) return;
    const range = check();
    if (range === undefined) return;
    const ttl = TTL_OPTIONS.find((option) => option.id === ttlId);
    if (ttl === undefined) throw new Error(`未登记的有效期选项：${ttlId}`);
    setBusy(true);
    setFailure(undefined);
    gateway.create({
      sessionId,
      range,
      ...selectionOf(),
      ...(ttl.ttlMs === undefined ? {} : { ttlMs: ttl.ttlMs }),
    }).then(
      (result) => {
        setBusy(false);
        setCreated(result);
        setStage('created');
        gateway.noteAction('share-create', 'ok');
        onCreated();
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error instanceof Error ? error.message : String(error));
        gateway.noteAction('share-create', 'failed');
      },
    );
  };

  /** 重置到表单。 */
  const restart = (): void => {
    setStage('form');
    setPreview(undefined);
    setPreviewSelection(undefined);
    setCreated(undefined);
    setCopyState(undefined);
    setFailure(undefined);
  };

  if (sessions.status === 'loading') return <Panel title="创建分享"><StatusLine>正在读取会话列表…</StatusLine></Panel>;
  if (sessions.status === 'failed') {
    return (
      <Panel title="创建分享">
        <ErrorNote>会话列表不可用，无法建立分享：{sessions.error instanceof Error ? sessions.error.message : String(sessions.error)}</ErrorNote>
      </Panel>
    );
  }
  if (options.length === 0) {
    return <Panel title="创建分享"><StatusLine>还没有可分享的会话。先用任意设备建立一条会话。</StatusLine></Panel>;
  }

  if (stage === 'preview' && preview !== undefined && previewSelection !== undefined) {
    return (
      <section>
        <SharePreviewPanel preview={preview} selection={previewSelection} at={previewAt} />
        {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
          <Button id="chdsh-share-back" onClick={() => setStage('form')}>返回修改</Button>
          <Button id="chdsh-share-confirm" tone="primary" disabled={busy} onClick={submit}>
            {busy ? '正在生成…' : '确认发布分享链接'}
          </Button>
        </div>
      </section>
    );
  }

  if (stage === 'created' && created !== undefined) {
    const url = shareUrlOf(typeof location === 'undefined' ? 'http://127.0.0.1' : location.origin, created.path);
    return (
      <Panel title="分享已建立" subtitle="链接持有者可以阅读固定快照。源会话之后的新内容不会加入这条分享。">
        <dl style={{ margin: '0 0 8px', display: 'grid', gap: '6px' }}>
          <div>
            <dt style={{ margin: 0, color: 'var(--chatdsh-muted)', fontSize: 'var(--cdh-fs-12)' }}>分享地址</dt>
            <dd style={{ margin: 0 }}>
              <input
                ref={urlInput}
                readOnly
                id="chdsh-share-url"
                value={url}
                aria-label="分享地址"
                onFocus={(event) => event.currentTarget.select()}
                style={URL_INPUT}
              />
            </dd>
          </div>
          <div>
            <dt style={{ margin: 0, color: 'var(--chatdsh-muted)', fontSize: 'var(--cdh-fs-12)' }}>有效期</dt>
            <dd style={{ margin: 0 }} data-share-expiry>{describeExpiryAt(created.expiresAt, Date.now())}</dd>
          </div>
          <div>
            <dt style={{ margin: 0, color: 'var(--chatdsh-muted)', fontSize: 'var(--cdh-fs-12)' }}>占用与范围</dt>
            <dd style={{ margin: 0 }} data-share-size>
              {`${describeBytes(created.bytes)} · 回合 ${String(created.scope.turnFrom)} 至 ${String(created.scope.turnTo)} · 事件 ${String(created.scope.eventCount)} 条 · 字符 ${String(created.scope.charCount)} 个`}
            </dd>
          </div>
          <div>
            <dt style={{ margin: 0, color: 'var(--chatdsh-muted)', fontSize: 'var(--cdh-fs-12)' }}>公开附件</dt>
            <dd style={{ margin: 0 }} data-share-attachment-count>
              {created.attachments.length === 0
                ? '没有附件；未勾选的附件不在公开页上'
                : `已复制 ${String(created.attachments.length)} 份：${created.attachments.map((item) => `${item.filename}（${String(item.size)} 字节）`).join('、')}`}
            </dd>
          </div>
        </dl>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <Button
            aria-label="复制分享链接"
            onClick={() => {
              void copyText(url).then((outcome) => {
                setCopyState(outcome);
                gateway.noteAction('share-copy', outcome.ok ? 'ok' : 'failed');
              });
            }}
          >
            复制链接
          </Button>
          <a
            className="chdsh-btn"
            id="chdsh-share-open"
            href={created.path}
            target="_blank"
            rel="noreferrer"
            aria-label="在新窗口打开公开快照"
            onClick={() => gateway.noteAction('share-open', 'ok')}
          >
            打开公开页
          </a>
          <Button id="chdsh-share-restart" onClick={restart}>再建立一条分享</Button>
        </div>
        {copyState !== undefined && !copyState.ok ? (
          <div data-share-copy-fallback>
            <StatusLine tone="danger">{`${copyState.detail}。下面这段文字可以直接选中复制。`}</StatusLine>
            <input
              ref={fallbackInput}
              readOnly
              data-share-copy-text
              aria-label="可手动复制的分享地址"
              value={url}
              onFocus={(event) => event.currentTarget.select()}
              style={URL_INPUT}
            />
          </div>
        ) : (
          <StatusLine>{copyState === undefined ? '复制按钮把分享地址写入剪贴板；写入失败时保留可选择复制的地址文本。' : '已复制到剪贴板。'}</StatusLine>
        )}
        <StatusLine>撤销入口在分享记录里：撤销之后这条链接立即失效。</StatusLine>
      </Panel>
    );
  }

  return (
    <Panel title="创建分享" subtitle="分享固定已确认的内容范围；发布前先看预览，确认没有个人信息与凭据。">
      <Field
        label="源会话"
        required
        help={selected === undefined ? '列出所有设备上的会话。' : `所属设备：${selected.deviceName}${selected.online ? '（在线）' : '（离线）'}`}
        error={failure === '请先选择源会话' ? failure : undefined}
      >
        <select id="chdsh-share-session" value={sessionId} onChange={(event) => loadReplica(event.currentTarget.value)}>
          <option value="">选择一条会话</option>
          {options.map((option) => (
            <option key={`${option.deviceId}/${option.sessionId}`} value={option.sessionId}>
              {`${option.title}（${option.deviceName}）`}
            </option>
          ))}
        </select>
      </Field>

      <Field label="内容范围" required help={MODE_HELP[mode]}>
        <select id="chdsh-share-scope" value={mode} onChange={(event) => setMode(event.currentTarget.value as ScopeMode)}>
          {(Object.keys(MODE_LABELS) as ScopeMode[]).map((key) => (
            <option key={key} value={key}>{MODE_LABELS[key]}</option>
          ))}
        </select>
      </Field>

      {loadingReplica ? <StatusLine>正在读取这份会话的回合与附件…</StatusLine> : null}
      {!loadingReplica && loaded !== undefined && turns.length === 0 ? (
        <StatusLine>这份会话还没有回合，无法建立分享。</StatusLine>
      ) : null}

      {mode === 'turns' ? (
        <fieldset style={CHOICE_GROUP} data-share-turn-choice>
          <legend style={CHOICE_LEGEND}>要公开的完整回合</legend>
          <p style={HELP_TEXT} id="chdsh-share-turns-help">
            逐项勾选回合，空格键切换勾选状态；还没有结束的回合不进入分享。
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '4px' }}>
            <Button id="chdsh-share-turns-all" onClick={() => setChosenTurns(new Set(completeTurns.map((turn) => turn.turn)))}>全选完整回合</Button>
            <Button id="chdsh-share-turns-none" onClick={() => setChosenTurns(new Set())}>清空选择</Button>
          </div>
          <ul style={CHOICE_LIST} aria-describedby="chdsh-share-turns-help">
            {turns.map((turn) => (
              <li key={turn.turn}>
                <label style={CHOICE_LABEL}>
                  <input
                    type="checkbox"
                    id={`chdsh-share-turn-${String(turn.turn)}`}
                    checked={chosenTurns.has(turn.turn)}
                    disabled={!turn.complete}
                    onChange={(event) => {
                      const next = new Set(chosenTurns);
                      if (event.currentTarget.checked) next.add(turn.turn);
                      else next.delete(turn.turn);
                      setChosenTurns(next);
                    }}
                  />
                  <span>
                    {`回合 ${String(turn.turn)} · ${formatTime(turn.startedAt)} · 助手消息 ${String(turn.assistantCount)} 条${turn.complete ? '' : '（进行中，不能分享）'}`}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {mode === 'range' ? (
        <>
          <Field label="起始回合" required help="区间内的完整回合进入快照。">
            <select id="chdsh-share-turn-from" value={fromTurn} onChange={(event) => setFromTurn(event.currentTarget.value)}>
              <option value="">选择起始回合</option>
              {completeTurns.map((turn) => (
                <option key={turn.turn} value={String(turn.turn)}>{`回合 ${String(turn.turn)} · ${formatTime(turn.startedAt)}`}</option>
              ))}
            </select>
          </Field>
          <Field label="结束回合" required help="结束回合不能早于起始回合。">
            <select id="chdsh-share-turn-to" value={toTurn} onChange={(event) => setToTurn(event.currentTarget.value)}>
              <option value="">选择结束回合</option>
              {completeTurns.map((turn) => (
                <option key={turn.turn} value={String(turn.turn)}>{`回合 ${String(turn.turn)} · ${formatTime(turn.startedAt)}`}</option>
              ))}
            </select>
          </Field>
        </>
      ) : null}

      {mode === 'bound' ? (
        <Field label="截止到的完整回合" required help="该回合及之前的完整回合进入快照。">
          <select id="chdsh-share-bound-turn" value={boundTurn} onChange={(event) => setBoundTurn(event.currentTarget.value)}>
            <option value="">选择截止回合</option>
            {completeTurns.map((turn) => (
              <option key={turn.turn} value={String(turn.turn)}>{`回合 ${String(turn.turn)} · ${formatTime(turn.startedAt)}`}</option>
            ))}
          </select>
        </Field>
      ) : null}

      <fieldset style={CHOICE_GROUP} data-share-attachment-choice>
        <legend style={CHOICE_LEGEND}>公开附件</legend>
        <p style={HELP_TEXT} id="chdsh-share-attachments-help">
          勾选要复制进分享包的附件，空格键切换勾选状态。没有勾选的附件不出现在公开页，也无法按路径猜测下载。
        </p>
        {candidates.length === 0 ? (
          <StatusLine>{loaded === undefined ? '先选择源会话，再列出这个范围里的附件。' : '这个范围里没有附件。'}</StatusLine>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '4px' }}>
              <Button id="chdsh-share-attachments-all" onClick={() => setChosenAttachments(new Set(candidates.map((candidate) => candidate.id)))}>
                {`全选附件（${String(candidates.length)}）`}
              </Button>
              <Button id="chdsh-share-attachments-none" onClick={() => setChosenAttachments(new Set())}>清空附件选择</Button>
            </div>
            <ul style={CHOICE_LIST} aria-describedby="chdsh-share-attachments-help" data-share-attachment-list>
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <label style={CHOICE_LABEL}>
                    <input
                      type="checkbox"
                      id={`chdsh-share-attachment-${candidate.id}`}
                      checked={chosenAttachments.has(candidate.id)}
                      onChange={(event) => {
                        const next = new Set(chosenAttachments);
                        if (event.currentTarget.checked) next.add(candidate.id);
                        else next.delete(candidate.id);
                        setChosenAttachments(next);
                      }}
                    />
                    <span>{`${candidate.filename}（${attachmentSizeLabel(candidate.size)}${candidate.mimeType === undefined ? '' : ` · ${candidate.mimeType}`}）`}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div data-share-attachment-summary>
              <StatusLine>
                {`已勾选 ${String(candidates.filter((candidate) => chosenAttachments.has(candidate.id)).length)} 份附件；其余 ${String(candidates.filter((candidate) => !chosenAttachments.has(candidate.id)).length)} 份不进入分享包。`}
              </StatusLine>
            </div>
          </>
        )}
      </fieldset>

      <fieldset style={CHOICE_GROUP} data-share-text-choice>
        <legend style={CHOICE_LEGEND}>公开文本</legend>
        <p style={HELP_TEXT} id="chdsh-share-text-help">至少保留一种文本；工具参数与结果原文、记忆内容与内部路径始终不公开。</p>
        <ul style={CHOICE_LIST} aria-describedby="chdsh-share-text-help">
          <li>
            <label style={CHOICE_LABEL}>
              <input
                type="checkbox"
                id="chdsh-share-include-user"
                checked={includeUserText}
                onChange={(event) => setIncludeUserText(event.currentTarget.checked)}
              />
              <span>用户消息</span>
            </label>
          </li>
          <li>
            <label style={CHOICE_LABEL}>
              <input
                type="checkbox"
                id="chdsh-share-include-assistant"
                checked={includeAssistantText}
                onChange={(event) => setIncludeAssistantText(event.currentTarget.checked)}
              />
              <span>助手消息</span>
            </label>
          </li>
        </ul>
      </fieldset>

      <Field label="有效期" help="到期后公开页返回失效页面，链接不再可读。">
        <select id="chdsh-share-ttl" value={ttlId} onChange={(event) => setTtlId(event.currentTarget.value)}>
          {TTL_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </Field>

      <StatusLine>默认只分享用户与助手的可见文本；相关记忆、工具参数、内部路径与敏感元数据不进入分享。</StatusLine>
      <StatusLine>口令保护：控制平面当前的分享接口没有口令字段，本次分享不支持口令；分享地址本身就是访问凭据。</StatusLine>
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <Button id="chdsh-share-preview" tone="primary" disabled={busy || loadingReplica} onClick={openPreview}>
          {busy ? '正在请求预览…' : '预览快照'}
        </Button>
      </div>
      {turns.length === 0 ? null : (
        <StatusLine>{`这份会话有 ${String(completeTurns.length)} 个完整回合、${String(candidates.length)} 份附件候选。`}</StatusLine>
      )}
    </Panel>
  );
}
