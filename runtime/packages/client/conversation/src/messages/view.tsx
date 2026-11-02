/**
 * 消息区的界面组件。
 *
 * 组件只负责呈现投影结果：文本按片段渲染，思考与轨迹默认折叠，工具卡片显示名称、状态、耗时
 * 与参数摘要，结果超过展示上限时给出字节数与完整读取入口，消息带时刻、状态与执行来源。消息
 * 反馈（赞、踩、复制）与「有新消息」入口也在这一层。
 *
 * Markdown 渲染由宿主注入渲染器：注入时按渲染器输出呈现，没有注入时按原始文本呈现并保留
 * 复制入口，因此解析失败不会丢失可读内容。
 * @module @chatdsh/client-conversation/messages/view
 */

import { useState, type ReactNode, type RefObject } from 'react';
import { Badge, Button } from '@chatdsh/core-ui-kit';
import {
  EXECUTION_SOURCE_TEXT,
  MESSAGE_STATUS_TEXT,
  formatMessageTime,
  segmentsText,
  type MessageEntry,
  type MessageSegment,
  type ReasoningSegment,
  type ToolSegment,
  type TraceEntry,
} from './model.ts';
import {
  FEEDBACK_REASON_TEXT,
  FEEDBACK_REASONS,
  type FeedbackRating,
  type FeedbackReason,
  type FeedbackState,
} from './feedback.ts';
import type { MessageWindow } from './paging.ts';

/** 宿主的 Markdown 渲染器。 */
export type MarkdownRenderer = (text: string) => ReactNode;

/** 角色名称。 */
const ROLE_TEXT: Readonly<Record<MessageEntry['role'], string>> = {
  user: '你',
  assistant: '助手',
  system: '系统',
  developer: '系统指令',
};

/** 消息区的外部依赖。 */
export interface MessageListHandlers {
  readonly renderMarkdown?: MarkdownRenderer;
  readonly feedbackOf: (messageId: string) => FeedbackState;
  readonly onRate: (messageId: string, rating: FeedbackRating) => void;
  readonly onReason: (messageId: string, reason: FeedbackReason) => void;
  readonly onNote: (messageId: string, note: string) => void;
  readonly onSubmitFeedback: (messageId: string) => void;
  readonly onCopy: (messageId: string, text: string) => void;
  readonly copiedAt: (messageId: string) => number | undefined;
  readonly copyFailure?: { readonly messageId: string; readonly detail: string };
}

/**
 * 渲染一段消息正文。
 * @param text - 正文。
 * @param renderMarkdown - 宿主的 Markdown 渲染器。
 * @returns 正文元素。
 */
function MessageText({ text, renderMarkdown }: { readonly text: string; readonly renderMarkdown?: MarkdownRenderer }) {
  if (renderMarkdown !== undefined) {
    return <div className="chdsh-conv__body" data-markdown="host">{renderMarkdown(text)}</div>;
  }
  return <p className="chdsh-conv__body" data-markdown="plain">{text}</p>;
}

/** 思考片段：默认折叠。 */
function ThinkingBlock({ segment }: { readonly segment: ReasoningSegment }) {
  const [open, setOpen] = useState(!segment.collapsed);
  return <details className="chdsh-conv__thinking" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>思考（{segment.text.length} 字符）</summary>
    <p className="chdsh-conv__body">{segment.text}</p>
  </details>;
}

/** 工具卡片。 */
function ToolCard({ segment }: { readonly segment: ToolSegment }) {
  const [showArguments, setShowArguments] = useState(false);
  const [showFullResult, setShowFullResult] = useState(false);
  const statusTone = segment.status === 'failed' ? 'danger' : segment.status === 'running' ? 'warn' : 'ok';
  const statusText = segment.status === 'failed' ? '失败' : segment.status === 'running' ? '运行中' : '完成';
  const result = segment.result;
  return <article className="chdsh-conv__tool" aria-label={`工具调用 ${segment.name}`}>
    <div className="chdsh-conv__toolhead">
      <span className="chdsh-conv__toolname">{segment.name}</span>
      <Badge tone={statusTone}>{statusText}</Badge>
      {segment.durationMs === undefined ? null : <span className="chdsh-conv__meta">耗时 {segment.durationMs} 毫秒</span>}
      <span className="chdsh-conv__meta" data-arguments-summary>{segment.argumentsSummary}</span>
      <Button onClick={() => setShowArguments((value) => !value)} aria-expanded={showArguments}>
        {showArguments ? '收起参数' : '查看参数'}
      </Button>
    </div>
    {showArguments
      ? <div role="region" aria-label={`${segment.name} 参数`} tabIndex={0}>
          <pre className="chdsh-conv__code">{segment.argumentsText}</pre>
        </div>
      : null}
    {result === undefined ? null : <div>
      {result.truncated
        ? <p className="chdsh-conv__hint">
            结果共 {result.bytes} 字节，已截断显示；{result.fullReadable ? '可以展开读取完整内容。' : '完整内容需要从源设备读取。'}
          </p>
        : null}
      {result.errorCode === undefined ? null : <p className="chdsh-conv__hint chdsh-conv__hint--danger">失败原因：{result.errorCode}</p>}
      <div role="region" aria-label={`${segment.name} 结果`} tabIndex={0}>
        <pre className="chdsh-conv__code">{result.text}</pre>
      </div>
      {result.truncated && result.fullReadable
        ? <Button onClick={() => setShowFullResult(true)} disabled={showFullResult} aria-expanded={showFullResult}>
            {showFullResult ? '完整内容已展开' : '读取完整结果'}
          </Button>
        : null}
      {showFullResult && result.truncated ? <FullResult text={result.fullText} name={segment.name} /> : null}
    </div>}
  </article>;
}

/**
 * 完整结果区域。
 *
 * 完整正文由消息投影保留在本地，展开时把完整文本交给独立的滚动区域呈现。
 * @param props - 展示文本与工具名。
 * @returns 完整结果区域。
 */
function FullResult({ text, name }: { readonly text: string; readonly name: string }) {
  return <div role="region" aria-label={`${name} 完整结果`} tabIndex={0} data-full-result>
    <pre className="chdsh-conv__code">{text}</pre>
  </div>;
}

/** 渲染一个消息片段。 */
function SegmentView({ segment, renderMarkdown }: { readonly segment: MessageSegment; readonly renderMarkdown?: MarkdownRenderer }) {
  switch (segment.kind) {
    case 'text':
      return <MessageText text={segment.text} {...(renderMarkdown === undefined ? {} : { renderMarkdown })} />;
    case 'reasoning':
      return <ThinkingBlock segment={segment} />;
    case 'tool':
      return <ToolCard segment={segment} />;
    case 'attachment':
      return <p className="chdsh-conv__hint">
        附件 {segment.filename ?? segment.attachmentId}
        {segment.mimeType === undefined ? '' : ` · ${segment.mimeType}`}
        {segment.size === undefined ? '' : ` · ${segment.size} 字节`}
      </p>;
  }
}

/** 反馈按钮组。 */
function FeedbackBar({ message, handlers }: { readonly message: MessageEntry; readonly handlers: MessageListHandlers }) {
  const state = handlers.feedbackOf(message.id);
  const text = segmentsText(message.segments);
  const copiedAt = handlers.copiedAt(message.id);
  const failure = handlers.copyFailure?.messageId === message.id ? handlers.copyFailure.detail : undefined;
  return <div className="chdsh-conv__row" data-feedback={state.status}>
    <Button
      onClick={() => {
        handlers.onRate(message.id, 'like');
        handlers.onSubmitFeedback(message.id);
      }}
      aria-pressed={state.rating === 'like'}
      disabled={state.status === 'submitting'}
    >赞</Button>
    <Button
      tone="danger"
      onClick={() => handlers.onRate(message.id, 'dislike')}
      aria-pressed={state.rating === 'dislike'}
      disabled={state.status === 'submitting'}
    >踩</Button>
    <Button onClick={() => handlers.onCopy(message.id, text)} disabled={text === ''}>
      {copiedAt === undefined ? '复制' : '已复制'}
    </Button>
    {state.rating === 'dislike'
      ? <>
          <label className="chdsh-conv__hint">
            原因
            <select
              value={state.reason ?? ''}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value !== '') handlers.onReason(message.id, value as FeedbackReason);
              }}
              aria-label="反馈原因"
            >
              <option value="">请选择原因</option>
              {FEEDBACK_REASONS.map((reason) => <option key={reason} value={reason}>{FEEDBACK_REASON_TEXT[reason]}</option>)}
            </select>
          </label>
          <label className="chdsh-conv__hint">
            说明
            <textarea
              value={state.note ?? ''}
              onChange={(event) => handlers.onNote(message.id, event.currentTarget.value)}
              aria-label="反馈说明"
              rows={2}
            />
          </label>
          <Button
            tone="primary"
            onClick={() => handlers.onSubmitFeedback(message.id)}
            disabled={state.status === 'submitting' || state.reason === undefined}
          >{state.status === 'submitting' ? '正在提交' : '提交反馈'}</Button>
        </>
      : null}
    {state.status === 'submitted' ? <span className="chdsh-conv__hint" role="status">反馈已提交</span> : null}
    {state.status === 'failed' ? <span className="chdsh-conv__hint chdsh-conv__hint--danger" role="alert">
      反馈提交失败{state.failureCode === undefined ? '' : `（${state.failureCode}）`}，内容已保留
    </span> : null}
    {failure === undefined ? null : <span className="chdsh-conv__hint chdsh-conv__hint--danger" role="alert">{failure}</span>}
  </div>;
}

/** 一条消息。 */
function MessageCard({ message, handlers }: { readonly message: MessageEntry; readonly handlers: MessageListHandlers }) {
  const status = MESSAGE_STATUS_TEXT[message.status];
  return <article
    className={`chdsh-conv__msg chdsh-conv__msg--${message.role}${message.status === 'streaming' ? ' chdsh-conv__msg--streaming' : ''}${message.status === 'failed' ? ' chdsh-conv__msg--failed' : ''}`}
    aria-label={`${ROLE_TEXT[message.role]}消息`}
    data-message-id={message.id}
    data-status={message.status}
  >
    <div className="chdsh-conv__msgmeta">
      <span className="chdsh-conv__role">{ROLE_TEXT[message.role]}</span>
      <span>{EXECUTION_SOURCE_TEXT[message.source]}</span>
      <time dateTime={new Date(message.at).toISOString()}>{formatMessageTime(message.at)}</time>
      <span data-status-text>{status}</span>
      {message.interrupted === true ? <Badge tone="warn">输出被中断</Badge> : null}
    </div>
    {message.segments.map((segment, index) => (
      <SegmentView key={`${message.id}:${String(index)}`} segment={segment} {...(handlers.renderMarkdown === undefined ? {} : { renderMarkdown: handlers.renderMarkdown })} />
    ))}
    <FeedbackBar message={message} handlers={handlers} />
  </article>;
}

/** 轨迹面板：默认折叠。 */
export function TracePanel({ trace }: { readonly trace: readonly TraceEntry[] }) {
  if (trace.length === 0) return null;
  return <details className="chdsh-conv__trace">
    <summary>执行轨迹（{trace.length} 条）</summary>
    <ol>
      {trace.map((entry) => <li key={entry.id} className="chdsh-conv__traceitem" data-trace-kind={entry.kind}>
        {formatMessageTime(entry.at)} · {entry.label}
      </li>)}
    </ol>
  </details>;
}

/** 消息区属性。 */
export interface MessageListProps {
  readonly messages: readonly MessageEntry[];
  readonly window: MessageWindow;
  readonly handlers: MessageListHandlers;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly onScroll: () => void;
  /** 「有新消息」入口文字；没有新消息时缺省。 */
  readonly newMessages?: string;
  readonly onShowNewMessages: () => void;
  readonly onLoadOlder?: () => void;
  /** 实时播报区域的文本。 */
  readonly announcement?: string;
  /** 播报是否暂停。 */
  readonly announcementsPaused: boolean;
}

/**
 * 消息区。
 *
 * 消息列表是 `role=log`，实时播报由独立的礼貌区域承担，因此流式输出不会逐片段打断读屏。
 * @param props - 消息、窗口、处理函数与滚动引用。
 * @returns 消息区元素。
 */
export function MessageList(props: MessageListProps) {
  const visible = props.window.startIndex < 0
    ? []
    : props.messages.slice(props.window.startIndex, props.window.endIndex + 1);
  return <section className="chdsh-conv__messages" ref={props.scrollRef} onScroll={props.onScroll}
    role="log" aria-label="消息" aria-live="off" tabIndex={0} data-message-count={props.messages.length}>
    {props.window.hasOlder && props.onLoadOlder !== undefined
      ? <Button onClick={props.onLoadOlder}>读取更早的消息</Button>
      : null}
    {visible.map((message) => <MessageCard key={message.id} message={message} handlers={props.handlers} />)}
    {props.newMessages === undefined
      ? null
      : <button type="button" className="chdsh-conv__newmsg" onClick={props.onShowNewMessages}>
          {props.newMessages}
        </button>}
    <p className="chdsh-conv__sr" role="status" aria-live="polite" aria-atomic="true" data-announcer>
      {props.announcementsPaused ? '' : (props.announcement ?? '')}
    </p>
  </section>;
}
