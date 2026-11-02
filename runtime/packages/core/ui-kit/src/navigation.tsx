import { useEffect, useId, useRef, type ReactNode } from 'react';

/** 模态使用原生 dialog 的背景隔离与焦点约束；关闭恢复实际触发元素。 */
export function Dialog({ open, title, description, onClose, children, drawer = false }: {
  open: boolean; title: string; description?: string; onClose: () => void; children: ReactNode; drawer?: boolean;
}) {
  const reference = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dialog = reference.current;
    if (dialog === null) throw new Error('对话框未挂载');
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [open]);
  return <dialog ref={reference} className={`chdsh-dialog${drawer ? ' chdsh-dialog--drawer' : ''}`}
    aria-labelledby={`${id}-title`} aria-describedby={description === undefined ? undefined : `${id}-description`}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
        .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled, [hidden], [inert]') && element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements.at(-1);
      if (first === undefined) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last!.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onCancel={(event) => { event.preventDefault(); close.current(); }}>
    <header className="chdsh-dialog__head"><h2 id={`${id}-title`}>{title}</h2>
      <button type="button" className="chdsh-btn" onClick={onClose} aria-label={`关闭${title}`}>关闭</button></header>
    {description === undefined ? null : <p id={`${id}-description`}>{description}</p>}
    {children}
  </dialog>;
}

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
  readonly disabledReason?: string;
}

/** 手动激活页签：方向键移动焦点，Enter 或 Space 激活选定页签。 */
export function Tabs({ label, items, selectedId, onSelect }: {
  label: string; items: readonly TabItem[]; selectedId: string; onSelect: (id: string) => void;
}) {
  const id = useId();
  const selected = items.find((item) => item.id === selectedId);
  if (selected === undefined || selected.disabledReason !== undefined) throw new Error('选中页签需要存在并且可用');
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('页签标识不能重复');
  const available = items.filter((item) => item.disabledReason === undefined);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  return <div className="chdsh-tabs">
    <div role="tablist" aria-label={label} className="chdsh-tabs__list">{items.map((item, index) => <button
      key={item.id} ref={(node) => { if (node === null) refs.current.delete(item.id); else refs.current.set(item.id, node); }}
      type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
      aria-selected={item.id === selectedId} disabled={item.disabledReason !== undefined}
      tabIndex={item.id === selectedId ? 0 : -1} title={item.disabledReason}
      className="chdsh-btn" onClick={() => onSelect(item.id)} onKeyDown={(event) => {
        const position = available.findIndex((candidate) => candidate.id === item.id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
          : event.key === 'ArrowRight' ? (position + 1) % available.length
            : event.key === 'ArrowLeft' ? (position - 1 + available.length) % available.length : undefined;
        if (next !== undefined) { event.preventDefault(); refs.current.get(available[next]!.id)?.focus(); }
      }}>{item.label}{item.disabledReason === undefined ? null : `（${item.disabledReason}）`}</button>)}</div>
    {items.map((item, index) => <section key={item.id} role="tabpanel" tabIndex={0} id={`${id}-panel-${index}`}
      aria-labelledby={`${id}-tab-${index}`} hidden={item.id !== selectedId}>{item.content}</section>)}
  </div>;
}
