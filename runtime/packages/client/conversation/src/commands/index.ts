/**
 * 命令与触发模块的出口。
 * @module @chatdsh/client-conversation/commands
 */

export {
  COMMAND_SCOPES,
  CommandPalette,
  PALETTE_NAVIGATION_KEYS,
  PALETTE_SHORTCUT_LABEL,
  RECENT_COMMANDS_MAX,
  buildConversationCommands,
  filterCommands,
  isPaletteNavigationKey,
  isPaletteShortcut,
  movePaletteSelection,
  orderByRecent,
  paletteKeyIntent,
  readRecentCommands,
  recentCommandsStorageKey,
  recordRecentCommand,
  type CommandDescriptor,
  type CommandPaletteOptions,
  type CommandScope,
  type ConversationCommandInput,
  type KeyboardEventLike,
  type PaletteKeyIntent,
  type PaletteLevel,
  type PaletteNavigationKey,
  type PaletteSelection,
} from './palette.ts';
export {
  TRIGGER_KINDS,
  applyTriggerSelection,
  detectTrigger,
  filterTriggerItems,
  groupTriggerItems,
  toTriggerItems,
  triggerStartsAt,
  type TriggerGroup,
  type TriggerItem,
  type TriggerKind,
  type TriggerMatch,
} from './triggers.ts';
export {
  PaletteDialog,
  TriggerPanel,
  toCommandItems,
  type PaletteDialogProps,
  type TriggerPanelProps,
} from './view.tsx';
