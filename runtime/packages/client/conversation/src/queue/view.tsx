/**
 * 待发送队列界面。
 *
 * 每条条目显示顺序、内容摘要、目标会话与状态，提供编辑、删除与立即发送；队列暂停时给出
 * 原因与恢复入口，恢复只重新读取状态，发送由用户显式触发。编辑保留原条目标识，因此重新
 * 提交仍然使用同一个幂等键。
 * @module @chatdsh/client-conversation/queue/view
 */

import { useState } from 'react';
import { Badge, Button } from '@chatdsh/core-ui-kit';
import { QUEUE_STATE_TEXT, type QueueSnapshot } from './queue.ts';

/** 队列面板属性。 */
export interface QueuePanelProps {
  readonly snapshot: QueueSnapshot;
  readonly onEdit: (id: string, text: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onSendNext: () => void;
  /** 操作结果提示。 */
  readonly notice?: string;
  /** 失败提示。 */
  readonly failure?: string;
}

/** 摘要长度上限。 */
const SUMMARY_MAX = 60;

/**
 * 生成一条待发送内容的摘要。
 * @param text - 正文。
 * @returns 单行摘要。
 */
export function queueSummary(text: string): string {
  const single = text.replaceAll(/\s+/g, ' ').trim();
  return single.length <= SUMMARY_MAX ? single : `${single.slice(0, SUMMARY_MAX)}…`;
}

/**
 * 队列面板。
 * @param props - 快照与处理函数。
 * @returns 面板元素。
 */
export function QueuePanel(props: QueuePanelProps) {
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | undefined>(undefined);
  if (props.snapshot.items.length === 0) return null;
  const commit = () => {
    if (editing === undefined) return;
    props.onEdit(editing.id, editing.text);
    setEditing(undefined);
  };
  return <section className="chdsh-conv__queue" aria-label="待发送队列" data-queue-state={props.snapshot.paused ? 'paused' : 'active'}>
    <div className="chdsh-conv__row">
      <h2 className="chdsh-conv__title">待发送队列</h2>
      <Badge tone={props.snapshot.paused ? 'warn' : 'neutral'}>
        {props.snapshot.pendingCount} 待发送 · {props.snapshot.confirmedCount} 已确认
      </Badge>
      {props.snapshot.paused
        ? <>
            <span className="chdsh-conv__hint chdsh-conv__hint--danger">
              队列已暂停：{props.snapshot.pauseReason ?? '连接中断'}
            </span>
            <Button onClick={props.onResume} data-action="queue-resume">恢复并重新读取状态</Button>
          </>
        : <Button onClick={props.onPause} data-action="queue-pause">暂停队列</Button>}
      <Button onClick={props.onSendNext} disabled={props.snapshot.paused} data-action="queue-send">
        发送下一条
      </Button>
    </div>
    <ol>
      {props.snapshot.items.map((item, index) => <li key={item.id} className="chdsh-conv__queueitem" data-queue-item={item.id} data-queue-state={item.state}>
        <span className="chdsh-conv__meta">第 {index + 1} 条</span>
        {editing?.id === item.id
          ? <>
              <label className="chdsh-conv__queuetext">
                编辑待发送内容
                <textarea
                  value={editing.text}
                  onChange={(event) => setEditing({ id: item.id, text: event.currentTarget.value })}
                  rows={2}
                  aria-label={`编辑第 ${index + 1} 条待发送内容`}
                />
              </label>
              <Button tone="primary" onClick={commit}>保存</Button>
              <Button onClick={() => setEditing(undefined)}>取消</Button>
            </>
          : <>
              <span className="chdsh-conv__queuetext">{queueSummary(item.text)}</span>
              <span className="chdsh-conv__meta">{item.sessionId}</span>
              <Badge tone={item.state === 'failed' ? 'danger' : item.state === 'unconfirmed' ? 'warn' : 'neutral'}>
                {QUEUE_STATE_TEXT[item.state]}
              </Badge>
              {item.state === 'pending'
                ? <>
                    <Button onClick={() => setEditing({ id: item.id, text: item.text })}>编辑</Button>
                    <Button tone="danger" onClick={() => props.onRemove(item.id)}>删除</Button>
                  </>
                : null}
            </>}
      </li>)}
    </ol>
    {props.notice === undefined ? null : <p className="chdsh-conv__hint" role="status">{props.notice}</p>}
    {props.failure === undefined ? null : <p className="chdsh-conv__hint chdsh-conv__hint--danger" role="alert">{props.failure}</p>}
  </section>;
}
