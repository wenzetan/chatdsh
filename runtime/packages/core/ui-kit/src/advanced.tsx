import { Component, Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly disabledReason?: string;
}

export interface MenuProps {
  label: string;
  items: readonly MenuItem[];
  onAction: (id: string) => void;
}

function assertItems(items: readonly { id: string; label: string }[], name: string) {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.id.trim() === '' || item.label.trim() === '') throw new Error(`${name}标识和名称不能为空`);
    if (ids.has(item.id)) throw new Error(`${name}标识不能重复`);
    ids.add(item.id);
  }
}

/** 菜单的字符检索仅在当前菜单范围循环，禁用项目保留键盘读取入口。 */
export function Menu({ label, items, onAction }: MenuProps) {
  assertItems(items, '菜单项目');
  if (label.trim() === '') throw new Error('菜单名称不能为空');
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const references = useRef(new Map<string, HTMLButtonElement>());
  const initial = useRef<'first' | 'last'>('first');
  const search = useRef({ value: '', time: 0 });
  const close = (restore = true) => {
    setOpen(false);
    search.current = { value: '', time: 0 };
    if (restore) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const target = initial.current === 'last' ? items.at(-1) : items[0];
    if (target !== undefined) references.current.get(target.id)?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open && items.length === 0) close();
  }, [open, items.length]);
  return <div className="chdsh-menu" ref={root} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(false);
  }}>
    <button type="button" className="chdsh-btn chdsh-menu__trigger" ref={trigger} id={`${id}-trigger`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={`${id}-menu`} disabled={items.length === 0}
      onClick={() => { if (open) close(); else { initial.current = 'first'; setOpen(true); } }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); initial.current = event.key === 'ArrowUp' ? 'last' : 'first';
          if (open) {
            const item = initial.current === 'last' ? items.at(-1) : items[0];
            if (item !== undefined) references.current.get(item.id)?.focus();
          } else setOpen(true);
        }
      }}>{label}</button>
    {open ? <ul role="menu" id={`${id}-menu`} aria-labelledby={`${id}-trigger`} className="chdsh-menu__list">
      {items.map((item, index) => <li role="none" key={item.id}>
        <button type="button" role="menuitem" className="chdsh-menu__item" tabIndex={-1}
          aria-disabled={item.disabledReason === undefined ? undefined : true}
          ref={(node) => { if (node === null) references.current.delete(item.id); else references.current.set(item.id, node); }}
          onClick={() => { if (item.disabledReason === undefined) { close(); onAction(item.id); } }}
          onKeyDown={(event) => {
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : event.key === 'ArrowDown' ? (index + 1) % items.length
                : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : undefined;
            if (next !== undefined) { event.preventDefault(); references.current.get(items[next]!.id)?.focus(); }
            else if (event.key === 'Escape') { event.preventDefault(); close(); }
            else if (event.key === 'Tab') close();
            else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
              const now = Date.now();
              const character = event.key.toLocaleLowerCase();
              const previous = now - search.current.time <= 500 ? search.current.value : '';
              const value = previous === character ? character : previous + character;
              search.current = { value, time: now };
              for (let offset = 1; offset <= items.length; offset += 1) {
                const candidate = items[(index + offset) % items.length]!;
                if (candidate.label.toLocaleLowerCase().startsWith(value)) { references.current.get(candidate.id)?.focus(); break; }
              }
            }
          }}>{item.label}{item.disabledReason === undefined ? null : <span className="chdsh-menu__reason">（{item.disabledReason}）</span>}</button>
      </li>)}
    </ul> : null}
  </div>;
}

export interface FileTreeNode {
  readonly id: string;
  readonly label: string;
  /** children 存在时表示目录，空数组表示空目录。 */
  readonly children?: readonly FileTreeNode[];
}

export interface FileTreeProps {
  label: string;
  nodes: readonly FileTreeNode[];
  expandedIds: readonly string[];
  selectedId?: string;
  onExpandedChange: (ids: readonly string[]) => void;
  onSelect: (id: string) => void;
  emptyMessage?: string;
}

interface TreeEntry { node: FileTreeNode; parent?: string; }

/** 受控单选树；宿主删除节点时同时清理 selectedId 与 expandedIds。 */
export function FileTree({ label, nodes, expandedIds, selectedId, onExpandedChange, onSelect, emptyMessage = '没有文件' }: FileTreeProps) {
  if (label.trim() === '') throw new Error('文件树名称不能为空');
  const all = new Map<string, TreeEntry>();
  const collect = (siblings: readonly FileTreeNode[], parent?: string) => {
    assertItems(siblings, '文件树节点');
    for (const node of siblings) {
      if (all.has(node.id)) throw new Error('文件树节点标识不能重复');
      all.set(node.id, { node, parent });
      if (node.children !== undefined) collect(node.children, node.id);
    }
  };
  collect(nodes);
  if (selectedId !== undefined && !all.has(selectedId)) throw new Error('选中文件树节点需要存在');
  const expanded = new Set(expandedIds);
  if (expanded.size !== expandedIds.length) throw new Error('展开目录标识不能重复');
  for (const id of expanded) {
    if (all.get(id)?.node.children === undefined) throw new Error('展开目录需要存在并且具有 children');
  }
  const visible: TreeEntry[] = [];
  const visit = (siblings: readonly FileTreeNode[]) => {
    for (const node of siblings) {
      visible.push(all.get(node.id)!);
      if (node.children !== undefined && expanded.has(node.id)) visit(node.children);
    }
  };
  visit(nodes);
  const [focusedId, setFocusedId] = useState<string | undefined>(selectedId);
  const references = useRef(new Map<string, HTMLLIElement>());
  const root = useRef<HTMLUListElement>(null);
  const previous = useRef<readonly TreeEntry[]>([]);
  const restore = useRef(false);
  let activeId = focusedId;
  if (!visible.some((entry) => entry.node.id === activeId)) {
    let ancestor = activeId === undefined ? undefined : all.get(activeId)?.parent;
    while (ancestor !== undefined && !visible.some((entry) => entry.node.id === ancestor)) ancestor = all.get(ancestor)?.parent;
    const oldIndex = previous.current.findIndex((entry) => entry.node.id === focusedId);
    activeId = ancestor ?? visible[Math.max(0, Math.min(oldIndex, visible.length - 1))]?.node.id;
  }
  const active = activeId;
  useEffect(() => {
    previous.current = visible;
    if (restore.current) {
      restore.current = false;
      if (active === undefined) root.current?.focus(); else references.current.get(active)?.focus();
    }
  });
  const focus = (id: string) => { setFocusedId(id); references.current.get(id)?.focus(); };
  const toggle = (id: string) => onExpandedChange(expanded.has(id) ? expandedIds.filter((value) => value !== id) : [...expandedIds, id]);
  const renderNodes = (siblings: readonly FileTreeNode[], level: number): ReactNode => siblings.map((node, index) => {
    const isDirectory = node.children !== undefined;
    const isExpanded = expanded.has(node.id);
    const selected = selectedId === node.id;
    return <li role="treeitem" key={node.id} className="chdsh-tree__item" tabIndex={active === node.id ? 0 : -1}
      aria-label={node.label} aria-level={level} aria-posinset={index + 1} aria-setsize={siblings.length}
      aria-selected={selected} aria-expanded={isDirectory ? isExpanded : undefined}
      ref={(element) => {
        const old = references.current.get(node.id);
        if (element === null) {
          if (old !== undefined && old === document.activeElement) restore.current = true;
          references.current.delete(node.id);
        } else references.current.set(node.id, element);
      }}
      onFocus={(event) => { if (event.target === event.currentTarget) setFocusedId(node.id); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const position = visible.findIndex((entry) => entry.node.id === node.id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
          : event.key === 'ArrowDown' ? Math.min(position + 1, visible.length - 1)
            : event.key === 'ArrowUp' ? Math.max(position - 1, 0) : undefined;
        if (next !== undefined) { event.preventDefault(); focus(visible[next]!.node.id); }
        else if (event.key === 'ArrowRight') {
          event.preventDefault();
          if (isDirectory && !isExpanded) toggle(node.id);
          else if (isExpanded && node.children?.[0] !== undefined) focus(node.children[0].id);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          if (isDirectory && isExpanded) toggle(node.id);
          else { const parent = all.get(node.id)?.parent; if (parent !== undefined) focus(parent); }
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); onSelect(node.id);
        }
      }}>
      <div className="chdsh-tree__row" onClick={() => { focus(node.id); onSelect(node.id); if (isDirectory) toggle(node.id); }}>
        <span className="chdsh-tree__disclosure" aria-hidden="true">{isDirectory ? isExpanded ? '▾' : '▸' : '·'}</span>
        <span className="chdsh-tree__label">{node.label}</span>
        {selected ? <span className="chdsh-tree__selected" aria-hidden="true">（已选择）</span> : null}
      </div>
      {isDirectory && isExpanded && node.children!.length > 0 ? <ul role="group" className="chdsh-tree__group">{renderNodes(node.children!, level + 1)}</ul> : null}
    </li>;
  });
  return <div className="chdsh-tree">
    <ul role="tree" aria-label={label} className="chdsh-tree__root" ref={root} tabIndex={visible.length === 0 ? 0 : -1}>{renderNodes(nodes, 1)}</ul>
    {visible.length === 0 ? <p role="status" className="chdsh-tree__empty">{emptyMessage}</p> : null}
  </div>;
}

export type ErrorBoundaryErrorCategory = 'render-error';

export interface ErrorBoundaryProps {
  children: ReactNode;
  onError: (category: ErrorBoundaryErrorCategory) => void;
  onRetry?: () => void;
  title?: string;
  retryLabel?: string;
}

interface ErrorBoundaryState { failed: boolean; generation: number; }

/** React 保留原始错误报告；宿主回调仅接收固定分类，故障内容不进入组件回调。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, generation: 0 };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> { return { failed: true }; }

  componentDidCatch() { this.props.onError('render-error'); }

  retry = () => {
    this.props.onRetry?.();
    this.setState((state) => ({ failed: false, generation: state.generation + 1 }));
  };

  render() {
    if (this.state.failed) return <section className="chdsh-error-boundary">
      <div role="alert" aria-atomic="true"><h2>{this.props.title ?? '界面发生故障'}</h2><p>此区域未能显示。请使用重试按钮重新加载此区域。</p></div>
      <button type="button" className="chdsh-btn chdsh-error-boundary__retry" onClick={this.retry}>{this.props.retryLabel ?? '重试'}</button>
    </section>;
    return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
  }
}
