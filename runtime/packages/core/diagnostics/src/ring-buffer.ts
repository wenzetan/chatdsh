/**
 * 固定容量的环形缓冲。
 *
 * 用于诊断事件等不可无界增长的队列：容量在创建时固定，写入满后覆盖最旧元素，并通过
 * `dropped` 暴露累计覆盖次数。槽位数量始终受容量约束，不会随写入次数增长。
 * @module @chatdsh/core-diagnostics/ring-buffer
 */

/** 有界环形缓冲的公开接口。 */
export interface BoundedRingBuffer<T> {
  /** 固定容量。 */
  readonly capacity: number;
  /** 当前元素数量。 */
  readonly size: number;
  /** 因覆盖而丢弃的累计元素数量；`clear()` 后归零。 */
  readonly dropped: number;

  /**
   * 写入一个元素；缓冲已满时覆盖最旧元素。
   * @param item - 待写入元素。
   * @returns 是否发生了覆盖。
   */
  push(item: T): boolean;

  /**
   * 按从旧到新的顺序取出并移除元素。
   * @param limit - 最多取出的元素数量；省略时取出全部。必须为非负安全整数。
   * @returns 取出的元素数组。
   */
  drain(limit?: number): T[];

  /**
   * 按从旧到新的顺序查看元素，不移除。
   * @returns 当前元素的浅拷贝数组。
   */
  snapshot(): T[];

  /** 清空元素并重置覆盖计数。 */
  clear(): void;
}

/** 环形缓冲实现。 */
class RingBuffer<T> implements BoundedRingBuffer<T> {
  readonly capacity: number;

  /**
   * 已占用的槽位。
   *
   * 使用 Map 而不是预分配数组，是为了让容量取任意正安全整数时都能创建成功：超大容量
   * 下只占用实际已写入元素的空间，槽位数量仍严格不超过容量。
   */
  readonly #slots = new Map<number, T>();

  /** 最旧元素的槽位下标。 */
  #head = 0;

  /** 下一个写入槽位下标。 */
  #tail = 0;

  /** 当前元素数量。 */
  #size = 0;

  /** 累计覆盖次数。 */
  #dropped = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(`环形缓冲容量必须是正安全整数，收到 ${String(capacity)}`);
    }
    this.capacity = capacity;
  }

  /** 计算环形下标的下一个位置。 */
  #advance(index: number): number {
    return index + 1 === this.capacity ? 0 : index + 1;
  }

  get size(): number {
    return this.#size;
  }

  get dropped(): number {
    return this.#dropped;
  }

  push(item: T): boolean {
    const overwritten = this.#size === this.capacity;
    // 缓冲已满时尾指针与头指针重合，写入即覆盖最旧元素。
    this.#slots.set(this.#tail, item);
    this.#tail = this.#advance(this.#tail);

    if (overwritten) {
      this.#head = this.#advance(this.#head);
      this.#dropped += 1;
      return true;
    }

    this.#size += 1;
    return false;
  }

  drain(limit: number = this.#size): T[] {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError(`drain 数量必须是非负安全整数，收到 ${String(limit)}`);
    }

    const take = Math.min(limit, this.#size);
    const result = new Array<T>(take);
    for (let index = 0; index < take; index += 1) {
      const slot = this.#head;
      result[index] = this.#slots.get(slot) as T;
      this.#slots.delete(slot);
      this.#head = this.#advance(this.#head);
      this.#size -= 1;
    }
    return result;
  }

  snapshot(): T[] {
    const result = new Array<T>(this.#size);
    let slot = this.#head;
    for (let index = 0; index < this.#size; index += 1) {
      result[index] = this.#slots.get(slot) as T;
      slot = this.#advance(slot);
    }
    return result;
  }

  clear(): void {
    this.#slots.clear();
    this.#head = 0;
    this.#tail = 0;
    this.#size = 0;
    this.#dropped = 0;
  }
}

/**
 * 创建一个固定容量的环形缓冲。
 * @param capacity - 正安全整数容量。
 * @returns 环形缓冲实例。
 */
export function createBoundedRingBuffer<T>(capacity: number): BoundedRingBuffer<T> {
  return new RingBuffer<T>(capacity);
}
