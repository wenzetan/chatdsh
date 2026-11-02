// WP14 录音与转写的验收。
//
// 宿主侧装配真实的结构化存储与真实录音服务，音频写进独立数据根的真实文件系统。当前部署
// 没有装载语音识别接口，能力探测与转写请求都按这个事实返回未满足条件，录音本身仍可保存、
// 读取与删除；录音元数据与转写文本分表存放，转写文本文件只在转写成功后出现。客户端录音
// 状态机覆盖权限拒绝、录制、暂停、停止、上传失败重试、取消释放与按钮可访问名称。
//
// 运行：node --test e2e/unit/client-complete-wp14-voice.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));
ensureBuilt();

const { Context } = await import('@deepseek-ai/cordis');
const { default: Storage } = await import('@deepseek-ai/dsh-storage');
const json = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const { ChatdshVoiceService } = await import('../../packages/host/voice/lib/index.js');
const { RECORDING_STATES, VoiceRecorder, durationText } = await import('../../packages/client/workspace-tools/lib/voice.js');

/** 一段真实 WAV：44 字节文件头与 800 个采样。 */
function wavBytes() {
  const samples = 800;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0, 'ascii');
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write('WAVE', 8, 'ascii');
  data.write('fmt ', 12, 'ascii');
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24);
  data.writeUInt32LE(32_000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36, 'ascii');
  data.writeUInt32LE(samples * 2, 40);
  return data;
}

/** 构建本工作包的 TypeScript 产物，多个测试文件同时运行时串行。 */
function ensureBuilt() {
  const packages = ['packages/host/attachments', 'packages/host/voice', 'packages/client/workspace-tools'];
  const ready = () => packages.every((path) => existsSync(join(RUNTIME, path, 'lib/index.js')));
  if (ready()) return;
  const lock = join(RUNTIME, '.verify', 'wp14-build.lock');
  mkdirSync(join(RUNTIME, '.verify'), { recursive: true });
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (ready()) return;
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 300_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error('等待构建锁超时');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
  try {
    execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', '--force', ...packages.map((path) => join(RUNTIME, path, 'tsconfig.json'))], {
      cwd: RUNTIME,
      stdio: 'inherit',
    });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** 在数据根上装配真实录音服务。 */
async function openVoice(root) {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(json, { root: join(root, 'storages') });
  await ctx.plugin(domainPlugin, { backend: 'json' });
  const voice = new ChatdshVoiceService(ctx);
  await voice[TypertRemoteService.init]();
  return { ctx, voice };
}

/** 收集某个存储域下所有 JSON 文件名。 */
function storageFiles(root) {
  const dir = join(root, 'storages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter((path) => path.endsWith('.json'));
}

test('宿主保存录音，元数据与转写文本分开，转写报告未满足条件', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp14-voice');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'runtime');
  mkdirSync(root, { recursive: true });
  process.env.DSH_HOME = root;
  try {
    const { voice } = await openVoice(root);
    const capability = voice.capability();
    assert.equal(capability.available, false, '当前部署没有装载转写接口');
    assert.match(capability.reason, /speech-to-text/u);
    assert.match(capability.reason, /未启用/u);
    assert.ok(capability.acceptedTypes.includes('audio/wav'));

    const audio = wavBytes();
    const record = await voice.put({
      sessionId: 'session-wp14',
      mimeType: 'audio/wav',
      durationMs: 5000,
      content: audio,
    });
    assert.equal(record.transcriptionState, 'none');
    assert.equal(record.size, audio.byteLength);
    const audioPath = join(root, 'voice', record.id, 'audio.wav');
    assert.equal(existsSync(audioPath), true, '音频写在真实文件系统');
    assert.deepEqual(readFileSync(audioPath), audio);

    const transcriptPath = join(root, 'voice', record.id, 'transcript.txt');
    assert.equal(existsSync(transcriptPath), false, '没有转写成功时不产生转写文本文件');

    const failure = await voice.transcribe(record.id).then(() => undefined, (error) => error);
    assert.equal(failure.code, 'voice-transcription-unavailable');
    assert.match(failure.message, /未启用/u);

    const missing = (() => {
      try {
        voice.transcript(record.id);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    assert.equal(missing.code, 'voice-transcript-missing');

    const storedNames = storageFiles(root).join(' ');
    assert.match(storedNames, /voice_store/u, '录音元数据落在 voice_store 存储域');

    const tooLarge = await voice.put({
      sessionId: 'session-wp14',
      mimeType: 'audio/wav',
      durationMs: 5000,
      content: Buffer.alloc(24 * 1024 * 1024 + 1),
    }).then(() => undefined, (error) => error);
    assert.equal(tooLarge.code, 'recording-too-large');
    assert.match(tooLarge.message, new RegExp(String(24 * 1024 * 1024)));

    const badType = await voice.put({
      sessionId: 'session-wp14',
      mimeType: 'video/mp4',
      durationMs: 1000,
      content: audio,
    }).then(() => undefined, (error) => error);
    assert.equal(badType.code, 'recording-type-rejected');

    const rebuilt = await openVoice(root);
    assert.equal(rebuilt.voice.get(record.id).durationMs, 5000);
    assert.equal(rebuilt.voice.capability().available, false);

    assert.equal(await voice.remove(record.id), true);
    assert.equal(existsSync(join(root, 'voice', record.id)), false, '删除后音频目录消失');
    assert.equal(voice.list('session-wp14').length, 0);
    assert.equal(await voice.remove(record.id), false);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});

test('录音状态机覆盖权限拒绝、暂停、上传重试、取消与可访问名称', { timeout: 60_000 }, async () => {
  const recorder = new VoiceRecorder({
    available: false,
    reason: '当前部署没有装载语音识别接口（`dsh-experimental-api-speech-to-text` 行未启用），录音可以保存，转写不可用',
    maxAudioBytes: 24 * 1024 * 1024,
    maxDurationMs: 300_000,
    acceptedTypes: ['audio/webm'],
  });
  assert.deepEqual(RECORDING_STATES.slice(0, 3), ['idle', 'permission-pending', 'denied']);
  assert.equal(recorder.state, 'idle');
  assert.match(recorder.purpose, /语音识别接口/u);
  assert.equal(recorder.primaryAction().label, '开始录音');
  assert.equal(recorder.ariaLabel, '录音：开始录音');

  recorder.requestPermission();
  assert.equal(recorder.state, 'permission-pending');
  recorder.permissionDenied('用户拒绝了麦克风权限');
  assert.equal(recorder.state, 'denied');
  assert.match(recorder.deniedReason, /拒绝/u);
  assert.equal(recorder.primaryAction().label, '重新请求麦克风权限');

  recorder.requestPermission();
  recorder.permissionGranted();
  assert.equal(recorder.state, 'recording');
  recorder.tick(1500);
  recorder.tick(500);
  assert.equal(recorder.duration, '00:02');
  assert.equal(durationText(62_000), '01:02');
  recorder.pause();
  recorder.tick(1000);
  assert.equal(recorder.durationMs, 2000, '暂停期间不计时');
  recorder.resume();
  recorder.stop();
  assert.equal(recorder.state, 'stopped');
  assert.equal(recorder.primaryAction().label, '上传录音');

  recorder.uploadBegin();
  recorder.uploadFailed('运行时不可达');
  assert.equal(recorder.state, 'failed');
  assert.equal(recorder.primaryAction().label, '重试上传');
  recorder.uploadBegin();
  recorder.uploadComplete({
    id: 'recording-1',
    sessionId: 'session-wp14',
    mimeType: 'audio/webm',
    size: 4096,
    durationMs: 2000,
    digest: 'digest',
    createdAt: 1_700_000_000_000,
    transcriptionState: 'none',
  });
  assert.equal(recorder.state, 'stopped');

  const transcription = recorder.beginTranscription();
  assert.equal(transcription.available, false);
  assert.match(transcription.reason, /未启用/u);
  assert.equal(recorder.state, 'transcription-unavailable');
  assert.match(recorder.transcriptionReason, /转写不可用/u);

  recorder.cancel();
  assert.equal(recorder.state, 'cancelled');
  assert.equal(recorder.resourcesReleased, true, '取消释放录音资源');
  assert.equal(recorder.duration, '00:00');
  assert.throws(() => recorder.transcriptionComplete('不该走到这里'), /没有正在进行的转写/);
});
