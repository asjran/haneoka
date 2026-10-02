import type {
  EvidenceGap,
  EvaluationBasisRequest,
  Objective,
  OptimizationInput,
  PlayMode,
  PowerStats,
  SearchBudget,
  SearchConstraints,
  ScoreEvaluationModel,
  SongOption,
  TeamAssignment,
} from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import { inventoryOptions, type PowerResolver } from "../data/solver-input.ts";
import type { InventoryV1 } from "../inventory.ts";
import { addPower, calcMemberLevelOrRankPower, calcMemberTrainingPower, calcSnapshotBonusBP } from "./power.ts";
import { createAssignmentEvaluator } from "./evaluate.ts";
import { createNativeNormalSlotResolver } from "./native-normal.ts";
import { createNativeNormalScoreResolver } from "./native-normal-score.ts";
import type { PreparedSong } from "../song-metrics.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
const zero = (): PowerStats => ({ performance: 0, technique: 0, visual: 0 });
const rates = (row: Record<string, unknown>): PowerStats => ({
  performance: Number(row.performanceRate),
  technique: Number(row.technicRate),
  visual: Number(row.visualRate),
});
const find = (data: TeamBuilderData, table: string, group: number, field: string, value: number | null) =>
  value === null
    ? undefined
    : data.progression[table]?.find((row) => Number(row.group) === group && Number(row[field]) === value);
const gap = (code: string, source: string): EvidenceGap => ({ code, source });

/** Known card-growth components. The returned stats are the actual supplied
 * levels' growth, not final live power; prepareEvaluation gives them their own
 * base-score objective and carries full-score gaps separately.
 */
export const nativeGrowthPowerResolver: PowerResolver = {
  member(card, state, data) {
    const level = find(data, "memberCardLevels", card.levelGroup, "level", state.level);
    const training = find(data, "memberCardAwake", card.trainingGroup, "awakeCount", state.training);
    const rank = find(data, "memberCardRanks", card.awakeningGroup, "rank", state.awakening);
    if (!level || !training || !rank)
      return { stats: null, gaps: [gap("member-growth-row-missing", state.instanceId)] };
    const stats = addPower(
      calcMemberLevelOrRankPower(card.statMax, rates(level)),
      calcMemberTrainingPower(card.statMax, rates(training)),
      calcMemberLevelOrRankPower(card.statMax, rates(rank)),
    );
    return {
      stats,
      bpPower: {
        performance: stats.performance * 10000,
        technique: stats.technique * 10000,
        visual: stats.visual * 10000,
      },
      gaps: [],
    };
  },
  snapshot(card, state, data) {
    const level = find(data, "supportCardLevels", card.levelGroup, "level", state.level);
    if (!level) return { stats: null, gaps: [gap("snapshot-growth-row-missing", state.instanceId)] };
    const bonusBP = calcSnapshotBonusBP(card.statMax, rates(level));
    return { stats: zero(), bonusBP, gaps: [] };
  },
};

export interface EvaluationRequest {
  data: TeamBuilderData;
  inventory: InventoryV1;
  songs: SongOption[];
  mode: PlayMode;
  objectives: Objective[];
  constraints: SearchConstraints;
  budget: SearchBudget;
  /** Native runtime plans are passed only after the full power/skill path is resolved. */
  nativeRuntime?: ScoreEvaluationModel;
  basis?: EvaluationBasisRequest;
}
/** Real inventory → actual growth rows → canonical chart → native note core.
 * base-score is a named component; full-score/rewards remain unavailable until
 * their runtime context is supplied. No unknown bonus is silently filled in.
 */
export function prepareEvaluation(request: EvaluationRequest): OptimizationInput {
  const { data, inventory, songs } = request;
  if (inventory.server !== data.identity.server || inventory.releaseId !== data.identity.releaseId)
    throw new RangeError("different-inventory-release");
  const options = inventoryOptions(inventory, data, nativeGrowthPowerResolver);
  if (request.nativeRuntime) {
    if (
      request.nativeRuntime.server !== data.identity.server ||
      request.nativeRuntime.releaseId !== data.identity.releaseId ||
      request.nativeRuntime.mode !== request.mode
    )
      throw new RangeError("different-runtime-context");
    return {
      ...data.identity,
      ...options,
      songs,
      objectives: request.objectives,
      constraints: request.constraints,
      budget: request.budget,
      basis: request.basis,
      evaluation: request.nativeRuntime,
    };
  }
  const tools = data.liveTools;
  const settingRows = dataRows(tools.liveSettings).map(nativeRow);
  const settings = Object.fromEntries(settingRows.map((row) => [String(row.key), Number(row.value)]));
  const noteRows = dataRows(tools.noteParameters).map(nativeRow);
  const judgementRows = dataRows(tools.judgementParameters).map(nativeRow);
  const timingRows = dataRows(tools.judgementTiming).map(nativeRow);
  const comboRows = dataRows(tools.comboScoreBonuses).map(nativeRow);
  const evaluation: ScoreEvaluationModel = {
    ...data.identity,
    mode: request.mode,
    scope: "growth-only",
    noteScorePercents: Object.fromEntries(
      noteRows.map((row) => [Number(row.noteOperateType), Number(row.scorePercent)]),
    ),
    justJudgementTypes: [
      ...new Set(
        timingRows.filter((row) => Number(row.noteSimulateJudgement) === 6).map((row) => Number(row.noteJudgementType)),
      ),
    ],
    comboBonuses: comboRows
      .filter((row) => Number(row.comboBonusType) === 0)
      .map((row) => ({ requiredCombo: Number(row.requiredComboCount), bonus: Number(row.bonusFactor) })),
    adjustmentFactor: settings.note_score_adjustment_factor!,
    lifeOnusFactor: settings.note_score_life_onus_factor!,
    perfectPercent: Number(judgementRows.find((row) => Number(row.noteSimulateJudgement) === 5)?.scorePercent),
    justPercent: Number(judgementRows.find((row) => Number(row.noteSimulateJudgement) === 6)?.scorePercent),
    slots: {},
    defaultSlots: {},
    songContexts: {},
    assumptions: ["growth-only-unboosted-component"],
    gaps: [],
  };
  if (
    ![evaluation.adjustmentFactor, evaluation.lifeOnusFactor, evaluation.perfectPercent, evaluation.justPercent].every(
      Number.isFinite,
    ) ||
    !noteRows.length ||
    !comboRows.length
  )
    evaluation.gaps.push(gap("native-score-master-inputs-incomplete", "same-release live-tools"));
  if (data.identity.server !== "intl")
    evaluation.gaps.push(gap("native-server-rules-unverified", data.identity.server));
  if (request.mode !== "normal")
    evaluation.gaps.push(gap("growth-only-component-requires-normal-mode", "native Gekiso/multi/battle runtime path"));
  if (request.objectives.some((objective) => objective !== "base-score"))
    evaluation.gaps.push(gap("full-runtime-context-required", "power/skill/SS/event native runtime path"));
  if (request.constraints.lockedSnapshotIds.length)
    evaluation.gaps.push(gap("snapshot-full-slot-path-unresolved", "native snapshot equip/power/skill runtime"));
  const growthSlots: NonNullable<ScoreEvaluationModel["defaultSlots"]>[string] = Object.fromEntries(
    options.members.map((member) => [
      member.instanceId,
      {
        "": {
          power: member.stats.performance + member.stats.technique + member.stats.visual,
          windows: [],
          gaps: [...member.gaps],
        },
      },
    ]),
  );
  for (const song of songs) {
    evaluation.defaultSlots![song.key] = growthSlots;
    evaluation.songContexts[song.key] = {
      eventBonusFactor: 1,
      life: 1000,
      assistModeFactor: 1,
      fixedScore: 0,
      personalSS: null,
      gaps: [],
    };
    // Named unboosted component uses positive LIFE and no assist; it does not
    // estimate the omitted player bonuses or skill activations.
  }
  return {
    ...data.identity,
    members: options.members,
    snapshots: options.snapshots,
    inputGaps: options.gaps,
    songs,
    objectives: request.objectives,
    constraints: request.constraints,
    budget: request.budget,
    basis: request.basis,
    evaluation,
  };
}

/** Worker-local formation evaluator. Its closures stay in the worker, so the
 * main thread does not construct a song × leader × member × snapshot matrix.
 */
export function prepareEvaluationForSearch(request: EvaluationRequest) {
  if (
    request.nativeRuntime ||
    request.mode !== "normal" ||
    request.objectives.every((objective) => objective === "base-score")
  ) {
    const input = prepareEvaluation(request);
    const evaluate = createAssignmentEvaluator(input);
    return { input, evaluate: (assignment: TeamAssignment, song: PreparedSong) => evaluate(assignment, song) };
  }
  const input = prepareEvaluation({ ...request, objectives: ["base-score"] });
  input.objectives = [...request.objectives];
  input.evaluation.scope = "native-runtime";
  input.evaluation.assumptions = ["normal-live-event-power-disabled"];
  input.evaluation.gaps = input.evaluation.gaps.filter((gap) => gap.code !== "snapshot-full-slot-path-unresolved");
  const native = createNativeNormalSlotResolver(request.data, request.inventory, input);
  const score = createNativeNormalScoreResolver(request.data, input);
  input.evaluation.gaps.push(...native.gaps, ...score.gaps);
  const lifeRow = dataRows(request.data.liveTools.liveSettings)
    .map(nativeRow)
    .find((row) => row.key === "life_base");
  const initialLife = Number(lifeRow?.value);
  if (!Number.isSafeInteger(initialLife) || initialLife < 1 || initialLife > 0x7fffffff)
    input.evaluation.gaps.push(gap("native-normal-life-base-unresolved", "MasterLiveSettings/life_base"));
  const usable = new Set(input.members.map((member) => member.instanceId));
  for (const state of request.inventory.members)
    if (
      !state.excluded &&
      !request.constraints.excludedMemberIds.includes(state.instanceId) &&
      !usable.has(state.instanceId)
    )
      input.evaluation.gaps.push(gap("native-normal-incomplete-member-search", state.instanceId));
  if (
    request.inventory.snapshots.some(
      (state) => !state.excluded && !request.constraints.excludedSnapshotIds.includes(state.instanceId),
    )
  )
    input.evaluation.gaps.push(
      gap("native-normal-snapshot-search-unresolved", "exclude snapshots for this normal scope"),
    );
  const rankRows = dataRows(request.data.liveTools.scoreRanks).map(nativeRow);
  const ssByGroup = new Map(
    rankRows.filter((row) => row.liveScoreRank === 7).map((row) => [Number(row.group), Number(row.requiredScore)]),
  );
  for (const song of request.songs) {
    const threshold = ssByGroup.get(Number(request.data.songs[String(song.songId)]?.liveScoreRankGroup));
    input.evaluation.songContexts[song.key]!.personalSS =
      threshold !== undefined && threshold > 0 && Number.isSafeInteger(threshold) ? threshold : null;
    if (Number.isSafeInteger(initialLife) && initialLife > 0)
      input.evaluation.songContexts[song.key]!.life = initialLife;
  }
  const evaluate = createAssignmentEvaluator(input, native.resolveSlots);
  return {
    input,
    evaluate: async (assignment: TeamAssignment, song: PreparedSong, controls: SearchEvaluationControls) => {
      const profiles = native.resolveSlots(assignment, song);
      const metric = await score.score(assignment, song, profiles, controls);
      return evaluate(assignment, song, metric);
    },
  };
}
