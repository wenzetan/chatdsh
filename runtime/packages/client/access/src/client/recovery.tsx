/**
 * 一次性恢复码面板。
 *
 * 恢复码只在生成时展示一次，界面逐条标出「未使用」，提供文本文件下载、打印视图与已保存
 * 确认。重新生成会让上一批全部失效，因此生成前经过再次认证；未确认已保存时页面拦截关闭。
 * 恢复码只存在于本次生成的页面状态里，不写入持久存储、日志与遥测。
 * @module @chatdsh/client-access/recovery
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Button, ErrorNote, Panel, StatusLine } from '@chatdsh/core-ui-kit';
import { describeAccessFailure, formatMoment } from './describe.ts';
import { createAccessGateway } from './gateway.ts';
import type {
  AccessGateway,
  AccessSensitiveAction,
  RecoveryCodeSet,
  RecoveryCodeStatus,
} from './types.ts';

/** 恢复码面板属性。 */
export interface RecoveryPanelProps {
  /** 数据入口。 */
  readonly gateway?: AccessGateway;
  /** 已读取的剩余状态。 */
  readonly status?: RecoveryCodeStatus;
  /** 生成前的再次认证；返回 `false` 表示取消。 */
  readonly guard?: (action: AccessSensitiveAction) => Promise<boolean>;
  /** 生成成功后的回调。 */
  readonly onGenerated?: (set: RecoveryCodeSet) => void;
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
 * 下载文件的正文。
 * @param set - 恢复码集合。
 * @returns 纯文本内容。
 */
export function recoveryCodeFileText(set: RecoveryCodeSet): string {
  return [
    'ChatDSH 一次性恢复码',
    `生成时间：${formatMoment(set.generatedAt)}`,
    '每条恢复码只能使用一次。重新生成会让这一批全部失效。',
    '请把这份文件保存在只有你能访问的位置。',
    '',
    ...set.codes.map((code, index) => `${String(index + 1)}. ${code}`),
    '',
  ].join('\n');
}

/**
 * 恢复码面板。
 * @param props - 数据入口、剩余状态、再认证与成功回调。
 * @returns 面板内容。
 */
export function RecoveryPanel({ gateway, status, guard, onGenerated }: RecoveryPanelProps = {}) {
  const face = gatewayOf(gateway);
  const uid = useId();
  const [current, setCurrent] = useState<RecoveryCodeStatus | undefined>(status);
  const [set, setSet] = useState<RecoveryCodeSet | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (status !== undefined) {
      setCurrent(status);
      return;
    }
    face.recoveryStatus().then(
      (value) => setCurrent(value),
      (error: unknown) => setFailure(describeAccessFailure(error)),
    );
  }, [face, status]);

  useEffect(() => {
    if (set === undefined || saved) return;
    const handle = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handle);
    return () => window.removeEventListener('beforeunload', handle);
  }, [set, saved]);

  const downloadUrl = useMemo(() => {
    if (set === undefined) return undefined;
    return URL.createObjectURL(new Blob([recoveryCodeFileText(set)], { type: 'text/plain;charset=utf-8' }));
  }, [set]);

  useEffect(() => {
    if (downloadUrl === undefined) return;
    return () => URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  const downloadName = set === undefined
    ? 'chatdsh-recovery-codes.txt'
    : `chatdsh-recovery-codes-${new Date(set.generatedAt).toISOString().slice(0, 10)}.txt`;

  /** 生成一批新的恢复码，旧码立即失效。 */
  const generate = (): void => {
    setPending(true);
    setFailure(undefined);
    setNotice(undefined);
    const proceed = guard === undefined ? Promise.resolve(true) : guard('regenerate-recovery-codes');
    proceed.then(async (authorized) => {
      if (!authorized) {
        setPending(false);
        setNotice('已取消重新生成恢复码。');
        return;
      }
      try {
        const value = await face.generateRecoveryCodes();
        setSet(value);
        setSaved(value.savedConfirmed);
        setChecked(false);
        setCurrent({ total: value.codes.length, remaining: value.codes.length });
        setPending(false);
        setNotice('新的恢复码已经生成。旧的一批立即失效，请先保存再离开本页。');
        face.noteAction('access-recovery-generate', 'ok');
        onGenerated?.(value);
      } catch (error) {
        setPending(false);
        setFailure(describeAccessFailure(error));
        face.noteAction('access-recovery-generate', 'failed');
      }
    });
  };

  /** 确认已经保存。 */
  const confirmSaved = (): void => {
    setPending(true);
    setFailure(undefined);
    face.confirmRecoveryCodesSaved().then(
      (value) => {
        setPending(false);
        setSet((current) => (current === undefined ? current : { ...current, savedConfirmed: value.savedConfirmed }));
        setSaved(true);
        setNotice('已确认保存这批恢复码。');
        face.noteAction('access-recovery-saved', 'ok');
      },
      (error: unknown) => {
        setPending(false);
        setFailure(describeAccessFailure(error));
        face.noteAction('access-recovery-saved', 'failed');
      },
    );
  };

  return (
    <Panel title="恢复码" subtitle="一次性恢复码用于在丢失验证方式时登录，每条只能使用一次。">
      <p data-recovery-remaining>
        {current === undefined
          ? '正在读取恢复码状态。'
          : `共 ${String(current.total)} 条，剩余 ${String(current.remaining)} 条未使用。`}
      </p>
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      <Button id="chdsh-access-recovery-generate" tone="primary" disabled={pending || (set !== undefined && !saved)} onClick={generate}>
        {set === undefined ? '生成恢复码' : '重新生成恢复码'}
      </Button>
      {set !== undefined && !saved ? <p data-recovery-unsaved>这一批恢复码还没有确认保存，离开页面时会收到提醒。</p> : null}

      {set === undefined ? null : (
        <section aria-labelledby={`${uid}-set`} data-recovery-set>
          <h3 id={`${uid}-set`}>{`本批恢复码（${String(set.codes.length)} 条）`}</h3>
          <p>{`生成时间：${formatMoment(set.generatedAt)}`}</p>
          <ol data-recovery-codes>
            {set.codes.map((code, index) => (
              <li key={`${String(index)}-${code}`} data-recovery-code>
                <code>{code}</code>
              </li>
            ))}
          </ol>
          <p>
            <a id="chdsh-access-recovery-download" href={downloadUrl} download={downloadName}>下载文本文件</a>
          </p>
          <section aria-label="恢复码打印视图" data-print-sheet>
            <h4>恢复码打印视图</h4>
            <p>ChatDSH 一次性恢复码</p>
            <p>{`生成时间：${formatMoment(set.generatedAt)}`}</p>
            <ol>
              {set.codes.map((code, index) => <li key={`${String(index)}-print`}><code>{code}</code></li>)}
            </ol>
            <p>每条恢复码只能使用一次。重新生成会让这一批全部失效。</p>
          </section>
          <style data-access-print>{'@media print { body * { visibility: hidden; } [data-print-sheet], [data-print-sheet] * { visibility: visible; } [data-print-sheet] { position: absolute; inset: 0; } }'}</style>
          <div role="group" aria-label="保存确认">
            <label>
              <input
                id="chdsh-access-recovery-saved"
                name="recovery-saved"
                type="checkbox"
                checked={checked}
                disabled={saved || pending}
                onChange={(event) => setChecked(event.target.checked)}
              />
              {' '}我已经把恢复码保存到安全的位置
            </label>
          </div>
          <Button id="chdsh-access-recovery-saved-confirm" disabled={!checked || saved || pending} onClick={confirmSaved}>
            {saved ? '已确认保存' : '确认保存'}
          </Button>
        </section>
      )}
    </Panel>
  );
}
