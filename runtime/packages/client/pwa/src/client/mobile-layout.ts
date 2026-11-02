/**
 * 移动布局控制器：弹层返回顺序、输入法避让与触控目标检查。
 *
 * 窄屏导航与右栏都以弹层形式出现：每打开一层压入一条历史记录，系统返回先关闭最上层，关闭
 * 之后页面仍停在原来的会话上。输入法弹起时用视觉视口的差值算出遮挡高度，写进根元素的
 * `--pwa-keyboard-inset`，输入区据此整体上移并把焦点元素滚进可见区域。触控目标的检查按
 * 44 像素的下限逐项测量，供验收与诊断使用。
 * @module @chatdsh/client-pwa/mobile-layout
 */

import type { PwaTelemetry } from './telemetry.ts';

/** 视口尺寸；视觉视口与布局视口的差值就是输入法遮挡的高度。 */
export interface ViewportMetrics {
  /** 布局视口高度。 */
  readonly innerHeight: number;
  /** 视觉视口高度。 */
  readonly height: number;
  /** 视觉视口相对布局视口顶部的偏移。 */
  readonly offsetTop: number;
}

/** 触控目标的下限，单位 CSS 像素。 */
export const TOUCH_TARGET_MIN = 44;

/** 判定输入法弹起的阈值，单位 CSS 像素；更小的差值来自地址栏收放。 */
export const KEYBOARD_INSET_THRESHOLD = 80;

/** 一处不达标的触控目标。 */
export interface TouchTargetOffender {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

/** 触控目标检查结果。 */
export interface TouchTargetAudit {
  readonly ok: boolean;
  readonly offenders: readonly TouchTargetOffender[];
}

/** 一个已打开的弹层。 */
export interface LayerHandle {
  readonly id: string;
  readonly element: HTMLElement;
}

/** 布局事件。 */
export type LayoutEvent = 'layer-open' | 'layer-close';

/** 移动布局控制器。 */
export interface MobileLayout {
  /** 挂载到根元素并开始监听视口与历史。 */
  attach(root: HTMLElement): void;
  /** 移除全部监听。 */
  detach(): void;
  /** 同步一次视口尺寸，返回输入法遮挡高度。 */
  syncViewport(metrics?: ViewportMetrics): number;
  /** 当前遮挡高度。 */
  inset(): number;
  /** 打开一层。 */
  openLayer(id: string, element: HTMLElement): void;
  /** 关闭指定层；不传时关闭最上层。 */
  closeLayer(id?: string): boolean;
  /** 关闭最上层并返回它的标识。 */
  closeTopLayer(): string | undefined;
  /** 最上层的标识。 */
  topLayer(): string | undefined;
  /** 判断某层是否打开。 */
  layerOpen(id: string): boolean;
  /** 按 44 像素下限检查触控目标。 */
  auditTouchTargets(): TouchTargetAudit;
  /** 订阅层变化。 */
  on(event: LayoutEvent, listener: (id: string) => void): () => void;
}

/** 布局控制器的依赖。 */
export interface MobileLayoutOptions {
  /** 浏览器窗口对象。 */
  readonly window?: Window;
  /** 文档对象。 */
  readonly document?: Document;
  /** 遥测面。 */
  readonly telemetry?: PwaTelemetry;
}

/**
 * 计算输入法遮挡高度。
 * @param metrics - 视口尺寸。
 * @param threshold - 判定阈值。
 * @returns 遮挡高度；小于阈值时记为 0。
 */
export function keyboardInsetOf(metrics: ViewportMetrics, threshold: number = KEYBOARD_INSET_THRESHOLD): number {
  const raw = metrics.innerHeight - metrics.height - metrics.offsetTop;
  return raw >= threshold ? Math.round(raw) : 0;
}

/** 可聚焦元素的选择器。 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 取一个元素里可以聚焦的子元素。
 * @param element - 容器。
 * @returns 可聚焦元素列表。
 */
function focusableIn(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => !node.hidden);
}

/**
 * 建立移动布局控制器。
 * @param options - 窗口、文档与遥测面。
 * @returns 布局控制器。
 */
export function createMobileLayout(options: MobileLayoutOptions = {}): MobileLayout {
  const win = options.window ?? window;
  const doc = options.document ?? document;
  const telemetry = options.telemetry;
  const layers: LayerHandle[] = [];
  const listeners = new Map<LayoutEvent, Set<(id: string) => void>>();
  let rootElement: HTMLElement | undefined;
  let lastInset = 0;
  let focusBefore: HTMLElement | undefined;

  const emit = (event: LayoutEvent, id: string): void => {
    for (const listener of listeners.get(event) ?? []) listener(id);
  };

  /** 读取当前视口尺寸。 */
  const currentMetrics = (): ViewportMetrics => {
    const visual = win.visualViewport;
    return {
      innerHeight: win.innerHeight,
      height: visual?.height ?? win.innerHeight,
      offsetTop: visual?.offsetTop ?? 0,
    };
  };

  /** 把聚焦限制在最上层里。 */
  const trapFocus = (event: KeyboardEvent): void => {
    const top = layers[layers.length - 1];
    if (top === undefined) return;
    const focusable = focusableIn(top.element);
    if (focusable.length === 0) {
      event.preventDefault();
      top.element.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || !top.element.contains(active))) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && layers.length > 0) {
      event.preventDefault();
      controller.closeTopLayer();
      return;
    }
    if (event.key === 'Tab') trapFocus(event);
  };

  const onViewportChange = (): void => {
    controller.syncViewport();
  };

  const onPopState = (event: PopStateEvent): void => {
    const top = layers[layers.length - 1];
    if (top === undefined) return;
    const state = event.state as { readonly pwaLayer?: unknown } | null;
    if (state !== null && state.pwaLayer === top.id) return;
    controller.closeLayer(top.id);
  };

  const controller: MobileLayout = {
    attach(root: HTMLElement): void {
      rootElement = root;
      win.visualViewport?.addEventListener('resize', onViewportChange);
      win.visualViewport?.addEventListener('scroll', onViewportChange);
      win.addEventListener('resize', onViewportChange);
      win.addEventListener('popstate', onPopState);
      doc.addEventListener('keydown', onKeydown);
      controller.syncViewport();
    },

    detach(): void {
      win.visualViewport?.removeEventListener('resize', onViewportChange);
      win.visualViewport?.removeEventListener('scroll', onViewportChange);
      win.removeEventListener('resize', onViewportChange);
      win.removeEventListener('popstate', onPopState);
      doc.removeEventListener('keydown', onKeydown);
      rootElement = undefined;
      layers.length = 0;
      listeners.clear();
    },

    syncViewport(metrics?: ViewportMetrics): number {
      const inset = keyboardInsetOf(metrics ?? currentMetrics());
      if (rootElement !== undefined) {
        rootElement.style.setProperty('--pwa-keyboard-inset', `${String(inset)}px`);
        rootElement.dataset['keyboardOpen'] = inset > 0 ? 'true' : 'false';
      }
      if (inset > 0) {
        const active = doc.activeElement;
        if (active instanceof HTMLElement) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      if (inset !== lastInset) {
        lastInset = inset;
        telemetry?.action('layout-ime', 'ok');
      }
      return inset;
    },

    inset(): number {
      return lastInset;
    },

    openLayer(id: string, element: HTMLElement): void {
      if (layers.some((layer) => layer.id === id)) return;
      focusBefore = doc.activeElement instanceof HTMLElement ? doc.activeElement : undefined;
      layers.push({ id, element });
      element.hidden = false;
      element.dataset['layerOpen'] = 'true';
      const state = (win.history.state ?? {}) as Record<string, unknown>;
      win.history.pushState({ ...state, pwaLayer: id }, '');
      const focusable = focusableIn(element);
      const first = focusable[0];
      if (first !== undefined) first.focus();
      else element.focus();
      telemetry?.action('layout-layer', 'ok');
      emit('layer-open', id);
    },

    closeLayer(id?: string): boolean {
      const index = id === undefined ? layers.length - 1 : layers.findIndex((layer) => layer.id === id);
      if (index < 0) return false;
      const [removed] = layers.splice(index, 1);
      if (removed === undefined) return false;
      removed.element.hidden = true;
      delete removed.element.dataset['layerOpen'];
      const state = (win.history.state ?? {}) as Record<string, unknown>;
      if (state.pwaLayer === removed.id) win.history.back();
      if (layers.length === 0 && focusBefore !== undefined) {
        focusBefore.focus();
        focusBefore = undefined;
      }
      telemetry?.action('layout-layer', 'ok');
      emit('layer-close', removed.id);
      return true;
    },

    closeTopLayer(): string | undefined {
      const top = layers[layers.length - 1];
      if (top === undefined) return undefined;
      controller.closeLayer(top.id);
      return top.id;
    },

    topLayer(): string | undefined {
      return layers[layers.length - 1]?.id;
    },

    layerOpen(id: string): boolean {
      return layers.some((layer) => layer.id === id);
    },

    auditTouchTargets(): TouchTargetAudit {
      if (rootElement === undefined) return { ok: true, offenders: [] };
      const offenders: TouchTargetOffender[] = [];
      for (const node of rootElement.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="button"]')) {
        if (node.hidden) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.height < TOUCH_TARGET_MIN || rect.width < TOUCH_TARGET_MIN) {
          offenders.push({
            label: node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 24) ?? node.tagName,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
      }
      if (offenders.length > 0) telemetry?.action('layout-touch-audit', 'failed');
      return { ok: offenders.length === 0, offenders };
    },

    on(event: LayoutEvent, listener: (id: string) => void): () => void {
      const bucket = listeners.get(event) ?? new Set();
      bucket.add(listener);
      listeners.set(event, bucket);
      return () => {
        bucket.delete(listener);
      };
    },
  };

  return controller;
}
