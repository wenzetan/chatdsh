/**
 * 侧栏「远程设备」面板：设备列表、会话列表与离线只读副本。
 * @module @chatdsh/client-remote/panel
 */

import { useEffect, type ReactNode } from 'react';
import type { RemoteController } from './controller.ts';
import { activityText, errorText, noticeText } from './format.ts';
import type { OverviewSession, ReplicaItem } from './model.ts';
import { activityTime, parseDevicePath } from './state.ts';
import { StatusStrip } from './status-bar.tsx';
import type { ReplicaSelection, RemoteSnapshot } from './types.ts';
import { useRemoteController } from './use-controller.ts';

/** 面板组件的属性。 */
export interface PanelPageProps {
  readonly t: ChatdshRemoteTranslate;
  readonly controller: RemoteController;
}

/** 只读副本里的一条记录。 */
function ReplicaItemView({ t, item }: { readonly t: ChatdshRemoteTranslate; readonly item: ReplicaItem; readonly key?: number }): ReactNode {
  const label = ((): string => {
    switch (item.kind) {
      case 'turn':
        return t('replica.turn', { count: item.title });
      case 'user':
        return t('replica.user');
      case 'assistant':
        return t('replica.assistant');
      case 'tool-call':
        return t('replica.toolCall', { name: item.title });
      case 'tool-result':
        return item.failed ? t('replica.toolResultFailed') : t('replica.toolResult');
      case 'approval-asked':
        return t('replica.approvalAsked', { name: item.title });
      case 'approval-decided':
        return t('replica.approvalDecided', { outcome: item.title });
    }
  })();
  const showEmpty = item.kind === 'user' || item.kind === 'assistant' || item.kind === 'tool-result';
  return (
    <li className="chatdsh-remote-event" data-kind={item.kind} data-failed={item.failed}>
      <span className="chatdsh-remote-event-label">{label}</span>
      {item.kind === 'tool-call'
        ? <pre className="chatdsh-remote-event-code">{item.text === '' ? t('replica.noText') : item.text}</pre>
        : item.text !== '' || showEmpty
          ? <p className="chatdsh-remote-event-text">{item.text === '' ? t('replica.noText') : item.text}</p>
          : null}
      {item.detail !== '' ? <span className="chatdsh-remote-event-detail">{t('replica.callId', { id: item.detail })}</span> : null}
    </li>
  );
}

/** 只读副本视图。 */
function ReplicaView({
  t,
  controller,
  selection,
}: {
  readonly t: ChatdshRemoteTranslate;
  readonly controller: RemoteController;
  readonly selection: ReplicaSelection;
}): ReactNode {
  return (
    <section className="chatdsh-remote-replica">
      <header className="chatdsh-remote-replica-head">
        <button type="button" className="chatdsh-remote-button" onClick={() => controller.closeReplica()}>
          {t('replica.back')}
        </button>
        <h2 className="chatdsh-remote-replica-title">{selection.session.title}</h2>
        <span className="chatdsh-remote-replica-badge" data-online={selection.deviceOnline}>
          {selection.deviceOnline ? t('replica.online') : t('replica.offline')}
        </span>
      </header>
      {selection.loading ? <p className="chatdsh-remote-empty">{t('replica.loading')}</p> : null}
      {selection.error !== null ? <p className="chatdsh-remote-error">{t('replica.error', { code: errorText(t, selection.error) })}</p> : null}
      {!selection.loading && selection.error === null && selection.items.length === 0
        ? <p className="chatdsh-remote-empty">{t('replica.empty')}</p>
        : null}
      {selection.items.length > 0
        ? <ol className="chatdsh-remote-events">{selection.items.map((item) => <ReplicaItemView key={item.seq} t={t} item={item} />)}</ol>
        : null}
      <footer className="chatdsh-remote-footer">
        <button
          type="button"
          className="chatdsh-remote-button chatdsh-remote-button-primary"
          disabled={!selection.canFork || selection.forking}
          onClick={() => { void controller.forkReplica(); }}
        >
          {selection.forking ? t('replica.forking') : t('replica.fork')}
        </button>
        {!selection.canFork && !selection.loading && selection.error === null
          ? <span className="chatdsh-remote-hint">{t('replica.noCompleteTurn')}</span>
          : null}
        {selection.fork !== null
          ? <span className="chatdsh-remote-meta">{t('replica.forkCreated', { id: selection.fork.sessionId })}</span>
          : null}
        {selection.forkError !== null
          ? <span className="chatdsh-remote-error">{t('replica.forkError', { code: errorText(t, selection.forkError) })}</span>
          : null}
      </footer>
    </section>
  );
}

/** 设备与会话列表。 */
function OverviewList({
  t,
  controller,
  snapshot,
}: {
  readonly t: ChatdshRemoteTranslate;
  readonly controller: RemoteController;
  readonly snapshot: RemoteSnapshot;
}): ReactNode {
  const now = Date.now();
  return (
    <div className="chatdsh-remote-columns">
      <section className="chatdsh-remote-section">
        <h2 className="chatdsh-remote-section-title">{t('devices.title')}</h2>
        {snapshot.devices.length === 0
          ? <p className="chatdsh-remote-empty">{t('devices.empty')}</p>
          : (
            <ul className="chatdsh-remote-list">
              {snapshot.devices.map((device) => (
                <li className="chatdsh-remote-row" key={device.id}>
                  <div className="chatdsh-remote-row-main">
                    <span className="chatdsh-remote-row-title">
                      <span className="chatdsh-remote-dot" data-online={device.online} />
                      {device.name}
                    </span>
                    <span className="chatdsh-remote-meta">
                      {device.platform} · {t('devices.sessionCount', { count: device.sessionCount })} · {t('devices.lastSeen')} {activityText(t, activityTime(now, device.lastSeenAt))}
                    </span>
                  </div>
                  {device.online
                    ? <a className="chatdsh-remote-link" href={`/d/${encodeURIComponent(device.id)}/`}>{t('devices.open')}</a>
                    : <span className="chatdsh-remote-meta">{t('devices.offline')}</span>}
                </li>
              ))}
            </ul>
          )}
      </section>
      <section className="chatdsh-remote-section">
        <h2 className="chatdsh-remote-section-title">{t('sessions.title')}</h2>
        {snapshot.sessions.length === 0
          ? <p className="chatdsh-remote-empty">{t('sessions.empty')}</p>
          : (
            <ul className="chatdsh-remote-list">
              {snapshot.sessions.map((session) => (
                <SessionRow key={session.sessionId} t={t} controller={controller} session={session} now={now} />
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}

/** 一条会话行。 */
function SessionRow({
  t,
  controller,
  session,
  now,
}: {
  readonly t: ChatdshRemoteTranslate;
  readonly controller: RemoteController;
  readonly session: OverviewSession;
  readonly now: number;
  readonly key?: string;
}): ReactNode {
  return (
    <li className="chatdsh-remote-row">
      <div className="chatdsh-remote-row-main">
        <span className="chatdsh-remote-row-title">
          <span className="chatdsh-remote-dot" data-online={session.online} />
          {session.title}
        </span>
        <span className="chatdsh-remote-meta">
          {t('sessions.device')}: {session.deviceName} · {session.online ? t('devices.online') : t('devices.offline')} · {t('sessions.updated')} {activityText(t, activityTime(now, session.updatedAt))}
        </span>
      </div>
      <span className="chatdsh-remote-actions">
        <button type="button" className="chatdsh-remote-button" onClick={() => { void controller.openReplica(session); }}>
          {t('sessions.view')}
        </button>
        {session.online
          ? <a className="chatdsh-remote-link" href={`/d/${encodeURIComponent(session.deviceId)}/`}>{t('sessions.openDevice')}</a>
          : null}
      </span>
    </li>
  );
}

/**
 * 主面板。
 * @param props - 翻译函数与控制器。
 * @returns 面板。
 */
export function PanelPage({ t, controller }: PanelPageProps): ReactNode {
  const snapshot = useRemoteController(controller);
  useEffect(() => {
    controller.ensureOverview();
  }, [controller]);
  const deviceId = parseDevicePath(location.pathname);
  const device = deviceId === undefined ? undefined : snapshot.devices.find((item) => item.id === deviceId);
  const relay = snapshot.relay;
  const relayLabel = relay.state === 'connected'
    ? t('relay.connected')
    : relay.state === 'checking' ? t('relay.checking') : t('relay.disconnected');
  return (
    <div className="chatdsh-remote-panel">
      <header className="chatdsh-remote-head">
        <h1 className="chatdsh-remote-title">{t('title')}</h1>
        <div className="chatdsh-remote-actions">
          <span className="chatdsh-remote-badge" data-state={relay.state}>{relayLabel}</span>
          <button type="button" className="chatdsh-remote-button" onClick={() => { void controller.refresh(); }}>
            {t('refresh')}
          </button>
        </div>
      </header>
      {deviceId !== undefined ? <StatusStrip t={t} deviceId={deviceId} device={device} /> : null}
      {relay.state === 'disconnected'
        ? <p className="chatdsh-remote-error">{t('relay.reason', { code: errorText(t, relay.code) })}</p>
        : null}
      {snapshot.loadingOverview ? <p className="chatdsh-remote-empty">{t('loading')}</p> : null}
      {snapshot.overviewError !== null && relay.state === 'connected'
        ? <p className="chatdsh-remote-error">{errorText(t, snapshot.overviewError)}</p>
        : null}
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
      {snapshot.replica !== null
        ? <ReplicaView t={t} controller={controller} selection={snapshot.replica} />
        : <OverviewList t={t} controller={controller} snapshot={snapshot} />}
    </div>
  );
}
