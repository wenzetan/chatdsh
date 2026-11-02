/**
 * 设备管理宿主的出口。
 *
 * 配对码、设备凭据、活动通道登记、设备生命周期与 HTTP/WebSocket 入口按职责分文件，
 * 由本模块统一导出。公共路由挂载由集成工作包完成。
 * @module @chatdsh/gateway/devices
 */

export * from './pairing.ts';
export * from './transports.ts';
export * from './credential.ts';
export * from './lifecycle.ts';
export * from './routes.ts';
