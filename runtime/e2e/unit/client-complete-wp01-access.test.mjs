// 访问认证契约的单元测试。
//
// 覆盖访问策略、四种登录方式、访问会话列表、再次认证、TOTP 绑定与恢复码。
// 运行：node --test e2e/unit/client-complete-wp01-access.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_AUTH_METHODS,
  ACCESS_SENSITIVE_ACTIONS,
  ACCESS_SECURITY,
  REAUTH_WINDOW_SECONDS,
  accessPolicySchema,
  accessSessionListSchema,
  accessSessionSchema,
  accessSignInResultSchema,
  accessSignInSchema,
  accessStatusSchema,
  recoveryCodeSetSchema,
  reauthRequestSchema,
  reauthResultSchema,
  totpEnrollmentSchema,
} from '../../packages/core/contracts/lib/index.js';
import { assertNoWatermark, expectReject, roundtrip } from './client-complete-wp01-support.mjs';

const SESSION = {
  sessionId: 'access-1',
  clientName: 'Chrome on Linux',
  createdAt: 1_700_000_000_000,
  lastActiveAt: 1_700_000_100_000,
  expiresAt: 1_702_592_000_000,
  renewableFrom: 1_702_000_000_000,
  current: true,
};

test('访问策略要求至少一种认证方式', () => {
  const policy = roundtrip(
    accessPolicySchema,
    { methods: ['password', 'totp'], twoFactorRequired: true, trustedNetworkAvailable: false, reauthWindowSeconds: 300 },
    '访问策略',
  );
  assert.deepEqual([...policy.methods], ['password', 'totp']);
  expectReject(
    accessPolicySchema,
    { methods: [], twoFactorRequired: false, trustedNetworkAvailable: false, reauthWindowSeconds: 300 },
    '空的认证方式列表',
  );
  expectReject(
    accessPolicySchema,
    { methods: ['sms'], twoFactorRequired: false, trustedNetworkAvailable: false, reauthWindowSeconds: 300 },
    '未登记的认证方式',
  );
  expectReject(
    accessPolicySchema,
    { methods: ['password'], twoFactorRequired: false, trustedNetworkAvailable: false, reauthWindowSeconds: 301 },
    '再次认证窗口超过上限',
  );
  assert.equal(REAUTH_WINDOW_SECONDS, 300);
  assert.equal(ACCESS_SECURITY.recoveryCodeCount, 10);
  assert.ok(ACCESS_AUTH_METHODS.includes('passkey'));
  assert.ok(ACCESS_SENSITIVE_ACTIONS.includes('regenerate-recovery-codes'));
});

test('密码登录保留原内容并拒绝空密码', () => {
  roundtrip(accessSignInSchema, { method: 'password', password: ' 空格 密码 ' }, '密码登录');
  expectReject(accessSignInSchema, { method: 'password', password: '' }, '空密码');
  expectReject(accessSignInSchema, { method: 'password' }, '缺少密码字段');
});

test('通行密钥登录要求全部断言字段', () => {
  const passkey = {
    method: 'passkey',
    challengeId: 'challenge-1',
    credentialId: 'credential-1',
    clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
    authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoM',
    signature: 'MEUCIQD',
  };
  roundtrip(accessSignInSchema, passkey, '通行密钥登录');
  expectReject(accessSignInSchema, { ...passkey, signature: undefined }, '缺少签名');
  expectReject(accessSignInSchema, { ...passkey, challengeId: undefined }, '缺少挑战标识');
});

test('TOTP 登录要求六位数字与第一阶段票据', () => {
  roundtrip(accessSignInSchema, { method: 'totp', code: '123456', partialTicket: 'ticket-1' }, 'TOTP 登录');
  expectReject(accessSignInSchema, { method: 'totp', code: '12345', partialTicket: 'ticket-1' }, '五位数验证码');
  expectReject(accessSignInSchema, { method: 'totp', code: 'abcdef', partialTicket: 'ticket-1' }, '非数字验证码');
  expectReject(accessSignInSchema, { method: 'totp', code: '123456' }, '缺少第一阶段票据');
});

test('恢复码登录要求一次性票据', () => {
  roundtrip(accessSignInSchema, { method: 'recovery-code', code: 'abcd-efgh-ijkl', partialTicket: 'ticket-2' }, '恢复码登录');
  expectReject(accessSignInSchema, { method: 'recovery-code', code: 'abcd-efgh-ijkl' }, '缺少第一阶段票据');
  expectReject(accessSignInSchema, { method: 'recovery-code', code: 'short', partialTicket: 'ticket-2' }, '过短的恢复码');
});

test('登录结果的三种分支各自成立', () => {
  roundtrip(
    accessSignInResultSchema,
    { outcome: 'authenticated', session: SESSION, tokenWritten: true },
    '登录成功',
  );
  roundtrip(
    accessSignInResultSchema,
    { outcome: 'second-factor-required', partialTicket: 'ticket-3', methods: ['totp', 'recovery-code'], expiresAt: 1_700_000_300_000 },
    '需要第二因素',
  );
  const rejected = roundtrip(
    accessSignInResultSchema,
    { outcome: 'rejected', code: 'auth-locked', attemptsLeft: 0, lockedUntil: 1_700_000_600_000 },
    '登录被拒绝',
  );
  assert.equal(rejected.code, 'auth-locked');
  expectReject(
    accessSignInResultSchema,
    { outcome: 'rejected', code: 'unknown-code' },
    '未登记的错误码',
  );
  expectReject(accessSignInResultSchema, { outcome: 'signed-in', session: SESSION }, '未知的结果种类');
});

test('访问会话列表区分当前会话', () => {
  const list = roundtrip(
    accessSessionListSchema,
    { items: [SESSION, { ...SESSION, sessionId: 'access-2', current: false }], currentSessionId: 'access-1' },
    '访问会话列表',
  );
  assert.equal(list.items.length, 2);
  assertNoWatermark(list, '访问会话列表');
  expectReject(accessSessionListSchema, { items: [SESSION] }, '缺少当前会话标识');
  const stripped = accessSessionListSchema.parse({ items: [SESSION], currentSessionId: 'access-1', extra: true });
  assert.equal('extra' in stripped, false, '未声明字段在解析结果里被剥离');
  roundtrip(accessSessionSchema, SESSION, '访问会话');
});

test('TOTP 绑定信息限制地址与密钥写法', () => {
  const enrollment = roundtrip(
    totpEnrollmentSchema,
    { otpauthUri: 'otpauth://totp/ChatDSH:user?secret=JBSWY3DPEHPK3PXP&issuer=ChatDSH', secret: 'JBSWY3DPEHPK3PXP', confirmed: false },
    'TOTP 绑定',
  );
  assert.equal(enrollment.confirmed, false);
  expectReject(
    totpEnrollmentSchema,
    { otpauthUri: 'https://example.test/qr', secret: 'JBSWY3DPEHPK3PXP', confirmed: false },
    '非 otpauth 地址',
  );
  expectReject(totpEnrollmentSchema, { otpauthUri: 'otpauth://totp/x?secret=1', secret: 'jbswy3dpehpk3pxp', confirmed: false }, '小写密钥');
});

test('恢复码集合固定十条并在保存前保持未确认', () => {
  const codes = Array.from({ length: 10 }, (_, index) => `code-${index}-abcdefgh`);
  roundtrip(recoveryCodeSetSchema, { codes, generatedAt: 1, savedConfirmed: false }, '恢复码集合');
  expectReject(recoveryCodeSetSchema, { codes: codes.slice(0, 9), generatedAt: 1, savedConfirmed: false }, '九条恢复码');
  expectReject(recoveryCodeSetSchema, { codes: [...codes, 'extra-code'], generatedAt: 1, savedConfirmed: false }, '十一条恢复码');
});

test('再次认证只接受登记的敏感动作', () => {
  roundtrip(
    reauthRequestSchema,
    { action: 'regenerate-recovery-codes', method: 'totp', credential: '123456' },
    '再次认证请求',
  );
  roundtrip(reauthRequestSchema, { action: 'change-access-policy', method: 'trusted-network' }, '受信任网络再次认证');
  expectReject(reauthRequestSchema, { action: 'delete-everything', method: 'password', credential: 'x' }, '未登记的敏感动作');
  expectReject(reauthRequestSchema, { method: 'password', credential: 'x' }, '缺少敏感动作');
  const result = roundtrip(
    reauthResultSchema,
    { outcome: 'authorized', validUntil: 1_700_000_300_000 },
    '再次认证成功',
  );
  assert.equal(result.outcome, 'authorized');
  const failed = roundtrip(reauthResultSchema, { outcome: 'rejected', code: 'reauth-required' }, '再次认证被拒绝');
  assert.equal(failed.code, 'reauth-required');
  expectReject(reauthResultSchema, { outcome: 'approved' }, '未知的再次认证结果');
});

test('访问状态用于接入页渲染', () => {
  const status = roundtrip(
    accessStatusSchema,
    { required: true, methods: ['password', 'passkey'], signedIn: false, secondFactorPending: false },
    '访问状态',
  );
  assert.equal(status.required, true);
  expectReject(
    accessStatusSchema,
    { required: true, methods: ['password'], signedIn: false, secondFactorPending: 'yes' },
    '类型不符的字段',
  );
});
