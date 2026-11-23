/**
 * 这些模块由宿主模块加载器在浏览器侧提供，磁盘上没有对应包，
 * 故此处只声明最小类型面。
 *
 * `react` 与 `react/jsx-runtime` 的运行时实现来自宿主模块图；下面的声明只覆盖
 * 本插件用到的函数与类型。slots 服务、locale 服务与 layout 服务同样由宿主提供，
 * 这里用全局接口描述它们的方法签名。
 */

declare module 'react' {
  export type ReactNode = any;
  export type Key = string | number;
  export interface MutableRefObject<T> {
    current: T;
  }
  export function createElement(type: any, props?: any, ...children: any[]): any;
  export function useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, dependencies: readonly unknown[]): T;
  export const Fragment: any;
}

declare module 'react/jsx-runtime' {
  export function jsx(type: any, props: any, key?: any): any;
  export function jsxs(type: any, props: any, key?: any): any;
  export const Fragment: any;
}

declare namespace JSX {
  type Element = any;
  interface IntrinsicElements {
    [name: string]: any;
  }
}

/** 宿主 slots 服务的注册选项。 */
interface ChatdshRemoteSlotOptions {
  readonly name: string;
  readonly key?: string;
  readonly id?: string;
  readonly order?: number;
  readonly label?: string | (() => string);
  readonly locale?: string;
  readonly inject?: () => unknown;
  readonly children?: Readonly<Record<string, unknown>>;
}

/** 宿主 slots 服务的最小面。 */
interface ChatdshRemoteSlotsService {
  inject(name: string, callback: () => (() => void) | Iterable<() => void>): () => void;
  register(options: ChatdshRemoteSlotOptions, component: (props: any) => any): () => void;
  subscribe(name: string, listener: () => void): () => void;
  entriesOfSlot(name: string): readonly unknown[];
  getVersion(name: string): number;
}

/** 宿主 locale 服务的翻译函数。 */
type ChatdshRemoteTranslate = (key: string, parameters?: Readonly<Record<string, string | number>>) => string;

/** 宿主 locale 服务的最小面。 */
interface ChatdshRemoteLocale {
  register(namespace: string, dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void;
  bind(namespace: string): ChatdshRemoteTranslate;
}

/** 宿主 layout 服务的最小面。 */
interface ChatdshRemoteLayout {
  selectPanel(id: string): void;
}
