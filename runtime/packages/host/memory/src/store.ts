/**
 * 记忆配置的持久存储。
 *
 * 记忆组映射、最近成功失败时刻与未确认写入记录都落在数据根下，每个名字一个 JSON 文件。
 * 写入先写同目录临时文件再原子替换；同一文件的读写在进程内串行。数据目录按 0700 建立，
 * 数据文件按 0600 写入。读取时用调用方给出的 schema 校验内容，内容不合形状就在原地失败。
 * 这里保存配置与待处理记录本身，不保存召回结果。
 * @module @chatdsh/host-memory/store
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ZodType } from 'zod';

/** 存储文件名的写法：小写字母、数字与连字符。 */
const NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/** 数据目录权限。 */
const DIRECTORY_MODE = 0o700;

/** 数据文件权限。 */
const FILE_MODE = 0o600;

/** 数据根：`DSH_HOME` 下的 `memory` 目录。 */
export function memoryDataRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory');
}

/** 一次读改写的结果。 */
export interface Mutation<T, R> {
  /** 需要写回的新值；缺省表示本次不写入。 */
  readonly value?: T;
  /** 返回给调用方的结果。 */
  readonly result: R;
}

/**
 * 记忆配置的持久存储。一个数据根只由本运行时的进程写入。
 */
export class MemoryStore {
  readonly #root: string;
  /** 每个文件一条任务链，保证同一文件的读改写不交叉。 */
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(root: string = memoryDataRoot()) {
    this.#root = root;
  }

  /** 存储根目录。 */
  get root(): string {
    return this.#root;
  }

  /**
   * 读取一个文件。
   * @param name - 文件名。
   * @param schema - 内容的 schema 校验器。
   * @param fallback - 文件不存在时的缺省值。
   * @returns 校验后的内容。
   */
  async read<T>(name: string, schema: ZodType<T>, fallback: T): Promise<T> {
    return this.#read(this.#path(name), schema, fallback);
  }

  /**
   * 覆盖写入一个文件。
   * @param name - 文件名。
   * @param schema - 内容的 schema 校验器。
   * @param value - 要写入的内容。
   */
  async write<T>(name: string, schema: ZodType<T>, value: T): Promise<void> {
    const checked = schema.parse(value);
    await this.#serial(name, () => this.#write(this.#path(name), checked));
  }

  /**
   * 在读改写里独占该文件。读取与写入之间不会被本进程内的其他任务打断。
   * @param name - 文件名。
   * @param schema - 内容的 schema 校验器。
   * @param fallback - 文件不存在时的初值。
   * @param mutate - 由当前值得到新值与结果。
   * @returns 读改写给出的结果。
   */
  async mutate<T, R>(name: string, schema: ZodType<T>, fallback: T, mutate: (current: T) => Promise<Mutation<T, R>>): Promise<R> {
    return this.#serial(name, async () => {
      const path = this.#path(name);
      const current = await this.#read(path, schema, fallback);
      const { value, result } = await mutate(current);
      if (value !== undefined) await this.#write(path, schema.parse(value));
      return result;
    });
  }

  #path(name: string): string {
    if (!NAME_PATTERN.test(name)) throw new RangeError(`存储文件名 ${JSON.stringify(name)} 不合法`);
    return join(this.#root, `${name}.json`);
  }

  #serial<T>(name: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(name) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.#chains.set(name, next.catch(() => undefined));
    return next;
  }

  async #read<T>(path: string, schema: ZodType<T>, fallback: T): Promise<T> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    return schema.parse(parsed);
  }

  async #write<T>(path: string, value: T): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE });
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
