/**
 * 接入页：密码登录、通行密钥入口、第二因素与安全返回。
 *
 * 密码字段使用 `autocomplete="current-password"` 与 `name="password"`，密码管理器可以填写，
 * 粘贴不被拦截；显示与隐藏按钮是有可访问名称的开关。失败时错误摘要带焦点，字段链接到具体
 * 输入；剩余次数与锁定倒计时分别显示，锁定期结束后自动恢复输入。第二因素支持验证码与一次性
 * 恢复码，验证码输入带时间片剩余秒数。密码、验证码与恢复码只存在于组件状态，提交后立即清空，
 * 不写入任何持久存储、诊断或遥测。
 * @module @chatdsh/client-access/signin
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  ErrorNote,
  ErrorSummary,
  Field,
  Panel,
  ProgressBar,
  Skeleton,
  StatusLine,
} from '@chatdsh/core-ui-kit';
import {
  accessErrorCodeOf,
  describeAccessFailure,
  formatClock,
  formatMoment,
  formatRemaining,
  PASSKEY_REASON_TEXT,
  timeStepSecondsLeft,
  TOTP_PERIOD_MS,
} from './describe.ts';
import { decodeBase64Url, encodeBase64Url } from './encoding.ts';
import { AccessCallError, createAccessGateway } from './gateway.ts';
import type {
  AccessAuthMethod,
  AccessGateway,
  AccessSession,
  AccessStatus,
  Loadable,
  SecondFactorMethod,
} from './types.ts';
import { useNow } from './use-now.ts';

/** 接入页属性。 */
export interface SignInPageProps {
  /** 数据入口；嵌入与测试场景可以直接传入。 */
  readonly gateway?: AccessGateway;
  /** 已校验的返回目标，只接受同源相对路径。 */
  readonly returnTarget?: string;
  /** 登录成功后的回调。 */
  readonly onAuthenticated?: (session: AccessSession, returnTarget?: string) => void;
}

/** 一次表单失败的字段与说明。 */
interface FormFailure {
  readonly fieldId: string;
  readonly message: string;
}

/** 提交中的第二步信息。 */
interface SecondFactorState {
  readonly partialTicket: string;
  readonly methods: readonly AccessAuthMethod[];
  readonly expiresAt: number;
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
 * 把登录结果里的错误码折成字段级失败。
 * @param error - 失败对象。
 * @param fieldId - 出错的字段。
 * @returns 失败说明。
 */
function failureOf(error: unknown, fieldId: string): FormFailure {
  return { fieldId, message: describeAccessFailure(error) };
}

/**
 * 接入页。
 * @param props - 数据入口、返回目标与成功回调。
 * @returns 页面内容。
 */
export function AccessSignInPage({ gateway, returnTarget, onAuthenticated }: SignInPageProps = {}) {
  const face = gatewayOf(gateway);
  const now = useNow();
  const headingId = useId();
  const [state, setState] = useState<Loadable<AccessStatus>>({ status: 'loading' });
  const [step, setStep] = useState<'first' | 'second' | 'authenticated'>('first');
  const [secondFactor, setSecondFactor] = useState<SecondFactorState | undefined>(undefined);
  const [factorMode, setFactorMode] = useState<SecondFactorMethod>('totp');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [failures, setFailures] = useState<readonly FormFailure[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [attemptsLeft, setAttemptsLeft] = useState<number | undefined>(undefined);
  const [lockedUntil, setLockedUntil] = useState<number | undefined>(undefined);
  const [usedRecoveryCodes, setUsedRecoveryCodes] = useState<readonly string[]>([]);
  const [passkeyNote, setPasskeyNote] = useState<string | undefined>(undefined);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [authenticated, setAuthenticated] = useState<AccessSession | undefined>(undefined);
  const secondHeading = useRef<HTMLHeadingElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  const locked = lockedUntil !== undefined && lockedUntil > now;

  const load = useCallback((): void => {
    setState({ status: 'loading' });
    face.status().then(
      (value) => {
        setState({ status: 'ready', value });
        setLockedUntil(value.lockedUntil);
        setStep(value.signedIn ? 'authenticated' : 'first');
        face.noteAction('access-status', 'ok');
      },
      (error: unknown) => {
        setState({ status: 'failed', error });
        face.noteAction('access-status', 'failed');
      },
    );
  }, [face]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!locked) return;
    const handle = setTimeout(() => {
      setLockedUntil(undefined);
      setAttemptsLeft(undefined);
      setAnnouncement('等待期已经结束，可以重新尝试登录。');
    }, lockedUntil - now);
    return () => clearTimeout(handle);
  }, [locked, lockedUntil, now]);

  useEffect(() => {
    if (step === 'second') secondHeading.current?.focus();
    if (step === 'authenticated') doneHeading.current?.focus();
  }, [step]);

  /** 把焦点移到错误摘要，读屏会先读到失败原因。 */
  const failWith = (items: readonly FormFailure[], message: string): void => {
    setFailures(items);
    setAnnouncement(message);
  };

  useEffect(() => {
    if (failures.length === 0) return;
    document.getElementById('chdsh-access-error-summary')?.focus();
  }, [failures]);

  /**
   * 处理一次登录结果。
   * @param result - 服务端结果。
   * @param action - 本次提交对应的界面动作名。
   * @param fieldId - 失败时错误摘要指向的字段。
   */
  const settle = async (
    result: Awaited<ReturnType<AccessGateway['signIn']>>,
    action: 'access-signin' | 'access-second-factor',
    fieldId: string,
  ): Promise<void> => {
    if (result.outcome === 'authenticated') {
      setPassword('');
      setTotpCode('');
      setRecoveryCode('');
      setFailures([]);
      setAttemptsLeft(undefined);
      setLockedUntil(undefined);
      setAuthenticated(result.session);
      setStep('authenticated');
      face.noteAction(action, 'ok');
      setAnnouncement('登录成功。');
      await face.status().then(
        (fresh) => setState({ status: 'ready', value: fresh }),
        () => setAnnouncement('登录成功，访问状态刷新失败。'),
      );
      onAuthenticated?.(result.session, returnTarget);
      return;
    }
    if (result.outcome === 'second-factor-required') {
      setPassword('');
      setSecondFactor({ partialTicket: result.partialTicket, methods: result.methods, expiresAt: result.expiresAt });
      setFactorMode(result.methods.includes('totp') ? 'totp' : 'recovery-code');
      setStep('second');
      setFailures([]);
      setAnnouncement('密码已通过，请输入第二因素完成登录。');
      return;
    }
    setPassword('');
    setTotpCode('');
    setRecoveryCode('');
    face.noteAction(action, 'failed');
    if (result.lockedUntil !== undefined) setLockedUntil(result.lockedUntil);
    setAttemptsLeft(result.attemptsLeft);
    if (result.code === 'ticket-expired') {
      setStep('first');
      setSecondFactor(undefined);
      setAnnouncement('第二因素票据已经过期，请重新输入密码。');
    }
    const error = new AccessCallError(result.code, 401, {
      ...(result.attemptsLeft === undefined ? {} : { attemptsLeft: result.attemptsLeft }),
      ...(result.lockedUntil === undefined ? {} : { lockedUntil: result.lockedUntil }),
      ...(result.used === true ? { used: true } : {}),
    });
    if (result.used === true) {
      failWith([{ fieldId, message: '该恢复码已经使用过，不能再次登录。' }], '该恢复码已经使用过，不能再次登录。');
      return;
    }
    failWith([failureOf(error, fieldId)], describeAccessFailure(error));
  };

  /** 提交密码。 */
  const submitPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (locked || pending) return;
    if (password === '') {
      failWith([{ fieldId: 'chdsh-access-password', message: '请输入密码。' }], '请输入密码。');
      return;
    }
    setPending(true);
    setFailures([]);
    face.signIn({ method: 'password', password }).then(
      async (result) => {
        await settle(result, 'access-signin', 'chdsh-access-password');
        setPending(false);
      },
      (error: unknown) => {
        setPassword('');
        face.noteAction('access-signin', 'failed');
        const call = error instanceof AccessCallError ? error : undefined;
        if (call?.lockedUntil !== undefined) setLockedUntil(call.lockedUntil);
        if (call?.attemptsLeft !== undefined) setAttemptsLeft(call.attemptsLeft);
        failWith([failureOf(error, 'chdsh-access-password')], describeAccessFailure(error));
        setPending(false);
      },
    );
  };

  /** 提交验证码。 */
  const submitTotp = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (locked || pending || secondFactor === undefined) return;
    if (!/^\d{6}$/.test(totpCode)) {
      failWith([{ fieldId: 'chdsh-access-factor', message: '请输入 6 位数字验证码。' }], '请输入 6 位数字验证码。');
      return;
    }
    setPending(true);
    setFailures([]);
    face.signIn({ method: 'totp', code: totpCode, partialTicket: secondFactor.partialTicket }).then(
      async (result) => {
        await settle(result, 'access-second-factor', 'chdsh-access-factor');
        setPending(false);
      },
      (error: unknown) => {
        setTotpCode('');
        face.noteAction('access-second-factor', 'failed');
        const call = error instanceof AccessCallError ? error : undefined;
        if (call?.lockedUntil !== undefined) setLockedUntil(call.lockedUntil);
        if (call?.attemptsLeft !== undefined) setAttemptsLeft(call.attemptsLeft);
        if (accessErrorCodeOf(error) === 'ticket-expired') {
          setStep('first');
          setSecondFactor(undefined);
          setAnnouncement('第二因素票据已经过期，请重新输入密码。');
        }
        failWith([failureOf(error, 'chdsh-access-factor')], describeAccessFailure(error));
        setPending(false);
      },
    );
  };

  /** 提交恢复码。 */
  const submitRecovery = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (locked || pending || secondFactor === undefined) return;
    const submitted = recoveryCode.trim();
    if (submitted === '') {
      failWith([{ fieldId: 'chdsh-access-recovery-code', message: '请输入一条未使用的恢复码。' }], '请输入一条未使用的恢复码。');
      return;
    }
    setPending(true);
    setFailures([]);
    face.signIn({ method: 'recovery-code', code: submitted, partialTicket: secondFactor.partialTicket }).then(
      async (result) => {
        if (result.outcome === 'rejected' && result.used === true) {
          setUsedRecoveryCodes((current) => [...new Set([...current, submitted])]);
        }
        await settle(result, 'access-second-factor', 'chdsh-access-recovery-code');
        setPending(false);
      },
      (error: unknown) => {
        setRecoveryCode('');
        face.noteAction('access-second-factor', 'failed');
        const call = error instanceof AccessCallError ? error : undefined;
        if (call?.lockedUntil !== undefined) setLockedUntil(call.lockedUntil);
        if (call?.attemptsLeft !== undefined) setAttemptsLeft(call.attemptsLeft);
        if (call?.used === true) {
          setUsedRecoveryCodes((current) => [...new Set([...current, submitted])]);
          failWith([{ fieldId: 'chdsh-access-recovery-code', message: '该恢复码已经使用过，不能再次登录。' }], '该恢复码已经使用过，不能再次登录。');
        } else {
          failWith([failureOf(error, 'chdsh-access-recovery-code')], describeAccessFailure(error));
        }
        setPending(false);
      },
    );
  };

  /** 用浏览器通行密钥登录。 */
  const signInWithPasskey = async (): Promise<void> => {
    if (locked || pending || passkeyBusy) return;
    setPasskeyBusy(true);
    setPasskeyNote(undefined);
    try {
      const challenge = await face.passkeyChallenge();
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: decodeBase64Url(challenge.challenge),
          timeout: 120_000,
          userVerification: 'required',
        },
      });
      if (!(credential instanceof PublicKeyCredential)) throw new Error('浏览器没有返回通行密钥凭据。');
      const response = credential.response;
      if (!(response instanceof AuthenticatorAssertionResponse)) throw new Error('通行密钥响应缺少断言数据。');
      const result = await face.signIn({
        method: 'passkey',
        challengeId: challenge.challengeId,
        credentialId: encodeBase64Url(credential.rawId),
        clientDataJSON: encodeBase64Url(response.clientDataJSON),
        authenticatorData: encodeBase64Url(response.authenticatorData),
        signature: encodeBase64Url(response.signature),
      });
      await settle(result, 'access-signin', 'chdsh-access-password');
    } catch (error) {
      face.noteAction('access-passkey', 'failed');
      setPasskeyNote(describeAccessFailure(error));
      setAnnouncement(`通行密钥登录失败：${describeAccessFailure(error)}`);
    } finally {
      setPasskeyBusy(false);
    }
  };

  if (state.status === 'loading') return <Panel title="访问"><Skeleton rows={4} /></Panel>;
  if (state.status === 'failed') {
    return (
      <Panel title="访问">
        <ErrorNote>{`访问状态读取失败：${describeAccessFailure(state.error)}`}</ErrorNote>
        <Button id="chdsh-access-status-reload" onClick={load}>重新读取</Button>
      </Panel>
    );
  }

  const status = state.value;
  const passkeyOffered = status.methods.includes('passkey');
  const passwordOffered = status.methods.includes('password');
  const browserSupportsPasskey = typeof window.PublicKeyCredential === 'function';
  const passkeyUsable = passkeyOffered && browserSupportsPasskey;
  const passkeyReason = status.passkeyUnavailableReason !== undefined
    ? PASSKEY_REASON_TEXT[status.passkeyUnavailableReason]
    : passkeyOffered && !browserSupportsPasskey
      ? PASSKEY_REASON_TEXT['browser-unsupported']
      : browserSupportsPasskey
        ? '当前部署没有登记通行密钥，也没有提供通行密钥校验实现。'
        : PASSKEY_REASON_TEXT['browser-unsupported'];

  if (step === 'authenticated') {
    return (
      <Panel title="访问" subtitle="访问会话已经建立。">
        <h2 id={`${headingId}-done`} ref={doneHeading} tabIndex={-1} data-access-signed-in>
          已登录
        </h2>
        <StatusLine>{authenticated === undefined ? '当前访问会话有效。' : `当前设备：${authenticated.clientName}，建立于 ${formatMoment(authenticated.createdAt)}。`}</StatusLine>
        {returnTarget === undefined
          ? null
          : <p><a id="chdsh-access-return" href={returnTarget}>返回之前的页面</a></p>}
        <div role="status" aria-live="polite" data-access-announcer>{announcement}</div>
      </Panel>
    );
  }

  if (!status.required) {
    return (
      <Panel title="访问" subtitle="当前来源在受信任网络内。">
        <StatusLine>受信任网络可以直接访问，无需输入密码。</StatusLine>
        {returnTarget === undefined ? null : <p><a id="chdsh-access-return" href={returnTarget}>返回之前的页面</a></p>}
      </Panel>
    );
  }

  return (
    <Panel title="访问" subtitle="登录后才能读写私有内容。本部署没有账号注册与账号标识表单。">
      <div role="status" aria-live="polite" data-access-announcer>{announcement}</div>
      <div data-access-error-summary>
        <ErrorSummary
          id="chdsh-access-error-summary"
          title="登录没有完成"
          errors={failures}
        />
      </div>
      {locked ? (
        <p data-access-lock role="timer" aria-live="off">
          {`连续失败次数过多，访问已进入等待期。剩余等待时间 ${formatClock(lockedUntil - now)}（${formatRemaining(lockedUntil - now)}）。`}
        </p>
      ) : null}
      {attemptsLeft === undefined || locked ? null : <p data-access-attempts>{`还可以尝试 ${String(attemptsLeft)} 次。`}</p>}

      {step === 'first' ? (
        <>
          {status.secondFactorPending ? (
            <StatusLine>上一次登录还缺少第二因素。票据只存在于当时的页面，请重新输入密码。</StatusLine>
          ) : null}
          {passwordOffered ? (
            <form id="chdsh-access-password-form" onSubmit={submitPassword} noValidate>
              <h2 id={`${headingId}-password`}>使用密码登录</h2>
              <Field label="密码" help="密码管理器可以填写；粘贴与键盘输入都可以使用。" required error={failures.find((item) => item.fieldId === 'chdsh-access-password')?.message}>
                <input
                  id="chdsh-access-password"
                  name="password"
                  type={revealed ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  disabled={locked || pending}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <Button
                id="chdsh-access-password-reveal"
                type="button"
                aria-controls="chdsh-access-password"
                aria-pressed={revealed}
                aria-label={revealed ? '隐藏密码' : '显示密码'}
                onClick={() => setRevealed((current) => !current)}
              >
                {revealed ? '隐藏密码' : '显示密码'}
              </Button>
              <Button id="chdsh-access-signin-submit" type="submit" tone="primary" disabled={locked || pending}>
                {pending ? '登录中…' : '登录'}
              </Button>
            </form>
          ) : (
            <StatusLine>当前来源不提供密码登录。</StatusLine>
          )}

          <section aria-labelledby={`${headingId}-passkey`} data-access-passkey>
            <h2 id={`${headingId}-passkey`}>使用通行密钥</h2>
            {passkeyUsable ? (
              <>
                <Button id="chdsh-access-passkey-signin" onClick={signInWithPasskey} disabled={locked || pending || passkeyBusy}>
                  {passkeyBusy ? '等待浏览器确认…' : '使用通行密钥'}
                </Button>
                {passkeyNote === undefined ? null : <ErrorNote>{passkeyNote}</ErrorNote>}
              </>
            ) : (
              <p data-access-passkey-unavailable>{passkeyReason}</p>
            )}
          </section>
        </>
      ) : (
        <section aria-labelledby={`${headingId}-second`}>
          <h2 id={`${headingId}-second`} ref={secondHeading} tabIndex={-1}>第二因素</h2>
          <p data-access-second-summary>
            {`密码已通过。请完成第二因素，票据在 ${formatClock((secondFactor?.expiresAt ?? now) - now)} 后过期。`}
          </p>
          <div role="group" aria-label="替换验证方式">
            {secondFactor?.methods.includes('totp') === true ? (
              <Button
                id="chdsh-access-use-totp"
                aria-pressed={factorMode === 'totp'}
                onClick={() => setFactorMode('totp')}
              >
                使用验证码
              </Button>
            ) : null}
            {secondFactor?.methods.includes('recovery-code') === true ? (
              <Button
                id="chdsh-access-use-recovery"
                aria-pressed={factorMode === 'recovery-code'}
                onClick={() => setFactorMode('recovery-code')}
              >
                使用恢复码
              </Button>
            ) : null}
          </div>

          {factorMode === 'totp' ? (
            <form id="chdsh-access-totp-form" onSubmit={submitTotp} noValidate>
              <Field
                label="验证码"
                help="输入认证器上显示的 6 位数字。验证码每 30 秒更新，前后各一个时间片可用。"
                required
                error={failures.find((item) => item.fieldId === 'chdsh-access-factor')?.message}
              >
                <input
                  id="chdsh-access-factor"
                  name="totp"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={totpCode}
                  disabled={locked || pending}
                  onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </Field>
              <p data-access-time-step>{`当前时间片还剩 ${String(timeStepSecondsLeft(now))} 秒。`}</p>
              <ProgressBar ratio={timeStepSecondsLeft(now) / (TOTP_PERIOD_MS / 1000)} label="验证码时间片剩余" />
              <Button id="chdsh-access-totp-submit" type="submit" tone="primary" disabled={locked || pending}>
                {pending ? '验证中…' : '验证并登录'}
              </Button>
            </form>
          ) : (
            <form id="chdsh-access-recovery-form" onSubmit={submitRecovery} noValidate>
              <Field
                label="恢复码"
                help="每条恢复码只能使用一次。恢复码不区分大小写，首尾空白会被忽略。"
                required
                error={failures.find((item) => item.fieldId === 'chdsh-access-recovery-code')?.message}
              >
                <input
                  id="chdsh-access-recovery-code"
                  name="recovery-code"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={recoveryCode}
                  disabled={locked || pending}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                />
              </Field>
              {usedRecoveryCodes.length === 0 ? null : (
                <ul data-access-used-recovery>
                  {usedRecoveryCodes.map((code, index) => (
                    <li key={`${code.slice(0, 2)}-${String(index)}`}><Badge tone="danger">已使用</Badge> 这条恢复码已经使用过，不能再次登录。</li>
                  ))}
                </ul>
              )}
              <Button id="chdsh-access-recovery-submit" type="submit" tone="primary" disabled={locked || pending}>
                {pending ? '验证中…' : '使用恢复码登录'}
              </Button>
            </form>
          )}
        </section>
      )}
    </Panel>
  );
}
