/**
 * 检索任务的编排。
 *
 * 这一层不依赖运行时：把一个问题拆成若干角度的子任务，并把各子任务的结论合并成一段可读
 * 文字。便于单独验证拆分与合并的规则。
 * @module @chatdsh/tool-research/plan
 */

/** 单个角度的子任务描述。 */
export interface ResearchAngle {
  readonly angle: string;
  readonly prompt: string;
}

/** 合并输入：一个角度的结论。 */
export interface ResearchFinding {
  readonly angle: string;
  readonly text: string;
}

/** 一个检索任务最多展开的子任务数，避免一次调用把并发拉到不可控的量级。 */
export const MAX_ANGLES = 6;

/**
 * 把问题与角度展开成子任务。
 *
 * 不给角度时按默认的三个角度展开：事实、对比、风险。角度超过上限时报错，避免静默截断。
 * @param question - 待检索的问题。
 * @param angles - 可选的角度名。
 * @returns 子任务列表。
 */
export function planResearch(question: string, angles?: readonly string[]): ResearchAngle[] {
  const trimmed = question.trim();
  if (trimmed === '') throw new Error('检索问题不能为空');
  const selected = angles === undefined || angles.length === 0 ? ['事实', '对比', '风险'] : [...angles];
  if (selected.length > MAX_ANGLES) throw new Error(`角度最多 ${MAX_ANGLES} 个，收到 ${selected.length} 个`);
  return selected.map((angle) => ({
    angle,
    prompt: `围绕「${angle}」这个角度检索并回答下面的问题。给出你查到的要点与来源；查不到时说明查不到，不要编造。\n\n问题：${trimmed}`,
  }));
}

/**
 * 合并各角度的结论。
 * @param findings - 各角度的结论，按角度顺序。
 * @returns 可读的合并结果。
 */
export function mergeFindings(findings: readonly ResearchFinding[]): string {
  if (findings.length === 0) return '没有取得任何角度的结论。';
  const sections = findings.map((finding) => {
    const text = finding.text.trim();
    return `## ${finding.angle}\n${text === '' ? '（这个角度没有返回内容）' : text}`;
  });
  return sections.join('\n\n');
}
