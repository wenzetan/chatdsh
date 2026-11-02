/**
 * 输入区界面。
 *
 * 组合输入框把组合事件、快捷键、字数、引用与附件条目串起来：组合期间只显示组合缓冲，正文与
 * 字数不变；Enter 发送、Shift+Enter 换行、Escape 请求停止或清空；超限时给出当前长度与上限；
 * 附件条目显示名称、类型、大小、进度与状态，未完成上传时阻止发送。
 *
 * 附件选择与上传由工作区工具包提供，这里只保留条目与阻止发送的规则；宿主没有接入附件入口
 * 时按钮禁用并说明原因。
 * @module @chatdsh/client-conversation/composer/view
 */

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Badge, Button } from '@chatdsh/core-ui-kit';
import { ReferenceStrip } from '../references/view.tsx';
import type { ReferenceObject, ReferenceObjectKind } from '../references/references.ts';
import {
  ATTACHMENT_STATE_TEXT,
  SEND_BLOCKER_TEXT,
  type AttachmentSlot,
  type ComposerSnapshot,
  type SendCheck,
} from './state.ts';
import { RUN_STATE_TEXT, type RunState } from '../messages/run.ts';

/** 输入区属性。 */
export interface ComposerProps {
  readonly snapshot: ComposerSnapshot;
  readonly sendCheck: SendCheck;
  readonly runState: RunState;
  readonly onTextChange: (text: string, selectionStart: number, selectionEnd: number) => void;
  readonly onSelectionChange: (start: number, end: number) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionUpdate: (data: string) => void;
  readonly onCompositionEnd: (data: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onRemoveReference: (id: string) => void;
  readonly onReselectReference: (kind: ReferenceObjectKind) => void;
  /** 附件入口；宿主没有接入时缺省。 */
  readonly onAttachRequest?: () => void;
  /** 附件入口不可用的原因。 */
  readonly attachUnavailableReason?: string;
  /** 操作结果提示。 */
  readonly notice?: string;
  /** 失败提示。 */
  readonly failure?: string;
  /** 触发面板等覆盖在输入区上方的元素。 */
  readonly children?: ReactNode;
  /** 输入区文本域引用，供焦点管理使用。 */
  readonly inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

/** 一个附件条目。 */
function AttachmentRow({ slot, onRemove }: { readonly slot: AttachmentSlot; readonly onRemove: (id: string) => void }) {
  return <li className="chdsh-conv__queueitem" data-attachment-state={slot.state}>
    <span className="chdsh-conv__queuetext">
      {slot.filename} · {slot.mimeType} · {slot.size} 字节 · {ATTACHMENT_STATE_TEXT[slot.state]}
      {slot.state === 'uploading' ? ` · ${String(Math.round(slot.progress * 100))}%` : ''}
    </span>
    {slot.state === 'uploading' ? <progress value={slot.progress} max={1} aria-label={`${slot.filename} 上传进度`} /> : null}
    <Button onClick={() => onRemove(slot.id)} aria-label={`移除附件 ${slot.filename}`}>移除</Button>
  </li>;
}

/**
 * 输入区。
 * @param props - 快照、检查结论与处理函数。
 * @returns 输入区元素。
 */
export function ComposerBox(props: ComposerProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const lengthId = `${id}-length`;
  const blockerId = `${id}-blocker`;
  const report = {
    length: props.snapshot.text.length,
    max: props.snapshot.maxLength,
  };
  const exceeded = report.length > report.max;
  const localInput = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const node = localInput.current;
    if (node === null || props.snapshot.composing) return;
    if (node.value === props.snapshot.text) return;
    node.value = props.snapshot.text;
  }, [props.snapshot.text, props.snapshot.composing]);
  const describing = [lengthId, props.sendCheck.canSend ? undefined : blockerId].filter(Boolean).join(' ');
  return <section className="chdsh-conv__composer" aria-label="输入区">
    <ReferenceStrip
      references={props.snapshot.references as readonly ReferenceObject[]}
      onRemove={props.onRemoveReference}
      onReselect={props.onReselectReference}
    />
    <ul className="chdsh-conv__chips" aria-label="附件">
      {props.snapshot.attachments.map((slot) => (
        <AttachmentRow key={slot.id} slot={slot} onRemove={props.onRemoveAttachment} />
      ))}
    </ul>
    <textarea
      id={inputId}
      ref={(node) => {
        localInput.current = node;
        if (props.inputRef !== undefined) props.inputRef.current = node;
      }}
      className="chdsh-conv__input"
      defaultValue={props.snapshot.text}
      aria-label="消息输入"
      aria-invalid={exceeded || undefined}
      aria-describedby={describing}
      placeholder="Enter 发送，Shift+Enter 换行，/ 命令，@ 引用"
      onChange={(event) => {
        const native = event.nativeEvent as InputEvent;
        if (native.isComposing === true || props.snapshot.composing) return;
        props.onTextChange(
          event.currentTarget.value,
          event.currentTarget.selectionStart ?? 0,
          event.currentTarget.selectionEnd ?? 0
        );
      }}
      onSelect={(event) => props.onSelectionChange(
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0
      )}
      onKeyDown={props.onKeyDown}
      onCompositionStart={props.onCompositionStart}
      onCompositionUpdate={(event) => props.onCompositionUpdate(event.data)}
      onCompositionEnd={(event) => props.onCompositionEnd(event.data)}
      data-composing={props.snapshot.composing ? 'true' : 'false'}
      data-composition-buffer={props.snapshot.compositionBuffer}
    />
    <div className="chdsh-conv__row">
      <p id={lengthId} className={`chdsh-conv__hint${exceeded ? ' chdsh-conv__hint--danger' : ''}`} data-length>
        {report.length} / {report.max}
      </p>
      {props.sendCheck.canSend ? null : <p id={blockerId} className="chdsh-conv__hint chdsh-conv__hint--danger" data-blocker>
        {props.sendCheck.reason ?? SEND_BLOCKER_TEXT.empty}
      </p>}
      <span className="chdsh-conv__meta" data-run-state>{RUN_STATE_TEXT[props.runState]}</span>
      <Button tone="primary" onClick={props.onSend} disabled={!props.sendCheck.canSend} data-action="send">发送</Button>
      <Button
        tone="danger"
        onClick={props.onStop}
        disabled={props.runState === 'idle' || props.runState === 'stopped'}
        data-action="stop"
      >停止</Button>
      <Button
        onClick={props.onAttachRequest}
        disabled={props.onAttachRequest === undefined}
        data-action="attach"
        title={props.attachUnavailableReason}
      >添加附件</Button>
      {props.onAttachRequest === undefined
        ? <Badge tone="neutral">{props.attachUnavailableReason ?? '附件入口由工作区工具包提供'}</Badge>
        : null}
    </div>
    {props.notice === undefined ? null : <p className="chdsh-conv__hint" role="status">{props.notice}</p>}
    {props.failure === undefined ? null : <p className="chdsh-conv__hint chdsh-conv__hint--danger" role="alert">{props.failure}</p>}
    {props.children}
  </section>;
}
