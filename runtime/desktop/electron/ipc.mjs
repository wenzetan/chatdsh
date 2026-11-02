/**
 * 桌面壳的 IPC 白名单与分发。
 *
 * 渲染进程只能调用这里登记过的通道，每个通道的参数在这里校验，来源在这里核对。分发入口
 * 由主进程接到 `ipcMain` 上，预加载脚本只按同一份白名单暴露具名方法，页面拿不到任意
 * `ipcRenderer` 调用能力。
 *
 * 分发器本身不依赖 Electron，参数与来源判定全是纯函数，测试可以直接驱动它。
 * @module chatdsh-desktop-shell/ipc
 */

import { EVENTS, METRICS, SPANS, beginSpan, noteCount, noteFailure } from './signals.mjs';

/** 一次 IPC 调用被拒绝。 */
export class IpcRejection extends Error {
  /**
   * @param code - 拒绝原因代码。
   * @param detail - 供日志使用的说明。
   */
  constructor(code, detail) {
    super(detail === undefined ? `IPC 拒绝：${code}` : `IPC 拒绝：${code}（${detail}）`);
    this.name = 'IpcRejection';
    this.code = code;
    this.detail = detail;
  }
}

/** 参数数量与类型不符时的统一入口。 */
function argumentFailure(code, detail) {
  return new IpcRejection(code, detail);
}

/** 参数描述：把原始值转成落库值，非法时抛出。 */
export const argument = {
  /** 文本参数。 */
  text({ maxLength = 512, required = true } = {}) {
    return {
      required,
      parse(value) {
        if (typeof value !== 'string') throw argumentFailure('argument-type', '参数必须是字符串');
        if (value.length === 0) throw argumentFailure('argument-empty', '参数不能为空');
        if (value.length > maxLength) throw argumentFailure('argument-too-long', `参数长度超过 ${maxLength}`);
        return value;
      },
    };
  },
  /** 布尔参数。 */
  flag({ required = true } = {}) {
    return {
      required,
      parse(value) {
        if (typeof value !== 'boolean') throw argumentFailure('argument-type', '参数必须是布尔值');
        return value;
      },
    };
  },
  /** 整数参数，可限定范围。 */
  integer({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
    return {
      required,
      parse(value) {
        if (typeof value !== 'number' || !Number.isInteger(value)) throw argumentFailure('argument-type', '参数必须是整数');
        if (value < min || value > max) throw argumentFailure('argument-range', `参数超出 ${min}..${max}`);
        return value;
      },
    };
  },
  /** 枚举参数。 */
  choice(values, { required = true } = {}) {
    const allowed = new Set(values);
    return {
      required,
      parse(value) {
        if (typeof value !== 'string') throw argumentFailure('argument-type', '参数必须是字符串');
        if (!allowed.has(value)) throw argumentFailure('argument-choice', `参数必须是 ${[...allowed].join('/')}`);
        return value;
      },
    };
  },
  /** 字符串列表参数。 */
  textList({ maxItems = 64, maxLength = 200, required = true } = {}) {
    return {
      required,
      parse(value) {
        if (!Array.isArray(value)) throw argumentFailure('argument-type', '参数必须是数组');
        if (value.length > maxItems) throw argumentFailure('argument-too-long', `列表超过 ${maxItems} 项`);
        return value.map((item) => {
          if (typeof item !== 'string' || item.length === 0 || item.length > maxLength) {
            throw argumentFailure('argument-type', '列表项必须是长度合法的字符串');
          }
          return item;
        });
      },
    };
  },
};

/** 没有参数。 */
export function noArguments(args) {
  if (args.length !== 0) throw argumentFailure('arguments-count', `期望 0 个参数，收到 ${args.length} 个`);
  return [];
}

/** 单个布尔参数。 */
export function booleanArgument(args) {
  if (args.length !== 1) throw argumentFailure('arguments-count', `期望 1 个参数，收到 ${args.length} 个`);
  return argument.flag().parse(args[0]);
}

/**
 * 单个对象参数：只允许描述里出现的字段，逐个校验。
 * @param shape - 字段名到描述对象的映射。
 * @returns 校验函数。
 */
export function objectArgument(shape) {
  return (args) => {
    if (args.length !== 1) throw argumentFailure('arguments-count', `期望 1 个参数，收到 ${args.length} 个`);
    const value = args[0];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw argumentFailure('argument-type', '参数必须是对象');
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(shape, key)) throw argumentFailure('argument-key', `不允许的字段 ${key}`);
    }
    const parsed = {};
    for (const [key, spec] of Object.entries(shape)) {
      const raw = value[key];
      if (raw === undefined) {
        if (spec.required === true) throw argumentFailure('argument-missing', `缺少字段 ${key}`);
        continue;
      }
      parsed[key] = spec.parse(raw);
    }
    return parsed;
  };
}

/** 主进程发往渲染进程的事件通道。 */
export const EVENT_CHANNELS = Object.freeze([
  'chatdsh:status',
  'chatdsh:menu:action',
  'chatdsh:update:changed',
  'chatdsh:notification:click',
]);

/**
 * 可被渲染进程调用的通道表。
 *
 * `kind` 为 `invoke` 的通道返回结果，为 `send` 的通道不返回结果；两种通道都要通过来源
 * 校验与参数校验。
 */
export const CALL_CHANNELS = Object.freeze([
  { channel: 'chatdsh:status:get', kind: 'invoke', validate: noArguments },
  { channel: 'chatdsh:keepalive:get', kind: 'invoke', validate: noArguments },
  { channel: 'chatdsh:keepalive:set', kind: 'invoke', validate: booleanArgument },
  { channel: 'chatdsh:logs:open', kind: 'invoke', validate: noArguments, fileSenders: true },
  { channel: 'chatdsh:logs:dir', kind: 'invoke', validate: noArguments, fileSenders: true },
  { channel: 'chatdsh:window:state', kind: 'invoke', validate: noArguments },
  { channel: 'chatdsh:native:choose-directory', kind: 'invoke', validate: objectArgument({ purpose: argument.choice(['workspace', 'export', 'artifact']) }) },
  { channel: 'chatdsh:native:open-external', kind: 'invoke', validate: objectArgument({ url: argument.text({ maxLength: 2048 }) }) },
  { channel: 'chatdsh:native:open-path', kind: 'invoke', validate: objectArgument({ path: argument.text({ maxLength: 4096 }) }) },
  { channel: 'chatdsh:native:clipboard-write', kind: 'invoke', validate: objectArgument({ text: argument.text({ maxLength: 1_048_576 }) }) },
  { channel: 'chatdsh:notification:show', kind: 'invoke', validate: objectArgument({
    kind: argument.choice(['approval', 'turn-complete', 'failure', 'update']),
    title: argument.text({ maxLength: 120 }),
    body: argument.text({ maxLength: 320 }),
    route: argument.text({ maxLength: 200 }),
  }) },
  { channel: 'chatdsh:update:state', kind: 'invoke', validate: noArguments },
  { channel: 'chatdsh:update:check', kind: 'invoke', validate: objectArgument({ channel: argument.choice(['stable', 'beta'], { required: false }) }) },
  { channel: 'chatdsh:update:download', kind: 'invoke', validate: noArguments },
  { channel: 'chatdsh:update:install', kind: 'invoke', validate: objectArgument({ confirmed: argument.flag() }) },
  { channel: 'chatdsh:update:cancel', kind: 'invoke', validate: noArguments },
  { channel: 'chatdsh:power:state', kind: 'invoke', validate: noArguments },
  { channel: 'chatdsh:power:set', kind: 'invoke', validate: objectArgument({ enabled: argument.flag(), mode: argument.choice(['prevent-display-sleep', 'prevent-app-suspension'], { required: false }) }) },
  { channel: 'chatdsh:login:state', kind: 'invoke', validate: noArguments },
  { channel: 'chatdsh:login:set', kind: 'invoke', validate: objectArgument({ enabled: argument.flag() }) },
  { channel: 'chatdsh:startup:failure', kind: 'invoke', validate: noArguments, fileSenders: true },
  { channel: 'chatdsh:startup:retry', kind: 'invoke', validate: noArguments, fileSenders: true },
  { channel: 'chatdsh:startup:safe-mode', kind: 'invoke', validate: objectArgument({ reason: argument.text({ maxLength: 200 }), disabledExtensions: argument.textList({ required: false }) }), fileSenders: true },
  { channel: 'chatdsh:startup:diagnostics', kind: 'invoke', validate: noArguments, fileSenders: true },
  { channel: 'chatdsh:window:minimize', kind: 'send', validate: noArguments },
  { channel: 'chatdsh:window:toggle-maximize', kind: 'send', validate: noArguments },
  { channel: 'chatdsh:window:close', kind: 'send', validate: noArguments },
  { channel: 'chatdsh:activity:report', kind: 'send', validate: objectArgument({ runningTurns: argument.integer({ min: 0, max: 9999 }), pendingApprovals: argument.integer({ min: 0, max: 9999 }), drafts: argument.integer({ min: 0, max: 9999 }) }) },
]);

/** 通道表按通道名索引。 */
export const CHANNEL_INDEX = new Map(CALL_CHANNELS.map((entry) => [entry.channel, entry]));

/** 渲染进程可以调用的通道名集合，预加载脚本按它暴露方法。 */
export const ALLOWED_CHANNELS = Object.freeze(CALL_CHANNELS.map((entry) => entry.channel));

/**
 * 核对来源地址。
 *
 * 窗口加载的是本机控制平面地址，页面里嵌入的第三方框架不能借同一个渲染进程调用桌面
 * 能力。壳自带的本地页面（启动页与恢复页）只按精确地址放行，并且只能调用标了
 * `fileSenders` 的通道。
 * @param url - 发送方框架地址。
 * @param allowedOrigins - 允许的来源集合。
 * @param allowedFiles - 允许的本地页面精确地址集合。
 * @param entry - 通道登记项。
 */
export function assertSenderUrl(url, allowedOrigins, allowedFiles = new Set(), entry = undefined) {
  if (typeof url !== 'string' || url === '') throw new IpcRejection('sender-url-invalid', '发送方没有地址');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new IpcRejection('sender-url-invalid', '发送方地址无法解析');
  }
  if (parsed.protocol === 'file:') {
    if (entry?.fileSenders !== true) throw new IpcRejection('sender-not-allowed', '本地页面不能调用这个通道');
    if (!allowedFiles.has(parsed.href)) throw new IpcRejection('sender-not-allowed', '本地页面不在允许集合里');
    return parsed;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IpcRejection('sender-scheme', `不允许的来源协议 ${parsed.protocol}`);
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new IpcRejection('sender-not-allowed', '来源不在允许集合里');
  }
  return parsed;
}

/**
 * 核对来源框架是主框架。
 * @param event - Electron 的 IPC 事件对象。
 */
export function assertMainFrame(event) {
  if (event.senderFrame === null || event.senderFrame === undefined) {
    throw new IpcRejection('sender-frame-missing', '发送方没有框架');
  }
  if (event.senderMainFrame !== undefined && event.senderFrame !== event.senderMainFrame) {
    throw new IpcRejection('sender-frame-not-main', '只接受主框架的调用');
  }
}

/**
 * 创建分发器。
 * @param options.handlers - 通道名到处理函数的映射。
 * @param options.allowedOrigins - 允许的来源集合。
 * @param options.allowedFiles - 允许的本地页面精确地址集合。
 * @param options.isTrustedSender - 判定事件是否来自受信窗口的处理函数。
 * @param options.channels - 通道表；缺省用内置表，接入方按需并入第二窗口的通道。
 * @returns 分发入口与拒绝原因记录。
 */
export function createIpcRouter({ handlers, allowedOrigins, allowedFiles = new Set(), isTrustedSender, channels = CALL_CHANNELS }) {
  const origins = allowedOrigins instanceof Set ? allowedOrigins : new Set(allowedOrigins);
  const files = allowedFiles instanceof Set ? allowedFiles : new Set(allowedFiles);
  const index = channels === CALL_CHANNELS ? CHANNEL_INDEX : new Map(channels.map((entry) => [entry.channel, entry]));
  const channelNames = channels.map((entry) => entry.channel);

  /** 记录一次拒绝。 */
  function recordRejection(channel, kind, reason) {
    noteFailure(EVENTS.ipcRejected, 'ipc', reason, { channel, kind });
    noteCount(METRICS.ipcRejections, { channel, reason });
  }

  /**
   * 执行一次调用。
   * @param channel - 通道名。
   * @param event - Electron 事件对象。
   * @param args - 原始参数。
   * @param throwOnReject - 是否把拒绝抛给调用方；`invoke` 抛，`send` 只记录。
   */
  async function dispatch(channel, event, args, throwOnReject) {
    const finish = beginSpan(SPANS.ipcInvoke);
    const entry = index.get(channel);
    const reject = (error) => {
      recordRejection(channel, entry?.kind ?? 'unknown', error.code);
      finish('failed', { channel });
      if (throwOnReject) throw error;
      return { ok: false, code: error.code };
    };
    if (entry === undefined) return reject(new IpcRejection('channel-not-allowed', '通道没有登记'));
    if (typeof handlers[channel] !== 'function') {
      return reject(new IpcRejection('handler-missing', '通道没有处理函数'));
    }
    try {
      if (isTrustedSender !== undefined && isTrustedSender(event) !== true) {
        return reject(new IpcRejection('sender-not-trusted', '发送方窗口不匹配'));
      }
      assertMainFrame(event);
      assertSenderUrl(event.senderFrame.url, origins, files, entry);
    } catch (error) {
      if (error instanceof IpcRejection) return reject(error);
      throw error;
    }
    let parsed;
    try {
      parsed = entry.validate(args);
    } catch (error) {
      if (error instanceof IpcRejection) return reject(error);
      throw error;
    }
    const payload = Array.isArray(parsed) ? parsed : [parsed];
    const result = await handlers[channel](...payload);
    finish('ok', { channel });
    return result;
  }

  return {
    /** 处理一次 `invoke` 调用。 */
    invoke(channel, event, ...args) {
      return dispatch(channel, event, args, true);
    },
    /** 处理一次 `send` 调用。 */
    send(channel, event, ...args) {
      return dispatch(channel, event, args, false);
    },
    /** 已接管的通道名。 */
    channels: channelNames,
  };
}
