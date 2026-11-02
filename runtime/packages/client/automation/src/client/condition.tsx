/**
 * 触发时间的条件表单：立即、相对延时、定时与重复互斥。
 *
 * 四个时间方式共用一个单选组，选中哪一种就只渲染哪一种的字段，提交时也只生成一种触发方式。
 * 校验错误定位到具体控件；夏令时提示跟随当前取值实时出现。
 * @module @chatdsh/client-automation/condition
 */

import { Field, StatusLine } from '@chatdsh/core-ui-kit';
import type { ChangeEvent } from 'react';
import {
  MIN_INTERVAL_SECONDS,
  REPEAT_KINDS,
  SCHEDULE_MODES,
  WEEKDAY_NAMES,
  modeFieldId,
  repeatFieldId,
  timeZoneChoices,
  weekdayFieldId,
  type DraftError,
  type RepeatKind,
  type ScheduleDraft,
  type ScheduleMode,
} from './schedule.ts';

/** 时间方式的名称。 */
const MODE_LABELS: Readonly<Record<ScheduleMode, string>> = {
  immediate: '立即',
  delay: '相对延时',
  once: '定时',
  repeat: '重复',
};

/** 时间方式的说明。 */
const MODE_HELP: Readonly<Record<ScheduleMode, string>> = {
  immediate: '保存后按原会话运行时的顺序尽快发生一次。',
  delay: '从保存时刻起，过一段相对延时之后发生一次。',
  once: '在指定的日期与时刻发生一次。',
  repeat: '按固定间隔、每日、每周或 cron 反复发生。',
};

/** 重复方式的名称。 */
const REPEAT_LABELS: Readonly<Record<RepeatKind, string>> = {
  interval: '固定间隔',
  daily: '每日',
  weekly: '每周',
  cron: 'cron 表达式',
};

/** 条件表单属性。 */
export interface ConditionFormProps {
  /** 表单取值。 */
  readonly draft: ScheduleDraft;
  /** 字段错误。 */
  readonly errors: readonly DraftError[];
  /** 夏令时提示。 */
  readonly daylight?: string;
  /** 取值变化回调。 */
  readonly onChange: (next: ScheduleDraft) => void;
}

/**
 * 取某个字段的错误说明。
 * @param errors - 字段错误。
 * @param fieldId - 字段标识。
 * @returns 说明；没有错误时为空。
 */
function errorOf(errors: readonly DraftError[], fieldId: string): string | undefined {
  return errors.find((error) => error.fieldId === fieldId)?.message;
}

/**
 * 条件表单。
 * @param props - 取值、错误、提示与变化回调。
 * @returns 表单片段。
 */
export function ConditionForm({ draft, errors, daylight, onChange }: ConditionFormProps) {
  const update = (patch: Partial<ScheduleDraft>): void => onChange({ ...draft, ...patch });
  const selectMode = (event: ChangeEvent<HTMLInputElement>): void => {
    const mode = event.currentTarget.value as ScheduleMode;
    update({ mode });
  };
  const selectRepeat = (event: ChangeEvent<HTMLSelectElement>): void => {
    const repeat = event.currentTarget.value as RepeatKind;
    update({ repeat });
  };
  const toggleWeekday = (weekday: number, checked: boolean): void => {
    const next = checked
      ? [...new Set([...draft.weekdays, weekday])]
      : draft.weekdays.filter((value) => value !== weekday);
    update({ weekdays: next.sort((left, right) => left - right) });
  };

  return (
    <fieldset className="chdsh-field" data-condition-form>
      <legend>触发时间（四种方式互斥）</legend>
      <p className="chdsh-field__help">选择一种时间方式；保存时只提交选中的一种。</p>
      <div role="radiogroup" aria-label="触发时间方式">
        {SCHEDULE_MODES.map((mode) => (
          <label key={mode} htmlFor={modeFieldId(mode)}>
            <input
              type="radio"
              id={modeFieldId(mode)}
              name="chdsh-automation-mode"
              value={mode}
              checked={draft.mode === mode}
              aria-describedby="chdsh-automation-mode-help"
              onChange={selectMode}
            />
            {MODE_LABELS[mode]}
          </label>
        ))}
      </div>
      <p id="chdsh-automation-mode-help" className="chdsh-field__help">{MODE_HELP[draft.mode]}</p>

      {draft.mode === 'delay' ? (
        <Field
          label="延时的分钟数"
          help="不少于 1 分钟；相对保存时刻计算。"
          error={errorOf(errors, 'chdsh-automation-delay-minutes')}
          required
        >
          <input
            type="number"
            id="chdsh-automation-delay-minutes"
            inputMode="numeric"
            min={1}
            value={draft.delayMinutes}
            onChange={(event) => update({ delayMinutes: event.currentTarget.value })}
          />
        </Field>
      ) : null}

      {draft.mode === 'once' ? (
        <Field
          label="发生的日期与时刻"
          help={`按所选时区 ${draft.timeZone} 的本地时刻解释。`}
          error={errorOf(errors, 'chdsh-automation-once-at')}
          required
        >
          <input
            type="datetime-local"
            id="chdsh-automation-once-at"
            value={draft.localDateTime}
            onChange={(event) => update({ localDateTime: event.currentTarget.value })}
          />
        </Field>
      ) : null}

      {draft.mode === 'repeat' ? (
        <>
          <Field label="重复方式" help="固定间隔最少 60 秒；cron 表达式的取值由原会话运行时校验。">
            <select id="chdsh-automation-repeat" value={draft.repeat} onChange={selectRepeat}>
              {REPEAT_KINDS.map((repeat) => (
                <option key={repeat} id={repeatFieldId(repeat)} value={repeat}>{REPEAT_LABELS[repeat]}</option>
              ))}
            </select>
          </Field>

          {draft.repeat === 'interval' ? (
            <Field
              label="间隔秒数"
              help={`不少于 ${String(MIN_INTERVAL_SECONDS)} 秒。`}
              error={errorOf(errors, 'chdsh-automation-interval-seconds')}
              required
            >
              <input
                type="number"
                id="chdsh-automation-interval-seconds"
                inputMode="numeric"
                min={MIN_INTERVAL_SECONDS}
                value={draft.intervalSeconds}
                onChange={(event) => update({ intervalSeconds: event.currentTarget.value })}
              />
            </Field>
          ) : null}

          {draft.repeat === 'daily' || draft.repeat === 'weekly' ? (
            <Field
              label={draft.repeat === 'daily' ? '每日的发生时刻' : '每周的发生时刻'}
              help="24 小时制，写法如 09:30。"
              error={errorOf(errors, 'chdsh-automation-clock')}
              required
            >
              <input
                type="time"
                id="chdsh-automation-clock"
                value={draft.clock}
                onChange={(event) => update({ clock: event.currentTarget.value })}
              />
            </Field>
          ) : null}

          {draft.repeat === 'weekly' ? (
            <fieldset className="chdsh-field">
              <legend>星期（至少选择一天）</legend>
              <div>
                {[1, 2, 3, 4, 5, 6, 7].map((weekday) => (
                  <label key={weekday} htmlFor={weekdayFieldId(weekday)}>
                    <input
                      type="checkbox"
                      id={weekdayFieldId(weekday)}
                      checked={draft.weekdays.includes(weekday)}
                      aria-describedby="chdsh-automation-weekday-help"
                      onChange={(event) => toggleWeekday(weekday, event.currentTarget.checked)}
                    />
                    {WEEKDAY_NAMES[weekday]}
                  </label>
                ))}
              </div>
              <p id="chdsh-automation-weekday-help" className="chdsh-field__help">
                星期编号按 ISO 约定：周一为 1，周日为 7。
                {errorOf(errors, weekdayFieldId(1)) === undefined ? null : ` ${errorOf(errors, weekdayFieldId(1)) ?? ''}`}
              </p>
            </fieldset>
          ) : null}

          {draft.repeat === 'cron' ? (
            <Field
              label="cron 表达式"
              help="五段式：分、时、日、月、周。界面只检查分段与字符，取值范围与语义由原会话运行时的成熟解析库校验。"
              error={errorOf(errors, 'chdsh-automation-cron')}
              required
            >
              <input
                type="text"
                id="chdsh-automation-cron"
                spellCheck={false}
                autoComplete="off"
                value={draft.expression}
                onChange={(event) => update({ expression: event.currentTarget.value })}
              />
            </Field>
          ) : null}
        </>
      ) : null}

      <Field
        label="时区"
        help="任务按这里的 IANA 时区解释本地时刻。"
        error={errorOf(errors, 'chdsh-automation-timezone')}
        required
      >
        <select id="chdsh-automation-timezone" value={draft.timeZone} onChange={(event) => update({ timeZone: event.currentTarget.value })}>
          {timeZoneChoices().map((zone) => <option key={zone} value={zone}>{zone}</option>)}
        </select>
      </Field>

      {daylight === undefined ? null : <StatusLine tone="danger">{daylight}</StatusLine>}
    </fieldset>
  );
}
