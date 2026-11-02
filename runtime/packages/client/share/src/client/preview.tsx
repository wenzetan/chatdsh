/**
 * 只读预览：发布之前把服务端将要公开的内容逐项列清楚。
 *
 * 预览数据来自控制平面的预览接口：消息条数、字符数、范围内事件数、脱敏次数、排除项与
 * 回合清单都是服务端在同一套过滤规则下算出来的，建立分享时用的也是这套规则，因此预览的
 * 数字与公开页上看到的结果一致。预览本身没有输入、审批、继续与编辑动作。
 * @module @chatdsh/client-share/preview
 */

import { Badge, ErrorNote, Panel, StatusLine } from '@chatdsh/core-ui-kit';
import { describeTurns, formatBytes, formatTime, SHARE_EXCLUSIONS } from './share.ts';
import type { ShareExclusion, SharePreview, ShareSelection } from './types.ts';

/** 预览属性。 */
export interface SharePreviewPanelProps {
  /** 控制平面的预览结论。 */
  readonly preview: SharePreview;
  /** 提交给控制平面的公开选择，回显出来供核对。 */
  readonly selection: ShareSelection;
  /** 预览时刻。 */
  readonly at: number;
}

/** 排除项文案。 */
const EXCLUSION_LABELS: Readonly<Record<ShareExclusion, string>> = {
  'memory-recall': '相关记忆',
  'tool-arguments': '工具参数与结果原文',
  'internal-paths': '内部路径',
  'sensitive-metadata': '敏感元数据与思考过程',
  'replica-watermark': '副本水位',
};

/** 事实行的样式：只在共享令牌上取值，不新增样式表条目。 */
const FACT_LABEL = { margin: 0, color: 'var(--chatdsh-muted)', fontSize: 'var(--cdh-fs-12)' } as const;
const FACT_VALUE = { margin: 0, color: 'var(--chatdsh-ink)', fontSize: 'var(--cdh-fs-13)', overflowWrap: 'anywhere' } as const;
const SECTION_TITLE = { margin: '12px 0 4px', color: 'var(--chatdsh-ink)', fontSize: 'var(--cdh-fs-13)' } as const;
const PLAIN_LIST = { margin: 0, paddingInlineStart: '20px', color: 'var(--chatdsh-ink-2)', fontSize: 'var(--cdh-fs-13)', overflowWrap: 'anywhere' } as const;
const ITEM_LINE = { margin: '2px 0', overflowWrap: 'anywhere', color: 'var(--chatdsh-ink-2)', fontSize: 'var(--cdh-fs-13)' } as const;

/**
 * 渲染只读预览。
 * @param props - 预览结论、公开选择与预览时刻。
 * @returns 预览面板。
 */
export function SharePreviewPanel({ preview, selection, at }: SharePreviewPanelProps) {
  const applied = new Set<ShareExclusion>(preview.excluded);
  const missing = preview.attachments.filter((attachment) => !attachment.downloadable);
  return (
    <Panel title="只读预览" subtitle="公开页只显示下列内容。源会话在这条快照建立之后的新内容不会加入。">
      <dl data-share-facts style={{ margin: '0 0 8px', display: 'grid', gap: '6px' }}>
        <div>
          <dt style={FACT_LABEL}>来源会话</dt>
          <dd data-share-source style={FACT_VALUE}>{preview.title}</dd>
        </div>
        <div>
          <dt style={FACT_LABEL}>回合范围</dt>
          <dd data-share-range style={FACT_VALUE}>
            {`${describeTurns(preview.turns)}（回合编号 ${String(preview.scope.turnFrom)} 至 ${String(preview.scope.turnTo)}）`}
          </dd>
        </div>
        <div>
          <dt style={FACT_LABEL}>公开文本</dt>
          <dd data-share-selection style={FACT_VALUE}>
            {[selection.includeUserText ? '用户消息' : undefined, selection.includeAssistantText ? '助手消息' : undefined]
              .filter((item) => item !== undefined)
              .join('、')}
          </dd>
        </div>
        <div>
          <dt style={FACT_LABEL}>预览时刻</dt>
          <dd data-share-created style={FACT_VALUE}>{formatTime(at)}</dd>
        </div>
        <div>
          <dt style={FACT_LABEL}>只读声明</dt>
          <dd style={FACT_VALUE}><Badge tone="brand">公开只读，无输入与审批动作</Badge></dd>
        </div>
      </dl>

      <h4 style={SECTION_TITLE}>过滤与脱敏</h4>
      <ul style={PLAIN_LIST} data-share-filter>
        <li style={ITEM_LINE} data-share-count>{`将公开的消息：${String(preview.messageCount)} 条`}</li>
        <li style={ITEM_LINE} data-share-chars>{`公开文本字符数：${String(preview.scope.charCount)} 个`}</li>
        <li style={ITEM_LINE} data-share-events>{`范围内事件数：${String(preview.scope.eventCount)} 条`}</li>
        <li style={ITEM_LINE} data-share-redact-paths>{`内部路径脱敏：${String(preview.redactions.paths)} 处`}</li>
        <li style={ITEM_LINE} data-share-redact-credentials>{`凭据脱敏：${String(preview.redactions.credentials)} 处`}</li>
        <li style={ITEM_LINE} data-share-compressed>{`压缩保存：${preview.scope.compressed ? '是' : '否'}`}</li>
      </ul>

      <h4 style={SECTION_TITLE}>排除项</h4>
      <ul style={PLAIN_LIST} data-share-exclusions>
        {SHARE_EXCLUSIONS.map((item) => (
          <li style={ITEM_LINE} key={item} data-share-exclusion={item}>
            {`${EXCLUSION_LABELS[item]}：${applied.has(item) ? '已排除' : '本范围未出现'}`}
          </li>
        ))}
      </ul>

      <h4 style={SECTION_TITLE}>回合清单</h4>
      <ul style={PLAIN_LIST} data-share-turns>
        {preview.turns.map((turn) => (
          <li style={ITEM_LINE} key={turn} data-share-turn={String(turn)}>{`回合 ${String(turn)}`}</li>
        ))}
      </ul>

      <h4 style={SECTION_TITLE}>公开附件</h4>
      {preview.attachments.length === 0 ? (
        <StatusLine>本次分享不包含附件；没有勾选的附件不出现在公开页，也无法按路径猜测下载。</StatusLine>
      ) : (
        <ul style={PLAIN_LIST} data-share-attachments>
          {preview.attachments.map((attachment) => (
            <li style={ITEM_LINE} key={attachment.id} data-share-attachment={attachment.id}>
              {`${attachment.filename}（${attachment.downloadable ? '可下载' : '源附件读不到'}）`}
            </li>
          ))}
        </ul>
      )}

      <StatusLine>预览与公开页使用同一套服务端过滤：条数、字符数、脱敏次数、排除项与附件清单在公开页上相同。</StatusLine>
      {missing.length === 0 ? null : (
        <ErrorNote>
          {`有 ${String(missing.length)} 份附件在源设备上读不到，勾选它们时无法发布；取消勾选后可以继续。`}
        </ErrorNote>
      )}
    </Panel>
  );
}

/**
 * 附件大小的展示。
 * @param size - 元数据里的字节数；缺省表示源附件元数据没有给出。
 * @returns 说明文字。
 */
export function attachmentSizeLabel(size: number | undefined): string {
  return size === undefined ? '大小未知' : formatBytes(size);
}
