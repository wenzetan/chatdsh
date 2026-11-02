/**
 * 设备、配对与撤销契约。
 *
 * 访问客户端与执行节点分组展示；执行节点记录平台、角色、能力与在线状态。配对码一次使用
 * 并有有效期，节点令牌只在建立时交给安全存储，控制平面保存摘要，页面不回显。撤销立即
 * 关闭 HTTP 与 WebSocket，保留历史会话与副本记录。
 * @module @chatdsh/core-contracts/devices
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import { countSchema, displayNameSchema, epochMillisSchema, identifierSchema } from './primitives.ts';

/** 执行节点在设备之间承担的位置。 */
export const DEVICE_ROLES = ['host', 'executor', 'both'] as const;

/** 执行节点角色取值。 */
export type DeviceRole = (typeof DEVICE_ROLES)[number];

/** 已登记的执行节点。 */
export const deviceSchema = z.object({
  /** 设备标识，创建后固定。 */
  id: identifierSchema,
  /** 展示名称。 */
  name: displayNameSchema,
  /** 平台标识，例如 `linux`、`win32`、`darwin`、`android`。 */
  platform: identifierSchema,
  /** 在设备之间承担的位置。 */
  role: z.enum(DEVICE_ROLES),
  /** 设备自报的能力标识。 */
  capabilities: z.array(identifierSchema),
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 最后在线时刻的毫秒时间戳。 */
  lastSeenAt: epochMillisSchema,
  /** 当前是否在线。 */
  online: z.boolean(),
  /** 是否为当前页面的执行设备。 */
  currentExecutor: z.boolean(),
  /** 已撤销时为撤销时刻。 */
  revokedAt: epochMillisSchema.optional(),
});

/** 已登记的执行节点。 */
export type Device = z.infer<typeof deviceSchema>;

/** 一个访问客户端。 */
export const accessClientSchema = z.object({
  /** 客户端标识。 */
  id: identifierSchema,
  /** 展示名称。 */
  name: displayNameSchema,
  /** 平台标识。 */
  platform: identifierSchema,
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 最后活动时刻的毫秒时间戳。 */
  lastSeenAt: epochMillisSchema,
  /** 是否为当前客户端。 */
  current: z.boolean(),
  /** 已撤销时为撤销时刻。 */
  revokedAt: epochMillisSchema.optional(),
});

/** 一个访问客户端。 */
export type AccessClient = z.infer<typeof accessClientSchema>;

/** 设备列表，访问客户端与执行节点分组。 */
export const deviceListSchema = z.object({
  accessClients: z.array(accessClientSchema),
  nodes: z.array(deviceSchema),
});

/** 设备列表。 */
export type DeviceList = z.infer<typeof deviceListSchema>;

/** 配对码的展示形式。 */
export const PAIRING_CODE_KINDS = ['qr', 'manual'] as const;

/** 配对码载荷：二维码与手动输入使用同一份内容。 */
export const pairingCodeSchema = z.object({
  /** 展示形式。 */
  kind: z.enum(PAIRING_CODE_KINDS),
  /** 控制平面地址，扫码时用于确认目标。 */
  controlUrl: z.string().min(1),
  /** 可输入编码；一次性使用。 */
  code: z.string().min(8).max(128),
  /** 到期时刻的毫秒时间戳。 */
  expiresAt: epochMillisSchema,
});

/** 配对码载荷。 */
export type PairingCode = z.infer<typeof pairingCodeSchema>;

/** 配对请求。 */
export const pairingRequestSchema = z.object({
  /** 控制平面地址；扫码时由二维码内容带入并要求用户确认。 */
  controlUrl: z.string().min(1),
  /** 配对码。 */
  code: z.string().min(8).max(128),
  /** 设备名称。 */
  name: displayNameSchema,
  /** 平台标识。 */
  platform: identifierSchema,
  /** 设备角色。 */
  role: z.enum(DEVICE_ROLES),
});

/** 配对请求。 */
export type PairingRequest = z.infer<typeof pairingRequestSchema>;

/** 配对结果。节点令牌只在建立时返回。 */
export const pairingResultSchema = z.object({
  /** 设备标识。 */
  deviceId: identifierSchema,
  /** 设备角色。 */
  role: z.enum(DEVICE_ROLES),
  /** 建立时刻的毫秒时间戳。 */
  pairedAt: epochMillisSchema,
  /** 节点令牌原值，只在建立时交给安全存储。 */
  nodeToken: z.string().min(32),
});

/** 配对结果。 */
export type PairingResult = z.infer<typeof pairingResultSchema>;

/** 撤销请求。 */
export const deviceRevokeRequestSchema = z.object({
  /** 设备标识。 */
  deviceId: identifierSchema,
  /** 撤销原因。 */
  reason: z.enum(['user', 'lost', 'rotate']),
});

/** 撤销请求。 */
export type DeviceRevokeRequest = z.infer<typeof deviceRevokeRequestSchema>;

/** 撤销结果。历史会话与副本记录保留。 */
export const deviceRevokeResultSchema = z.object({
  /** 设备标识。 */
  deviceId: identifierSchema,
  /** 撤销时刻的毫秒时间戳。 */
  revokedAt: epochMillisSchema,
  /** 被关闭的长连接数量。 */
  closedLinks: countSchema,
  /** 历史会话与副本保留。 */
  sessionsPreserved: z.literal(true),
});

/** 撤销结果。 */
export type DeviceRevokeResult = z.infer<typeof deviceRevokeResultSchema>;

/** 链路检查结果。 */
export const deviceLinkCheckSchema = z.object({
  /** 设备标识。 */
  deviceId: identifierSchema,
  /** 检查时刻的毫秒时间戳。 */
  checkedAt: epochMillisSchema,
  /** 是否可达。 */
  reachable: z.boolean(),
  /** 往返耗时，单位毫秒；不可达时缺省。 */
  latencyMs: countSchema.optional(),
  /** 不可达原因码。 */
  code: chatdshErrorCodeSchema.optional(),
});

/** 链路检查结果。 */
export type DeviceLinkCheck = z.infer<typeof deviceLinkCheckSchema>;
