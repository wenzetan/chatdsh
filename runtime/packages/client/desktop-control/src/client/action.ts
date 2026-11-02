/**
 * 受控动作的执行入口。
 *
 * 任何要操作桌面的一方都先取许可、再执行、最后回报结果。无有效租约、已暂停或已中断时许可
 * 申请直接失败，动作不执行；失败结果同时写进界面动作遥测，界面因此能在中断之后如实说明
 * 「已拒绝：授权已中断」。
 * @module @chatdsh/client-desktop-control/action
 */

import type { ControlGateway, ControlTelemetry, PermitView } from './types.ts';
import { browserTelemetry } from './telemetry.ts';

/** 一次受控动作。 */
export interface ControlActionInput<T> {
  /** 动作名，例如 `click`。 */
  readonly action: string;
  /** 动作坐标，给出时由宿主核对是否落在范围之内。 */
  readonly point?: { readonly x: number; readonly y: number };
  /** 拿到许可之后真正执行的动作。 */
  readonly run: (permit: PermitView) => Promise<T>;
}

/**
 * 在租约约束下执行一次动作。
 * @param gateway - 数据入口。
 * @param input - 动作与执行体。
 * @param telemetry - 界面动作遥测。
 * @returns 执行体的返回值。
 */
export async function runControlAction<T>(
  gateway: ControlGateway,
  input: ControlActionInput<T>,
  telemetry: ControlTelemetry = browserTelemetry,
): Promise<T> {
  let permit: PermitView;
  try {
    permit = await gateway.action({
      action: input.action,
      ...(input.point === undefined ? {} : { point: input.point }),
    });
  } catch (error) {
    telemetry.action('control-action', 'failed');
    throw error;
  }
  telemetry.action('control-action', 'ok');
  try {
    const result = await input.run(permit);
    await gateway.endAction({ permitId: permit.permitId, outcome: 'ok' });
    return result;
  } catch (error) {
    await gateway.endAction({ permitId: permit.permitId, outcome: 'failed' });
    throw error;
  }
}
