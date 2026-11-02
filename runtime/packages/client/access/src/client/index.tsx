/**
 * 访问区段：访问状态、访问会话、验证码绑定、恢复码与再次认证。
 *
 * 区段读取一次访问状态，把剩余未使用的恢复码条数与 TOTP 绑定情况交给各面板。重新生成恢复码
 * 与撤销全部会话之前弹出再次认证对话框，认证通过后才继续原动作。
 * @module @chatdsh/client-access
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { formatTimeOfDay } from './describe.ts';
import { createAccessGateway } from './gateway.ts';
import { ReauthDialog } from './reauth.tsx';
import { RecoveryPanel } from './recovery.tsx';
import { SessionsPanel } from './sessions.tsx';
import { TotpPanel } from './totp.tsx';
import type { AccessGateway, AccessSensitiveAction, AccessStatus, Loadable } from './types.ts';
import { RECOVERY_CODE_COUNT } from './types.ts';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-access';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots'];

/** 一次待处理的再次认证。 */
interface PendingReauth {
  readonly action: AccessSensitiveAction;
  readonly resolve: (authorized: boolean) => void;
}

/** 区段属性。 */
export interface AccessSectionProps {
  /** 数据入口；嵌入与测试场景可以直接传入。 */
  readonly gateway?: AccessGateway;
  /** 撤销当前会话之后的回调，宿主用它回到登录入口。 */
  readonly onSignedOut?: () => void;
}

/**
 * 设置页区段：访问的完整界面。
 * @param props - 可选的数据入口。
 * @returns 区段内容。
 */
export function AccessSection({ gateway, onSignedOut }: AccessSectionProps = {}) {
  const face = useMemo(() => gateway ?? createAccessGateway(), [gateway]);
  const [status, setStatus] = useState<Loadable<AccessStatus>>({ status: 'loading' });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [pendingReauth, setPendingReauth] = useState<PendingReauth | undefined>(undefined);

  const load = useCallback((): void => {
    face.status().then(
      (value) => setStatus({ status: 'ready', value }),
      (error: unknown) => setStatus({ status: 'failed', error }),
    );
  }, [face]);

  useEffect(() => {
    load();
  }, [load]);

  const guard = useCallback((action: AccessSensitiveAction): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      setPendingReauth({ action, resolve });
    }), []);

  const closeReauth = (): void => {
    pendingReauth?.resolve(false);
    setPendingReauth(undefined);
  };

  const authorized = (validUntil: number): void => {
    setNotice(`再次认证通过，有效至 ${formatTimeOfDay(validUntil)}。`);
    pendingReauth?.resolve(true);
    setPendingReauth(undefined);
  };

  if (status.status === 'loading') return <Panel title="访问"><Skeleton rows={4} /></Panel>;
  if (status.status === 'failed') {
    return (
      <Panel title="访问">
        <StatusLine tone="danger">访问状态读取失败，请刷新后重试。</StatusLine>
      </Panel>
    );
  }

  const value = status.value;
  const reauthMethods = [...new Set([...value.methods, ...(value.totpEnrolled ? (['totp'] as const) : [])])]
    .filter((method) => method === 'password' || method === 'totp');
  return (
    <>
      <Panel title="访问" subtitle="单用户部署没有账号表。登录、第二因素与会话都在这里管理。" count={`${String(value.recoveryCodesRemaining)} 条恢复码可用`}>
        <StatusLine>
          {value.signedIn
            ? `当前访问会话有效。可用的认证方式：${value.methods.join('、')}。`
            : '当前没有访问会话，私有内容需要登录后访问。'}
        </StatusLine>
        {value.lockedUntil === undefined ? null : (
          <StatusLine tone="danger">{`访问处于等待期，结束时刻 ${formatTimeOfDay(value.lockedUntil)}。`}</StatusLine>
        )}
        {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      </Panel>
      <SessionsPanel gateway={face} guard={guard} onSignedOut={() => {
        load();
        onSignedOut?.();
      }} />
      <TotpPanel gateway={face} enrolled={value.totpEnrolled} onConfirmed={load} />
      <RecoveryPanel
        gateway={face}
        status={{ total: RECOVERY_CODE_COUNT, remaining: value.recoveryCodesRemaining }}
        guard={guard}
        onGenerated={load}
      />
      <ReauthDialog
        open={pendingReauth !== undefined}
        action={pendingReauth?.action ?? 'revoke-all-sessions'}
        methods={reauthMethods}
        gateway={face}
        onClose={closeReauth}
        onAuthorized={authorized}
      />
    </>
  );
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}

/** 客户端根上下文的形状。 */
interface ClientFace {
  readonly slots: ClientSlots;
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientFace): void {
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 57,
    label: () => '访问',
    locale: 'chatdsh.access',
  }, () => <AccessSection />));
}
