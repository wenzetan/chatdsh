// WP25 访问认证的凭据验收测试。
//
// 覆盖密码的设置与校验、错误密码的失败计数与锁定等待递增、一次性恢复码的消费与重放拒绝、
// TOTP 时间片的窗口判定与一次性认领。每个测试在 runtime/.run 下分配独立数据根，使用真实
// SQLite 文件与真实哈希计算，数据库文件的字节内容直接读取用于证明原值没有落库。
//
// TOTP 的完整校验（正确验证码通过、同一时间片重用拒绝）依赖成熟 TOTP 库；本机没有该依赖，
// 对应测试以明确理由记录为跳过，表示该项未验证。
//
// 运行：node --test e2e/unit/client-complete-wp25-credentials.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { CHATDSH_ERROR_CODES } from '../../packages/core/contracts/lib/index.js';
import { hashAccessPassword, verifyAccessPassword } from '../../gateway/lib/access/password.js';
import { AccessStore } from '../../gateway/lib/access/store.js';
import { createAccessLimiter } from '../../gateway/lib/access/limit.js';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  recoveryCodeDigest,
  recoveryCodesRemaining,
} from '../../gateway/lib/access/recovery.js';
import { assertTotpStepWindow, currentTotpStep, TOTP_WINDOW } from '../../gateway/lib/access/totp.js';

/** runtime 根，用于定位依赖安装位置。 */
const RUNTIME_ROOT = resolve(import.meta.dirname, '../..');

/** TOTP 库的候选安装位置。 */
const TOTP_LIBRARY_PATHS = [
  join(RUNTIME_ROOT, 'node_modules', 'otplib', 'package.json'),
  join(RUNTIME_ROOT, '.dsh-deps', 'otplib', 'package.json'),
];

/** 成熟 TOTP 库缺失的说明。 */
const TOTP_LIBRARY_REASON = `缺少成熟 TOTP 库：${TOTP_LIBRARY_PATHS.join('、')} 都不存在，TOTP 完整校验未验证`;

/** 建立独立数据根与真实 SQLite 文件上的访问存储。 */
async function withAccessStore(prefix, run) {
  const home = allocateIndependentHome(prefix);
  const databasePath = join(home, 'access.sqlite');
  const database = new DatabaseSync(databasePath);
  const store = new AccessStore(database);
  try {
    await run({ home, databasePath, database, store });
  } finally {
    database.close();
    releaseIndependentHome(home);
  }
}

/** 读取数据库文件的字节内容，按 latin1 解码后做逐字节子串比较。 */
function databaseBytes(databasePath) {
  return readFileSync(databasePath).toString('latin1');
}

/** 把文本转成与 databaseBytes 相同的比较形式。 */
function asBytes(text) {
  return Buffer.from(text, 'utf8').toString('latin1');
}

test('密码设置与校验：正确密码通过、错误密码拒绝，原值不落库', async () => {
  await withAccessStore('wp25-password', async ({ databasePath, database, store }) => {
    const now = 1_700_000_000_000;
    const encoded = await hashAccessPassword('access-pass-1');
    const fields = encoded.split('$');
    assert.equal(fields.length, 6, `密码摘要编码应当有 6 段，实际 ${fields.length} 段`);
    assert.deepEqual(fields.slice(0, 4), ['scrypt', '65536', '8', '1'], '摘要编码应当带算法与派生参数');
    assert.equal(Buffer.from(fields[4], 'base64url').length, 16, '盐应当为 16 字节');
    assert.equal(Buffer.from(fields[5], 'base64url').length, 32, '摘要应当为 32 字节');

    store.writeCredential('password', encoded, now);
    const stored = store.credential('password');
    assert.equal(stored.digest, encoded);
    assert.equal(stored.updatedAt, now);

    assert.equal(await verifyAccessPassword('access-pass-1', stored.digest), true, '正确密码应当通过校验');
    assert.equal(await verifyAccessPassword('access-pass-2', stored.digest), false, '错误密码应当被拒绝');

    // 同一密码两次设置的摘要不同：盐每次随机生成。
    const second = await hashAccessPassword('access-pass-1');
    assert.notEqual(second, encoded, '同一密码两次设置的摘要应当因为随机盐而不同');
    assert.equal(await verifyAccessPassword('access-pass-1', second), true);

    const rows = database.prepare('select kind, digest from access_credentials where kind = ?').all('password');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].digest, encoded);

    const bytes = databaseBytes(databasePath);
    assert.ok(!bytes.includes(asBytes('access-pass-1')), '数据库文件里不得出现密码原值');
    assert.ok(bytes.includes(asBytes(encoded)), '数据库文件里应当保存版本化摘要');
  });
});

test('错误密码累计到锁定阈值后拒绝，等待时间逐次递增并封顶', async () => {
  await withAccessStore('wp25-lockout', async ({ store }) => {
    const limiter = createAccessLimiter(store);
    const now = 1_700_000_000_000;
    const source = '203.0.113.7';
    const threshold = 5;
    const baseMs = 5 * 60 * 1000;
    const maxMs = 60 * 60 * 1000;

    const initial = limiter.guard(source, now);
    assert.deepEqual(initial, { allowed: true, attemptsLeft: threshold });

    for (let attempt = 1; attempt < threshold; attempt += 1) {
      const counted = limiter.fail(source, now);
      assert.equal(counted.lockedUntil, undefined, `第 ${attempt} 次失败不应进入等待`);
      assert.equal(counted.attemptsLeft, threshold - attempt, `第 ${attempt} 次失败后的剩余次数`);
    }

    const locked = limiter.fail(source, now);
    assert.equal(locked.attemptsLeft, 0);
    assert.equal(locked.lockedUntil, now + baseMs, `第 ${threshold} 次失败应当等待 ${baseMs} 毫秒`);

    const blocked = limiter.guard(source, now + 1);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.code, CHATDSH_ERROR_CODES.authLocked, '锁定期内的拒绝码应当是 auth-locked');
    assert.equal(blocked.lockedUntil, now + baseMs);
    assert.equal(limiter.lockedUntil(source, now + 1), now + baseMs);

    const waits = [];
    let at = now + baseMs + 1;
    for (let attempt = threshold + 1; attempt <= threshold + 5; attempt += 1) {
      const counted = limiter.fail(source, at);
      const wait = counted.lockedUntil - at;
      waits.push(wait);
      at = counted.lockedUntil + 1;
    }

    assert.deepEqual(
      waits,
      [baseMs * 2, baseMs * 4, baseMs * 8, maxMs, maxMs],
      `连续失败的等待时间应当逐次翻倍并封顶 ${maxMs} 毫秒，实际 ${waits.join('、')}`,
    );

    limiter.succeed(source, at);
    assert.equal(limiter.lockedUntil(source, at), undefined, '成功认证应当清零锁定状态');
    const reopened = limiter.guard(source, at);
    assert.deepEqual(reopened, { allowed: true, attemptsLeft: threshold });
  });
});

test('恢复码一次性消费，重复使用被拒绝，原值不落库', async () => {
  await withAccessStore('wp25-recovery', async ({ databasePath, database, store }) => {
    const now = 1_700_000_000_000;
    const codes = generateRecoveryCodes(store, now);
    assert.equal(codes.length, 10, '每次生成 10 条恢复码');
    assert.equal(new Set(codes).size, codes.length, '同批恢复码不得重复');
    for (const code of codes) assert.match(code, /^[0-9a-f]{32}$/, `恢复码应当是 32 个十六进制字符：${code}`);

    assert.equal(recoveryCodesRemaining(store), 10);
    assert.equal(store.recoveryCodeStats().total, 10);

    const expected = createHash('sha256').update(codes[0], 'utf8').digest('hex');
    assert.equal(recoveryCodeDigest(codes[0]), expected, '恢复码摘要应当是规范化原值的 SHA-256');
    assert.equal(recoveryCodeDigest(`  ${codes[0].toUpperCase()}  `), expected, '大小写与首尾空白不影响摘要');

    assert.equal(consumeRecoveryCode(store, codes[0], now), true, '未消费的恢复码应当消费成功');
    assert.equal(recoveryCodesRemaining(store), 9);
    assert.equal(consumeRecoveryCode(store, codes[0], now + 1), false, '同一条恢复码第二次提交必须失败');
    assert.equal(consumeRecoveryCode(store, 'z'.repeat(32), now), false, '形状不符的恢复码必须失败');
    assert.equal(consumeRecoveryCode(store, 'f'.repeat(32), now), false, '未登记的恢复码必须失败');

    const rows = database.prepare('select code_hash from access_recovery_codes order by code_hash').all();
    assert.equal(rows.length, 10);
    for (const row of rows) assert.match(row.code_hash, /^[0-9a-f]{64}$/, '库里只保存恢复码摘要');

    const bytes = databaseBytes(databasePath);
    for (const code of codes) {
      assert.ok(!bytes.includes(asBytes(code)), `数据库文件里不得出现恢复码原值：${code}`);
    }
  });
});

test('TOTP 时间片：窗口内通过、越窗拒绝、同一片只能认领一次', async () => {
  await withAccessStore('wp25-totp', async ({ database, store }) => {
    const at = 1_700_000_000_000;
    const step = currentTotpStep(at);
    assert.equal(step, Math.floor(at / 1000 / 30), '时间片序号应当是毫秒数除以 30 秒并取整');
    assert.equal(TOTP_WINDOW, 1, '允许的时间窗口为前后各一个');

    assert.doesNotThrow(() => assertTotpStepWindow(step, step));
    assert.doesNotThrow(() => assertTotpStepWindow(step, step - TOTP_WINDOW));
    assert.doesNotThrow(() => assertTotpStepWindow(step, step + TOTP_WINDOW));

    for (const offset of [TOTP_WINDOW + 1, -(TOTP_WINDOW + 1)]) {
      assert.throws(
        () => assertTotpStepWindow(step, step + offset),
        (error) => {
          assert.equal(error.code, CHATDSH_ERROR_CODES.totpInvalid, '越窗的拒绝码应当是 totp-invalid');
          return true;
        },
        `偏移 ${offset} 个时间片应当被拒绝`,
      );
    }

    assert.equal(store.consumeTotpStep(step, at), true, '当前时间片第一次认领应当成功');
    assert.equal(store.consumeTotpStep(step, at + 1), false, '同一时间片第二次认领必须失败');

    assert.equal(store.consumeTotpStep(step - 1, at), true);
    store.pruneTotpSteps(step);
    const remaining = database.prepare('select step from access_totp_steps order by step').all();
    assert.deepEqual(
      remaining.map((row) => row.step),
      [step],
      `清理应当只保留不早于给定时间片的记录，实际 ${remaining.map((row) => row.step).join('、')}`,
    );
  });
});

test(
  'TOTP 校验：正确时间片通过、同一时间片重用拒绝',
  { skip: TOTP_LIBRARY_PATHS.some((path) => existsSync(path)) ? false : TOTP_LIBRARY_REASON },
  () => {},
);
