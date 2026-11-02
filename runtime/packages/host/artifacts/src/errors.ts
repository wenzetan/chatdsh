/**
 * 制品操作的错误码。
 *
 * 取值与跨组件契约里的错误码一致，供遥测按码聚合与界面按码分支。制品的错误码集中
 * 定义在这里，业务代码只在错误位置就地抛出，不做事后猜测。
 * @module @chatdsh/host-artifacts/errors
 */

/** 制品可以抛出的错误码。 */
export const ARTIFACT_ERROR_CODES = {
  /** 制品不存在。 */
  objectNotFound: 'object-not-found',
  /** 请求字段缺失或不合法。 */
  requestInvalid: 'request-invalid',
  /** 指定的版本不属于该制品，或版本记录已丢失。 */
  versionUnknown: 'artifact-version-unknown',
  /** 历史版本不可改写。 */
  versionImmutable: 'artifact-version-immutable',
} as const;

/** 错误码取值。 */
export type ArtifactErrorCode = (typeof ARTIFACT_ERROR_CODES)[keyof typeof ARTIFACT_ERROR_CODES];

/** 带错误码的制品异常。 */
export class ArtifactError extends Error {
  /** 稳定的错误码，写入遥测的 `error.code`。 */
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}
