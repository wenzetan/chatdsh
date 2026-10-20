/**
 * 分享面板：管理当前账号名下的快照链接。
 *
 * 分享记录属于控制平面，面板按同源相对路径访问它的接口：经控制平面访问页面时可用，
 * 直连运行时的那条路径上没有这些记录，面板会说明当前形态不支持。
 * @module @chatdsh/client-share
 */

import { useCallback, useEffect, useState } from 'react';

/** 一条分享记录。 */
interface ShareRecord {
  readonly token: string;
  readonly sessionId: string;
  readonly upToSeq: number;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
  readonly visits: number;
}

/** 控制平面的接口路径。 */
export const SHARES_PATH = '/chatdsh/gateway/shares';
export const SHARE_PATH = '/chatdsh/gateway/share';

/** 写操作要求的请求头，与遥测端点一致，跨站表单无法携带。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-share';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots'];

/** 读取分享记录。 */
async function loadShares(): Promise<ShareRecord[]> {
  const response = await fetch(SHARES_PATH, { headers: { 'x-chatdsh-share': 'list' } });
  if (!response.ok) throw new Error(`列表返回 ${response.status}`);
  const payload = (await response.json()) as { shares?: ShareRecord[] };
  return payload.shares ?? [];
}

/** 撤销一条分享。 */
async function revokeShare(token: string): Promise<void> {
  const response = await fetch(`${SHARE_PATH}?token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: { [CSRF_HEADER]: '1' },
  });
  if (!response.ok) throw new Error(`撤销返回 ${response.status}`);
}

/** 设置页区段。 */
function ShareSection() {
  const [shares, setShares] = useState<ShareRecord[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    loadShares().then(
      (records) => {
        setShares(records);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);

  useEffect(refresh, [refresh]);

  if (failed) return <p style={{ fontSize: 13, opacity: 0.7 }}>分享记录暂不可用：这条页面没有经过控制平面。</p>;
  if (shares === undefined) return <p style={{ fontSize: 13, opacity: 0.7 }}>正在读取分享记录…</p>;
  if (shares.length === 0) return <p style={{ fontSize: 13, opacity: 0.7 }}>还没有分享链接。</p>;

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }}>
      {shares.map((record) => {
        const state = record.revokedAt !== undefined ? '已撤销' : '有效';
        return (
          <li key={record.token} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 600 }}>
              {record.sessionId} · 截至序号 {record.upToSeq}
            </div>
            <div style={{ opacity: 0.7 }}>
              {state} · 访问 {record.visits} 次 · 建立于 {new Date(record.createdAt).toISOString()}
            </div>
            {record.revokedAt === undefined ? (
              <button
                type="button"
                disabled={busy === record.token}
                onClick={() => {
                  setBusy(record.token);
                  revokeShare(record.token).then(
                    () => {
                      setBusy(undefined);
                      refresh();
                    },
                    () => {
                      setBusy(undefined);
                      setFailed(true);
                    },
                  );
                }}
                style={{ marginTop: 4, fontSize: 12 }}
              >
                {busy === record.token ? '撤销中…' : '撤销'}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: { slots: ClientSlots }): void {
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 50,
    label: () => '分享',
    locale: 'chatdsh.share',
  }, ShareSection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
