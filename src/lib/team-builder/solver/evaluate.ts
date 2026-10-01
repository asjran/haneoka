import type {
  Candidate,
  MetricValue,
  Objective,
  OptimizationInput,
  ResolvedSlotProfile,
  SkillWindow,
  TeamAssignment,
} from "../contracts.ts";
import { eventRewardMetrics } from "../rewards.ts";
import {
  calcNativeNoteScore,
  nativeComboFactor,
  nativeDifficultyFactor,
  nativeLuckFactorPercent,
  nativeScoreUpFactor,
  unavailableMetric,
} from "../score.ts";
import type { PreparedSong } from "../song-metrics.ts";

interface WindowCacheEntry {
  song: PreparedSong;
  profile: ResolvedSlotProfile;
  active: SkillWindow[][];
}
/** Bounded coverage cache; chart judgements and skill intervals resolve once. */
function windowCache() {
  const entries: WindowCacheEntry[] = [];
  let nodes = 0;
  return (song: PreparedSong, profile: ResolvedSlotProfile): SkillWindow[][] => {
    const hit = entries.findIndex((entry) => entry.song === song && entry.profile === profile);
    if (hit >= 0) {
      const entry = entries.splice(hit, 1)[0]!;
      entries.push(entry);
      return entry.active;
    }
    const empty: SkillWindow[] = [];
    const active = song.nodes.map(() => empty);
    if (profile.windows.length > 512) throw new RangeError("skill-window-limit");
    for (const window of profile.windows) {
      if (!Object.values(window).every(Number.isFinite) || window.endMs < window.startMs)
        throw new RangeError("skill-window-state");
      let low = 0,
        high = song.nodes.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (song.nodes[mid]!.event.timeMs < window.startMs) low = mid + 1;
        else high = mid;
      }
      for (let i = low; i < song.nodes.length && song.nodes[i]!.event.timeMs <= window.endMs; i++) {
        if (active[i] === empty) active[i] = [window];
        else active[i]!.push(window);
      }
    }
    while (entries.length && (nodes + song.nodes.length > 100000 || entries.length >= 128))
      nodes -= entries.shift()!.song.nodes.length;
    entries.push({ song, profile, active });
    nodes += song.nodes.length;
    return active;
  };
}
export function createAssignmentEvaluator(
  input: OptimizationInput,
): (assignment: TeamAssignment, prepared: PreparedSong) => Candidate {
  const cache = windowCache();
  return (assignment, prepared) => evaluateAssignment(input, assignment, prepared, cache);
}

/** Scores a fully resolved native scenario. Missing runtime state remains null. */
export function evaluateAssignment(
  input: OptimizationInput,
  assignment: TeamAssignment,
  prepared: PreparedSong,
  coverage?: ReturnType<typeof windowCache>,
): Candidate {
  const model = input.evaluation;
  const context = model.songContexts[prepared.song.key];
  const profiles = assignment.memberInstanceIds.map(
    (member, slot) =>
      model.slots[prepared.song.key]?.[assignment.leaderInstanceId]?.[member]?.[
        assignment.snapshotInstanceIds[slot] ?? ""
      ] ?? model.defaultSlots?.[prepared.song.key]?.[member]?.[assignment.snapshotInstanceIds[slot] ?? ""],
  );
  const rewards = eventRewardMetrics();
  let score = unavailableMetric("unresolved-slot-or-song-context", "native power/skill/trigger/mission runtime state");
  const optionGaps = [
    ...assignment.memberInstanceIds.flatMap(
      (id) => input.members.find((member) => member.instanceId === id)?.gaps ?? [],
    ),
    ...assignment.snapshotInstanceIds.flatMap((id) =>
      id === null ? [] : (input.snapshots.find((snapshot) => snapshot.instanceId === id)?.gaps ?? []),
    ),
  ];
  const gaps = [
    ...optionGaps,
    ...model.gaps,
    ...prepared.gaps,
    ...(context?.gaps ?? []),
    ...profiles.flatMap((profile) => profile?.gaps ?? []),
  ];
  if (context && profiles.every((profile) => profile !== undefined) && gaps.length === 0) {
    const resolved = profiles.map((profile) => profile!);
    const basePower = resolved.reduce((sum, profile) => sum + profile.power, 0);
    const intervals = coverage ? resolved.map((profile) => coverage(prepared, profile)) : null;
    let total = context.fixedScore;
    for (const [index, node] of prepared.nodes.entries()) {
      // Effective windows are resolved by the native trigger/condition adapter.
      const active = intervals
        ? intervals.flatMap((rows) => rows[index]!)
        : resolved.flatMap((profile) =>
            profile.windows.filter(
              (window) => window.startMs <= node.event.timeMs && node.event.timeMs <= window.endMs,
            ),
          );
      const sum = (
        key:
          | "scoreBonus"
          | "perfectBonus"
          | "justBonus"
          | "comboBonus"
          | "gekisoComboBonus"
          | "luckBonusPercent"
          | "powerDelta",
      ) => active.reduce((value, window) => Math.fround(value + window[key]), 0);
      const common = {
        bandPower: basePower + sum("powerDelta"),
        adjustmentFactor: model.adjustmentFactor,
        musicDifficultyFactor: nativeDifficultyFactor(prepared.song.playLevel),
        convertedNoteCount: prepared.convertedNoteCount,
        notePercent: model.noteScorePercents[node.event.operateType]!,
        comboFactor: nativeComboFactor(node.comboBonus, sum("comboBonus"), sum("gekisoComboBonus")),
        luckFactorPercent: nativeLuckFactorPercent(sum("luckBonusPercent")),
        eventBonusFactor: context.eventBonusFactor,
        life: context.life,
        lifeOnusFactor: model.lifeOnusFactor,
        assistModeFactor: context.assistModeFactor,
      };
      const perfect = calcNativeNoteScore({
        ...common,
        judgementPercent: model.perfectPercent,
        scoreUpFactor: nativeScoreUpFactor(sum("scoreBonus"), sum("perfectBonus")),
      });
      const rate = model.mode === "gekiso" && node.justable ? input.constraints.justRate : 0;
      const just =
        rate > 0
          ? calcNativeNoteScore({
              ...common,
              judgementPercent: model.justPercent,
              scoreUpFactor: nativeScoreUpFactor(sum("scoreBonus"), sum("justBonus")),
            })
          : perfect;
      total += (1 - rate) * perfect + rate * just;
    }
    score = {
      value: total,
      status: model.assumptions.length || input.constraints.justRate > 0 ? "conditional" : "verified",
      assumptions: [...model.assumptions],
      gaps: [],
    };
    if (input.constraints.justRate > 0) score.assumptions.push("just-marginal-rate-fixed-runtime-state");
  } else score.gaps.push(...gaps);
  const computed = score;
  if (model.scope === "growth-only")
    score = unavailableMetric(
      "full-power-and-skill-context-unresolved",
      "native song/player/leader/snapshot/trigger bonuses",
    );
  const surplus: MetricValue =
    score.value !== null && context?.personalSS !== null && context?.personalSS !== undefined
      ? {
          ...score,
          value: score.value - context.personalSS,
          assumptions: [...score.assumptions],
          gaps: [...score.gaps],
        }
      : unavailableMetric("personal-ss-threshold-or-score-unresolved", "mode-specific native score-rank context");
  const metrics: Record<Objective, MetricValue> = {
    score,
    "base-score":
      model.scope === "growth-only"
        ? computed
        : unavailableMetric("base-score-scenario-not-requested", "evaluation scope"),
    "ss-surplus": surplus,
    "event-points": rewards.points,
    "event-items": rewards.items,
  };
  return {
    assignment,
    songKey: prepared.song.key,
    metrics,
    vector: input.objectives.map((objective) => metrics[objective].value ?? NaN),
  };
}
