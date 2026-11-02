/**
 * 本机 home 层补丁文件的读写。
 *
 * 补丁文件 `$DSH_HOME/cordis.patch.yml` 在补丁层顺序里位于 profile 之后，承载从控制平面
 * 同步来的白名单设置。文件是一份顶层 YAML 数组，每个元素是 `{id, name, config}` 形式的
 * 补丁行；写入按 id 合并，已有的行只更新被指定的字段，没有的行追加一条。
 * @module @chatdsh/host-settings-sync/home
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

/** 一份 `!!js` 表达式在解析结果里的表示，dump 时还原成同样的标量。 */
class JsExpression {
  constructor(readonly text: string) {}
}

const JsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => new JsExpression(data),
  instanceOf: JsExpression,
  represent: (value: unknown) => (value as JsExpression).text,
});

/** 读补丁文件用的模式：把 `!!js` 标量解析成表达式节点而不是报错。 */
const PATCH_SCHEMA = yaml.JSON_SCHEMA.extend([JsType]);

/** 一条补丁行。 */
export interface PatchRow {
  /** 补丁行的 id，同步记录里用白名单命名空间作 id。 */
  id: string;
  /** 补丁行的模块名，用于匹配上游行。 */
  name: string;
  /** 这一行的配置取值。 */
  config?: Record<string, unknown>;
}

/**
 * home 层补丁文件的读写。
 */
export class HomeLayer {
  /** 补丁文件路径。 */
  readonly path: string;

  constructor(homeRoot: string) {
    this.path = join(homeRoot, 'cordis.patch.yml');
  }

  /** 读现有补丁行；文件不存在时返回空数组。 */
  read(): PatchRow[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    if (text.trim() === '') return [];
    const parsed = yaml.load(text, { schema: PATCH_SCHEMA });
    if (parsed === null || parsed === undefined) return [];
    if (!Array.isArray(parsed)) throw new Error(`home 层补丁不是数组：${this.path}`);
    return parsed as PatchRow[];
  }

  /** 读一个命名空间已经写进 home 层的字段。 */
  fieldsOf(namespace: string): Record<string, unknown> {
    const row = this.read().find((entry) => entry.id === namespace);
    return row?.config ?? {};
  }

  /**
   * 合并一组字段到某个命名空间对应的补丁行。
   * @param namespace - 白名单命名空间，用作补丁行的 id。
   * @param moduleName - 补丁行的 `name`，用于匹配上游行。
   * @param fields - 字段名到取值的映射。
   */
  merge(namespace: string, moduleName: string, fields: Record<string, unknown>): void {
    const rows = this.read();
    let row = rows.find((entry) => entry.id === namespace);
    if (row === undefined) {
      row = { id: namespace, name: moduleName, config: {} };
      rows.push(row);
    }
    row.config = { ...(row.config ?? {}), ...fields };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, yaml.dump(rows, { schema: PATCH_SCHEMA, lineWidth: -1 }), 'utf8');
  }
}
