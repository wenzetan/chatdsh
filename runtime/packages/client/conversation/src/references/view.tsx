/**
 * 引用条：显示输入区里的引用对象、失效原因与移除入口。
 *
 * 失效的引用保留在输入区并标注原因，提供重新选择与移除两个动作，界面不会静默删除用户的
 * 选择。移除之后焦点交给相邻引用或引用条本身。
 * @module @chatdsh/client-conversation/references/view
 */

import { useRef } from 'react';
import { Button } from '@chatdsh/core-ui-kit';
import { describeReference, REFERENCE_KIND_TEXT, type ReferenceObject, type ReferenceObjectKind } from './references.ts';

/** 引用条属性。 */
export interface ReferenceStripProps {
  readonly references: readonly ReferenceObject[];
  readonly onRemove: (id: string) => void;
  readonly onReselect: (kind: ReferenceObjectKind) => void;
  readonly label?: string;
}

/**
 * 引用条。
 * @param props - 引用对象与处理函数。
 * @returns 引用条元素；没有引用时返回 `null`。
 */
export function ReferenceStrip(props: ReferenceStripProps) {
  const list = useRef<HTMLUListElement>(null);
  if (props.references.length === 0) return null;
  const remove = (reference: ReferenceObject) => {
    const order = props.references.map((item) => item.id);
    const index = order.indexOf(reference.id);
    const neighbor = order[index + 1] ?? order[index - 1];
    props.onRemove(reference.id);
    if (neighbor !== undefined) {
      const target = list.current?.querySelector<HTMLButtonElement>(`[data-reference-id="${neighbor}"]`);
      target?.focus();
    } else {
      list.current?.focus();
    }
  };
  return <ul className="chdsh-conv__chips" ref={list} tabIndex={-1} aria-label={props.label ?? '引用对象'}>
    {props.references.map((reference) => <li key={`${reference.kind}:${reference.id}`}>
      <span
        className={`chdsh-conv__chip${reference.available ? '' : ' chdsh-conv__chip--invalid'}`}
        data-reference-kind={reference.kind}
        data-reference-available={reference.available ? 'true' : 'false'}
        title={describeReference(reference)}
      >
        <span>{REFERENCE_KIND_TEXT[reference.kind]}：{reference.label}</span>
        {reference.available ? null : <span data-reference-invalid>（{describeReference(reference)}）</span>}
        {reference.available
          ? null
          : <Button tone="danger" onClick={() => props.onReselect(reference.kind)}>重新选择</Button>}
        <Button
          data-reference-id={reference.id}
          onClick={() => remove(reference)}
          aria-label={`移除引用 ${reference.label}`}
        >移除</Button>
      </span>
    </li>)}
  </ul>;
}
