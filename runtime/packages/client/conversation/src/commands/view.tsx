/**
 * 命令面板与触发面板的界面。
 *
 * 命令面板是模态层：面板自身负责查询框与条目列表的语义，Escape 关闭、Enter 执行、方向键与
 * Home/End 移动；关闭后由宿主把焦点还给打开它的控件。触发面板跟随输入区的光标出现，键盘
 * 仍留在输入区，因此条目列表只负责呈现与 `aria-activedescendant` 指向。
 * @module @chatdsh/client-conversation/commands/view
 */

import type { KeyboardEvent, RefObject } from 'react';
import { CommandSurface, type CommandItem } from '@chatdsh/core-ui-kit';
import { PALETTE_SHORTCUT_LABEL, type CommandDescriptor } from './palette.ts';
import type { TriggerGroup, TriggerItem, TriggerKind } from './triggers.ts';

/** 把命令转成命令面板的条目。 */
export function toCommandItems(commands: readonly CommandDescriptor[]): CommandItem[] {
  return commands.map((command) => ({
    id: command.id,
    label: command.name,
    description: [command.group, command.description].filter(Boolean).join(' · '),
    ...(command.shortcut === undefined ? {} : { shortcut: command.shortcut }),
    ...(command.enabled ? {} : { disabledReason: command.disabledReason ?? '当前不可用' }),
  }));
}

/** 命令面板属性。 */
export interface PaletteDialogProps {
  readonly open: boolean;
  readonly levelLabel: string;
  readonly canGoBack: boolean;
  readonly query: string;
  readonly commands: readonly CommandDescriptor[];
  readonly activeId?: string;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onActiveChange: (id: string) => void;
  readonly onClose: () => void;
  readonly rootRef?: RefObject<HTMLDivElement | null>;
  readonly onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * 命令面板。
 * @param props - 查询、条目与处理函数。
 * @returns 面板元素；关闭时返回 `null`。
 */
export function PaletteDialog(props: PaletteDialogProps) {
  if (!props.open) return null;
  return <div
    className="chdsh-conv__palette"
    ref={props.rootRef}
    onKeyDownCapture={props.onKeyDownCapture}
    data-palette
  >
    <CommandSurface
      label={`${props.levelLabel}（${PALETTE_SHORTCUT_LABEL}）`}
      query={props.query}
      items={toCommandItems(props.commands)}
      {...(props.activeId === undefined ? {} : { activeId: props.activeId })}
      onQueryChange={props.onQueryChange}
      onSelect={props.onSelect}
      onActiveChange={props.onActiveChange}
      emptyMessage="没有匹配的命令"
    />
    <div className="chdsh-conv__row">
      {props.canGoBack ? <button type="button" className="chdsh-btn" onClick={props.onClose}>返回上一级需要退格</button> : null}
      <button type="button" className="chdsh-btn" onClick={props.onClose}>关闭命令面板</button>
    </div>
  </div>;
}

/** 触发面板属性。 */
export interface TriggerPanelProps {
  readonly id: string;
  readonly kind: TriggerKind;
  readonly query: string;
  readonly groups: readonly TriggerGroup[];
  readonly activeId?: string;
  readonly onSelect: (item: TriggerItem) => void;
}

/**
 * 触发面板。
 *
 * 列表使用 `role=listbox`，条目带 `aria-selected`，不可用条目带原因；键盘焦点留在输入区，
 * 由输入区把 `aria-activedescendant` 指到当前条目。
 * @param props - 触发种类、查询、分组与当前条目。
 * @returns 面板元素。
 */
export function TriggerPanel(props: TriggerPanelProps) {
  const title = props.kind === 'command' ? '运行时命令' : '引用对象';
  return <div className="chdsh-conv__trigger" data-trigger-panel={props.kind}>
    <div className="chdsh-command">
      <p className="chdsh-command__hint" role="status" aria-atomic="true">
        {title}：{props.query === '' ? '输入名称过滤' : `匹配 ${props.query}`}
      </p>
      {props.groups.length === 0
        ? <p className="chdsh-command__empty" role="status">没有匹配的{title}</p>
        : <ul className="chdsh-command__list" role="listbox" id={props.id} aria-label={title}>
            {props.groups.map((group) => <li key={group.group} role="presentation">
              <p className="chdsh-command__description" role="presentation">{group.group}</p>
              <ul role="group" aria-label={group.group} className="chdsh-command__list">
                {group.items.map((item) => <li
                  key={`${item.kind}:${item.id}`}
                  id={`${props.id}-${item.kind}-${item.id}`}
                  role="option"
                  aria-selected={props.activeId === `${item.kind}:${item.id}`}
                  aria-disabled={item.unavailableReason === undefined ? undefined : true}
                  className={`chdsh-command__item${props.activeId === `${item.kind}:${item.id}` ? ' chdsh-command__item--active' : ''}`}
                  onClick={() => {
                    if (item.unavailableReason === undefined) props.onSelect(item);
                  }}
                >
                  <span className="chdsh-command__title">{item.label}</span>
                  <span className="chdsh-command__description">
                    {item.origin === 'local' ? '本机' : '远程'}
                    {item.description === undefined ? '' : ` · ${item.description}`}
                  </span>
                  {item.unavailableReason === undefined
                    ? null
                    : <span className="chdsh-command__reason">（{item.unavailableReason}）</span>}
                </li>)}
              </ul>
            </li>)}
          </ul>}
    </div>
  </div>;
}
