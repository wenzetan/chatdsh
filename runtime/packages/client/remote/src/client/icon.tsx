/**
 * 侧栏「远程设备」入口的图标。
 * @module @chatdsh/client-remote/icon
 */

import type { ReactNode } from 'react';

/** 侧栏图标。 */
export function PanelIcon({ size }: { readonly size: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="8" height="6" rx="1.2" />
      <rect x="13" y="14" width="8" height="6" rx="1.2" />
      <path d="M7 10v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}
