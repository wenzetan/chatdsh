/**
 * 消息来源的类型登记。
 *
 * `MessageSourceMap` 是可合并接口，注释写明「每个生产者在自己的模块里声明自己的 kind」。
 * 记忆召回追加的用户消息由宿主产生，界面按这个 kind 把它显示成一段相关记忆，宿主与
 * 浏览器侧因此共用同一处取值。声明合并必须写上游的真实包名，写成别名挂不上。
 * @module @chatdsh/core-contracts/message-sources
 */

import type {} from '@deepseek-ai/dsh-llm';

/** 记忆召回追加的用户消息来源。 */
export interface MemoryRecallMessageSource {
  /** 来源标识。 */
  readonly kind: 'memory-recall';
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本步开始时按当前问题查到的记忆，作为一条用户消息追加在历史末尾。 */
    'memory-recall': MemoryRecallMessageSource;
  }
}
