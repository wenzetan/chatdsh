/**
 * 面板组件：侧栏条目与设置区段共用的一套原子件。
 *
 * 每个组件只消费设计令牌，不含业务数据；数据由各客户端插件取回后传入。组件覆盖
 * 加载、空、失败三类状态与徽标、按钮、进度条等元素，使各面板的版式保持一致。
 * @module @chatdsh/core-ui-kit/components
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** 面板外壳：统一的标题行与正文间距。 */
export function Panel({ title, subtitle, count, children }: { title: string; subtitle?: string; count?: ReactNode; children?: ReactNode }) {
  return (
    <section className="chdsh-panel">
      <div className="chdsh-panel__head">
        <h3 className="chdsh-panel__title">{title}</h3>
        {count === undefined ? null : <span className="chdsh-panel__count">{count}</span>}
      </div>
      {subtitle === undefined ? null : <p className="chdsh-panel__sub">{subtitle}</p>}
      {children}
    </section>
  );
}

/** 状态说明：加载中、空、失败共用的一行文字。 */
export function StatusLine({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'danger' }) {
  const color = tone === 'danger' ? 'var(--chatdsh-danger)' : 'var(--chatdsh-muted)';
  return <p role={tone === 'danger' ? 'alert' : 'status'} aria-atomic="true" style={{ margin: 0, color, fontSize: 'var(--cdh-fs-12)' }}>{children}</p>;
}

/** 骨架：与真实行等高的占位，数量默认三行。 */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_value, index) => <div key={index} className="chdsh-skeleton" />)}
    </div>
  );
}

/** 空状态：一句说明加一个下一步动作位。 */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="chdsh-empty" role="status" aria-live="polite">
      <div>{children}</div>
      {action === undefined ? null : <div className="chdsh-empty__action">{action}</div>}
    </div>
  );
}

/** 列表容器。 */
export function List({ children }: { children: ReactNode }) {
  return <ul className="chdsh-list">{children}</ul>;
}

/** 列表行：左侧圆点、正文、右侧动作。 */
export function Row({ title, meta, badge, actions, dot }: { title: ReactNode; meta?: ReactNode; badge?: ReactNode; actions?: ReactNode; dot?: 'ok' | 'warn' | 'danger' | 'idle' }) {
  return (
    <li className="chdsh-row">
      {dot === undefined ? null : <span className={`chdsh-dot${dot === 'idle' ? '' : ` chdsh-dot--${dot}`}`} />}
      <div className="chdsh-row__body">
        <div className="chdsh-row__title">
          {title}
          {badge === undefined ? null : badge}
        </div>
        {meta === undefined ? null : <div className="chdsh-row__meta">{meta}</div>}
      </div>
      {actions === undefined ? null : <div className="chdsh-row__acts">{actions}</div>}
    </li>
  );
}

/** 徽标。 */
export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'brand'; children: ReactNode }) {
  const className = tone === 'neutral' ? 'chdsh-badge' : `chdsh-badge chdsh-badge--${tone}`;
  return <span className={className}>{children}</span>;
}

/** 按钮。 */
export function Button({ tone = 'default', className, type = 'button', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'danger' | 'primary'; children: ReactNode }) {
  const classes = ['chdsh-btn', tone === 'default' ? undefined : `chdsh-btn--${tone}`, className].filter(Boolean).join(' ');
  return <button {...props} type={type} className={classes}>{children}</button>;
}

/** 进度条：比例 0 到 1。 */
export function ProgressBar({ ratio, tone = 'brand', label = '任务进度' }: { ratio: number; tone?: 'brand' | 'warn' | 'danger'; label?: string }) {
  if (!Number.isFinite(ratio)) throw new Error('任务进度需要有限数值');
  const percent = Math.max(0, Math.min(1, ratio)) * 100;
  const fillClass = tone === 'brand' ? 'chdsh-bar__fill' : `chdsh-bar__fill chdsh-bar__fill--${tone}`;
  return (
    <div className="chdsh-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className={fillClass} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** 错误提示条。 */
export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="chdsh-error" role="alert">{children}</p>;
}
