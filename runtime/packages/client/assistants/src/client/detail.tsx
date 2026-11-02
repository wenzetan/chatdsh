/**
 * 助手详情：定义字段、装配结果与技能引用状态。
 *
 * 装配结果来自宿主的装配清单，是这个助手在当前进程里真实装配出来的行；装配失败的助手在名册
 * 里有诊断文字，这里原样展示，说明修改会被拒绝而原定义保持可用。技能引用按技能服务的当前
 * 状态标注启用与停用。
 * @module @chatdsh/client-assistants/detail
 */

import { Badge, Button, Dialog, ScrollRegion, StatusLine } from '@chatdsh/core-ui-kit';

import { COMMON_ROWS } from '../index.ts';
import {
  describeEnablement,
  describePhase,
  formatTime,
  presetGroupOf,
  SKILL_SOURCE_LABEL,
  tierLabelOf,
  tierOf,
} from './state.ts';
import type { AssistantRecord, PresetEntry, PresetGroup, SkillEntry } from './types.ts';

/** 详情对话框的依赖。 */
export interface AssistantDetailProps {
  /** 助手记录。 */
  readonly record: AssistantRecord;
  /** 装配清单；读取失败时为 undefined。 */
  readonly presets: readonly PresetGroup[] | undefined;
  /** 预设名册；读取失败时为 undefined。 */
  readonly roster: readonly PresetEntry[] | undefined;
  /** 技能目录；读取失败时为 undefined。 */
  readonly skills: readonly SkillEntry[] | undefined;
  /** 关闭对话框。 */
  readonly onClose: () => void;
}

/** 助手详情对话框。 */
export function AssistantDetail({ record, presets, roster, skills, onClose }: AssistantDetailProps) {
  const group = presetGroupOf(presets, record.id);
  const rosterEntry = roster?.find((entry) => entry.id === record.id);
  const tier = tierOf(record);
  const referenced = record.skills.map((id) => ({ id, skill: skills?.find((entry) => entry.id === id) }));

  return (
    <Dialog
      open
      title={`助手 ${record.name}`}
      description="进行中的会话保持创建时的定义；修改只影响后续创建的会话，已有会话不提供切换。"
      onClose={onClose}
    >
      <section aria-label="定义">
        <h4>定义</h4>
        <StatusLine><span id="wp11-assistant-detail-id">{`标识 ${record.id} · 版本 ${String(record.revision)}`}</span></StatusLine>
        <StatusLine>{`名称 ${record.name} · ${tierLabelOf(tier)} · 排序 ${String(record.order)}`}</StatusLine>
        <StatusLine>{`说明：${record.description === '' ? '没有填写说明' : record.description}`}</StatusLine>
        <StatusLine>{`建立于 ${formatTime(record.createdAt)}，最后修改于 ${formatTime(record.updatedAt)}`}</StatusLine>
        <ScrollRegion label="助手指令全文">
          <pre id="wp11-assistant-detail-instructions" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {record.instructions === '' ? '（没有填指令）' : record.instructions}
          </pre>
        </ScrollRegion>
      </section>
      <section aria-label="工具装配" className="chdsh-assistants-group">
        <h4>工具装配</h4>
        <StatusLine>{`附加工具 ${String(record.tools.length)} 行：${record.tools.length === 0 ? '只挂档位自带的行' : record.tools.join('、')}`}</StatusLine>
        <StatusLine>{`所有档位共用的行：${COMMON_ROWS.join('、')}`}</StatusLine>
        {rosterEntry?.broken === undefined ? null : (
          <StatusLine tone="danger">{`名册诊断：${rosterEntry.broken}`}</StatusLine>
        )}
        <span id="wp11-assistant-detail-assembly">
          {group === undefined
            ? presets === undefined
              ? '装配清单读取失败，无法核对当前装配结果。'
              : '注册表里没有这个助手的装配记录：它可能刚被删除，或者装配在启动阶段就失败了。'
            : group.broken === undefined
              ? `装配清单：${String(group.rows.length)} 行，全部可用。`
              : `装配清单里有装不起来的行：${group.broken}`}
        </span>
        {group === undefined ? null : (
          <ScrollRegion label="装配行">
            <ul id="wp11-assistant-detail-rows" className="chdsh-assistants-tools">
              {group.rows.map((row) => (
                <li key={`${row.entryId ?? row.moduleName}`}>
                  {`${row.entryId ?? '（没有行标识）'} · ${row.moduleName} · ${describeEnablement(row.enabled)} · ${describePhase(row.fiberPhase)}${
                    row.condition === undefined ? '' : ` · 条件 ${row.condition}`
                  }`}
                </li>
              ))}
            </ul>
          </ScrollRegion>
        )}
        <StatusLine>
          写入是「装配后落盘」的两步：装配失败整笔拒绝，原定义继续可用；因此保存失败不会留下一个装不起来的助手。
        </StatusLine>
      </section>
      <section aria-label="技能引用" className="chdsh-assistants-group">
        <h4>技能引用</h4>
        {skills === undefined
          ? <StatusLine tone="danger">{`技能目录不可用：${String(record.skills.length)} 条引用暂时无法核对状态。`}</StatusLine>
          : referenced.length === 0
            ? <StatusLine>没有引用技能。</StatusLine>
            : (
              <ul id="wp11-assistant-detail-skills" className="chdsh-assistants-tools">
                {referenced.map((entry) => (
                  <li key={entry.id}>
                    {entry.skill === undefined
                      ? `${entry.id} · 技能目录里没有这一条`
                      : `${entry.skill.name} · ${SKILL_SOURCE_LABEL[entry.skill.source]} · `}
                    {entry.skill === undefined
                      ? null
                      : (
                        <Badge tone={entry.skill.enabled ? 'ok' : 'warn'}>
                          {entry.skill.enabled ? '已启用' : '已停用'}
                        </Badge>
                      )}
                  </li>
                ))}
              </ul>
            )}
      </section>
      <Button id="wp11-assistant-detail-close" onClick={onClose}>关闭</Button>
    </Dialog>
  );
}
