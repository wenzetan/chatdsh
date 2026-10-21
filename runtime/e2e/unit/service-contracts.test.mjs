// 宿主服务契约的回归测试。
//
// 这些服务把依赖写在 `Service.inject` 静态字段里：加载器只认这个字段，写成模块级
// `export const inject` 时实例拿不到 ctx 上的服务，运行时才抛错。测试断言每个服务的
// 静态依赖清单，并用真实 Cordis 上下文构造模型提供方服务，验证 Remote 方法可读。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { ChatdshMemoryService } = await import('../../packages/host/memory/lib/index.js');
const { ChatdshHermesChatService } = await import('../../packages/host/chat-hermes/lib/index.js');
const { ChatdshModelProviderService } = await import('../../packages/host/model-provider/lib/index.js');
const { ChatdshContextInsightsService } = await import('../../packages/host/context-insights/lib/index.js');
const { ChatdshSkillsService } = await import('../../packages/host/skills/lib/index.js');

test('服务把依赖声明在静态字段上', () => {
  assert.ok(ChatdshMemoryService.inject.includes('systemPrompt'));
  assert.ok(ChatdshMemoryService.inject.includes('sessionPersistence'));
  assert.ok(ChatdshHermesChatService.inject.includes('sessions'));
  assert.ok(ChatdshHermesChatService.inject.includes('sessionPersistence'));
  assert.ok(ChatdshModelProviderService.inject.includes('llm'));
  assert.ok(ChatdshContextInsightsService.inject.includes('sessionProjections'));
  assert.ok(ChatdshContextInsightsService.inject.includes('sessions'));
  assert.ok(ChatdshSkillsService.inject.includes('skills'));
});

test('模型提供方服务在真实上下文里列出注册信息', () => {
  const ctx = new Context();
  const service = new ChatdshModelProviderService(ctx, {
    providers: [
      { provider: 'gateway', baseUrl: 'http://127.0.0.1:20128/v1' },
      { provider: 'openclaw', displayName: 'OpenClaw', baseUrl: 'https://example.invalid/v1' },
    ],
  });
  assert.deepEqual(service.list().map((item) => item.provider), ['gateway', 'openclaw']);
  assert.deepEqual(service.status(), { available: true, providers: 2 });
});

test('模型提供方服务对非法配置就地抛出', () => {
  const ctx = new Context();
  assert.throws(
    () => new ChatdshModelProviderService(ctx, { providers: [{ provider: 'Bad', baseUrl: 'http://x/v1' }] }),
    (error) => error.code === 'model-provider/invalid',
  );
});
