import { cloneElement, useId, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';

interface FieldControl extends HTMLAttributes<HTMLElement> {
  id?: string;
  required?: boolean;
}

/** 标签、帮助和错误与实际控件使用同一组标识。 */
export function Field({ label, help, error, required, children }: {
  label: string; help?: ReactNode; error?: ReactNode; required?: boolean;
  children: ReactElement<FieldControl>;
}) {
  const generated = useId();
  const id = children.props.id ?? generated;
  const invalid = error !== undefined && error !== null;
  const describedBy = [children.props['aria-describedby'], help === undefined ? undefined : `${id}-help`, invalid ? `${id}-error` : undefined].filter(Boolean).join(' ');
  return <div className="chdsh-field">
    <label htmlFor={id}>{label}{required ? <span>（必填）</span> : null}</label>
    {cloneElement(children, { id, required: required ?? children.props.required, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy || undefined })}
    {help === undefined ? null : <p id={`${id}-help`} className="chdsh-field__help">{help}</p>}
    {invalid ? <p id={`${id}-error`} className="chdsh-field__error">{error}</p> : null}
  </div>;
}

/** 提交失败后调用方可以将焦点移到该摘要；链接定位具体字段。 */
export function ErrorSummary({ title = '请检查以下字段', errors, ...props }: {
  title?: string; errors: readonly { fieldId: string; message: string }[];
} & HTMLAttributes<HTMLElement>) {
  const id = useId();
  if (errors.length === 0) return null;
  return <section {...props} className="chdsh-error-summary" tabIndex={-1} role="alert" aria-labelledby={id}>
    <h3 id={id}>{title}</h3>
    <ul>{errors.map((error) => <li key={error.fieldId}><a href={`#${encodeURIComponent(error.fieldId)}`} onClick={(event) => {
      event.preventDefault();
      document.getElementById(error.fieldId)?.focus();
    }}>{error.message}</a></li>)}</ul>
  </section>;
}

/** 宽内容独立滚动，保留表格标题、表头和原生表格语义。 */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  return <div className="chdsh-scroll-region" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

/** 状态提示保留在文档中，避免定时消失导致辅助技术无法读取。 */
export function Toast({ children, urgent = false, onDismiss }: { children: ReactNode; urgent?: boolean; onDismiss?: () => void }) {
  return <div className="chdsh-toast">
    <div role={urgent ? 'alert' : 'status'} aria-atomic="true">{children}</div>
    {onDismiss === undefined ? null : <button type="button" className="chdsh-btn" onClick={onDismiss} aria-label="关闭状态提示">关闭</button>}
  </div>;
}
