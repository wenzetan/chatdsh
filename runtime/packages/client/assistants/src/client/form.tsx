/**
 * 助手新建与编辑向导：字段校验、错误摘要、版本冲突与装配失败反馈。
 *
 * 字段来自规格：名称（1–80 字符且唯一）、说明（最多 512 字符）、指令（最多 32,000 字符）、
 * 排序整数、档位与附加工具多选，技能引用来自技能服务的真实目录。提交时先做本地校验；本地
 * 通过之后由宿主复核并真实装配，装配失败的记录不会被写入，表单保留全部输入。
 *
 * 版本冲突：保存携带读到的 `revision`，宿主判定过期时界面保留编辑稿，读取服务器当前值之后
 * 按最新版本重新提交。
 * @module @chatdsh/client-assistants/form
 */

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button, Dialog, ErrorNote, ErrorSummary, Field, StatusLine } from '@chatdsh/core-ui-kit';

import {
  ASSISTANT_DESCRIPTION_LIMIT,
  ASSISTANT_INSTRUCTIONS_LIMIT,
  ASSISTANT_NAME_LIMIT,
  ASSISTANT_ORDER_RANGE,
  ASSISTANT_TIERS,
} from '../index.ts';
import { CheckboxGroup, type CheckOption } from './multiselect.tsx';
import {
  ASSISTANT_ERROR_CODES,
  codeOf,
  describeEnablement,
  describeFailure,
  draftOfRecord,
  EMPTY_DRAFT,
  FIELD_IDS,
  errorFor,
  fieldOfHostMessage,
  formatTime,
  inherentRowsOf,
  inputOf,
  patchOf,
  SKILL_SOURCE_LABEL,
  tierDescriptionOf,
  tierLabelOf,
  validateDraft,
  type AssistantDraft,
  type FieldError,
  type ToolRowView,
} from './state.ts';
import type { AssistantRecord, AssistantsGateway, SkillEntry } from './types.ts';

/** 表单的依赖。 */
export interface AssistantFormProps {
  /** 数据入口。 */
  readonly gateway: AssistantsGateway;
  /** 新建还是修改。 */
  readonly mode: 'create' | 'edit';
  /** 修改时的原记录。 */
  readonly record?: AssistantRecord;
  /** 除本次提交这一条之外的现有记录，用于名称唯一性判定。 */
  readonly others: readonly AssistantRecord[];
  /** 技能目录；读取失败时为 undefined。 */
  readonly skills: readonly SkillEntry[] | undefined;
  /** 技能目录的读取失败原因。 */
  readonly skillsFailure?: unknown;
  /** 工具目录，来自三档预设的装配结果。 */
  readonly catalog: readonly ToolRowView[];
  /** 工具目录的读取失败原因。 */
  readonly catalogFailure?: unknown;
  /** 关闭对话框。 */
  readonly onClose: () => void;
  /** 保存成功后回调，参数是写入后的记录。 */
  readonly onSaved: (record: AssistantRecord) => void;
}

/** 版本冲突的提示状态。 */
interface ConflictState {
  readonly message: string;
  /** 是否已经按服务器当前值重新读取过。 */
  readonly reloaded: boolean;
}

/** 助手新建与编辑向导。 */
export function AssistantForm({ gateway, mode, record, others, skills, skillsFailure, catalog, catalogFailure, onClose, onSaved }: AssistantFormProps) {
  const summaryId = useId();
  const [draft, setDraft] = useState<AssistantDraft>(record === undefined ? EMPTY_DRAFT : draftOfRecord(record));
  const [baseline, setBaseline] = useState<AssistantRecord | undefined>(record);
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [conflict, setConflict] = useState<ConflictState | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const action = mode === 'create' ? 'assistant.create' : 'assistant.update';

  useEffect(() => {
    if (errors.length === 0) return;
    document.getElementById(summaryId)?.focus();
  }, [errors, summaryId]);

  const inherent = inherentRowsOf(catalog, draft.tier);
  const chosenExtraTools = draft.tools.filter((rowId) => !inherent.includes(rowId));

  /** 切换档位：把已经成为档位自带的附加项去掉，其余选择保留。 */
  const switchTier = (tier: AssistantDraft['tier']): void => {
    const next = inherentRowsOf(catalog, tier);
    setDraft((previous) => ({ ...previous, tier, tools: previous.tools.filter((rowId) => !next.includes(rowId)) }));
    setErrors([]);
  };

  const toolOptions: CheckOption[] = catalog.map((row) => {
    const tiers = row.tiers.map((tier) => tierLabelOf(tier)).join('、');
    const hint = [`档位：${tiers}`, describeEnablement(row.enabled)].join(' · ');
    if (row.tiers.includes(draft.tier)) {
      return {
        id: row.rowId,
        label: `${row.rowId}（${row.moduleName}）`,
        hint: row.condition === undefined ? hint : `${hint} · 条件 ${row.condition}`,
        fixedReason: `当前档位自带这一行，不能取消`,
      };
    }
    return {
      id: row.rowId,
      label: `${row.rowId}（${row.moduleName}）`,
      hint: row.condition === undefined ? hint : `${hint} · 条件 ${row.condition}`,
      ...(row.enabled === false
        ? { blockedReason: '当前平台不装配这一行，不能作为附加工具' }
        : {}),
    };
  });

  const skillOptions: CheckOption[] = (skills ?? []).map((skill) => {
    const selected = draft.skills.includes(skill.id);
    const base = `${SKILL_SOURCE_LABEL[skill.source]} · ${skill.description}`;
    if (skill.enabled) return { id: skill.id, label: skill.name, hint: base };
    if (selected) {
      return { id: skill.id, label: skill.name, hint: `${base} · 已停用；去掉这条引用之后不能再选回来` };
    }
    return { id: skill.id, label: skill.name, hint: base, blockedReason: '已停用，不能新增引用' };
  });

  const toggleTool = (id: string, checked: boolean): void => {
    setDraft((previous) => ({
      ...previous,
      tools: checked ? [...previous.tools, id] : previous.tools.filter((rowId) => rowId !== id),
    }));
  };

  const toggleSkill = (id: string, checked: boolean): void => {
    setDraft((previous) => ({
      ...previous,
      skills: checked ? [...previous.skills, id] : previous.skills.filter((skillId) => skillId !== id),
    }));
  };

  /** 提交：本地校验、真实装配、失败分类。 */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting) return;
    const found = validateDraft(draft, others, skills);
    setErrors(found);
    if (found.length > 0) {
      gateway.noteAction(action, 'rejected');
      return;
    }
    const input = inputOf({ ...draft, tools: chosenExtraTools });
    setFailure(undefined);
    setConflict(undefined);
    setSubmitting(true);
    const written = mode === 'create' || baseline === undefined
      ? gateway.create(input)
      : gateway.update(baseline.id, patchOf({ ...draft, tools: chosenExtraTools }, baseline));
    written.then(
      (saved) => {
        gateway.noteAction(action, 'ok');
        setSubmitting(false);
        onSaved(saved);
      },
      (error: unknown) => {
        gateway.noteAction(action, 'failed');
        setSubmitting(false);
        const message = describeFailure(error);
        if (codeOf(error) === ASSISTANT_ERROR_CODES.conflict && mode === 'edit') {
          setConflict({ message, reloaded: false });
          return;
        }
        const field = fieldOfHostMessage(message);
        if (field === undefined) {
          setFailure(error);
          return;
        }
        setErrors([{ fieldId: field, message }]);
      },
    );
  };

  /** 冲突之后重新读取服务器值，保留编辑稿。 */
  const reloadFromServer = (): void => {
    if (reloading) return;
    setReloading(true);
    gateway.load().then(
      (snapshot) => {
        setReloading(false);
        const found = baseline === undefined ? undefined : snapshot.assistants.find((entry) => entry.id === baseline.id);
        if (found === undefined) {
          gateway.noteAction('assistant.reload', 'failed');
          setFailure(new Error('服务器上已经没有这个助手：可能被另一处删除，请关闭对话框后刷新列表'));
          return;
        }
        gateway.noteAction('assistant.reload', 'ok');
        setBaseline(found);
        setConflict({
          message: `已按服务器当前值重新读取：版本 ${String(found.revision)}，名称「${found.name}」，修改于 ${formatTime(found.updatedAt)}。编辑稿仍然保留，再次保存按这个版本提交。`,
          reloaded: true,
        });
      },
      (error: unknown) => {
        setReloading(false);
        gateway.noteAction('assistant.reload', 'failed');
        setFailure(error);
      },
    );
  };

  return (
    <Dialog
      open
      title={mode === 'create' ? '新建助手' : '助手设置'}
      description="助手是一个 preset 定义：保存时宿主重新装配，装配失败的记录不会被写入，原定义保持不变。"
      onClose={onClose}
    >
      <form aria-label={mode === 'create' ? '新建助手' : '助手设置'} onSubmit={submit} noValidate>
        <ErrorSummary id={summaryId} errors={errors} />
        {failure === undefined ? null : <ErrorNote>{`保存没有被受理：${describeFailure(failure)}。原定义与你的输入都保留。`}</ErrorNote>}
        {conflict === undefined ? null : (
          <div className="chdsh-error" role="alert">
            <p>{`助手版本已过期，本次保存未写入：${conflict.message}`}</p>
            <p>
              <Button id="wp11-assistant-conflict-reload" onClick={reloadFromServer} disabled={reloading}>
                {reloading ? '正在重新读取' : '重新读取服务器值'}
              </Button>
            </p>
          </div>
        )}
        <Field
          label="名称"
          required
          help={`1 到 ${String(ASSISTANT_NAME_LIMIT)} 个字符，与其它助手名称重复时保存会被拒绝。当前 ${String(draft.name.trim().length)} 个字符。`}
          error={errorFor(errors, FIELD_IDS.name)}
        >
          <input
            id={FIELD_IDS.name}
            value={draft.name}
            onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))}
          />
        </Field>
        <Field
          label="说明"
          help={`一句话说明这个助手做什么，最多 ${String(ASSISTANT_DESCRIPTION_LIMIT)} 个字符。当前 ${String(draft.description.length)} 个字符。`}
          error={errorFor(errors, FIELD_IDS.description)}
        >
          <textarea
            id={FIELD_IDS.description}
            rows={2}
            value={draft.description}
            onChange={(event) => setDraft((previous) => ({ ...previous, description: event.target.value }))}
          />
        </Field>
        <Field
          label="指令"
          help={`作为人格前缀注入，最多 ${String(ASSISTANT_INSTRUCTIONS_LIMIT)} 个字符。当前 ${String(draft.instructions.length)} 个字符。`}
          error={errorFor(errors, FIELD_IDS.instructions)}
        >
          <textarea
            id={FIELD_IDS.instructions}
            rows={6}
            value={draft.instructions}
            onChange={(event) => setDraft((previous) => ({ ...previous, instructions: event.target.value }))}
          />
        </Field>
        <Field
          label="档位"
          help={`${tierDescriptionOf(draft.tier)} 切换档位不影响已开始的会话。`}
          error={errorFor(errors, FIELD_IDS.tier)}
        >
          <select id={FIELD_IDS.tier} value={draft.tier} onChange={(event) => switchTier(event.target.value as AssistantDraft['tier'])}>
            {ASSISTANT_TIERS.map((tier) => (
              <option key={tier} value={tier}>{`${tierLabelOf(tier)}：${tierDescriptionOf(tier)}`}</option>
            ))}
          </select>
        </Field>
        <Field
          label="排序值"
          help={`整数，范围 ${String(ASSISTANT_ORDER_RANGE.min)} 到 ${String(ASSISTANT_ORDER_RANGE.max)}；数值小的排在前面。`}
          error={errorFor(errors, FIELD_IDS.order)}
        >
          <input
            id={FIELD_IDS.order}
            inputMode="numeric"
            value={draft.orderText}
            onChange={(event) => setDraft((previous) => ({ ...previous, orderText: event.target.value }))}
          />
        </Field>
        {catalogFailure === undefined ? null : (
          <StatusLine tone="danger">{`工具装配清单读取失败：${describeFailure(catalogFailure)}。附加工具暂时不能选择。`}</StatusLine>
        )}
        <CheckboxGroup
          label="附加工具"
          idPrefix="wp11-assistant-tools"
          groupDomId={FIELD_IDS.tools}
          selected={chosenExtraTools}
          options={toolOptions}
          onToggle={toggleTool}
          error={errorFor(errors, FIELD_IDS.tools)}
          help={`清单来自当前部署三档预设的真实装配结果，当前已选 ${String(chosenExtraTools.length)} 行附加工具。档位自带的行不能取消。`}
        />
        {skillsFailure === undefined ? null : (
          <StatusLine tone="danger">{`技能目录读取失败：${describeFailure(skillsFailure)}。技能引用暂时不能修改。`}</StatusLine>
        )}
        <CheckboxGroup
          label="引用的技能"
          idPrefix="wp11-assistant-skills"
          groupDomId={FIELD_IDS.skills}
          selected={draft.skills}
          options={skillOptions}
          onToggle={toggleSkill}
          error={errorFor(errors, FIELD_IDS.skills)}
          help={skills === undefined
            ? '技能目录不可用时保留原有引用，重新加载之后再改。'
            : `引用 ${String(draft.skills.length)} 个技能。已停用的技能不能新增引用。`}
        />
        <Button id="wp11-assistant-submit" type="submit" tone="primary" disabled={submitting}>
          {submitting ? '正在保存' : '保存'}
        </Button>
        <Button id="wp11-assistant-cancel" onClick={onClose}>取消</Button>
      </form>
    </Dialog>
  );
}
