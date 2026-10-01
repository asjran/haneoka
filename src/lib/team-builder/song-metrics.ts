import type { ChartEvent, EvidenceGap, SongOption } from "./contracts.ts";

export interface NoteRules {
  noteScorePercents: Record<number, number>;
  justJudgementTypes: number[];
  comboBonuses: { requiredCombo: number; bonus: number }[];
}
export interface PreparedSong {
  song: SongOption;
  convertedNoteCount: number;
  justableCount: number;
  /** One entry per canonical judged node, in its original order. */
  nodes: {
    event: ChartEvent;
    weight: number;
    comboFactor: number;
    comboBonus: number;
    justable: boolean;
    segmentIndex: number;
  }[];
  segments: { notes: number; justable: number; weightedNotes: number }[];
  gaps: EvidenceGap[];
}

/** Master-weighted count and chronology; rush segments do not reorder combos. */
export function prepareSong(song: SongOption, rules: NoteRules): PreparedSong {
  const gaps = [...song.gaps];
  const segments = song.segments.map(() => ({ notes: 0, justable: 0, weightedNotes: 0 }));
  const justableTypes = new Set(rules.justJudgementTypes);
  const bonuses = [...rules.comboBonuses].sort((a, b) => a.requiredCombo - b.requiredCombo);
  let weightTotal = 0;
  let comboBonus = 0;
  let bonusIndex = 0;
  let lastTime = -Infinity;
  let justableCount = 0;
  const nodes = song.events.map((event, index) => {
    if (!Number.isFinite(event.timeMs) || event.timeMs < lastTime) throw new RangeError("canonical-node-order");
    lastTime = event.timeMs;
    const percent = rules.noteScorePercents[event.operateType];
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0)
      throw new RangeError(`note-score-percent:${event.operateType}`);
    const weight = percent / 100;
    weightTotal += weight;
    while (bonusIndex < bonuses.length && bonuses[bonusIndex]!.requiredCombo <= index + 1) {
      comboBonus = Math.fround(comboBonus + Math.fround(bonuses[bonusIndex++]!.bonus));
    }
    const justable = justableTypes.has(event.judgementType);
    if (justable) justableCount++;
    const matching = song.segments.flatMap((segment, i) =>
      segment.startTick <= event.tick && event.tick <= segment.endTick ? [i] : [],
    );
    if (matching.length > 1 && !gaps.some((gap) => gap.code === "overlapping-mission-segments")) {
      gaps.push({ code: "overlapping-mission-segments", source: "canonical chart fever ranges" });
    }
    const segmentIndex = matching[0] ?? -1;
    const segment = segments[segmentIndex];
    if (segment) {
      segment.notes++;
      segment.justable += Number(justable);
      segment.weightedNotes += weight;
    }
    return { event, weight, comboFactor: Math.fround(1 + comboBonus), comboBonus, justable, segmentIndex };
  });
  // Sum integer percentages first: repeated 0.1 additions can round above an integer.
  const convertedNoteCount = Math.ceil(
    song.events.reduce((sum, event) => sum + rules.noteScorePercents[event.operateType]!, 0) / 100,
  );
  if (convertedNoteCount <= 0 || !Number.isFinite(weightTotal)) throw new RangeError("empty-chart");
  return { song, convertedNoteCount, justableCount, nodes, segments, gaps };
}

export interface WeightedOutcome {
  value: number;
  weight: number;
}
/** The linear mean of a Master lottery; threshold/rush expectations need its state machine. */
export function weightedMean(outcomes: readonly WeightedOutcome[]): number {
  let total = 0;
  let weighted = 0;
  for (const outcome of outcomes) {
    if (!Number.isFinite(outcome.value) || !Number.isFinite(outcome.weight) || outcome.weight < 0)
      throw new RangeError("lottery-outcome");
    total += outcome.weight;
    weighted += outcome.value * outcome.weight;
  }
  if (!(total > 0)) throw new RangeError("empty-lottery");
  return weighted / total;
}

/** LuckGekisouLotteryMachine.GetBasePoint / IsSubNote, Intl 1.0.1.
 * Classification uses operation, independently of JUST timing eligibility.
 */
export function luckCategory(operateType: number): 0 | 1 | null {
  if ([0, 80, 82, 100, 101, 102, 103, 104, 105, 121, 122].includes(operateType)) return null;
  return [21, 60, 61, 62, 63, 120].includes(operateType) ? 1 : 0;
}
export function expectedLuckCharge(
  events: readonly ChartEvent[],
  distributions: Record<0 | 1, WeightedOutcome[]>,
): number {
  const normal = weightedMean(distributions[0]);
  const sub = weightedMean(distributions[1]);
  return events.reduce((sum, event) => {
    const category = luckCategory(event.operateType);
    return sum + (category === null ? 0 : category === 1 ? sub : normal);
  }, 0);
}

export function tickToTimeMs(changes: readonly { bpm: number; tick: number; timeMs: number }[], tick: number): number {
  const first = changes[0];
  if (!first) return Math.floor((tick * 60000) / (120 * 480));
  let segment = first;
  for (const change of changes) {
    if (change.tick <= tick) segment = change;
    else break;
  }
  return Math.floor(segment.timeMs + ((tick - segment.tick) * 60000) / Math.fround(segment.bpm * 480));
}
