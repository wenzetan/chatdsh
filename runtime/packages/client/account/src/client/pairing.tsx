/**
 * 配对面板：签发一次性配对码、显示有效期、给出目标地址与手填载荷。
 *
 * 目标地址取自控制平面的签发返回值，界面把它列在第一位供新设备核对。这一页没有可用的
 * 二维码生成库，因此明确标注二维码不可用，并把同一份内容放进可选中的手填载荷里；配对码
 * 过期后给出提示与重新签发入口。签发失败按控制平面的错误码说明原因。
 * @module @chatdsh/client-account/pairing
 */

import { useEffect, useRef, useState } from 'react';
import { Button, ErrorNote, Field, Panel, StatusLine } from '@chatdsh/core-ui-kit';
import { copyText, type CopyOutcome } from './copy.ts';
import { describeFailure, formatMoment, formatRemaining } from './describe.ts';
import type { DeviceGateway, PairingCode } from './types.ts';

/** 配对面板属性。 */
export interface PairingPanelProps {
  readonly gateway: DeviceGateway;
  /** 签发成功后的回调，用于在区段里提示。 */
  readonly onIssued?: () => void;
}

/**
 * 配对面板。
 * @param props - 数据入口与签发回调。
 * @returns 面板。
 */
export function PairingPanel({ gateway, onIssued }: PairingPanelProps) {
  const [code, setCode] = useState<PairingCode | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<CopyOutcome | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  const payload = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const expired = code !== undefined && now >= code.expiresAt;

  useEffect(() => {
    if (code === undefined) return;
    payload.current?.focus();
  }, [code]);

  useEffect(() => {
    if (code === undefined || expired) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code, expired]);

  const issue = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    setCopied(undefined);
    gateway.issuePairing('manual').then(
      (issued) => {
        if (!alive.current) return;
        setBusy(false);
        setCode(issued);
        setNow(Date.now());
        gateway.noteAction('device-pairing-issue', 'ok');
        onIssued?.();
      },
      (error: unknown) => {
        if (!alive.current) return;
        setBusy(false);
        setFailure(describeFailure(error));
        gateway.noteAction('device-pairing-issue', 'failed');
      },
    );
  };

  return (
    <Panel title="添加执行设备" subtitle="在新设备安装兼容的运行组件，再用这里的配对码把它加入控制平面。">
      <ol>
        <li>在新设备打开配对页。</li>
        <li>粘贴手填载荷，或者按四位一组输入配对码。</li>
        <li>核对目标地址、名称与平台后确认。</li>
      </ol>
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      {code === undefined ? (
        <div data-pairing-empty>
          <Button id="chdsh-device-pairing-issue" tone="primary" disabled={busy} onClick={issue}>
            {busy ? '正在签发…' : '生成配对码'}
          </Button>
          <StatusLine>配对码一次性使用，有效期从签发时刻开始计算，过期后需要重新签发。</StatusLine>
        </div>
      ) : (
        <div data-pairing-issued>
          <dl data-pairing-facts>
            <dt>目标地址</dt>
            <dd data-pairing-target>{code.controlUrl}</dd>
            <dt>有效期</dt>
            <dd data-pairing-remaining>{formatRemaining(code.expiresAt, now)}</dd>
            <dt>到期时刻</dt>
            <dd>{formatMoment(code.expiresAt)}</dd>
            <dt>配对码</dt>
            <dd><output data-pairing-code>{code.code}</output></dd>
          </dl>
          <StatusLine>新设备将连接上面这个地址。请核对协议、主机与端口，与控制平面的实际入口逐字一致。</StatusLine>
          <StatusLine>配对码一次性使用，用掉或过期之后需要重新签发。</StatusLine>
          {expired ? <ErrorNote>配对码已过期，控制平面不再接受它。请重新签发一枚。</ErrorNote> : null}
          <p data-pairing-qr-unavailable>
            二维码：当前部署没有安装二维码生成库，这一页不生成二维码。请把下面的手填载荷复制到新设备，或按四位一组输入配对码。
          </p>
          <Field label="手填载荷" help="新设备粘贴这份载荷，会同时带入目标地址与配对码。">
            <textarea
              id="chdsh-device-pairing-payload"
              readOnly
              rows={3}
              ref={payload}
              value={code.encoded}
              onFocus={(event) => event.currentTarget.select()}
              style={{ fontFamily: 'var(--cdh-font-mono)', fontSize: 'var(--cdh-fs-12)' }}
            />
          </Field>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--cdh-s2)' }}>
            <Button
              id="chdsh-device-pairing-copy"
              onClick={() => {
                void copyText(code.encoded).then((outcome) => {
                  if (!alive.current) return;
                  setCopied(outcome);
                });
              }}
            >
              复制载荷
            </Button>
            <Button id="chdsh-device-pairing-reissue" disabled={busy} onClick={issue}>
              {expired ? '重新签发' : '重签配对码'}
            </Button>
          </div>
          {copied === undefined ? null : (
            <StatusLine>{copied.ok ? '已复制到剪贴板。' : copied.detail}</StatusLine>
          )}
        </div>
      )}
    </Panel>
  );
}
