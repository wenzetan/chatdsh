/**
 * 记忆组与工作区关联。
 *
 * 记录以稳定 `memoryGroupId` 保存，工作区由设备标识与绝对路径共同确定。更新带 `revision`
 * 比较交换，版本过期直接拒绝；解除关联只改映射，Hindsight 里的既有记忆保持原样。记忆组
 * 条目数的读取依赖记忆服务的统计接口，未读取到时记录里不写这个字段，界面据此显示统计
 * 查询未完成。
 * @module @chatdsh/host-memory/groups
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  ChatdshError,
  countSchema,
  displayNameSchema,
  epochMillisSchema,
  identifierSchema,
  memoryGroupSaveSchema,
  memoryWorkspaceRefSchema,
  revisionSchema,
  type MemoryGroupSave,
  type MemoryWorkspaceRef,
} from '@chatdsh/core-contracts';
import type { MemoryStore } from './store.ts';

/** 存储文件名。 */
export const GROUPS_STORE = 'memory-groups';

/** 记忆组数量上限。达到上限后拒绝新建，不删除任何既有映射。 */
export const GROUP_LIMIT = 1024;

/** 记忆组记录的 schema。 */
const groupRecordSchema = z.object({
  memoryGroupId: identifierSchema,
  displayName: displayNameSchema,
  workspaces: z.array(memoryWorkspaceRefSchema).min(1),
  entryCount: countSchema.optional(),
  createdAt: epochMillisSchema,
  updatedAt: epochMillisSchema,
  revision: revisionSchema,
});

/** 存储文件的 schema。 */
const groupsFileSchema = z.object({
  groups: z.array(groupRecordSchema),
});

/** 记忆组记录。 */
export type MemoryGroupRecord = z.infer<typeof groupRecordSchema>;

/** 存储里的形状。 */
type GroupsFile = z.infer<typeof groupsFileSchema>;

/** 文件缺省值。 */
const EMPTY: GroupsFile = { groups: [] };

/**
 * 生成记忆组标识。
 *
 * 标识与路径无关：同一个仓库在两台设备上的两份检出关联到同一个组之后，两边算出的召回
 * bank 完全相同。
 * @returns 形如 `mg_` 加二十四位十六进制的标识。
 */
function newGroupId(): string {
  return `mg_${randomBytes(12).toString('hex')}`;
}

/**
 * 判断两个工作区是否相同。
 * @param left - 一个工作区。
 * @param right - 另一个工作区。
 * @returns 设备标识与路径都相同时为 true。
 */
export function sameWorkspace(left: MemoryWorkspaceRef, right: MemoryWorkspaceRef): boolean {
  return left.deviceId === right.deviceId && left.path === right.path;
}

/**
 * 校验记忆组保存请求。
 * @param input - 保存请求。
 * @returns 校验后的请求。
 */
function parseGroupSave(input: MemoryGroupSave): MemoryGroupSave {
  const parsed = memoryGroupSaveSchema.safeParse(input);
  if (!parsed.success) throw new ChatdshError('request-invalid', '记忆组保存请求不合法');
  if (parsed.data.memoryGroupId !== undefined && parsed.data.revision === undefined) {
    throw new ChatdshError('request-invalid', '更新记忆组必须带 revision');
  }
  return parsed.data;
}

/**
 * 校验 revision 参数。
 * @param revision - 调用方给出的版本。
 * @returns 校验后的版本。
 */
function parseRevision(revision: number): number {
  const parsed = revisionSchema.safeParse(revision);
  if (!parsed.success) throw new ChatdshError('request-invalid', 'revision 必须是非负整数');
  return parsed.data;
}

/**
 * 按设备标识与路径去重工作区。
 * @param workspaces - 关联的工作区集合。
 * @returns 去重后的工作区集合。
 */
function dedupeWorkspaces(workspaces: readonly MemoryWorkspaceRef[]): MemoryWorkspaceRef[] {
  const out: MemoryWorkspaceRef[] = [];
  for (const workspace of workspaces) {
    if (out.some((candidate) => sameWorkspace(candidate, workspace))) continue;
    out.push({ deviceId: workspace.deviceId, path: workspace.path });
  }
  return out;
}

/**
 * 确认一个工作区没有属于其他记忆组。
 * @param groups - 当前全部记忆组。
 * @param workspace - 待确认的工作区。
 * @param except - 允许包含该工作区的记忆组标识。
 */
function assertWorkspaceFree(groups: readonly MemoryGroupRecord[], workspace: MemoryWorkspaceRef, except: string | undefined): void {
  const owner = groups.find((group) => group.memoryGroupId !== except && group.workspaces.some((candidate) => sameWorkspace(candidate, workspace)));
  if (owner !== undefined) {
    throw new ChatdshError('request-invalid', '该工作区已经属于另一个记忆组', { memoryGroupId: owner.memoryGroupId, path: workspace.path });
  }
}

/**
 * 取出一个已存在的记忆组。
 * @param groups - 当前全部记忆组。
 * @param memoryGroupId - 记忆组标识。
 * @returns 记忆组在数组里的下标与记录。
 */
function findGroup(groups: readonly MemoryGroupRecord[], memoryGroupId: string): { readonly index: number; readonly record: MemoryGroupRecord } {
  const index = groups.findIndex((group) => group.memoryGroupId === memoryGroupId);
  const record = index < 0 ? undefined : groups[index];
  if (record === undefined) throw new ChatdshError('memory-group-unknown', '记忆组不存在', { memoryGroupId });
  return { index, record };
}

/** 记忆组注册表。 */
export class MemoryGroupRegistry {
  constructor(private readonly store: MemoryStore, private readonly now: () => number = Date.now) {}

  /**
   * 读取全部记忆组，按建立顺序。
   * @returns 记忆组记录。
   */
  async list(): Promise<MemoryGroupRecord[]> {
    return (await this.store.read(GROUPS_STORE, groupsFileSchema, EMPTY)).groups;
  }

  /**
   * 按标识读取一个记忆组。
   * @param memoryGroupId - 记忆组标识。
   * @returns 记忆组记录；不存在时为 `undefined`。
   */
  async get(memoryGroupId: string): Promise<MemoryGroupRecord | undefined> {
    return (await this.list()).find((group) => group.memoryGroupId === memoryGroupId);
  }

  /**
   * 按工作区解析所属记忆组。
   * @param workspace - 设备标识与绝对路径。
   * @returns 所属记忆组；没有关联时为 `undefined`。
   */
  async resolve(workspace: MemoryWorkspaceRef): Promise<MemoryGroupRecord | undefined> {
    return (await this.list()).find((group) => group.workspaces.some((candidate) => sameWorkspace(candidate, workspace)));
  }

  /**
   * 新建或更新一个记忆组。
   *
   * 新建时生成稳定标识并从 `revision` 1 开始；更新时用调用方给出的版本比较交换，版本
   * 不一致直接拒绝，避免两个界面互相覆盖。
   * @param input - 保存请求。
   * @returns 保存后的记录。
   */
  async save(input: MemoryGroupSave): Promise<MemoryGroupRecord> {
    const parsed = parseGroupSave(input);
    return this.store.mutate<GroupsFile, MemoryGroupRecord>(GROUPS_STORE, groupsFileSchema, EMPTY, async (current) => {
      const groups = [...current.groups];
      const now = this.now();
      for (const workspace of parsed.workspaces) assertWorkspaceFree(groups, workspace, parsed.memoryGroupId);
      if (parsed.memoryGroupId === undefined) {
        if (groups.length >= GROUP_LIMIT) {
          throw new ChatdshError('request-invalid', '记忆组数量达到上限', { limit: GROUP_LIMIT });
        }
        const record: MemoryGroupRecord = {
          memoryGroupId: newGroupId(),
          displayName: parsed.displayName,
          workspaces: dedupeWorkspaces(parsed.workspaces),
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
        groups.push(record);
        return { value: { groups }, result: record };
      }
      const { index, record } = findGroup(groups, parsed.memoryGroupId);
      if (record.revision !== parsed.revision) {
        throw new ChatdshError('revision-conflict', '记忆组版本已过期', { memoryGroupId: record.memoryGroupId, revision: record.revision });
      }
      const updated: MemoryGroupRecord = {
        ...record,
        displayName: parsed.displayName,
        workspaces: dedupeWorkspaces(parsed.workspaces),
        updatedAt: now,
        revision: record.revision + 1,
      };
      groups[index] = updated;
      return { value: { groups }, result: updated };
    });
  }

  /**
   * 解除一个工作区与记忆组的关联。解除最后一个工作区时删除该组。
   * @param memoryGroupId - 记忆组标识。
   * @param workspace - 要解除的工作区。
   * @param revision - 调用方看到的版本。
   * @returns 更新后的记忆组；整组被删除时为 `undefined`。
   */
  async detach(memoryGroupId: string, workspace: MemoryWorkspaceRef, revision: number): Promise<MemoryGroupRecord | undefined> {
    const expected = parseRevision(revision);
    return this.store.mutate<GroupsFile, MemoryGroupRecord | undefined>(GROUPS_STORE, groupsFileSchema, EMPTY, async (current) => {
      const groups = [...current.groups];
      const { index, record } = findGroup(groups, memoryGroupId);
      if (record.revision !== expected) {
        throw new ChatdshError('revision-conflict', '记忆组版本已过期', { memoryGroupId: record.memoryGroupId, revision: record.revision });
      }
      const remaining = record.workspaces.filter((candidate) => !sameWorkspace(candidate, workspace));
      if (remaining.length === record.workspaces.length) {
        throw new ChatdshError('request-invalid', '该工作区不在这个记忆组里', { memoryGroupId: record.memoryGroupId, path: workspace.path });
      }
      if (remaining.length === 0) {
        groups.splice(index, 1);
        return { value: { groups }, result: undefined };
      }
      const updated: MemoryGroupRecord = { ...record, workspaces: remaining, updatedAt: this.now(), revision: record.revision + 1 };
      groups[index] = updated;
      return { value: { groups }, result: updated };
    });
  }

  /**
   * 删除一个记忆组映射。既有记忆保持原样。
   * @param memoryGroupId - 记忆组标识。
   * @param revision - 调用方看到的版本。
   * @returns 删除成功为 true。
   */
  async remove(memoryGroupId: string, revision: number): Promise<boolean> {
    const expected = parseRevision(revision);
    return this.store.mutate<GroupsFile, boolean>(GROUPS_STORE, groupsFileSchema, EMPTY, async (current) => {
      const groups = [...current.groups];
      const { index, record } = findGroup(groups, memoryGroupId);
      if (record.revision !== expected) {
        throw new ChatdshError('revision-conflict', '记忆组版本已过期', { memoryGroupId: record.memoryGroupId, revision: record.revision });
      }
      groups.splice(index, 1);
      return { value: { groups }, result: true };
    });
  }

  /**
   * 写入最近一次读取到的组 bank 条目数。条目数不是用户编辑，不改变 `revision`。
   * @param counts - 记忆组标识到条目数的映射。
   */
  async recordCounts(counts: ReadonlyMap<string, number>): Promise<void> {
    if (counts.size === 0) return;
    await this.store.mutate<GroupsFile, void>(GROUPS_STORE, groupsFileSchema, EMPTY, async (current) => {
      let changed = false;
      const groups = current.groups.map((group) => {
        const count = counts.get(group.memoryGroupId);
        if (count === undefined || count === group.entryCount) return group;
        changed = true;
        return { ...group, entryCount: count };
      });
      return changed ? { value: { groups }, result: undefined } : { result: undefined };
    });
  }
}
