/**
 * 制品查看器：受限 HTML、安全 SVG、图片工具栏、文本与不可预览说明。
 *
 * HTML 只放进 `sandbox=""` 的 iframe：没有 `allow-same-origin`，没有 `allow-scripts`，因此
 * 页面拿不到宿主接口、不能提交表单、也不能跳出预览区。SVG 只作为 `<img>` 的图片呈现，脚本
 * 在图片上下文里不会执行。图片工具栏的缩放比例相对原尺寸，键盘 `+`、`-` 调整，`Home` 复位。
 * @module @chatdsh/client-artifacts/viewers
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, ScrollRegion, StatusLine } from '@chatdsh/core-ui-kit';

import { DEFAULT_ZOOM_PERCENT, fitPercentOf, keyboardZoomOf, zoomStepOf, type PreviewPlan } from './state.ts';

/** 图片工具栏用到的下载与外部打开地址。 */
export interface Attachment {
  /** 内容的对象地址。 */
  readonly url: string;
  /** 下载文件名。 */
  readonly filename: string;
}

/** 查看器的依赖。 */
export interface ArtifactPreviewProps {
  /** 预览判定。 */
  readonly plan: PreviewPlan;
  /** 制品标题，用作替代文本与预览标题。 */
  readonly title: string;
  /** 当前版本的下载地址；读取失败时为未定义。 */
  readonly attachment?: Attachment;
}

/** 受限 HTML 预览：iframe 的沙箱标记为空，因此没有同源权限、脚本执行与表单提交。 */
export function SandboxHtmlPreview({ html, title }: { readonly html: string; readonly title: string }) {
  return (
    <section aria-label="受限 HTML 预览">
      <StatusLine>
        受限预览：脚本、表单提交与宿主接口都不可用，页面里的链接不能跳出预览区。
      </StatusLine>
      <iframe
        id="wp12-html-frame"
        className="chdsh-artifact-frame"
        title={`受限预览：${title}`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={html}
        style={{ width: '100%', height: '60vh', border: '1px solid var(--chatdsh-line-2)', borderRadius: 'var(--cdh-r2)', background: 'var(--chatdsh-panel)' }}
      />
    </section>
  );
}

/** SVG 预览：以图片方式呈现，脚本不会执行。 */
export function SvgPreview({ dataUrl, title }: { readonly dataUrl: string; readonly title: string }) {
  return (
    <section aria-label="SVG 预览">
      <StatusLine>SVG 按安全图片呈现：脚本不会执行，页面也拿不到宿主接口。</StatusLine>
      <img id="wp12-svg" src={dataUrl} alt={title} style={{ maxWidth: '100%', height: 'auto' }} />
    </section>
  );
}

/** 文本预览：可选择、可复制，查找交给浏览器的页面内查找。 */
export function TextPreview({ text, title }: { readonly text: string; readonly title: string }) {
  return (
    <section aria-label="文本预览">
      <StatusLine>文本可以选中与复制；查找使用浏览器的页面内查找（Ctrl+F）。</StatusLine>
      <ScrollRegion label={`文本内容：${title}`}>
        <pre id="wp12-text" tabIndex={0} style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</pre>
      </ScrollRegion>
    </section>
  );
}

/** 不可预览的说明：一句原因、一个错误码与可用的下一步。 */
export function PreviewNotice({ plan, attachment }: { readonly plan: Extract<PreviewPlan, { kind: 'notice' }>; readonly attachment?: Attachment }) {
  return (
    <section aria-label="内容不可预览">
      <StatusLine tone="danger">{`${plan.title}：${plan.message}`}</StatusLine>
      <p style={{ margin: 0 }}>错误码 <code id="wp12-preview-code">{plan.code}</code></p>
      {attachment === undefined
        ? null
        : (
          <p style={{ margin: 0 }}>
            <a href={attachment.url} download={attachment.filename} aria-label={`下载 ${attachment.filename}`}>下载当前版本</a>
          </p>
        )}
    </section>
  );
}

/** 图片查看器：缩放百分比、适应宽度、原尺寸、下载与外部打开。 */
export function ImageViewer({ dataUrl, title, attachment }: {
  readonly dataUrl: string;
  readonly title: string;
  readonly attachment?: Attachment;
}) {
  const [natural, setNatural] = useState<{ readonly width: number; readonly height: number } | undefined>(undefined);
  const [containerWidth, setContainerWidth] = useState(0);
  const [mode, setMode] = useState<{ readonly kind: 'fit' } | { readonly kind: 'zoom'; readonly percent: number }>({ kind: 'zoom', percent: DEFAULT_ZOOM_PERCENT });
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = box.current;
    if (node === null) return undefined;
    const observer = new ResizeObserver(() => setContainerWidth(node.clientWidth));
    observer.observe(node);
    setContainerWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const fitPercent = mode.kind === 'fit' && natural !== undefined ? fitPercentOf(containerWidth, natural.width) : undefined;
  const percent = mode.kind === 'zoom' ? mode.percent : fitPercent;
  const width = mode.kind === 'fit'
    ? '100%'
    : natural === undefined
      ? `${String(mode.percent)}%`
      : `${String(Math.round((natural.width * mode.percent) / 100))}px`;

  const zoomBy = (direction: 'in' | 'out'): void => {
    const base = percent ?? DEFAULT_ZOOM_PERCENT;
    setMode({ kind: 'zoom', percent: zoomStepOf(base, direction) });
  };
  const reset = (): void => setMode({ kind: 'zoom', percent: DEFAULT_ZOOM_PERCENT });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const action = keyboardZoomOf(event.key);
    if (action === undefined) return;
    event.preventDefault();
    if (action === 'reset') reset();
    else zoomBy(action);
  };

  return (
    <section aria-label="图片预览">
      <div id="wp12-image-viewer" role="group" aria-label={`图片查看器：${title}`} tabIndex={0} onKeyDown={onKeyDown}>
        <div role="toolbar" aria-label="图片工具栏">
          <Button aria-label="缩小图片" onClick={() => zoomBy('out')}>缩小</Button>
          <span id="wp12-zoom-percent" aria-live="polite">{percent === undefined ? '—' : `${String(percent)}%`}</span>
          <Button aria-label="放大图片" onClick={() => zoomBy('in')}>放大</Button>
          <Button aria-label="适应宽度" onClick={() => setMode({ kind: 'fit' })}>适应宽度</Button>
          <Button aria-label="原始大小" onClick={reset}>原始大小</Button>
          {attachment === undefined
            ? null
            : (
              <>
                <a href={attachment.url} download={attachment.filename} aria-label={`下载图片 ${attachment.filename}`}>下载</a>
                <a href={attachment.url} target="_blank" rel="noopener noreferrer" aria-label={`外部打开图片 ${attachment.filename}`}>外部打开</a>
              </>
            )}
        </div>
        <div ref={box} style={{ overflow: 'auto', maxHeight: '60vh' }}>
          <img
            id="wp12-image"
            src={dataUrl}
            alt={title}
            style={{ width, height: 'auto', display: 'block' }}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          />
        </div>
      </div>
      <StatusLine>键盘 + 与 - 调整缩放，Home 复位到原尺寸。</StatusLine>
    </section>
  );
}

/**
 * 按预览判定选择查看器。
 * @param props - 预览判定、标题与下载地址。
 * @returns 对应的查看器。
 */
export function ArtifactPreview({ plan, title, attachment }: ArtifactPreviewProps) {
  if (plan.kind === 'notice') return <PreviewNotice plan={plan} attachment={attachment} />;
  if (plan.kind === 'html') return <SandboxHtmlPreview html={plan.html} title={title} />;
  if (plan.kind === 'svg') return <SvgPreview dataUrl={plan.dataUrl} title={title} />;
  if (plan.kind === 'image') return <ImageViewer dataUrl={plan.dataUrl} title={title} attachment={attachment} />;
  return <TextPreview text={plan.text} title={title} />;
}
