/**
 * 连接器表单：条件字段、参数编辑、名称唯一校验与错误摘要。
 *
 * 传输方式决定显示哪一组字段：stdio 显示命令与参数，http 显示地址；切换传输方式时清空另一
 * 组字段，提交时两者互斥校验。参数按 JSON 字符串数组填写，用 `JSON.parse` 展开。凭据一栏只
 * 接受环境变量名：值从本机环境读取，界面不回显也不保存值。
 *
 * 键盘与焦点：对话框使用原生 `dialog` 的焦点约束，Escape 关闭并把焦点还给触发元素；
 * 校验失败后焦点落到错误摘要，摘要里的链接把焦点交给对应字段。
 * @module @chatdsh/client-connectors/form
 */

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button, Dialog, ErrorNote, ErrorSummary, Field } from '@chatdsh/core-ui-kit';

import {
  CONNECTOR_NAME_LIMIT,
  describeFailure,
  draftOfRecord,
  EMPTY_DRAFT,
  FIELD_IDS,
  fieldOfHostMessage,
  inputOf,
  validateDraft,
  type ConnectorDraft,
  type FieldError,
} from './state.ts';
import type { ConnectorRecord, ConnectorTransport, ConnectorsGateway } from './types.ts';

/** 表单的依赖。 */
export interface ConnectorFormProps {
  /** 数据入口。 */
  readonly gateway: ConnectorsGateway;
  /** 新建还是修改。 */
  readonly mode: 'create' | 'edit';
  /** 修改时的原记录。 */
  readonly record?: ConnectorRecord;
  /** 除本次提交这一条之外的现有记录，用于名称唯一性判定。 */
  readonly others: readonly ConnectorRecord[];
  /** 关闭对话框。 */
  readonly onClose: () => void;
  /** 保存成功后回调，参数是写入后的记录。 */
  readonly onSaved: (record: ConnectorRecord) => void;
}

/** 取某个字段的校验结果。 */
function errorFor(errors: readonly FieldError[], fieldId: string): string | undefined {
  return errors.find((entry) => entry.fieldId === fieldId)?.message;
}

/** 连接器表单。 */
export function ConnectorForm({ gateway, mode, record, others, onClose, onSaved }: ConnectorFormProps) {
  const summaryId = useId();
  const [draft, setDraft] = useState<ConnectorDraft>(record === undefined ? EMPTY_DRAFT : draftOfRecord(record));
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [submitFailure, setSubmitFailure] = useState<unknown>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const action = mode === 'create' ? 'connector.create' : 'connector.update';

  useEffect(() => {
    if (errors.length === 0) return;
    document.getElementById(summaryId)?.focus();
  }, [errors, summaryId]);

  const switchTransport = (transport: ConnectorTransport): void => {
    setDraft(transport === 'stdio'
      ? { ...draft, transport, url: '' }
      : { ...draft, transport, command: '', argsText: '' });
    setErrors([]);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting) return;
    const found = validateDraft(draft, others);
    setErrors(found);
    if (found.length > 0) {
      gateway.noteAction(action, 'rejected');
      return;
    }
    setSubmitFailure(undefined);
    setSubmitting(true);
    gateway.save(inputOf(draft, record?.id)).then(
      (saved) => {
        gateway.noteAction(action, 'ok');
        setSubmitting(false);
        onSaved(saved);
      },
      (error: unknown) => {
        gateway.noteAction(action, 'failed');
        setSubmitting(false);
        const message = error instanceof Error ? error.message : '';
        const field = fieldOfHostMessage(message);
        if (field === undefined) {
          setSubmitFailure(error);
          return;
        }
        setErrors([{ fieldId: field, message }]);
      },
    );
  };

  const stdio = draft.transport === 'stdio';
  return (
    <Dialog
      open
      title={mode === 'create' ? '新建连接器' : '连接器设置'}
      description="连接器把外部能力接进工具目录：stdio 方式启动一个命令，http 方式连接一个地址。"
      onClose={onClose}
    >
      <form aria-label={mode === 'create' ? '新建连接器' : '连接器设置'} onSubmit={submit} noValidate>
        <ErrorSummary id={summaryId} errors={errors} />
        {submitFailure === undefined ? null : <ErrorNote>{describeFailure(submitFailure)}</ErrorNote>}
        <Field
          label="名称"
          required
          help={`同时用于 MCP 服务器名，最多 ${String(CONNECTOR_NAME_LIMIT)} 个字符；规范化后不能与其它连接器重复。`}
          error={errorFor(errors, FIELD_IDS.name)}
        >
          <input
            id={FIELD_IDS.name}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field label="传输方式" required error={errorFor(errors, FIELD_IDS.transport)}>
          <select
            id={FIELD_IDS.transport}
            value={draft.transport}
            onChange={(event) => switchTransport(event.target.value as ConnectorTransport)}
          >
            <option value="stdio">stdio（本机命令）</option>
            <option value="http">http（远程地址）</option>
          </select>
        </Field>
        {stdio
          ? (
            <>
              <Field label="命令" required error={errorFor(errors, FIELD_IDS.command)} help="stdio 方式下启动的可执行文件。">
                <input
                  id={FIELD_IDS.command}
                  value={draft.command}
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                />
              </Field>
              <Field
                label="参数"
                error={errorFor(errors, FIELD_IDS.args)}
                help={'按 JSON 字符串数组填写，例如 ["--dir","/srv/notes"]；留空表示没有参数。'}
              >
                <textarea
                  id={FIELD_IDS.args}
                  rows={3}
                  value={draft.argsText}
                  onChange={(event) => setDraft({ ...draft, argsText: event.target.value })}
                />
              </Field>
            </>
          )
          : (
            <Field label="地址" required error={errorFor(errors, FIELD_IDS.url)} help="http 方式下连接的完整 URL，协议限 http 与 https。">
              <input
                id={FIELD_IDS.url}
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </Field>
          )}
        <Field
          label="凭据环境变量名"
          error={errorFor(errors, FIELD_IDS.credential)}
          help="只填变量名，例如 CHATDSH_NOTES_TOKEN。凭据值从本机环境读取，界面不回显也不保存值。"
        >
          <input
            id={FIELD_IDS.credential}
            value={draft.credentialEnv}
            placeholder="CHATDSH_NOTES_TOKEN"
            onChange={(event) => setDraft({ ...draft, credentialEnv: event.target.value })}
          />
        </Field>
        <Field label="启用状态" help="停用后工具从目录移除；再次启用会重新同步加载器行。">
          <input
            id={FIELD_IDS.enabled}
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
        </Field>
        <Button id="wp13-connector-submit" type="submit" tone="primary" disabled={submitting}>
          {submitting ? '正在保存' : '保存'}
        </Button>
        <Button id="wp13-connector-cancel" onClick={onClose}>取消</Button>
      </form>
    </Dialog>
  );
}
