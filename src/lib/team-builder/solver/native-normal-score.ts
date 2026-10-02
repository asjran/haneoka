import type { EvidenceGap, MetricValue, OptimizationInput, ResolvedSlotProfile, TeamAssignment } from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import type { PreparedSong } from "../song-metrics.ts";
import { calcNativeNoteScore, nativeComboFactor, nativeDifficultyFactor, unavailableMetric } from "../score.ts";

import {
  buildNormalSkillWindows,
  normalSkillOrders,
  resolveNormalSkillEffects,
  type NormalSkillPlan,
} from "./normal-skills.ts";
import { addPower, floorPowerBP } from "./power.ts";

const f = Math.fround;
interface PrefixEntry {
  song: PreparedSong;
  power: number;
  factor: number;
  sums: Float64Array;
}
const gap = (code: string, source: string): EvidenceGap => ({ code, source });
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;

const orders = normalSkillOrders();
function lowerBound(song: PreparedSong, timeMs: number): number {
  let low = 0,
    high = song.nodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (song.nodes[middle]!.event.timeMs < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Prepare immutable live effects and chart event identities once. Per-order
 * commands retain the chart's original index even when their times are unsorted.
 * The first normal scope is positive-duration, unconditional type2000, with
 * snapshots excluded; unsupported state machines retain an explicit gap.
 */
export function createNativeNormalScoreResolver(data: TeamBuilderData, input: OptimizationInput) {
  const gaps: EvidenceGap[] = [];
  const phaseRows = dataRows(data.skillReference.effectSettings).map(nativeRow);
  const phase = phaseRows.filter((row) => row.skillEffectType === 2000);
  if (phase.length !== 1 || phase[0]!.phase !== 2)
    gaps.push(gap("native-normal-effect-phase-unresolved", "same-release MasterSkillEffectSetting/2000"));
  if (input.constraints.teamSize !== 5) gaps.push(gap("native-normal-requires-five-members", "normal formation"));
  if (input.snapshots.some((snapshot) => !input.constraints.excludedSnapshotIds.includes(snapshot.instanceId)))
    gaps.push(gap("native-normal-snapshot-search-unresolved", "exclude snapshots for this normal scope"));
  const phaseByEffectType = Object.fromEntries(
    phaseRows.map((row) => [Number(row.skillEffectType), Number(row.phase)]),
  );
  const members = new Map<string, NormalSkillPlan>();
  for (const member of input.members) {
    const raw = data.skills.live?.[String(member.liveSkillId)];
    const plan = resolveNormalSkillEffects({
      rows: dataRows(raw?.effects),
      kind: "live",
      skillId: member.liveSkillId,
      level: member.liveSkillLevel,
      phaseByEffectType,
    });
    if (plan.effects.some((effect) => effect.type !== 2000))
      members.set(member.instanceId, {
        effects: [],
        gaps: [...plan.gaps, gap("native-normal-basic-live-skills-required", member.instanceId)],
      });
    else members.set(member.instanceId, plan);
  }
  const charts = new Map(input.songs.map((song) => [song.key, [...song.skillTimesMs]]));
  const prefixes: PrefixEntry[] = [];
  let cachedNodes = 0;
  const interrupted = (controls: SearchEvaluationControls) => controls.cancelled() || controls.expired();
  async function prefix(song: PreparedSong, power: number, factor: number, controls: SearchEvaluationControls) {
    const found = prefixes.findIndex(
      (entry) => entry.song === song && entry.power === power && entry.factor === factor,
    );
    if (found >= 0) {
      const entry = prefixes.splice(found, 1)[0]!;
      prefixes.push(entry);
      return entry.sums;
    }
    const model = input.evaluation,
      context = model.songContexts[song.song.key]!;
    const sums = new Float64Array(song.nodes.length + 1);
    for (const [index, node] of song.nodes.entries()) {
      if (index % 2048 === 0) {
        if (interrupted(controls)) return null;
        if (index) {
          controls.progress();
          await controls.yield();
        }
      }
      sums[index + 1] =
        sums[index]! +
        calcNativeNoteScore({
          bandPower: power,
          adjustmentFactor: model.adjustmentFactor,
          musicDifficultyFactor: nativeDifficultyFactor(song.song.playLevel),
          convertedNoteCount: song.convertedNoteCount,
          notePercent: model.noteScorePercents[node.event.operateType]!,
          judgementPercent: model.perfectPercent,
          comboFactor: nativeComboFactor(node.comboBonus, 0),
          scoreUpFactor: factor,
          luckFactorPercent: 100,
          eventBonusFactor: context.eventBonusFactor,
          life: context.life,
          lifeOnusFactor: model.lifeOnusFactor,
          assistModeFactor: context.assistModeFactor,
        });
    }
    while (prefixes.length && (prefixes.length >= 48 || cachedNodes + sums.length > 200000))
      cachedNodes -= prefixes.shift()!.sums.length;
    prefixes.push({ song, power, factor, sums });
    cachedNodes += sums.length;
    return sums;
  }
  return {
    gaps,
    async score(
      assignment: TeamAssignment,
      song: PreparedSong,
      profiles: readonly (ResolvedSlotProfile | undefined)[],
      controls: SearchEvaluationControls,
    ): Promise<MetricValue> {
      const local = [
        ...gaps,
        ...song.gaps,
        ...profiles.flatMap((profile) => profile?.gaps ?? [gap("native-normal-slot-unresolved", song.song.key)]),
      ];
      const times = charts.get(song.song.key);
      if (!times || times.length !== 5 || times.some((time) => !int(time)))
        local.push(gap("native-normal-chart-events-unresolved", song.song.key));
      if (assignment.snapshotInstanceIds.some((id) => id !== null))
        local.push(gap("native-normal-support-runtime-unresolved", "selected snapshots"));
      const nativeMembers = [...assignment.memberInstanceIds];
      const leaderSlot = nativeMembers.indexOf(assignment.leaderInstanceId);
      if (nativeMembers.length !== 5 || leaderSlot < 0)
        local.push(gap("native-normal-formation-unresolved", "assignment"));
      else [nativeMembers[2], nativeMembers[leaderSlot]] = [nativeMembers[leaderSlot]!, nativeMembers[2]!];
      const plans = nativeMembers.map((id) => members.get(id));
      for (const [slot, plan] of plans.entries())
        local.push(...(plan?.gaps ?? [gap("native-normal-member-unresolved", nativeMembers[slot]!)]));
      if (local.length) return { value: null, status: "unavailable", assumptions: [], gaps: local };
      // LiveDataCreator passes DeckPowerResult.TotalPower.get_Total to
      // MemberDataContainer.SelfDeckTotalPower, after the BP vectors are summed.
      const deck = profiles.every((profile) => profile!.bpPower)
        ? floorPowerBP(addPower(...profiles.map((profile) => profile!.bpPower!)))
        : null;
      const power = deck
        ? ((deck.performance + deck.technique + deck.visual) / 10000) | 0
        : profiles.reduce((sum, profile) => sum + profile!.power, 0);
      const lastNoteMs = song.nodes.at(-1)!.event.timeMs;
      for (const plan of plans)
        for (const timeMs of times!)
          for (const effect of plan!.effects) {
            const finish = (timeMs + Math.ceil(f(f(effect.seconds) * f(1000)))) | 0;
            if (finish < timeMs || finish > lastNoteMs)
              local.push(gap("native-music-length-required-for-skill-finish", song.song.key));
          }
      if (local.length) return { value: null, status: "unavailable", assumptions: [], gaps: local };
      const formation = plans.map((live) => ({ live: live!, supports: [null, null] as const }));
      let total = 0,
        minimum = Infinity,
        maximum = -Infinity;
      let bestSkillOrder: string[] = [];
      const assumptions = new Set([
        ...input.evaluation.assumptions,
        "native-normal-nominal-uniform-member-shuffle",
        "100-percent-perfect",
      ]);
      for (const [orderIndex, order] of orders.entries()) {
        if (interrupted(controls))
          return unavailableMetric("native-normal-shuffle-interrupted", "search cancellation/budget");
        if (orderIndex && orderIndex % 8 === 0) {
          controls.progress();
          await controls.yield();
        }
        // Every positive Live effect is known to finish before this horizon;
        // actual audio duration >= the last valid judged node gives the same commands.
        const skills = buildNormalSkillWindows({ formation, order, skillTimesMs: times!, musicLengthMs: lastNoteMs });
        if (skills.gaps.length) return { value: null, status: "unavailable", assumptions: [], gaps: [...skills.gaps] };
        skills.assumptions.forEach((assumption) => assumptions.add(assumption));
        const commands = [...skills.factorCommands];
        // The native comparator uses owner ID before insertion order at equal time.
        for (let index = 1; index < commands.length; index++) {
          const left = commands[index - 1]!,
            right = commands[index]!;
          if (
            left.timeMs === right.timeMs &&
            (left.factorOwnerId === undefined || right.factorOwnerId === undefined) &&
            left.handleId !== right.handleId
          )
            return unavailableMetric("native-normal-factor-owner-order-unresolved", song.song.key);
        }
        commands.sort(
          (a, b) => a.timeMs - b.timeMs || (a.factorOwnerId ?? 0) - (b.factorOwnerId ?? 0) || a.sequence - b.sequence,
        );
        let score = input.evaluation.songContexts[song.song.key]!.fixedScore;
        let index = 0,
          factor = f(1);
        for (const command of commands) {
          const end = lowerBound(song, command.timeMs);
          if (end > index) {
            const sums = await prefix(song, power, factor, controls);
            if (!sums) return unavailableMetric("native-normal-shuffle-interrupted", "search cancellation/budget");
            score += sums[end]! - sums[index]!;
          }
          factor = f(factor + f(f(command.diffMillPercent) / f(100000)));
          index = end;
        }
        if (index < song.nodes.length) {
          const sums = await prefix(song, power, factor, controls);
          if (!sums) return unavailableMetric("native-normal-shuffle-interrupted", "search cancellation/budget");
          score += sums[song.nodes.length]! - sums[index]!;
        }
        if (!int(score))
          return unavailableMetric("native-normal-score-domain-unresolved", "native signed score accumulation");
        total += score;
        minimum = Math.min(minimum, score);
        if (score > maximum) {
          maximum = score;
          bestSkillOrder = order.map((slot) => nativeMembers[slot]!);
        }
      }
      return {
        value: total / orders.length,
        status: "conditional",
        range: { minimum, maximum },
        bestSkillOrder,
        assumptions: [...assumptions],
        gaps: [],
        breakdown: [
          { key: "resolved-team-power", value: power, unit: "power", source: "native normal slot factory" },
          {
            key: "normal-shuffle-orders",
            value: orders.length,
            unit: "count",
            source: "native Fisher–Yates bounded-draw domain",
          },
          { key: "normal-score-minimum", value: minimum, unit: "score", source: "complete play per native order" },
          { key: "normal-score-maximum", value: maximum, unit: "score", source: "complete play per native order" },
          {
            key: "normal-score-mean",
            value: total / orders.length,
            unit: "score",
            source: "uniform nominal order expectation",
          },
        ],
      };
    },
  };
}
