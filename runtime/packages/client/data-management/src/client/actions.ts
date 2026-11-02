/**
 * 数据管理界面的动作名与结果取值。
 *
 * 动作名进入 `chatdsh.client.ui.action` 的 `action` 属性，结果进入 `outcome`。取值集合固定，
 * 新增动作需要同时登记遥测清单。
 * @module @chatdsh/client-data-management/actions
 */

/** 界面动作名。 */
export type DataManagementAction =
  | 'data-usage-read'
  | 'data-usage-export'
  | 'data-retention-save'
  | 'data-cleanup-estimate'
  | 'data-cleanup-execute'
  | 'data-replica-read'
  | 'data-lineage-read'
  | 'data-fork-estimate'
  | 'data-fork-create'
  | 'data-inbox-read'
  | 'data-restore'
  | 'data-permanent-delete';

/** 动作结果。 */
export type DataManagementOutcome = 'ok' | 'failed';
