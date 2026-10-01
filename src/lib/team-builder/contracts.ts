import type { TeamBuilderData } from "./data.ts";
import type { InventoryV1 } from "./inventory.ts";
/** Serializable inputs shared by the inventory adapter, solver worker and UI. */
export interface ReleaseIdentity {
  server: string;
  releaseId: string;
}
export type Objective = "score" | "ss-surplus" | "event-points" | "event-items" | "base-score";
export type PlayMode = "normal" | "gekiso" | "multi" | "battle";
export interface EvidenceGap {
  code: string;
  source: string;
}
export interface MetricValue {
  value: number | null;
  status: "verified" | "conditional" | "unavailable";
  assumptions: string[];
  gaps: EvidenceGap[];
}
export interface PowerStats {
  performance: number;
  technique: number;
  visual: number;
}
/** Adapter resolves the player's actual levels; no implicit maximum training. */
export interface MemberOption {
  instanceId: string;
  cardId: number;
  characterId: number;
  bandId: number;
  attribute: number;
  stats: PowerStats;
  leaderSkillId?: number;
  leaderSkillLevel?: number;
  /** CardPower stores 1 point as 10,000 integer BP units. */
  bpPower?: PowerStats;
  liveSkillId: number;
  liveSkillLevel: number;
  gekisoSkillId: number;
  gekisoSkillLevel: number;
  gaps: EvidenceGap[];
}
export interface SnapshotOption {
  instanceId: string;
  cardId: number;
  stats: PowerStats;
  /** PowerBonusPercent uses BP percentages, not additive member power. */
  bonusBP?: PowerStats;
  supportSkills?: { id: number; level: number }[];
  gekisoSupportSkills?: { id: number; level: number }[];
  supportSkillId: number;
  supportSkillLevel: number;
  gekisoSupportSkillId: number;
  gekisoSupportSkillLevel: number;
  /** undefined means the adapter has not established equip restrictions. */
  allowedCharacterIds?: number[];
  gaps: EvidenceGap[];
}
export interface ChartEvent {
  tick: number;
  timeMs: number;
  operateType: number;
  judgementType: number;
}
export interface SongOption {
  key: string;
  songId: number;
  scoreId: number;
  difficulty: number;
  playLevel: number;
  durationMs: number;
  events: ChartEvent[];
  skillTimesMs: number[];
  segments: { startTick: number; endTick: number; mission: number }[];
  gaps: EvidenceGap[];
}
export interface TeamAssignment {
  memberInstanceIds: string[];
  /** Each index equips the corresponding member; null is an empty slot. */
  snapshotInstanceIds: (string | null)[];
  leaderInstanceId: string;
}
export interface Candidate {
  assignment: TeamAssignment;
  songKey: string;
  metrics: Record<Objective, MetricValue>;
  /** The objective values used by Pareto comparison, in requested order. */
  vector: number[];
}
export interface SearchConstraints {
  lockedMemberIds: string[];
  excludedMemberIds: string[];
  lockedSnapshotIds: string[];
  excludedSnapshotIds: string[];
  excludedSongKeys: string[];
  excludeJustMissions: boolean;
  /** Fraction of eligible nodes receiving JUST, default 0; other nodes PERFECT. */
  justRate: number;
  teamSize: number;
}
export interface SearchBudget {
  maxEvaluations: number;
  maxMilliseconds: number;
  maxCandidates: number;
}
export interface SearchProgress {
  evaluated: number;
  elapsedMs: number;
  phase: "loading" | "search" | "complete";
}
export interface SearchResult {
  candidates: Candidate[];
  completeness: "exhaustive" | "budget-limited" | "cancelled" | "unavailable";
  evaluated: number;
  elapsedMs: number;
  gaps: EvidenceGap[];
}

/** Fully resolved native slot state. The adapter preserves gaps until the full
 * power/skill/condition path is established for this player and selected mode. */
export interface ResolvedSlotProfile {
  power: number;
  windows: SkillWindow[];
  gaps: EvidenceGap[];
}
export interface SkillWindow {
  startMs: number;
  endMs: number;
  scoreBonus: number;
  perfectBonus: number;
  justBonus: number;
  comboBonus: number;
  gekisoComboBonus: number;
  luckBonusPercent: number;
  powerDelta: number;
}
export interface SongScoreContext {
  eventBonusFactor: number;
  life: number;
  assistModeFactor: number;
  /** Extra native fixed scores (for example resolved mission-rank rewards). */
  fixedScore: number;
  /** Personal threshold only; a room-total threshold must stay separate. */
  personalSS: number | null;
  gaps: EvidenceGap[];
}
export interface ScoreEvaluationModel extends ReleaseIdentity {
  mode: PlayMode;
  /** A growth-only result belongs to base-score, never the full score objective. */
  scope?: "native-runtime" | "growth-only";
  noteScorePercents: Record<number, number>;
  justJudgementTypes: number[];
  comboBonuses: { requiredCombo: number; bonus: number }[];
  adjustmentFactor: number;
  lifeOnusFactor: number;
  perfectPercent: number;
  justPercent: number;
  /** Leader-independent profiles, shared across songs when the scenario allows it. */
  defaultSlots?: Record<string, Record<string, Record<string, ResolvedSlotProfile>>>;
  /** songKey → leader → member → snapshot instance ("" = none). */
  slots: Record<string, Record<string, Record<string, Record<string, ResolvedSlotProfile>>>>;
  songContexts: Record<string, SongScoreContext>;
  assumptions: string[];
  gaps: EvidenceGap[];
}
export interface OptimizationInput extends ReleaseIdentity {
  members: MemberOption[];
  snapshots: SnapshotOption[];
  songs: SongOption[];
  objectives: Objective[];
  constraints: SearchConstraints;
  budget: SearchBudget;
  evaluation: ScoreEvaluationModel;
  inputGaps?: EvidenceGap[];
}
export interface WorkerPreparationInput {
  data: TeamBuilderData;
  inventory: InventoryV1;
  selections: { songId: number; difficulty: number }[];
  mode: PlayMode;
  objectives: Objective[];
  constraints: SearchConstraints;
  budget: SearchBudget;
}
export type SolverRequest =
  | { type: "prepare"; runId: string; request: WorkerPreparationInput }
  | { type: "start"; runId: string; input: OptimizationInput }
  | { type: "cancel"; runId: string };
export type SolverResponse =
  | { type: "progress"; runId: string; progress: SearchProgress }
  | { type: "result"; runId: string; result: SearchResult }
  | { type: "error"; runId: string; code: string };
