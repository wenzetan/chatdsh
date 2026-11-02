/**
 * 部署与传输安全的控制平面出口。
 *
 * 监听计划、请求守卫、组合包装卸与平台能力探测都来自部署核心包；这一层负责把它们接到真实的
 * HTTP 服务与路由上。
 * @module @chatdsh/gateway/deploy
 */

export {
  createDeployListener,
  type DeployListener,
  type DeployListenerOptions,
} from './listener.ts';
export {
  createDeploymentHandler,
  DEPLOYMENT_PREFIX,
  type DeploymentHandler,
  type DeploymentHandlerOptions,
} from './routes.ts';
