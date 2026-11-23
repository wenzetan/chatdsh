/**
 * 界面文案的格式化。
 * @module @chatdsh/client-remote/format
 */

import type { ActivityTime } from './state.ts';
import type { Notice } from './types.ts';

/**
 * 把错误码翻译成界面文字。
 * @param t - 当前语言的翻译函数。
 * @param code - 错误码。
 * @returns 已知错误码的文案；未知错误码带上原始码。
 */
export function errorText(t: ChatdshRemoteTranslate, code: string): string {
  const key = `error.${code}`;
  const text = t(key);
  return text === key ? t('error.unknown', { code }) : text;
}

/**
 * 把相对时间翻译成界面文字。
 * @param t - 当前语言的翻译函数。
 * @param value - 相对时间。
 * @returns 可显示的文字。
 */
export function activityText(t: ChatdshRemoteTranslate, value: ActivityTime): string {
  switch (value.unit) {
    case 'now':
      return t('time.now');
    case 'minute':
      return t('time.minute', { count: value.value });
    case 'hour':
      return t('time.hour', { count: value.value });
    case 'day':
      return t('time.day', { count: value.value });
    case 'date':
      return t('time.date', { date: new Date(value.at).toLocaleDateString() });
  }
}

/**
 * 把动作提示翻译成界面文字。
 * @param t - 当前语言的翻译函数。
 * @param notice - 动作提示。
 * @returns 可显示的文字。
 */
export function noticeText(t: ChatdshRemoteTranslate, notice: Notice): string {
  if (notice.kind === 'error') return errorText(t, notice.code);
  if (notice.code === 'control-url.saved') return t('notice.control-url.saved');
  if (notice.code === 'fork.created') {
    const detail = notice.detail ?? '';
    return detail === '' ? t('notice.fork.created') : `${t('notice.fork.created')} ${detail}`;
  }
  return notice.code;
}
