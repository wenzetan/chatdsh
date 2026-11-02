import { useEffect } from 'react';
/**
 * 表单校验问题与焦点转移。
 *
 * 提交失败后把焦点移到第一个出错的控件；字段标识与 `<Field>` 生成的控件标识一致，
 * 键盘用户不需要重新寻找位置。
 * @module @chatdsh/client-memory/problems
 */

/** 一条字段校验问题。 */
export interface FormProblem {
  /** 出错的控件标识。 */
  readonly fieldId: string;
  /** 给用户看的说明。 */
  readonly message: string;
}

/**
 * 校验问题出现后把焦点移到第一处。
 * @param problems - 当前问题列表；为空时不动焦点。
 */
export function useProblemFocus(problems: readonly FormProblem[]): void {
  const key = problems.map((problem) => problem.fieldId).join('|');
  useEffect(() => {
    const first = problems[0];
    if (first === undefined) return;
    const element = document.getElementById(first.fieldId);
    element?.focus();
    // 只在问题集合变化时移动焦点，输入过程中不重复抢占。
  }, [key]);
}
