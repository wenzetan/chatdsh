/**
 * 文件浏览的界面模型：目录树、路径拼接、预览判定与失败说明。
 *
 * 目录树按工作区相对路径组织，目录在前、文件在后，展开与加载分别记录，加载失败留在
 * 该目录上而不是清空整棵树。预览按扩展名与字节数判定文本、图片、超大与二进制四种分支，
 * 上限取本模块声明的真实数字，提示里同时给出文件大小与上限。整棵树不持有文件内容，
 * 只持有目录列举结果与展开状态。
 * @module @chatdsh/client-workspace-tools/files
 */

import { WorkspaceClientError, type DirectoryEntry, type DirectoryListing } from './types.ts';

/** 文本预览的字节上限：2 MiB。 */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** 图片预览的字节上限：8 MiB。 */
export const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** 文本预览一次取的行数上限。 */
export const TEXT_PREVIEW_MAX_LINES = 2000;

/** 根目录传给宿主 `workspaceFiles/list` 的路径。 */
export const ROOT_PATH_ARGUMENT = '.';

/** 预览分支。 */
export const PREVIEW_BRANCHES = ['text', 'image', 'too-large', 'binary'] as const;

/** 预览分支取值。 */
export type PreviewBranch = (typeof PREVIEW_BRANCHES)[number];

/** 文本类扩展名。 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'yaml', 'yml', 'xml', 'html', 'css', 'log', 'toml', 'ini', 'sql', 'sh', 'py',
]);

/** 图片类扩展名。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/** 文本类媒体类型前缀。 */
const TEXT_MIME_PATTERN = /^(?:text\/|application\/(?:json|javascript|xml|yaml|x-yaml|typescript|sql)$)/u;

/** 图片类媒体类型集合。 */
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 取扩展名，小写、不带点。 */
function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index + 1).toLowerCase();
}

/**
 * 按文件名推断媒体类型。
 * @param name - 文件名。
 * @returns 媒体类型；无法判断时为空串。
 */
export function mimeTypeOfName(name: string): string {
  const extension = extensionOf(name);
  if (extension === '') return '';
  if (IMAGE_EXTENSIONS.has(extension)) return `image/${extension === 'jpg' ? 'jpeg' : extension}`;
  if (TEXT_EXTENSIONS.has(extension)) return extension === 'md' || extension === 'markdown' ? 'text/markdown' : 'text/plain';
  return '';
}

/**
 * 预览判定。
 * @param input - 文件名、媒体类型与字节数。
 * @returns 分支、上限与说明。
 */
export function classifyPreview(input: {
  readonly name: string;
  readonly mimeType?: string;
  readonly size?: number;
}): { readonly branch: PreviewBranch; readonly limitBytes: number; readonly notice?: string } {
  const mimeType = (input.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const image = IMAGE_MIME_TYPES.has(mimeType) || IMAGE_EXTENSIONS.has(extensionOf(input.name));
  const text = !image && (TEXT_MIME_PATTERN.test(mimeType) || TEXT_EXTENSIONS.has(extensionOf(input.name)));
  const limitBytes = image ? IMAGE_PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES;
  const size = input.size;
  if (!image && !text) {
    return { branch: 'binary', limitBytes, notice: '这个文件不提供文本或图片预览。' };
  }
  if (size !== undefined && size > limitBytes) {
    return {
      branch: 'too-large',
      limitBytes,
      notice: `文件 ${String(size)} 字节超过预览上限 ${String(limitBytes)} 字节，下载后查看完整内容。`,
    };
  }
  return { branch: image ? 'image' : 'text', limitBytes };
}

/**
 * 把文本切成带行号的行。
 * @param text - 文本内容。
 * @returns 从 1 开始编号的行。
 */
export function textLines(text: string): { readonly number: number; readonly text: string }[] {
  if (text === '') return [];
  return text.split('\n').map((line, index) => ({ number: index + 1, text: line }));
}

/** 失败说明。 */
export interface FileFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** 错误码到失败说明的映射。 */
const FAILURE_TEXT: Readonly<Record<string, FileFailure>> = {
  'workspace-file/not-found': { code: 'file-not-found', message: '文件或目录不存在，可能已被移动或删除。', retryable: true },
  FS_NOT_FOUND: { code: 'file-not-found', message: '文件或目录不存在，可能已被移动或删除。', retryable: true },
  FS_PERMISSION_DENIED: { code: 'file-permission-denied', message: '没有读取这个路径的权限，宿主拒绝了这次读取。', retryable: false },
  EACCES: { code: 'file-permission-denied', message: '没有读取这个路径的权限，宿主拒绝了这次读取。', retryable: false },
  EPERM: { code: 'file-permission-denied', message: '没有读取这个路径的权限，宿主拒绝了这次读取。', retryable: false },
  'workspace-file/outside-workspace': { code: 'file-permission-denied', message: '这个路径不在工作区内，宿主拒绝读取。', retryable: false },
  FS_SANDBOX_DENIED: { code: 'file-permission-denied', message: '沙箱策略拒绝读取这个路径。', retryable: false },
  'workspace-file/too-large': { code: 'file-too-large', message: '文件超过宿主允许的读取上限，下载后查看完整内容。', retryable: false },
  FS_TOO_LARGE: { code: 'file-too-large', message: '文件超过宿主允许的读取上限，下载后查看完整内容。', retryable: false },
  'workspace-file/not-text': { code: 'file-binary', message: '这个文件不是 UTF-8 文本，无法按文本预览。', retryable: false },
  FS_NOT_TEXT: { code: 'file-binary', message: '这个文件不是 UTF-8 文本，无法按文本预览。', retryable: false },
  'workspace-file/not-regular-file': { code: 'file-not-regular', message: '这个路径不是普通文件，无法预览。', retryable: false },
  FS_NOT_REGULAR_FILE: { code: 'file-not-regular', message: '这个路径不是普通文件，无法预览。', retryable: false },
  'client/offline': { code: 'workspace-offline', message: '运行时不可达，恢复连接后重新加载。', retryable: true },
  'client/unavailable': { code: 'workspace-unavailable', message: '当前部署没有提供工作区文件接口。', retryable: false },
};

/**
 * 把宿主或传输层的失败折算成说明。
 * @param error - 失败对象。
 * @returns 错误码、说明与是否可以重试。
 */
export function describeFileFailure(error: unknown): FileFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code: unknown }).code)
    : 'client/internal';
  const known = FAILURE_TEXT[code];
  if (known !== undefined) return known;
  return {
    code: 'file-read-failed',
    message: error instanceof Error ? error.message : '读取失败，原因未知。',
    retryable: true,
  };
}

/** 共享文件树组件使用的节点形状。 */
export interface WorkspaceTreeNode {
  readonly id: string;
  readonly label: string;
  readonly children?: readonly WorkspaceTreeNode[];
}

/** 目录树里一行的可见状态。 */
export interface FileTreeRow {  /** 工作区相对路径，根目录为空串。 */
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly level: number;
  readonly expanded: boolean;
  /** 已加载的子项数量；未加载时为空。 */
  readonly childCount?: number;
  readonly size?: number;
  /** 读屏标签，包含类型与大小。 */
  readonly label: string;
}

/** 一个节点的内部状态。 */
interface TreeNodeState {
  entry: DirectoryEntry;
  expanded: boolean;
  loading: boolean;
  children?: string[];
  failure?: FileFailure;
}

/** 拼接工作区相对路径。 */
function joinPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/**
 * 按类型与大小生成读屏标签。
 * @param entry - 目录项。
 * @returns 标签文本。
 */
export function entryLabel(entry: DirectoryEntry): string {
  if (entry.type === 'directory') return `${entry.name}，目录`;
  const size = entry.size === undefined ? '大小未知' : `${String(entry.size)} 字节`;
  return `${entry.name}，文件，${size}`;
}

/**
 * 目录树模型。
 */
export class FileTreeModel {
  private readonly nodes = new Map<string, TreeNodeState>();
  private selected: string | undefined;

  /** 根目录列举；空路径代表工作区根。 */
  setRoot(listing: DirectoryListing): void {
    this.applyListing('', listing);
  }

  /**
   * 记录一次展开开始的加载。
   * @param path - 目录路径。
   */
  beginLoad(path: string): void {
    const node = this.requireNode(path);
    if (node.entry.type !== 'directory') throw new WorkspaceClientError('file-not-directory', `${path} 不是目录`);
    node.expanded = true;
    node.loading = true;
    node.failure = undefined;
  }

  /**
   * 记录一次目录列举的结果。
   * @param path - 目录路径。
   * @param listing - 列举结果。
   */
  finishLoad(path: string, listing: DirectoryListing): void {
    const node = this.requireNode(path);
    if (node.entry.type !== 'directory') throw new WorkspaceClientError('file-not-directory', `${path} 不是目录`);
    this.applyListing(path, listing);
    node.loading = false;
    node.failure = undefined;
  }

  /**
   * 记录一次目录列举的失败。
   * @param path - 目录路径。
   * @param error - 失败对象。
   */
  failLoad(path: string, error: unknown): void {
    const node = this.requireNode(path);
    node.loading = false;
    node.failure = describeFileFailure(error);
  }

  /**
   * 取一个目录的失败状态。
   * @param path - 目录路径。
   * @returns 失败说明；正常时为空。
   */
  failureOf(path: string): FileFailure | undefined {
    return this.requireNode(path).failure;
  }

  /** 合并一次列举结果。 */
  private applyListing(path: string, listing: DirectoryListing): void {
    const node = this.requireNode(path);
    const ordered = [...listing.entries].sort((left, right) => {
      if (left.type !== right.type) {
        if (left.type === 'directory') return -1;
        if (right.type === 'directory') return 1;
      }
      return left.name.localeCompare(right.name, 'zh-Hans-CN');
    });
    const children: string[] = [];
    for (const entry of ordered) {
      const childPath = joinPath(path, entry.name);
      const kind = entry.type === 'directory' ? 'directory' : 'file';
      const existing = this.nodes.get(childPath);
      if (existing === undefined) {
        this.nodes.set(childPath, {
          entry: { ...entry, type: kind },
          expanded: false,
          loading: false,
        });
      } else {
        existing.entry = { ...entry, type: kind };
      }
      children.push(childPath);
    }
    node.children = children;
  }

  /**
   * 折叠一个目录。
   * @param path - 目录路径。
   */
  collapse(path: string): void {
    this.requireNode(path).expanded = false;
  }

  /**
   * 切换目录的展开状态。
   * @param path - 目录路径。
   * @returns 切换后的展开状态。
   */
  toggle(path: string): boolean {
    const node = this.requireNode(path);
    if (node.entry.type !== 'directory') throw new WorkspaceClientError('file-not-directory', `${path} 不是目录`);
    node.expanded = !node.expanded;
    return node.expanded;
  }

  /**
   * 选中一行。
   * @param path - 路径。
   */
  select(path: string): void {
    this.requireNode(path);
    this.selected = path;
  }

  /** 当前选中路径。 */
  get selectedPath(): string | undefined {
    return this.selected;
  }

  /** 已展开的目录路径。 */
  expandedPaths(): string[] {
    return [...this.nodes.entries()]
      .filter(([, node]) => node.expanded)
      .map(([path]) => path);
  }

  /**
   * 取一个节点的目录项。
   * @param path - 路径。
   * @returns 目录项。
   */
  entryOf(path: string): DirectoryEntry {
    return this.requireNode(path).entry;
  }

  /** 共享文件树组件需要的节点形状；目录始终带 children。 */
  treeNodes(): WorkspaceTreeNode[] {
    const build = (parent: string): WorkspaceTreeNode[] => {
      const children = parent === '' ? this.rootChildren() : this.nodes.get(parent)?.children ?? [];
      return children.map((path) => {
        const node = this.nodes.get(path);
        if (node === undefined) throw new WorkspaceClientError('file-not-found', `目录树里没有 ${path}`);
        const label = entryLabel(node.entry);
        if (node.entry.type !== 'directory') return { id: path, label };
        return { id: path, label, children: build(path) };
      });
    };
    return build('');
  }

  /** 可见行：只包含已展开目录的直接子项。 */
  visibleRows(): FileTreeRow[] {    const rows: FileTreeRow[] = [];
    const visit = (parent: string, level: number): void => {
      const children = parent === '' ? this.rootChildren() : this.nodes.get(parent)?.children ?? [];
      for (const path of children) {
        const node = this.nodes.get(path);
        if (node === undefined) continue;
        const isDirectory = node.entry.type === 'directory';
        rows.push({
          path,
          name: node.entry.name,
          kind: isDirectory ? 'directory' : 'file',
          level,
          expanded: isDirectory ? node.expanded : false,
          ...(node.children === undefined ? {} : { childCount: node.children.length }),
          ...(node.entry.size === undefined ? {} : { size: node.entry.size }),
          label: entryLabel(node.entry),
        });
        if (isDirectory && node.expanded) visit(path, level + 1);
      }
    };
    visit('', 1);
    return rows;
  }

  /** 根目录的直接子项。 */
  private rootChildren(): string[] {
    return this.nodes.get('')?.children ?? [];
  }

  /** 取节点，缺失时就地抛出。 */
  private requireNode(path: string): TreeNodeState {
    if (path === '') {
      let root = this.nodes.get('');
      if (root === undefined) {
        root = { entry: { name: '', type: 'directory' }, expanded: true, loading: false };
        this.nodes.set('', root);
      }
      return root;
    }
    const node = this.nodes.get(path);
    if (node === undefined) throw new WorkspaceClientError('file-not-found', `目录树里没有 ${path}`);
    return node;
  }
}
