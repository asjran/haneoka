import type { MetricValue } from "./contracts.ts";

/** Explicit runtime state for one canonical node. Rates are factors, not percentages. */
export interface NativeNoteScoreInput {
  bandPower: number;
  adjustmentFactor: number;
  musicDifficultyFactor: number;
  convertedNoteCount: number;
  notePercent: number;
  judgementPercent: number;
  comboFactor: number;
  scoreUpFactor: number;
  luckFactorPercent: number;
  eventBonusFactor: number;
  life: number;
  lifeOnusFactor: number;
  assistModeFactor: number;
}
const f = Math.fround;
const mul = (a: number, b: number) => f(f(a) * f(b));
const div = (a: number, b: number) => f(f(a) / f(b));

/** Intl 1.0.1 LiveScoreCalculator.CalcNoteScoreCore, VA 0x55e4e38.
 * Float32 at each arithmetic instruction; both native FloorToInt boundaries matter.
 */
export function calcNativeNoteScore(input: NativeNoteScoreInput): number {
  for (const [key, value] of Object.entries(input))
    if (!Number.isFinite(value)) throw new RangeError(`score-input:${key}`);
  if (
    !Number.isSafeInteger(input.bandPower) ||
    input.bandPower < 0 ||
    !Number.isSafeInteger(input.convertedNoteCount) ||
    input.convertedNoteCount <= 0
  )
    throw new RangeError("score-power-or-note-count");
  if (input.notePercent < 0 || input.judgementPercent < 0 || input.comboFactor < 0 || input.scoreUpFactor < 0)
    throw new RangeError("negative-score-factor");
  // Assembly order: adjustment * power, * difficulty; note%, judgement%,
  // combo, skill, luck%, / converted count; floor; event, LIFE, assist; floor.
  let value = mul(input.adjustmentFactor, input.bandPower);
  value = mul(value, input.musicDifficultyFactor);
  value = mul(div(input.notePercent, 100), value);
  value = mul(div(input.judgementPercent, 100), value);
  value = mul(value, input.comboFactor);
  value = mul(value, input.scoreUpFactor);
  value = mul(div(input.luckFactorPercent, 100), value);
  value = div(value, input.convertedNoteCount);
  value = f(Math.floor(value));
  value = mul(value, input.eventBonusFactor);
  value = mul(input.life > 0 ? 1 : input.lifeOnusFactor, value);
  value = mul(input.assistModeFactor, value);
  const result = Math.floor(value);
  if (result < 0 || result > 0x7fffffff) throw new RangeError("native-score-int32-overflow");
  return result;
}

/** CalcNoteScore caps ordinary and Gekiso combo ladders separately at +100%. */
export function nativeComboFactor(ordinaryBonus: number, skillComboBonus: number, gekisoBonus = 0): number {
  return mul(f(f(1 + Math.min(f(ordinaryBonus), 1)) + f(skillComboBonus)), f(1 + Math.min(f(gekisoBonus), 1)));
}
/** General and judgement-specific score-up factors add before the score core. */
export function nativeScoreUpFactor(generalBonus: number, judgementBonus = 0): number {
  return f(f(1 + f(generalBonus)) + f(judgementBonus));
}
/** LiveScoreController.AddJudgementNoteScoreUpFactor uses RoundToInt (ties-even)
 * after the float32 mill-percent product; the general type2000 path uses floor. */
export function nativeJudgementFactorMillPercent(additionalFactor: number): number {
  if (!Number.isFinite(additionalFactor)) throw new RangeError("judgement-factor-input");
  const scaled = mul(additionalFactor, 100000);
  const lower = Math.floor(scaled),
    fraction = scaled - lower;
  const rounded = fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
  if (!Number.isSafeInteger(rounded) || rounded < -0x80000000 || rounded > 0x7fffffff)
    throw new RangeError("judgement-factor-int32-overflow");
  return rounded === 0 ? 0 : rounded;
}
export function nativeLuckFactorPercent(bonusPercent: number): number {
  return Math.min(100 + bonusPercent, 200);
}
export function nativeDifficultyFactor(playLevel: number): number {
  if (!Number.isSafeInteger(playLevel)) throw new RangeError("play-level");
  return f(1 + mul(playLevel - 5, f(0.005)));
}
/** SkillEffectUpdater expires when elapsed > durationSeconds*1000 + extensionMs. */
export function isSkillActive(timeMs: number, startMs: number, seconds: number, extensionMs: number): boolean {
  return timeMs >= startMs && timeMs - startMs <= f(mul(seconds, 1000) + f(extensionMs));
}
export function unavailableMetric(code: string, source: string): MetricValue {
  return { value: null, status: "unavailable", assumptions: [], gaps: [{ code, source }] };
}
