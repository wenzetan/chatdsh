/**
 * 平台能力的真实加载探测。
 *
 * 每项能力都是一次真实的加载动作：模块用动态 `import` 加载，文件真的读一次，全局对象真的
 * 检查一次。加载结果是运行环境给出的事实，声明按它给出，缺什么就报什么，不预先写死。
 * @module @chatdsh/core-deployment/capabilities
 */

import { readFile } from 'node:fs/promises';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import type { PlatformCapability } from './bundles.ts';

/** 一项平台能力的探测。 */
export interface CapabilityProbe {
  /** 能力标识。 */
  readonly id: string;
  /** 执行真实加载并给出结果。 */
  load(): Promise<PlatformCapability>;
}

/** 读取错误里的原因码；读不到时给固定值。 */
function codeOf(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') {
      return code === 'ERR_MODULE_NOT_FOUND' ? 'module-not-found' : code === 'ENOENT' ? 'file-not-found' : fallback;
    }
  }
  return fallback;
}

/**
 * 模块加载探测。
 * @param id - 能力标识。
 * @param specifier - 模块标识或绝对路径。
 * @returns 探测。
 */
export function moduleProbe(id: string, specifier: string): CapabilityProbe {
  return {
    id,
    async load() {
      try {
        await import(specifier);
        return { id, status: 'available' };
      } catch (error) {
        return { id, status: 'missing', code: codeOf(error, 'module-load-failed') };
      }
    },
  };
}

/**
 * 文件读取探测。
 * @param id - 能力标识。
 * @param path - 文件绝对路径。
 * @returns 探测。
 */
export function fileProbe(id: string, path: string): CapabilityProbe {
  return {
    id,
    async load() {
      try {
        await readFile(path);
        return { id, status: 'available' };
      } catch (error) {
        return { id, status: 'missing', code: codeOf(error, 'file-unreadable') };
      }
    },
  };
}

/**
 * 全局对象探测。
 * @param id - 能力标识。
 * @param name - 全局对象上的名字。
 * @returns 探测。
 */
export function globalProbe(id: string, name: string): CapabilityProbe {
  return {
    id,
    async load() {
      const value = (globalThis as unknown as Record<string, unknown>)[name];
      if (value === undefined) return { id, status: 'missing', code: 'global-absent' };
      return { id, status: 'available' };
    },
  };
}

/**
 * 逐个执行探测，结果同时写进遥测。
 * @param probes - 探测清单。
 * @param telemetry - 遥测客户端。
 * @returns 每一项能力的加载结果。
 */
export async function probeCapabilities(
  probes: readonly CapabilityProbe[],
  telemetry: ChatdshTelemetry
): Promise<PlatformCapability[]> {
  const results: PlatformCapability[] = [];
  for (const probe of probes) {
    const result = await telemetry.runSpan(
      'chatdsh.gateway.deploy.capability',
      { module: probe.id, outcome: 'checking' },
      async (span) => {
        const loaded = await probe.load();
        span.setAttribute('status', loaded.status);
        span.setAttribute('outcome', loaded.status === 'available' ? 'ok' : 'missing');
        telemetry
          .counter('chatdsh_gateway_deploy_capabilities_total', { description: '平台能力加载结果' })
          .add(1, {
            module: probe.id,
            status: loaded.status,
            outcome: loaded.status === 'available' ? 'ok' : 'missing',
          });
        if (loaded.status === 'missing') {
          telemetry.event('chatdsh.gateway.deploy.capability.failed', {
            module: probe.id,
            status: loaded.status,
            outcome: 'missing',
            'error.type': 'capability',
            'error.code': loaded.code ?? 'capability-missing',
          });
        }
        return loaded;
      }
    );
    results.push(result);
  }
  return results;
}
