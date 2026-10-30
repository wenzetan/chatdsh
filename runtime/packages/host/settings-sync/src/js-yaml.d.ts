/**
 * js-yaml 的最小类型声明。
 *
 * 上游 dsh-app-boot 依赖 js-yaml，运行时沿 DSH 安装的 node_modules 解析得到它；
 * 这个包只需要 load 与 dump 两个入口，这里补一份最小声明，避免为了类型再引一份 @types。
 * @module @chatdsh/host-settings-sync/js-yaml
 */

declare module 'js-yaml' {
  export interface LoadOptions {
    readonly schema?: unknown;
  }

  export interface DumpOptions {
    readonly schema?: unknown;
    readonly lineWidth?: number;
  }

  /** 一个自定义标量类型。 */
  export interface SarfType {
    readonly kind: string;
    readonly resolve: (data: unknown) => boolean;
    readonly construct: (data: string) => unknown;
    readonly instanceOf?: object;
    readonly represent?: (value: unknown) => string;
  }

  /** 标量类型构造器。 */
  export class Type implements SarfType {
    constructor(tag: string, options: Omit<SarfType, 'kind'> & { readonly kind?: string });
    readonly kind: string;
    readonly resolve: (data: unknown) => boolean;
    readonly construct: (data: string) => unknown;
    readonly instanceOf?: object;
    readonly represent?: (value: unknown) => string;
  }

  /** JSON 模式的 schema，可 extend 出带自定义标量的新 schema。 */
  export const JSON_SCHEMA: { extend(types: readonly unknown[]): unknown };

  export function load(text: string, options?: LoadOptions): unknown;
  export function dump(value: unknown, options?: DumpOptions): string;

  const yaml: {
    Type: typeof Type;
    JSON_SCHEMA: typeof JSON_SCHEMA;
    load: typeof load;
    dump: typeof dump;
  };
  export default yaml;
}
