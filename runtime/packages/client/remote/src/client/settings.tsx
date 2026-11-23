/**
 * 设置区段：中继连接、本机设备标识、中继地址、一次性配对码与遥测开关。
 * @module @chatdsh/client-remote/settings
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { RemoteController } from './controller.ts';
import { errorText, noticeText } from './format.ts';
import { useRemoteController } from './use-controller.ts';

/** 设置区段的属性。 */
export interface SettingsSectionProps {
  readonly t: ChatdshRemoteTranslate;
  readonly controller: RemoteController;
}

/**
 * 设置区段。
 * @param props - 翻译函数与控制器。
 * @returns 设置区段。
 */
export function SettingsSection({ t, controller }: SettingsSectionProps): ReactNode {
  const snapshot = useRemoteController(controller);
  const [controlUrl, setControlUrl] = useState(() => snapshot.settings.controlUrl);
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState(false);

  useEffect(() => {
    controller.ensureSettings();
    controller.ensureOverview();
  }, [controller]);

  useEffect(() => {
    setControlUrl(snapshot.settings.controlUrl);
  }, [snapshot.settings.controlUrl]);

  useEffect(() => () => controller.clearPairing(), [controller]);

  const relay = snapshot.relay;
  const relayLabel = relay.state === 'connected'
    ? t('relay.connected')
    : relay.state === 'checking' ? t('relay.checking') : t('relay.disconnected');
  const identity = snapshot.settings.identity !== null
    ? snapshot.settings.identity
    : snapshot.settings.identityError === 'http-404' || snapshot.settings.identityError === 'not-found'
      ? t('settings.identityUnpaired')
      : snapshot.settings.identityError !== null
        ? errorText(t, snapshot.settings.identityError)
        : t('settings.identityUnpaired');
  const telemetry = snapshot.settings.telemetry !== null
    ? snapshot.settings.telemetry.enabled
      ? t('settings.telemetryOn')
      : snapshot.settings.telemetry.reason === undefined
        ? t('settings.telemetryOff')
        : t('settings.telemetryReason', { reason: snapshot.settings.telemetry.reason })
    : snapshot.settings.telemetryError !== null
      ? `${t('settings.telemetryUnavailable')} (${errorText(t, snapshot.settings.telemetryError)})`
      : snapshot.settings.loading ? t('settings.reading') : t('settings.telemetryUnavailable');
  const pairingResult = snapshot.pairing;

  return (
    <section className="chatdsh-remote-settings">
      <h2 className="chatdsh-remote-settings-title">{t('settings.title')}</h2>
      {snapshot.notice !== null
        ? (
          <div className="chatdsh-remote-notice" data-kind={snapshot.notice.kind}>
            <span>{noticeText(t, snapshot.notice)}</span>
            <button type="button" className="chatdsh-remote-button" onClick={() => controller.clearNotice()}>
              {t('notice.dismiss')}
            </button>
          </div>
        )
        : null}
      <dl className="chatdsh-remote-facts">
        <dt>{t('settings.relay')}</dt>
        <dd>{relayLabel}</dd>
        <dt>{t('settings.identity')}</dt>
        <dd>{identity}</dd>
        <dt>{t('settings.telemetry')}</dt>
        <dd>{telemetry}</dd>
      </dl>
      <div className="chatdsh-remote-field">
        <label htmlFor="chatdsh-remote-control-url">{t('settings.controlUrl')}</label>
        <input
          id="chatdsh-remote-control-url"
          className="chatdsh-remote-input"
          type="url"
          value={controlUrl}
          placeholder="http://127.0.0.1:3170"
          onChange={(event: { target: { value: string } }) => setControlUrl(event.target.value)}
        />
        <span className="chatdsh-remote-hint">{t('settings.controlUrlHint')}</span>
        <div className="chatdsh-remote-actions">
          <button type="button" className="chatdsh-remote-button" onClick={() => controller.saveControlUrl(controlUrl)}>
            {t('settings.save')}
          </button>
          <button
            type="button"
            className="chatdsh-remote-button"
            onClick={() => {
              void controller.refreshSettings();
              void controller.refresh();
            }}
          >
            {t('settings.refresh')}
          </button>
        </div>
      </div>
      <div className="chatdsh-remote-field">
        <label htmlFor="chatdsh-remote-pairing-code">{t('settings.pairCode')}</label>
        <input
          id="chatdsh-remote-pairing-code"
          className="chatdsh-remote-input"
          type="text"
          autoComplete="off"
          value={code}
          onChange={(event: { target: { value: string } }) => setCode(event.target.value)}
        />
        <div className="chatdsh-remote-actions">
          <button
            type="button"
            className="chatdsh-remote-button chatdsh-remote-button-primary"
            disabled={code.trim() === '' || pairing}
            onClick={() => {
              void (async () => {
                setPairing(true);
                await controller.pair(code);
                setPairing(false);
                setCode('');
              })();
            }}
          >
            {pairing ? t('settings.pairing') : t('settings.pair')}
          </button>
        </div>
      </div>
      {pairingResult !== null && 'error' in pairingResult
        ? <p className="chatdsh-remote-error">{t('settings.pairError', { code: errorText(t, pairingResult.error) })}</p>
        : null}
      {pairingResult !== null && 'deviceId' in pairingResult
        ? (
          <div className="chatdsh-remote-field">
            <p className="chatdsh-remote-meta">{t('settings.pairSuccess', { id: pairingResult.deviceId })}</p>
            <code className="chatdsh-remote-token">{t('settings.pairToken', { token: pairingResult.token })}</code>
          </div>
        )
        : null}
    </section>
  );
}
