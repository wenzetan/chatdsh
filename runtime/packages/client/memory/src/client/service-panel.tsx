import { Badge, Button, EmptyState, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { failureText, formatTimestamp, isServiceMissing, type Loadable, type MemorySettingsView, type MemoryState } from './face.ts';
/**
 * 记忆服务面板：状态、配置来源、召回上限、额外 bank 与最近成功失败时刻。
 *
 * 地址与凭据只显示是否已配置，值不进入界面。读取失败时给错误码与重新读取入口，四种状态
 * 各用一句完整文字说明。
 * @module @chatdsh/client-memory/service-panel
 */

/** 状态文字。 */
const STATE_LABEL: Record<MemoryState, string> = {
  'enabled-available': '已启用可用',
  'enabled-unreachable': '已启用不可达',
  disabled: '未启用',
  'read-failed': '读取失败',
};

/** 状态徽标色调。 */
const STATE_TONE: Record<MemoryState, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  'enabled-available': 'ok',
  'enabled-unreachable': 'warn',
  disabled: 'neutral',
  'read-failed': 'danger',
};

/** 状态面板的属性。 */
export interface ServicePanelProps {
  /** 配置视图的加载状态。 */
  readonly state: Loadable<MemorySettingsView>;
  /** 重新读取配置。 */
  readonly onReload: () => void;
}

/**
 * 渲染记忆服务面板。
 * @param props - 加载状态与重新读取动作。
 * @returns 面板。
 */
export function ServicePanel({ state, onReload }: ServicePanelProps) {
  if (state.status === 'loading') {
    return (
      <Panel title="记忆服务">
        <Skeleton rows={3} />
      </Panel>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <Panel title="记忆服务">
        <StatusLine tone="danger">记忆未启用：宿主没有注册记忆服务。</StatusLine>
        <EmptyState>把记忆组合包加入 profile 的 bundles 列表，并部署记忆后端。</EmptyState>
      </Panel>
    );
  }
  if (state.status === 'failed') {
    return (
      <Panel title="记忆服务">
        <StatusLine tone="danger">
          {isServiceMissing(state.failure) ? '记忆未启用：宿主没有注册记忆服务' : '读取记忆配置失败'}：{failureText(state.failure)}
        </StatusLine>
        <p>
          <Button onClick={onReload}>重新读取</Button>
        </p>
      </Panel>
    );
  }
  const view = state.value;
  return (
    <Panel title="记忆服务" count={<Badge tone={STATE_TONE[view.state]}>{STATE_LABEL[view.state]}</Badge>}>
      <div data-memory-state={view.state}>
        <List>
          <Row
            title="后端状态"
            dot={view.state === 'enabled-available' ? 'ok' : view.state === 'read-failed' ? 'danger' : 'warn'}
            meta={view.enabled ? '记忆已启用；召回与写入按 bank 规则执行。' : '记忆未启用；会话不做召回与写入。'}
          />
          <Row title="配置来源" meta={view.configSource} />
          <Row title="单次召回上限" meta={`${String(view.maxTokens)} 令牌`} />
          <Row title="额外召回 bank" meta={view.extraBanks.length === 0 ? '无' : view.extraBanks.join('、')} />
          <Row title="服务地址" meta={view.endpointConfigured ? '已配置（值不回显）' : '未配置'} />
          <Row title="凭据环境变量" meta={view.credentialEnvConfigured ? '已设置（值不回显）' : '未设置'} />
          <Row title="最近成功" meta={view.lastSuccessAt === undefined ? '无记录' : formatTimestamp(view.lastSuccessAt)} />
          <Row
            title="最近失败"
            meta={view.lastFailureAt === undefined
              ? '无记录'
              : `${formatTimestamp(view.lastFailureAt)}${view.lastErrorCode === undefined ? '' : `（错误码 ${view.lastErrorCode}）`}`}
          />
          <Row title="配置版本" meta={`revision ${String(view.revision)}`} />
        </List>
        <StatusLine>
          启用状态、召回上限与额外 bank 由插件配置行提供，变更从新回合生效；地址与凭据值不进入界面、公开导出与遥测。
        </StatusLine>
        <p>
          <Button onClick={onReload}>重新读取</Button>
        </p>
      </div>
    </Panel>
  );
}
