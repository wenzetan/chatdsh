/**
 * 连接器条目的呈现。
 *
 * 这一层不依赖运行时：把连接器记录整理成模型可读的几行文字，便于单独验证。
 * @module @chatdsh/tool-connector/format
 */

/** 一条连接器记录里与呈现相关的字段。 */
export interface ConnectorSummary {
  readonly name: string;
  readonly transport: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly credentialEnv?: string;
  readonly enabled: boolean;
}

/**
 * 把连接器记录整理成文字。
 *
 * 停用的条目也列出来并标注状态，模型据此知道它存在但当前不可用。
 * @param records - 连接器记录。
 * @returns 可读的列表；没有记录时返回一句说明。
 */
export function describeConnectors(records: readonly ConnectorSummary[]): string {
  if (records.length === 0) return '还没有登记外部连接器。';
  const lines = records.map((record) => {
    const target = record.transport === 'http'
      ? record.url ?? '地址未填写'
      : `${record.command ?? '命令未填写'}${record.args === undefined || record.args.length === 0 ? '' : ` ${record.args.join(' ')}`}`;
    const state = record.enabled ? '' : '（已停用）';
    const credential = record.credentialEnv === undefined ? '' : `，凭据来自环境变量 ${record.credentialEnv}`;
    return `- ${record.name}${state}：${record.transport} · ${target}${credential}`;
  });
  return `已登记 ${records.length} 个外部连接器：\n${lines.join('\n')}`;
}
