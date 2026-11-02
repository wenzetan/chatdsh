/**
 * 启动失败记录、崩溃证据与安全模式。
 *
 * 失败记录只保留阶段、错误码、退出码、存活时间与有界脱敏日志，供启动恢复界面展示与
 * 导出。安全模式把停用扩展与原因写进状态文件，并通过环境变量传给控制平面。
 * @module chatdsh-desktop-shell/startup-recovery
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** 日志尾巴保留的行数与单行长度。 */
export const MAX_LOG_LINES = 80;
export const MAX_LOG_LINE_LENGTH = 500;

/** 崩溃记录保留条数。 */
export const MAX_CRASH_RECORDS = 20;

/** 脱敏规则：凭据、令牌、邮箱、地址与用户目录。 */
const REDACTIONS = Object.freeze([
  { pattern: /((?:^|[\s?&;])(?:token|key|secret|password|bootstrap|code)=)[^&\s]+/giu, replacement: '$1<已隐藏>' },
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gu, replacement: '$1 <已隐藏>' },
  { pattern: /\b(x-chatdsh-bootstrap|x-chatdsh-csrf|authorization|cookie)\s*[:=]\s*\S+/giu, replacement: '$1: <已隐藏>' },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/gu, replacement: '<密钥已隐藏>' },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, replacement: '<邮箱已隐藏>' },
  { pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/gu, replacement: '<地址已隐藏>' },
  { pattern: /(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/)[^\\/\s]+/gu, replacement: '<用户目录>' },
  { pattern: /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, replacement: '' },
]);

/** 文件名。 */
const FILES = Object.freeze({
  failure: 'startup-failure.json',
  crashes: 'crashes.json',
  safeMode: 'safe-mode.json',
  diagnostics: 'diagnostics.json',
});

/**
 * 脱敏一行日志。
 * @param line - 原始行。
 * @returns 脱敏并截断后的行。
 */
export function redactLine(line) {
  let text = String(line);
  const home = homedir();
  if (home !== '') text = text.split(home).join('<用户目录>');
  for (const rule of REDACTIONS) text = text.replace(rule.pattern, rule.replacement);
  if (text.length > MAX_LOG_LINE_LENGTH) text = `${text.slice(0, MAX_LOG_LINE_LENGTH)}…`;
  return text;
}

/**
 * 脱敏并截取日志尾巴。
 * @param lines - 原始行列表。
 * @param limit - 保留行数。
 * @returns 脱敏后的行列表。
 */
export function redactLines(lines, limit = MAX_LOG_LINES) {
  const source = Array.isArray(lines) ? lines : [];
  return source.slice(Math.max(0, source.length - limit)).map((line) => redactLine(line));
}

/**
 * 组装一条启动失败记录。
 * @param input - 阶段、错误码、退出码、存活秒数、日志与尝试次数。
 * @returns 记录对象。
 */
export function buildFailureRecord(input) {
  if (typeof input.stage !== 'string' || input.stage === '') throw new Error('失败记录缺少阶段');
  return {
    at: input.at ?? new Date().toISOString(),
    stage: input.stage,
    code: input.code ?? 'unknown',
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode : undefined,
    uptimeSeconds: Number.isFinite(input.uptimeSeconds) ? Math.max(0, Math.round(input.uptimeSeconds)) : 0,
    attempt: Number.isInteger(input.attempt) ? input.attempt : 1,
    logTail: redactLines(input.lines ?? []),
  };
}

/** 读一个 JSON 文件；文件不存在时返回 undefined。 */
function readJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text);
}

/** 原子写一个 JSON 文件。 */
function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.writing`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, file);
}

/**
 * 写入启动失败记录。
 * @param dir - 数据根。
 * @param record - 记录对象。
 * @returns 记录文件路径。
 */
export function writeFailureRecord(dir, record) {
  const file = join(dir, FILES.failure);
  writeJson(file, record);
  return file;
}

/**
 * 读取启动失败记录。
 * @param dir - 数据根。
 * @returns 记录，没有时为 undefined。
 */
export function readFailureRecord(dir) {
  return readJson(join(dir, FILES.failure));
}

/**
 * 清除启动失败记录。
 * @param dir - 数据根。
 */
export function clearFailureRecord(dir) {
  rmSync(join(dir, FILES.failure), { force: true });
}

/**
 * 追加一条崩溃证据。
 * @param dir - 数据根。
 * @param entry - 错误码、原因与存活秒数。
 * @returns 追加后的记录列表。
 */
export function recordCrash(dir, entry) {
  const file = join(dir, FILES.crashes);
  const existing = readJson(file);
  const list = Array.isArray(existing) ? existing : [];
  list.push({
    at: entry.at ?? new Date().toISOString(),
    code: entry.code,
    reason: entry.reason,
    uptimeSeconds: Math.max(0, Math.round(entry.uptimeSeconds ?? 0)),
  });
  const bounded = list.slice(Math.max(0, list.length - MAX_CRASH_RECORDS));
  writeJson(file, bounded);
  return bounded;
}

/**
 * 读取崩溃证据。
 * @param dir - 数据根。
 * @returns 记录列表。
 */
export function readCrashes(dir) {
  const existing = readJson(join(dir, FILES.crashes));
  return Array.isArray(existing) ? existing : [];
}

/**
 * 清除崩溃证据。
 * @param dir - 数据根。
 */
export function clearCrashes(dir) {
  rmSync(join(dir, FILES.crashes), { force: true });
}

/**
 * 进入安全模式：写入原因与停用扩展。
 * @param dir - 数据根。
 * @param input - 原因与停用的扩展列表。
 * @returns 安全模式记录。
 */
export function enterSafeMode(dir, input) {
  const record = {
    at: new Date().toISOString(),
    reason: input.reason ?? 'manual',
    disabledExtensions: [...(input.disabledExtensions ?? [])],
  };
  writeJson(join(dir, FILES.safeMode), record);
  return record;
}

/**
 * 读取安全模式记录。
 * @param dir - 数据根。
 * @returns 记录，没有时为 undefined。
 */
export function readSafeMode(dir) {
  return readJson(join(dir, FILES.safeMode));
}

/**
 * 退出安全模式。
 * @param dir - 数据根。
 */
export function exitSafeMode(dir) {
  rmSync(join(dir, FILES.safeMode), { force: true });
}

/**
 * 安全模式要传给控制平面的环境变量。
 * @param record - 安全模式记录。
 * @returns 环境变量对象。
 */
export function safeModeEnv(record) {
  return {
    CHATDSH_SAFE_MODE: '1',
    CHATDSH_SAFE_MODE_REASON: record.reason,
    CHATDSH_DISABLED_EXTENSIONS: record.disabledExtensions.join(','),
  };
}

/**
 * 启动恢复界面可选的入口。
 * @param record - 失败记录。
 * @returns 入口列表。
 */
export function recoveryChoices(record) {
  const choices = [
    {
      id: 'retry',
      label: '重试启动',
      detail: record === undefined ? '按当前配置重新拉起运行时' : `上次失败阶段 ${record.stage}（${record.code}）`,
    },
    {
      id: 'safe-mode',
      label: '安全模式启动',
      detail: '只加载内置插件，业务区段暂停，可以在这里停用可疑扩展',
    },
    {
      id: 'reset-config',
      label: '重置本地配置',
      detail: '清空本地设置与插件状态，会话与日志保留',
      danger: true,
    },
  ];
  return choices;
}

/**
 * 把失败记录、崩溃证据与版本信息写进一份诊断文件。
 * @param dir - 数据根。
 * @param input - 版本、失败记录与崩溃列表。
 * @returns 诊断文件路径。
 */
export function writeDiagnostics(dir, input) {
  const file = join(dir, FILES.diagnostics);
  writeJson(file, {
    at: new Date().toISOString(),
    versions: input.versions ?? {},
    failure: input.failure,
    crashes: input.crashes ?? [],
    logTail: redactLines(input.lines ?? []),
  });
  return file;
}

/**
 * 安全模式提示文案。
 * @param record - 安全模式记录。
 * @returns 说明文本。
 */
export function safeModeNotice(record) {
  const disabled = record.disabledExtensions.length === 0
    ? '没有登记的扩展需要停用'
    : `已停用 ${record.disabledExtensions.length} 个扩展：${record.disabledExtensions.join('、')}`;
  return `本次启动进入安全模式（原因：${record.reason}）。${disabled}。排障完成后可以正常重启。`;
}
