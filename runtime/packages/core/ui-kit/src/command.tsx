/**
 * 命令面板：受控查询、活动条目导航与结果选择。
 *
 * 查询文本、条目列表与面板开关由宿主控制。活动条目可以由宿主通过 activeId 与
 * onActiveChange 完全接管，也可以交给组件内部维护；Escape 只清空查询，面板的关闭与
 * 焦点恢复由宿主处理。
 * @module @chatdsh/core-ui-kit/command
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface CommandItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly shortcut?: string;
  readonly disabledReason?: string;
}

export interface CommandSurfaceProps {
  label: string;
  query: string;
  items: readonly CommandItem[];
  /** 宿主接管的当前活动条目，必须同时提供 onActiveChange。 */
  activeId?: string;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
  onActiveChange?: (id: string) => void;
  emptyMessage?: string;
  loading?: boolean;
}

function assertItems(items: readonly CommandItem[]) {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.id.trim() === '') throw new Error('命令条目标识不能为空');
    if (item.label.trim() === '') throw new Error('命令条目名称不能为空');
    if (ids.has(item.id)) throw new Error('命令条目标识不能重复');
    ids.add(item.id);
  }
}

/** 禁用条目保留在列表里供读屏读取原因，方向键经过但不响应 Enter。 */
export function CommandSurface({
  label,
  query,
  items,
  activeId,
  onQueryChange,
  onSelect,
  onActiveChange,
  emptyMessage = '没有匹配的命令',
  loading = false,
}: CommandSurfaceProps) {
  if (label.trim() === '') throw new Error('命令面板名称不能为空');
  if (typeof query !== 'string') throw new Error('命令查询必须是字符串');
  if (!Array.isArray(items)) throw new Error('命令条目必须是数组');
  assertItems(items);
  const ids = new Set(items.map((item) => item.id));
  if (activeId !== undefined) {
    if (!ids.has(activeId)) throw new Error('命令面板当前活动条目不在列表中');
    if (onActiveChange === undefined) throw new Error('指定命令活动条目时需要提供 onActiveChange');
  }
  const id = useId();
  const listId = `${id}-list`;
  const inputId = `${id}-input`;
  const [movedId, setMovedId] = useState<string | undefined>(undefined);
  const list = useRef<HTMLUListElement>(null);
  const firstAvailable = items.find((item) => item.disabledReason === undefined)?.id ?? items[0]?.id;
  const active = activeId ?? (movedId !== undefined && ids.has(movedId) ? movedId : firstAvailable);
  const activeIndex = active === undefined ? -1 : items.findIndex((item) => item.id === active);
  const shown = items.length > 0;
  useEffect(() => {
    if (activeIndex < 0) return;
    list.current?.children.item(activeIndex)?.scrollIntoView({ block: 'nearest' });
  });
  const move = (next: string) => {
    if (activeId === undefined) setMovedId(next);
    onActiveChange?.(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      onQueryChange('');
      return;
    }
    if (items.length === 0) return;
    const position = Math.max(0, activeIndex);
    const next = event.key === 'ArrowDown' ? items[(position + 1) % items.length]
      : event.key === 'ArrowUp' ? items[(position - 1 + items.length) % items.length]
        : event.key === 'Home' ? items[0]
          : event.key === 'End' ? items.at(-1)
            : undefined;
    if (next !== undefined) {
      event.preventDefault();
      move(next.id);
      return;
    }
    if (event.key !== 'Enter') return;
    const current = activeIndex < 0 ? undefined : items[activeIndex];
    if (current === undefined || current.disabledReason !== undefined) return;
    event.preventDefault();
    onSelect(current.id);
  };
  return <section className="chdsh-command" role="dialog" aria-label={label} aria-busy={loading ? true : undefined}>
    <input id={inputId} className="chdsh-command__input" type="text" role="combobox"
      autoComplete="off" spellCheck={false} value={query}
      aria-label={`搜索${label}`} aria-autocomplete="list"
      aria-controls={shown ? listId : undefined} aria-expanded={shown}
      aria-activedescendant={activeIndex < 0 ? undefined : `${listId}-option-${activeIndex}`}
      onChange={(event) => onQueryChange(event.currentTarget.value)} onKeyDown={onKeyDown} />
    {loading ? <p className="chdsh-command__hint" role="status" aria-atomic="true">正在加载命令</p> : null}
    {shown ? <ul id={listId} ref={list} role="listbox" aria-label={`${label}结果`} className="chdsh-command__list">
      {items.map((item, index) => {
        const selected = index === activeIndex;
        return <li key={item.id} id={`${listId}-option-${index}`} role="option" aria-selected={selected}
          aria-disabled={item.disabledReason === undefined ? undefined : true}
          className={`chdsh-command__item${selected ? ' chdsh-command__item--active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { if (item.disabledReason === undefined) onSelect(item.id); }}>
          <span className="chdsh-command__title">{item.label}</span>
          {item.description === undefined ? null : <span className="chdsh-command__description">{item.description}</span>}
          {item.shortcut === undefined ? null : <kbd className="chdsh-command__shortcut">{item.shortcut}</kbd>}
          {item.disabledReason === undefined ? null : <span className="chdsh-command__reason">（{item.disabledReason}）</span>}
        </li>;
      })}
    </ul> : loading ? null : <>
      <p className="chdsh-command__empty" role="status" aria-atomic="true">{emptyMessage}</p>
      {query === '' ? null : <button type="button" className="chdsh-btn chdsh-command__clear" onClick={() => onQueryChange('')}>清除搜索</button>}
    </>}
  </section>;
}
