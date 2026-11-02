/**
 * 组合输入模块的出口。
 * @module @chatdsh/client-conversation/composer
 */

export {
  ATTACHMENT_STATES,
  ATTACHMENT_STATE_TEXT,
  COMPOSER_INTENTS,
  Composer,
  DEFAULT_MAX_LENGTH,
  SEND_BLOCKERS,
  SEND_BLOCKER_TEXT,
  type AttachmentSlot,
  type AttachmentState,
  type ComposerIntent,
  type ComposerKeyEvent,
  type ComposerOptions,
  type ComposerSnapshot,
  type LengthReport,
  type SendBlocker,
  type SendCheck,
} from './state.ts';
export { ComposerBox, type ComposerProps } from './view.tsx';
