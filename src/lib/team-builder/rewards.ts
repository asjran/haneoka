import type { MetricValue } from "./contracts.ts";
import { unavailableMetric } from "./score.ts";

/** BattleLiveScoreRankCalculator.CalcRequiredScore (Intl 1.0.1, 0x620dbec).
 * This is a room total threshold; compare it to the room total score.
 */
export function battleScoreThreshold(requiredScore: number, rankTargetPlayerCount: number): number {
  if (!Number.isSafeInteger(requiredScore) || requiredScore < 0 || !Number.isSafeInteger(rankTargetPlayerCount))
    throw new RangeError("score-threshold-input");
  if (rankTargetPlayerCount < 1) return 0x7fffffff;
  const result = Math.trunc(Math.sqrt(5 / rankTargetPlayerCount) * requiredScore * rankTargetPlayerCount);
  if (result > 0x7fffffff) throw new RangeError("score-threshold-int32-overflow");
  return result;
}

export interface RewardRow {
  count: number;
  probability: number;
}
/** Marginal expectation for the supplied rank reward rows (probability / 10,000).
 * Event Item conversion and consumption multipliers belong to their own formula.
 */
export function rankRewardExpectation(rows: readonly RewardRow[]): number {
  let value = 0;
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.count) ||
      row.count < 0 ||
      !Number.isSafeInteger(row.probability) ||
      row.probability < 0 ||
      row.probability > 10000
    )
      throw new RangeError("reward-row");
    value += (row.count * row.probability) / 10000;
  }
  return value;
}

export function eventRewardMetrics(): { points: MetricValue; items: MetricValue } {
  return {
    points: unavailableMetric(
      "event-point-formula-and-active-event-inputs",
      "MasterEvent/MasterLiveEventPoint + event result service",
    ),
    items: unavailableMetric(
      "event-item-conversion-and-lottery",
      "active event reward/conversion tables + event result service",
    ),
  };
}
