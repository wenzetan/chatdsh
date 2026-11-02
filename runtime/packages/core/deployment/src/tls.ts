/**
 * TLS 与双向 TLS 的材料校验。
 *
 * 启动前读取证书与私钥，核对文件权限、私钥与证书是否配对、证书有效期；双向 TLS 还要求配置
 * 客户端证书的签发机构。到期前 30 天写一条告警事件，过期或权限过宽直接拒绝启动。轮换时重新
 * 读一遍材料，只对新连接生效。
 * @module @chatdsh/core-deployment/tls
 */

import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { readFileSync, statSync, type Stats } from 'node:fs';
import { createSecureContext, type TlsOptions } from 'node:tls';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { DeploymentError } from './errors.ts';
import { emitRejection } from './telemetry.ts';

/** 证书与私钥的文件位置与信任条件。 */
export interface TlsPaths {
  /** 服务端证书文件。 */
  readonly certPath: string;
  /** 服务端私钥文件。 */
  readonly keyPath: string;
  /** 客户端证书的签发机构；双向 TLS 必需。 */
  readonly caPath?: string;
  /** 是否要求并校验客户端证书。 */
  readonly mutual: boolean;
  /** 到期告警阈值，单位天，缺省 30 天。 */
  readonly warnBeforeDays?: number;
}

/** 校验通过的材料。 */
export interface TlsMaterial {
  /** 交给 `https.createServer` 与 `setSecureContext` 的选项。 */
  readonly options: TlsOptions;
  /** 校验时使用的私钥对象。 */
  readonly key: KeyObject;
  /** 服务端证书。 */
  readonly certificate: X509Certificate;
  /** 证书生效时刻，ISO 8601。 */
  readonly notBefore: string;
  /** 证书失效时刻，ISO 8601。 */
  readonly notAfter: string;
  /** 距失效的整天数，向下取整。 */
  readonly daysRemaining: number;
  /** 证书主题；只用于诊断输出，不写入遥测。 */
  readonly subject: string;
  /** 证书的 SHA-256 指纹；只用于诊断输出，不写入遥测。 */
  readonly fingerprintSha256: string;
  /** 是否要求客户端证书。 */
  readonly mutual: boolean;
  /** 当前状态：有效或在告警窗口内。 */
  readonly status: 'valid' | 'expiring';
}

/** 默认的到期告警阈值。 */
export const DEFAULT_WARN_BEFORE_DAYS = 30;

/** 一天对应的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 私钥文件不允许出现的权限位：属主之外的任何读写执行位。 */
const KEY_PERMISSION_MASK = 0o077;

/** 读取一个必须存在的普通文件。 */
function readRequiredFile(path: string, errorCode: string, label: string): Buffer {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    throw new DeploymentError(errorCode, 'tls', 500, `${label}文件不存在或不可读：${path}`);
  }
  if (!stats.isFile()) {
    throw new DeploymentError(errorCode, 'tls', 500, `${label}不是普通文件：${path}`);
  }
  try {
    return readFileSync(path);
  } catch {
    throw new DeploymentError(errorCode, 'tls', 500, `${label}文件不可读：${path}`);
  }
}

/**
 * 校验并加载证书与私钥。
 * @param paths - 文件位置与信任条件。
 * @param telemetry - 遥测客户端。
 * @returns 校验通过的材料与可直接使用的安全上下文选项。
 * @throws DeploymentError 文件缺失、权限过宽、私钥与证书不配对、证书过期或未生效、双向 TLS 缺少签发机构。
 */
export async function loadTlsMaterial(paths: TlsPaths, telemetry: ChatdshTelemetry): Promise<TlsMaterial> {
  const mode = paths.mutual ? 'mtls' : 'tls';
  return telemetry.runSpan('chatdsh.gateway.deploy.tls.material', { mode, outcome: 'checking' }, async (span) => {
    const reject: (error: DeploymentError) => never = (error) => {
      emitRejection(telemetry, {
        action: 'tls-material',
        errorType: error.errorType,
        errorCode: error.code,
        span,
        mode,
      });
      throw error;
    };

    let keyStats: Stats | undefined;
    try {
      keyStats = statSync(paths.keyPath);
    } catch {
      keyStats = undefined;
    }
    if (keyStats === undefined || !keyStats.isFile()) {
      reject(new DeploymentError('tls-key-unreadable', 'tls', 500, `私钥文件不存在或不可读：${paths.keyPath}`));
    }
    const keyMode = keyStats.mode;
    if (process.platform !== 'win32' && (keyMode & KEY_PERMISSION_MASK) !== 0) {
      reject(new DeploymentError('key-permission-forbidden', 'tls', 500, '私钥文件权限过宽，只允许属主读写'));
    }

    const keyPem = readRequiredFile(paths.keyPath, 'tls-key-unreadable', '私钥');
    const certPem = readRequiredFile(paths.certPath, 'tls-cert-unreadable', '证书');

    let key: KeyObject;
    try {
      key = createPrivateKey(keyPem);
    } catch {
      reject(new DeploymentError('tls-key-invalid', 'tls', 500, '私钥内容无法解析'));
    }
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(certPem);
    } catch {
      reject(new DeploymentError('tls-cert-invalid', 'tls', 500, '证书内容无法解析'));
    }

    if (!certificate.checkPrivateKey(key)) {
      reject(new DeploymentError('tls-key-mismatch', 'tls', 500, '私钥与证书不配对'));
    }

    const now = Date.now();
    const notBefore = Date.parse(certificate.validFrom);
    const notAfter = Date.parse(certificate.validTo);
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
      reject(new DeploymentError('tls-cert-invalid', 'tls', 500, '证书有效期无法解析'));
    }
    if (now < notBefore) {
      reject(new DeploymentError('certificate-not-yet-valid', 'tls', 500, '证书尚未生效'));
    }
    if (now >= notAfter) {
      reject(new DeploymentError('certificate-expired', 'tls', 500, '证书已过期'));
    }

    let caPem: string | undefined;
    if (paths.mutual) {
      const caPath = paths.caPath;
      if (caPath === undefined) {
        reject(new DeploymentError('tls-client-ca-required', 'tls', 500, '双向 TLS 必须配置客户端证书的签发机构'));
      }
      caPem = readRequiredFile(caPath, 'tls-ca-unreadable', '签发机构证书').toString('utf8');
      try {
        createSecureContext({ ca: caPem });
      } catch {
        reject(new DeploymentError('tls-ca-invalid', 'tls', 500, '客户端证书的签发机构内容无法解析'));
      }
    }

    const warnBeforeDays = paths.warnBeforeDays ?? DEFAULT_WARN_BEFORE_DAYS;
    const daysRemaining = Math.floor((notAfter - now) / DAY_MS);
    const status: 'valid' | 'expiring' = daysRemaining < warnBeforeDays ? 'expiring' : 'valid';
    span.setAttribute('status', status);
    span.setAttribute('outcome', 'ok');
    if (status === 'expiring') {
      telemetry.event('chatdsh.gateway.deploy.tls.expiring', {
        status,
        mode,
        outcome: 'warned',
        'error.code': 'certificate-expiring-soon',
      });
    }

    const options: TlsOptions = {
      key: keyPem,
      cert: certPem,
      ...(caPem === undefined ? {} : { ca: caPem }),
      requestCert: paths.mutual,
      rejectUnauthorized: paths.mutual,
      minVersion: 'TLSv1.2',
    };
    return {
      options,
      key,
      certificate,
      notBefore: new Date(notBefore).toISOString(),
      notAfter: new Date(notAfter).toISOString(),
      daysRemaining,
      subject: certificate.subject,
      fingerprintSha256: certificate.fingerprint256,
      mutual: paths.mutual,
      status,
    };
  });
}
