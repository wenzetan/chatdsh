/**
 * 服务后端的注册表。
 *
 * 运行时按「种类 + 标识」解析实现，合法取值由注册表决定，配置里写的是字符串。
 * 新增一个同种类实现只需要注册一个新描述符；新增一个种类只需要在契约包里增加
 * 一个文件与一项登记。两类扩展都不改动既有实现。
 *
 * 这里不持有任何具体实现，也不做网络调用：解析与校验是纯计算，失败就地抛出。
 * @module @chatdsh/core-backends
 */

import type {
  BackendCallContext,
  BackendDescriptor,
  BackendDeps,
  BackendHealth,
  BackendKind,
} from '@chatdsh/core-contracts';

/** 注册表的键。 */
export function backendKey(kind: BackendKind, id: string): string {
  return `${kind}:${id}`;
}

/** 解析结果。 */
export interface ResolvedBackend<TService = unknown> {
  /** 命中的描述符。 */
  readonly descriptor: BackendDescriptor<unknown, TService>;
  /** 按配置创建的服务实例。 */
  readonly service: TService;
}

/**
 * 后端注册表。
 *
 * 注册时校验种类与标识非空、同一个键不允许重复。解析失败时把该种类下已注册的标识
 * 一并列在错误信息里，装配阶段的报错因此能直接指出可用的取值。
 */
export class BackendRegistry {
  private readonly descriptors = new Map<string, BackendDescriptor<unknown, unknown>>();

  /** 注册一个实现。同一个键重复注册即抛出。 */
  register(descriptor: BackendDescriptor<unknown, unknown>): void {
    if (descriptor.kind === '') throw new Error('后端描述符缺少种类');
    if (descriptor.id === '') throw new Error(`后端描述符缺少标识：${JSON.stringify(descriptor.kind)}`);
    const key = backendKey(descriptor.kind, descriptor.id);
    if (this.descriptors.has(key)) throw new Error(`后端重复注册：${key}`);
    this.descriptors.set(key, descriptor);
  }

  /** 按种类列出已注册的标识。 */
  list(kind: BackendKind): readonly string[] {
    return [...this.descriptors.entries()]
      .filter(([key]) => key.startsWith(`${kind}:`))
      .map(([key]) => key.slice(kind.length + 1))
      .sort();
  }

  /** 取一个描述符。未注册时抛出，并列出该种类下可用的标识。 */
  descriptorOf<TService>(kind: BackendKind, id: string): BackendDescriptor<unknown, TService> {
    const key = backendKey(kind, id);
    const found = this.descriptors.get(key);
    if (found === undefined) {
      const available = this.list(kind);
      const hint = available.length === 0 ? '该种类下没有任何实现' : `可用取值：${available.join('、')}`;
      throw new Error(`未注册的后端 ${key}；${hint}`);
    }
    return found as BackendDescriptor<unknown, TService>;
  }

  /**
   * 按配置解析出一个实现并创建服务。
   *
   * 配置在创建前经描述符的校验器解析，失败即抛出。
   */
  resolve<TService>(
    kind: BackendKind,
    id: string,
    config: unknown,
    deps: BackendDeps = {},
  ): ResolvedBackend<TService> {
    const descriptor = this.descriptorOf<TService>(kind, id);
    const parsed = descriptor.configSchema.parse(config);
    const service = descriptor.create(parsed, deps);
    return { descriptor, service };
  }

  /** 探测一个实现的可用性。 */
  async health(kind: BackendKind, id: string, deps: BackendDeps = {}): Promise<BackendHealth> {
    return this.descriptorOf(kind, id).health(deps);
  }
}

/**
 * 断言实现声明了某项能力。
 *
 * 调用方在调用前断言，缺少该能力时按 `unsupported` 失败，而不是带着残缺语义继续。
 */
export function assertCapability(
  descriptor: BackendDescriptor<unknown, unknown>,
  capability: string,
): void {
  if (descriptor.capabilities.includes(capability)) return;
  const available = descriptor.capabilities.length === 0 ? '未声明任何能力' : descriptor.capabilities.join('、');
  throw new Error(
    `后端 ${backendKey(descriptor.kind, descriptor.id)} 不支持 ${capability}；${available}`,
  );
}

/**
 * 一次调用的上下文工厂。
 *
 * 适配层不生成链路标识：这里把调用方从当前 span 取出的 `traceparent` 原样带上，
 * 没有活动 span 时留空。
 */
export function callContext(traceparent?: string, signal?: AbortSignal): BackendCallContext {
  return traceparent === undefined ? { signal } : { traceparent, signal };
}
