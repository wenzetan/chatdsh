/**
 * 结构化提问与应答状态机契约。
 *
 * 提问按 schema 显示标题、说明、单选或多选、自由输入与选择数量约束；应答携带问题标识与
 * 状态版本，服务端验证问题仍然有效。提交、取消、过期与上下文变化分别处理，失效应答保留
 * 填写内容并拒绝提交。
 * @module @chatdsh/core-contracts/questions
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import {
  countSchema,
  epochMillisSchema,
  identifierSchema,
  operationIdSchema,
  requestDigestSchema,
  revisionSchema,
} from './primitives.ts';

/** 提问卡片的状态。 */
export const QUESTION_STATES = ['pending', 'answering', 'submitted', 'cancelled', 'expired'] as const;

/** 提问卡片的状态取值。 */
export type QuestionState = (typeof QUESTION_STATES)[number];

/** 提问状态的迁移表。 */
export const QUESTION_TRANSITIONS: Readonly<Record<QuestionState, readonly QuestionState[]>> = {
  pending: ['answering', 'submitted', 'cancelled', 'expired'],
  answering: ['submitted', 'cancelled', 'expired'],
  submitted: [],
  cancelled: [],
  expired: [],
};

/**
 * 判定提问能否迁移到目标状态。
 * @param from - 当前状态。
 * @param to - 目标状态。
 * @returns 允许迁移时为真。
 */
export function canTransitionQuestion(from: QuestionState, to: QuestionState): boolean {
  return QUESTION_TRANSITIONS[from].includes(to);
}

/** 一个问题选项。 */
export const questionOptionSchema = z.object({
  /** 选项标识。 */
  id: identifierSchema,
  /** 选项文本。 */
  label: z.string().min(1).max(300),
  /** 选项说明。 */
  description: z.string().max(1000).optional(),
});

/** 一个问题选项。 */
export type QuestionOption = z.infer<typeof questionOptionSchema>;

/** 一个问题。 */
export const questionSchema = z
  .object({
    /** 问题标识，同时是应答的关联键。 */
    questionId: identifierSchema,
    /** 问题标题。 */
    title: z.string().min(1).max(300),
    /** 问题说明。 */
    description: z.string().max(2000).optional(),
    /** 是否多选。 */
    multiple: z.boolean(),
    /** 是否必答。 */
    required: z.boolean(),
    /** 最少选择数量。 */
    minSelections: countSchema.optional(),
    /** 最多选择数量。 */
    maxSelections: countSchema.optional(),
    /** 候选项。 */
    options: z.array(questionOptionSchema).min(1),
    /** 允许自由输入。 */
    allowFreeText: z.boolean(),
    /** 自由输入的最大字符数。 */
    freeTextMaxLength: countSchema.optional(),
  })
  .superRefine((question, context) => {
    const optionCount = question.options.length;
    if (!question.multiple && optionCount < 1) {
      context.addIssue({ code: 'custom', message: '单选问题至少需要一个候选项', path: ['options'] });
    }
    if (question.minSelections !== undefined && question.minSelections > optionCount) {
      context.addIssue({ code: 'custom', message: '最少选择数量超过候选项数', path: ['minSelections'] });
    }
    if (question.maxSelections !== undefined && question.maxSelections > optionCount) {
      context.addIssue({ code: 'custom', message: '最多选择数量超过候选项数', path: ['maxSelections'] });
    }
    if (
      question.minSelections !== undefined &&
      question.maxSelections !== undefined &&
      question.minSelections > question.maxSelections
    ) {
      context.addIssue({ code: 'custom', message: '最少选择数量超过最多选择数量', path: ['minSelections'] });
    }
    if (!question.multiple && (question.maxSelections ?? 1) > 1) {
      context.addIssue({ code: 'custom', message: '单选问题最多选择一个候选项', path: ['maxSelections'] });
    }
    const ids = new Set(question.options.map((option) => option.id));
    if (ids.size !== optionCount) {
      context.addIssue({ code: 'custom', message: '候选项标识重复', path: ['options'] });
    }
  });

/** 一个问题。 */
export type Question = z.infer<typeof questionSchema>;

/** 一次提问卡片。 */
export const questionCardSchema = z.object({
  /** 会话标识。 */
  sessionId: identifierSchema,
  /** 状态版本。 */
  stateVersion: revisionSchema,
  /** 当前状态。 */
  state: z.enum(QUESTION_STATES),
  /** 提问内的问题列表。 */
  questions: z.array(questionSchema).min(1),
  /** 提出时刻的毫秒时间戳。 */
  raisedAt: epochMillisSchema,
  /** 失效时刻的毫秒时间戳。 */
  expiresAt: epochMillisSchema,
});

/** 一次提问卡片。 */
export type QuestionCard = z.infer<typeof questionCardSchema>;

/** 单个问题的应答。 */
export const questionAnswerSchema = z.object({
  /** 问题标识。 */
  questionId: identifierSchema,
  /** 选中的选项标识。 */
  selected: z.array(identifierSchema),
  /** 自由输入文本。 */
  freeText: z.string().max(20000).optional(),
});

/** 单个问题的应答。 */
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

/** 提问应答请求。 */
export const questionAnswerRequestSchema = z.object({
  /** 提问卡片标识，取会话标识与提出时刻。 */
  sessionId: identifierSchema,
  /** 卡片状态版本。 */
  stateVersion: revisionSchema,
  /** 逐问题的应答。 */
  answers: z.array(questionAnswerSchema).min(1),
  /** 操作标识。 */
  operationId: operationIdSchema,
  /** 请求摘要。 */
  requestDigest: requestDigestSchema,
});

/** 提问应答请求。 */
export type QuestionAnswerRequest = z.infer<typeof questionAnswerRequestSchema>;

/**
 * 按提问 schema 校验一组应答，返回错误说明列表。
 *
 * 关联键缺失、选项不属于该问题、必答为空、选择数量越界都返回说明。返回空数组表示可以提交。
 * @param questions - 提问内的问题列表。
 * @param answers - 提交的应答。
 * @returns 错误说明列表，按问题出现顺序。
 */
export function validateAnswers(questions: readonly Question[], answers: readonly QuestionAnswer[]): string[] {
  const problems: string[] = [];
  const byId = new Map(questions.map((question) => [question.questionId, question]));
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (question === undefined) {
      problems.push(`回答的问题不存在：${answer.questionId}`);
      continue;
    }
    const optionIds = new Set(question.options.map((option) => option.id));
    for (const selected of answer.selected) {
      if (!optionIds.has(selected)) problems.push(`选项不属于该问题：${selected}`);
    }
    const selectedCount = answer.selected.length;
    if (question.required && selectedCount === 0 && (answer.freeText ?? '').trim() === '') {
      problems.push(`必答问题没有填写：${question.questionId}`);
    }
    if (question.minSelections !== undefined && selectedCount > 0 && selectedCount < question.minSelections) {
      problems.push(`选择数量少于下限：${question.questionId}`);
    }
    if (question.maxSelections !== undefined && selectedCount > question.maxSelections) {
      problems.push(`选择数量超过上限：${question.questionId}`);
    }
    if (!question.multiple && selectedCount > 1) {
      problems.push(`单选问题只能选择一个候选项：${question.questionId}`);
    }
    if ((answer.freeText ?? '') !== '' && !question.allowFreeText) {
      problems.push(`该问题不允许自由输入：${question.questionId}`);
    }
    if (
      question.freeTextMaxLength !== undefined &&
      (answer.freeText ?? '').length > question.freeTextMaxLength
    ) {
      problems.push(`自由输入超过长度上限：${question.questionId}`);
    }
  }
  const answered = new Set(answers.map((answer) => answer.questionId));
  for (const question of questions) {
    if (question.required && !answered.has(question.questionId)) {
      problems.push(`必答问题缺少应答：${question.questionId}`);
    }
  }
  return problems;
}

/** 提问应答的结果。 */
export const questionAnswerResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('submitted'),
    /** 卡片状态版本。 */
    stateVersion: revisionSchema,
    /** 提交时刻的毫秒时间戳。 */
    submittedAt: epochMillisSchema,
  }),
  z.object({
    outcome: z.literal('rejected'),
    /** 错误码。 */
    code: chatdshErrorCodeSchema,
    /** 逐条问题说明。 */
    problems: z.array(z.string()).optional(),
  }),
]);

/** 提问应答的结果。 */
export type QuestionAnswerResult = z.infer<typeof questionAnswerResultSchema>;
