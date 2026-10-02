import type { EvidenceGap, ReleaseIdentity } from "../contracts.ts";
import { calcNativeNoteScore, nativeLuckFactorPercent, type NativeNoteScoreInput } from "../score.ts";
import { calculateSSRatio } from "./score-ranks.ts";

const f = Math.fround;
const i32 = (value: number) => value | 0;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const nonnegative = (value: unknown): value is number => integer(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(f(value));
export interface GekisoResolved<T> {
  value: T | null;
  gaps: EvidenceGap[];
}
const known = <T>(value: T): GekisoResolved<T> => ({ value, gaps: [] });
const unknown = <T>(code: string, source: string): GekisoResolved<T> => ({ value: null, gaps: [{ code, source }] });
type Row = Readonly<Record<string, unknown>>;
const row = (raw: Row): Record<string, unknown> =>
  Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/^_/u, ""), value]));
export type GekisoMission = 1 | 2 | 3;
export type LuckLotResult = 0 | 1 | 2 | 3;
export type GekisoScoreDomain = "personal-live" | "personal-solo" | "room-live";
const lotResult = (value: unknown): value is LuckLotResult => nonnegative(value) && value <= 3;
export interface GekisoRuleIdentity extends ReleaseIdentity {
  sourceId?: string;
}
export interface GekisoRules extends GekisoRuleIdentity {
  /** rangeIndex -> rank1..5 percentages, from the song's missionPattern. */
  rankingPercents: readonly (readonly number[])[];
  luckGaugeMax: number;
  luckGaugeMaxRush: number;
  luckRushScoreBonusPercent: number;
  basePointTables: Readonly<Record<string, readonly { value: number; weight: number }[]>>;
  bonusLotTables: Readonly<Record<number, readonly { result: LuckLotResult; weight: number }[]>>;
}

/** Prepare the small same-pin tables once, outside the candidate loop. */
export function prepareGekisoRules(input: {
  identity: GekisoRuleIdentity;
  expectedIdentity: GekisoRuleIdentity;
  missionPattern: number;
  settings: readonly Row[];
  rankingBonuses: readonly Row[];
  luckBasePoints: readonly Row[];
  luckBonusLots: readonly Row[];
}): GekisoResolved<GekisoRules> {
  if (!input.identity.sourceId || !input.expectedIdentity.sourceId)
    return unknown("gekiso-rule-source-identity-unresolved", "observed same-pin sourceId");
  if (
    input.identity.server !== input.expectedIdentity.server ||
    input.identity.releaseId !== input.expectedIdentity.releaseId ||
    input.identity.sourceId !== input.expectedIdentity.sourceId
  )
    return unknown("gekiso-rule-identity-mismatch", "same server/release pin");
  if (!nonnegative(input.missionPattern) || input.missionPattern < 1)
    return unknown("gekiso-mission-pattern-unresolved", "selected song missionPattern");
  const settings = input.settings.map(row);
  const setting = (key: string) => {
    const found = settings.filter((value) => value.key === key);
    if (found.length !== 1) return null;
    const value = Number(found[0]!.value);
    return nonnegative(value) ? value : null;
  };
  const normal = setting("gekisou_luck_gauge_max"),
    rush = setting("gekisou_luck_gauge_max_rush"),
    rushBonus = setting("gekisou_luck_rush_score_bonus_percent");
  if (normal === null || normal < 1 || rush === null || rush < 1 || rushBonus === null)
    return unknown("gekiso-luck-settings-unresolved", "MasterLiveSettings gauge/rush values");
  const rankingPercents: (number | null)[][] = Array.from({ length: 3 }, () => Array(5).fill(null));
  for (const raw of input.rankingBonuses) {
    const value = row(raw);
    if (value.missionPattern !== input.missionPattern) continue;
    if (
      !nonnegative(value.count) ||
      value.count < 1 ||
      value.count > 3 ||
      !nonnegative(value.rank) ||
      value.rank < 1 ||
      value.rank > 5 ||
      !integer(value.scoreBonusPercent)
    )
      return unknown("gekiso-ranking-row-invalid", `MasterLiveGekisouRankingScoreBonus:${value.id}`);
    if (rankingPercents[value.count - 1]![value.rank - 1] !== null)
      return unknown("gekiso-ranking-row-duplicate", `range:${value.count}/rank:${value.rank}`);
    rankingPercents[value.count - 1]![value.rank - 1] = value.scoreBonusPercent;
  }
  if (rankingPercents.some((values) => values.some((value) => value === null)))
    return unknown("gekiso-ranking-matrix-incomplete", `missionPattern:${input.missionPattern}`);
  const basePointTables: Record<string, { value: number; weight: number }[]> = {};
  for (const raw of input.luckBasePoints) {
    const value = row(raw);
    if (
      (value.noteCategory !== 0 && value.noteCategory !== 1) ||
      !integer(value.noteSimulateJudgement) ||
      !nonnegative(value.basePoint) ||
      !nonnegative(value.weight)
    )
      return unknown("gekiso-base-point-row-invalid", `MasterLiveGekisouLuckBasePoint:${value.id}`);
    const key = `${value.noteCategory}:${value.noteSimulateJudgement}`;
    (basePointTables[key] ??= []).push({ value: value.basePoint, weight: value.weight });
  }
  for (const key of ["0:3", "0:4", "0:5", "1:5"])
    if (!(basePointTables[key]?.reduce((sum, value) => sum + value.weight, 0)! > 0))
      return unknown("gekiso-base-point-table-missing", key);
  const bonusLotTables: Record<number, { result: LuckLotResult; weight: number }[]> = {};
  for (const raw of input.luckBonusLots) {
    const value = row(raw);
    if (
      !nonnegative(value.chanceLotType) ||
      value.chanceLotType > 4 ||
      !lotResult(value.lotResult) ||
      !nonnegative(value.weight)
    )
      return unknown("gekiso-bonus-lot-row-invalid", `MasterLiveGekisouLuckBonusLot:${value.id}`);
    (bonusLotTables[value.chanceLotType] ??= []).push({ result: value.lotResult, weight: value.weight });
  }
  for (let chance = 0; chance <= 4; chance++)
    if (!(bonusLotTables[chance]?.reduce((sum, value) => sum + value.weight, 0)! > 0))
      return unknown("gekiso-bonus-lot-table-missing", `chance:${chance}`);
  return known({
    ...input.identity,
    rankingPercents: rankingPercents as number[][],
    luckGaugeMax: normal,
    luckGaugeMaxRush: rush,
    luckRushScoreBonusPercent: rushBonus,
    basePointTables,
    bonusLotTables,
  });
}

export interface GekisoSelectedSkill {
  id: number;
  level: number;
  mission: 0 | GekisoMission | 4;
  effectRows: readonly Row[];
  /** Preserve the native getter result; interpretation belongs to the trigger factory. */
  supportExecTiming?: number;
}
export interface GekisoSelectedMember {
  memberSkillIndex: number;
  member: GekisoSelectedSkill | null;
  supports: readonly [GekisoSelectedSkill | null, GekisoSelectedSkill | null];
  gaps: readonly EvidenceGap[];
}
export interface GekisoSkillBinding {
  formationSlot: number;
  memberSkillIndex: number;
  physicalSupportSlot: "01" | "02" | null;
  nativeCompactSkillIndex: number | null;
  skill: GekisoSelectedSkill;
  effectsAtLevel: readonly Record<string, unknown>[];
}
/** Select only the supplied five members and their two physical support slots.
 * This returns level rows, not activated effects; conditions/counters stay upstream.
 */
export function resolveSelectedGekisoSkills(selected: readonly GekisoSelectedMember[]): GekisoResolved<{
  membersByMission: Readonly<Record<GekisoMission, readonly GekisoSkillBinding[]>>;
  supports: readonly GekisoSkillBinding[];
}> {
  const inputGaps = selected.flatMap((value) => value.gaps);
  if (inputGaps.length) return { value: null, gaps: inputGaps };
  if (
    selected.length !== 5 ||
    new Set(selected.map((value) => value.memberSkillIndex)).size !== 5 ||
    selected.some(
      (value) => !nonnegative(value.memberSkillIndex) || value.memberSkillIndex > 4 || value.supports.length !== 2,
    )
  )
    return unknown("gekiso-five-selected-member-indices-required", "selected formation");
  const membersByMission: Record<GekisoMission, GekisoSkillBinding[]> = { 1: [], 2: [], 3: [] },
    supports: GekisoSkillBinding[] = [];
  for (const [formationSlot, owner] of selected.entries()) {
    let compact = 0;
    for (const [index, skill] of [owner.member, ...owner.supports].entries()) {
      if (!skill) continue;
      const compactIndex = index === 0 ? null : compact++;
      if (
        !nonnegative(skill.id) ||
        skill.id < 1 ||
        !nonnegative(skill.level) ||
        skill.level < 1 ||
        !nonnegative(skill.mission) ||
        skill.mission > 4
      )
        return unknown("gekiso-selected-skill-invalid", `slot:${formationSlot}/skill:${skill.id}`);
      if (index && !nonnegative(skill.supportExecTiming))
        return unknown("gekiso-support-exec-timing-unresolved", `slot:${formationSlot}/skill:${skill.id}`);
      const idKey = index === 0 ? "gekisouSkillID" : "gekisouSupportSkillID";
      const effectsAtLevel = skill.effectRows
        .map(row)
        .filter((value) => value.level === skill.level && (value[idKey] === undefined || value[idKey] === skill.id));
      if (skill.mission !== 0 && !effectsAtLevel.length)
        return unknown("gekiso-selected-skill-level-missing", `skill:${skill.id}/level:${skill.level}`);
      const binding: GekisoSkillBinding = {
        formationSlot,
        memberSkillIndex: owner.memberSkillIndex,
        physicalSupportSlot: index === 0 ? null : index === 1 ? "01" : "02",
        nativeCompactSkillIndex: compactIndex,
        skill,
        effectsAtLevel,
      };
      if (index) supports.push(binding);
      else if (skill.mission === 4) for (const mission of [1, 2, 3] as const) membersByMission[mission].push(binding);
      else if (skill.mission) membersByMission[skill.mission].push(binding);
    }
  }
  return known({ membersByMission, supports });
}

/** GetScoreFrame and GetTimingComboInRange use the previous 40ms score frame. */
export function gekisoPreviousScoreFrameEnd(timeMs: number): number {
  if (!integer(timeMs)) throw new RangeError("gekiso-note-time");
  return i32((timeMs < 1 ? 0 : Math.ceil(f(f(timeMs) / f(40)))) * 40 - 40);
}
export function resolveGekisoComboFactor(input: {
  hasNativeRangeCombo: boolean | null;
  nativeBonusAtPreviousFrame: number | null;
}): GekisoResolved<number> {
  if (input.hasNativeRangeCombo === false) return known(f(1));
  if (typeof input.hasNativeRangeCombo !== "boolean" || !finite(input.nativeBonusAtPreviousFrame))
    return unknown(
      "gekiso-timing-combo-or-ladder-unresolved",
      "native range history at previous40ms frame/type1 ladder",
    );
  return known(f(f(1) + Math.min(f(input.nativeBonusAtPreviousFrame), f(1))));
}

export function resolveGekisoRankingBonus(input: {
  rules: GekisoRules;
  rangeIndex: number;
  complete: boolean | null;
  /** Explicit solo rank1; room rank comes from actual grouped players. */
  rank: number | null;
  startTimingScore: number | null;
  endTimingScore: number | null;
}): GekisoResolved<{ rangeScore: number; percent: number; fixedScore: number }> {
  if (
    input.complete !== true ||
    !nonnegative(input.rangeIndex) ||
    input.rangeIndex > 2 ||
    input.rank === null ||
    !nonnegative(input.rank) ||
    input.rank < 1 ||
    input.rank > 5 ||
    !integer(input.startTimingScore) ||
    !integer(input.endTimingScore)
  )
    return unknown("gekiso-completed-range-score-or-rank-unresolved", `range:${input.rangeIndex}`);
  const rangeScore = i32(input.endTimingScore - input.startTimingScore),
    percent = input.rules.rankingPercents[input.rangeIndex]?.[input.rank - 1];
  if (!integer(percent))
    return unknown("gekiso-ranking-percent-unresolved", `range:${input.rangeIndex}/rank:${input.rank}`);
  // Native signed64 product, signed division truncating toward zero, then int32.
  const fixedScore = Number(BigInt.asIntN(32, (BigInt(rangeScore) * BigInt(percent)) / 100n));
  return known({ rangeScore, percent, fixedScore });
}

export interface GekisoLuckState {
  gaugeValue: number;
  lotCount: number;
  rushCombo: number;
  next: -1 | LuckLotResult;
  totalBonusPoint: number;
  gaugeMax: number;
  normalGaugeMax: number;
  rushGaugeMax: number;
  resultCounts: readonly [number, number, number, number];
}
/** LuckGaugeUp/LotProbabilityUp pass the resolved effect integer as a BP factor. */
export function resolveGekisoEffectFactorBP(effectValueBP: number | null): GekisoResolved<number> {
  return integer(effectValueBP)
    ? known(f(f(effectValueBP) / f(10000)))
    : unknown("gekiso-effect-value-bp-unresolved", "resolved effect value");
}
/** Instant gauge-percent applier multiplies in signed32 before float32 division. */
export function resolveGekisoInstantGaugeBP(
  currentGaugeMax: number | null,
  effectValueBP: number | null,
): GekisoResolved<number> {
  if (!integer(currentGaugeMax) || currentGaugeMax < 1 || !integer(effectValueBP))
    return unknown("gekiso-instant-gauge-input-unresolved", "native current gauge max and resolved BP value");
  const value = Math.floor(f(f(Math.imul(currentGaugeMax, effectValueBP)) / f(10000)));
  return integer(value)
    ? known(value)
    : unknown("gekiso-instant-gauge-out-of-int32", "signed32 multiply/float32 divide/floor");
}
/** Managed zero initialization, LuckScore ctor defaults, then actual range settings. */
export function createGekisoLuckState(rules: GekisoRules): GekisoLuckState {
  return {
    gaugeValue: 0,
    lotCount: 0,
    rushCombo: 0,
    next: -1,
    totalBonusPoint: 0,
    gaugeMax: rules.luckGaugeMax,
    normalGaugeMax: rules.luckGaugeMax,
    rushGaugeMax: rules.luckGaugeMaxRush,
    resultCounts: [0, 0, 0, 0],
  };
}
function basePointKey(operation: number, judgement: number): { key: string | null; consumesDraw: boolean } {
  if ([0, 80, 82, 100, 101, 102, 103, 104, 105, 121, 122].includes(operation) || [-1, 0, 1, 7].includes(judgement))
    return { key: null, consumesDraw: false };
  if ([21, 60, 61, 62, 63, 120].includes(operation)) return { key: "1:5", consumesDraw: true };
  return { key: [3, 4, 5, 6].includes(judgement) ? `0:${judgement === 6 ? 5 : judgement}` : null, consumesDraw: true };
}
/** Consume an already resolved native base-point outcome; never substitute its mean. */
export function resolveGekisoLuckCharge(
  rules: GekisoRules,
  input: {
    operation: number;
    judgement: number;
    basePointDraw: number | null;
    gaugeUpFactor: number | null;
  },
): GekisoResolved<{ charge: number; basePoint: number; consumesBasePointDraw: boolean }> {
  if (!integer(input.operation) || !integer(input.judgement) || !finite(input.gaugeUpFactor))
    return unknown(
      "gekiso-luck-note-or-gauge-factor-unresolved",
      "native note and factor history at its original time",
    );
  const selection = basePointKey(input.operation, input.judgement);
  let basePoint = 0;
  if (selection.key !== null) {
    const values = rules.basePointTables[selection.key];
    if (input.basePointDraw === null) return unknown("gekiso-base-point-random-outcome-required", selection.key);
    if (
      !nonnegative(input.basePointDraw) ||
      !values?.some((value) => value.weight > 0 && value.value === input.basePointDraw)
    )
      return unknown("gekiso-base-point-outcome-invalid", selection.key);
    basePoint = input.basePointDraw;
  }
  const charge = Math.floor(f(f(f(1) + f(input.gaugeUpFactor)) * f(basePoint)));
  if (!integer(charge)) return unknown("gekiso-luck-charge-out-of-int32", "float32 charge floor");
  return known({ charge, basePoint, consumesBasePointDraw: selection.consumesDraw });
}
/** Linear charge only: floor each native outcome before taking its weighted mean. */
export function expectedGekisoLuckCharge(
  rules: GekisoRules,
  input: {
    operation: number;
    judgement: number;
    gaugeUpFactor: number | null;
  },
): GekisoResolved<number> {
  if (!integer(input.operation) || !integer(input.judgement) || !finite(input.gaugeUpFactor))
    return unknown("gekiso-luck-note-or-gauge-factor-unresolved", "linear charge input");
  const selection = basePointKey(input.operation, input.judgement);
  if (selection.key === null) return known(0);
  const values = rules.basePointTables[selection.key];
  if (!values?.length) return unknown("gekiso-base-point-table-missing", selection.key);
  let weight = 0,
    sum = 0;
  for (const value of values) {
    const charge = Math.floor(f(f(f(1) + f(input.gaugeUpFactor)) * f(value.value)));
    if (!integer(charge)) return unknown("gekiso-luck-charge-out-of-int32", selection.key);
    weight += value.weight;
    sum += charge * value.weight;
  }
  return weight > 0 ? known(sum / weight) : unknown("gekiso-base-point-table-empty", selection.key);
}

export interface ResolvedLuckDraw {
  chanceType: number;
  /** Native outcome after active minimum-result rules and their remaining quota. */
  result: LuckLotResult;
  /** floor(float32(probabilityUpFactor*100)) at the draw's original time. */
  probabilityBuffPercent: number;
}
export interface GekisoLuckStep {
  state: GekisoLuckState | null;
  charge: number | null;
  /** Native caller permits consumption at states<=5; pending-frame requires Playing=4. */
  rangeState: number | null;
  kind: "judged-note" | "pending-frame";
  currentFrameHasLotResult: boolean | null;
  probabilityUpFactor: number | null;
  rushBonusHandleActive: boolean | null;
  initialDraw: ResolvedLuckDraw | null;
  nextDraw: ResolvedLuckDraw | null;
}
export interface GekisoLuckStepResult {
  state: GekisoLuckState;
  consumed: LuckLotResult | null;
  nextChanceType: number;
  probabilityBuffPercent: number;
  /** Points affect mission ranking. Only this separate rush command changes note score. */
  rushScoreCommand: { kind: "enable" | "disable"; percent: number } | null;
}
export function resolveGekisoLuckStep(rules: GekisoRules, input: GekisoLuckStep): GekisoResolved<GekisoLuckStepResult> {
  const source = "GekisouController.UpdateLuckGekisou/ConsumeLotAndProcessLottery";
  if (
    !input.state ||
    !integer(input.charge) ||
    !nonnegative(input.rangeState) ||
    !finite(input.probabilityUpFactor) ||
    typeof input.rushBonusHandleActive !== "boolean" ||
    (input.kind !== "judged-note" && input.kind !== "pending-frame") ||
    (input.kind === "pending-frame" && typeof input.currentFrameHasLotResult !== "boolean")
  )
    return unknown("gekiso-luck-runtime-state-required", source);
  if (input.kind === "pending-frame" && input.charge !== 0)
    return unknown("gekiso-pending-frame-charge-invalid", source);
  const original = input.state;
  if (
    original.resultCounts.length !== 4 ||
    ![
      original.gaugeValue,
      original.lotCount,
      original.rushCombo,
      original.totalBonusPoint,
      ...original.resultCounts,
    ].every(nonnegative) ||
    !nonnegative(original.gaugeMax) ||
    original.gaugeMax < 1 ||
    !nonnegative(original.normalGaugeMax) ||
    original.normalGaugeMax < 1 ||
    !nonnegative(original.rushGaugeMax) ||
    original.rushGaugeMax < 1 ||
    (original.next !== -1 && !lotResult(original.next))
  )
    return unknown("gekiso-luck-runtime-state-invalid", source);
  const probabilityBuffPercent = Math.floor(f(f(input.probabilityUpFactor) * f(100)));
  if (!integer(probabilityBuffPercent)) return unknown("gekiso-luck-probability-factor-invalid", source);
  const state = { ...original, resultCounts: [...original.resultCounts] as [number, number, number, number] };
  if (input.kind === "judged-note") state.gaugeValue = i32(state.gaugeValue + input.charge);
  if (input.kind === "judged-note" && state.gaugeValue >= state.gaugeMax) {
    const count = Math.floor(state.gaugeValue / state.gaugeMax);
    state.gaugeValue = i32(state.gaugeValue - count * state.gaugeMax);
    state.lotCount = i32(state.lotCount + count);
  }
  if (state.gaugeValue < 0 || state.lotCount < 0)
    return unknown("gekiso-luck-signed-overflow-state-unresolved", source);
  const chance = () => (state.rushCombo <= 3 ? [0, 4, 3, 2][state.rushCombo]! : 1);
  const unchanged = (): GekisoResolved<GekisoLuckStepResult> =>
    known({ state, consumed: null, nextChanceType: chance(), probabilityBuffPercent, rushScoreCommand: null });
  if (
    input.rangeState > 5 ||
    state.lotCount < 1 ||
    (input.kind === "pending-frame" && (input.rangeState !== 4 || input.currentFrameHasLotResult))
  )
    return unchanged();
  const drawMatches = (draw: ResolvedLuckDraw | null, chanceType: number) =>
    draw &&
    draw.chanceType === chanceType &&
    lotResult(draw.result) &&
    draw.probabilityBuffPercent === probabilityBuffPercent;
  if (state.next === -1) {
    if (!drawMatches(input.initialDraw, 0))
      return unknown("gekiso-initial-lot-random-outcome-required", "normal chance0 before first consumption");
    state.next = input.initialDraw!.result;
  }
  const consumed = state.next,
    wasRush = state.rushCombo !== 0;
  state.lotCount = i32(state.lotCount - 1); // Exactly one lot per invocation.
  state.totalBonusPoint = i32(state.totalBonusPoint + [0, 5, 10, 10][consumed]!);
  state.resultCounts[consumed] = i32(state.resultCounts[consumed] + 1);
  state.rushCombo = consumed === 3 ? i32(state.rushCombo + 1) : 0;
  if (state.rushCombo < 0 || state.totalBonusPoint < 0 || state.resultCounts[consumed] < 0)
    return unknown("gekiso-luck-signed-overflow-state-unresolved", source);
  const maximum = consumed === 3 ? state.rushGaugeMax : state.normalGaugeMax;
  if (maximum !== state.gaugeMax) {
    state.gaugeMax = maximum;
    if (state.gaugeValue > maximum) {
      // Equality intentionally does not flush.
      const count = Math.floor(state.gaugeValue / maximum);
      state.gaugeValue = i32(state.gaugeValue - count * maximum);
      state.lotCount = i32(state.lotCount + count);
    }
  }
  const nextChanceType = chance();
  if (!drawMatches(input.nextDraw, nextChanceType))
    return unknown("gekiso-next-lot-random-outcome-required", `prefetch chance:${nextChanceType}`);
  state.next = input.nextDraw!.result;
  const rushScoreCommand =
    consumed === 3 && !wasRush
      ? { kind: "enable" as const, percent: rules.luckRushScoreBonusPercent }
      : consumed !== 3 && input.rushBonusHandleActive
        ? { kind: "disable" as const, percent: rules.luckRushScoreBonusPercent }
        : null;
  return known({ state, consumed, nextChanceType, probabilityBuffPercent, rushScoreCommand });
}

/** JUST marginal scoring is conditional on explicitly fixed runtime factors. */
export function resolveGekisoNoteScore(input: {
  factors: Omit<NativeNoteScoreInput, "judgementPercent" | "luckFactorPercent"> | null;
  luckBonusPercent: number | null;
  justable: boolean;
  justRate: number;
  perfectPercent: number;
  justPercent: number;
}): GekisoResolved<{ perfect: number; just: number; conditionalMean: number }> {
  if (
    !input.factors ||
    !finite(input.luckBonusPercent) ||
    !Number.isFinite(input.justRate) ||
    input.justRate < 0 ||
    input.justRate > 1 ||
    !finite(input.perfectPercent) ||
    !finite(input.justPercent)
  )
    return unknown("gekiso-note-runtime-factors-required", "fixed factors and JUST marginal rate");
  const luckFactorPercent = nativeLuckFactorPercent(input.luckBonusPercent);
  const perfect = calcNativeNoteScore({ ...input.factors, luckFactorPercent, judgementPercent: input.perfectPercent });
  const just = input.justable
    ? calcNativeNoteScore({ ...input.factors, luckFactorPercent, judgementPercent: input.justPercent })
    : perfect;
  const rate = input.justable ? input.justRate : 0;
  return known({ perfect, just, conditionalMean: (1 - rate) * perfect + rate * just });
}
export function resolveGekisoSSTargets(input: {
  score: number | null;
  scoreDomain: GekisoScoreDomain;
  ssThreshold: number | null;
  thresholdDomain: GekisoScoreDomain;
}): GekisoResolved<{ ratio: number; surplus: number }> {
  if (input.scoreDomain !== input.thresholdDomain)
    return unknown("gekiso-ss-domain-or-threshold-unresolved", `${input.scoreDomain}/${input.thresholdDomain}`);
  const domain = input.scoreDomain === "room-live" ? "room" : "personal";
  const ratio = calculateSSRatio(input.score, input.ssThreshold, domain, domain);
  return ratio === null
    ? unknown("gekiso-ss-domain-or-threshold-unresolved", `${input.scoreDomain}/${input.thresholdDomain}`)
    : known({ ratio, surplus: input.score! - input.ssThreshold! });
}
