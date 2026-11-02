/**
 * 危险动作的确认对话框。
 *
 * 对话框列出对象、范围、可释放空间与逐项依赖影响；两项确认都勾选后确认按钮才可用。打开后
 * 焦点落在取消按钮上，确认按钮从不接收初始焦点；对话框内用原生 `dialog` 约束 Tab 与
 * Shift+Tab 的移动范围，Escape 关闭并把焦点还给触发元素。执行期间按钮锁定，失败原因留在
 * 对话框里。
 * @module @chatdsh/client-data-management/confirm-dialog
 */

import { Button, Dialog, ErrorNote, StatusLine } from '@chatdsh/core-ui-kit';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** 对话框里的一行事实。 */
export interface ConfirmFact {
  readonly label: string;
  readonly value: ReactNode;
}

/** 一项需要逐项确认的依赖。 */
export interface ConfirmDependency {
  /** 稳定的依赖标识，用作复选框的键。 */
  readonly id: string;
  /** 依赖的名称。 */
  readonly label: string;
  /** 依赖的细节，例如建立时间与到期时间。 */
  readonly detail?: string;
}

/** 确认对话框的属性。 */
export interface ConfirmDialogProps {
  /** 是否打开。 */
  readonly open: boolean;
  /** 标题。 */
  readonly title: string;
  /** 一句话说明。 */
  readonly description: string;
  /** 对象与范围。 */
  readonly facts: readonly ConfirmFact[];
  /** 不可撤销的影响。 */
  readonly impacts: readonly string[];
  /** 逐项确认的依赖；为空表示没有依赖。 */
  readonly dependencies?: readonly ConfirmDependency[];
  /** 依赖需要逐项勾选；缺省为真。 */
  readonly requireDependencyConfirm?: boolean;
  /** 第二项确认的说明。 */
  readonly acknowledgeLabel?: string;
  /** 确认按钮的文字。 */
  readonly confirmLabel: string;
  /** 正在执行。 */
  readonly busy: boolean;
  /** 失败原因；没有失败时缺省。 */
  readonly failure?: string;
  /** 关闭对话框。 */
  readonly onClose: () => void;
  /** 执行动作；两项确认都已勾选。 */
  readonly onConfirm: () => void;
}

/**
 * 危险动作的确认对话框。
 * @param props - 对象、依赖与回调。
 * @returns 对话框。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  facts,
  impacts,
  dependencies = [],
  requireDependencyConfirm = true,
  acknowledgeLabel,
  confirmLabel,
  busy,
  failure,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const container = useRef<HTMLDivElement>(null);
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChecked([]);
    setAcknowledged(false);
    let alive = true;
    // 原生 dialog 打开时会把焦点放到第一个可聚焦控件上；这里在同一个任务结束时改放到取消按钮。
    queueMicrotask(() => {
      if (!alive) return;
      container.current?.querySelector<HTMLButtonElement>('[data-confirm-cancel]')?.focus();
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const dependenciesConfirmed = !requireDependencyConfirm || dependencies.every((item) => checked.includes(item.id));
  const acknowledgedReady = acknowledgeLabel === undefined || acknowledged;
  const ready = dependenciesConfirmed && acknowledgedReady;

  return (
    <Dialog open={open} title={title} description={description} onClose={onClose}>
      <div ref={container} data-confirm-dialog>
        <dl data-confirm-facts>
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <h3>执行后的影响</h3>
        <ul data-confirm-impacts>
          {impacts.map((impact) => <li key={impact}>{impact}</li>)}
        </ul>
        <div data-confirm-dependencies>
          {dependencies.length === 0
            ? <p data-confirm-dependencies-none>范围内没有有效分享、活动导入或记忆组引用。</p>
            : requireDependencyConfirm
              ? (
                <fieldset>
                  <legend>依赖影响逐项确认</legend>
                  {dependencies.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        data-dependency-check={item.id}
                        checked={checked.includes(item.id)}
                        onChange={(event) => {
                          setChecked((current) => event.target.checked
                            ? [...current, item.id]
                            : current.filter((value) => value !== item.id));
                        }}
                      />
                      {item.detail === undefined ? item.label : `${item.label} · ${item.detail}`}
                    </label>
                  ))}
                </fieldset>
              )
              : (
                <>
                  <p>这次操作会影响以下依赖，下一级需要逐项确认。</p>
                  <ul data-confirm-dependency-list>
                    {dependencies.map((item) => (
                      <li key={item.id}>{item.detail === undefined ? item.label : `${item.label} · ${item.detail}`}</li>
                    ))}
                  </ul>
                </>
              )}
        </div>
        {acknowledgeLabel === undefined
          ? null
          : (
            <label data-confirm-acknowledge>
              <input
                type="checkbox"
                data-acknowledge-check
                checked={acknowledged}
                onChange={(event) => {
                  setAcknowledged(event.target.checked);
                }}
              />
              {acknowledgeLabel}
            </label>
          )}
        {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
        {busy ? <StatusLine>正在执行…</StatusLine> : null}
        <div>
          <Button data-confirm-cancel onClick={onClose} disabled={busy}>取消</Button>
          <Button data-confirm-accept tone="danger" disabled={busy || !ready} onClick={onConfirm}>
            {busy ? '正在执行…' : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
