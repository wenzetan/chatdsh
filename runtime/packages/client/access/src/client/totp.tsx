/**
 * 验证码（TOTP）绑定面板。
 *
 * 绑定开始后显示可复制的 base32 密钥与 `otpauth://` 地址，并用一次验证码确认。工作区没有
 * 成熟的二维码生成库，页面明确说明二维码不可用，并给出两条可以手动带入认证器的路径。
 * 密钥只存在于本页状态，不写入持久存储、日志、导出或遥测。
 * @module @chatdsh/client-access/totp
 */

import { useId, useState, type FormEvent } from 'react';
import { Badge, Button, ErrorNote, ErrorSummary, Field, Panel, StatusLine } from '@chatdsh/core-ui-kit';
import { describeAccessFailure } from './describe.ts';
import { createAccessGateway } from './gateway.ts';
import type { AccessGateway, TotpEnrollment } from './types.ts';

/** 绑定面板属性。 */
export interface TotpPanelProps {
  /** 数据入口。 */
  readonly gateway?: AccessGateway;
  /** 是否已经完成绑定；由访问状态得出。 */
  readonly enrolled?: boolean;
  /** 绑定确认成功后的回调。 */
  readonly onConfirmed?: () => void;
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
 * 验证码绑定面板。
 * @param props - 数据入口、已绑定状态与成功回调。
 * @returns 面板内容。
 */
export function TotpPanel({ gateway, enrolled = false, onConfirmed }: TotpPanelProps = {}) {
  const face = gatewayOf(gateway);
  const uid = useId();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(enrolled);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [copyNote, setCopyNote] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  /** 把焦点移到错误摘要。 */
  const focusSummary = (): void => {
    document.getElementById('chdsh-access-totp-error')?.focus();
  };

  /** 开始一次绑定。 */
  const start = (): void => {
    setPending(true);
    setFailure(undefined);
    setNotice(undefined);
    setCopyNote(undefined);
    face.enrollTotp().then(
      (value) => {
        setEnrollment(value);
        setConfirmed(value.confirmed);
        setPending(false);
        face.noteAction('access-totp-enroll', 'ok');
        setNotice('绑定信息只在本次页面显示。请把密钥或 otpauth 地址带入认证器，再输入一次验证码确认。');
      },
      (error: unknown) => {
        setPending(false);
        setFailure(describeAccessFailure(error));
        face.noteAction('access-totp-enroll', 'failed');
        queueMicrotask(focusSummary);
      },
    );
  };

  /** 复制密钥。 */
  const copySecret = (): void => {
    if (enrollment === undefined) return;
    navigator.clipboard.writeText(enrollment.secret).then(
      () => setCopyNote('密钥已复制到剪贴板。'),
      () => setCopyNote('无法访问剪贴板。请选中密钥后手动复制。'),
    );
  };

  /** 提交确认验证码。 */
  const confirm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending || enrollment === undefined) return;
    if (!/^\d{6}$/.test(code)) {
      setFailure('请输入 6 位数字验证码。');
      queueMicrotask(focusSummary);
      return;
    }
    setPending(true);
    setFailure(undefined);
    face.confirmTotp(code).then(
      () => {
        setPending(false);
        setConfirmed(true);
        setCode('');
        setNotice('验证码绑定已确认。');
        face.noteAction('access-totp-confirm', 'ok');
        onConfirmed?.();
      },
      (error: unknown) => {
        setPending(false);
        setCode('');
        setFailure(describeAccessFailure(error));
        face.noteAction('access-totp-confirm', 'failed');
        queueMicrotask(focusSummary);
      },
    );
  };

  const binding = enrollment !== undefined && !confirmed;

  return (
    <Panel title="验证码" subtitle="用认证器生成的一次性验证码作为第二因素。">
      {confirmed ? (
        <p data-totp-enrolled><Badge tone="ok">已绑定</Badge> 登录时可以输入认证器上的 6 位验证码。</p>
      ) : null}
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      <div data-access-totp-error id="chdsh-access-totp-error" tabIndex={-1}>
        <ErrorSummary id={`${uid}-summary`} title="绑定没有完成" errors={failure === undefined ? [] : [{ fieldId: 'chdsh-access-totp-confirm-code', message: failure }]} />
      </div>
      <Button id="chdsh-access-totp-start" tone={confirmed ? 'default' : 'primary'} disabled={pending} onClick={start}>
        {confirmed ? '重新绑定验证码' : '开始绑定验证码'}
      </Button>

      {enrollment === undefined ? null : (
        <section aria-labelledby={`${uid}-binding`} data-totp-binding>
          <h3 id={`${uid}-binding`}>绑定信息</h3>
          <p data-totp-qr-unavailable>
            当前部署没有安装成熟的二维码生成库，无法显示二维码。请把下面的密钥手动输入认证器，或者复制 otpauth 地址导入认证器。绑定信息只在本次页面显示，离开后不能再次查看，密钥也不会进入日志、导出与遥测。
          </p>
          <Field label="密钥" help="base32 写法的共享密钥，只在本页显示一次。">
            <input id="chdsh-access-totp-secret" name="totp-secret" type="text" readOnly value={enrollment.secret} autoComplete="off" spellCheck={false} />
          </Field>
          <Button id="chdsh-access-totp-copy" type="button" onClick={copySecret} disabled={enrollment.secret === ''}>复制密钥</Button>
          {copyNote === undefined ? null : <StatusLine>{copyNote}</StatusLine>}
          <Field label="otpauth 地址" help="认证器可以导入这条地址，其中包含密钥与发行方。">
            <textarea id="chdsh-access-totp-uri" name="totp-uri" readOnly rows={3} value={enrollment.otpauthUri} spellCheck={false} />
          </Field>
          <form id="chdsh-access-totp-confirm-form" onSubmit={confirm} noValidate>
            <Field label="确认验证码" help="输入认证器上显示的 6 位数字，确认绑定成功。" required>
              <input
                id="chdsh-access-totp-confirm-code"
                name="totp-confirm"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                value={code}
                disabled={pending || !binding}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </Field>
            <Button id="chdsh-access-totp-confirm" type="submit" tone="primary" disabled={pending || !binding}>
              {pending ? '确认中…' : '确认绑定'}
            </Button>
          </form>
        </section>
      )}
    </Panel>
  );
}
