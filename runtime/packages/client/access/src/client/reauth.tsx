/**
 * 敏感操作的再次认证对话框。
 *
 * 修改密码、移除验证方式、重新生成恢复码与撤销全部会话之前弹出本对话框。说明文字给出有效
 * 窗口（5 分钟）与本次认证只对该动作生效；支持密码与验证码两种方式，输入完成后提交，结果
 * 为拒绝时保留对话框并给出错误码说明。对话框约束焦点，关闭后焦点回到触发元素。凭据只存在于
 * 对话框状态里，提交后立即清空。
 * @module @chatdsh/client-access/reauth
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Dialog, ErrorNote, Field, StatusLine } from '@chatdsh/core-ui-kit';
import { describeAccessFailure, formatTimeOfDay, METHOD_LABELS, SENSITIVE_ACTION_LABELS } from './describe.ts';
import { AccessCallError, createAccessGateway } from './gateway.ts';
import type { AccessAuthMethod, AccessGateway, AccessSensitiveAction } from './types.ts';

/** 再次认证的有效窗口，单位秒。 */
export const REAUTH_WINDOW_SECONDS = 300;

/** 再次认证对话框属性。 */
export interface ReauthDialogProps {
  /** 是否打开。 */
  readonly open: boolean;
  /** 目标敏感动作。 */
  readonly action: AccessSensitiveAction;
  /** 可用的认证方式。 */
  readonly methods: readonly AccessAuthMethod[];
  /** 数据入口。 */
  readonly gateway?: AccessGateway;
  /** 关闭回调。 */
  readonly onClose: () => void;
  /** 授权回调，参数是有效窗口结束时刻。 */
  readonly onAuthorized: (validUntil: number) => void;
}

let sharedGateway: AccessGateway | undefined;

/**
 * 取数据入口。
 * @param provided - 调用方传入的入口。
 * @returns 数据入口。
 */
function gatewayOf(provided?: AccessGateway): AccessGateway {
  if (provided !== undefined) return provided;
  sharedGateway ??= createAccessGateway();
  return sharedGateway;
}

/**
 * 再次认证对话框。
 * @param props - 目标动作、可用方式与回调。
 * @returns 对话框内容。
 */
export function ReauthDialog({ open, action, methods, gateway, onClose, onAuthorized }: ReauthDialogProps) {
  const face = gatewayOf(gateway);
  const options = methods.filter((method) => method === 'password' || method === 'totp');
  const [method, setMethod] = useState<AccessAuthMethod>(options[0] ?? 'password');
  const [credential, setCredential] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setCredential('');
      setFailure(undefined);
      setNotice(undefined);
      setMethod(options[0] ?? 'password');
    }
  }, [open]);

  if (options.length === 0) {
    return (
      <Dialog open={open} title="再次认证" description="当前没有可以用于再次认证的方式。" onClose={onClose}>
        <StatusLine tone="danger">没有可用的认证方式，无法执行该动作。</StatusLine>
      </Dialog>
    );
  }

  /** 提交一次再次认证。 */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending) return;
    if (credential === '') {
      setFailure(method === 'password' ? '请输入密码。' : '请输入 6 位数字验证码。');
      return;
    }
    setPending(true);
    setFailure(undefined);
    face.reauth({ action, method, credential }).then(
      (result) => {
        setPending(false);
        setCredential('');
        if (result.outcome === 'authorized') {
          const validUntil = result.validUntil ?? Date.now() + REAUTH_WINDOW_SECONDS * 1000;
          setNotice(`再次认证通过，有效至 ${formatTimeOfDay(validUntil)}。`);
          face.noteAction('access-reauth', 'ok');
          onAuthorized(validUntil);
          return;
        }
        setFailure(`再次认证被拒绝：${describeAccessFailure(new AccessCallError(result.code ?? 'auth-invalid', 401))}`);
        face.noteAction('access-reauth', 'failed');
      },
      (error: unknown) => {
        setPending(false);
        setCredential('');
        setFailure(describeAccessFailure(error));
        face.noteAction('access-reauth', 'failed');
      },
    );
  };

  return (
    <Dialog
      open={open}
      title="再次认证"
      description={`${SENSITIVE_ACTION_LABELS[action]}需要再次认证。再次认证在 ${String(REAUTH_WINDOW_SECONDS / 60)} 分钟内有效，本次认证只对当前这个动作生效。`}
      onClose={onClose}
    >
      <form id="chdsh-access-reauth-form" onSubmit={submit} noValidate>
        <div role="group" aria-label="再次认证方式">
          {options.map((option) => (
            <Button
              key={option}
              id={`chdsh-access-reauth-method-${option}`}
              aria-pressed={method === option}
              onClick={() => {
                setMethod(option);
                setCredential('');
                setFailure(undefined);
              }}
            >
              {`使用${METHOD_LABELS[option]}`}
            </Button>
          ))}
        </div>
        {method === 'password' ? (
          <Field label="密码" help="输入当前部署密码完成再次认证。" required>
            <input
              id="chdsh-access-reauth-credential"
              name="reauth-password"
              type="password"
              autoComplete="current-password"
              value={credential}
              disabled={pending}
              onChange={(event) => setCredential(event.target.value)}
            />
          </Field>
        ) : (
          <Field label="验证码" help="输入认证器上显示的 6 位数字。" required>
            <input
              id="chdsh-access-reauth-credential"
              name="reauth-totp"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              value={credential}
              disabled={pending}
              onChange={(event) => setCredential(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </Field>
        )}
        {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
        {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
        <div style={{ display: 'flex', gap: 'var(--cdh-s2)', justifyContent: 'flex-end' }}>
          <Button id="chdsh-access-reauth-cancel" onClick={onClose}>取消</Button>
          <Button id="chdsh-access-reauth-submit" type="submit" tone="primary" disabled={pending}>
            {pending ? '认证中…' : '完成再次认证'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
