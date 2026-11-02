/**
 * 触发条件的时间方式：互斥选择、表单校验与下次发生时间。
 *
 * 时间方式分四种：立即、相对延时、定时与重复。重复再分固定间隔、每日、每周与 cron。
 * 四种时间方式互斥，提交时只生成一种触发方式；间隔下限沿用契约里的 60 秒；cron 表达式
 * 只做形状检查与字段分段检查，语义由原会话运行时用成熟解析库验证。
 *
 * 夏令时的两个边界在这里显式处理：本地时刻不存在时按跳过处理，本地时刻出现两次时只取
 * 较早的一次。界面据此给出提示，避免用户以为任务会准点发生。
 * @module @chatdsh/client-automation/schedule
 */

/** 时间方式。 */
export const SCHEDULE_MODES = ['immediate', 'delay', 'once', 'repeat'] as const;

/** 时间方式取值。 */
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

/** 重复方式。 */
export const REPEAT_KINDS = ['interval', 'daily', 'weekly', 'cron'] as const;

/** 重复方式取值。 */
export type RepeatKind = (typeof REPEAT_KINDS)[number];

/** 间隔下限，单位秒，与契约里的取值一致。 */
export const MIN_INTERVAL_SECONDS = 60;

/** 定时任务的一种触发方式。 */
export type ScheduleSpec =
  | { readonly kind: 'once'; readonly at: number; readonly timeZone: string }
  | { readonly kind: 'interval'; readonly everySeconds: number; readonly timeZone: string }
  | { readonly kind: 'daily'; readonly time: string; readonly timeZone: string }
  | { readonly kind: 'weekly'; readonly weekdays: readonly number[]; readonly time: string; readonly timeZone: string }
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string };

/** 表单里的原始取值；输入框都是字符串。 */
export interface ScheduleDraft {
  /** 时间方式。 */
  readonly mode: ScheduleMode;
  /** 相对延时的分钟数。 */
  readonly delayMinutes: string;
  /** 定时方式下的本地时刻，写法 `YYYY-MM-DDTHH:mm`。 */
  readonly localDateTime: string;
  /** 重复方式。 */
  readonly repeat: RepeatKind;
  /** 重复方式的固定间隔秒数。 */
  readonly intervalSeconds: string;
  /** 每日与每周的发生时刻，写法 `HH:mm`。 */
  readonly clock: string;
  /** 每周选中的星期编号，周一为 1，周日为 7。 */
  readonly weekdays: readonly number[];
  /** cron 表达式。 */
  readonly expression: string;
  /** IANA 时区。 */
  readonly timeZone: string;
}

/** 一条字段错误。 */
export interface DraftError {
  /** 出错字段的标识，用于把焦点移到控件。 */
  readonly fieldId: string;
  /** 面向用户的说明。 */
  readonly message: string;
}

/** 星期编号与名称。 */
export const WEEKDAY_NAMES: Readonly<Record<number, string>> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
};

/** 时区候选：常用的 IANA 时区，浏览器时区始终排在最前面。 */
const COMMON_TIME_ZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/** 判断一个时区名称是否被运行环境认可。 */
export function isKnownTimeZone(zone: string): boolean {
  if (zone === 'UTC') return true;
  if (zone.trim() === '') return false;
  return Intl.supportedValuesOf('timeZone').includes(zone);
}

/**
 * 时区候选列表。
 * @param browserZone - 浏览器时区；缺省取运行环境时区。
 * @returns 去重后的候选列表。
 */
export function timeZoneChoices(browserZone?: string): string[] {
  const detected = browserZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ordered = [detected, ...COMMON_TIME_ZONES];
  const seen: string[] = [];
  for (const zone of ordered) {
    if (!isKnownTimeZone(zone) || seen.includes(zone)) continue;
    seen.push(zone);
  }
  return seen;
}

/** 日期与时间的格式化器缓存。 */
const PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** 取一个按字段输出的格式化器。 */
function partsFormatter(zone: string): Intl.DateTimeFormat {
  const cached = PARTS_FORMATTERS.get(zone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  PARTS_FORMATTERS.set(zone, formatter);
  return formatter;
}

/** 墙上时间的一个日期分量。 */
interface WallParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** 取一个时刻在某个时区的墙上日期。 */
function wallPartsOf(zone: string, epochMs: number): WallParts {
  const parts = partsFormatter(zone).formatToParts(new Date(epochMs));
  const pick = (type: 'year' | 'month' | 'day'): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) throw new Error(`时区 ${zone} 的日期分量缺失`);
    return Number(found.value);
  };
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

/**
 * 某个时刻在某个时区的偏移量，单位毫秒。
 * @param zone - IANA 时区。
 * @param epochMs - 时刻。
 * @returns 偏移量；东八区为 8 小时。
 */
export function offsetAt(zone: string, epochMs: number): number {
  const parts = partsFormatter(zone).formatToParts(new Date(epochMs));
  const pick = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) throw new Error(`时区 ${zone} 的分量 ${type} 缺失`);
    return Number(found.value);
  };
  const wall = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/** 一个本地时刻的解析结论。 */
export type WallTimeResolution =
  | { readonly kind: 'unique'; readonly epochMs: number }
  | { readonly kind: 'gap' }
  | { readonly kind: 'overlap'; readonly epochMs: number };

/**
 * 把一个本地时刻解析成时刻。
 *
 * 夏令时切换当天有两种边界：切换跳过的本地时刻不存在，切换重复的本地时刻对应两个时刻。
 * 不存在的时刻判为 `gap`，重复的时刻取较早的一个并标记为 `overlap`。
 * @param zone - IANA 时区。
 * @param localDateTime - 本地时刻，写法 `YYYY-MM-DDTHH:mm`。
 * @returns 解析结论。
 */
export function resolveLocalDateTime(zone: string, localDateTime: string): WallTimeResolution {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localDateTime);
  if (matched === null) throw new Error(`本地时刻写法不合法：${localDateTime}`);
  const wall = Date.UTC(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
  );
  const dayMs = 86_400_000;
  const offsets = [wall - dayMs, wall, wall + dayMs].map((probe) => offsetAt(zone, probe));
  const valid = [...new Set(offsets)]
    .map((offset) => wall - offset)
    .filter((candidate) => candidate + offsetAt(zone, candidate) === wall)
    .sort((left, right) => left - right);
  if (valid.length === 0) return { kind: 'gap' };
  const earliest = valid[0];
  if (earliest === undefined) return { kind: 'gap' };
  if (valid.length > 1) return { kind: 'overlap', epochMs: earliest };
  return { kind: 'unique', epochMs: earliest };
}

/**
 * 把一个时刻按某个时区写成面向用户的文字。
 * @param zone - IANA 时区。
 * @param epochMs - 时刻。
 * @returns 例如「2026年11月2日 08:30」。
 */
export function formatInZone(zone: string, epochMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(epochMs));
}

/**
 * 把一个时刻写成某个时区的本地时刻，供 `datetime-local` 输入框使用。
 * @param zone - IANA 时区。
 * @param epochMs - 时刻。
 * @returns 写法 `YYYY-MM-DDTHH:mm`。
 */
export function localDateTimeOf(zone: string, epochMs: number): string {
  const parts = partsFormatter(zone).formatToParts(new Date(epochMs));
  const pick = (type: string): string => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) throw new Error(`时区 ${zone} 的分量 ${type} 缺失`);
    return found.value;
  };
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`;
}

/**
 * 把一个时刻写成某个时区的本地时刻，供 `time` 输入框使用。
 * @param zone - IANA 时区。
 * @param epochMs - 时刻。
 * @returns 写法 `HH:mm`。
 */
export function localClockOf(zone: string, epochMs: number): string {
  return localDateTimeOf(zone, epochMs).slice(11);
}

/** 把秒数写成间隔说明。 */
export function describeInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${String(seconds / 3600)} 小时`;
  if (seconds % 60 === 0) return `${String(seconds / 60)} 分钟`;
  return `${String(seconds)} 秒`;
}

/** 解析 `HH:mm` 形式的时刻。 */
function parseClock(clock: string): { hour: number; minute: number } {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  if (matched === null) throw new Error(`时刻写法不合法：${clock}`);
  return { hour: Number(matched[1]), minute: Number(matched[2]) };
}

/** 一个墙上日期的后面第几天。 */
function wallDatePlus(zone: string, epochMs: number, days: number): WallParts {
  const today = wallPartsOf(zone, epochMs);
  const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day) + days * 86_400_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** 墙上日期的 ISO 星期编号，周一为 1。 */
function isoWeekday(date: WallParts): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 把墙上日期与时刻拼成本地时刻写法。 */
function wallText(date: WallParts, hour: number, minute: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.year)}-${pad(date.month)}-${pad(date.day)}T${pad(hour)}:${pad(minute)}`;
}

/**
 * 按本地墙面时间重复的任务算出下一次发生时刻。
 *
 * 每日与每周走同一段搜索：逐天检查候选本地时刻，跳过的本地时刻直接略过，重复的本地时刻
 * 取较早的一次；候选时刻必须晚于当前时刻。
 * @param zone - IANA 时区。
 * @param clock - 发生时刻，写法 `HH:mm`。
 * @param weekdays - 每周任务的星期编号；每日任务传空数组。
 * @param now - 当前时刻。
 * @returns 下一次发生时刻；14 天内没有可用时刻时返回空。
 */
function nextWallOccurrence(zone: string, clock: string, weekdays: readonly number[], now: number): number | undefined {
  const { hour, minute } = parseClock(clock);
  for (let days = 0; days <= 14; days += 1) {
    const date = wallDatePlus(zone, now, days);
    if (weekdays.length > 0 && !weekdays.includes(isoWeekday(date))) continue;
    const resolution = resolveLocalDateTime(zone, wallText(date, hour, minute));
    if (resolution.kind === 'gap') continue;
    if (resolution.epochMs <= now) continue;
    return resolution.epochMs;
  }
  return undefined;
}

/**
 * 算出一种触发方式的下一次发生时刻。
 *
 * cron 方式的下次发生时间由原会话运行时用成熟解析库算出，界面不在这里重复实现，返回空值
 * 表示由运行时回填。
 * @param spec - 触发方式。
 * @param now - 当前时刻。
 * @returns 下一次发生时刻；无法在界面内算出时为空。
 */
export function nextOccurrence(spec: ScheduleSpec, now: number): number | undefined {
  switch (spec.kind) {
    case 'once':
      return spec.at;
    case 'interval':
      return now + spec.everySeconds * 1000;
    case 'daily':
      return nextWallOccurrence(spec.timeZone, spec.time, [], now);
    case 'weekly':
      return nextWallOccurrence(spec.timeZone, spec.time, spec.weekdays, now);
    case 'cron':
      return undefined;
  }
}

/** cron 表达式的分段数量。 */
const CRON_FIELDS = 5;

/** cron 每一段允许的字符。 */
const CRON_FIELD_PATTERN = /^[\d*?LW#\/,-]+$/i;

/**
 * 检查 cron 表达式的形状。
 *
 * 本函数只检查分段数量与字符集合，取值范围与语义（例如步长写成零这类非法写法）由原会话
 * 运行时的成熟解析库判定，界面把运行时的结论原样展示。
 * @param expression - 表达式。
 * @returns 不合法的说明；合法时为空。
 */
export function cronShapeError(expression: string): string | undefined {
  const trimmed = expression.trim();
  if (trimmed === '') return '请填写 cron 表达式';
  const fields = trimmed.split(/\s+/);
  if (fields.length !== CRON_FIELDS) return `cron 表达式需要 ${String(CRON_FIELDS)} 段，当前有 ${String(fields.length)} 段`;
  const invalid = fields.find((field) => !CRON_FIELD_PATTERN.test(field));
  if (invalid !== undefined) return `cron 表达式里的这一段含有不支持的字符：${invalid}`;
  return undefined;
}

/** 表单里的时间方式控件标识。 */
export function modeFieldId(mode: ScheduleMode): string {
  return `chdsh-automation-mode-${mode}`;
}

/** 重复方式控件标识。 */
export function repeatFieldId(repeat: RepeatKind): string {
  return `chdsh-automation-repeat-${repeat}`;
}

/** 星期复选框标识。 */
export function weekdayFieldId(weekday: number): string {
  return `chdsh-automation-weekday-${String(weekday)}`;
}

/**
 * 校验条件表单。
 *
 * 只校验当前选中的时间方式，未选中的分支不参与校验；这样切换时间方式之后不会留下别的
 * 分支的旧错误。第一条错误与错误摘要的第一项一致，界面把焦点交给摘要。
 * @param draft - 表单取值。
 * @param now - 当前时刻。
 * @returns 字段错误列表，按出现顺序排列。
 */
export function draftErrors(draft: ScheduleDraft, now: number): DraftError[] {
  const errors: DraftError[] = [];
  if (!isKnownTimeZone(draft.timeZone)) {
    errors.push({ fieldId: 'chdsh-automation-timezone', message: '请选择一个 IANA 时区' });
  }
  switch (draft.mode) {
    case 'immediate':
      break;
    case 'delay': {
      const minutes = Number(draft.delayMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || draft.delayMinutes.trim() === '') {
        errors.push({ fieldId: 'chdsh-automation-delay-minutes', message: '相对延时需要填写不少于 1 的整数分钟' });
      }
      break;
    }
    case 'once': {
      const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.test(draft.localDateTime);
      if (!matched) {
        errors.push({ fieldId: 'chdsh-automation-once-at', message: '定时方式需要选择日期与时刻' });
        break;
      }
      if (!isKnownTimeZone(draft.timeZone)) break;
      const resolution = resolveLocalDateTime(draft.timeZone, draft.localDateTime);
      if (resolution.kind === 'gap') {
        errors.push({ fieldId: 'chdsh-automation-once-at', message: '这个本地时刻在所选时区不存在（夏令时跳过的时段），请换一个时刻' });
        break;
      }
      if (resolution.epochMs <= now) {
        errors.push({ fieldId: 'chdsh-automation-once-at', message: '定时方式需要选择晚于当前时刻的时间' });
      }
      break;
    }
    case 'repeat': {
      switch (draft.repeat) {
        case 'interval': {
          const seconds = Number(draft.intervalSeconds);
          if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || draft.intervalSeconds.trim() === '') {
            errors.push({ fieldId: 'chdsh-automation-interval-seconds', message: `固定间隔不少于 ${String(MIN_INTERVAL_SECONDS)} 秒` });
          }
          break;
        }
        case 'daily': {
          if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(draft.clock)) {
            errors.push({ fieldId: 'chdsh-automation-clock', message: '每日任务需要填写 24 小时制的发生时刻' });
          }
          break;
        }
        case 'weekly': {
          if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(draft.clock)) {
            errors.push({ fieldId: 'chdsh-automation-clock', message: '每周任务需要填写 24 小时制的发生时刻' });
          }
          if (draft.weekdays.length === 0) {
            errors.push({ fieldId: weekdayFieldId(1), message: '每周任务至少选择一天' });
          }
          break;
        }
        case 'cron': {
          const shape = cronShapeError(draft.expression);
          if (shape !== undefined) errors.push({ fieldId: 'chdsh-automation-cron', message: shape });
          break;
        }
      }
      break;
    }
  }
  return errors;
}

/**
 * 把表单取值转换成一种触发方式。
 *
 * 调用前必须先通过 `draftErrors` 的校验：这里对不合法的取值直接抛出，避免把半成品的取值
 * 提交给运行时。
 * @param draft - 表单取值。
 * @param now - 当前时刻。
 * @returns 触发方式。
 */
export function draftToSpec(draft: ScheduleDraft, now: number): ScheduleSpec {
  const errors = draftErrors(draft, now);
  if (errors.length > 0) throw new Error(`条件表单尚未通过校验：${errors.map((error) => error.message).join('；')}`);
  const timeZone = draft.timeZone;
  switch (draft.mode) {
    case 'immediate':
      return { kind: 'once', at: now, timeZone };
    case 'delay':
      return { kind: 'once', at: now + Number(draft.delayMinutes) * 60_000, timeZone };
    case 'once': {
      const resolution = resolveLocalDateTime(timeZone, draft.localDateTime);
      if (resolution.kind === 'gap') throw new Error('定时方式的本地时刻在当前时区不存在');
      return { kind: 'once', at: resolution.epochMs, timeZone };
    }
    case 'repeat':
      switch (draft.repeat) {
        case 'interval':
          return { kind: 'interval', everySeconds: Number(draft.intervalSeconds), timeZone };
        case 'daily':
          return { kind: 'daily', time: draft.clock, timeZone };
        case 'weekly':
          return { kind: 'weekly', weekdays: [...draft.weekdays].sort((left, right) => left - right), time: draft.clock, timeZone };
        case 'cron':
          return { kind: 'cron', expression: draft.expression.trim(), timeZone };
      }
  }
}

/**
 * 把一种触发方式写成一行的摘要。
 * @param spec - 触发方式。
 * @returns 面向用户的摘要。
 */
export function describeSpec(spec: ScheduleSpec, now?: number): string {
  switch (spec.kind) {
    case 'once': {
      const prefix = now !== undefined && spec.at <= now ? '单次（立即）' : '单次';
      return `${prefix}：${formatInZone(spec.timeZone, spec.at)}`;
    }
    case 'interval':
      return `固定间隔：每 ${describeInterval(spec.everySeconds)}一次`;
    case 'daily':
      return `每日：${spec.time}`;
    case 'weekly':
      return `每周：${spec.weekdays.map((weekday) => WEEKDAY_NAMES[weekday] ?? String(weekday)).join('、')} ${spec.time}`;
    case 'cron':
      return `cron：${spec.expression}`;
  }
}

/**
 * 给出当前表单取值的夏令时提示。
 *
 * 只有定时与每日、每周这三种按本地时刻发生的方式需要提示：跳过的时刻会被略过，重复的时刻
 * 只发生一次。其余方式不受本地时刻解析影响。
 * @param draft - 表单取值。
 * @param now - 当前时刻。
 * @returns 提示文字；没有夏令时边界时为空。
 */
export function daylightNotice(draft: ScheduleDraft, now: number): string | undefined {
  if (!isKnownTimeZone(draft.timeZone)) return undefined;
  if (draft.mode === 'once') {
    if (!/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.test(draft.localDateTime)) return undefined;
    const resolution = resolveLocalDateTime(draft.timeZone, draft.localDateTime);
    if (resolution.kind === 'gap') return `${draft.timeZone} 在该时刻处于夏令时切换跳过的时段，这个本地时刻不存在。`;
    if (resolution.kind === 'overlap') {
      return `${draft.timeZone} 在该时刻出现两次（夏令时回拨），任务只在较早的一次发生，对应 ${formatInZone(draft.timeZone, resolution.epochMs)}。`;
    }
    return undefined;
  }
  if (draft.mode === 'repeat' && (draft.repeat === 'daily' || draft.repeat === 'weekly')) {
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(draft.clock)) return undefined;
    const { hour, minute } = parseClock(draft.clock);
    for (let days = 0; days <= 366; days += 1) {
      const date = wallDatePlus(draft.timeZone, now, days);
      const resolution = resolveLocalDateTime(draft.timeZone, wallText(date, hour, minute));
      if (resolution.kind === 'gap') {
        return `${draft.timeZone} 在 ${String(date.year)}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')} 的这个时刻因夏令时不存在，当天的任务会被跳过。`;
      }
      if (resolution.kind === 'overlap') {
        return `${draft.timeZone} 在 ${String(date.year)}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')} 的这个时刻出现两次，当天的任务只在较早的一次发生。`;
      }
    }
  }
  return undefined;
}

/**
 * 生成默认表单取值。
 * @param timeZone - 默认时区；缺省取浏览器时区。
 * @param now - 当前时刻。
 * @returns 表单取值：时间方式为立即，重复方式为固定间隔。
 */
export function createDefaultDraft(timeZone?: string, now: number = Date.now()): ScheduleDraft {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Date(now + 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return {
    mode: 'immediate',
    delayMinutes: '10',
    localDateTime: `${String(local.getFullYear())}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`,
    repeat: 'interval',
    intervalSeconds: '3600',
    clock: '09:00',
    weekdays: [1],
    expression: '0 9 * * *',
    timeZone: zone,
  };
}
