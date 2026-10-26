/**
 * 桌面主进程的遥测。
 *
 * 壳按遥测规范把启动各阶段、运行时编排与电源阻止编成 OTLP，交给运行时提供的同源中继
 * （`/chatdsh/telemetry/browser`）：span 走 `traces`，失败事件走 `logs`。中继在运行时里，
 * 因此上报地址要等运行时起来才拿得到；在那之前的记录先排队，地址就绪后一次性发出。
 * 运行时启动失败时中继尚未存在，这类失败只留在进程日志里。
 *
 * 上报不阻塞启动，也不改变控制流：任何异常都在本模块内吞掉。
 * @module chatdsh-desktop-shell/telemetry
 */

/** 中继路径。 */
const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 本进程在遥测规范里的 instrumentation scope。 */
const SCOPE = '@chatdsh/desktop';

/** 进程形态。 */
const SURFACE = 'desktop';

/** 服务名。 */
const SERVICE = 'chatdsh-desktop';

/** 排队上限，避免运行时迟迟不就绪时无限增长。 */
const QUEUE_LIMIT = 32;

let origin;
const pending = [];

/**
 * 设置中继地址。设置后把排队的记录一次性发出去。
 * @param value - 运行时地址，例如 `http://127.0.0.1:3151`。
 */
export function setTelemetryOrigin(value) {
  origin = value;
  while (pending.length > 0) {
    const item = pending.shift();
    send(item.signal, item.body);
  }
}

/** 生成随机十六进制标识。 */
function hex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 把普通对象编成 OTLP 属性列表，空值跳过。 */
function attributesOf(source) {
  return Object.entries(source)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}

/** 资源属性。 */
function resource() {
  return {
    attributes: [
      { key: 'service.name', value: { stringValue: SERVICE } },
      { key: 'chatdsh.surface', value: { stringValue: SURFACE } },
      { key: 'chatdsh.component', value: { stringValue: SCOPE } },
    ],
  };
}

/** 真正发出一次上报。 */
function send(signal, body) {
  void fetch(`${origin}${RELAY_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-signal': signal, 'x-chatdsh-csrf': '1' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

/** 入队或直发。 */
function post(signal, body) {
  if (origin === undefined) {
    if (pending.length < QUEUE_LIMIT) pending.push({ signal, body });
    return;
  }
  send(signal, body);
}

/**
 * 开始一段 span。
 * @param name - span 名，形如 `chatdsh.desktop.startup.runtime`。
 * @returns 结束函数，入参是结果与附加属性。
 */
export function startSpan(name) {
  const startedAt = Date.now();
  const traceId = hex(16);
  const spanId = hex(8);
  return (outcome, extra = {}) => {
    const endedAt = Date.now();
    post('traces', {
      resourceSpans: [{
        resource: resource(),
        scopeSpans: [{
          scope: { name: SCOPE },
          spans: [{
            traceId,
            spanId,
            name,
            kind: 1,
            startTimeUnixNano: String(startedAt * 1_000_000),
            endTimeUnixNano: String(endedAt * 1_000_000),
            status: { code: outcome === 'ok' ? 1 : 2 },
            attributes: attributesOf({ ...extra, outcome, duration: endedAt - startedAt }),
          }],
        }],
      }],
    });
  };
}

/**
 * 记录一条失败事件。
 * @param name - 事件名。
 * @param source - 属性，通常是 `error.type` 与 `error.code`。
 */
export function noteEvent(name, source) {
  post('logs', {
    resourceLogs: [{
      resource: resource(),
      scopeLogs: [{
        scope: { name: SCOPE },
        logRecords: [{
          timeUnixNano: String(Date.now() * 1_000_000),
          severityNumber: 13,
          severityText: 'WARN',
          body: { stringValue: name },
          attributes: attributesOf(source),
        }],
      }],
    }],
  });
}
