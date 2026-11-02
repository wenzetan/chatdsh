/**
 * 录音的界面状态：权限、录制、暂停、停止、上传、转写、失败与取消。
 *
 * 录音先说明用途再请求麦克风；权限被拒绝时停在拒绝状态并给出重新请求的入口。停止之后
 * 先可试听、再上传、再转写；转写能力不可用时按宿主给出的原因停在不可用状态，录音本身
 * 仍然保留。取消会标记资源已经释放，并让上传与转写请求不再继续。
 * @module @chatdsh/client-workspace-tools/voice
 */

import { WorkspaceClientError, type RecordingRecord, type TranscriptionCapability } from './types.ts';

/** 录音状态。 */
export const RECORDING_STATES = [
  'idle',
  'permission-pending',
  'denied',
  'recording',
  'paused',
  'stopped',
  'uploading',
  'transcribing',
  'transcribed',
  'transcription-unavailable',
  'failed',
  'cancelled',
] as const;

/** 录音状态取值。 */
export type RecordingState = (typeof RECORDING_STATES)[number];

/** 状态说明。 */
export const RECORDING_STATE_TEXT: Readonly<Record<RecordingState, string>> = {
  idle: '没有录音',
  'permission-pending': '正在请求麦克风权限',
  denied: '麦克风权限被拒绝',
  recording: '正在录制',
  paused: '录制已暂停',
  stopped: '录制已停止，可以试听',
  uploading: '正在上传录音',
  transcribing: '正在转写',
  transcribed: '转写完成，请确认后插入',
  'transcription-unavailable': '当前部署没有转写能力',
  failed: '录音上传失败，可以重试',
  cancelled: '录音已取消',
};

/** 录音用途说明，请求权限之前展示。 */
export const RECORDING_PURPOSE_TEXT = '这段录音会先上传到运行时，再交给部署里的语音识别接口转写成文字；没有转写能力时只保存录音。';

/**
 * 把毫秒时长格式化成 `分:秒`。
 * @param durationMs - 毫秒。
 * @returns `分:秒` 文本。
 */
export function durationText(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 录音主按钮。 */
export interface RecordingAction {
  readonly label: string;
  readonly action: 'request-permission' | 'pause' | 'resume' | 'stop' | 'reset' | 'upload' | 'retry-upload' | 'cancel-transcription' | 'none';
}

/**
 * 录音控制器。
 */
export class VoiceRecorder {
  private readonly capability: TranscriptionCapability;
  private status: RecordingState = 'idle';
  private elapsedMs = 0;
  private deniedReasonValue: string | undefined;
  private transcriptionReasonValue: string | undefined;
  private transcriptValue = '';
  private recordingValue: RecordingRecord | undefined;
  private failureValue: string | undefined;
  private released = false;

  /**
   * @param capability - 宿主回报的转写能力。
   */
  constructor(capability: TranscriptionCapability) {
    this.capability = capability;
  }

  /** 当前状态。 */
  get state(): RecordingState {
    return this.status;
  }

  /** 状态说明。 */
  get stateText(): string {
    return RECORDING_STATE_TEXT[this.status];
  }

  /** 当前累计时长，毫秒。 */
  get durationMs(): number {
    return this.elapsedMs;
  }

  /** 当前累计时长文本。 */
  get duration(): string {
    return durationText(this.elapsedMs);
  }

  /** 用途说明。 */
  get purpose(): string {
    return RECORDING_PURPOSE_TEXT;
  }

  /** 权限被拒绝的原因。 */
  get deniedReason(): string | undefined {
    return this.deniedReasonValue;
  }

  /** 转写不可用的原因。 */
  get transcriptionReason(): string | undefined {
    return this.transcriptionReasonValue;
  }

  /** 当前转写文本。 */
  get transcript(): string {
    return this.transcriptValue;
  }

  /** 最近一次上传得到的录音记录。 */
  get recording(): RecordingRecord | undefined {
    return this.recordingValue;
  }

  /** 最近一次失败说明。 */
  get failure(): string | undefined {
    return this.failureValue;
  }

  /** 资源是否已经释放。 */
  get resourcesReleased(): boolean {
    return this.released;
  }

  /** 转写能力是否可用。 */
  get transcriptionAvailable(): boolean {
    return this.capability.available;
  }

  /** 主按钮的可访问名称。 */
  get ariaLabel(): string {
    return `录音：${this.primaryAction().label}`;
  }

  /**
   * 主按钮的当前动作。
   * @returns 标签与动作名。
   */
  primaryAction(): RecordingAction {
    switch (this.status) {
      case 'idle':
      case 'cancelled':
        return { label: '开始录音', action: 'request-permission' };
      case 'denied':
        return { label: '重新请求麦克风权限', action: 'request-permission' };
      case 'permission-pending':
        return { label: '正在请求权限', action: 'none' };
      case 'recording':
        return { label: '暂停录音', action: 'pause' };
      case 'paused':
        return { label: '继续录音', action: 'resume' };
      case 'stopped':
        return { label: '上传录音', action: 'upload' };
      case 'uploading':
        return { label: '正在上传', action: 'none' };
      case 'transcribing':
        return { label: '取消转写', action: 'cancel-transcription' };
      case 'transcribed':
        return { label: '重新录制', action: 'reset' };
      case 'transcription-unavailable':
        return { label: '重新录制', action: 'reset' };
      case 'failed':
        return { label: '重试上传', action: 'retry-upload' };
    }
  }

  /** 请求麦克风权限。 */
  requestPermission(): void {
    if (this.status !== 'idle' && this.status !== 'cancelled' && this.status !== 'denied') {
      throw new WorkspaceClientError('recording-state-invalid', `当前状态 ${this.status} 不能重新请求权限`);
    }
    this.status = 'permission-pending';
    this.deniedReasonValue = undefined;
    this.failureValue = undefined;
  }

  /** 权限获批，开始录制。 */
  permissionGranted(): void {
    if (this.status !== 'permission-pending') {
      throw new WorkspaceClientError('recording-state-invalid', '没有待处理的权限请求');
    }
    this.status = 'recording';
    this.elapsedMs = 0;
    this.released = false;
  }

  /**
   * 权限被拒绝。
   * @param reason - 浏览器给出的原因说明。
   */
  permissionDenied(reason: string): void {
    if (this.status !== 'permission-pending') {
      throw new WorkspaceClientError('recording-state-invalid', '没有待处理的权限请求');
    }
    this.status = 'denied';
    this.deniedReasonValue = reason;
  }

  /** 暂停录制。 */
  pause(): void {
    if (this.status !== 'recording') throw new WorkspaceClientError('recording-state-invalid', '当前没有在录制');
    this.status = 'paused';
  }

  /** 继续录制。 */
  resume(): void {
    if (this.status !== 'paused') throw new WorkspaceClientError('recording-state-invalid', '录制没有暂停');
    this.status = 'recording';
  }

  /**
   * 累计录制时长。
   * @param deltaMs - 新增毫秒。
   */
  tick(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new WorkspaceClientError('recording-tick-invalid', '录制时长增量必须是非负数');
    if (this.status !== 'recording') return;
    this.elapsedMs += deltaMs;
  }

  /** 停止录制。 */
  stop(): void {
    if (this.status !== 'recording' && this.status !== 'paused') {
      throw new WorkspaceClientError('recording-state-invalid', '当前没有录制可以停止');
    }
    this.status = 'stopped';
  }

  /** 重新录制：清空时长、上传结果与转写文本。 */
  reset(): void {
    if (this.status === 'recording' || this.status === 'paused') {
      throw new WorkspaceClientError('recording-state-invalid', '录制中没有停止，不能重新录制');
    }
    this.status = 'idle';
    this.elapsedMs = 0;
    this.transcriptValue = '';
    this.recordingValue = undefined;
    this.failureValue = undefined;
    this.transcriptionReasonValue = undefined;
  }

  /** 开始上传。 */
  uploadBegin(): void {
    if (this.status !== 'stopped' && this.status !== 'failed') {
      throw new WorkspaceClientError('recording-state-invalid', '只有停止后的录音可以上传');
    }
    this.status = 'uploading';
    this.failureValue = undefined;
  }

  /**
   * 上传完成。
   * @param record - 宿主返回的录音记录。
   */
  uploadComplete(record: RecordingRecord): void {
    if (this.status !== 'uploading') throw new WorkspaceClientError('recording-state-invalid', '没有正在上传的录音');
    this.recordingValue = record;
    this.status = 'stopped';
  }

  /**
   * 上传失败。
   * @param reason - 失败说明。
   */
  uploadFailed(reason: string): void {
    if (this.status !== 'uploading') throw new WorkspaceClientError('recording-state-invalid', '没有正在上传的录音');
    this.status = 'failed';
    this.failureValue = reason;
  }

  /**
   * 请求转写。
   * @returns 是否进入转写；能力不可用时给出原因。
   */
  beginTranscription(): { readonly available: boolean; readonly reason?: string } {
    if (this.recordingValue === undefined) {
      throw new WorkspaceClientError('recording-not-uploaded', '录音还没有上传，不能转写');
    }
    if (!this.capability.available) {
      this.status = 'transcription-unavailable';
      this.transcriptionReasonValue = this.capability.reason ?? '当前部署没有装载转写能力';
      return { available: false, reason: this.transcriptionReasonValue };
    }
    this.status = 'transcribing';
    this.failureValue = undefined;
    return { available: true };
  }

  /**
   * 转写完成。
   * @param text - 转写文本。
   */
  transcriptionComplete(text: string): void {
    if (this.status !== 'transcribing') throw new WorkspaceClientError('recording-state-invalid', '没有正在进行的转写');
    if (text.trim() === '') throw new WorkspaceClientError('transcription-empty', '转写结果是空文本');
    this.transcriptValue = text;
    this.status = 'transcribed';
  }

  /**
   * 转写失败。
   * @param reason - 失败说明。
   */
  transcriptionFailed(reason: string): void {
    if (this.status !== 'transcribing') throw new WorkspaceClientError('recording-state-invalid', '没有正在进行的转写');
    this.status = 'failed';
    this.failureValue = reason;
    this.transcriptionReasonValue = reason;
  }

  /** 取消转写请求，回到可以再次请求的状态。 */
  cancelTranscription(): void {
    if (this.status !== 'transcribing') throw new WorkspaceClientError('recording-state-invalid', '没有正在进行的转写');
    this.status = 'stopped';
  }

  /**
   * 编辑转写文本。
   * @param text - 用户改过的文本。
   */
  editTranscript(text: string): void {
    if (this.status !== 'transcribed') throw new WorkspaceClientError('recording-state-invalid', '转写还没有完成');
    this.transcriptValue = text;
  }

  /** 取消录音并释放资源。 */
  cancel(): void {
    if (this.status === 'transcribing') throw new WorkspaceClientError('recording-state-invalid', '转写进行中，请先取消转写');
    this.status = 'cancelled';
    this.released = true;
    this.elapsedMs = 0;
    this.failureValue = undefined;
  }
}
