/**
 * 配对码的扫码能力与手动输入。
 *
 * 当前构建没有引入条码解码库。浏览器自带 `BarcodeDetector` 时用相机扫码；没有时明确说明
 * 扫码不可用，并给出手动输入配对码的入口。配对码与控制平面的签发规则一致：16 位、去掉容易
 * 看错的 0、O、1、I，展示时每 4 位一组。
 * @module @chatdsh/client-pwa/scanner
 */

/** 配对码字符数。 */
export const PAIRING_CODE_LENGTH = 16;

/** 配对码字符集，去掉容易看错的 0、O、1、I。 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 展示时的分组长度。 */
export const PAIRING_GROUP_LENGTH = 4;

/** 扫码不可用的原因。 */
export const SCANNER_UNAVAILABLE_REASON = 'decoder-missing';

/** 扫码能力的说明。 */
export interface ScanCapability {
  /** 能否用相机扫码。 */
  readonly available: boolean;
  /** 解码实现：浏览器自带的 BarcodeDetector，或者没有。 */
  readonly decoder: 'barcode-detector' | 'none';
  /** 面向用户的说明。 */
  readonly detail: string;
  /** 扫码不可用时的替代入口。 */
  readonly fallback: 'manual-entry';
}

/** BarcodeDetector 的最小形状。 */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ readonly rawValue: string }[]>;
}

/** BarcodeDetector 的构造签名。 */
type BarcodeDetectorConstructor = new (options?: { readonly formats?: readonly string[] }) => BarcodeDetectorLike;

/**
 * 规范化手动输入的配对码。
 * @param input - 用户输入，允许空格与连字符。
 * @returns 16 位配对码；字符集或长度不合法时为 `undefined`。
 */
export function normalizePairingCode(input: string): string | undefined {
  const compact = input.replaceAll(/[\s-]/g, '').toUpperCase();
  if (compact.length !== PAIRING_CODE_LENGTH) return undefined;
  for (const char of compact) {
    if (!PAIRING_CODE_ALPHABET.includes(char)) return undefined;
  }
  return compact;
}

/**
 * 把配对码排成每 4 位一组的展示形式。
 * @param code - 规范化的配对码。
 * @returns 带连字符的展示文本。
 */
export function formatPairingCode(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += PAIRING_GROUP_LENGTH) {
    groups.push(code.slice(index, index + PAIRING_GROUP_LENGTH));
  }
  return groups.join('-');
}

/**
 * 说明手动输入不通过的原因。
 * @param input - 用户输入。
 * @returns 中文原因；通过时为 `undefined`。
 */
export function pairingCodeError(input: string): string | undefined {
  const compact = input.replaceAll(/[\s-]/g, '');
  if (compact === '') return '请输入配对码';
  if (compact.length !== PAIRING_CODE_LENGTH) {
    return `配对码是 ${String(PAIRING_CODE_LENGTH)} 位，当前输入 ${String(compact.length)} 位`;
  }
  const normalized = normalizePairingCode(input);
  if (normalized === undefined) return '配对码包含不允许的字符：只能使用大写字母与数字，且不含 0、O、1、I';
  return undefined;
}

/**
 * 读取当前环境的扫码能力。
 * @param scope - 全局对象；缺省取运行时全局。
 * @returns 扫码能力说明。
 */
export function barcodeScanCapability(scope: Record<string, unknown> = globalThis): ScanCapability {
  const detector = scope['BarcodeDetector'];
  if (typeof detector === 'function') {
    return {
      available: true,
      decoder: 'barcode-detector',
      detail: '浏览器提供 BarcodeDetector，可以用相机扫描配对二维码。',
      fallback: 'manual-entry',
    };
  }
  return {
    available: false,
    decoder: 'none',
    detail: '当前构建没有包含条码解码库，浏览器也没有提供 BarcodeDetector，扫码不可用。请手动输入配对码。',
    fallback: 'manual-entry',
  };
}

/** 扫码器。 */
export interface PairingScanner {
  /** 扫码能力。 */
  readonly capability: ScanCapability;
  /**
   * 打开相机并等待识别出配对码。
   * @returns 识别到的配对码；识别到的内容不是合法配对码时抛出。
   */
  scan(): Promise<string>;
  /** 停止相机轨道。 */
  stop(): void;
}

/**
 * 建立扫码器。
 *
 * 只有浏览器自带解码器时才打开相机；没有解码器时 `scan` 直接抛出带说明的失败，界面据此
 * 显示手动输入入口。
 * @param options - 全局对象与相机约束覆盖。
 * @returns 扫码器。
 */
export function createPairingScanner(options: {
  readonly scope?: Record<string, unknown>;
  readonly navigator?: Navigator;
  readonly document?: Document;
} = {}): PairingScanner {
  const scope: Record<string, unknown> = options.scope ?? (globalThis as unknown as Record<string, unknown>);
  const nav = options.navigator ?? navigator;
  const doc = options.document ?? document;
  const capability = barcodeScanCapability(scope);
  let stream: MediaStream | undefined;

  return {
    capability,

    async scan(): Promise<string> {
      if (!capability.available) throw new Error(capability.detail);
      if (nav.mediaDevices === undefined) throw new Error('当前来源没有相机接口，无法扫码');
      const Constructor = scope['BarcodeDetector'] as BarcodeDetectorConstructor;
      const detector = new Constructor({ formats: ['qr_code'] });
      stream = await nav.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = doc.createElement('video');
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      try {
        for (;;) {
          const results = await detector.detect(video);
          const raw = results[0]?.rawValue;
          if (raw !== undefined) {
            const code = normalizePairingCode(raw);
            if (code === undefined) throw new Error('二维码内容不是合法的配对码，请手动输入配对码');
            return code;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 250);
          });
        }
      } finally {
        this.stop();
      }
    },

    stop(): void {
      if (stream === undefined) return;
      for (const track of stream.getTracks()) track.stop();
      stream = undefined;
    },
  };
}
