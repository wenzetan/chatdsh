/**
 * 分享的生命周期：预览、建立、列表、撤销、公开访问与附件下载。
 *
 * 建立分享时解析完整回合、执行服务端内容过滤、把逐项授权的附件复制进分享包，并在一个
 * 事务里写入固定快照；之后源会话继续写入不会改变已发布链接。公开访问按令牌判定撤销与
 * 过期，未知令牌与失效令牌都只返回不可用，不透露来源会话。
 * @module @chatdsh/gateway/sharing/service
 */

import { randomBytes } from 'node:crypto';
import { CHATDSH_ERROR_CODES, type ChatdshTelemetry, type ContentScope, type TelemetrySpan } from '@chatdsh/core-contracts';
import type {
  PublicAccess,
  PublicAttachmentContent,
  ShareAttachmentRecord,
  ShareAttachmentSource,
  ShareCreateInput,
  ShareCreatedView,
  SharePreviewInput,
  SharePreviewView,
  ShareRange,
  ShareRecordView,
  ShareRevokeView,
  SourceAttachment,
} from './types.ts';
import { ShareError } from './types.ts';
import type { ReplicaEventReader } from './types.ts';
import { buildTurnIndex, sessionTitleOf } from './events.ts';
import { filterTurns, type FilterResult } from './filter.ts';
import { resolveRange, type ResolvedRange } from './range.ts';
import { ShareRepository, statusOf, type StoredShare } from './repository.ts';
import {
  ATTACHMENT_ID_PATTERN,
  digestOf,
  readShareAttachment,
  removeSharePackage,
  writeShareAttachment,
} from './attachments.ts';

/** 动作 span 的名称。 */
export const SHARE_SPANS = {
  preview: 'chatdsh.gateway.share.preview',
  create: 'chatdsh.gateway.share.create',
  list: 'chatdsh.gateway.share.list',
  revoke: 'chatdsh.gateway.share.revoke',
  render: 'chatdsh.gateway.share.render',
  attachment: 'chatdsh.gateway.share.attachment',
} as const;

/** 计数指标的名称。 */
export const SHARE_METRICS = {
  previews: 'chatdsh_gateway_share_previews_total',
  creations: 'chatdsh_gateway_share_creations_total',
  listings: 'chatdsh_gateway_share_listings_total',
  revocations: 'chatdsh_gateway_share_revocations_total',
  views: 'chatdsh_gateway_share_views_total',
  downloads: 'chatdsh_gateway_share_attachment_downloads_total',
} as const;

/** 失败事件的名称。 */
export const SHARE_REJECTED_EVENT = 'chatdsh.gateway.share.rejected';

/** 失败分类。 */
interface Failure {
  readonly type: string;
  readonly code: string;
  readonly reason: string;
}

/** 分享服务依赖。 */
export interface ShareServiceOptions {
  readonly repository: ShareRepository;
  readonly replica: ReplicaEventReader;
  readonly attachments: ShareAttachmentSource;
  readonly telemetry: ChatdshTelemetry;
  /** 分享包目录，附件副本写在这里。 */
  readonly sharesRoot: string;
  /** 公开路径前缀，缺省 `/s/`。 */
  readonly publicPrefix?: string;
}

/** 一次建立所需的固定内容。 */
interface BuiltContent {
  readonly title: string;
  readonly scope: ContentScope;
  readonly resolved: ResolvedRange;
  readonly filtered: FilterResult;
}

/** 待复制的附件。 */
interface PreparedAttachment {
  readonly id: string;
  readonly source: SourceAttachment;
}

/** 把异常归类成遥测取值。 */
function failureOf(error: unknown): Failure {
  if (error instanceof ShareError) return { type: 'share', code: error.code, reason: error.reason };
  return { type: 'internal', code: CHATDSH_ERROR_CODES.internalError, reason: 'internal' };
}

/** 全部分享服务用到的计数指标说明。 */
const METRIC_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [SHARE_METRICS.previews]: '分享预览结果',
  [SHARE_METRICS.creations]: '分享建立结果',
  [SHARE_METRICS.listings]: '分享列表读取结果',
  [SHARE_METRICS.revocations]: '分享撤销结果',
  [SHARE_METRICS.views]: '公开快照访问结果',
  [SHARE_METRICS.downloads]: '分享附件下载结果',
};

/** 分享服务。 */
export class ShareService {
  private readonly publicPrefix: string;

  constructor(private readonly options: ShareServiceOptions) {
    this.publicPrefix = options.publicPrefix ?? '/s/';
  }

  /** 预览：与建立使用同一套范围解析与过滤，不写任何记录。 */
  async preview(input: SharePreviewInput): Promise<SharePreviewView> {
    return await this.options.telemetry.runSpan(SHARE_SPANS.preview, { 'session.id': input.sessionId }, async (span) => {
      try {
        const built = this.build(input.sessionId, input.range, input.includeUserText, input.includeAssistantText);
        const candidates = await this.candidates(input.attachmentIds);
        span.setAttribute('outcome', 'ok');
        span.setAttribute('count', built.filtered.messages.length);
        span.setAttribute('turn', built.resolved.turnFrom);
        this.count(SHARE_METRICS.previews, 'ok');
        return {
          title: built.title,
          scope: built.scope,
          turns: built.resolved.turnNumbers,
          messageCount: built.filtered.messages.length,
          attachments: candidates.map((candidate) => ({
            id: candidate.id,
            filename: candidate.filename,
            downloadable: candidate.downloadable,
          })),
          excluded: built.filtered.excluded,
          redactions: {
            paths: built.filtered.redactedPaths,
            credentials: built.filtered.redactedCredentials,
          },
        };
      } catch (error) {
        this.reject(span, SHARE_METRICS.previews, 'preview', error);
        throw error;
      }
    });
  }

  /** 建立分享：固定快照内容并复制授权附件。 */
  async create(input: ShareCreateInput): Promise<ShareCreatedView> {
    return await this.options.telemetry.runSpan(SHARE_SPANS.create, { 'session.id': input.sessionId }, async (span) => {
      try {
        if (input.operationId !== undefined) {
          const existing = this.options.repository.findByOperation(input.operationId);
          if (existing !== undefined) {
            if (input.requestDigest !== undefined && existing.requestDigest !== input.requestDigest) {
              throw new ShareError(
                CHATDSH_ERROR_CODES.operationDigestMismatch,
                'operation-digest',
                '同一操作标识携带了不同的请求摘要',
              );
            }
            span.setAttribute('outcome', 'duplicate');
            this.count(SHARE_METRICS.creations, 'duplicate');
            return this.createdView(existing, Date.now());
          }
        }
        if (input.ttlMs !== undefined && (!Number.isInteger(input.ttlMs) || input.ttlMs < 0)) {
          throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'ttl-invalid', '有效期必须是非负整数毫秒');
        }
        const built = this.build(input.sessionId, input.range, input.includeUserText, input.includeAssistantText);
        const prepared = await this.prepareAttachments(input.attachmentIds);
        const token = randomBytes(32).toString('base64url');
        const createdAt = Date.now();
        const expiresAt = input.ttlMs === undefined ? undefined : createdAt + input.ttlMs;
        const records: ShareAttachmentRecord[] = [];
        let attachmentBytes = 0;
        try {
          for (const item of prepared) {
            const storageKey = await writeShareAttachment({
              root: this.options.sharesRoot,
              token,
              attachmentId: item.id,
              bytes: item.source.bytes,
            });
            records.push({
              id: item.id,
              filename: item.source.filename,
              mimeType: item.source.mimeType,
              size: item.source.size,
              digest: item.source.digest,
              storageKey,
            });
            attachmentBytes += item.source.size;
          }
        } catch (error) {
          await removeSharePackage({ root: this.options.sharesRoot, token });
          throw error;
        }
        const messageBytes = built.filtered.messages.reduce(
          (total, message) => total + Buffer.byteLength(message.text, 'utf8'),
          0,
        );
        const scope: ContentScope = { ...built.scope, attachmentsComplete: records.length === prepared.length };
        try {
          this.options.repository.insert({
            share: {
              token,
              sessionId: input.sessionId,
              title: built.title,
              scope,
              turnNumbers: built.resolved.turnNumbers,
              fromTurn: built.resolved.turnFrom,
              toTurn: built.resolved.turnTo,
              boundSeq: built.resolved.boundSeq,
              createdAt,
              ...(expiresAt === undefined ? {} : { expiresAt }),
              bytes: messageBytes + attachmentBytes,
              messageCount: built.filtered.messages.length,
              attachmentBytes,
              ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
              ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
            },
            messages: built.filtered.messages,
            attachments: records,
          });
        } catch (error) {
          await removeSharePackage({ root: this.options.sharesRoot, token });
          throw error;
        }
        const stored = this.options.repository.get(token);
        if (stored === undefined) {
          throw new ShareError(CHATDSH_ERROR_CODES.internalError, 'write-unconfirmed', '分享写入后读不到记录');
        }
        span.setAttribute('outcome', 'ok');
        span.setAttribute('count', stored.messageCount);
        span.setAttribute('turn', stored.fromTurn);
        span.setAttribute('bytes', stored.bytes);
        this.count(SHARE_METRICS.creations, 'ok');
        return this.createdView(stored, createdAt);
      } catch (error) {
        this.reject(span, SHARE_METRICS.creations, 'create', error);
        throw error;
      }
    });
  }

  /** 列出全部分享与占用空间。 */
  async list(): Promise<{ readonly shares: readonly ShareRecordView[]; readonly totalBytes: number }> {
    return await this.options.telemetry.runSpan(SHARE_SPANS.list, {}, async (span) => {
      try {
        const now = Date.now();
        const shares = this.options.repository.list().map((share) => this.recordView(share, now));
        const totalBytes = this.options.repository.totalBytes();
        span.setAttribute('outcome', 'ok');
        span.setAttribute('count', shares.length);
        span.setAttribute('bytes', totalBytes);
        this.count(SHARE_METRICS.listings, 'ok');
        return { shares, totalBytes };
      } catch (error) {
        this.reject(span, SHARE_METRICS.listings, 'list', error);
        throw error;
      }
    });
  }

  /** 撤销分享；未知令牌返回空，已撤销时返回原撤销时刻。 */
  async revoke(token: string): Promise<ShareRevokeView | undefined> {
    return await this.options.telemetry.runSpan(SHARE_SPANS.revoke, {}, async (span) => {
      const now = Date.now();
      const revokedAt = this.options.repository.revoke(token, now);
      if (revokedAt === undefined) {
        span.setAttribute('outcome', 'missing');
        this.count(SHARE_METRICS.revocations, 'missing');
        this.options.telemetry.event(SHARE_REJECTED_EVENT, {
          'error.type': 'share',
          'error.code': CHATDSH_ERROR_CODES.objectNotFound,
          outcome: 'missing',
          kind: 'revoke',
          reason: 'unknown',
        });
        return undefined;
      }
      const stored = this.options.repository.get(token);
      if (stored === undefined) {
        throw new ShareError(CHATDSH_ERROR_CODES.internalError, 'write-unconfirmed', '撤销后读不到分享记录');
      }
      span.setAttribute('outcome', 'ok');
      this.count(SHARE_METRICS.revocations, 'ok');
      return { shareId: token, revokedAt, status: statusOf(stored, now) };
    });
  }

  /** 公开访问：按令牌给出固定页面模型或不可用结论。 */
  publicAccess(token: string): PublicAccess {
    return this.options.telemetry.runSpanSync(SHARE_SPANS.render, {}, (span) => {
      const now = Date.now();
      const share = this.options.repository.get(token);
      if (share === undefined) return this.unavailable(span, 'unknown');
      const status = statusOf(share, now);
      if (status === 'revoked') return this.unavailable(span, 'revoked');
      if (status === 'expired') return this.unavailable(span, 'expired');
      this.options.repository.touch(token);
      const messages = this.options.repository.messagesOf(token);
      const attachments = this.options.repository.attachmentsOf(token);
      span.setAttribute('outcome', 'ok');
      span.setAttribute('count', messages.length);
      span.setAttribute('turn', share.fromTurn);
      this.count(SHARE_METRICS.views, 'ok');
      return {
        state: 'active',
        page: {
          title: share.title,
          createdAt: share.createdAt,
          scope: share.scope,
          turns: share.turnNumbers,
          messages,
          attachments: attachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            size: attachment.size,
          })),
          readOnly: true,
          canPrint: true,
          interactive: false,
          token,
        },
      };
    });
  }

  /** 读取已授权附件；未授权与分享不可用都返回空，由调用方统一回 404。 */
  async attachment(token: string, attachmentId: string): Promise<PublicAttachmentContent | undefined> {
    return await this.options.telemetry.runSpan(SHARE_SPANS.attachment, {}, async (span) => {
      try {
        const share = this.options.repository.get(token);
        if (share === undefined) return this.attachmentUnavailable(span, 'unknown');
        const status = statusOf(share, Date.now());
        if (status === 'revoked') return this.attachmentUnavailable(span, 'revoked');
        if (status === 'expired') return this.attachmentUnavailable(span, 'expired');
        if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return this.attachmentUnavailable(span, 'denied');
        const record = this.options.repository.attachmentOf(token, attachmentId);
        if (record === undefined) return this.attachmentUnavailable(span, 'denied');
        const bytes = await readShareAttachment({ root: this.options.sharesRoot, storageKey: record.storageKey });
        if (digestOf(bytes) !== record.digest) {
          throw new ShareError(CHATDSH_ERROR_CODES.internalError, 'package-corrupt', '分享包里的附件摘要与记录不一致');
        }
        span.setAttribute('outcome', 'ok');
        span.setAttribute('bytes', bytes.byteLength);
        this.count(SHARE_METRICS.downloads, 'ok');
        return { filename: record.filename, mimeType: record.mimeType, bytes };
      } catch (error) {
        this.reject(span, SHARE_METRICS.downloads, 'attachment', error);
        throw error;
      }
    });
  }

  /** 解析范围并执行过滤。 */
  private build(sessionId: string, range: ShareRange, includeUserText: boolean, includeAssistantText: boolean): BuiltContent {
    const events = this.options.replica.read(sessionId);
    if (events.length === 0) {
      throw new ShareError(CHATDSH_ERROR_CODES.sessionNotFound, 'replica-missing', '源会话没有可读副本');
    }
    const index = buildTurnIndex(events);
    const resolved = resolveRange(index, range);
    const filtered = filterTurns(resolved.turns, { includeUserText, includeAssistantText });
    const scope: ContentScope = {
      turnFrom: resolved.turnFrom,
      turnTo: resolved.turnTo,
      eventCount: resolved.eventCount,
      charCount: filtered.charCount,
      compressed: false,
      attachmentsComplete: true,
    };
    return {
      title: sessionTitleOf(events) ?? '会话快照',
      scope,
      resolved,
      filtered,
    };
  }

  /** 预览用的附件候选：读得到才可下载，读不到只标注不可下载。 */
  private async candidates(attachmentIds: readonly string[]): Promise<
    readonly { readonly id: string; readonly filename: string; readonly downloadable: boolean }[]
  > {
    const ids = [...new Set(attachmentIds)];
    const out: { id: string; filename: string; downloadable: boolean }[] = [];
    for (const id of ids) {
      if (!ATTACHMENT_ID_PATTERN.test(id)) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachment-id', '附件标识不合法');
      }
      try {
        const source = await this.options.attachments.read(id);
        out.push({ id, filename: source.filename, downloadable: true });
      } catch (error) {
        if (error instanceof ShareError && error.reason.startsWith('attachment')) {
          out.push({ id, filename: id, downloadable: false });
          continue;
        }
        throw error;
      }
    }
    return out;
  }

  /** 建立分享前的附件读取：任何一份读不到都拒绝建立，不静默丢弃。 */
  private async prepareAttachments(attachmentIds: readonly string[]): Promise<readonly PreparedAttachment[]> {
    const ids = [...new Set(attachmentIds)];
    const out: PreparedAttachment[] = [];
    for (const id of ids) {
      if (!ATTACHMENT_ID_PATTERN.test(id)) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachment-id', '附件标识不合法');
      }
      out.push({ id, source: await this.options.attachments.read(id) });
    }
    return out;
  }

  /** 分享列表里的一条。 */
  private recordView(share: StoredShare, now: number): ShareRecordView {
    const status = statusOf(share, now);
    return {
      shareId: share.token,
      sourceSessionId: share.sessionId,
      title: share.title,
      scope: share.scope,
      status,
      createdAt: share.createdAt,
      ...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
      ...(share.revokedAt === undefined ? {} : { revokedAt: share.revokedAt }),
      visits: share.visits,
      bytes: share.bytes,
      ...(status === 'active' ? { path: `${this.publicPrefix}${share.token}` } : {}),
    };
  }

  /** 建立结果。 */
  private createdView(share: StoredShare, now: number): ShareCreatedView {
    const attachments = this.options.repository.attachmentsOf(share.token).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      size: attachment.size,
    }));
    return {
      shareId: share.token,
      path: `${this.publicPrefix}${share.token}`,
      sourceSessionId: share.sessionId,
      title: share.title,
      scope: share.scope,
      status: statusOf(share, now),
      createdAt: share.createdAt,
      ...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
      bytes: share.bytes,
      attachments,
    };
  }

  /** 公开访问的不可用结论与遥测。 */
  private unavailable(span: TelemetrySpan, reason: 'revoked' | 'expired' | 'unknown'): PublicAccess {
    span.setAttribute('outcome', reason);
    this.count(SHARE_METRICS.views, reason);
    this.options.telemetry.event(SHARE_REJECTED_EVENT, {
      'error.type': 'share',
      'error.code': CHATDSH_ERROR_CODES.shareUnavailable,
      outcome: reason,
      kind: 'render',
      reason,
    });
    return { state: reason };
  }

  /** 附件不可用的结论与遥测。 */
  private attachmentUnavailable(span: TelemetrySpan, reason: 'revoked' | 'expired' | 'unknown' | 'denied'): undefined {
    span.setAttribute('outcome', reason);
    this.count(SHARE_METRICS.downloads, reason);
    this.options.telemetry.event(SHARE_REJECTED_EVENT, {
      'error.type': 'share',
      'error.code': reason === 'denied' ? CHATDSH_ERROR_CODES.permissionDenied : CHATDSH_ERROR_CODES.shareUnavailable,
      outcome: reason,
      kind: 'attachment',
      reason,
    });
    return undefined;
  }

  /** 失败：写失败事件、计数并把异常原样抛出。 */
  private reject(span: TelemetrySpan, metric: string, kind: string, error: unknown): void {
    const failure = failureOf(error);
    span.setAttribute('outcome', 'rejected');
    this.count(metric, 'rejected');
    this.options.telemetry.event(SHARE_REJECTED_EVENT, {
      'error.type': failure.type,
      'error.code': failure.code,
      outcome: 'rejected',
      kind,
      reason: failure.reason,
    });
  }

  /** 计数。 */
  private count(metric: string, outcome: string): void {
    this.options.telemetry.counter(metric, { description: METRIC_DESCRIPTIONS[metric] ?? metric }).add(1, { outcome });
  }
}
