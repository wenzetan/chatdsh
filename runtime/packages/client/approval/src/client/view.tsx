/**
 * 审批界面组件：待处理列表、单张卡片、提问卡片、计划编辑区与统计。
 *
 * 交互约定按无障碍要求固定下来：打开卡片时焦点停在标题上，危险动作排在焦点顺序末尾，Escape
 * 只关闭不提交；圆点、颜色之外还有文字状态；实时播报区始终留在文档里，播报内容来自状态而不是
 * 定时消失的提示。
 * @module @chatdsh/client-approval/view
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { Badge, Button, EmptyState, Panel, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import {
  CARD_STATE_TEXT,
  CHOICE_TEXT,
  RECORD_RESULT_TEXT,
  escalationScopeText,
  groupLines,
  type CardRow,
  type QuestionCardView,
} from './model.ts';
import type { ApprovalController, ApprovalState, PlanEditorState, QuestionRow } from './controller.ts';

/** 一处内联样式。 */
const MUTED: React.CSSProperties = { color: 'var(--chatdsh-muted)', fontSize: 'var(--cdh-fs-12)', margin: 0 };
/** 卡片容器样式。 */
const CARD_BOX: React.CSSProperties = { border: '1px solid var(--chatdsh-border, #d5d5d5)', borderRadius: 8, padding: 10, marginBottom: 8 };
/** 行内操作区样式。 */
const ACTIONS: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 };

/**
 * 取一条卡片的展示行。
 * @param row - 界面行。
 * @returns 文案。
 */
function cardMeta(row: CardRow): string {
  const card = row.card;
  const parts = [
    `设备 ${card.deviceId}`,
    `会话 ${card.sessionId}`,
    card.cwd === undefined ? undefined : `目录 ${card.cwd}`,
    `提出于 ${new Date(card.raisedAt).toLocaleString('zh-CN')}`,
    `失效于 ${new Date(card.expiresAt).toLocaleString('zh-CN')}`,
    `能力范围 ${card.capabilityScope}`,
  ];
  return parts.filter((part): part is string => part !== undefined).join(' · ');
}

/**
 * 一张审批卡片。
 * @param props - 控制器、状态与界面行。
 * @returns 卡片元素。
 */
function ApprovalCard({ controller, state, row }: {
  readonly controller: ApprovalController;
  readonly state: ApprovalState;
  readonly row: CardRow;
}): ReactElement {
  const card = row.card;
  const busy = state.busyCallId === card.callId;
  const open = state.openCallId === card.callId;
  const titleId = `card-${card.callId}-title`;
  return (
    <article
      style={CARD_BOX}
      data-approval-card=""
      data-call-id={card.callId}
      data-state={card.state}
      data-actionable={row.actionable ? 'true' : 'false'}
      aria-labelledby={titleId}
    >
      <h3
        id={titleId}
        tabIndex={-1}
        data-focus-id={titleId}
        style={{ margin: 0, fontSize: 'var(--cdh-fs-14)' }}
        onClick={() => controller.openCard(card.callId)}
      >
        {card.toolName}：{card.summary}
      </h3>
      <p style={MUTED} data-focus-id={`card-${card.callId}-summary`} tabIndex={-1}>
        {cardMeta(row)}
      </p>
      <p style={MUTED}>
        <Badge tone={card.state === 'pending' ? 'warn' : card.state === 'decided' ? 'ok' : 'neutral'}>
          {CARD_STATE_TEXT[card.state]}
        </Badge>
        {card.invalidReason === undefined ? null : <span data-invalid-reason={card.invalidReason}> {card.invalidText}</span>}
        {row.localInvalidReason === undefined ? null : (
          <span data-local-invalid={row.localInvalidReason}> {row.localInvalidText}</span>
        )}
        {card.decidedBy === undefined ? null : <span> · 由 {card.decidedBy} 决定</span>}
      </p>
      {open ? null : (
        <div style={ACTIONS}>
          <Button data-action="open-card" onClick={() => controller.openCard(card.callId)}>查看并决定</Button>
        </div>
      )}
      {open && row.actionable ? (
        <div style={ACTIONS} role="group" aria-label={`${card.toolName} 的决定`}>
          {row.offered.map((choice) => (
            <Button
              key={choice}
              data-action={`decide-${choice}`}
              data-focus-id={`card-${card.callId}-choice-${choice}`}
              tone={choice === 'deny' ? 'danger' : 'primary'}
              disabled={busy}
              onClick={() => controller.requestChoice(card.callId, choice)}
            >
              {CHOICE_TEXT[choice]}
            </Button>
          ))}
        </div>
      ) : null}
      {open && state.escalation?.callId === card.callId ? (
        <div role="alertdialog" aria-label="确认扩大审批范围" data-escalation={state.escalation.choice} style={{ marginTop: 8 }}>
          <p style={{ margin: 0 }}>
            确认要{CHOICE_TEXT[state.escalation.choice]}吗？{escalationScopeText(state.escalation.choice)}。
          </p>
          <div style={ACTIONS}>
            <Button data-action="confirm-escalation" tone="primary" onClick={() => void controller.confirmEscalation()}>确认</Button>
            <Button data-action="cancel-escalation" onClick={() => controller.cancelEscalation()}>取消</Button>
          </div>
        </div>
      ) : null}
      {row.actionable ? (
        <div style={ACTIONS}>
          <Button
            data-action="jump-session"
            data-focus-id={`card-${card.callId}-jump`}
            onClick={() => controller.jumpToSession(card.sessionId)}
          >
            打开会话
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * 提问卡片。
 * @param props - 控制器与一行提问。
 * @returns 卡片元素。
 */
function QuestionCard({ controller, row }: {
  readonly controller: ApprovalController;
  readonly row: QuestionRow;
}): ReactElement {
  const card: QuestionCardView = row.card;
  const titleId = `question-${card.callId}-title`;
  const options = (question: QuestionCardView['questions'][number]): ReactElement[] => question.options.map((option) => {
    const selected = (row.draft.selections[question.id] ?? []).includes(option.label);
    return (
      <label key={option.label} style={{ display: 'block', marginTop: 4 }}>
        <input
          type={question.multiple ? 'checkbox' : 'radio'}
          name={`${card.callId}-${question.id}`}
          checked={selected}
          data-question-option={option.label}
          onChange={() => controller.selectOption(card.callId, question.id, option.label, question.multiple)}
        />
        <span>{option.label}</span>
        {option.description === undefined ? null : <span style={MUTED}> {option.description}</span>}
      </label>
    );
  });
  return (
    <section style={CARD_BOX} data-question-card="" data-call-id={card.callId} data-kind={card.kind} aria-labelledby={titleId}>
      <h3 id={titleId} tabIndex={-1} data-focus-id={titleId} style={{ margin: 0, fontSize: 'var(--cdh-fs-14)' }}>
        {card.kind === 'plan-review' ? '计划审阅' : '需要回答的提问'}
      </h3>
      <p style={MUTED}>
        <Badge tone="warn">{card.state === 'pending' ? '等待回答' : card.state}</Badge>
        <span> · 会话 {card.sessionId} · 失效于 {new Date(card.expiresAt).toLocaleString('zh-CN')}</span>
      </p>
      {card.planMarkdown === undefined ? null : (
        <pre data-plan-markdown="" style={{ whiteSpace: 'pre-wrap', margin: '8px 0', fontSize: 'var(--cdh-fs-13)' }}>
          {card.planMarkdown}
        </pre>
      )}
      {card.questions.map((question) => (
        <fieldset key={question.id} style={{ border: 'none', padding: 0, margin: '8px 0' }}>
          <legend style={{ fontWeight: 600 }}>
            {question.header === undefined ? question.question : `${question.header}：${question.question}`}
          </legend>
          {question.detail === undefined ? null : <p style={MUTED}>{question.detail}</p>}
          {card.kind === 'plan-review' ? (
            <p style={MUTED}>批准执行与继续规划由下面的计划编辑区提交，这里只说明这次审阅的选项。</p>
          ) : (
            <>
              <div role="group" aria-label={question.question}>{options(question)}</div>
              <label style={{ display: 'block', marginTop: 6 }}>
                <span style={MUTED}>自由输入</span>
                <textarea
                  data-question-free={question.id}
                  value={row.draft.freeText[question.id] ?? ''}
                  onChange={(event) => controller.setFreeText(card.callId, question.id, event.target.value)}
                  rows={2}
                  style={{ width: '100%' }}
                />
              </label>
            </>
          )}
        </fieldset>
      ))}
      {row.problems.length === 0 ? null : (
        <ul role="alert" data-question-problems="">
          {row.problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}
      <div style={ACTIONS}>
        {card.kind === 'plan-review' ? (
          <Button data-action="begin-plan" tone="primary" onClick={() => void controller.beginPlan(card.callId)}>编辑计划</Button>
        ) : (
          <>
            <Button data-action="answer-question" tone="primary" disabled={row.busy} onClick={() => void controller.submitQuestion(card.callId)}>提交答案</Button>
            <Button data-action="skip-question" disabled={row.busy} onClick={() => void controller.skipQuestion(card.callId)}>跳过</Button>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * 计划编辑区。
 *
 * 只有取得编辑租约的一侧可以输入；其他客户端看到只读文本与持有者说明，编辑区保持禁用。
 * @param props - 控制器与编辑区状态。
 * @returns 编辑区元素。
 */
function PlanEditor({ controller, plan }: {
  readonly controller: ApprovalController;
  readonly plan: PlanEditorState;
}): ReactElement {
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (plan.editable) editor.current?.focus();
  }, [plan.editable]);
  return (
    <section style={CARD_BOX} data-plan-editor="" data-editable={plan.editable ? 'true' : 'false'} aria-label="计划编辑区">
      <h4 style={{ margin: 0, fontSize: 'var(--cdh-fs-13)' }}>
        {plan.editable ? '由你编辑这份计划' : '这一处编辑区只读'}
      </h4>
      <p style={MUTED} data-takeover-holder={plan.holderId ?? ''}>
        {plan.editable
          ? '取得编辑租约的一侧可以提交，其他人这一处只读。'
          : plan.reason ?? (plan.holderLabel === undefined ? '尚未取得编辑租约' : `${plan.holderLabel}正在编辑`)}
        {plan.dirty ? ' · 草稿尚未写回宿主' : ''}
      </p>
      <textarea
        ref={editor}
        data-plan-text=""
        value={plan.text}
        readOnly={!plan.editable}
        disabled={!plan.editable}
        rows={8}
        style={{ width: '100%', fontFamily: 'monospace' }}
        onChange={(event) => controller.editPlan(event.target.value)}
      />
      {plan.failure === undefined ? null : <p role="alert" data-plan-failure="">{plan.failure}</p>}
      <div style={ACTIONS}>
        <Button data-action="save-plan-draft" disabled={!plan.editable || plan.submitting} onClick={() => void controller.savePlan()}>保存草稿</Button>
        <Button data-action="approve-plan" tone="primary" disabled={!plan.editable || plan.submitting} onClick={() => void controller.submitPlan('approve')}>批准执行</Button>
        <Button data-action="revise-plan" disabled={!plan.editable || plan.submitting} onClick={() => void controller.submitPlan('revise')}>提交修改意见</Button>
        <Button data-action="release-plan" disabled={!plan.editable} onClick={() => void controller.releasePlan()}>释放编辑区</Button>
      </div>
    </section>
  );
}

/**
 * 统计与最近决定。
 * @param props - 状态。
 * @returns 面板元素。
 */
function StatsPanel({ state }: { readonly state: ApprovalState }): ReactElement {
  const stats = state.stats;
  if (stats === undefined) return <Panel title="审批统计"><Skeleton rows={2} /></Panel>;
  return (
    <Panel title="审批统计" subtitle={`统计截至 ${new Date(stats.readAt).toLocaleString('zh-CN')}`}>
      <p data-stats="" style={{ margin: 0 }}>
        <span data-stats-approved={String(stats.approved)}>批准 {stats.approved}</span>
        <span> · </span>
        <span data-stats-denied={String(stats.denied)}>拒绝 {stats.denied}</span>
        <span> · </span>
        <span data-stats-timeout={String(stats.timeout)}>超时 {stats.timeout}</span>
        <span> · </span>
        <span data-stats-auto={String(stats.autoApproved)}>按策略自动批准 {stats.autoApproved}</span>
        <span> · </span>
        <span data-stats-pending={String(stats.pending)}>仍在等待 {stats.pending}</span>
      </p>
      <h4 style={{ marginBottom: 4, fontSize: 'var(--cdh-fs-13)' }}>最近的决定</h4>
      {stats.recent.length === 0 ? <p style={MUTED}>还没有决定记录。</p> : (
        <ol data-recent-decisions="" style={{ margin: 0, paddingLeft: 18 }}>
          {stats.recent.map((record) => (
            <li key={`${record.callId}-${String(record.decidedAt)}`} data-recent-call={record.callId}>
              {RECORD_RESULT_TEXT[record.result]} · {record.toolName} · 会话 {record.sessionId} · {record.decidedBy} · {new Date(record.decidedAt).toLocaleString('zh-CN')}
            </li>
          ))}
        </ol>
      )}
      {state.policies.length === 0 ? null : (
        <>
          <h4 style={{ marginBottom: 4, fontSize: 'var(--cdh-fs-13)' }}>生效中的策略</h4>
          <ul data-policies="" style={{ margin: 0, paddingLeft: 18 }}>
            {state.policies.map((policy) => (
              <li key={policy.id} data-policy={policy.id}>{policy.description}</li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/**
 * 实时播报区。
 * @param props - 播报状态。
 * @returns 播报元素。
 */
function Announcer({ state }: { readonly state: ApprovalState }): ReactElement {
  const announcement = state.announcement;
  return (
    <>
      <div data-announcer="" role="status" aria-live="polite" aria-atomic="true" style={{ minHeight: 1 }}>
        {announcement !== undefined && !announcement.urgent ? announcement.text : ''}
      </div>
      <div data-announcer-urgent="" role="alert" aria-atomic="true" style={{ minHeight: 1 }}>
        {announcement !== undefined && announcement.urgent ? announcement.text : ''}
      </div>
    </>
  );
}

/**
 * 审批面板：待处理列表、提问卡片、计划编辑区与统计。
 * @param props - 控制器与状态。
 * @returns 面板元素。
 */
export function ApprovalPanel({ controller, state }: {
  readonly controller: ApprovalController;
  readonly state: ApprovalState;
}): ReactElement {
  const focused = useRef<string | undefined>(undefined);
  useEffect(() => {
    const target = state.focusTarget;
    if (target === undefined || focused.current === target) return;
    focused.current = target;
    const element = document.querySelector<HTMLElement>(`[data-focus-id="${target}"]`);
    controller.takeFocusTarget();
    element?.focus();
  }, [controller, state.focusTarget]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const intent = controller.handleKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (intent !== 'none') event.preventDefault();
  };

  const questions = state.questions.filter((row) => row.card.state === 'pending');
  return (
    <div data-approval-panel="" data-online={state.online ? 'true' : 'false'} onKeyDown={onKeyDown}>
      <Announcer state={state} />
      {state.failure === undefined ? null : <StatusLine tone="danger">{state.failure}</StatusLine>}
      {state.notice === undefined ? null : (
        <p data-notice={state.notice.tone} role={state.notice.tone === 'danger' ? 'alert' : 'status'} style={{ margin: '0 0 8px' }}>
          {state.notice.text}
        </p>
      )}
      {state.conflictText === undefined ? null : <p data-conflict="" role="alert">{state.conflictText}</p>}
      {state.online ? null : <p data-offline="" role="status">设备离线：列表只读，决定与提交都不会发出。</p>}
      <Panel
        title="待处理审批"
        count={`${String(state.actionable)} 待处理`}
        subtitle={state.scope === 'global' ? '全部设备、全部会话的待处理卡片，按会话与工具分组' : '本会话内的审批'}
      >
        <div style={ACTIONS} role="tablist" aria-label="列表过滤">
          {(['waiting', 'handled', 'all'] as const).map((filter) => (
            <Button
              key={filter}
              data-filter={filter}
              aria-pressed={state.filter === filter}
              onClick={() => void controller.setFilter(filter)}
            >
              {filter === 'waiting' ? '等待中' : filter === 'handled' ? '已处理' : '全部'}
            </Button>
          ))}
          <Button data-action="refresh" onClick={() => void controller.refresh()}>刷新</Button>
        </div>
        {!state.loaded ? <Skeleton rows={3} /> : state.rows.length === 0 ? <EmptyState>没有待处理的审批。</EmptyState> : (
          <>
            <div data-approval-groups="" style={{ margin: '8px 0' }}>
              {groupLines(state.groups).map((line) => <p key={line} data-approval-group-line="" style={MUTED}>{line}</p>)}
            </div>
            {state.rows.map((row) => (
              <ApprovalCard key={row.card.callId} controller={controller} state={state} row={row} />
            ))}
          </>
        )}
      </Panel>
      {questions.length === 0 ? null : (
        <Panel title="提问与计划" count={`${String(questions.length)} 待回答`}>
          {questions.map((row) => <QuestionCard key={row.card.callId} controller={controller} row={row} />)}
        </Panel>
      )}
      {state.plan === undefined ? null : <PlanEditor controller={controller} plan={state.plan} />}
      <StatsPanel state={state} />
    </div>
  );
}
