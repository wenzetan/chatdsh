/**
 * 能力组合包的装卸与检查。
 *
 * 记忆与 PWA 各自是一个独立组合包：装载时构造自己的后端连接、扫描、订阅、推送与静态资源
 * 端点，卸载时按相反顺序释放。默认组合一个包都不装，因此不建立任何后端连接、不启动任何
 * 扫描、不登记订阅、不构造推送通道；检查接口按真实持有情况报告每个包的服务、菜单、端点与
 * 资源数量。
 * @module @chatdsh/core-deployment/bundles
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { DeploymentError } from './errors.ts';

/** 组合包可能持有的资源类别。 */
export type BundleResourceKind = 'backend-connection' | 'scan' | 'subscription' | 'push' | 'static-routes';

/** 组合包声明的一项菜单入口。 */
export interface BundleMenuEntry {
  /** 稳定标识。 */
  readonly id: string;
  /** 显示名。 */
  readonly label: string;
}

/** 组合包登记的一个端点。 */
export interface BundleEndpoint {
  /** HTTP 方法。 */
  readonly method: string;
  /** 精确路径。 */
  readonly path: string;
  /** 传输形态。 */
  readonly transport: 'http' | 'sse' | 'websocket';
  /** 处理函数；只在组合包装载期间对外可达。 */
  readonly handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

/** 装载时拿到的上下文。 */
export interface BundleMountContext {
  /** 遥测客户端。 */
  readonly telemetry: ChatdshTelemetry;
}

/** 一次装载的句柄。 */
export interface BundleMountHandle {
  /** 本次装载登记的端点。 */
  readonly endpoints: readonly BundleEndpoint[];
  /** 推送一条通知；只有具备推送通道的组合包实现它。 */
  push?: (message: PushMessage) => Promise<{ readonly status: number }>;
  /** 释放本次装载持有的全部资源。 */
  release(): Promise<void>;
}

/** 一条推送消息。 */
export interface PushMessage {
  /** 订阅标识，对应已登记的订阅。 */
  readonly subscriptionId: string;
  /** 载荷；只放事件类别与匿名对象标识，不放正文。 */
  readonly payload: Readonly<Record<string, string>>;
}

/** 组合包定义。 */
export interface CapabilityBundle {
  /** 稳定标识。 */
  readonly id: string;
  /** 显示名。 */
  readonly label: string;
  /** 装载后持有的资源类别。 */
  readonly resources: readonly BundleResourceKind[];
  /** 装载后提供的服务。 */
  readonly services: readonly string[];
  /** 装载后出现的菜单入口。 */
  readonly menus: readonly BundleMenuEntry[];
  /** 装载步骤；失败时抛出 {@link DeploymentError}。 */
  mount(context: BundleMountContext): Promise<BundleMountHandle>;
}

/** 一个组合包的当前状态。 */
export interface BundleState {
  /** 稳定标识。 */
  readonly id: string;
  /** 显示名。 */
  readonly label: string;
  /** 是否已装载。 */
  readonly mounted: boolean;
  /** 持有的资源数量，按类别给出。 */
  readonly resources: Readonly<Record<string, number>>;
  /** 提供的服务；未装载时为空。 */
  readonly services: readonly string[];
  /** 菜单入口；未装载时为空。 */
  readonly menus: readonly BundleMenuEntry[];
  /** 端点；未装载时为空。 */
  readonly endpoints: readonly { readonly method: string; readonly path: string; readonly transport: string }[];
}

/** 装载检查的快照。 */
export interface DeploymentSnapshot {
  /** 全部组合包的状态。 */
  readonly bundles: readonly BundleState[];
  /** 默认组合装载的包标识；最轻组合为空。 */
  readonly lightest: readonly string[];
  /** 全部组合包合计持有的资源数量。 */
  readonly resources: Readonly<Record<string, number>>;
  /** 平台能力的加载结果。 */
  readonly capabilities: readonly PlatformCapability[];
}

/** 平台能力的一项声明。 */
export interface PlatformCapability {
  /** 能力标识。 */
  readonly id: string;
  /** 真实加载结果。 */
  readonly status: 'available' | 'missing';
  /** 加载失败时的原因码。 */
  readonly code?: string;
}

/** 组合包部署的输入。 */
export interface CapabilityDeploymentOptions {
  /** 可装载的组合包。 */
  readonly bundles: readonly CapabilityBundle[];
  /** 遥测客户端。 */
  readonly telemetry: ChatdshTelemetry;
  /** 启动时就装载的包；缺省一个都不装，即最轻组合。 */
  readonly initialBundles?: readonly string[];
  /** 平台能力的加载结果；由能力探测步骤填入。 */
  readonly capabilities?: readonly PlatformCapability[];
}

/** 内部记录：一个组合包的装载状态。 */
interface MountedBundle {
  readonly handle: BundleMountHandle;
  readonly counts: Map<BundleResourceKind, number>;
}

/**
 * 组合包装卸与检查。
 */
export class CapabilityDeployment {
  readonly #bundles: readonly CapabilityBundle[];
  readonly #telemetry: ChatdshTelemetry;
  readonly #mounted = new Map<string, MountedBundle>();
  readonly #capabilities: PlatformCapability[];
  readonly #initial: readonly string[];

  constructor(options: CapabilityDeploymentOptions) {
    const ids = new Set<string>();
    for (const bundle of options.bundles) {
      if (ids.has(bundle.id)) {
        throw new DeploymentError('bundle-duplicate', 'bundle', 500, `组合包标识重复：${bundle.id}`);
      }
      ids.add(bundle.id);
    }
    this.#bundles = options.bundles;
    this.#telemetry = options.telemetry;
    this.#capabilities = [...(options.capabilities ?? [])];
    this.#initial = [...(options.initialBundles ?? [])];
  }

  /**
   * 按配置装载启动时就该出现的组合包；缺省一个都不装。
   * @returns 装载之后的快照。
   */
  async start(): Promise<DeploymentSnapshot> {
    for (const id of this.#initial) await this.mount(id);
    return this.inspect();
  }

  /**
   * 装载一个组合包。
   * @param id - 组合包标识。
   * @returns 装载之后的状态。
   * @throws DeploymentError 标识未知、已经装载，或装载步骤失败。
   */
  async mount(id: string): Promise<BundleState> {
    const telemetry = this.#telemetry;
    return telemetry.runSpan('chatdsh.gateway.deploy.bundle', { action: 'mount', module: id, outcome: 'starting' }, async (span) => {
      const bundle = this.#bundleOf(id);
      if (this.#mounted.has(id)) {
        throw this.#rejectBundle(span, id, 'mount', 'bundle-already-mounted', '组合包已经处于装载状态');
      }
      let handle: BundleMountHandle;
      try {
        handle = await bundle.mount({ telemetry });
      } catch (error) {
        if (error instanceof DeploymentError) {
          throw this.#rejectBundle(span, id, 'mount', error.code, error.message, error.status);
        }
        throw this.#rejectBundle(span, id, 'mount', 'bundle-mount-failed', '组合包装载失败', 502);
      }
      const counts = new Map<BundleResourceKind, number>();
      for (const kind of bundle.resources) counts.set(kind, 1);
      this.#mounted.set(id, { handle, counts });
      span.setAttribute('count', bundle.resources.length);
      span.setAttribute('outcome', 'mounted');
      telemetry
        .counter('chatdsh_gateway_deploy_bundle_mounts_total', { description: '组合包装卸结果' })
        .add(1, { module: id, action: 'mount', outcome: 'mounted' });
      this.#recordResources();
      return this.#stateOf(bundle);
    });
  }

  /**
   * 卸载一个组合包。
   * @param id - 组合包标识。
   * @returns 卸载之后的状态。
   * @throws DeploymentError 标识未知或当前没有装载。
   */
  async unmount(id: string): Promise<BundleState> {
    const telemetry = this.#telemetry;
    return telemetry.runSpan('chatdsh.gateway.deploy.bundle', { action: 'unmount', module: id, outcome: 'starting' }, async (span) => {
      const bundle = this.#bundleOf(id);
      const mounted = this.#mounted.get(id);
      if (mounted === undefined) {
        throw this.#rejectBundle(span, id, 'unmount', 'bundle-not-mounted', '组合包当前没有装载');
      }
      try {
        await mounted.handle.release();
      } catch {
        throw this.#rejectBundle(span, id, 'unmount', 'bundle-release-failed', '组合包资源释放失败');
      }
      this.#mounted.delete(id);
      span.setAttribute('count', bundle.resources.length);
      span.setAttribute('outcome', 'unmounted');
      telemetry
        .counter('chatdsh_gateway_deploy_bundle_mounts_total', { description: '组合包装卸结果' })
        .add(1, { module: id, action: 'unmount', outcome: 'unmounted' });
      this.#recordResources();
      return this.#stateOf(bundle);
    });
  }

  /**
   * 推送一条通知。
   * @param message - 订阅标识与载荷。
   * @returns 推送结果。
   * @throws DeploymentError 带推送通道的组合包没有装载，或投递失败。
   */
  async push(message: PushMessage): Promise<{ readonly status: number }> {
    for (const [id, mounted] of this.#mounted) {
      if (mounted.handle.push === undefined) continue;
      try {
        return await mounted.handle.push(message);
      } catch (error) {
        const code = error instanceof DeploymentError ? error.code : 'push-delivery-failed';
        throw new DeploymentError(code, 'bundle', 502, `组合包 ${id} 的推送投递失败`);
      }
    }
    throw new DeploymentError('bundle-push-unavailable', 'bundle', 503, '没有装载带推送通道的组合包');
  }

  /**
   * 按方法与前缀查找已装载组合包的端点。
   * @param method - HTTP 方法。
   * @param path - 请求路径。
   * @returns 命中的端点；没有命中时为 `undefined`。
   */
  routeOf(method: string, path: string): BundleEndpoint | undefined {
    for (const mounted of this.#mounted.values()) {
      for (const endpoint of mounted.handle.endpoints) {
        if (endpoint.method === method && endpoint.path === path) return endpoint;
      }
    }
    return undefined;
  }

  /**
   * 检查当前装卸状态。
   * @returns 组合包、资源与平台能力的快照。
   */
  inspect(): DeploymentSnapshot {
    return this.#telemetry.runSpanSync(
      'chatdsh.gateway.deploy.bundle',
      { action: 'inspect', outcome: 'ok' },
      (span) => {
        const resources: Record<string, number> = {};
        for (const mounted of this.#mounted.values()) {
          for (const [kind, count] of mounted.counts) resources[kind] = (resources[kind] ?? 0) + count;
        }
        span.setAttribute('count', Object.keys(resources).length);
        return {
          bundles: this.#bundles.map((bundle) => this.#stateOf(bundle)),
          lightest: [...this.#initial],
          resources,
          capabilities: [...this.#capabilities],
        };
      }
    );
  }

  /** 卸载全部组合包，按装载的逆序释放。 */
  async close(): Promise<void> {
    const ids = [...this.#mounted.keys()].reverse();
    for (const id of ids) await this.unmount(id);
  }

  /** 取组合包定义；未知标识就地失败。 */
  #bundleOf(id: string): CapabilityBundle {
    const bundle = this.#bundles.find((candidate) => candidate.id === id);
    if (bundle === undefined) {
      this.#telemetry.event('chatdsh.gateway.deploy.bundle.rejected', {
        action: 'lookup',
        module: id,
        outcome: 'rejected',
        'error.type': 'bundle',
        'error.code': 'bundle-unknown',
      });
      this.#telemetry
        .counter('chatdsh_gateway_deploy_bundle_mounts_total', { description: '组合包装卸结果' })
        .add(1, { module: id, action: 'lookup', outcome: 'rejected' });
      throw new DeploymentError('bundle-unknown', 'bundle', 404, `未知的组合包：${id}`);
    }
    return bundle;
  }

  /** 记录一次装卸拒绝并返回可抛出的错误。 */
  #rejectBundle(
    span: { setAttribute(key: string, value: string | number | boolean): void },
    id: string,
    action: string,
    errorCode: string,
    message: string,
    status = 409
  ): DeploymentError {
    span.setAttribute('outcome', 'rejected');
    span.setAttribute('error.type', 'bundle');
    span.setAttribute('error.code', errorCode);
    this.#telemetry.event('chatdsh.gateway.deploy.bundle.rejected', {
      action,
      module: id,
      outcome: 'rejected',
      'error.type': 'bundle',
      'error.code': errorCode,
    });
    this.#telemetry
      .counter('chatdsh_gateway_deploy_bundle_mounts_total', { description: '组合包装卸结果' })
      .add(1, { module: id, action, outcome: 'rejected' });
    return new DeploymentError(errorCode, 'bundle', status, message);
  }

  /** 把合计持有量写进当前量指标。 */
  #recordResources(): void {
    const totals: Record<string, number> = {};
    for (const mounted of this.#mounted.values()) {
      for (const [kind, count] of mounted.counts) totals[kind] = (totals[kind] ?? 0) + count;
    }
    const gauge = this.#telemetry.gauge('chatdsh_gateway_deploy_resources', {
      description: '组合包当前持有的资源数量',
    });
    for (const kind of ['backend-connection', 'scan', 'subscription', 'push', 'static-routes'] as const) {
      gauge.record(totals[kind] ?? 0, { kind });
    }
  }

  /** 组装一个组合包的状态。 */
  #stateOf(bundle: CapabilityBundle): BundleState {
    const mounted = this.#mounted.get(bundle.id);
    const resources: Record<string, number> = {};
    if (mounted !== undefined) for (const [kind, count] of mounted.counts) resources[kind] = count;
    return {
      id: bundle.id,
      label: bundle.label,
      mounted: mounted !== undefined,
      resources,
      services: mounted === undefined ? [] : [...bundle.services],
      menus: mounted === undefined ? [] : [...bundle.menus],
      endpoints:
        mounted === undefined
          ? []
          : mounted.handle.endpoints.map((endpoint) => ({
              method: endpoint.method,
              path: endpoint.path,
              transport: endpoint.transport,
            })),
    };
  }
}
