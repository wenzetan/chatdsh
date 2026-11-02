// SYS03 备份、校验与隔离恢复的验收测试。
//
// 真实 SQLite、真实文件系统、真实 HTTP 监听与独立数据根。每个测试在 runtime/.run 下分配独立
// 数据根：源数据根里建立两台设备的会话归属、真实 JSONL 会话日志、附件字节、分享包、推送订阅、
// 外部自动化与加密凭据，随后生成备份、逐项校验、销毁源，再仅用备份恢复到另一个目录并继续指定
// 会话。演练全程记录对一个真实 HTTP 端点的请求次数，断言零外发。
//
// 运行：node --test e2e/unit/client-complete-sys03-backup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, ReplicaStore, SettingsStore, ShareStore } from '../../gateway/lib/store.js';
import { AutomationStore, handleWebhook } from '../../gateway/lib/automation.js';
import { NotificationStore } from '../../gateway/lib/notifications/records.js';
import { deriveAccessKey, loadAccessMasterKey, sealAccessSecret } from '../../gateway/lib/access/keys.js';
import { writeShareAttachment } from '../../gateway/lib/sharing/attachments.js';
import * as backup from '../../gateway/lib/backup/index.js';
import * as hostBackup from '../../packages/host/backup/lib/index.js';

/** runtime 根。 */
const RUNTIME = resolve(import.meta.dirname, '../..');

/** 测试用软件版本。 */
const SOFTWARE_VERSION = '0.1.0';

/** 真实端点收到的请求条数；任何外发都会记在这里。 */
let outboundRequests = 0;

/** 关闭遥测导出的真实遥测客户端。 */
function createTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
}

/** 计算文本摘要。 */
function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 在独立数据根里运行一个测试。 */
async function withHome(prefix, run) {
  const home = allocateIndependentHome(prefix);
  try {
    return await run(home);
  } finally {
    releaseIndependentHome(home);
  }
}

/** 建立一个真实 HTTP 端点，记录收到的请求。 */
async function startEndpoint() {
  const server = createServer((request, response) => {
    outboundRequests += 1;
    request.resume();
    response.writeHead(204);
    response.end();
  });
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/notify`,
    async stop() {
      await new Promise((settle) => server.close(settle));
    },
  };
}

/** 写一份附件字节。 */
function writeAttachment(home, id, filename, content) {
  const directory = join(home, 'attachments', id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, filename), content, { encoding: 'utf8', mode: 0o600 });
  return { id, filename, content, bytes: Buffer.byteLength(content) };
}

/** 建立会话日志的持久化上下文。 */
async function createPersistence(root) {
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
  const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl');
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(jsonl, { root });
  await new Promise((settle) => setTimeout(settle, 600));
  return ctx;
}

/** 用真实会话持久化写下会话日志。 */
async function writeSessionLogs(root, specs) {
  const ctx = await createPersistence(root);
  for (const spec of specs) {
    const created = await ctx.sessionPersistence.create({
      id: spec.sessionId,
      version: 4,
      cwd: spec.cwd,
      createdAt: spec.createdAt,
      isSeeded: false,
    });
    const events = eventsFor(spec.sessionId, spec.createdAt, 0, spec.events);
    await created.append(events);
    await created.flush();
    await created.close();
  }
  return ctx;
}

/** 构造一段连续事件：回合开始与回合结束成对出现，序号连续。 */
function eventsFor(sessionId, createdAt, fromSeq, count) {
  void sessionId;
  const events = [];
  for (let offset = 0; offset < count; offset += 1) {
    const seq = fromSeq + offset;
    const turn = Math.floor(seq / 2) + 1;
    events.push(seq % 2 === 0
      ? { type: 'turn/start', seq, time: createdAt + seq + 1, data: { turn } }
      : { type: 'turn/end', seq, time: createdAt + seq + 1, data: { turn, reason: { kind: 'completed' } } });
  }
  return events;
}

/** 用真实持久化续写指定会话。 */
async function appendSessionLog(root, spec, fromSeq, count) {
  const ctx = await createPersistence(root);
  const handle = await ctx.sessionPersistence.open(spec.sessionId, 'write');
  await handle.append(eventsFor(spec.sessionId, spec.createdAt, fromSeq, count));
  await handle.flush();
  await handle.close();
}

/**
 * 在源数据根里建立多设备会话、附件、分享、推送订阅、外部自动化与加密凭据。
 * @returns 演练需要核对的事实。
 */
async function seedSource(home, options = {}) {
  const now = Date.now() - 3_600_000;
  const databasePath = join(home, 'gateway', 'gateway.sqlite');
  const store = new GatewayStore(databasePath);
  const replica = new ReplicaStore(store.handle());
  store.registerNode({ id: 'device-a', name: 'A 工作站', platform: 'linux', role: 'host', capabilities: ['shell', 'files'], tokenHash: sha256Hex('token-a') });
  store.registerNode({ id: 'device-b', name: 'B 笔记本', platform: 'darwin', role: 'executor', capabilities: ['shell'], tokenHash: sha256Hex('token-b') });
  store.touchDevice({ id: 'device-a', origin: 'cli', platform: 'linux', lastSeenAt: now });
  store.touchDevice({ id: 'device-b', origin: 'desktop', platform: 'darwin', lastSeenAt: now + 1 });
  const sessionSpecs = [
    { sessionId: 'sess-alpha', deviceId: 'device-a', cwd: '/work/alpha', kind: 'work', createdAt: now, events: 6 },
    { sessionId: 'sess-beta', deviceId: 'device-b', cwd: '/work/beta', kind: 'chat', createdAt: now + 1000, events: 6 },
  ];
  for (const spec of sessionSpecs) {
    store.upsertSession({
      sessionId: spec.sessionId,
      deviceId: spec.deviceId,
      cwd: spec.cwd,
      kind: spec.kind,
      createdAt: spec.createdAt,
    });
  }
  for (const spec of sessionSpecs) {
    for (const event of eventsFor(spec.sessionId, spec.createdAt, 0, spec.events)) {
      replica.append(spec.sessionId, [{
        seq: event.seq,
        kind: event.type,
        time: event.time,
        bytes: Buffer.byteLength(JSON.stringify(event)),
        payload: event,
      }]);
    }
  }
  const share = new ShareStore(store.handle()).create({ sessionId: 'sess-alpha' }, 5);
  const notifications = new NotificationStore(store.handle());
  if (options.pushEndpoint !== undefined) {
    notifications.upsertSubscription({
      deviceId: 'device-a',
      clientId: 'client-a',
      endpoint: options.pushEndpoint,
      p256dh: 'BOr6yq6r7yQ0m9m5c7cQ0m9m5c7cQ0m9m5c7cQ0m9m5c7cQ0m9m5c7cQ',
      auth: 'c2VjcmV0LWF1dGg',
      permission: 'granted',
    }, now);
  }
  const automation = new AutomationStore(store.handle());
  automation.create({
    id: 'auto-1',
    name: '外部巡检',
    trigger: { kind: 'webhook', secretEnv: 'SYS03_WEBHOOK_SECRET' },
    action: { kind: 'start-session', prompt: '巡检' },
    enabled: true,
    createdAt: now,
    target: { deviceId: 'device-a' },
  });
  const masterKey = loadAccessMasterKey(join(home, 'access', 'master.key'));
  const envelopeSource = options.foreignEnvelope === true ? randomBytes(32) : masterKey;
  const envelope = sealAccessSecret(deriveAccessKey(envelopeSource, 'envelope'), Buffer.from('totp-secret-for-restore'), 'totp');
  const settings = new SettingsStore(store.handle());
  settings.put({ namespace: 'access', key: 'totp', value: JSON.stringify(envelope) });
  store.close();

  const attachments = [
    writeAttachment(home, 'att-report', 'report.md', '# 演练报告\n多设备会话与附件字节\n'),
    writeAttachment(home, 'att-trace', 'trace.log', 'line-1\nline-2\n'),
  ];
  const shareBytes = Buffer.from('分享包里的附件副本\n', 'utf8');
  const shareStorageKey = await writeShareAttachment({
    root: join(home, 'shares'),
    token: share.token,
    attachmentId: 'att-shared',
    bytes: shareBytes,
  });

  await writeSessionLogs(join(home, 'sessions'), sessionSpecs);

  return {
    databasePath,
    sessions: sessionSpecs,
    attachments,
    shareToken: share.token,
    shareStorageKey,
    shareBytes,
    masterKeyPath: join(home, 'access', 'master.key'),
  };
}

/** 生成一套备份。 */
function createSet(sourceRoot, backupRoot, keyPath, options = {}) {
  return backup.createBackup({
    sourceRoot,
    backupRoot,
    software: { version: SOFTWARE_VERSION },
    keyPath,
    external: options.external ?? [
      { service: 'hindsight', configured: true, reference: 'hindsight-export-2026-11-02' },
      { service: 'hermes', configured: false },
    ],
    telemetry: options.telemetry,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
}

/** 读数据库里的一张表，返回纯对象行。 */
function rowsOf(databasePath, sql, parameters = []) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all(...parameters).map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

/** 读一行。 */
function rowOf(databasePath, sql, parameters = []) {
  return rowsOf(databasePath, sql, parameters)[0];
}

test('备份：多设备会话、附件与分享进入清单，SQLite 走一致性快照，主密钥不进入备份', async () => {
  const telemetry = createTelemetry();
  try {
    await withHome('sys03-create', async (home) => {
      await withHome('sys03-create-store', async (storeHome) => {
        const source = await seedSource(home);
        const backupRoot = join(storeHome, 'sets', 'set-1');
        const created = await createSet(home, backupRoot, source.masterKeyPath, { telemetry });

        assert.equal(created.manifest.manifestVersion, 1);
        assert.equal(created.manifest.software.product, 'chatdsh');
        assert.equal(created.manifest.software.version, SOFTWARE_VERSION);
        assert.equal(created.manifest.restorePoint.sessions, 2, '恢复点记录两个会话');
        assert.equal(created.manifest.restorePoint.events, 12, '恢复点记录十二条副本事件');
        assert.ok(created.manifest.restorePoint.maxEventTime > 0);

        const included = Object.fromEntries(created.manifest.included.map((entry) => [entry.domain, entry]));
        for (const domain of ['control-plane', 'device-logs', 'attachments', 'share-packages', 'exports', 'access-credentials']) {
          assert.ok(included[domain] !== undefined, `包含清单缺少数据域 ${domain}`);
        }
        assert.equal(included['control-plane'].kind, 'sqlite-snapshot', '控制平面用一致性快照');
        assert.equal(included['device-logs'].objects, 4, '两个会话目录各有一份压缩日志与一个租约文件');
        assert.equal(included.attachments.objects, 2, '两个附件对象进入备份');
        assert.equal(included['share-packages'].objects, 1, '分享包里的附件副本进入备份');

        const excluded = Object.fromEntries(created.manifest.excluded.map((entry) => [entry.domain, entry]));
        for (const domain of ['hindsight-memory', 'hermes-history', 'master-key', 'workspace-files', 'process-secrets']) {
          assert.ok(excluded[domain] !== undefined, `排除清单缺少 ${domain}`);
          assert.ok(excluded[domain].reason.length > 0, `排除项 ${domain} 缺少原因`);
        }

        const external = Object.fromEntries(created.manifest.external.map((entry) => [entry.service, entry]));
        assert.equal(external.hindsight.configured, true);
        assert.equal(external.hindsight.included, false, 'Hindsight 数据不包含在备份内');
        assert.equal(external.hindsight.reference, 'hindsight-export-2026-11-02', '记录单独备份结果引用');
        assert.equal(external.hermes.configured, false);
        assert.equal(external.hermes.included, false);

        const keyPaths = created.manifest.objects.map((object) => object.relativePath);
        assert.equal(keyPaths.includes('access/master.key'), false, '主密钥不得进入备份');
        assert.equal(keyPaths.includes('gateway/gateway.sqlite'), true);
        assert.equal(keyPaths.includes('attachments/att-report/report.md'), true);
        assert.equal(keyPaths.includes(`shares/${source.shareStorageKey}`), true);
        assert.ok(
          keyPaths.some((path) => path.startsWith('sessions/') && path.endsWith('.jsonl.zstd')),
          '设备会话日志进入备份',
        );
        assert.equal(
          created.manifest.totals.plaintextBytes,
          created.manifest.objects.reduce((sum, object) => sum + object.bytes, 0),
          '清单合计等于对象字节之和',
        );
        assert.equal(created.manifest.retention.daily, 7);
        assert.equal(created.manifest.retention.weekly, 4);
        assert.equal(created.manifest.retention.monthly, 12);
        assert.equal(created.manifest.encryption.masterKeyIncluded, false);
        assert.equal(created.manifest.keys.length, 2, '备份对象加密与访问凭据信封各一项密钥要求');
        assert.ok(created.manifest.keys.every((key) => key.recovery.length >= 2), '每项密钥要求都给出恢复条件');

        assert.equal(existsSync(join(backupRoot, backup.CHECKPOINT_FILENAME)), false, '备份完成后检查点被移除');
        const objectFile = join(backupRoot, created.manifest.objects.find((object) => object.relativePath === 'attachments/att-report/report.md').key);
        const cipher = readFileSync(objectFile);
        const plain = Buffer.from(source.attachments[0].content, 'utf8');
        assert.equal(cipher.subarray(0, Math.min(16, plain.length)).equals(plain.subarray(0, Math.min(16, plain.length))), false, '对象以密文保存');
        assert.equal(cipher.length, plain.length + 16, '密文长度等于明文加认证标签');

        const snapshot = rowOf(source.databasePath, 'select count(*) as total from sqlite_master where type = ?', ['table']);
        assert.ok(Number(snapshot.total) > 0);
        const controlPlaneObject = created.manifest.objects.find((object) => object.relativePath === 'gateway/gateway.sqlite');
        assert.ok(controlPlaneObject.cipherBytes > controlPlaneObject.bytes, '一致性快照同样走加密');
      });
    });
  } finally {
    await telemetry.shutdown();
  }
});

test('校验：摘要核对通过；对象缺失、损坏、清单被改写、空间不足、密钥缺失与不符各自明确失败', async () => {
  const telemetry = createTelemetry();
  try {
    await withHome('sys03-verify', async (home) => {
      await withHome('sys03-verify-store', async (storeHome) => {
        const source = await seedSource(home);
        const backupRoot = join(storeHome, 'sets', 'set-1');
        const created = await createSet(home, backupRoot, source.masterKeyPath, { telemetry });

        const report = await backup.verifyBackup({ backupRoot, keyPath: source.masterKeyPath, telemetry });
        assert.equal(report.manifestId, created.manifestId);
        assert.equal(report.objects, created.manifest.objects.length);
        assert.equal(report.plaintextBytes, created.manifest.totals.plaintextBytes);
        assert.equal(report.keyId, backup.backupKeyIdOf(readFileSync(source.masterKeyPath)));
        assert.equal(report.schemaVersion, 0);
        assert.ok(report.external.some((entry) => entry.service === 'hindsight' && entry.reference === 'hindsight-export-2026-11-02'));

        const corruptRoot = join(storeHome, 'sets', 'corrupt');
        cpSync(backupRoot, corruptRoot, { recursive: true });
        const corruptObject = join(corruptRoot, created.manifest.objects.find((object) => object.relativePath === 'attachments/att-trace/trace.log').key);
        const bytes = readFileSync(corruptObject);
        bytes[Math.floor(bytes.length / 2)] ^= 0xff;
        writeFileSync(corruptObject, bytes);
        await assert.rejects(
          backup.verifyBackup({ backupRoot: corruptRoot, keyPath: source.masterKeyPath, telemetry }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.objectCorrupt, `损坏对象的原因码应当是 ${backup.BACKUP_ERROR_CODES.objectCorrupt}`);
            return true;
          },
          '密文被改写时必须明确失败',
        );

        const missingRoot = join(storeHome, 'sets', 'missing');
        cpSync(backupRoot, missingRoot, { recursive: true });
        rmSync(join(missingRoot, created.manifest.objects.find((object) => object.relativePath === 'attachments/att-trace/trace.log').key));
        await assert.rejects(
          backup.verifyBackup({ backupRoot: missingRoot, keyPath: source.masterKeyPath, telemetry }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.objectMissing, '对象缺失必须明确失败');
            assert.equal(error.details.missing, 1);
            return true;
          },
          '缺少对象时必须明确失败',
        );

        const tamperedRoot = join(storeHome, 'sets', 'tampered');
        cpSync(backupRoot, tamperedRoot, { recursive: true });
        const manifestPath = join(tamperedRoot, backup.MANIFEST_FILENAME);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.restorePoint.events = 9999;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await assert.rejects(
          backup.verifyBackup({ backupRoot: tamperedRoot, keyPath: source.masterKeyPath, telemetry }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.manifestDigestMismatch, '清单被改写必须明确失败');
            return true;
          },
          '清单正文被改写时必须失败',
        );

        await assert.rejects(
          backup.verifyBackup({ backupRoot, keyPath: source.masterKeyPath, telemetry, requiredFreeBytes: Number.MAX_SAFE_INTEGER }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.diskSpaceInsufficient, '空间不足必须明确失败');
            assert.ok(Number(error.details.freeBytes) > 0);
            assert.equal(Number(error.details.requiredBytes), Number.MAX_SAFE_INTEGER);
            return true;
          },
          '剩余空间不足时必须失败',
        );

        await assert.rejects(
          backup.verifyBackup({ backupRoot, keyPath: join(storeHome, 'absent.key'), telemetry }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.keyMissing, '密钥缺失必须明确失败');
            assert.ok(error.recovery.length >= 1, '密钥缺失时给出重新配置条件');
            return true;
          },
          '缺少密钥时必须失败',
        );

        const wrongKeyPath = join(storeHome, 'wrong.key');
        writeFileSync(wrongKeyPath, randomBytes(32), { mode: 0o600 });
        await assert.rejects(
          backup.verifyBackup({ backupRoot, keyPath: wrongKeyPath, telemetry }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.keyMismatch, '密钥与清单不符必须明确失败');
            return true;
          },
          '密钥不一致时必须失败',
        );

        await assert.rejects(
          createSet(home, join(storeHome, 'sets', 'external-missing'), source.masterKeyPath, {
            telemetry,
            external: [{ service: 'hindsight', configured: true }],
          }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.externalScopeIncomplete, '外部服务缺少备份引用必须要求补齐');
            assert.equal(error.details.service, 'hindsight');
            return true;
          },
          '外部服务数据未包含时必须要求补齐',
        );
      });
    });
  } finally {
    await telemetry.shutdown();
  }
});

test('恢复：凭据无法解密时停止，删除未完成的目录并给出重新配置条件', async () => {
  const telemetry = createTelemetry();
  try {
    await withHome('sys03-credential', async (home) => {
      await withHome('sys03-credential-store', async (storeHome) => {
        const source = await seedSource(home, { foreignEnvelope: true });
        const backupRoot = join(storeHome, 'sets', 'set-1');
        await createSet(home, backupRoot, source.masterKeyPath, { telemetry });
        const targetRoot = join(storeHome, 'restored');
        await assert.rejects(
          backup.restoreBackup({
            backupRoot,
            targetRoot,
            keyPath: source.masterKeyPath,
            currentSoftware: { version: SOFTWARE_VERSION, schemaVersion: 1 },
            telemetry,
          }),
          (error) => {
            assert.equal(
              error.code,
              backup.BACKUP_ERROR_CODES.restoreCredentialUndecryptable,
              `凭据不可解密的原因码应当是 ${backup.BACKUP_ERROR_CODES.restoreCredentialUndecryptable}`,
            );
            assert.ok(error.recovery.length >= 2, '停止时给出重新配置条件');
            return true;
          },
          '加密凭据无法解密时必须停止恢复',
        );
        assert.equal(existsSync(targetRoot), false, '失败时不留下半成品目录');
      });
    });
  } finally {
    await telemetry.shutdown();
  }
});

test('备份中断：进程被真实终止后按检查点续跑，已完成对象不重复加密', async () => {
  const telemetry = createTelemetry();
  try {
    await withHome('sys03-resume', async (home) => {
      await withHome('sys03-resume-store', async (storeHome) => {
        const source = await seedSource(home);
        const backupRoot = join(storeHome, 'sets', 'resume');
        const modules = {
          backup: pathToFileURL(join(RUNTIME, 'gateway/lib/backup/index.js')).href,
          client: pathToFileURL(join(RUNTIME, 'packages/core/diagnostics/lib/client.js')).href,
          config: pathToFileURL(join(RUNTIME, 'packages/core/diagnostics/lib/config.js')).href,
        };
        const script = [
          `const backup = await import(${JSON.stringify(modules.backup)});`,
          `const { createTelemetryClient } = await import(${JSON.stringify(modules.client)});`,
          `const { defaultTelemetryConfig } = await import(${JSON.stringify(modules.config)});`,
          'const telemetry = createTelemetryClient({ config: defaultTelemetryConfig({ surface: "gateway" }), component: "@chatdsh/gateway", env: { CHATDSH_TELEMETRY: "off" } });',
          'await backup.createBackup({',
          '  sourceRoot: process.env.SYS03_SOURCE,',
          '  backupRoot: process.env.SYS03_BACKUP,',
          '  software: { version: "0.1.0" },',
          '  keyPath: process.env.SYS03_KEY,',
          '  external: [{ service: "hindsight", configured: false }, { service: "hermes", configured: false }],',
          '  telemetry,',
          '  onProgress: (progress) => { process.stdout.write(JSON.stringify({ done: progress.completed, path: progress.relativePath }) + "\\n"); },',
          '});',
        ].join('\n');
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          cwd: RUNTIME,
          env: {
            ...process.env,
            DSH_HOME: home,
            CHATDSH_TELEMETRY: 'off',
            SYS03_SOURCE: home,
            SYS03_BACKUP: backupRoot,
            SYS03_KEY: source.masterKeyPath,
          },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        const firstLine = await new Promise((settle, fail) => {
          let buffer = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            buffer += chunk;
            const line = buffer.split('\n')[0];
            if (!buffer.includes('\n')) return;
            settle(line);
          });
          child.on('exit', (code) => fail(new Error(`备份子进程提前结束，退出码 ${code}`)));
        });
        assert.ok(JSON.parse(firstLine).done >= 1, '子进程至少完成一个对象');
        const exited = new Promise((settle) => child.once('exit', (code, signal) => settle({ code, signal })));
        child.kill('SIGKILL');
        assert.equal((await exited).signal, 'SIGKILL', '备份进程被真实终止');
        assert.equal(existsSync(join(backupRoot, backup.CHECKPOINT_FILENAME)), true, '终止后检查点留在备份目录');
        const checkpoint = JSON.parse(readFileSync(join(backupRoot, backup.CHECKPOINT_FILENAME), 'utf8'));
        assert.ok(Object.keys(checkpoint.objects).length >= 1, '检查点登记了已完成对象');

        const resumed = await createSet(home, backupRoot, source.masterKeyPath, { telemetry });
        assert.ok(resumed.resumedObjects >= 1, '续跑跳过已完成对象');
        assert.equal(resumed.manifest.objects.length, resumed.manifest.totals.objects);
        assert.equal(existsSync(join(backupRoot, backup.CHECKPOINT_FILENAME)), false, '续跑完成后检查点被移除');
        const report = await backup.verifyBackup({ backupRoot, keyPath: source.masterKeyPath, telemetry });
        assert.equal(report.objects, resumed.manifest.objects.length, '续跑得到的备份通过完整校验');

        const otherSource = join(storeHome, 'other-source');
        mkdirSync(join(otherSource, 'gateway'), { recursive: true });
        rmSync(backupRoot, { recursive: true });
        mkdirSync(backupRoot, { recursive: true });
        writeFileSync(join(backupRoot, backup.CHECKPOINT_FILENAME), JSON.stringify({
          checkpointVersion: 1,
          sourceRoot: otherSource,
          sourceDigest: 'another-digest',
          startedAt: Date.now(),
          objects: {},
        }));
        await assert.rejects(
          createSet(home, backupRoot, source.masterKeyPath, { telemetry }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.checkpointMismatch, '换了源必须拒绝续跑');
            return true;
          },
          '检查点与当前源不一致时必须拒绝',
        );
      });
    });
  } finally {
    await telemetry.shutdown();
  }
});

test('隔离恢复：销毁源后仅凭备份恢复到新目录，核对字节与业务关系并继续指定会话', async (t) => {
  const telemetry = createTelemetry();
  const sourceHome = allocateIndependentHome('sys03-source');
  try {
    await withHome('sys03-restore-store', async (storeHome) => {
        const source = await seedSource(sourceHome);
        const keyPath = join(storeHome, 'keys', 'master.key');
        mkdirSync(join(storeHome, 'keys'), { recursive: true, mode: 0o700 });
        writeFileSync(keyPath, readFileSync(source.masterKeyPath), { mode: 0o600 });
        const backupRoot = join(storeHome, 'sets', 'set-1');
        const created = await createSet(sourceHome, backupRoot, source.masterKeyPath, { telemetry });

        rmSync(sourceHome, { recursive: true });
        assert.equal(existsSync(sourceHome), false, '测试源被真实销毁');

        const targetRoot = join(storeHome, 'restored');
        const report = await backup.restoreBackup({
          backupRoot,
          targetRoot,
          keyPath,
          currentSoftware: { version: SOFTWARE_VERSION, schemaVersion: 1 },
          telemetry,
        });

        assert.equal(report.manifestId, created.manifestId);
        assert.equal(report.restorePoint.at, created.manifest.restorePoint.maxEventTime, '实际恢复点取自副本事件');
        assert.equal(report.restorePoint.events, 12);
        assert.equal(report.restorePoint.sessions, 2);
        assert.ok(report.durationMs >= 0);
        assert.match(report.restorePoint.iso, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(report.items.ownership.valid, true);
        assert.equal(report.items.ownership.sessions, 2);
        assert.equal(report.items.continuity.events, 12);
        assert.equal(report.items.continuity.sessions, 2);
        assert.equal(report.items.continuity.maxSeq, 5);
        assert.equal(report.items.attachments.files, 3, '两个附件加分享包里的附件副本');
        assert.equal(report.items.encryption.credentialRecords, 1);
        assert.equal(report.items.encryption.decrypted, 1);
        t.diagnostic(`实际恢复点 ${report.restorePoint.iso}（会话 ${String(report.restorePoint.sessions)} 个、事件 ${String(report.restorePoint.events)} 条），恢复耗时 ${String(report.durationMs)} 毫秒，核对对象 ${String(report.items.manifest.objects)} 个`);
        assert.equal(report.items.compatibility.compatible, true);
        assert.equal(report.external.find((entry) => entry.service === 'hindsight').reference, 'hindsight-export-2026-11-02');

        assert.equal(existsSync(join(targetRoot, backup.RESTORE_GATE_FILENAME)), true, '恢复目录里写入恢复门禁');
        assert.equal(existsSync(join(targetRoot, backup.RESTORE_REPORT_FILENAME)), true, '恢复目录里写入恢复报告');
        assert.equal(statSync(join(targetRoot, backup.RESTORE_GATE_FILENAME)).mode & 0o777, 0o600);

        for (const attachment of source.attachments) {
          const restored = readFileSync(join(targetRoot, 'attachments', attachment.id, attachment.filename), 'utf8');
          assert.equal(restored, attachment.content, `附件 ${attachment.filename} 的字节一致`);
        }
        const shareBytes = readFileSync(join(targetRoot, 'shares', source.shareStorageKey));
        assert.equal(shareBytes.equals(source.shareBytes), true, '分享包字节一致');

        const restoredManifest = hostBackup.readRestoredManifest(targetRoot);
        assert.equal(restoredManifest.manifestId, created.manifestId, '恢复目录保留原清单');
        const restoredFiles = await hostBackup.verifyRestoredFiles(targetRoot, restoredManifest);
        assert.equal(restoredFiles.valid, true);
        assert.equal(restoredFiles.byDomain['device-logs'], 4, '两份设备会话日志的字节与清单一致');
        assert.equal(restoredFiles.byDomain.attachments, 2);
        assert.equal(restoredFiles.byDomain['share-packages'], 1);
        assert.deepEqual(restoredFiles.skipped, ['control-plane'], '控制平面在恢复后被有意改写，不参与这一轮字节核对');

        const restoredDatabase = join(targetRoot, 'gateway', 'gateway.sqlite');
        assert.equal(statSync(restoredDatabase).mode & 0o777, 0o600);
        const sessions = rowsOf(restoredDatabase, 'select session_id, device_id from sessions order by session_id');
        assert.deepEqual(sessions.map((row) => row.session_id), ['sess-alpha', 'sess-beta']);
        assert.deepEqual(sessions.map((row) => row.device_id), ['device-a', 'device-b']);
        const share = rowOf(restoredDatabase, 'select session_id, up_to_seq from shares where token = ?', [source.shareToken]);
        assert.equal(share.session_id, 'sess-alpha');
        assert.equal(Number(share.up_to_seq), 5);
        const nodeRows = rowsOf(restoredDatabase, 'select id, token_hash from node_devices order by id');
        assert.equal(nodeRows.length, 2);
        for (const row of nodeRows) {
          assert.match(row.token_hash, /^restored-/, '恢复后节点令牌失效，需要重新配对或轮换');
        }
        const restoredStore = new GatewayStore(restoredDatabase);
        try {
          assert.equal(restoredStore.nodeByTokenHash(sha256Hex('token-a')), undefined, '旧节点令牌不再有效');
          const replica = new ReplicaStore(restoredStore.handle());
          assert.equal(replica.watermarkOf('sess-alpha'), 5, '副本水位随备份一起恢复');
        } finally {
          restoredStore.close();
        }

        const spec = source.sessions[0];
        await appendSessionLog(join(targetRoot, 'sessions'), spec, 6, 2);
        const continuedStore = new GatewayStore(restoredDatabase);
        try {
          const replica = new ReplicaStore(continuedStore.handle());
          const appended = replica.append('sess-alpha', eventsFor('sess-alpha', spec.createdAt, 6, 2).map((event) => ({
            seq: event.seq,
            kind: event.type,
            time: event.time,
            bytes: Buffer.byteLength(JSON.stringify(event)),
            payload: event,
          })));
          assert.equal(appended.written, 2, '恢复后的控制平面可以继续接收该会话事件');
          assert.equal(appended.watermark, 7);
        } finally {
          continuedStore.close();
        }
        const continuity = backup.verifyContinuity(restoredDatabase);
        assert.equal(continuity.valid, true);
        assert.equal(continuity.events, 14);
        assert.equal(continuity.maxSeq, 7);
        const restarted = await backup.readRestorePoint(restoredDatabase);
        assert.equal(restarted.events, 14);
        assert.ok(restarted.maxEventTime >= report.restorePoint.at);
    });
  } finally {
    if (existsSync(sourceHome)) releaseIndependentHome(sourceHome);
    await telemetry.shutdown();
  }
});

test('恢复端零外发：外部自动化与通知发送默认关闭，逐项处置后才放开', async () => {
  const telemetry = createTelemetry();
  const endpoint = await startEndpoint();
  const before = outboundRequests;
  try {
    await withHome('sys03-gate-source', async (sourceHome) => {
      await withHome('sys03-gate-store', async (storeHome) => {
        const source = await seedSource(sourceHome, { pushEndpoint: endpoint.url });
        const backupRoot = join(storeHome, 'sets', 'set-1');
        await createSet(sourceHome, backupRoot, source.masterKeyPath, { telemetry });
        const targetRoot = join(storeHome, 'restored');
        const report = await backup.restoreBackup({
          backupRoot,
          targetRoot,
          keyPath: source.masterKeyPath,
          currentSoftware: { version: SOFTWARE_VERSION, schemaVersion: 1 },
          telemetry,
        });
        assert.equal(report.gate.externalAutomation, 'disabled');
        assert.equal(report.gate.notificationSending, 'disabled');
        assert.ok(report.gate.dispositions.some((item) => item.kind === 'device-token'));
        assert.ok(report.gate.dispositions.some((item) => item.kind === 'push-subscription'));
        assert.ok(report.gate.dispositions.some((item) => item.kind === 'automation'));
        assert.ok(report.gate.dispositions.some((item) => item.kind === 'access-credential'));
        assert.equal(report.gate.dispositions.every((item) => item.state === 'pending'), true);

        const gate = hostBackup.readRestoreGate(targetRoot);
        assert.equal(gate.manifestId, report.manifestId);
        hostBackup.assertArtifactsAgree(hostBackup.readRestoreReport(targetRoot), gate);
        assert.throws(
          () => hostBackup.assertExternalServiceAllowed(gate, 'external-automation'),
          (error) => {
            assert.equal(error.code, hostBackup.RESTORE_ARTIFACT_ERROR_CODES.externalDisabled);
            return true;
          },
          '外部自动化在处置完成前必须关闭',
        );
        assert.throws(
          () => hostBackup.assertExternalServiceAllowed(gate, 'notification-sending'),
          (error) => {
            assert.equal(error.code, hostBackup.RESTORE_ARTIFACT_ERROR_CODES.externalDisabled);
            return true;
          },
          '通知发送在处置完成前必须关闭',
        );

        const restoredDatabase = join(targetRoot, 'gateway', 'gateway.sqlite');
        const automations = rowsOf(restoredDatabase, 'select id, enabled from automations');
        assert.equal(automations.length, 1);
        assert.equal(Number(automations[0].enabled), 0, '恢复后外部自动化被停用');
        const restoredHandle = new DatabaseSync(restoredDatabase);
        let webhook;
        let subscriptions;
        try {
          const automationStore = new AutomationStore(restoredHandle);
          webhook = handleWebhook(automationStore, 'auto-1', { 'x-chatdsh-webhook-secret': 'ignored' }, '{"event":"push"}');
          const notifications = new NotificationStore(restoredHandle);
          assert.equal(notifications.activeSubscriptions('device-a').length, 0, '恢复后没有生效的推送订阅');
          subscriptions = notifications.subscriptions('device-a');
        } finally {
          restoredHandle.close();
        }
        assert.equal(webhook.status, 404);
        assert.equal(webhook.body.error, 'automation-disabled', '恢复后的自动化拒收外部触发');
        assert.equal(subscriptions.length, 1);
        assert.equal(subscriptions[0].state, 'unsubscribed', '推送订阅置为待确认状态');
        assert.equal(subscriptions[0].code, 'restore-pending-confirmation');

        const plan = await hostBackup.planStartupAfterRestore({
          restoredRoot: targetRoot,
          currentVersion: SOFTWARE_VERSION,
          supportedSchemaVersion: 1,
        });
        assert.equal(plan.canServe, true, '本地数据可用');
        assert.equal(plan.canServeExternally, false, '对外服务尚未放开');
        assert.ok(plan.blockers.includes('external-services-disabled'));
        assert.ok(plan.blockers.some((item) => item.startsWith('dispositions-pending:')));
        assert.equal(plan.continuity.valid, true, '控制平面副本上的事件连续');
        assert.equal(plan.continuity.events, 12);
        assert.equal(plan.files.valid, true, '恢复出来的文件与清单逐字节一致');
        assert.ok(plan.files.files >= 5);

        const choices = [];
        const actions = { 'device-token': 'rotate', 'push-subscription': 'unsubscribe', automation: 'reconfirm', 'access-credential': 'replace' };
        for (const item of hostBackup.pendingDispositions(gate)) {
          choices.push({ kind: item.kind, id: item.id, action: actions[item.kind] });
        }
        const partial = hostBackup.planExternalServiceRelease(gate, choices.slice(0, 1));
        assert.equal(partial.released, false, '处置不完整时不放开对外服务');
        assert.ok(partial.blockers.length >= 2);
        const released = hostBackup.releaseExternalServices(gate, choices);
        assert.equal(released.externalAutomation, 'enabled');
        assert.equal(released.notificationSending, 'enabled');
        hostBackup.writeRestoreGate(targetRoot, released);
        const reopened = await hostBackup.planStartupAfterRestore({
          restoredRoot: targetRoot,
          currentVersion: SOFTWARE_VERSION,
          supportedSchemaVersion: 1,
        });
        assert.equal(reopened.canServeExternally, true, '逐项处置后允许对外服务');
        assert.equal(reopened.blockers.length, 0);

        assert.equal(outboundRequests - before, 0, '演练全程没有向真实端点发出任何请求');
      });
    });
  } finally {
    await endpoint.stop();
  }
});

test('隔离恢复不覆盖现有根：未经确认拒绝切换，确认后旧根改名留档', async () => {
  const telemetry = createTelemetry();
  try {
    await withHome('sys03-switch-source', async (sourceHome) => {
      await withHome('sys03-switch-store', async (storeHome) => {
        const source = await seedSource(sourceHome);
        const backupRoot = join(storeHome, 'sets', 'set-1');
        await createSet(sourceHome, backupRoot, source.masterKeyPath, { telemetry });
        const targetRoot = join(storeHome, 'restored');
        await backup.restoreBackup({
          backupRoot,
          targetRoot,
          keyPath: source.masterKeyPath,
          currentSoftware: { version: SOFTWARE_VERSION, schemaVersion: 1 },
          telemetry,
        });

        const liveRoot = join(storeHome, 'live');
        mkdirSync(liveRoot, { recursive: true, mode: 0o700 });
        writeFileSync(join(liveRoot, 'current-marker.txt'), '现有数据根\n', { mode: 0o600 });
        const liveDigest = sha256Hex(readFileSync(join(liveRoot, 'current-marker.txt'), 'utf8'));

        const plan = backup.planRestoreSwitch({ restoredRoot: targetRoot, liveRoot });
        assert.equal(plan.requiresConfirmation, true);
        assert.equal(plan.canActivate, false);
        assert.deepEqual(plan.blockers, ['live-root-present']);

        await assert.rejects(
          backup.activateRestoredRoot({
            restoredRoot: targetRoot,
            liveRoot,
            confirmation: { confirmed: false },
            telemetry,
          }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.restoreSwitchNotConfirmed, '未确认时必须拒绝切换');
            return true;
          },
          '用户确认之前不得切换',
        );
        assert.equal(sha256Hex(readFileSync(join(liveRoot, 'current-marker.txt'), 'utf8')), liveDigest, '现有根保持不动');

        await assert.rejects(
          backup.activateRestoredRoot({
            restoredRoot: targetRoot,
            liveRoot,
            confirmation: { confirmed: true },
            telemetry,
          }),
          (error) => {
            assert.equal(error.code, backup.BACKUP_ERROR_CODES.restoreLiveRootPresent, '现有根未处置时必须拒绝切换');
            return true;
          },
          '不覆盖现有根',
        );
        assert.equal(sha256Hex(readFileSync(join(liveRoot, 'current-marker.txt'), 'utf8')), liveDigest, '拒绝之后现有根仍然不动');

        const activated = await backup.activateRestoredRoot({
          restoredRoot: targetRoot,
          liveRoot,
          confirmation: { confirmed: true, vacateLiveRoot: true },
          telemetry,
        });
        assert.ok(activated.previousRoot !== undefined, '旧根改名留档');
        assert.equal(existsSync(activated.previousRoot), true);
        assert.equal(readFileSync(join(activated.previousRoot, 'current-marker.txt'), 'utf8'), '现有数据根\n');
        assert.equal(existsSync(join(liveRoot, backup.RESTORE_GATE_FILENAME)), true, '正式根换成恢复出来的数据');
        assert.equal(existsSync(join(liveRoot, backup.RESTORE_SWITCH_FILENAME)), true, '正式根里留下切换记录');
        const marker = JSON.parse(readFileSync(join(liveRoot, backup.RESTORE_SWITCH_FILENAME), 'utf8'));
        assert.equal(marker.previousRoot, activated.previousRoot);
        assert.equal(marker.restoredFrom, targetRoot);
        assert.equal(existsSync(targetRoot), false, '恢复目录已经改名到正式位置');
      });
    });
  } finally {
    await telemetry.shutdown();
  }
});

test('保留策略：每日 7、每周 4、每月 12，过期备份被真实删除', async () => {
  const telemetry = createTelemetry();
  try {
    await withHome('sys03-retention', async (home) => {
      await withHome('sys03-retention-store', async (storeHome) => {
        const source = await seedSource(home);
        const setsRoot = join(storeHome, 'sets');
        const day = 86_400_000;
        const base = Date.parse('2026-09-01T03:00:00Z');
        const times = [base, base + 3_600_000, base + 7_200_000, base + 45 * day];
        for (const [index, now] of times.entries()) {
          await createSet(home, join(setsRoot, `set-${String(index + 1)}`), source.masterKeyPath, { telemetry, now });
        }
        const plan = backup.planRetention({ setsRoot, now: base + 60 * day });
        assert.equal(plan.keep.length, 2, '同一天只保留最新一套，最新一套始终保留');
        assert.equal(plan.prune.length, 2);
        assert.deepEqual(plan.prune.map((entry) => entry.name), ['set-1', 'set-2']);
        assert.equal(backup.BACKUP_RETENTION.daily, 7);
        assert.equal(backup.BACKUP_RETENTION.weekly, 4);
        assert.equal(backup.BACKUP_RETENTION.monthly, 12);
        assert.equal(backup.BACKUP_RETENTION.rpoHours, 24);
        assert.equal(backup.BACKUP_RETENTION.restoreTargetMinutes, 30);

        const pruned = await backup.pruneBackups({ setsRoot, now: base + 60 * day, telemetry });
        assert.equal(pruned.removed, 2);
        assert.ok(pruned.bytes > 0);
        assert.equal(existsSync(join(setsRoot, 'set-1')), false, '过期备份被真实删除');
        assert.equal(existsSync(join(setsRoot, 'set-2')), false);
        assert.equal(existsSync(join(setsRoot, 'set-3')), true);
        assert.equal(existsSync(join(setsRoot, 'set-4')), true);
      });
    });
  } finally {
    await telemetry.shutdown();
  }
});

test('遥测：备份与恢复的信号在包声明与源码里一致，宿主备份包不重复声明信号', () => {
  const manifest = JSON.parse(readFileSync(join(RUNTIME, 'gateway/package.json'), 'utf8'));
  const names = [
    ...manifest.chatdsh.telemetry.events,
    ...manifest.chatdsh.telemetry.spans,
    ...manifest.chatdsh.telemetry.metrics,
  ];
  const sources = readdirSync(join(RUNTIME, 'gateway/src/backup'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(RUNTIME, 'gateway/src/backup', name), 'utf8'))
    .join('\n');
  const backupNames = names.filter((name) => name.includes('backup') || name.includes('restore_duration'));
  assert.ok(backupNames.length >= 14, `备份与恢复的遥测信号至少十四条，实际 ${String(backupNames.length)}`);
  for (const name of backupNames) {
    assert.ok(sources.includes(name), `${name} 在源码里没有出现`);
  }
  const used = new Set([...(sources.match(/\bchatdsh\.[a-z0-9]+(?:\.[a-z0-9]+)+\b/g) ?? []), ...(sources.match(/\bchatdsh_[a-z0-9_]+\b/g) ?? [])]);
  for (const name of used) assert.ok(names.includes(name), `${name} 没有在 gateway/package.json 里声明`);

  const hostManifest = JSON.parse(readFileSync(join(RUNTIME, 'packages/host/backup/package.json'), 'utf8'));
  assert.equal(hostManifest.chatdsh, undefined, '宿主备份包不声明遥测面，信号统一由控制平面包登记');
  const hostSources = readdirSync(join(RUNTIME, 'packages/host/backup/src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(RUNTIME, 'packages/host/backup/src', name), 'utf8'))
    .join('\n');
  assert.equal(/\bchatdsh\.[a-z0-9]+\./u.test(hostSources), false);
  assert.equal(/\bchatdsh_[a-z0-9_]+/u.test(hostSources), false);
});
