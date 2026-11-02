/**
 * 多选框组：附加工具与技能引用共用的可选清单。
 *
 * 键盘操作与勾选语义：Tab 进入整组一次，方向键在可选项之间移动焦点，Home 与 End 跳到首尾，
 * Space 勾选或取消当前项。档位自带的行与已停用的技能显示原因并禁止改动，焦点移动跳过它们。
 * 组本身用 `role="group"`，组名来自标题，说明与错误关联到同一个描述集合。
 * @module @chatdsh/client-assistants/multiselect
 */

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

/** 一个可选项。 */
export interface CheckOption {
  /** 选项标识，同时是勾选值的取值。 */
  readonly id: string;
  /** 显示文字。 */
  readonly label: string;
  /** 选项下面的一行说明。 */
  readonly hint?: string;
  /** 不能新选的说明；已选的项保持勾选。 */
  readonly blockedReason?: string;
  /** 始终装配、不能取消的说明。 */
  readonly fixedReason?: string;
}

/** 多选框组的依赖。 */
export interface CheckboxGroupProps {
  /** 组名。 */
  readonly label: string;
  /** 组的说明文字。 */
  readonly help?: ReactNode;
  /** 组上的错误文字。 */
  readonly error?: string;
  /** 当前勾选的取值。 */
  readonly selected: readonly string[];
  /** 可选项，按显示顺序排列。 */
  readonly options: readonly CheckOption[];
  /** 勾选或取消一个选项。 */
  readonly onToggle: (id: string, checked: boolean) => void;
  /** 选项控件标识的前缀，便于外部定位。 */
  readonly idPrefix: string;
  /** 组容器的标识，错误摘要按它把焦点交给整组。 */
  readonly groupDomId?: string;
}

/**
 * 多选框组。
 * @param props - 组名、选项与勾选回调。
 * @returns 表单里的一组复选项。
 */
export function CheckboxGroup({ label, help, error, selected, options, onToggle, idPrefix, groupDomId }: CheckboxGroupProps) {
  const id = useId();
  const controls = useRef(new Map<string, HTMLInputElement>());
  const chosen = new Set(selected);

  /** 可以接收焦点的选项。 */
  const focusable = (): HTMLInputElement[] =>
    options
      .map((option) => controls.current.get(option.id))
      .filter((control): control is HTMLInputElement => control !== undefined && !control.disabled);

  /** 方向键与首页末页键在可选项之间移动焦点。 */
  const move = (event: KeyboardEvent<HTMLDivElement>, step: number | 'first' | 'last'): void => {
    const list = focusable();
    if (list.length === 0) return;
    event.preventDefault();
    const current = list.findIndex((control) => control === document.activeElement);
    const next = step === 'first'
      ? 0
      : step === 'last'
        ? list.length - 1
        : current < 0
          ? 0
          : (current + step + list.length) % list.length;
    list[next]?.focus();
  };

  const descriptionIds = [help === undefined ? undefined : `${id}-help`, error === undefined ? undefined : `${id}-error`]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div className="chdsh-field" id={groupDomId} tabIndex={groupDomId === undefined ? undefined : -1}>
      <span id={`${id}-label`}>{label}</span>
      <div
        className="chdsh-multiselect"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={descriptionIds === '' ? undefined : descriptionIds}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') move(event, 1);
          else if (event.key === 'ArrowUp') move(event, -1);
          else if (event.key === 'Home') move(event, 'first');
          else if (event.key === 'End') move(event, 'last');
        }}
      >
        {options.map((option) => {
          const fixed = option.fixedReason !== undefined;
          const blocked = option.blockedReason !== undefined;
          const checked = fixed || chosen.has(option.id);
          const disabled = fixed || blocked;
          const note = fixed ? option.fixedReason : option.blockedReason;
          return (
            <label key={option.id} className="chdsh-multiselect__option">
              <input
                id={`${idPrefix}-${option.id}`}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                ref={(node) => {
                  if (node === null) controls.current.delete(option.id);
                  else controls.current.set(option.id, node);
                }}
                onChange={(event) => onToggle(option.id, event.target.checked)}
              />
              <span className="chdsh-multiselect__text">
                {option.label}
                {option.hint === undefined ? null : <span className="chdsh-field__help">{option.hint}</span>}
                {note === undefined ? null : <span className="chdsh-field__help">{note}</span>}
              </span>
            </label>
          );
        })}
      </div>
      {help === undefined ? null : <p id={`${id}-help`} className="chdsh-field__help">{help}</p>}
      {error === undefined ? null : <p id={`${id}-error`} className="chdsh-field__error">{error}</p>}
    </div>
  );
}
