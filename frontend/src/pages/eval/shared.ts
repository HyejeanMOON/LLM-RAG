import type { EvalMetricInfo } from "../../api";

/** 分数显示：0~1 的指标保留 3 位小数，耗时和字数取整 */
export function fmt(key: string, v: number | undefined): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "–";
  if (key.endsWith("_ms")) return `${Math.round(v)} ms`;
  if (key.endsWith("_chars")) return String(Math.round(v));
  return v.toFixed(3);
}

/** 0~1 的指标可以画条形 */
export const isRatio = (key: string) => !key.endsWith("_ms") && !key.endsWith("_chars");

export function lowerBetter(key: string, infos: EvalMetricInfo[]): boolean {
  return infos.find((m) => m.key === key)?.lower_better ?? false;
}

export const GROUP_ORDER = ["retrieval", "text", "judge", "system"] as const;
