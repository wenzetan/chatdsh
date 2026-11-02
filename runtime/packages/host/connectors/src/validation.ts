/**
 * 连接器表单的条件校验。
 *
 * 校验按传输方式分支：stdio 必须有命令、不接受地址；http 必须有地址、不接受命令与参数。
 * 参数必须是字符串数组，凭据只接受环境变量名（不接受凭据值），名称在记录之间唯一。
 * 这一层是纯函数，不读存储、不连网络。
 * @module @chatdsh/host-connectors/validation
 */

import { ChatdshError } from '@chatdsh/core-contracts';
import { TRANSPORTS, type ConnectorRecord, type ConnectorTransport } from './domain.ts';

/** 连接器名称的长度上限。 */
export const CONNECTOR_NAME_LIMIT = 80;

/** 凭据环境变量名的形状。 */
export const CREDENTIAL_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 一份待校验的连接器表单。 */
export interface ConnectorDraft {
  readonly id?: string;
  readonly name: string;
  readonly transport: ConnectorTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly credentialEnv?: string;
  readonly enabled?: boolean;
}

/** 校验通过的规范化表单。 */
export type ValidConnectorDraft = ConnectorDraft & { readonly name: string; readonly transport: ConnectorTransport };

/** 就地拒绝。 */
function invalid(message: string): never {
  throw new ChatdshError('request-invalid', message);
}

/**
 * 解析连接器地址。
 * @param value - 地址原文。
 * @returns 解析后的地址。
 * @throws {@link ChatdshError} 地址不合法时抛出。
 */
function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    return invalid(`连接器地址 ${value} 不是合法的 URL`);
  }
}

/**
 * 校验并规范化一份连接器表单。
 *
 * @param draft - 待校验的表单。
 * @param others - 除本次提交这一条之外的现有记录，用于名称唯一性判定。
 * @returns 规范化后的表单：名称去空白、无效字段剔除。
 * @throws {@link ChatdshError} 字段缺失、类型不符、条件字段冲突或名称重复时抛出。
 */
export function assertConnectorDraft(
  draft: ConnectorDraft,
  others: readonly ConnectorRecord[],
): ValidConnectorDraft {
  if (!TRANSPORTS.includes(draft.transport)) invalid(`连接器的传输方式只支持 stdio 与 http，实际 ${String(draft.transport)}`);
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (name === '') invalid('连接器名称不能为空');
  if (name.length > CONNECTOR_NAME_LIMIT) invalid(`连接器名称最多 ${CONNECTOR_NAME_LIMIT} 个字符`);
  for (const other of others) {
    if (other.id !== draft.id && other.name === name) invalid(`连接器名称 ${name} 已被占用`);
  }

  const args = draft.args;
  if (args !== undefined) {
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
      invalid('连接器参数必须是字符串数组');
    }
  }

  const credentialEnv = draft.credentialEnv === undefined ? undefined : draft.credentialEnv.trim();
  if (credentialEnv !== undefined && credentialEnv !== '' && !CREDENTIAL_ENV_PATTERN.test(credentialEnv)) {
    invalid(`连接器的凭据只接受环境变量名，${credentialEnv} 不是合法的变量名`);
  }

  if (draft.transport === 'stdio') {
    const command = draft.command === undefined ? '' : draft.command.trim();
    if (command === '') invalid('stdio 方式的连接器必须给出命令');
    if (draft.url !== undefined && draft.url.trim() !== '') invalid('stdio 方式的连接器不接受地址');
    return {
      id: draft.id,
      name,
      transport: 'stdio',
      command,
      ...(args === undefined ? {} : { args: [...args] }),
      ...(credentialEnv === undefined || credentialEnv === '' ? {} : { credentialEnv }),
      ...(draft.enabled === undefined ? {} : { enabled: draft.enabled }),
    };
  }

  const url = draft.url === undefined ? '' : draft.url.trim();
  if (url === '') invalid('http 方式的连接器必须给出地址');
  const parsed = parseUrl(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    invalid(`连接器地址只支持 http 与 https，实际 ${parsed.protocol}`);
  }
  if (draft.command !== undefined && draft.command.trim() !== '') invalid('http 方式的连接器不接受命令');
  if (args !== undefined && args.length > 0) invalid('http 方式的连接器不接受参数');
  return {
    id: draft.id,
    name,
    transport: 'http',
    url: parsed.toString(),
    ...(credentialEnv === undefined || credentialEnv === '' ? {} : { credentialEnv }),
    ...(draft.enabled === undefined ? {} : { enabled: draft.enabled }),
  };
}
