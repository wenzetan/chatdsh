/**
 * 工作区工具的界面：文件浏览、附件列表与录音区，外加独立的终端展示视图。
 *
 * 文件区把目录树、路径输入与预览放在一起：树用共享组件，键盘导航与焦点由它负责；预览按
 * 文本、图片、超大与失败四种分支显示，失败提示带错误码与重试入口。附件区显示每个条目的
 * 名称、类型、大小、进度与状态，未完成或失败的条目会拦住发送。录音区先说明用途再请求
 * 麦克风，权限被拒绝、设备缺失、转写不可用分别显示。终端视图只渲染命令、输出与提示三类
 * 条目，命令与输出分开，读屏按条目朗读。
 * @module @chatdsh/client-workspace-tools/panel
 */

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  FileTree,
  Panel,
  ProgressBar,
  ScrollRegion,
  StatusLine,
} from '@chatdsh/core-ui-kit';
import {
  AttachmentUploader,
  UPLOAD_STATE_TEXT,
  type RejectedFile,
  type UploadSlot,
} from './attachments.ts';
import {
  FileTreeModel,
  TEXT_PREVIEW_MAX_LINES,
  classifyPreview,
  describeFileFailure,
  mimeTypeOfName,
  textLines,
  type FileFailure,
  type WorkspaceTreeNode,
} from './files.ts';
import { TERMINAL_STATUS_TEXT, TerminalSession, announcementOf, type TerminalEntry } from './terminal.ts';
import { VoiceRecorder, durationText } from './voice.ts';
import type {
  AttachmentLimits,
  RecordingRecord,
  TranscriptionCapability,
  WorkspaceGateway,
} from './types.ts';

/** 预览状态。 */
type PreviewState =
  | { readonly kind: 'empty' }
  | {
    readonly kind: 'text';
    readonly path: string;
    readonly mediaType: string;
    readonly bytes?: number;
    readonly eof: boolean;
    readonly lines: readonly { readonly number: number; readonly text: string }[];
  }
  | { readonly kind: 'image'; readonly path: string; readonly dataUrl: string; readonly bytes?: number }
  | { readonly kind: 'notice'; readonly path: string; readonly branch: 'too-large' | 'binary'; readonly notice: string; readonly limitBytes: number }
  | { readonly kind: 'failure'; readonly path: string; readonly failure: FileFailure };

/** 附件区属性。 */
export interface AttachmentSectionProps {
  readonly gateway: WorkspaceGateway;
  readonly sessionId: string;
  /** 输入区；插入附件的引用标记。 */
  readonly composerTarget?: { insert(text: string): void };
  /** 插入后的回调，供外壳同步字数与草稿。 */
  readonly onInserted?: (text: string) => void;
}

/**
 * 把文件内容读成 base64。
 * @param file - 浏览器文件对象。
 * @returns base64 文本。
 */
async function readBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const window = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += window) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + window));
  }
  return btoa(binary);
}

/** 文件浏览区属性。 */
export interface FileBrowserProps {
  readonly gateway: WorkspaceGateway;
}

/**
 * 文件浏览区：目录树、路径输入、文本与图片预览。
 * @param props - 数据入口。
 * @returns 文件浏览区。
 */
export function FileBrowser({ gateway }: FileBrowserProps) {
  const model = useRef(new FileTreeModel()).current;
  const [nodes, setNodes] = useState<WorkspaceTreeNode[]>([]);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<FileFailure | undefined>(undefined);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'empty' });
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(false);
  const previewId = useId();

  const applyNodes = useCallback(() => {
    setNodes(model.treeNodes());
  }, [model]);

  const openFile = useCallback(async (path: string) => {
    const entry = model.entryOf(path);
    const classification = classifyPreview({ name: entry.name, size: entry.size, mimeType: mimeTypeOfName(entry.name) });
    if (classification.branch === 'too-large' || classification.branch === 'binary') {
      setPreview({
        kind: 'notice',
        path,
        branch: classification.branch,
        notice: classification.notice ?? '',
        limitBytes: classification.limitBytes,
      });
      return;
    }
    setLoading(true);
    setFailure(undefined);
    try {
      if (classification.branch === 'image') {
        const page = await gateway.readBytes(path);
        setPreview({
          kind: 'image',
          path,
          dataUrl: `data:${mimeTypeOfName(entry.name)};base64,${page.base64}`,
          ...(page.bytes === undefined ? {} : { bytes: page.bytes }),
        });
      } else {
        const page = await gateway.readText(path);
        setPreview({
          kind: 'text',
          path,
          mediaType: mimeTypeOfName(entry.name) || 'text/plain',
          ...(page.bytes === undefined ? {} : { bytes: page.bytes }),
          eof: page.eof,
          lines: textLines(page.text),
        });
      }
    } catch (error) {
      setFailure(describeFileFailure(error));
    } finally {
      setLoading(false);
    }
  }, [gateway, model]);

  const refreshRoot = useCallback(async () => {
    setLoading(true);
    setStatus('正在读取目录');
    setFailure(undefined);
    try {
      const listing = await gateway.listDirectory('');
      model.setRoot(listing);
      applyNodes();
      setExpanded([]);
      setStatus(
        listing.truncated
          ? `目录条目超过上限，只列出前 ${String(listing.entries.length)} 项`
          : `已列出 ${String(listing.entries.length)} 项`,
      );
    } catch (error) {
      const described = describeFileFailure(error);
      setFailure(described);
      setStatus(undefined);
    } finally {
      setLoading(false);
    }
  }, [applyNodes, gateway, model]);

  useEffect(() => {
    void refreshRoot();
  }, [refreshRoot]);

  const expandDirectory = useCallback(async (path: string) => {
    model.beginLoad(path);
    try {
      const listing = await gateway.listDirectory(path);
      model.finishLoad(path, listing);
      applyNodes();
    } catch (error) {
      model.failLoad(path, error);
      setFailure(describeFileFailure(error));
    }
  }, [applyNodes, gateway, model]);

  const onExpandedChange = useCallback((ids: readonly string[]) => {
    for (const id of expanded) {
      if (!ids.includes(id)) model.collapse(id);
    }
    setExpanded(ids);
    for (const id of ids) {
      if (!expanded.includes(id)) void expandDirectory(id);
    }
  }, [expandDirectory, expanded, model]);

  const onSelect = useCallback((id: string) => {
    model.select(id);
    setSelected(id);
    const entry = model.entryOf(id);
    if (entry.type === 'directory') {
      if (!expanded.includes(id)) onExpandedChange([...expanded, id]);
      return;
    }
    void openFile(id);
  }, [expanded, model, onExpandedChange, openFile]);

  const openTypedPath = useCallback(async () => {
    const path = pathInput.trim();
    if (path === '') return;
    const name = path.split('/').at(-1) ?? path;
    const stat = await gateway.stat(path).catch(() => undefined);
    const classification = classifyPreview({ name, mimeType: mimeTypeOfName(name), ...(stat?.bytes === undefined ? {} : { size: stat.bytes }) });
    if (classification.branch === 'too-large' || classification.branch === 'binary') {
      setPreview({ kind: 'notice', path, branch: classification.branch, notice: classification.notice ?? '', limitBytes: classification.limitBytes });
      return;
    }
    setLoading(true);
    setFailure(undefined);
    try {
      if (classification.branch === 'image') {
        const page = await gateway.readBytes(path);
        setPreview({
          kind: 'image',
          path,
          dataUrl: `data:${mimeTypeOfName(name)};base64,${page.base64}`,
          ...(page.bytes === undefined ? {} : { bytes: page.bytes }),
        });
      } else {
        const page = await gateway.readText(path);
        setPreview({
          kind: 'text',
          path,
          mediaType: mimeTypeOfName(name) || 'text/plain',
          ...(page.bytes === undefined ? {} : { bytes: page.bytes }),
          eof: page.eof,
          lines: textLines(page.text),
        });
      }
    } catch (error) {
      setPreview({ kind: 'failure', path, failure: describeFileFailure(error) });
    } finally {
      setLoading(false);
    }
  }, [gateway, pathInput]);

  return <Panel title="文件" subtitle="工作区目录与只读预览">
    <div className="chdsh-wp14__toolbar">
      <Button onClick={() => void refreshRoot()} data-action="tree-refresh">刷新目录</Button>
      <input
        className="chdsh-wp14__path"
        aria-label="文件路径"
        placeholder="工作区相对路径，例如 src/main.ts"
        value={pathInput}
        onChange={(event) => setPathInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void openTypedPath();
        }}
        data-field="path"
      />
      <Button onClick={() => void openTypedPath()} data-action="path-open">打开路径</Button>
    </div>
    {loading ? <StatusLine>正在加载</StatusLine> : null}
    {status === undefined ? null : <StatusLine>{status}</StatusLine>}
    {nodes.length === 0
      ? <EmptyState>工作区还没有文件</EmptyState>
      : <ScrollRegion label="工作区文件">
        <FileTree
          label="工作区文件"
          nodes={nodes}
          expandedIds={expanded}
          {...(selected === undefined ? {} : { selectedId: selected })}
          onExpandedChange={onExpandedChange}
          onSelect={onSelect}
        />
      </ScrollRegion>}
    {failure === undefined
      ? null
      : <ErrorNote>
        {failure.message}
        {failure.retryable ? ' 可以重新尝试。' : ''}
      </ErrorNote>}
    <section className="chdsh-wp14__preview" aria-live="polite" aria-label="文件预览" id={previewId}>
      {preview.kind === 'empty' ? <EmptyState>从目录树选择文件，或者输入路径打开</EmptyState> : null}
      {preview.kind === 'text' ? <>
        <p className="chdsh-wp14__meta" data-preview-meta>
          <span>{preview.path}</span>
          <Badge tone="neutral">只读</Badge>
          <span>{preview.mediaType}</span>
          <span>UTF-8</span>
          {preview.bytes === undefined ? null : <span>{preview.bytes} 字节</span>}
          <span>{preview.eof ? '已到文件末尾' : `最多显示 ${String(TEXT_PREVIEW_MAX_LINES)} 行`}</span>
        </p>
        <ScrollRegion label="文件内容">
          <ol className="chdsh-wp14__lines" data-text-preview>
            {preview.lines.map((line) => <li key={line.number} data-line={line.number}>
              <span className="chdsh-wp14__lineno" aria-hidden="true">{line.number}</span>
              <span className="chdsh-wp14__linetext">{line.text}</span>
            </li>)}
          </ol>
        </ScrollRegion>
      </> : null}
      {preview.kind === 'image' ? <>
        <p className="chdsh-wp14__meta">
          <span>{preview.path}</span>
          <Badge tone="neutral">只读</Badge>
          {preview.bytes === undefined ? null : <span>{preview.bytes} 字节</span>}
        </p>
        <img className="chdsh-wp14__image" src={preview.dataUrl} alt={`${preview.path} 的图片预览`} data-image-preview />
      </> : null}
      {preview.kind === 'notice' ? <ErrorNote>
        {preview.path}：{preview.notice}
      </ErrorNote> : null}
      {preview.kind === 'failure' ? <ErrorNote>
        {preview.path}：{preview.failure.message}（{preview.failure.code}）
      </ErrorNote> : null}
    </section>
  </Panel>;
}

/**
 * 附件区：选择、校验、进度、重试、取消与插入引用。
 * @param props - 数据入口、会话与输入区。
 * @returns 附件区。
 */
export function AttachmentSection({ gateway, sessionId, composerTarget, onInserted }: AttachmentSectionProps) {
  const [limits, setLimits] = useState<AttachmentLimits | undefined>(undefined);
  const uploaderRef = useRef<AttachmentUploader | undefined>(undefined);
  const filesRef = useRef(new Map<string, File>());
  const [slots, setSlots] = useState<readonly UploadSlot[]>([]);
  const [rejected, setRejected] = useState<readonly RejectedFile[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [limitsFailure, setLimitsFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void gateway.attachmentLimits().then((value) => {
      if (cancelled) return;
      uploaderRef.current = new AttachmentUploader(value);
      setLimits(value);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setLimitsFailure(error instanceof Error ? error.message : '附件上限读取失败');
    });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  const sync = useCallback(() => {
    const uploader = uploaderRef.current;
    if (uploader === undefined) return;
    setSlots([...uploader.state]);
  }, []);

  const uploadSlot = useCallback(async (slotId: string, retry: boolean) => {
    const uploader = uploaderRef.current;
    const file = filesRef.current.get(slotId);
    if (uploader === undefined || file === undefined) return;
    if (retry) uploader.retry(slotId);
    else uploader.begin(slotId);
    sync();
    try {
      const record = await gateway.uploadAttachment({
        sessionId,
        filename: file.name,
        mimeType: (file.type.split(';')[0] ?? '').trim().toLowerCase(),
        base64: await readBase64(file),
      });
      uploader.complete(slotId, record);
      sync();
      if (composerTarget !== undefined) {
        const token = uploader.insertReference(composerTarget, slotId);
        onInserted?.(token);
        setNotice(`已插入引用 ${token}`);
      }
    } catch (error) {
      uploader.fail(slotId, error);
      sync();
    }
  }, [composerTarget, gateway, onInserted, sessionId, sync]);

  const onFiles = useCallback(async (files: readonly File[]) => {
    const uploader = uploaderRef.current;
    if (uploader === undefined) return;
    const result = uploader.select(files.map((file) => ({ name: file.name, type: file.type, size: file.size })));
    setRejected(result.rejected);
    sync();
    for (const slot of result.accepted) {
      const file = files.find((item) => item.name === slot.filename && item.size === slot.size);
      if (file === undefined) continue;
      filesRef.current.set(slot.id, file);
      await uploadSlot(slot.id, false);
    }
  }, [sync, uploadSlot]);

  const sendCheck = uploaderRef.current?.sendCheck() ?? { canSend: false, blockers: ['attachment-pending'], reason: '附件上限读取中' };

  return <Panel title="附件" subtitle="上传未完成或失败会阻止发送" count={slots.length}>
    {limitsFailure === undefined ? null : <ErrorNote>{limitsFailure}</ErrorNote>}
    <div className="chdsh-wp14__toolbar">
      <label className="chdsh-wp14__filelabel">
        选择附件
        <input
          type="file"
          multiple
          aria-label="选择附件"
          disabled={limits === undefined}
          onChange={(event) => {
            const files = event.target.files === null ? [] : [...event.target.files];
            void onFiles(files);
            event.target.value = '';
          }}
          data-field="attachment-input"
        />
      </label>
      {limits === undefined ? null : <StatusLine>
        单个附件最多 {limits.maxBytes} 字节，单条消息最多 {limits.maxPerMessage} 个附件
      </StatusLine>}
    </div>
    {rejected.length === 0 ? null : <ul className="chdsh-wp14__rejected" role="alert" aria-label="被拒绝的附件">
      {rejected.map((item) => <li key={`${item.filename}-${item.code}`} data-rejected-code={item.code}>
        {item.message}
      </li>)}
    </ul>}
    <ul className="chdsh-wp14__attachments" aria-label="附件列表">
      {slots.map((slot) => <li key={slot.id} className="chdsh-wp14__attachment" tabIndex={0} data-attachment-state={slot.state} data-attachment-id={slot.id}>
        <span>{slot.filename} · {slot.mimeType} · {slot.size} 字节 · {UPLOAD_STATE_TEXT[slot.state]}</span>
        {slot.state === 'uploading' && slot.progress === 0
          ? <progress aria-label={`${slot.filename} 上传进度`} />
          : <ProgressBar ratio={slot.progress} label={`${slot.filename} 上传进度`} />}
        {slot.failure === undefined ? null : <span className="chdsh-wp14__failure">{slot.failure.message}</span>}
        <span className="chdsh-wp14__actions">
          {slot.state === 'failed' ? <Button onClick={() => void uploadSlot(slot.id, true)} data-action="attachment-retry">重新上传</Button> : null}
          <Button onClick={() => {
            const uploader = uploaderRef.current;
            if (uploader === undefined) return;
            uploader.cancel(slot.id);
            sync();
          }} data-action="attachment-cancel">取消</Button>
          <Button onClick={() => {
            const uploader = uploaderRef.current;
            if (uploader === undefined) return;
            uploader.remove(slot.id);
            filesRef.current.delete(slot.id);
            sync();
          }} data-action="attachment-remove">移除</Button>
          {composerTarget === undefined ? null : <Button onClick={() => {
            const uploader = uploaderRef.current;
            if (uploader === undefined) return;
            try {
              const token = uploader.insertReference(composerTarget, slot.id);
              onInserted?.(token);
              setNotice(`已插入引用 ${token}`);
            } catch (error) {
              setNotice(error instanceof Error ? error.message : '插入失败');
            }
          }} data-action="attachment-insert">插入引用</Button>}
        </span>
      </li>)}
    </ul>
    {slots.length === 0 ? <EmptyState>还没有附件</EmptyState> : null}
    <p className="chdsh-wp14__meta" data-can-send={sendCheck.canSend ? 'true' : 'false'}>
      {sendCheck.canSend ? '附件都已上传完成，可以发送' : sendCheck.reason}
    </p>
    {notice === undefined ? null : <p role="status">{notice}</p>}
  </Panel>;
}

/** 录音区属性。 */
export interface VoiceSectionProps {
  readonly gateway: WorkspaceGateway;
  readonly sessionId: string;
  readonly onInsertText?: (text: string) => void;
}

/**
 * 录音区：用途说明、权限、录制状态、上传、转写与取消。
 * @param props - 数据入口、会话与插入回调。
 * @returns 录音区。
 */
export function VoiceSection({ gateway, sessionId, onInsertText }: VoiceSectionProps) {
  const [capability, setCapability] = useState<TranscriptionCapability | undefined>(undefined);
  const [capabilityFailure, setCapabilityFailure] = useState<string | undefined>(undefined);
  const recorderRef = useRef<VoiceRecorder | undefined>(undefined);
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const mediaRef = useRef<MediaRecorder | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | undefined>(undefined);
  const purposeId = useId();

  useEffect(() => {
    let cancelled = false;
    void gateway.voiceCapability().then((value) => {
      if (cancelled) return;
      setCapability(value);
      recorderRef.current = new VoiceRecorder(value);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setCapabilityFailure(error instanceof Error ? error.message : '转写能力读取失败');
    });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  const stopTracks = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = undefined;
    if (timerRef.current !== undefined) {
      window.clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const start = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder === undefined) return;
    setFailure(undefined);
    recorder.requestPermission();
    refresh();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      const reason = error instanceof Error ? error.message : '麦克风不可用';
      recorder.permissionDenied(denied ? `浏览器拒绝了麦克风权限：${reason}` : `没有可用的麦克风输入：${reason}`);
      setFailure(recorder.deniedReason ?? reason);
      refresh();
      return;
    }
    streamRef.current = stream;
    recorder.permissionGranted();
    const media = new MediaRecorder(stream);
    chunksRef.current = [];
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    media.start();
    mediaRef.current = media;
    timerRef.current = window.setInterval(() => {
      recorder.tick(1000);
      refresh();
    }, 1000);
    refresh();
  }, [refresh]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    const media = mediaRef.current;
    if (recorder === undefined || media === undefined) return;
    media.stop();
    streamRef.current?.getAudioTracks().forEach((track) => {
      if (track.readyState === 'live') track.enabled = false;
    });
    stopTracks();
    recorder.stop();
    refresh();
  }, [refresh, stopTracks]);

  const upload = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder === undefined) return;
    const blob = new Blob(chunksRef.current, { type: mediaRef.current?.mimeType ?? 'audio/webm' });
    recorder.uploadBegin();
    refresh();
    let record: RecordingRecord;
    try {
      record = await gateway.uploadRecording({
        sessionId,
        mimeType: blob.type,
        durationMs: recorder.durationMs,
        base64: await readBase64(new File([blob], 'recording.webm', { type: blob.type })),
      });
      recorder.uploadComplete(record);
      refresh();
    } catch (error) {
      recorder.uploadFailed(error instanceof Error ? error.message : '录音上传失败');
      setFailure(recorder.failure ?? '录音上传失败');
      refresh();
      return;
    }
    const started = recorder.beginTranscription();
    refresh();
    if (!started.available) return;
    try {
      const result = await gateway.transcribeRecording(record.id, {});
      recorder.transcriptionComplete(result.text);
      refresh();
    } catch (error) {
      recorder.transcriptionFailed(error instanceof Error ? error.message : '转写失败');
      setFailure(recorder.failure ?? '转写失败');
      refresh();
    }
  }, [gateway, refresh, sessionId]);

  const recorder = recorderRef.current;
  if (capabilityFailure !== undefined) {
    return <Panel title="录音" subtitle="录制、上传与转写">
      <ErrorNote>{capabilityFailure}</ErrorNote>
    </Panel>;
  }
  if (recorder === undefined) {
    return <Panel title="录音" subtitle="录制、上传与转写">
      <StatusLine>正在读取转写能力</StatusLine>
    </Panel>;
  }
  const action = recorder.primaryAction();
  return <Panel title="录音" subtitle="先说明用途，再请求麦克风权限" >
    <p id={purposeId} className="chdsh-wp14__purpose">{recorder.purpose}</p>
    {capability?.available === true
      ? <StatusLine>转写提供方：{capability.providerId}</StatusLine>
      : <StatusLine tone="danger">当前部署没有转写能力：{capability?.reason}</StatusLine>}
    <div className="chdsh-wp14__toolbar">
      <Button
        tone={recorder.state === 'recording' ? 'danger' : 'default'}
        aria-label={recorder.ariaLabel}
        aria-describedby={purposeId}
        data-action="recording-primary"
        onClick={() => {
          if (action.action === 'request-permission') void start();
          else if (action.action === 'pause') {
            mediaRef.current?.pause();
            recorder.pause();
            refresh();
          } else if (action.action === 'resume') {
            mediaRef.current?.resume();
            recorder.resume();
            refresh();
          } else if (action.action === 'upload' || action.action === 'retry-upload') {
            void upload();
          } else if (action.action === 'reset') {
            recorder.reset();
            refresh();
          } else if (action.action === 'cancel-transcription') {
            recorder.cancelTranscription();
            refresh();
          }
        }}
      >{action.label}</Button>
      {recorder.state === 'recording' || recorder.state === 'paused'
        ? <Button onClick={stop} aria-label="停止录音并可以试听" data-action="recording-stop">停止录音</Button>
        : null}
      <Button onClick={() => {
        stopTracks();
        if (mediaRef.current?.state === 'recording') mediaRef.current.stop();
        recorder.cancel();
        refresh();
      }} data-action="recording-cancel">取消录音</Button>
      <span data-recording-state>{recorder.stateText}</span>
      <span data-recording-duration>{durationText(recorder.durationMs)}</span>
    </div>
    {recorder.deniedReason === undefined ? null : <ErrorNote>{recorder.deniedReason}</ErrorNote>}
    {recorder.transcriptionReason === undefined ? null : <ErrorNote>{recorder.transcriptionReason}</ErrorNote>}
    {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
    {recorder.transcript === '' ? null : <>
      <label className="chdsh-wp14__field" htmlFor={`${purposeId}-transcript`}>转写文本</label>
      <textarea
        id={`${purposeId}-transcript`}
        aria-label="转写文本"
        value={recorder.transcript}
        onChange={(event) => {
          recorder.editTranscript(event.target.value);
          refresh();
        }}
        rows={4}
      />
      <Button onClick={() => onInsertText?.(recorder.transcript)} data-action="transcript-insert">确认插入</Button>
    </>}
    {recorder.state === 'cancelled' ? <StatusLine>录音已取消，麦克风与定时器已经释放</StatusLine> : null}
  </Panel>;
}

/** 终端视图属性。 */
export interface TerminalViewProps {
  readonly session: TerminalSession;
  /** 提交命令之后交给宿主的回调。 */
  readonly onCommand?: (command: string) => void;
  readonly onReconnect?: () => void;
  readonly onClose?: (confirm: boolean) => void;
}

/**
 * 终端视图：状态、命令条目、输出条目与提示。
 * @param props - 会话与回调。
 * @returns 终端视图。
 */
export function TerminalView({ session, onCommand, onReconnect, onClose }: TerminalViewProps) {
  const [command, setCommand] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<readonly TerminalEntry[]>(session.output);
  const [status, setStatus] = useState(session.state);
  const [confirming, setConfirming] = useState(false);
  const inputId = useId();
  const sync = useCallback(() => {
    setEntries([...session.output]);
    setStatus(session.state);
  }, [session]);
  return <Panel title="终端" subtitle={`${session.id} · ${session.cwd}`}>
    <p className="chdsh-wp14__meta">
      <span data-terminal-status>{TERMINAL_STATUS_TEXT[status]}</span>
      <span>{session.cwd}</span>
    </p>
    <div className="chdsh-wp14__toolbar">
      <Button onClick={() => {
        try {
          const result = session.reconnect();
          onReconnect?.();
          setFailure(result.notice);
          sync();
        } catch (error) {
          setFailure(error instanceof Error ? error.message : '重连失败');
        }
      }} data-action="terminal-reconnect">重新连接</Button>
      <Button onClick={() => setConfirming(true)} data-action="terminal-close">关闭终端</Button>
    </div>
    <Dialog
      open={confirming}
      title="关闭终端"
      description="关闭仍然连接的终端会终止其中正在运行的进程，命令历史保留在当前页面。"
      onClose={() => setConfirming(false)}
    >
      <div className="chdsh-wp14__toolbar">
        <Button tone="danger" onClick={() => {
          try {
            session.close(true);
            onClose?.(true);
            setConfirming(false);
            sync();
          } catch (error) {
            setFailure(error instanceof Error ? error.message : '关闭失败');
          }
        }} data-action="terminal-close-confirm">终止进程并关闭</Button>
        <Button onClick={() => setConfirming(false)} data-action="terminal-close-cancel">保留终端</Button>
      </div>
    </Dialog>
    <ScrollRegion label="终端输出">
      <ol className="chdsh-wp14__terminal" data-terminal-entries>
        {entries.map((entry, index) => <li key={`${entry.kind}-${String(index)}`} data-terminal-kind={entry.kind}>
          <span className="chdsh-wp14__lineno" aria-hidden="true">{entry.kind === 'command' ? '$' : entry.kind === 'notice' ? '!' : '›'}</span>
          <span>{entry.text}</span>
          <span className="chdsh-wp14__sr">{announcementOf(entry)}</span>
        </li>)}
      </ol>
    </ScrollRegion>
    {entries.length === 0 ? <EmptyState>还没有终端输出</EmptyState> : null}
    <form className="chdsh-wp14__toolbar" onSubmit={(event) => {
      event.preventDefault();
      try {
        session.submit(command);
        onCommand?.(command);
        setCommand('');
        setFailure(undefined);
        sync();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : '命令没有提交');
      }
    }}>
      <label htmlFor={inputId} className="chdsh-wp14__sr">终端命令</label>
      <input id={inputId} aria-label="终端命令" value={command} onChange={(event) => setCommand(event.target.value)} data-field="terminal-command" />
      <Button type="submit" data-action="terminal-submit">运行</Button>
    </form>
    {failure === undefined ? null : <StatusLine tone="danger">{failure}</StatusLine>}
  </Panel>;
}

/** 工作区面板属性。 */
export interface WorkspacePanelProps {
  readonly gateway: WorkspaceGateway;
  readonly sessionId: string;
  readonly composerTarget?: { insert(text: string): void };
  readonly onInsertText?: (text: string) => void;
  /** 终端区域；由外壳把上游终端会话接进来。 */
  readonly terminal?: ReactNode;
}

/**
 * 工作区面板：文件、附件、录音与可选的终端。
 * @param props - 数据入口、会话与插入回调。
 * @returns 工作区面板。
 */
export function WorkspacePanel({ gateway, sessionId, composerTarget, onInsertText, terminal }: WorkspacePanelProps) {
  const sections = useMemo(() => ({ gateway, sessionId }), [gateway, sessionId]);
  return <div className="chdsh-wp14">
    <FileBrowser gateway={sections.gateway} />
    {terminal}
    <AttachmentSection
      gateway={sections.gateway}
      sessionId={sections.sessionId}
      {...(composerTarget === undefined ? {} : { composerTarget })}
      {...(onInsertText === undefined ? {} : { onInserted: onInsertText })}
    />
    <VoiceSection
      gateway={sections.gateway}
      sessionId={sections.sessionId}
      {...(onInsertText === undefined ? {} : { onInsertText })}
    />
  </div>;
}
