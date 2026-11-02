/**
 * 项目面板的纯逻辑：展示名回退、排序、筛选、字段校验与失败说明。
 *
 * 这一层不接触网络与 React，便于单独核对排序、空名称回退与校验文案。
 * @module @chatdsh/client-projects/state
 */

import type {
  AssistantOption,
  ModelProviderRow,
  ProjectRecord,
} from './types.ts';

/** 名称的上限，与 S10 的字段约束一致。 */
export const PROJECT_TITLE_LIMIT = 80;

/** 新建向导里目录字段的标识，错误摘要用它跳转。 */
export const PATH_FIELD_ID = 'wp10-project-path';

/** 名称字段的标识。 */
export const TITLE_FIELD_ID = 'wp10-project-title';

/** 说明字段的标识。 */
export const INSTRUCTIONS_FIELD_ID = 'wp10-project-instructions';

/** 默认模型字段的标识。 */
export const MODEL_FIELD_ID = 'wp10-project-model';

/** 默认助手字段的标识。 */
export const ASSISTANT_FIELD_ID = 'wp10-project-assistant';

/** 失败说明用到的客户端错误码。 */
export const CLIENT_ERROR_CODES = {
  /** 控制平面不可达。 */
  offline: 'client/offline',
  /** 当前组合没有提供该命名空间。 */
  unavailable: 'client/unavailable',
} as const;

/** 目录列举失败的错误码，与服务端投影一致。 */
export const DIRECTORY_ERROR_CODES = {
  unavailable: 'directory-picker/unavailable',
  unreadable: 'directory-picker/unreadable',
  exists: 'directory-picker/exists',
  createFailed: 'directory-picker/create-failed',
} as const;

/** 列表排序的三种口径。 */
export type SortKey = 'name' | 'updated' | 'path';

/** 排序下拉的选项。 */
export const SORT_OPTIONS: readonly { readonly key: SortKey; readonly label: string }[] = [
  { key: 'name', label: '按名称' },
  { key: 'updated', label: '按更新时间' },
  { key: 'path', label: '按目录' },
];

/** 表单草稿：字符串形式保存，提交时再转成写入输入。 */
export interface ProjectDraft {
  readonly path: string;
  readonly title: string;
  readonly instructions: string;
  readonly defaultModel: string;
  readonly defaultAssistant: string;
}

/** 一条字段校验结果。 */
export interface FieldError {
  readonly fieldId: string;
  readonly message: string;
}

/** 取路径的末段；根路径保留为 `/`。 */
export function lastSegmentOf(path: string): string {
  const trimmed = path.replace(/\/+$/u, '');
  if (trimmed === '') return '/';
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? trimmed : trimmed.slice(index + 1) || '/';
}

/** 一条记录在界面上的名称：名称为空时回退到目录末段。 */
export function displayNameOf(record: Pick<ProjectRecord, 'path' | 'title' | 'displayTitle'>): string {
  if (record.title.trim() !== '' && record.displayTitle !== '') return record.displayTitle;
  return lastSegmentOf(record.path);
}

/** 名称的字符数量，按码位计数，避免把代理对算成两个字符。 */
export function titleLengthOf(title: string): number {
  return [...title.trim()].length;
}

/** 按名称、更新时间或目录排序；名称相同时再按目录，保证顺序确定。 */
export function sortProjects(records: readonly ProjectRecord[], key: SortKey): ProjectRecord[] {
  const sorted = [...records];
  sorted.sort((left, right) => {
    if (key === 'updated') {
      if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
    } else if (key === 'path') {
      return left.path.localeCompare(right.path);
    }
    const byName = displayNameOf(left).localeCompare(displayNameOf(right));
    if (byName !== 0) return byName;
    return left.path.localeCompare(right.path);
  });
  return sorted;
}

/** 按名称与目录做大小写不敏感的筛选。 */
export function filterProjects(records: readonly ProjectRecord[], query: string): ProjectRecord[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...records];
  return records.filter((record) =>
    displayNameOf(record).toLocaleLowerCase().includes(needle)
    || record.path.toLocaleLowerCase().includes(needle));
}

/** 把毫秒时间戳写成 `YYYY-MM-DD HH:mm`。 */
export function formatUpdatedAt(updatedAt: number): string {
  const date = new Date(updatedAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 默认模型徽标的文字。 */
export function modelBadgeOf(model: string | undefined): string | undefined {
  return model === undefined || model === '' ? undefined : `默认模型 ${model}`;
}

/** 默认助手徽标的文字；名册里有展示名时用展示名。 */
export function assistantBadgeOf(id: string | undefined, options: readonly AssistantOption[]): string | undefined {
  if (id === undefined || id === '') return undefined;
  const option = options.find((candidate) => candidate.id === id);
  return `默认助手 ${option?.name ?? id}`;
}

/** 从模型提供方名册拼出可选引用，按字符串排序后去重。 */
export function modelOptionsOf(providers: readonly ModelProviderRow[]): string[] {
  const references = new Set<string>();
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      if (model.trim() !== '') references.add(`${provider.provider}/${model}`);
    }
  }
  return [...references].sort((left, right) => left.localeCompare(right));
}

/** 从助手名册筛出可选项，装配失败的预设不出现。 */
export function assistantOptionsOf(roster: readonly AssistantOption[]): AssistantOption[] {
  return roster
    .filter((entry) => entry.broken === undefined)
    .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
}

/**
 * 校验一份草稿。
 * @param draft - 表单草稿。
 * @param existingPaths - 已有项目记录的路径，用于拒绝重复。
 * @param mode - 新建时检查重复，修改时路径只读。
 * @returns 字段错误列表，按字段出现顺序排列。
 */
export function validateDraft(
  draft: ProjectDraft,
  existingPaths: readonly string[],
  mode: 'create' | 'edit',
): FieldError[] {
  const errors: FieldError[] = [];
  if (draft.path.trim() === '') {
    errors.push({ fieldId: PATH_FIELD_ID, message: '请先在上方选择一个目录' });
  } else if (!draft.path.startsWith('/')) {
    errors.push({ fieldId: PATH_FIELD_ID, message: '目录必须是绝对路径' });
  } else if (mode === 'create' && existingPaths.includes(draft.path)) {
    errors.push({ fieldId: PATH_FIELD_ID, message: '该目录已经有项目记录' });
  }
  if (titleLengthOf(draft.title) > PROJECT_TITLE_LIMIT) {
    errors.push({ fieldId: TITLE_FIELD_ID, message: `名称最多 ${String(PROJECT_TITLE_LIMIT)} 个字符` });
  }
  return errors;
}

/** 保存失败之后的判定：记录被删除、版本已前进，或当前版本未变。 */
export type RevisionVerdict = 'deleted' | 'conflict' | 'unchanged';

/**
 * 比较保存前的版本与重新读到的记录。
 * @param loadedRevision - 表单载入时的版本。
 * @param current - 重新读取到的记录。
 * @returns 判定结果。
 */
export function revisionVerdict(loadedRevision: number, current: ProjectRecord | undefined): RevisionVerdict {
  if (current === undefined) return 'deleted';
  return current.revision === loadedRevision ? 'unchanged' : 'conflict';
}

/**
 * 把一次失败写成面向用户的一句话。
 * @param error - 失败对象。
 * @returns 说明文字。
 */
export function describeFailure(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly code?: unknown; readonly message?: unknown };
    const code = typeof record.code === 'string' ? record.code : '';
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    if (code === CLIENT_ERROR_CODES.offline) return '控制平面不可达，恢复连接后重新加载。';
    if (code === CLIENT_ERROR_CODES.unavailable) return '当前部署没有提供这项能力。';
    if (code === DIRECTORY_ERROR_CODES.unavailable) return '当前部署没有提供目录列举动作，无法浏览目录。';
    if (code === DIRECTORY_ERROR_CODES.unreadable) return '这个目录不能被列举：路径不完整、不存在或没有读取权限。';
    if (message !== '') return code === '' ? message : `${message}（${code}）`;
    if (code !== '') return `操作没有完成（${code}）。`;
  }
  return '操作没有完成，请稍后再试。';
}

/** 草稿里被清空的字段转成写入输入的省略形式。 */
export function inputOf(draft: ProjectDraft, revision?: number): Record<string, unknown> {
  return {
    path: draft.path,
    title: draft.title,
    instructions: draft.instructions,
    ...(draft.defaultModel === '' ? {} : { defaultModel: draft.defaultModel }),
    ...(draft.defaultAssistant === '' ? {} : { defaultAssistant: draft.defaultAssistant }),
    ...(revision === undefined ? {} : { revision }),
  };
}
