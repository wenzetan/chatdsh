// 审批与提问状态机契约的单元测试。
//
// 覆盖卡片字段、关联键、状态迁移、并发决定、提问 schema 与逐项校验。
// 运行：node --test e2e/unit/client-complete-wp01-interactions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_CARD_STATES,
  APPROVAL_LIST_FILTERS,
  QUESTION_STATES,
  approvalCardSchema,
  approvalDecisionRequestSchema,
  approvalDecisionResultSchema,
  approvalListQuerySchema,
  approvalPendingCountSchema,
  canTransitionApproval,
  canTransitionQuestion,
  questionAnswerRequestSchema,
  questionAnswerResultSchema,
  questionCardSchema,
  questionSchema,
  validateAnswers,
} from '../../packages/core/contracts/lib/index.js';
import {
  OPERATION_ID,
  REQUEST_DIGEST,
  expectReject,
  roundtrip,
} from './client-complete-wp01-support.mjs';

const CARD = {
  sessionId: 'session-1',
  runId: 'run-1',
  callId: 'call-1',
  stateVersion: 3,
  state: 'pending',
  origin: 'dsh',
  toolName: 'bash',
  summary: 'rm -rf ./build',
  reason: '清理构建产物',
  deviceId: 'device-1',
  cwd: '/srv/work',
  capabilityScope: '命令执行',
  choices: ['once', 'session', 'always', 'deny'],
  priority: 1,
  raisedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_300_000,
};

const DECISION = {
  callId: 'call-1',
  stateVersion: 3,
  choice: 'once',
  operationId: OPERATION_ID,
  requestDigest: REQUEST_DIGEST,
  escalationConfirmed: false,
};

test('审批卡片字段可以往返', () => {
  const card = roundtrip(approvalCardSchema, CARD, '审批卡片');
  assert.equal(card.callId, 'call-1');
  assert.deepEqual([...APPROVAL_CARD_STATES], ['pending', 'answering', 'decided', 'expired', 'superseded', 'unavailable']);
  expectReject(approvalCardSchema, { ...CARD, state: 'waiting' }, '未知的卡片状态');
  expectReject(approvalCardSchema, { ...CARD, choices: ['maybe'] }, '未登记的审批选项');
  expectReject(approvalCardSchema, { ...CARD, origin: 'remote' }, '未知的来源执行体');
});

test('审批卡片状态按迁移表推进', () => {
  assert.equal(canTransitionApproval('pending', 'answering'), true);
  assert.equal(canTransitionApproval('pending', 'decided'), true);
  assert.equal(canTransitionApproval('answering', 'decided'), true);
  assert.equal(canTransitionApproval('pending', 'expired'), true);
  assert.equal(canTransitionApproval('decided', 'pending'), false);
  assert.equal(canTransitionApproval('expired', 'decided'), false);
  assert.equal(canTransitionApproval('superseded', 'answering'), false);
});

test('审批决定必须携带工具调用标识与状态版本', () => {
  const decision = roundtrip(approvalDecisionRequestSchema, DECISION, '审批决定');
  assert.equal(decision.choice, 'once');
  expectReject(approvalDecisionRequestSchema, { ...DECISION, callId: undefined }, '缺少工具调用标识');
  expectReject(approvalDecisionRequestSchema, { ...DECISION, stateVersion: undefined }, '缺少状态版本');
  expectReject(approvalDecisionRequestSchema, { ...DECISION, choice: 'maybe' }, '未登记的审批选项');
});

test('扩大审批范围需要再次确认', () => {
  const escalated = roundtrip(
    approvalDecisionRequestSchema,
    { ...DECISION, choice: 'always', escalationConfirmed: true },
    '扩大范围并确认',
  );
  assert.equal(escalated.escalationConfirmed, true);
  expectReject(
    approvalDecisionRequestSchema,
    { ...DECISION, choice: 'session', escalationConfirmed: false },
    '扩大范围没有确认',
  );
  expectReject(
    approvalDecisionRequestSchema,
    { ...DECISION, choice: 'always', escalationConfirmed: false },
    '始终允许没有确认',
  );
});

test('审批决定结果区分落定、已处理与拒绝', () => {
  const decided = roundtrip(
    approvalDecisionResultSchema,
    { outcome: 'decided', callId: 'call-1', stateVersion: 4, choice: 'once', decidedAt: 1_700_000_000_000 },
    '决定落定',
  );
  assert.equal(decided.stateVersion, 4);
  const already = roundtrip(
    approvalDecisionResultSchema,
    { outcome: 'already-decided', callId: 'call-1', choice: 'deny', decidedAt: 1_700_000_000_000 },
    '已被另一客户端处理',
  );
  assert.equal(already.choice, 'deny');
  const expired = roundtrip(
    approvalDecisionResultSchema,
    { outcome: 'rejected', code: 'approval-expired' },
    '卡片已失效',
  );
  assert.equal(expired.code, 'approval-expired');
  expectReject(approvalDecisionResultSchema, { outcome: 'rejected', code: 'unknown-code' }, '未登记的错误码');
  expectReject(approvalDecisionResultSchema, { outcome: 'decided', callId: 'call-1' }, '缺少状态版本与选项');
});

test('审批列表过滤与待处理计数', () => {
  roundtrip(approvalListQuerySchema, { filter: 'waiting', sessionId: 'session-1', limit: 100 }, '审批列表查询');
  assert.deepEqual([...APPROVAL_LIST_FILTERS], ['waiting', 'handled', 'all']);
  expectReject(approvalListQuerySchema, { filter: 'deferred' }, '未知的过滤条件');
  const count = roundtrip(approvalPendingCountSchema, { waiting: 2, handled: 5, readAt: 1_700_000_000_000 }, '待处理计数');
  assert.equal(count.waiting, 2);
});

test('提问 schema 校验选择数量与候选项唯一性', () => {
  const question = roundtrip(
    questionSchema,
    {
      questionId: 'question-1',
      title: '选择目标环境',
      multiple: false,
      required: true,
      options: [
        { id: 'staging', label: '预发布' },
        { id: 'prod', label: '生产' },
      ],
      allowFreeText: false,
    },
    '问题',
  );
  assert.equal(question.multiple, false);
  expectReject(
    questionSchema,
    { ...question, options: [{ id: 'staging', label: '预发布' }, { id: 'staging', label: '重复' }] },
    '重复的候选项标识',
  );
  expectReject(questionSchema, { ...question, options: [] }, '没有候选项');
  expectReject(questionSchema, { ...question, minSelections: 3 }, '最少选择超过候选项数');
  expectReject(questionSchema, { ...question, multiple: true, minSelections: 2, maxSelections: 1 }, '最少选择超过最多选择');
  expectReject(questionSchema, { ...question, multiple: false, maxSelections: 2 }, '单选问题允许多选');
});

test('提问卡片与应答状态按迁移表推进', () => {
  const card = roundtrip(
    questionCardSchema,
    {
      sessionId: 'session-1',
      stateVersion: 1,
      state: 'pending',
      questions: [
        {
          questionId: 'question-1',
          title: '选择目标环境',
          multiple: false,
          required: true,
          options: [{ id: 'staging', label: '预发布' }],
          allowFreeText: false,
        },
      ],
      raisedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_300_000,
    },
    '提问卡片',
  );
  assert.equal(card.questions.length, 1);
  assert.deepEqual([...QUESTION_STATES], ['pending', 'answering', 'submitted', 'cancelled', 'expired']);
  assert.equal(canTransitionQuestion('pending', 'submitted'), true);
  assert.equal(canTransitionQuestion('submitted', 'pending'), false);
  expectReject(questionCardSchema, { ...card, questions: [] }, '没有问题的卡片');
  expectReject(questionCardSchema, { ...card, state: 'open' }, '未知的提问状态');
});

test('提问应答要求状态版本与逐问题关联键', () => {
  roundtrip(
    questionAnswerRequestSchema,
    {
      sessionId: 'session-1',
      stateVersion: 1,
      answers: [{ questionId: 'question-1', selected: ['staging'] }],
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
    },
    '提问应答请求',
  );
  expectReject(
    questionAnswerRequestSchema,
    { sessionId: 'session-1', answers: [{ questionId: 'question-1', selected: ['staging'] }], operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST },
    '缺少状态版本',
  );
  expectReject(
    questionAnswerRequestSchema,
    { sessionId: 'session-1', stateVersion: 1, answers: [], operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST },
    '空的应答列表',
  );
  expectReject(
    questionAnswerRequestSchema,
    { sessionId: 'session-1', stateVersion: 1, answers: [{ selected: ['staging'] }], operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST },
    '应答缺少问题标识',
  );
});

test('逐问题校验拒绝越界、越权与未关联的应答', () => {
  const questions = [
    {
      questionId: 'question-1',
      title: '选择目标环境',
      multiple: false,
      required: true,
      options: [
        { id: 'staging', label: '预发布' },
        { id: 'prod', label: '生产' },
      ],
      allowFreeText: false,
    },
    {
      questionId: 'question-2',
      title: '补充说明',
      multiple: true,
      required: false,
      options: [{ id: 'note', label: '需要说明' }],
      allowFreeText: true,
      freeTextMaxLength: 10,
    },
  ];
  assert.deepEqual(validateAnswers(questions, []), ['必答问题缺少应答：question-1']);
  assert.deepEqual(
    validateAnswers(questions, [{ questionId: 'question-1', selected: ['staging'] }]),
    [],
  );
  assert.deepEqual(
    validateAnswers(questions, [{ questionId: 'missing', selected: [] }]),
    ['回答的问题不存在：missing', '必答问题缺少应答：question-1'],
  );
  assert.deepEqual(
    validateAnswers(questions, [{ questionId: 'question-1', selected: ['unknown-option'] }]),
    ['选项不属于该问题：unknown-option'],
  );
  assert.deepEqual(
    validateAnswers(questions, [{ questionId: 'question-1', selected: ['staging', 'prod'] }]),
    ['单选问题只能选择一个候选项：question-1'],
  );
  assert.deepEqual(
    validateAnswers(questions, [
      { questionId: 'question-1', selected: ['staging'] },
      { questionId: 'question-2', selected: ['note'], freeText: '超过十个字符的说明内容' },
    ]),
    ['自由输入超过长度上限：question-2'],
  );
  assert.deepEqual(
    validateAnswers(questions, [
      { questionId: 'question-1', selected: ['staging'], freeText: '不允许的自由输入' },
    ]),
    ['该问题不允许自由输入：question-1'],
  );
  const submitted = roundtrip(
    questionAnswerResultSchema,
    { outcome: 'submitted', stateVersion: 2, submittedAt: 1_700_000_000_000 },
    '提问应答成功',
  );
  assert.equal(submitted.stateVersion, 2);
  const rejected = roundtrip(
    questionAnswerResultSchema,
    { outcome: 'rejected', code: 'question-invalid', problems: ['必答问题没有填写：question-1'] },
    '提问应答被拒绝',
  );
  assert.equal(rejected.problems.length, 1);
  expectReject(questionAnswerResultSchema, { outcome: 'accepted', stateVersion: 2 }, '未知的结果种类');
});
