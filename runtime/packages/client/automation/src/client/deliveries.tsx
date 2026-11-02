/**
 * 投递记录：来源、接收时间、去重结果、状态、执行会话与失败原因。
 *
 * 记录按页读取，游标由控制平面给出，界面只保留当前页与上一页的游标。过滤与分页都走真实
 * 接口；失败时显示原因与重试，不把空结果画成「没有投递」。会话跳转只打开业务页面，不改
 * 动任何状态。
 * @module @chatdsh/client-automation/deliveries
 */

import { Badge, Button, EmptyState, ErrorNote, Panel, ScrollRegion, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useState } from 'react';
import {
  DEDUPE_LABELS,
  DELIVERY_STATE_LABELS,
  DELIVERY_STATE_TONES,
  SOURCE_LABELS,
  describeCode,
  formatTimestamp,
} from './format.ts';
import type { Loadable } from './loadable.ts';
import type {
  AutomationDelivery,
  AutomationGateway,
  AutomationRecord,
  DeliveryPage,
  DeliveryState,
} from './types.ts';

/** 每页条数。 */
export const DELIVERY_PAGE_SIZE = 20;

/** 状态过滤的候选。 */
const STATE_FILTERS: readonly DeliveryState[] = ['received', 'validated', 'dispatching', 'accepted', 'completed', 'failed', 'unconfirmed'];

/** 投递面板属性。 */
export interface DeliveryPanelProps {
  /** 数据入口。 */
  readonly gateway: AutomationGateway;
  /** 自动化列表，用于过滤。 */
  readonly automations: readonly AutomationRecord[];
  /** 面板是否处于显示状态；未显示时不发请求。 */
  readonly active: boolean;
}

/**
 * 投递记录面板。
 * @param props - 数据入口与自动化列表。
 * @returns 面板。
 */
export function DeliveryPanel({ gateway, automations, active }: DeliveryPanelProps) {
  const [automationId, setAutomationId] = useState<string>('');
  const [state, setState] = useState<DeliveryState | ''>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<readonly (string | undefined)[]>([]);
  const [page, setPage] = useState<Loadable<DeliveryPage>>({ status: 'loading' });

  const load = useCallback((nextCursor: string | undefined): void => {
    setPage({ status: 'loading' });
    gateway.deliveries({
      limit: DELIVERY_PAGE_SIZE,
      ...(automationId === '' ? {} : { automationId }),
      ...(state === '' ? {} : { state }),
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    }).then(
      (value) => {
        setPage({ status: 'ready', value });
        gateway.noteAction('automation-deliveries', 'ok');
      },
      (error: unknown) => {
        setPage({ status: 'failed', error });
        gateway.noteAction('automation-deliveries', 'failed');
      },
    );
  }, [automationId, state, gateway]);

  useEffect(() => {
    if (!active) return;
    setCursor(undefined);
    setHistory([]);
    load(undefined);
  }, [active, load]);

  const next = (nextCursor: string): void => {
    setHistory((current) => [...current, cursor]);
    setCursor(nextCursor);
    load(nextCursor);
  };

  const previous = (): void => {
    const trail = [...history];
    const target = trail.pop();
    setHistory(trail);
    setCursor(target);
    load(target);
  };

  return (
    <Panel
      title="投递记录"
      subtitle="记录包含事件标识、来源、接收时间、去重结果、状态、执行会话与失败原因；过滤与分页都由控制平面执行。"
    >
      <p className="chdsh-field__help">
        控制器按记录里的环境变量名读取签名密钥，与请求头 x-chatdsh-webhook-secret 逐字比较；密钥值不出现在页面、投递记录与遥测里。
        请求体必须是 JSON 对象，事件标识用于去重：同一事件重复投递不会重复建立会话，调用方显式重试沿用同一去重结论。
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <label htmlFor="chdsh-automation-deliveries-automation">
          自动化
          <select
            id="chdsh-automation-deliveries-automation"
            value={automationId}
            onChange={(event) => setAutomationId(event.currentTarget.value)}
          >
            <option value="">全部自动化</option>
            {automations.map((record) => <option key={record.id} value={record.id}>{record.name}</option>)}
          </select>
        </label>
        <label htmlFor="chdsh-automation-deliveries-state">
          状态
          <select
            id="chdsh-automation-deliveries-state"
            value={state}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setState(value === '' ? '' : value as DeliveryState);
            }}
          >
            <option value="">全部状态</option>
            {STATE_FILTERS.map((candidate) => (
              <option key={candidate} value={candidate}>{DELIVERY_STATE_LABELS[candidate]}</option>
            ))}
          </select>
        </label>
        <Button id="chdsh-automation-deliveries-reload" onClick={() => load(cursor)}>重新读取</Button>
      </div>

      {page.status === 'loading' ? <Skeleton rows={4} /> : null}
      {page.status === 'failed' ? (
        <ErrorNote>
          投递记录不可用：{page.error instanceof Error ? page.error.message : String(page.error)}
        </ErrorNote>
      ) : null}
      {page.status === 'ready' && page.value.deliveries.length === 0 ? (
        <EmptyState>
          还没有投递记录。外部系统按 webhook 地址投递之后，这里会按接收时间列出每一次事件与去重结论。
        </EmptyState>
      ) : null}
      {page.status === 'ready' && page.value.deliveries.length > 0 ? (
        <>
          <ScrollRegion label="投递记录表格">
            <table>
              <caption className="chdsh-field__help">
                {`第 ${String(history.length + 1)} 页，每页 ${String(DELIVERY_PAGE_SIZE)} 条`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">事件标识</th>
                  <th scope="col">来源</th>
                  <th scope="col">接收时间</th>
                  <th scope="col">去重结果</th>
                  <th scope="col">状态</th>
                  <th scope="col">执行会话</th>
                  <th scope="col">失败原因</th>
                </tr>
              </thead>
              <tbody>
                {page.value.deliveries.map((delivery) => (
                  <DeliveryRow
                    key={delivery.deliveryId}
                    delivery={delivery}
                    names={automations}
                    onOpen={() => gateway.noteAction('automation-session-open', 'ok')}
                  />
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
            <Button id="chdsh-automation-deliveries-previous" disabled={history.length === 0} onClick={previous}>
              上一页
            </Button>
            <Button
              id="chdsh-automation-deliveries-next"
              disabled={page.value.nextCursor === undefined}
              onClick={() => {
                if (page.value.nextCursor !== undefined) next(page.value.nextCursor);
              }}
            >
              下一页
            </Button>
            {page.value.nextCursor === undefined ? <StatusLine>已经是最后一页。</StatusLine> : null}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

/** 一行投递记录。 */
function DeliveryRow({ delivery, names, onOpen }: {
  readonly delivery: AutomationDelivery;
  readonly names: readonly AutomationRecord[];
  readonly onOpen: () => void;
}) {
  const name = names.find((record) => record.id === delivery.automationId)?.name ?? delivery.automationId;
  return (
    <tr data-delivery-id={delivery.deliveryId}>
      <td>
        <span title={name}>{delivery.eventId}</span>
      </td>
      <td>{SOURCE_LABELS[delivery.source] ?? delivery.source}</td>
      <td>{formatTimestamp(delivery.receivedAt)}</td>
      <td>{DEDUPE_LABELS[delivery.dedupe]}</td>
      <td>
        <Badge tone={DELIVERY_STATE_TONES[delivery.state]}>{DELIVERY_STATE_LABELS[delivery.state]}</Badge>
      </td>
      <td>
        {delivery.sessionId === undefined ? '尚未建立' : (
          <a
            href={`/sessions/${encodeURIComponent(delivery.sessionId)}`}
            aria-label={`打开投递建立的会话：${delivery.eventId}`}
            onClick={onOpen}
          >
            {delivery.sessionId}
          </a>
        )}
      </td>
      <td>{delivery.code === undefined ? '无' : describeCode(delivery.code)}</td>
    </tr>
  );
}
