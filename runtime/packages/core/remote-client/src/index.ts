/**
 * 自建 Remote 服务的客户端贡献构造器。
 *
 * 上游的客户端 contribution 由 typert 生成器产出；自建服务没有生成器，因此这里按
 * 同一份形状手写 descriptor：`package` 是宿主服务名，endpoint 是
 * `<服务名>/<方法名>`，参数按声明的种类映射到 strict codec。结果统一按 JSON 解码，
 * 因为客户端只读展示，不参与宿主侧的类型校验。
 *
 * 这一层不依赖 zod 包：调用方传入自己的 zod 实例，打包时不会多出一份运行时。
 * @module @chatdsh/core-remote-client
 */

/** 参数种类。 */
export type RemoteParameterKind = 'string' | 'boolean' | 'number' | 'json';

/** 一个方法的声明。 */
export interface RemoteMethodSpec {
  /** 按顺序的参数。 */
  readonly parameters: readonly { readonly name: string; readonly kind: RemoteParameterKind }[];
}

/** 构造器需要的 zod 子集。 */
export interface ZodLike {
  string(): unknown;
  boolean(): unknown;
  number(): unknown;
  any(): unknown;
}

/** 生成后的 codec。 */
interface Codec {
  readonly mode: 'strict';
  readonly typeSymbol: string;
  readonly create: () => unknown;
}

/** 生成后的参数。 */
interface Parameter {
  readonly name: string;
  readonly wire: string;
  readonly source: 'json';
  readonly codec: Codec;
}

/** 生成后的 descriptor。 */
interface Descriptor {
  readonly id: string;
  readonly service: string;
  readonly namespace: string;
  readonly method: string;
  readonly invocation: { readonly kind: 'direct' };
  readonly parameters: readonly Parameter[];
  readonly result: Codec;
}

/** 一个 contribution。 */
export interface RemoteContribution {
  readonly package: string;
  readonly descriptors: readonly Descriptor[];
}

/** 参数种类到 zod 校验器的映射。 */
function codecOf(kind: RemoteParameterKind, zod: ZodLike): Codec {
  const create = (): unknown => {
    switch (kind) {
      case 'string': return zod.string();
      case 'boolean': return zod.boolean();
      case 'number': return zod.number();
      case 'json': return zod.any();
    }
  };
  return { mode: 'strict', typeSymbol: kind, create };
}

/**
 * 构造一个服务的客户端 contribution。
 * @param service - 宿主服务名，同时是命名空间。
 * @param methods - endpoint 到方法声明的映射，endpoint 形如 `<服务名>/<方法名>`。
 * @param zod - 调用方的 zod 实例。
 * @returns 可直接交给 `ctx.remote.$mount` 的 contribution。
 * @throws endpoint 前缀与服务名不一致时抛出。
 */
export function buildRemoteContribution(
  service: string,
  methods: Readonly<Record<string, RemoteMethodSpec>>,
  zod: ZodLike,
): RemoteContribution {
  const descriptors = Object.entries(methods).map(([endpoint, definition]) => {
    const separator = endpoint.indexOf('/');
    if (separator <= 0) throw new Error(`Remote endpoint 缺少方法名：${endpoint}`);
    const namespace = endpoint.slice(0, separator);
    const method = endpoint.slice(separator + 1);
    if (namespace !== service) throw new Error(`Remote endpoint 的前缀必须是服务名 ${service}：${endpoint}`);
    return {
      id: `${service}#${endpoint}`,
      service,
      namespace,
      method,
      invocation: { kind: 'direct' as const },
      parameters: definition.parameters.map((parameter) => ({
        name: parameter.name,
        wire: parameter.name,
        source: 'json' as const,
        codec: codecOf(parameter.kind, zod),
      })),
      result: codecOf('json', zod),
    };
  });
  return { package: service, descriptors };
}

/**
 * 解包一次 Remote 调用结果。
 *
 * 客户端命名空间方法返回 `{ ok: true, value }` 或 `{ ok: false, error }`；调用方只关心
 * 值，失败时抛错交给组件降级。非 RemoteResult 形状原样返回，便于兼容直接数据。
 * @param result - Remote 调用结果。
 * @returns 成功时的值。
 * @throws Remote 调用失败时抛出，消息带错误码。
 */
export function unwrapRemoteResult<T>(result: unknown): T {
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    const envelope = result as { readonly ok: boolean; readonly value?: unknown; readonly error?: { readonly code?: string } };
    if (envelope.ok) return envelope.value as T;
    throw new Error(`Remote 调用失败：${envelope.error?.code ?? 'unknown'}`);
  }
  return result as T;
}
