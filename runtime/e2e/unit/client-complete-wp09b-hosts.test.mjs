// WP09-A2 宿主能力的验收测试：制品、连接器与技能。
//
// 每个测试在 runtime/.run 下分配独立数据根，挂载真实的存储枢纽、JSON 后端与存储域表单，
// 因此记录与内容都真实落盘；连接器与技能测试另外挂载真实的加载器、MCP 客户端、工具注册表
// 与技能提供方，工具目录的变化来自真实的协议握手与真实的目录扫描。
//
// 覆盖：制品版本列表与当前版本一致、历史版本不可改写、安全读取的内容类型与受限预览标记、
// 删除范围与占用空间、版本引用配对校验；连接器的条件表单校验、凭据只存环境变量名、
// 停用后工具从目录移除、工具测试权限、配置保存成功而同步失败的两种结果、重启恢复；
// 技能的启停持久化、来源检索、重名与超限拒绝、重启后恢复启用状态。
//
// 运行：node --test e2e/unit/client-complete-wp09b-hosts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const Storage = (await import('@deepseek-ai/dsh-storage')).default;
const jsonBackend = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
const { Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { SkillRegistry } = await import('@deepseek-ai/dsh-skill');
const skillFilesystem = await import('@deepseek-ai/dsh-skill-filesystem');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const artifacts = await import('../../packages/host/artifacts/lib/index.js');
const connectors = await import('../../packages/host/connectors/lib/index.js');
const skills = await import('../../packages/host/skills/lib/index.js');
const contracts = await import('../../packages/core/contracts/lib/index.js');

/** 验收用的真实 MCP 服务器：stdio 上响应 initialize 与 tools/list。 */
const MCP_PROBE = resolve(import.meta.dirname, '../fixtures/mcp-probe.mjs');

/** 不可达的 http 端点，连接被立刻拒绝，不会让同步等待超时。 */
const UNREACHABLE_URL = 'http://127.0.0.1:1/mcp';

/** 本次测试登记的清理动作，在释放数据根之前按逆序执行。 */
const pendingCleanups = [];

/**
 * 在独立数据根里运行一个测试。
 * @param {string} prefix - 数据根前缀。
 * @param {(paths: { home: string, storages: string, artifacts: string }) => Promise<void>} run - 测试主体。
 */
async function withHome(prefix, run) {
  const home = allocateIndependentHome(prefix);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await run({ home, storages: join(home, 'storages'), artifacts: join(home, 'artifacts') });
  } finally {
    for (const cleanup of pendingCleanups.splice(0).reverse()) await cleanup();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
}

/**
 * 挂载真实的存储枢纽、JSON 后端与存储域表单。
 * @param {string} home - 独立数据根。
 * @returns {Promise<object>} 上下文。
 */
async function openStorage(home) {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(jsonBackend, { root: join(home, 'storages') });
  await ctx.plugin(domainPlugin, { backend: 'json' });
  return ctx;
}

/**
 * 挂载制品服务。
 * @param {string} home - 独立数据根。
 * @returns {Promise<{ ctx: object, service: object }>} 上下文与服务。
 */
async function openArtifactHost(home) {
  const ctx = await openStorage(home);
  const service = new artifacts.ChatdshArtifactsService(ctx);
  await service[TypertRemoteService.init]();
  return { ctx, service };
}

/**
 * 挂载连接器服务：真实存储、真实系统提示、真实工具注册表与真实加载器。
 * @param {string} home - 独立数据根。
 * @returns {Promise<{ ctx: object, service: object }>} 上下文与服务。
 */
async function openConnectorHost(home) {
  const ctx = await openStorage(home);
  new SystemPrompt(ctx, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(Loader);
  const service = new connectors.ChatdshConnectorService(ctx, {});
  await service[TypertRemoteService.init]();
  // 停下来的连接器会留下加载器行与 MCP 子进程，测试结束前必须删干净；删除后等子进程
  // 读到自己 stdin 关闭并写完退场记录，再让调用方释放数据根。
  pendingCleanups.push(async () => {
    for (const record of service.list()) await service.remove(record.id);
    await new Promise((stop) => setTimeout(stop, 500));
  });
  return { ctx, service };
}

/**
 * 在数据根里写一份真实的技能目录。
 * @param {string} dir - 技能根目录。
 * @param {string} name - 技能名。
 * @param {string} description - 说明。
 */
function writeSkill(dir, name, description) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}的正文。\n`);
}

/**
 * 挂载技能服务：真实技能注册表、真实文件系统提供方与真实存储。
 * @param {string} home - 独立数据根。
 * @param {{ custom: string, bundled: string }} dirs - 技能根目录。
 * @returns {Promise<{ ctx: object, service: object }>} 上下文与服务。
 */
async function openSkillHost(home, dirs) {
  const ctx = await openStorage(home);
  await ctx.plugin(SkillRegistry);
  await ctx.plugin(skillFilesystem, {
    providerName: 'wp09b-filesystem',
    includeDefaultRoots: false,
    customSkillDirs: [dirs.custom],
    bundledSkillDir: dirs.bundled,
    watch: false,
    dshHome: home,
  });
  const service = new skills.ChatdshSkillsService(ctx);
  await service[TypertRemoteService.init]();
  return { ctx, service };
}

/**
 * 断言一个调用以指定错误码失败。
 * @param {() => Promise<unknown>} action - 待观察的调用。
 * @param {string} code - 期望的错误码。
 */
async function rejectsWithCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${String(error.code)}：${error.message}`);
    return true;
  });
}

/**
 * 断言一个同步调用以指定错误码抛出。
 * @param {() => unknown} action - 待观察的调用。
 * @param {string} code - 期望的错误码。
 */
function throwsWithCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${String(error.code)}：${error.message}`);
    return true;
  });
}

/**
 * 轮询直到条件成立。
 * @param {() => boolean} predicate - 条件。
 * @param {string} label - 超时说明。
 */
async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((stop) => setTimeout(stop, 100));
  }
  throw new Error(`等待超时：${label}`);
}

/** 读一份落盘的 JSON 记录文件。 */
function readStore(home, unit) {
  return JSON.parse(readFileSync(join(home, 'storages', `${unit}.json`), 'utf8'));
}

test('制品版本列表与当前版本一致，历史版本不可改写', async () => {
  await withHome('wp09b-artifact-version', async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const first = await service.put({
      sessionId: 'session-1',
      title: '说明',
      kind: 'markdown',
      mimeType: 'text/markdown',
      content: '# 第一版\n',
    });
    const second = await service.put({
      id: first.id,
      sessionId: 'session-1',
      title: '说明',
      mimeType: 'text/html',
      content: '<script>alert(1)</script><h1>第二版</h1>',
    });
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(second.createdAt, first.createdAt, '同一制品的建立时刻不随版本变化');

    const fileV1 = join(home, 'artifacts', first.id, 'v1');
    const fileV2 = join(home, 'artifacts', first.id, 'v2');
    assert.equal(readFileSync(fileV1, 'utf8'), '# 第一版\n');
    assert.equal(readFileSync(fileV2, 'utf8'), '<script>alert(1)</script><h1>第二版</h1>');

    const list = contracts.artifactVersionListSchema.parse(await service.versionList(first.id));
    assert.equal(list.currentVersion, 2);
    assert.deepEqual(list.versions.map((version) => version.version), [1, 2]);
    assert.deepEqual(list.versions.map((version) => version.mimeType), ['text/markdown', 'text/html']);
    for (const version of list.versions) {
      assert.equal(version.immutable, true);
      assert.equal(version.sourceSessionId, 'session-1');
      assert.equal(version.downloadable, true);
    }

    // 历史版本读取拿到的是当次写入的字节，写入第 2 版没有改动第 1 版。
    const readOld = await service.read(first.id, 1);
    assert.equal(Buffer.from(readOld.base64, 'base64').toString('utf8'), '# 第一版\n');
    assert.equal(readOld.version.version, 1);
    assert.equal(readOld.version.mimeType, 'text/markdown');
    assert.equal(readOld.record.version, 2, '制品记录仍指向当前版本');
    assert.equal(readFileSync(fileV1, 'utf8'), '# 第一版\n');

    const integrity = await service.verify(first.id);
    assert.deepEqual(integrity.versions, [1, 2]);
    assert.equal(integrity.currentVersion, 2);
    assert.deepEqual(integrity.missingFiles, []);
    assert.deepEqual(integrity.digestMismatches, []);
    assert.equal(integrity.declaredBytes, first.size + second.size);
    assert.equal(integrity.contentBytes, integrity.declaredBytes);
  });
});

test('安全读取返回内容类型与受限预览标记，HTML 与 SVG 不获得宿主访问权', async () => {
  await withHome('wp09b-artifact-safety', async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const cases = [
      { title: '纯文本', mimeType: 'text/plain', content: '正文', contentType: 'text/plain', mode: 'text' },
      { title: '标记文档', mimeType: 'text/markdown', content: '# 标题', contentType: 'text/markdown', mode: 'text' },
      { title: '页面', mimeType: 'text/html', content: '<html><script>fetch("/chatdsh")</script></html>', contentType: 'text/html', mode: 'html-sandbox' },
      { title: '矢量图', mimeType: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', contentType: 'image/svg+xml', mode: 'image' },
      { title: '位图', mimeType: 'image/png; charset=binary', content: 'iVBORw0KGgo=', contentType: 'image/png', mode: 'image' },
      { title: '文档', mimeType: 'application/pdf', content: '%PDF-1.7', contentType: 'application/pdf', mode: 'pdf' },
      { title: '压缩包', mimeType: 'application/zip', content: 'PK', contentType: 'application/zip', mode: 'download-only' },
    ];
    for (const item of cases) {
      const record = await service.put({
        sessionId: 'session-safety',
        title: item.title,
        mimeType: item.mimeType,
        content: item.content,
      });
      const read = await service.read(record.id);
      const preview = contracts.artifactPreviewSchema.parse(read.preview);
      assert.equal(read.contentType, item.contentType, `${item.title} 的内容类型`);
      assert.equal(preview.mode, item.mode, `${item.title} 的预览方式`);
      assert.equal(preview.scriptAllowed, false, `${item.title} 不允许执行脚本`);
      assert.equal(preview.hostBridgeAllowed, false, `${item.title} 不获得宿主访问权`);
      assert.equal(preview.formSubmitAllowed, false, `${item.title} 不允许表单提交`);
    }
  });
});

test('删除范围列出全部版本与占用空间，删除后内容文件与记录一并消失', async () => {
  await withHome('wp09b-artifact-delete', async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const first = await service.put({ sessionId: 'session-2', title: '报告', mimeType: 'text/markdown', content: '一' });
    const second = await service.put({ id: first.id, sessionId: 'session-2', title: '报告', mimeType: 'text/markdown', content: '二二' });

    const scope = contracts.artifactDeleteScopeSchema.parse(await service.deleteScope(first.id));
    assert.equal(scope.artifactId, first.id);
    assert.equal(scope.allVersions, true);
    assert.deepEqual(scope.versions, [1, 2]);
    assert.deepEqual(scope.affectedVersions, [1, 2]);
    assert.equal(scope.totalBytes, first.size + second.size);
    assert.equal(scope.requiresConfirm, true);
    assert.ok(existsSync(join(home, 'artifacts', first.id, 'v1')), '删除范围只计算，不删除');

    assert.equal(await service.remove(first.id), true);
    assert.equal(existsSync(join(home, 'artifacts', first.id)), false);
    assert.deepEqual(service.list(), []);
    await rejectsWithCode(async () => service.versionList(first.id), contracts.CHATDSH_ERROR_CODES.objectNotFound);
    await rejectsWithCode(async () => service.read(first.id), contracts.CHATDSH_ERROR_CODES.objectNotFound);
    assert.equal(await service.remove(first.id), false, '重复删除不报错也不生效');
  });
});

test('版本引用按制品标识与版本号配对校验', async () => {
  await withHome('wp09b-artifact-ref', async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const record = await service.put({ sessionId: 'session-3', title: '脚本', mimeType: 'text/x-python', content: 'print(1)' });
    const other = await service.put({ sessionId: 'session-3', title: '别的', mimeType: 'text/markdown', content: '# 别的' });

    contracts.artifactVersionRefSchema.parse({ artifactId: record.id, version: 1 });
    const view = await service.resolveRef({ artifactId: record.id, version: 1 });
    assert.equal(view.artifactId, record.id);
    assert.equal(view.version, 1);
    assert.equal(view.immutable, true);

    await rejectsWithCode(
      async () => service.resolveRef({ artifactId: record.id, version: 9 }),
      contracts.CHATDSH_ERROR_CODES.artifactVersionUnknown,
    );
    await rejectsWithCode(
      async () => service.resolveRef({ artifactId: other.id, version: 2 }),
      contracts.CHATDSH_ERROR_CODES.artifactVersionUnknown,
    );
    await rejectsWithCode(
      async () => service.resolveRef({ artifactId: 'missing-artifact', version: 1 }),
      contracts.CHATDSH_ERROR_CODES.objectNotFound,
    );
    await rejectsWithCode(
      async () => service.resolveRef({ artifactId: record.id, version: 0 }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => service.resolveRef({ artifactId: '', version: 1 }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
  });
});

test('存储里当前版本与版本记录不一致时拒绝读取，并且不覆盖已有版本', async () => {
  await withHome('wp09b-artifact-divergence', async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const record = await service.put({ sessionId: 'session-4', title: '日志', mimeType: 'text/plain', content: '第一版' });
    await service.put({ id: record.id, sessionId: 'session-4', title: '日志', mimeType: 'text/plain', content: '第二版' });

    // 破坏当前版本号，模拟记录与版本表不同步的落盘状态。
    const storePath = join(home, 'storages', 'artifacts_store.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.tables.artifacts[record.id].version = 1;
    writeFileSync(storePath, JSON.stringify(store, null, 2));

    const restarted = await openArtifactHost(home);
    await rejectsWithCode(
      async () => restarted.service.versionList(record.id),
      contracts.CHATDSH_ERROR_CODES.artifactVersionUnknown,
    );
    // 追加写入会算出第 2 版，而第 2 版已经有记录与内容文件，必须拒绝覆盖。
    await rejectsWithCode(
      async () => restarted.service.put({
        id: record.id,
        sessionId: 'session-4',
        title: '日志',
        mimeType: 'text/plain',
        content: '试图覆盖',
      }),
      contracts.CHATDSH_ERROR_CODES.artifactVersionImmutable,
    );
    assert.equal(readFileSync(join(home, 'artifacts', record.id, 'v2'), 'utf8'), '第二版');
  });
});

test('制品在重启后保留全部版本与内容字节', async () => {
  await withHome('wp09b-artifact-restart', async ({ home }) => {
    const first = await openArtifactHost(home);
    const record = await first.service.put({ sessionId: 'session-5', title: '手册', mimeType: 'text/markdown', content: '# 一' });
    await first.service.put({ id: record.id, sessionId: 'session-5', title: '手册', mimeType: 'text/markdown', content: '# 二' });

    const restarted = await openArtifactHost(home);
    const list = await restarted.service.versionList(record.id);
    assert.equal(list.currentVersion, 2);
    assert.deepEqual(list.versions.map((version) => version.version), [1, 2]);
    const read = await restarted.service.read(record.id, 1);
    assert.equal(Buffer.from(read.base64, 'base64').toString('utf8'), '# 一');
  });
});

test('连接器条件表单按传输方式校验，名称在记录之间唯一', async () => {
  await withHome('wp09b-connector-validation', async ({ home }) => {
    const { service } = await openConnectorHost(home);
    const stdio = await service.save({ name: 'notes', transport: 'stdio', command: 'notes-mcp', args: ['--dir', '/srv/notes'] });
    assert.equal(stdio.transport, 'stdio');
    assert.deepEqual(stdio.args, ['--dir', '/srv/notes']);
    const http = await service.save({ name: 'search', transport: 'http', url: UNREACHABLE_URL });
    assert.equal(http.transport, 'http');
    assert.equal(http.url, UNREACHABLE_URL);

    await rejectsWithCode(
      async () => service.save({ name: '没有命令', transport: 'stdio' }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => service.save({ name: 'stdio 带地址', transport: 'stdio', command: 'x', url: 'https://example.test/mcp' }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => service.save({ name: '没有地址', transport: 'http' }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => service.save({ name: 'http 带命令', transport: 'http', url: UNREACHABLE_URL, command: 'x' }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => service.save({ name: '协议不支持', transport: 'http', url: 'ftp://example.test/mcp' }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => service.save({ name: '参数非字符串', transport: 'stdio', command: 'x', args: ['ok', 3] }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => service.save({ name: 'notes', transport: 'stdio', command: 'other-mcp' }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => service.save({ name: '凭据写成值', transport: 'stdio', command: 'x', credentialEnv: 'token=abc' }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => service.save({ name: '未知传输', transport: 'sse' }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );

    assert.deepEqual(service.list().map((record) => record.name), ['notes', 'search']);
    assert.deepEqual(service.get(stdio.id), stdio);
    assert.equal(await service.remove(stdio.id), true);
    await rejectsWithCode(async () => service.get(stdio.id), contracts.CHATDSH_ERROR_CODES.objectNotFound);
    await rejectsWithCode(
      async () => service.save({ id: 'missing-connector', name: 'x', transport: 'stdio', command: 'x' }),
      contracts.CHATDSH_ERROR_CODES.objectNotFound,
    );
  });
});

test('凭据只保存环境变量名，值不进入记录也不进入对外读出', async () => {
  await withHome('wp09b-connector-credential', async ({ home }) => {
    const previous = process.env.CHATDSH_TEST_TOKEN;
    process.env.CHATDSH_TEST_TOKEN = 'super-secret-value';
    try {
      const { ctx, service } = await openConnectorHost(home);
      const record = await service.save({
        name: 'remote-api',
        transport: 'http',
        url: UNREACHABLE_URL,
        credentialEnv: 'CHATDSH_TEST_TOKEN',
      });
      assert.equal(record.credentialEnv, 'CHATDSH_TEST_TOKEN');

      const storeText = readFileSync(join(home, 'storages', 'connectors_store.json'), 'utf8');
      assert.ok(storeText.includes('CHATDSH_TEST_TOKEN'), '记录里保存变量名');
      assert.equal(storeText.includes('super-secret-value'), false, '记录里不出现凭据值');

      const rowsText = JSON.stringify(service.mcpRows());
      assert.ok(rowsText.includes('CHATDSH_TEST_TOKEN'), '对外读出的行配置只带变量名');
      assert.equal(rowsText.includes('super-secret-value'), false, '对外读出里不出现凭据值');

      // 装配行时才从本机环境取值：加载器行里有值，记录与 Remote 读出里没有。
      const entry = [...ctx.loader.entries()].find(
        (item) => String(item.options.id) === connectors.rowIdOf('remote-api'),
      );
      assert.ok(entry !== undefined, '同步后应存在加载器行');
      assert.equal(entry.options.config.headers.Authorization, `Bearer super-secret-value`);
    } finally {
      if (previous === undefined) delete process.env.CHATDSH_TEST_TOKEN;
      else process.env.CHATDSH_TEST_TOKEN = previous;
    }
  });
});

test('连接器接入后工具进入目录，停用后从目录移除，工具测试按启用状态判权', async () => {
  await withHome('wp09b-connector-tools', async ({ home }) => {
    const probeLog = join(home, 'mcp-probe.log');
    const previousLog = process.env.MCP_PROBE_LOG;
    process.env.MCP_PROBE_LOG = probeLog;
    try {
      const { ctx, service } = await openConnectorHost(home);
      const record = await service.save({
        name: 'probe-server',
        transport: 'stdio',
        command: process.execPath,
        args: [MCP_PROBE],
        credentialEnv: 'MCP_PROBE_LOG',
      });
      assert.equal(service.state(record.id).sync.status, 'ok');
      assert.deepEqual(service.state(record.id).rows, [connectors.rowIdOf('probe-server')]);

      const toolName = 'mcp__probe-server__probe-tool';
      await waitFor(
        () => (service.mcpTools()['probe-server'] ?? []).includes(toolName),
        'MCP 客户端完成握手并注册工具',
      );
      assert.deepEqual(service.state(record.id).tools, [toolName]);
      assert.equal(existsSync(probeLog), true, '子进程通过注入的环境变量写了探针日志');

      const called = await service.callMcpTool(toolName, {});
      assert.equal(called.isError, false);
      await rejectsWithCode(
        async () => service.callMcpTool('plain-tool', {}),
        contracts.CHATDSH_ERROR_CODES.requestInvalid,
      );
      await rejectsWithCode(
        async () => service.callMcpTool(toolName, []),
        contracts.CHATDSH_ERROR_CODES.requestInvalid,
      );

      await service.setEnabled(record.id, false);
      await waitFor(() => (service.mcpTools()['probe-server'] ?? []).length === 0, '停用后工具从目录消失');
      const disabled = service.state(record.id);
      assert.equal(disabled.enabled, false);
      assert.deepEqual(disabled.rows, []);
      assert.deepEqual(disabled.tools, []);
      assert.equal(disabled.sync.status, 'ok');
      await rejectsWithCode(
        async () => service.callMcpTool(toolName, {}),
        contracts.CHATDSH_ERROR_CODES.permissionDenied,
      );
      assert.equal([...ctx.loader.entries()].some((item) => String(item.options.id) === connectors.rowIdOf('probe-server')), false);

      // 重新启用后工具回到目录。
      await service.setEnabled(record.id, true);
      await waitFor(
        () => (service.mcpTools()['probe-server'] ?? []).includes(toolName),
        '重新启用后工具回到目录',
      );
    } finally {
      if (previousLog === undefined) delete process.env.MCP_PROBE_LOG;
      else process.env.MCP_PROBE_LOG = previousLog;
    }
  });
});

test('配置保存成功而同步失败时保留双重状态，修复后可以重新同步', async () => {
  await withHome('wp09b-connector-sync-failure', async ({ home }) => {
    const previous = process.env.CHATDSH_ABSENT_TOKEN;
    delete process.env.CHATDSH_ABSENT_TOKEN;
    try {
      const { service } = await openConnectorHost(home);
      const missing = await service.save({
        name: 'remote-api',
        transport: 'http',
        url: UNREACHABLE_URL,
        credentialEnv: 'CHATDSH_ABSENT_TOKEN',
      });
      // 配置已经落盘。
      assert.deepEqual(service.get(missing.id), missing);
      assert.deepEqual(service.list().map((record) => record.id), [missing.id]);
      // 同步失败单独记录，两者同时可查。
      const failed = service.state(missing.id);
      assert.equal(failed.sync.status, 'failed');
      assert.equal(failed.sync.errorCode, contracts.CHATDSH_ERROR_CODES.connectorCredentialMissing);
      assert.equal(failed.sync.errorType, 'ChatdshError');
      assert.deepEqual(failed.rows, []);
      assert.equal(failed.configSaved, true);

      // 状态落盘：重启后仍然是「已保存、同步失败」。
      const restarted = await openConnectorHost(home);
      const afterRestart = restarted.service.state(missing.id);
      assert.equal(afterRestart.configSaved, true);
      assert.equal(afterRestart.sync.status, 'failed');
      assert.equal(afterRestart.sync.errorCode, contracts.CHATDSH_ERROR_CODES.connectorCredentialMissing);

      // 补上环境变量后重新同步成功。
      process.env.CHATDSH_ABSENT_TOKEN = 'restored-value';
      const plan = await restarted.service.syncMcpRows();
      assert.equal(plan.create.length, 1);
      const fixed = restarted.service.state(missing.id);
      assert.equal(fixed.sync.status, 'ok');
      assert.deepEqual(fixed.rows, [connectors.rowIdOf('remote-api')]);
    } finally {
      if (previous === undefined) delete process.env.CHATDSH_ABSENT_TOKEN;
      else process.env.CHATDSH_ABSENT_TOKEN = previous;
    }
  });
});

test('名称规范化后冲突时拒绝同步，配置仍然保留', async () => {
  await withHome('wp09b-connector-conflict', async ({ home }) => {
    const { service } = await openConnectorHost(home);
    const left = await service.save({ name: 'my notes', transport: 'stdio', command: 'notes-mcp' });
    const right = await service.save({ name: 'my-notes', transport: 'stdio', command: 'other-mcp' });
    assert.deepEqual(service.list().map((record) => record.id).sort(), [left.id, right.id].sort());

    await rejectsWithCode(() => service.syncMcpRows(), contracts.CHATDSH_ERROR_CODES.requestInvalid);
    assert.equal(service.state(left.id).sync.status, 'failed');
    assert.equal(service.state(right.id).sync.status, 'failed');
    assert.equal(service.state(left.id).configSaved, true);

    // 改名后冲突消失，同步恢复。
    await service.save({ id: right.id, name: 'other-notes', transport: 'stdio', command: 'other-mcp' });
    const plan = await service.syncMcpRows();
    assert.equal(plan.conflicts.length, 0);
    assert.equal(service.state(left.id).sync.status, 'ok');
    assert.equal(service.state(right.id).sync.status, 'ok');
  });
});

test('技能目录按真实扫描结果建立，来源检索与启停计数一致', async () => {
  await withHome('wp09b-skills-catalog', async ({ home }) => {
    const custom = join(home, 'custom-skills');
    const bundled = join(home, 'bundled-skills');
    writeSkill(custom, 'alpha', '甲技能用于写测试');
    writeSkill(custom, 'beta', '乙技能用于查日志');
    writeSkill(bundled, 'gamma', '内置的排序规则');

    const { service } = await openSkillHost(home, { custom, bundled });
    const entries = service.list();
    assert.deepEqual(entries.map((entry) => entry.id).sort(), ['alpha', 'beta', 'gamma']);
    assert.equal(entries.find((entry) => entry.id === 'alpha').source, 'user');
    assert.equal(entries.find((entry) => entry.id === 'gamma').source, 'builtin');
    assert.deepEqual(service.catalogState(), { total: 3, enabled: 3 });

    assert.deepEqual((await service.search({ source: 'builtin' })).map((entry) => entry.id), ['gamma']);
    assert.deepEqual((await service.search({ text: '写测试' })).map((entry) => entry.id), ['alpha']);
    assert.deepEqual((await service.search({ text: 'ALPHA' })).map((entry) => entry.id), ['alpha']);
    assert.deepEqual(await service.search({ text: '没有这个词' }), []);

    const toggled = await service.toggle('beta', false);
    assert.deepEqual(toggled, { id: 'beta', enabled: false });
    assert.deepEqual(service.catalogState(), { total: 3, enabled: 2 });
    assert.equal(service.list().find((entry) => entry.id === 'beta').enabled, false);
    assert.deepEqual((await service.search({ text: '乙技能' })).map((entry) => entry.enabled), [false]);
    assert.deepEqual(service.overrideList(), [{ id: 'beta', enabled: false }]);
    assert.equal(readStore(home, 'skills_store').tables.overrides.beta.enabled, false);

    await service.toggle('beta', true);
    assert.deepEqual(service.catalogState(), { total: 3, enabled: 3 });
    await service.toggle('beta', false);
  });
});

test('技能启用状态在重启后恢复，未知标识与超限检索被拒绝', async () => {
  await withHome('wp09b-skills-restart', async ({ home }) => {
    const custom = join(home, 'custom-skills');
    const bundled = join(home, 'bundled-skills');
    writeSkill(custom, 'alpha', '甲技能');
    writeSkill(bundled, 'gamma', '内置技能');

    const first = await openSkillHost(home, { custom, bundled });
    await first.service.toggle('alpha', false);
    assert.deepEqual(first.service.catalogState(), { total: 2, enabled: 1 });

    const restarted = await openSkillHost(home, { custom, bundled });
    assert.deepEqual(restarted.service.catalogState(), { total: 2, enabled: 1 });
    assert.equal(restarted.service.list().find((entry) => entry.id === 'alpha').enabled, false);
    assert.equal(restarted.service.list().find((entry) => entry.id === 'gamma').enabled, true);

    await rejectsWithCode(
      async () => restarted.service.toggle('missing-skill', false),
      contracts.CHATDSH_ERROR_CODES.objectNotFound,
    );
    await rejectsWithCode(
      async () => restarted.service.toggle('alpha', 'false'),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => restarted.service.search({ text: 'x'.repeat(skills.SKILL_QUERY_LIMIT + 1) }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    await rejectsWithCode(
      async () => restarted.service.search({ source: 'project' }),
      contracts.CHATDSH_ERROR_CODES.requestInvalid,
    );
    // 停用的技能仍然可以被检索出来，只是带着停用状态。
    assert.equal((await restarted.service.search({ text: '甲技能' }))[0].enabled, false);
  });
});

test('技能目录拒绝重名与超出条数上限', async () => {
  const seed = { name: 'alpha', description: '甲', source: 'user' };
  throwsWithCode(
    () => skills.createSkillCatalog([seed, { ...seed }]),
    contracts.CHATDSH_ERROR_CODES.requestInvalid,
  );
  const many = Array.from({ length: skills.SKILL_LIMIT + 1 }, (_item, index) => ({
    id: `skill-${index}`,
    name: `skill-${index}`,
    description: '批量',
    source: 'user',
  }));
  throwsWithCode(() => skills.createSkillCatalog(many), contracts.CHATDSH_ERROR_CODES.requestInvalid);
  const limit = skills.createSkillCatalog(many.slice(0, skills.SKILL_LIMIT));
  assert.equal(limit.catalog().total, skills.SKILL_LIMIT);
});
