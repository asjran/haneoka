import { OurNotesGekisouPlan, OUR_NOTES_GEKISOU_LANE_LIFETIME } from "../presentation/Gekisou.js";
import { OurNotesGekisouPresentation } from "../presentation/GekisouPresentation.js";
import type {
  OurNotesGekisouPresentationProjector,
  OurNotesGekisouPresentationTiming,
  OurNotesGekisouProjectionContext,
} from "../presentation/GekisouPresentation.js";
import { FeverState, isPairNoteOperateType, NoteDirection, NoteOperateType, NoteSimulateJudgement } from "@haneoka/cassiopeia";
import { applyLineEase, interpolateNoteLine, LANE_COUNT, mirrorLane } from "@haneoka/cassiopeia";
import { VisualTimeMap } from "@haneoka/cassiopeia";
import type {
  ChartDocument,
  ChartNote,
  JudgementEvent,
  LaneInputEffectEvent,
  SessionSnapshot,
  WatchVisualReplayContract,
} from "@haneoka/cassiopeia";
import { isRenderLaneEffectKind, NativeChartVisualProfilesError } from "../render/types.js";
import type { OurNotesNoteEffectSkin } from "../assets/manifest.js";
import type {
  RenderDirection,
  RenderFrame,
  RenderHold,
  RenderJudgement,
  RenderJudgementInstance,
  RenderLaneEffectKind,
  RenderNote,
  RenderNoteKind,
  RenderParticleEffect,
  RenderPathPoint,
  RenderSimultaneousLine,
  NativeChartVisualProfiles,
  NativeChartVisualProfileDiagnostic,
} from "../render/types.js";

export interface RenderSettings {
  noteSpeed: number;
  /** Float32 constant C in GetNoteDisplayOffsetTimeMs. */
  noteSpeedCurve: number;
  mirror: boolean;
  effects: boolean;
  noteSize: number;
  /** Native SlideOpacity option (OptionItemType 106). */
  longAlpha: number;
  /** Native GuideOpacity option (OptionItemType 107). */
  guideAlpha: number;
  graphicsQuality: number;
  guidelineCount: number;
  guidelineOpacity: number;
  laneOpacity: number;
  /** Native DetailSettings.JudgePositionDisplay (OptionItemType 105). */
  showJudgementLine: boolean;
  /** Native SimultaneousLineDisplay (OptionItemType 108). */
  showSimultaneousLine: boolean;
  /** Emphasize critical/ease-note marks; the original option defaults off. */
  showEaseNote: boolean;
  /** Native ContinuationEffectDisplay (OptionItemType 208). */
  continuationEffectDisplay?: boolean;
  backgroundBrightness: number;
  judgeResultPosition: "center" | "lane" | "none";
  noteOverlapLaneBuffer: number;
  showFastSlow: boolean;
  showPerfectFastSlow: boolean;
  showJudgeOffsetMs: boolean;
  alwaysShowFastSlow: boolean;
  /** MasterLiveScoreRank required scores for C/B/A/S/SS. */
  scoreRankScores?: ReadonlyArray<number>;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  // MasterOptionDefault optionItemType=1 preset=1 stores "5.00". The
  // separate MasterLiveSettings note_speed_default=6 is a runtime fallback,
  // not the fresh-user option value shown by the original settings UI.
  noteSpeed: 5,
  noteSpeedCurve: 1.30999994,
  mirror: false,
  effects: true,
  continuationEffectDisplay: true,
  noteSize: 1,
  longAlpha: 0.6,
  guideAlpha: 0.6,
  // MasterOptionDefault: LiveQuality=1.
  graphicsQuality: 1,
  // MasterOptionDefault: GuidelineCount=2 means LiveLaneSplitCountType.Lane6,
  // not a literal line count. LaneOpacity=80, GuidelineOpacity=25.
  guidelineCount: 6,
  guidelineOpacity: 0.25,
  laneOpacity: 0.8,
  // MasterOptionDefault stores FALSE for option 105 in every preset.
  showJudgementLine: false,
  // MasterOptionDefault stores TRUE for option 108 in every preset.
  showSimultaneousLine: true,
  showEaseNote: false,
  backgroundBrightness: 0.7,
  judgeResultPosition: "center",
  noteOverlapLaneBuffer: 0,
  showFastSlow: true,
  showPerfectFastSlow: true,
  showJudgeOffsetMs: false,
  alwaysShowFastSlow: false,
};

export interface RenderFrameBuilderOptions {
  /** Stable seed for replay capture; live sessions use platform entropy. */
  particleSeed?: number;
  noteEffectSkin?: OurNotesNoteEffectSkin;
  visualProfiles?: NativeChartVisualProfiles;
  gekisou?: OurNotesGekisouPlan;
  gekisouPresentation?: OurNotesGekisouPresentationConfiguration;
}

export interface OurNotesGekisouPresentationConfiguration {
  readonly projector: OurNotesGekisouPresentationProjector;
  readonly context: OurNotesGekisouProjectionContext;
  readonly timing?: OurNotesGekisouPresentationTiming;
}

interface ResolvedVisualProfiles {
  notes: ReadonlyMap<number, number>;
  lines: ReadonlyMap<number, number>;
}

/** Resolve once; aliases are already compiled by the authoring host, never read from private extensions. */
function resolveVisualProfiles(
  chart: ChartDocument,
  profiles: NativeChartVisualProfiles | undefined,
): ResolvedVisualProfiles | undefined {
  if (profiles === undefined) return;
  const diagnostics: NativeChartVisualProfileDiagnostic[] = [];
  if (!profiles || !Array.isArray(profiles.notes) || !Array.isArray(profiles.lines)) {
    throw new NativeChartVisualProfilesError([
      { code: "invalid-profiles", target: "notes", message: "notes and lines must be arrays" },
    ]);
  }
  const noteById = new Map(chart.notes.map((note) => [note.id, note]));
  const lineById = new Map(chart.lines.map((line) => [line.id, line]));
  const notes = new Map<number, number>();
  const lines = new Map<number, number>();
  const generated = (note: ChartNote) =>
    note.indexInLine === null &&
    (note.operateType === NoteOperateType.Combo || note.operateType === NoteOperateType.ComboSkip);
  for (const target of ["notes", "lines"] as const) {
    const seen = new Set<number>();
    for (const entry of profiles[target]) {
      const id =
        target === "notes"
          ? (entry as NativeChartVisualProfiles["notes"][number])?.nativeNoteId
          : (entry as NativeChartVisualProfiles["lines"][number])?.nativeLineId;
      if (!Number.isSafeInteger(id) || id < 0 || !(target === "notes" ? noteById : lineById).has(id)) {
        diagnostics.push({
          code: "unknown-id",
          target,
          nativeId: id,
          message: "ID does not belong to this compiled chart",
        });
        continue;
      }
      if (seen.has(id))
        diagnostics.push({ code: "duplicate-id", target, nativeId: id, message: "Each native ID must occur once" });
      seen.add(id);
      if (!Number.isFinite(entry.noteSpeed) || entry.noteSpeed < 1 || entry.noteSpeed > 14) {
        diagnostics.push({
          code: "invalid-speed",
          target,
          nativeId: id,
          message: "noteSpeed must be finite native option units in 1..14",
        });
        continue;
      }
      if (target === "notes" && generated(noteById.get(id)!)) {
        diagnostics.push({
          code: "generated-note",
          target,
          nativeId: id,
          message: "Generated Combo inherits its native line profile",
        });
        continue;
      }
      (target === "notes" ? notes : lines).set(id, entry.noteSpeed);
    }
  }
  if (diagnostics.length) throw new NativeChartVisualProfilesError(diagnostics);
  if (notes.size === 0 && lines.size === 0) return;
  const explicitNotes = new Map(notes);
  const memberships = new Map<number, Set<number>>();
  for (const line of chart.lines)
    for (const id of line.noteIds) {
      let set = memberships.get(id);
      if (!set) memberships.set(id, (set = new Set()));
      set.add(line.id);
    }
  for (const note of chart.notes)
    for (const id of note.lineIds) {
      if (!lineById.has(id)) continue;
      let set = memberships.get(note.id);
      if (!set) memberships.set(note.id, (set = new Set()));
      set.add(id);
    }
  const participantsByLine = new Map<number, ChartNote[]>();
  for (const note of chart.notes) {
    if (generated(note)) continue;
    for (const id of memberships.get(note.id) ?? []) {
      let participants = participantsByLine.get(id);
      if (!participants) participantsByLine.set(id, (participants = []));
      participants.push(note);
    }
  }
  // A line header supplies all unspecified nodes. Without a header every
  // participating node must explicitly agree, since the global speed can change.
  for (const line of chart.lines) {
    const participants = participantsByLine.get(line.id) ?? [];
    const header = lines.get(line.id);
    const speeds = new Set(participants.map((note) => explicitNotes.get(note.id) ?? header));
    if (speeds.size > 1 || (header !== undefined && [...speeds].some((speed) => speed !== header))) {
      diagnostics.push({
        code: "line-speed-conflict",
        target: "lines",
        nativeId: line.id,
        message: "Line header and all participating nodes must have one effective speed",
      });
    } else {
      const speed = header ?? speeds.values().next().value;
      if (speed !== undefined) lines.set(line.id, speed);
    }
  }
  for (const note of chart.notes) {
    const owners = memberships.get(note.id) ?? new Set<number>();
    if (owners.size === 0) continue;
    const speeds = new Set([...owners].map((id) => lines.get(id)));
    if (speeds.size > 1) {
      diagnostics.push({
        code: "shared-note-speed-conflict",
        target: "notes",
        nativeId: note.id,
        message: "Shared native note belongs to lines with different effective speeds",
      });
      continue;
    }
    const speed = speeds.values().next().value;
    if (speed !== undefined) notes.set(note.id, speed);
  }
  if (diagnostics.length) throw new NativeChartVisualProfilesError(diagnostics);
  return { notes, lines };
}

interface ProfileNotePartition {
  speed: number | undefined;
  items: { timeMs: number; index: number }[];
  first: number;
  last: number;
  windowStart?: number;
}

interface ProfilePairPartition {
  leftSpeed: number | undefined;
  rightSpeed: number | undefined;
  items: { timeMs: number; index: number }[];
  first: number;
  last: number;
  windowStart?: number;
}

interface ProfilePairEndpoints {
  leftTimeMs: number;
  rightTimeMs: number;
  leftSpeed: number | undefined;
  rightSpeed: number | undefined;
}

/**
 * effect001 ParticleSystems use `autoRandomSeed=true`. Unity gives a newly
 * played prefab a fresh seed, but that seed must then remain stable while we
 * redraw the same effect across animation frames.
 */
function automaticParticleSeedEntropy(): number {
  const entropy = new Uint32Array(1);
  try {
    globalThis.crypto.getRandomValues(entropy);
    return entropy[0]!;
  } catch {
    const clock = Date.now() ^ Math.trunc((globalThis.performance?.now?.() ?? 0) * 1_000);
    return mixParticleSeed(clock);
  }
}

function mixParticleSeed(value: number): number {
  let state = value >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x21f0aaad);
  state = Math.imul(state ^ (state >>> 15), 0x735a2d97);
  return (state ^ (state >>> 15)) >>> 0;
}

interface PreparedHoldPoint {
  timeMs: number;
  pos: number;
  size: number;
}

interface PreparedLine {
  id: number;
  kind: ChartDocument["lines"][number]["kind"];
  authored: ReadonlyArray<ChartNote>;
  points: ReadonlyArray<PreparedHoldPoint>;
  realStartTimeMs: number;
  realEndTimeMs: number;
  inverseDuration: number;
  minimumWidth: number;
  critical: boolean;
  /** Monotonic playback cursors; adjusted backwards safely after option changes. */
  pointStartCursor: number;
  pointEndCursor: number;
  /** Persistent SlideLoop activation state; a new activation needs a new auto seed. */
  particleEffectActive: boolean;
  particleEffectSeed: number | undefined;
  particleEffectStartedAtMs: number | undefined;
}

interface PreparedSimultaneousLine {
  id: string;
  timeMs: number;
  leftCenter: number;
  rightCenter: number;
  firstNoteId: number;
  secondNoteId: number;
}

function samplePreparedLine(line: PreparedLine, timeMs: number, target: PreparedHoldPoint): PreparedHoldPoint {
  const authored = line.authored;
  const nextIndex = lowerBoundTime(authored, timeMs);
  if (nextIndex <= 0) {
    const first = authored[0]!;
    target.timeMs = timeMs;
    target.pos = first.pos;
    target.size = first.size;
    return target;
  }
  if (nextIndex >= authored.length) {
    const last = authored[authored.length - 1]!;
    target.timeMs = timeMs;
    target.pos = last.pos;
    target.size = last.size;
    return target;
  }
  const next = authored[nextIndex]!;
  if (next.timeMs === timeMs) {
    target.timeMs = timeMs;
    target.pos = next.pos;
    target.size = next.size;
    return target;
  }
  const previous = authored[nextIndex - 1]!;
  const duration = next.timeMs - previous.timeMs;
  const progress = duration <= 0 ? 0 : Math.max(0, Math.min(1, (timeMs - previous.timeMs) / duration));
  const leftProgress = applyLineEase(previous.easeL, progress);
  const rightProgress = applyLineEase(previous.easeR, progress);
  target.timeMs = timeMs;
  target.pos = previous.pos + (next.pos - previous.pos) * leftProgress;
  const right = previous.pos + previous.size + (next.pos + next.size - previous.pos - previous.size) * rightProgress;
  target.size = right - target.pos;
  return target;
}

interface MutableRenderHold extends Omit<RenderHold, "points"> {
  points: RenderPathPoint[];
}

interface PooledRenderHold extends MutableRenderHold {
  readonly pointPool: RenderPathPoint[];
}

interface MutableRankResult {
  rank: (typeof SCORE_RANK_LABELS)[number];
  progress: number;
}

interface ReusableFrameBuffers {
  readonly frame: RenderFrame;
  readonly notes: RenderNote[];
  readonly notePool: RenderNote[];
  readonly simultaneousLines: RenderSimultaneousLine[];
  readonly simultaneousLinePool: RenderSimultaneousLine[];
  readonly holds: MutableRenderHold[];
  readonly holdPool: PooledRenderHold[];
  readonly particles: RenderParticleEffect[];
  readonly particlePool: RenderParticleEffect[];
  readonly hudJudgements: RenderJudgementInstance[];
  readonly hudJudgementPool: RenderJudgementInstance[];
  readonly rank: MutableRankResult;
}

// MasterLiveMusic 100001 -> group 1100001. Fallback for callers which do
// not supply their song's rank group.
const FALLBACK_SCORE_RANK_SCORES = [553_524, 2_136_175, 4_548_528, 9_150_398, 12_945_117] as const;
const SCORE_RANK_LABELS = ["D", "C", "B", "A", "S", "SS"] as const;
const HUD_RANK_LABELS = ["C", "B", "A", "S", "SS"] as const;
// These serialized anchored positions are read by UIFreeLiveHeaderView.Awake;
// the final field is the right edge of the 502px gauge.
const SCORE_RANK_POSITIONS = [88, 177, 264, 352, 439] as const;
const SCORE_GAUGE_MAX_POSITION = 502;

function lowerBoundTime<T extends { timeMs: number }>(items: ReadonlyArray<T>, timeMs: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.timeMs < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function adjustLowerBoundCursor<T extends { timeMs: number }>(
  items: ReadonlyArray<T>,
  timeMs: number,
  cursor: number,
): number {
  let index = Math.max(0, Math.min(items.length, cursor));
  while (index < items.length && items[index]!.timeMs < timeMs) index++;
  while (index > 0 && items[index - 1]!.timeMs >= timeMs) index--;
  return index;
}

function adjustUpperBoundCursor<T extends { timeMs: number }>(
  items: ReadonlyArray<T>,
  timeMs: number,
  cursor: number,
): number {
  let index = Math.max(0, Math.min(items.length, cursor));
  while (index < items.length && items[index]!.timeMs <= timeMs) index++;
  while (index > 0 && items[index - 1]!.timeMs > timeMs) index--;
  return index;
}

const NATIVE_MAX_NOTE_SPEED = 12;
const EXTENDED_MAX_NOTE_SPEED = 14;
const NATIVE_MIN_VIEW_TIME_SECONDS = 0.35;

function nativeNoteViewTimeSeconds(noteSpeed: number, curveExponent: number): number {
  const normalized = (Math.max(1, Math.min(NATIVE_MAX_NOTE_SPEED, noteSpeed)) - 1) / 11;
  if (normalized <= 0) return 4;
  if (normalized >= 1) return NATIVE_MIN_VIEW_TIME_SECONDS;
  const eased = Math.max(0, Math.min(1, 1 - Math.pow(1 - normalized, Math.max(0.01, curveExponent))));
  return Math.ceil(1000 * (4 + (NATIVE_MIN_VIEW_TIME_SECONDS - 4) * eased)) / 1000;
}

/**
 * Note display offset view time: ease the normalized note-speed approach
 * [0,1] across a 4..0.35 s window using exponent C=1.30999994.
 *
 * The native option range ends at 12. The website's requested 12..14 range is
 * deliberately isolated here: 1..12 retains the exact curve, while the
 * extension continues the geometric view-time ratio from native 11→12.
 */
export function noteViewTimeSeconds(noteSpeed: number, curveExponent = 1.30999994): number {
  const speed = Math.max(1, Math.min(EXTENDED_MAX_NOTE_SPEED, Number(noteSpeed) || 1));
  if (speed <= NATIVE_MAX_NOTE_SPEED) return nativeNoteViewTimeSeconds(speed, curveExponent);

  const previousViewTime = nativeNoteViewTimeSeconds(NATIVE_MAX_NOTE_SPEED - 1, curveExponent);
  const continuationRatio = NATIVE_MIN_VIEW_TIME_SECONDS / previousViewTime;
  const extendedViewTime = NATIVE_MIN_VIEW_TIME_SECONDS * Math.pow(continuationRatio, speed - NATIVE_MAX_NOTE_SPEED);
  return Math.ceil(1000 * extendedViewTime) / 1000;
}

function renderKind(note: ChartNote): RenderNoteKind {
  switch (note.operateType) {
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      return note.direction === NoteDirection.Left
        ? "flick-left"
        : note.direction === NoteDirection.Right
          ? "flick-right"
          : "flick";
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.HiddenSlideBegin:
      return "slide-start";
    case NoteOperateType.SlideEnd:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.HiddenSlideEnd:
      return "slide-end";
    case NoteOperateType.SlideConnection:
    case NoteOperateType.SlideConnectionTrace:
    case NoteOperateType.Combo:
      return "slide-node";
    case NoteOperateType.Trace:
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.GuideEndTrace:
      return "trace";
    case NoteOperateType.GuideBegin:
    case NoteOperateType.GuideEnd:
      return "guide";
    default:
      return "tap";
  }
}

function renderDirection(note: ChartNote, mirror: boolean): RenderDirection {
  if (note.direction === NoteDirection.Left) return mirror ? "right" : "left";
  if (note.direction === NoteDirection.Right) return mirror ? "left" : "right";
  return renderKind(note) === "flick" ? "up" : "none";
}

function isGuideStart(note: ChartNote): boolean {
  return (
    note.operateType === NoteOperateType.GuideBegin ||
    note.operateType === NoteOperateType.GuideBeginNormal ||
    note.operateType === NoteOperateType.GuideBeginFlick ||
    note.operateType === NoteOperateType.GuideBeginTrace
  );
}

function judgementName(value: NoteSimulateJudgement): RenderJudgement | undefined {
  if (value === NoteSimulateJudgement.Just) return "just";
  if (value === NoteSimulateJudgement.Perfect) return "perfect";
  if (value === NoteSimulateJudgement.Great) return "great";
  if (value === NoteSimulateJudgement.Good) return "good";
  if (value === NoteSimulateJudgement.Bad) return "bad";
  if (value === NoteSimulateJudgement.Miss) return "miss";
  return undefined;
}

function normalizedRankScores(
  values: ReadonlyArray<number> | undefined,
): readonly [number, number, number, number, number] {
  const candidate = values?.length === 5 ? values : FALLBACK_SCORE_RANK_SCORES;
  let previous = 0;
  for (let index = 0; index < 5; index++) {
    const value = candidate[index]!;
    if (!Number.isFinite(value) || value <= previous) return FALLBACK_SCORE_RANK_SCORES;
    previous = value;
  }
  return candidate as unknown as readonly [number, number, number, number, number];
}

function writeNativeScoreRank(
  simulatorScore: number,
  values: ReadonlyArray<number> | undefined,
  target: MutableRankResult,
): MutableRankResult {
  const thresholds = normalizedRankScores(values);
  // The constructor sets the SS scaling field to 1.2f; Initialize rounds SS * that value.
  const maximumScore = Math.max(thresholds[4], Math.round(thresholds[4] * 1.2));
  // ChartSession is intentionally deck-independent and emits 0..1,000,000.
  // Project it onto the song's native score domain before running native UI
  // interpolation, preserving all song-specific threshold ratios.
  const score = Math.max(0, Math.min(1_000_000, Number.isFinite(simulatorScore) ? simulatorScore : 0));
  const nativeScore = (score / 1_000_000) * maximumScore;
  let rankIndex = 0;
  while (rankIndex < thresholds.length && nativeScore >= thresholds[rankIndex]!) rankIndex++;

  const segment = Math.min(rankIndex, SCORE_RANK_POSITIONS.length);
  const lowScore = segment === 0 ? 0 : thresholds[segment - 1]!;
  const highScore = segment < thresholds.length ? thresholds[segment]! : maximumScore;
  const lowPosition = segment === 0 ? 0 : SCORE_RANK_POSITIONS[segment - 1]!;
  const highPosition =
    segment < SCORE_RANK_POSITIONS.length ? SCORE_RANK_POSITIONS[segment]! : SCORE_GAUGE_MAX_POSITION;
  const amount =
    highScore <= lowScore ? 1 : Math.max(0, Math.min(1, (nativeScore - lowScore) / (highScore - lowScore)));
  const position = lowPosition + (highPosition - lowPosition) * amount;
  target.rank = SCORE_RANK_LABELS[Math.min(rankIndex, SCORE_RANK_LABELS.length - 1)]!;
  target.progress = Math.max(0, Math.min(1, position / (SCORE_GAUGE_MAX_POSITION + 0.0001)));
  return target;
}

/** UIFreeLiveHeaderView.Initialize/UpdateScore. */
export function nativeScoreRank(
  simulatorScore: number,
  values?: ReadonlyArray<number>,
): { rank: (typeof SCORE_RANK_LABELS)[number]; progress: number } {
  return writeNativeScoreRank(simulatorScore, values, { rank: "D", progress: 0 });
}

/**
 * Guide line MonoBehaviour alpha curve: keys (0,1) and (1,0), unweighted
 * Hermite tangents -0.950166225 and -0.88311684, applied during the final
 * `_fadeStartBeforeEndMs=100` milliseconds.
 */
function nativeGuideEndAlpha(timeMs: number, endTimeMs: number): number {
  if (timeMs <= endTimeMs - 100) return 1;
  if (timeMs >= endTimeMs) return 0;
  const t = Math.max(0, Math.min(1, (timeMs - (endTimeMs - 100)) / 100));
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h11 = t3 - t2;
  return Math.max(0, Math.min(1, h00 + h10 * -0.9501662254333496 + h11 * -0.8831168413162231));
}

/** LiveNoteEffectViewUtility.ConvertToLiveNoteEffectViewType. */
export function nativeParticleEffectKind(note: ChartNote): RenderParticleEffect["kind"] | null {
  switch (note.operateType) {
    case NoteOperateType.Normal:
    case NoteOperateType.GuideBeginNormal:
      return "tap";
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideEnd:
      // The effect mapping for operate types 20..22 is [Slide, Connect, Slide].
      return "slide";
    case NoteOperateType.SlideConnection:
    case NoteOperateType.Trace:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.SlideConnectionTrace:
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.GuideEndTrace:
      return "connect";
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      return "flick";
    default:
      return null;
  }
}

/** LiveLaneEffectViewUtility.ConvertToLiveNoteEffectViewType (non-Gekisou path). */
export function nativeLaneEffectKind(note: ChartNote): RenderLaneEffectKind | null {
  switch (note.operateType) {
    case NoteOperateType.Normal:
    case NoteOperateType.GuideBeginNormal:
      return "lane-effect-normal";
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideEnd:
      return "lane-effect-slide";
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      return "lane-effect-flick";
    default:
      // Slide connections and trace/guide nodes explicitly return None.
      return null;
  }
}

function directedLaneEffectKind(
  kind: RenderParticleEffect["kind"],
  direction: RenderDirection,
): RenderParticleEffect["kind"] {
  if (kind !== "lane-effect-flick") return kind;
  if (direction === "left") return "lane-effect-flick-left";
  if (direction === "right") return "lane-effect-flick-right";
  return kind;
}

/** System.Math.Round(float), whose default midpoint mode is ToEven. */
function nativeRoundToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

// All six selected lane ParticleSystems serialize startLifetime=.45 and
// simulationSpeed=2, so their visible real-time lifetime is .225 seconds.
const NATIVE_LANE_EFFECT_LIFETIME = 0.44999998807907104 / 2;
// LiveGameLaneEffectBase is released by its invisible parent PS callback:
// duration=1, simulationSpeed=1. The visible child ends after .45/2 seconds.
const NATIVE_LANE_EFFECT_OCCUPANCY_MS = 1000;

/**
 * Durations of the tap/slide/flick judgement clips selected by
 * ConvertAnimType. Miss/Wait/Pass map to AnimType.None.
 */
export function nativeParticleEffectLifetime(
  kind: RenderParticleEffect["kind"],
  judgement: NoteSimulateJudgement,
  noteEffectSkin: OurNotesNoteEffectSkin = "effect001",
): number {
  if (
    judgement !== NoteSimulateJudgement.Bad &&
    judgement !== NoteSimulateJudgement.Good &&
    judgement !== NoteSimulateJudgement.Great &&
    judgement !== NoteSimulateJudgement.Perfect &&
    judgement !== NoteSimulateJudgement.Just
  )
    return 0;
  if (kind === "slide-loop") return Number.POSITIVE_INFINITY;
  const perfect = judgement === NoteSimulateJudgement.Perfect || judgement === NoteSimulateJudgement.Just;
  if (kind === "flick") {
    if (perfect) return noteEffectSkin === "effect001Simple" ? 3 / 4 : 5 / 12;
    if (judgement === NoteSimulateJudgement.Bad) return noteEffectSkin === "effect001Simple" ? 5 / 12 : 7 / 12;
    return 1 / 2;
  }
  if (kind === "slide" || kind === "connect" || kind === "trace") {
    return perfect ? 7 / 12 : 5 / 12;
  }
  return 5 / 12;
}

interface QueuedJudgementEffect {
  event: JudgementEvent;
  spawnedAtMs: number;
  id: string;
  kind: RenderParticleEffect["kind"];
  lifetime: number;
  /** Assigned once at native autoRandomSeed activation time. */
  seed?: number;
}

interface QueuedLaneInputEffect {
  event: LaneInputEffectEvent;
  id: string;
  lifetime: number;
}

function laneFeedbackPriority(effect: QueuedJudgementEffect | QueuedLaneInputEffect, empty: boolean): number {
  if (empty) return 2;
  const judgement = effect as QueuedJudgementEffect;
  switch (judgement.kind) {
    case "lane-effect-gekisou": return 50;
    case "lane-effect-normal": return 10;
    case "lane-effect-slide": return 20;
    case "lane-effect-flick":
      return judgement.event.note.direction === NoteDirection.Left ? 31
        : judgement.event.note.direction === NoteDirection.Right ? 32 : 30;
    default: return 1;
  }
}

interface LaneFeedbackOwner {
  effect: QueuedJudgementEffect | QueuedLaneInputEffect;
  empty: boolean;
  timeMs: number;
}

interface QueuedHudJudgement {
  event: JudgementEvent;
  spawnedAtMs: number;
  id: number;
}

const HUD_JUDGEMENT_LIFETIME_SECONDS = 0.3;

export class RenderFrameBuilder {
  private readonly visualTimeMap: VisualTimeMap;
  private readonly renderableNotes: ReadonlyArray<ChartNote>;
  private readonly preparedSimultaneousLines: ReadonlyArray<PreparedSimultaneousLine>;
  private readonly preparedLines: ReadonlyArray<PreparedLine>;
  private readonly effects: QueuedJudgementEffect[] = [];
  private readonly hudJudgements: QueuedHudJudgement[] = [];
  private readonly laneFeedbackOwners = new Map<number, LaneFeedbackOwner>();
  /** Raw input feedback is never inserted into the judgement/score pipeline. */
  private readonly laneInputEffects: QueuedLaneInputEffect[] = [];
  private readonly sampleStart: PreparedHoldPoint = { timeMs: 0, pos: 0, size: 0 };
  private readonly sampleEnd: PreparedHoldPoint = { timeMs: 0, pos: 0, size: 0 };
  private readonly particleSeedEntropy: number;
  private readonly noteEffectSkin: OurNotesNoteEffectSkin;
  private readonly gekisou: OurNotesGekisouPlan | undefined;
  private gekisouPresentation: OurNotesGekisouPresentation | undefined;
  private gekisouPresentationConfiguration: OurNotesGekisouPresentationConfiguration | undefined;
  private visualProfiles: ResolvedVisualProfiles | undefined;
  private readonly notePartitions: ProfileNotePartition[] = [];
  private readonly pairPartitions: ProfilePairPartition[] = [];
  private readonly profileNoteIndices: number[] = [];
  private readonly profilePairIndices: number[] = [];
  private readonly profileViewTimes = new Map<number, number>();
  private profileNoteInverse: Float64Array | undefined;
  private readonly profilePairEndpoints: ProfilePairEndpoints[] = [];
  private effectHead = 0;
  private hudJudgementHead = 0;
  private laneInputEffectHead = 0;
  private nextLaneInputEffectId = 0;
  private nextHudJudgementId = 0;
  /** Deliberately survives a timeline reset: the next Play gets a new seed. */
  private nextParticleEffectActivation = 0;
  private firstVisibleNoteCursor = 0;
  private lastVisibleNoteCursor = 0;
  private firstVisibleSimultaneousLineCursor = 0;
  private lastVisibleSimultaneousLineCursor = 0;
  private reusable?: ReusableFrameBuffers;
  private lastTimeMs = 0;
  private seekTargetTimeMs: number | undefined;

  constructor(
    private readonly chart: ChartDocument,
    options: RenderFrameBuilderOptions = {},
  ) {
    this.visualProfiles = resolveVisualProfiles(chart, options.visualProfiles);
    this.gekisou = options.gekisou;
    this.gekisouPresentation = this.gekisou
      ? new OurNotesGekisouPresentation(this.gekisou.ranges)
      : undefined;
    this.configureGekisouPresentation(options.gekisouPresentation);
    this.noteEffectSkin = options.noteEffectSkin ?? "effect001";
    this.particleSeedEntropy =
      options.particleSeed === undefined ? automaticParticleSeedEntropy() : mixParticleSeed(options.particleSeed);
    this.visualTimeMap = new VisualTimeMap(chart.timeScaleChanges);
    const sourceNoteById = new Map(chart.notes.map((note) => [note.id, note]));
    const visualNoteById = new Map(
      chart.notes.map((note) => [note.id, { ...note, timeMs: this.visualTimeMap.toScaledTimeMs(note.timeMs) }]),
    );
    this.renderableNotes = [...visualNoteById.values()]
      .filter((note) => note.visible && !isGuideStart(note))
      .sort((left, right) => left.timeMs - right.timeMs || left.id - right.id);
    const simultaneousCandidates = this.renderableNotes.filter((note) => isPairNoteOperateType(note.operateType));
    const simultaneousLines: PreparedSimultaneousLine[] = [];
    const pairGroups = new Map<number, ChartNote[]>();
    for (const note of simultaneousCandidates) {
      const group = pairGroups.get(note.tick);
      if (group) group.push(note);
      else pairGroups.set(note.tick, [note]);
    }
    for (const group of pairGroups.values()) {
      group.sort((left, right) => left.id - right.id);
      for (let index = 1; index < group.length; index++) {
        const first = group[index - 1]!;
        const second = group[index]!;
        const firstCenter = first.pos + first.size / 2;
        const secondCenter = second.pos + second.size / 2;
        if (firstCenter === secondCenter) continue;
        simultaneousLines.push({
          id: `${first.id}:${second.id}`,
          timeMs: second.timeMs,
          leftCenter: Math.min(firstCenter, secondCenter),
          rightCenter: Math.max(firstCenter, secondCenter),
          firstNoteId: first.id,
          secondNoteId: second.id,
        });
      }
    }
    simultaneousLines.sort((left, right) => left.timeMs - right.timeMs || left.id.localeCompare(right.id));
    this.preparedSimultaneousLines = simultaneousLines;
    this.preparedLines = chart.lines.map((line) => {
      const authored = line.noteIds
        .map((id) => visualNoteById.get(id))
        .filter((note): note is ChartNote => Boolean(note) && note!.indexInLine !== null)
        .sort((left, right) => left.timeMs - right.timeMs);
      const sourceAuthored = line.noteIds
        .map((id) => sourceNoteById.get(id))
        .filter((note): note is ChartNote => Boolean(note) && note!.indexInLine !== null)
        .sort((left, right) => left.timeMs - right.timeMs);
      const points: PreparedHoldPoint[] = [];
      for (let index = 0; index < authored.length - 1; index++) {
        const head = authored[index]!;
        const tail = authored[index + 1]!;
        const steps = Math.max(1, Math.ceil((tail.timeMs - head.timeMs) / 45));
        for (let step = 0; step <= steps; step++) {
          if (index > 0 && step === 0) continue;
          const timeMs = head.timeMs + ((tail.timeMs - head.timeMs) * step) / steps;
          const shape = interpolateNoteLine(head, tail, timeMs);
          points.push({ timeMs, pos: shape.pos, size: shape.size });
        }
      }
      return {
        id: line.id,
        kind: line.kind,
        authored,
        points,
        realStartTimeMs: sourceAuthored[0]?.timeMs ?? 0,
        realEndTimeMs: sourceAuthored[sourceAuthored.length - 1]?.timeMs ?? 0,
        inverseDuration:
          sourceAuthored.length > 1 && sourceAuthored.at(-1)!.timeMs > sourceAuthored[0]!.timeMs
            ? Math.fround(1 / Math.fround(sourceAuthored.at(-1)!.timeMs - sourceAuthored[0]!.timeMs))
            : 0,
        minimumWidth: sourceAuthored.reduce((width, note) => Math.min(width, note.size), Infinity),
        critical: line.critical,
        pointStartCursor: 0,
        pointEndCursor: 0,
        particleEffectActive: false,
        particleEffectSeed: undefined,
        particleEffectStartedAtMs: undefined,
      };
    });
    this.configureVisualPartitions();
  }

  /** Geometry and viewport changes retain the source result index. */
  configureGekisouPresentation(configuration: OurNotesGekisouPresentationConfiguration | undefined): void {
    this.gekisouPresentationConfiguration = configuration;
    if (this.gekisouPresentation && configuration?.timing)
      this.gekisouPresentation.timing = configuration.timing;
  }

  /** Replace visual profiles on this same compiled chart; keep judgement/HUD/effect timelines intact. */
  setVisualProfiles(profiles: NativeChartVisualProfiles | undefined): void {
    const resolved = resolveVisualProfiles(this.chart, profiles);
    // Validation finishes before any current valid window/state is replaced.
    this.visualProfiles = resolved;
    this.notePartitions.length = 0;
    this.pairPartitions.length = 0;
    this.profilePairEndpoints.length = 0;
    this.profileNoteIndices.length = 0;
    this.profilePairIndices.length = 0;
    this.profileViewTimes.clear();
    this.profileNoteInverse = undefined;
    this.firstVisibleNoteCursor = 0;
    this.lastVisibleNoteCursor = 0;
    this.firstVisibleSimultaneousLineCursor = 0;
    this.lastVisibleSimultaneousLineCursor = 0;
    for (const line of this.reusable?.simultaneousLinePool ?? []) {
      delete line.leftApproach;
      delete line.rightApproach;
    }
    this.configureVisualPartitions();
  }

  private configureVisualPartitions(): void {
    if (this.visualProfiles) {
      const visualNoteById = new Map(this.renderableNotes.map((note) => [note.id, note]));
      this.profileNoteInverse = new Float64Array(this.renderableNotes.length);
      const noteGroups = new Map<number | undefined, ProfileNotePartition>();
      this.renderableNotes.forEach((note, index) => {
        const speed = this.visualProfiles!.notes.get(note.id);
        let group = noteGroups.get(speed);
        if (!group) noteGroups.set(speed, (group = { speed, items: [], first: 0, last: 0 }));
        group.items.push({ index, timeMs: note.timeMs });
      });
      this.notePartitions.push(...noteGroups.values());
      const pairGroups = new Map<string, ProfilePairPartition>();
      this.preparedSimultaneousLines.forEach((line, index) => {
        const first = visualNoteById.get(line.firstNoteId)!;
        const second = visualNoteById.get(line.secondNoteId)!;
        const [left, right] =
          first.pos + first.size / 2 < second.pos + second.size / 2 ? [first, second] : [second, first];
        const leftSpeed = this.visualProfiles!.notes.get(left.id);
        const rightSpeed = this.visualProfiles!.notes.get(right.id);
        this.profilePairEndpoints.push({ leftTimeMs: left.timeMs, rightTimeMs: right.timeMs, leftSpeed, rightSpeed });
        const key = `${leftSpeed ?? "global"}:${rightSpeed ?? "global"}`;
        let group = pairGroups.get(key);
        if (!group) pairGroups.set(key, (group = { leftSpeed, rightSpeed, items: [], first: 0, last: 0 }));
        group.items.push({ index, timeMs: line.timeMs });
      });
      this.pairPartitions.push(...pairGroups.values());
    }
  }

  private profileViewTime(speed: number | undefined, globalViewTimeMs: number, curve: number): number {
    if (speed === undefined) return globalViewTimeMs;
    let time = this.profileViewTimes.get(speed);
    if (time === undefined) {
      time = noteViewTimeSeconds(speed, curve) * 1000;
      this.profileViewTimes.set(speed, time);
    }
    return time;
  }

  private collectProfileNotes(visualTimeMs: number, globalViewTimeMs: number, curve: number): number[] {
    const indices = this.profileNoteIndices;
    indices.length = 0;
    for (const group of this.notePartitions) {
      const viewTimeMs = this.profileViewTime(group.speed, globalViewTimeMs, curve);
      this.profileWindow(group, visualTimeMs - viewTimeMs * 0.16, visualTimeMs + viewTimeMs * 1.1);
      for (let i = group.first; i < group.last; i++) {
        const index = group.items[i]!.index;
        indices.push(index);
        this.profileNoteInverse![index] = 1 / viewTimeMs;
      }
    }
    // Global index is the original time/ID ordering across all partitions.
    indices.sort((a, b) => a - b);
    return indices;
  }

  private collectProfilePairs(visualTimeMs: number, globalViewTimeMs: number, curve: number): number[] {
    const indices = this.profilePairIndices;
    indices.length = 0;
    for (const group of this.pairPartitions) {
      const leftTime = this.profileViewTime(group.leftSpeed, globalViewTimeMs, curve);
      const rightTime = this.profileViewTime(group.rightSpeed, globalViewTimeMs, curve);
      this.profileWindow(group, visualTimeMs, visualTimeMs + Math.max(leftTime, rightTime) * 1.1);
      for (let i = group.first; i < group.last; i++) {
        const index = group.items[i]!.index;
        const endpoints = this.profilePairEndpoints[index]!;
        // Never connect a visible slow endpoint to an as-yet invisible fast one.
        if (
          endpoints.leftTimeMs < visualTimeMs ||
          endpoints.rightTimeMs < visualTimeMs ||
          endpoints.leftTimeMs > visualTimeMs + leftTime * 1.1 ||
          endpoints.rightTimeMs > visualTimeMs + rightTime * 1.1
        )
          continue;
        indices.push(index);
      }
    }
    indices.sort((a, b) => a - b);
    return indices;
  }

  private profileWindow(group: ProfileNotePartition | ProfilePairPartition, firstTime: number, lastTime: number): void {
    // Large seek/first frame uses bounded searches; ordinary ticks advance each profile cursor.
    if (group.windowStart === undefined || Math.abs(firstTime - group.windowStart) > lastTime - firstTime) {
      group.first = lowerBoundTime(group.items, firstTime);
      let low = group.first;
      let high = group.items.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (group.items[middle]!.timeMs <= lastTime) low = middle + 1;
        else high = middle;
      }
      group.last = low;
    } else {
      group.first = adjustLowerBoundCursor(group.items, firstTime, group.first);
      group.last = adjustUpperBoundCursor(group.items, lastTime, group.last);
    }
    group.windowStart = firstTime;
  }

  addJudgement(event: JudgementEvent, timeMs: number, currentGekisouRangeIndex?: number): void {
    this.gekisouPresentation?.record({
      noteId: event.note.id,
      noteTimeMs: event.note.timeMs,
      judgedAtMs: event.judgedAtMs,
      judgement: event.judgement,
    });
    // Compact outside the rAF build path. copyWithin retains the backing
    // storage and avoids the allocation/copy churn of per-frame splice.
    if (this.effectHead > 64 && this.effectHead * 2 >= this.effects.length) {
      this.effects.copyWithin(0, this.effectHead);
      this.effects.length -= this.effectHead;
      this.effectHead = 0;
    }
    if (this.hudJudgementHead > 64 && this.hudJudgementHead * 2 >= this.hudJudgements.length) {
      this.hudJudgements.copyWithin(0, this.hudJudgementHead);
      this.hudJudgements.length -= this.hudJudgementHead;
      this.hudJudgementHead = 0;
    }
    if (judgementName(event.judgement)) {
      this.hudJudgements.push({ event, spawnedAtMs: timeMs, id: this.nextHudJudgementId++ });
    }
    const gekisou = this.gekisou?.isGekisouLane(event, currentGekisouRangeIndex) ?? false;
    const ordinaryKind = nativeParticleEffectKind(event.note);
    const kind = ordinaryKind === "tap" && gekisou ? "excellent" : ordinaryKind;
    if (kind) {
      const lifetime = nativeParticleEffectLifetime(kind, event.judgement, this.noteEffectSkin);
      if (lifetime > 0) {
        const activation = this.nextParticleEffectActivation++;
        this.effects.push({
          event,
          spawnedAtMs: timeMs,
          // `id` is an active-instance identity, not a chart-note identity:
          // the same note can be played again after a seek/restart.
          id: `${event.note.id}:${timeMs}:note:${activation}`,
          kind,
          lifetime,
          seed: mixParticleSeed(this.particleSeedEntropy ^ Math.imul(activation + 1, 0x9e3779b9)),
        });
      }
    }
    const ordinaryLaneKind = nativeLaneEffectKind(event.note);
    const laneKind = ordinaryLaneKind && gekisou
      ? "lane-effect-gekisou" : ordinaryLaneKind;
    // LiveLaneEffectView.UpdateFrame gates lane effects on judgements 3..6
    // (Good..Just); a Bad neither lights the lane nor plays a lane fill.
    if (laneKind && event.judgement >= NoteSimulateJudgement.Good && event.judgement <= NoteSimulateJudgement.Just) {
      const effect: QueuedJudgementEffect = {
        event,
        spawnedAtMs: timeMs,
        id: `${event.note.id}:${timeMs}:lane`,
        kind: laneKind,
        lifetime: laneKind === "lane-effect-gekisou"
          ? OUR_NOTES_GEKISOU_LANE_LIFETIME : NATIVE_LANE_EFFECT_LIFETIME,
      };
      this.effects.push(effect);
      this.claimLaneFeedback(event.note.pos, event.note.size, effect, false, timeMs);
    }
  }

  addLaneInput(event: LaneInputEffectEvent): void {
    if (!Number.isFinite(event.lane) || !Number.isFinite(event.width) || event.width <= 0) return;
    if (this.laneInputEffectHead > 64 && this.laneInputEffectHead * 2 >= this.laneInputEffects.length) {
      this.laneInputEffects.copyWithin(0, this.laneInputEffectHead);
      this.laneInputEffects.length -= this.laneInputEffectHead;
      this.laneInputEffectHead = 0;
    }
    const effect: QueuedLaneInputEffect = {
      event,
      id: `lane-input:${event.pointerId}:${this.nextLaneInputEffectId++}`,
      lifetime: NATIVE_LANE_EFFECT_LIFETIME,
    };
    this.laneInputEffects.push(effect);
    this.claimLaneFeedback(event.lane, event.width, effect, true, event.timeMs);
  }

  private claimLaneFeedback(
    left: number,
    width: number,
    effect: QueuedJudgementEffect | QueuedLaneInputEffect,
    empty: boolean,
    timeMs: number,
  ): void {
    const frameTime = empty ? (effect as QueuedLaneInputEffect).event.timeMs
      : (effect as QueuedJudgementEffect).event.judgedAtMs;
    const priority = laneFeedbackPriority(effect, empty);
    const first = nativeRoundToEven(left);
    const last = first + Math.max(1, nativeRoundToEven(width)) - 1;
    for (let lane = Math.max(0, first); lane <= Math.min(LANE_COUNT - 1, last); lane++) {
      const previous = this.laneFeedbackOwners.get(lane);
      if (previous && timeMs < previous.timeMs) continue;
      if (previous) {
        const previousFrame = previous.empty ? (previous.effect as QueuedLaneInputEffect).event.timeMs
          : (previous.effect as QueuedJudgementEffect).event.judgedAtMs;
        if (previousFrame === frameTime && priority <= laneFeedbackPriority(previous.effect, previous.empty)) continue;
      }
      if (empty && previous && !previous.empty && timeMs < previous.timeMs + NATIVE_LANE_EFFECT_OCCUPANCY_MS) continue;
      this.laneFeedbackOwners.set(lane, { effect, empty, timeMs });
    }
  }

  reset(seekTargetTimeMs?: number): void {
    if (seekTargetTimeMs !== undefined && !Number.isFinite(seekTargetTimeMs)) {
      throw new TypeError("Seek visual barrier must be a finite chart time");
    }
    this.seekTargetTimeMs = seekTargetTimeMs;
    this.gekisouPresentation?.reset();
    this.effects.length = 0;
    this.effectHead = 0;
    this.hudJudgements.length = 0;
    this.hudJudgementHead = 0;
    this.laneFeedbackOwners.clear();
    this.laneInputEffects.length = 0;
    this.laneInputEffectHead = 0;
    this.nextLaneInputEffectId = 0;
    this.firstVisibleNoteCursor = 0;
    this.lastVisibleNoteCursor = 0;
    this.firstVisibleSimultaneousLineCursor = 0;
    this.lastVisibleSimultaneousLineCursor = 0;
    for (const partition of [...this.notePartitions, ...this.pairPartitions]) {
      partition.first = 0;
      partition.last = 0;
      partition.windowStart = undefined;
    }
    for (const line of this.preparedLines) {
      line.pointStartCursor = 0;
      line.pointEndCursor = 0;
      line.particleEffectActive = false;
      line.particleEffectSeed = undefined;
      line.particleEffectStartedAtMs = undefined;
    }
    this.lastTimeMs = seekTargetTimeMs ?? 0;
  }

  /** Rebuild presentation results with the same native watch ticks used by ChartSession.reset. */
  resetWatch(timeMs: number, replay?: WatchVisualReplayContract, history?: readonly JudgementEvent[]): void {
    this.reset(replay ? timeMs : undefined);
    const tracker = this.gekisouPresentation;
    const plan = this.gekisou;
    if (!tracker || !plan) return;
    if (history) {
      for (const event of history) if (event.judgedAtMs <= timeMs) tracker.record({
        noteId: event.note.id, noteTimeMs: event.note.timeMs,
        judgedAtMs: event.judgedAtMs, judgement: event.judgement,
      });
      return;
    }
    for (const note of this.chart.notes) {
      if (!note.judged || note.timeMs >= timeMs) continue;
      let judgedAtMs = Math.floor(note.timeMs) + 1;
      if (replay) {
        const eligibleAt = note.timeMs + replay.inputOffsetMs;
        let low = 0, high = replay.tickTimesMs.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (replay.tickTimesMs[middle]! < eligibleAt) low = middle + 1;
          else high = middle;
        }
        judgedAtMs = replay.tickTimesMs[low] ?? judgedAtMs;
      }
      if (judgedAtMs > timeMs) continue;
      let feverSection = null;
      let feverState = FeverState.Wait;
      for (const section of this.chart.timeline.fever) {
        if (section.startTimeMs > judgedAtMs) break;
        feverSection = section;
        feverState = judgedAtMs < section.endTimeMs ? FeverState.Fever : FeverState.End;
      }
      tracker.record({
        noteId: note.id,
        noteTimeMs: note.timeMs,
        judgedAtMs,
        judgement: plan.autoJudgement(note, { observedTimeMs: judgedAtMs, feverState, feverSection }),
      });
    }
  }

  build(timeMs: number, snapshot: SessionSnapshot, partialSettings: Partial<RenderSettings> = {}): RenderFrame {
    return this.buildFrame(timeMs, snapshot, partialSettings, false);
  }

  /**
   * Allocation-bounded rAF path. The returned DTO and its nested arrays are
   * overwritten by the next call and must be rendered synchronously.
   */
  buildReusable(timeMs: number, snapshot: SessionSnapshot, partialSettings: Partial<RenderSettings> = {}): RenderFrame {
    return this.buildFrame(timeMs, snapshot, partialSettings, true);
  }

  private buildFrame(
    timeMs: number,
    snapshot: SessionSnapshot,
    partialSettings: Partial<RenderSettings>,
    reuse: boolean,
  ): RenderFrame {
    if (timeMs + 5 < this.lastTimeMs) this.reset();
    if (this.seekTargetTimeMs !== undefined && timeMs > this.seekTargetTimeMs) this.seekTargetTimeMs = undefined;
    const visualTimeMs = this.visualTimeMap.toScaledTimeMs(timeMs);
    const settings = partialSettings;
    const noteSpeed = settings.noteSpeed ?? DEFAULT_RENDER_SETTINGS.noteSpeed;
    const noteSpeedCurve = settings.noteSpeedCurve ?? DEFAULT_RENDER_SETTINGS.noteSpeedCurve;
    const mirror = settings.mirror ?? DEFAULT_RENDER_SETTINGS.mirror;
    const noteSize = Math.max(0.1, Math.min(2, settings.noteSize ?? DEFAULT_RENDER_SETTINGS.noteSize));
    const viewTimeMs = noteViewTimeSeconds(noteSpeed, noteSpeedCurve) * 1000;
    const inverseViewTimeMs = 1 / viewTimeMs;
    const earliestVisibleTime = visualTimeMs - viewTimeMs * 0.16;
    const latestVisibleTime = visualTimeMs + viewTimeMs * 1.1;
    if (!this.visualProfiles) {
      this.firstVisibleNoteCursor = adjustLowerBoundCursor(
        this.renderableNotes,
        earliestVisibleTime,
        this.firstVisibleNoteCursor,
      );
      this.lastVisibleNoteCursor = adjustUpperBoundCursor(
        this.renderableNotes,
        latestVisibleTime,
        this.lastVisibleNoteCursor,
      );
    }
    if (this.visualProfiles) this.profileViewTimes.clear();
    const profiledNotes = this.visualProfiles
      ? this.collectProfileNotes(visualTimeMs, viewTimeMs, noteSpeedCurve)
      : undefined;
    const buffers = reuse ? this.reusableBuffers() : undefined;
    const notes: RenderNote[] = buffers?.notes ?? [];
    notes.length = 0;
    for (
      let cursor = profiledNotes ? 0 : this.firstVisibleNoteCursor;
      cursor < (profiledNotes?.length ?? this.lastVisibleNoteCursor);
      cursor++
    ) {
      const index = profiledNotes ? profiledNotes[cursor]! : cursor;
      const note = this.renderableNotes[index]!;
      // After judgement, UpdaterBase.SetLastJudgement sets
      // NoteSimulateState.Done (6). On the next view update,
      // LiveAllNoteView.CleanupNoteView calls TryReleaseNote, which
      // deactivates the GameObject, resets it and returns it to the pool. A
      // consumed note therefore must not keep moving below the judgement line
      // while its impact effect is playing.
      if (snapshot.noteState.isProcessed(note.id)) continue;
      const approach =
        (note.timeMs - visualTimeMs) * (profiledNotes ? this.profileNoteInverse![index]! : inverseViewTimeMs);
      const outputIndex = notes.length;
      const output = buffers
        ? (buffers.notePool[outputIndex] ??= { id: note.id, kind: "tap", lane: 0, width: 0, approach: 0 })
        : ({ id: note.id, kind: "tap", lane: 0, width: 0, approach: 0 } satisfies RenderNote);
      output.id = note.id;
      output.kind = renderKind(note);
      output.lane = mirror ? mirrorLane(note.pos, note.size) : note.pos;
      output.width = note.size;
      output.approach = approach;
      output.direction = renderDirection(note, mirror);
      output.critical = note.critical;
      output.scale = noteSize;
      output.alpha = approach < 0 ? Math.max(0, 1 + approach / 0.16) : 1;
      notes.push(output);
    }

    const simultaneousLines: RenderSimultaneousLine[] = buffers?.simultaneousLines ?? [];
    simultaneousLines.length = 0;
    if (settings.showSimultaneousLine ?? DEFAULT_RENDER_SETTINGS.showSimultaneousLine) {
      // Pair lines share note view progress, but the SpriteRenderer's
      // serialized 0.025-unit Y size remains fixed; only X is resized by
      // LivePairNoteLineView.SetProgress.
      const firstLineTime = Math.max(visualTimeMs, earliestVisibleTime);
      if (!this.visualProfiles) {
        this.firstVisibleSimultaneousLineCursor = adjustLowerBoundCursor(
          this.preparedSimultaneousLines,
          firstLineTime,
          this.firstVisibleSimultaneousLineCursor,
        );
        this.lastVisibleSimultaneousLineCursor = adjustUpperBoundCursor(
          this.preparedSimultaneousLines,
          latestVisibleTime,
          this.lastVisibleSimultaneousLineCursor,
        );
      }
      const profiledPairs = this.visualProfiles
        ? this.collectProfilePairs(visualTimeMs, viewTimeMs, noteSpeedCurve)
        : undefined;
      for (
        let cursor = profiledPairs ? 0 : this.firstVisibleSimultaneousLineCursor;
        cursor < (profiledPairs?.length ?? this.lastVisibleSimultaneousLineCursor);
        cursor++
      ) {
        const index = profiledPairs ? profiledPairs[cursor]! : cursor;
        const line = this.preparedSimultaneousLines[index]!;
        if (snapshot.noteState.isProcessed(line.firstNoteId) || snapshot.noteState.isProcessed(line.secondNoteId))
          continue;
        const outputIndex = simultaneousLines.length;
        const output = buffers
          ? (buffers.simultaneousLinePool[outputIndex] ??= {
              id: line.id,
              leftCenter: 0,
              rightCenter: 0,
              approach: 0,
            })
          : ({ id: line.id, leftCenter: 0, rightCenter: 0, approach: 0 } satisfies RenderSimultaneousLine);
        output.id = line.id;
        output.leftCenter = mirror ? LANE_COUNT - line.rightCenter : line.leftCenter;
        output.rightCenter = mirror ? LANE_COUNT - line.leftCenter : line.rightCenter;
        output.approach = (line.timeMs - visualTimeMs) * inverseViewTimeMs;
        if (profiledPairs) {
          const endpoints = this.profilePairEndpoints[index]!;
          const leftApproach =
            (endpoints.leftTimeMs - visualTimeMs) *
            (1 / this.profileViewTime(endpoints.leftSpeed, viewTimeMs, noteSpeedCurve));
          const rightApproach =
            (endpoints.rightTimeMs - visualTimeMs) *
            (1 / this.profileViewTime(endpoints.rightSpeed, viewTimeMs, noteSpeedCurve));
          if (leftApproach === rightApproach) {
            output.approach = leftApproach;
            delete output.leftApproach;
            delete output.rightApproach;
          } else {
            output.leftApproach = mirror ? rightApproach : leftApproach;
            output.rightApproach = mirror ? leftApproach : rightApproach;
          }
        }
        simultaneousLines.push(output);
      }
    }

    const holds: MutableRenderHold[] = buffers?.holds ?? [];
    holds.length = 0;
    for (const line of this.preparedLines) {
      const authored = line.authored;
      const lineViewTimeMs = this.visualProfiles
        ? this.profileViewTime(this.visualProfiles.lines.get(line.id), viewTimeMs, noteSpeedCurve)
        : viewTimeMs;
      const lineInverseViewTimeMs = this.visualProfiles ? 1 / lineViewTimeMs : inverseViewTimeMs;
      const lineEarliestVisibleTime = this.visualProfiles ? visualTimeMs - lineViewTimeMs * 0.16 : earliestVisibleTime;
      const lineLatestVisibleTime = this.visualProfiles ? visualTimeMs + lineViewTimeMs * 1.1 : latestVisibleTime;
      if (
        authored.length < 2 ||
        authored[authored.length - 1]!.timeMs < lineEarliestVisibleTime ||
        authored[0]!.timeMs > lineLatestVisibleTime
      )
        continue;

      // LiveNoteLineViewBase.SetupAllMesh clamps each BeginProgress/EndProgress
      // to 1 before building a trapezoid. In raw simulator progress, 1 is
      // exactly the judgement line. Keeping older samples behind that point
      // lets the WebGL near plane cut a hole through the ribbon, which is why
      // an active hold used to look like two separate pieces. Clip at the
      // current music time and synthesize the exact intersecting cross-section,
      // as the native mesh builder does.
      const visibleStartTime = Math.max(authored[0]!.timeMs, visualTimeMs);
      const visibleEndTime = Math.min(authored[authored.length - 1]!.timeMs, lineLatestVisibleTime);
      if (visibleEndTime <= visibleStartTime) continue;

      const outputIndex = holds.length;
      const output: MutableRenderHold = buffers
        ? (buffers.holdPool[outputIndex] ??= {
            id: line.id,
            kind: "slide",
            points: [],
            pointPool: [],
          })
        : ({ id: line.id, kind: "slide", points: [] } satisfies MutableRenderHold);
      const points = output.points;
      points.length = 0;
      const pointPool = buffers ? (output as PooledRenderHold).pointPool : undefined;
      this.appendHoldPoint(
        points,
        pointPool,
        samplePreparedLine(line, visibleStartTime, this.sampleStart),
        visualTimeMs,
        lineInverseViewTimeMs,
        mirror,
        line,
      );
      line.pointStartCursor = adjustUpperBoundCursor(line.points, visibleStartTime, line.pointStartCursor);
      line.pointEndCursor = adjustLowerBoundCursor(line.points, visibleEndTime, line.pointEndCursor);
      for (let pointIndex = line.pointStartCursor; pointIndex < line.pointEndCursor; pointIndex++) {
        this.appendHoldPoint(
          points,
          pointPool,
          line.points[pointIndex]!,
          visualTimeMs,
          lineInverseViewTimeMs,
          mirror,
          line,
        );
      }
      this.appendHoldPoint(
        points,
        pointPool,
        samplePreparedLine(line, visibleEndTime, this.sampleEnd),
        visualTimeMs,
        lineInverseViewTimeMs,
        mirror,
        line,
      );
      if (points.length < 2) continue;
      output.id = line.id;
      output.minimumWidth = line.minimumWidth;
      output.kind = line.kind === "guide" ? "guide" : "slide";
      output.active =
        line.kind !== "guide" &&
        timeMs >= line.realStartTimeMs &&
        timeMs < line.realEndTimeMs &&
        snapshot.lineState.isActive(line.id);
      output.alpha =
        line.kind === "guide"
          ? Math.max(0.1, Math.min(1, settings.guideAlpha ?? DEFAULT_RENDER_SETTINGS.guideAlpha)) *
            nativeGuideEndAlpha(timeMs, line.realEndTimeMs)
          : Math.max(0.1, Math.min(1, settings.longAlpha ?? DEFAULT_RENDER_SETTINGS.longAlpha));
      output.critical = line.critical;
      holds.push(output);
    }

    while (
      this.effectHead < this.effects.length &&
      timeMs - this.effects[this.effectHead]!.spawnedAtMs > this.effects[this.effectHead]!.lifetime * 1000
    ) {
      this.effectHead++;
    }
    if (this.effectHead === this.effects.length && this.effectHead > 0) {
      this.effects.length = 0;
      this.effectHead = 0;
    }
    while (
      this.hudJudgementHead < this.hudJudgements.length &&
      timeMs - this.hudJudgements[this.hudJudgementHead]!.spawnedAtMs >= HUD_JUDGEMENT_LIFETIME_SECONDS * 1000
    ) {
      this.hudJudgementHead++;
    }
    if (this.hudJudgementHead === this.hudJudgements.length && this.hudJudgementHead > 0) {
      this.hudJudgements.length = 0;
      this.hudJudgementHead = 0;
    }
    while (
      this.laneInputEffectHead < this.laneInputEffects.length &&
      timeMs - this.laneInputEffects[this.laneInputEffectHead]!.event.timeMs >
        this.laneInputEffects[this.laneInputEffectHead]!.lifetime * 1000
    ) {
      this.laneInputEffectHead++;
    }
    if (this.laneInputEffectHead === this.laneInputEffects.length && this.laneInputEffectHead > 0) {
      this.laneInputEffects.length = 0;
      this.laneInputEffectHead = 0;
    }
    const particles: RenderParticleEffect[] = buffers?.particles ?? [];
    particles.length = 0;
    if (settings.effects ?? DEFAULT_RENDER_SETTINGS.effects) {
      // Source UpdateFrame replaces the previous type in each of 24 lanes.
      for (let index = this.effectHead; index < this.effects.length; index++) {
        const effect = this.effects[index]!;
        const age = (timeMs - effect.spawnedAtMs) / 1000;
        if (age < 0 || age > effect.lifetime) continue;
        const note = effect.event.note;
        const direction = renderDirection(note, mirror);
        const kind = directedLaneEffectKind(effect.kind, direction);

        if (isRenderLaneEffectKind(kind)) {
          // PlayEffect treats laneFromIndex..laneToIndex as an inclusive range.
          // NoteBase stores the inclusive end as start + roundedWidth - 1, so a
          // size-2 note drives two of the 24 pre-initialized lane instances.
          const laneStart = nativeRoundToEven(mirror ? mirrorLane(note.pos, note.size) : note.pos);
          const laneEnd = laneStart + Math.max(1, nativeRoundToEven(note.size)) - 1;
          for (let lane = laneStart; lane <= laneEnd; lane += 1) {
            if (this.laneFeedbackOwners.get(mirror ? LANE_COUNT - 1 - lane : lane)?.effect !== effect) continue;
            const outputIndex = particles.length;
            const id = `${effect.id}:${lane}`;
            const output = buffers
              ? (buffers.particlePool[outputIndex] ??= { id, kind, lane, age: 0 })
              : ({ id, kind, lane, age: 0 } satisfies RenderParticleEffect);
            output.id = id;
            output.kind = kind;
            output.lane = lane;
            output.width = 1;
            output.approach = undefined;
            output.age = age;
            output.judgement = judgementName(effect.event.judgement);
            output.lifetime = effect.lifetime;
            output.intensity = noteSize;
            output.direction = direction;
            output.color = undefined;
            // Authored lane ParticleSystems disable autoRandomSeed and store 0,
            // so Stop/Clear + Play repeats the same deterministic sequence.
            output.seed = 0;
            particles.push(output);
          }
          continue;
        }

        // The native finish event runs at the clip's float32 length.
        if (Math.fround(age) >= Math.fround(effect.lifetime)) continue;

        const outputIndex = particles.length;
        const output = buffers
          ? (buffers.particlePool[outputIndex] ??= { id: effect.id, kind: effect.kind, lane: 0, age: 0 })
          : ({ id: effect.id, kind: effect.kind, lane: 0, age: 0 } satisfies RenderParticleEffect);
        output.id = effect.id;
        output.kind = kind;
        output.lane = mirror ? mirrorLane(note.pos, note.size) : note.pos;
        output.width = note.size;
        output.approach = undefined;
        output.age = age;
        output.judgement = judgementName(effect.event.judgement);
        output.lifetime = effect.lifetime;
        output.intensity = noteSize;
        output.direction = direction;
        output.color = undefined;
        // Source effect001 ParticleSystems use autoRandomSeed=true. Store one
        // fresh seed at Play time so the same effect is stable across frames,
        // yet a replayed note receives a new particle layout. Lane effects
        // intentionally remain seed 0 because their native systems disable
        // autoRandomSeed.
        output.seed = effect.seed;
        particles.push(output);
      }
      // Empty input only restarts lanes without a still-playing successful fill.
      for (let index = this.laneInputEffectHead; index < this.laneInputEffects.length; index++) {
        const effect = this.laneInputEffects[index]!;
        const age = (timeMs - effect.event.timeMs) / 1000;
        if (age < 0 || age > effect.lifetime) continue;
        const laneStart = nativeRoundToEven(
          mirror ? mirrorLane(effect.event.lane, effect.event.width) : effect.event.lane,
        );
        const laneEnd = laneStart + Math.max(1, nativeRoundToEven(effect.event.width)) - 1;
        for (let lane = laneStart; lane <= laneEnd; lane += 1) {
          if (this.laneFeedbackOwners.get(mirror ? LANE_COUNT - 1 - lane : lane)?.effect !== effect) continue;
          const outputIndex = particles.length;
          const id = `${effect.id}:${lane}`;
          const output = buffers
            ? (buffers.particlePool[outputIndex] ??= {
                id,
                kind: "lane-input-blank-miss",
                lane,
                age: 0,
              })
            : ({
                id,
                kind: "lane-input-blank-miss",
                lane,
                age: 0,
              } satisfies RenderParticleEffect);
          output.id = id;
          output.kind = "lane-input-blank-miss";
          output.lane = lane;
          output.width = 1;
          output.approach = undefined;
          output.age = age;
          output.judgement = undefined;
          output.lifetime = effect.lifetime;
          output.intensity = 1;
          output.direction = "none";
          output.color = undefined;
          output.seed = 0;
          particles.push(output);
        }
      }
      // UpdateFrame keeps one SlideLoop prefab per Playing long-line ID in
      // _lineNoteEffectDictionary, updates its interpolated width/position,
      // and stops/removes it when that line is no longer active. Session's
      // allocation-free lineState additionally preserves pointer ownership in
      // play mode instead of lighting every overlapping chart line.
      for (const line of this.preparedLines) {
        if (
          line.kind !== "long" ||
          !snapshot.lineState.isActive(line.id) ||
          line.authored.length < 2 ||
          (this.seekTargetTimeMs !== undefined && timeMs <= this.seekTargetTimeMs)
        ) {
          line.particleEffectActive = false;
          line.particleEffectSeed = undefined;
          line.particleEffectStartedAtMs = undefined;
          continue;
        }
        if (
          !line.particleEffectActive ||
          line.particleEffectSeed === undefined ||
          line.particleEffectStartedAtMs === undefined
        ) {
          const activation = this.nextParticleEffectActivation++;
          line.particleEffectActive = true;
          line.particleEffectSeed = mixParticleSeed(this.particleSeedEntropy ^ Math.imul(activation + 1, 0x9e3779b9));
          // Native acquisition enables a newly active prefab; pooled objects
          // keep no Animator state on disable. Its clock starts at activation.
          line.particleEffectStartedAtMs = timeMs;
        }
        const point = samplePreparedLine(line, visualTimeMs, this.sampleStart);
        const outputIndex = particles.length;
        const id = `line:${line.id}`;
        const output = buffers
          ? (buffers.particlePool[outputIndex] ??= { id, kind: "slide-loop", lane: 0, age: 0 })
          : ({ id, kind: "slide-loop", lane: 0, age: 0 } satisfies RenderParticleEffect);
        output.id = id;
        output.kind = "slide-loop";
        output.lane = mirror ? mirrorLane(point.pos, point.size) : point.pos;
        output.width = point.size;
        output.age = Math.max(0, (timeMs - line.particleEffectStartedAtMs) / 1000);
        output.judgement = "perfect";
        output.lifetime = undefined;
        output.intensity = noteSize;
        output.direction = "none";
        // SlideLoop stays stable while held, but its source ParticleSystems
        // have autoRandomSeed=true and therefore receive a fresh sequence
        // after the line is stopped and activated again.
        output.seed = line.particleEffectSeed;
        particles.push(output);
      }
    } else {
      for (const line of this.preparedLines) {
        line.particleEffectActive = false;
        line.particleEffectSeed = undefined;
        line.particleEffectStartedAtMs = undefined;
      }
    }

    const rank = buffers
      ? writeNativeScoreRank(snapshot.score, settings.scoreRankScores, buffers.rank)
      : nativeScoreRank(snapshot.score, settings.scoreRankScores);
    const visual = snapshot.watchVisualState;
    const hudTimeMs = visual?.sampledTimeMs ?? timeMs;
    const last = visual ? visual.lastJudgement : snapshot.lastJudgement;
    const hud = buffers?.frame.hud ?? {};
    const hudJudgements: RenderJudgementInstance[] = buffers?.hudJudgements ?? [];
    hudJudgements.length = 0;
    for (let index = this.hudJudgementHead; index < this.hudJudgements.length; index += 1) {
      const queued = this.hudJudgements[index]!;
      const judgement = judgementName(queued.event.judgement);
      if (!judgement) continue;
      const outputIndex = hudJudgements.length;
      const output = buffers
        ? (buffers.hudJudgementPool[outputIndex] ??= {
            id: 0,
            judgement,
            age: 0,
            laneCenter: 0,
            width: 0,
            fastSlow: null,
            differenceMs: 0,
          })
        : ({
            id: 0,
            judgement,
            age: 0,
            laneCenter: 0,
            width: 0,
            fastSlow: null,
            differenceMs: 0,
          } satisfies RenderJudgementInstance);
      output.id = queued.id;
      output.judgement = judgement;
      output.age = Math.max(0, (hudTimeMs - queued.spawnedAtMs) / 1000);
      output.laneCenter = mirror
        ? LANE_COUNT - queued.event.note.pos - queued.event.note.size / 2
        : queued.event.note.pos + queued.event.note.size / 2;
      output.width = queued.event.note.size;
      output.fastSlow = queued.event.timing === 1 ? "FAST" : queued.event.timing === 2 ? "SLOW" : null;
      output.differenceMs = queued.event.diffMs;
      hudJudgements.push(output);
    }
    hud.score = snapshot.score;
    // UICountAdditionInfoElement positive/negative clips are both 0.45 s.
    hud.scoreDelta = last && hudTimeMs - last.judgedAtMs < 450 ? last.scoreDelta : undefined;
    hud.combo = visual?.combo ?? snapshot.combo;
    hud.comboAge =
      last && hud.combo >= 1 && last.combo === hud.combo
        ? Math.max(0, (hudTimeMs - last.judgedAtMs) / 1000)
        : undefined;
    hud.perfectCombo = visual?.perfectCombo ?? snapshot.perfectCombo;
    hud.fullCombo = visual?.fullCombo ?? snapshot.fullCombo;
    hud.continuationEffects = settings.continuationEffectDisplay ?? true;
    hud.life = snapshot.life;
    hud.maxLife = 1000;
    hud.rank = rank.rank;
    hud.rankProgress = rank.progress;
    hud.rankLabels = HUD_RANK_LABELS;
    hud.judgement = last ? judgementName(last.judgement) : undefined;
    hud.judgementAge = last ? Math.max(0, (hudTimeMs - last.judgedAtMs) / 1000) : undefined;
    hud.fastSlow = last?.timing === 1 ? "FAST" : last?.timing === 2 ? "SLOW" : null;
    hud.differenceMs = last?.diffMs;
    hud.judgements = hudJudgements;
    hud.judgementPosition = settings.judgeResultPosition ?? DEFAULT_RENDER_SETTINGS.judgeResultPosition;
    hud.noteOverlapLaneBuffer = settings.noteOverlapLaneBuffer ?? DEFAULT_RENDER_SETTINGS.noteOverlapLaneBuffer;
    hud.showFastSlow = settings.showFastSlow ?? DEFAULT_RENDER_SETTINGS.showFastSlow;
    hud.showPerfectFastSlow = settings.showPerfectFastSlow ?? DEFAULT_RENDER_SETTINGS.showPerfectFastSlow;
    hud.showJudgeOffsetMs = settings.showJudgeOffsetMs ?? DEFAULT_RENDER_SETTINGS.showJudgeOffsetMs;
    hud.alwaysShowFastSlow = settings.alwaysShowFastSlow ?? DEFAULT_RENDER_SETTINGS.alwaysShowFastSlow;
    hud.showPause = true;

    const stage = buffers?.frame.stage ?? {};
    stage.laneOpacity = settings.laneOpacity ?? DEFAULT_RENDER_SETTINGS.laneOpacity;
    stage.guidelineOpacity = settings.guidelineOpacity ?? DEFAULT_RENDER_SETTINGS.guidelineOpacity;
    stage.judgementLineOpacity = (settings.showJudgementLine ?? DEFAULT_RENDER_SETTINGS.showJudgementLine) ? 1 : 0;
    stage.guidelineCount = settings.guidelineCount ?? DEFAULT_RENDER_SETTINGS.guidelineCount;
    stage.backgroundBrightness = settings.backgroundBrightness ?? DEFAULT_RENDER_SETTINGS.backgroundBrightness;

    const gekisouConfiguration = this.gekisouPresentationConfiguration;
    const overlays = this.gekisouPresentation && gekisouConfiguration
      ? gekisouConfiguration.projector.project(
          this.gekisouPresentation.sample(hudTimeMs), gekisouConfiguration.context,
        )
      : undefined;

    const deltaTime = Math.max(0, timeMs - this.lastTimeMs) / 1000;
    this.lastTimeMs = timeMs;
    if (buffers) {
      buffers.frame.time = timeMs / 1000;
      buffers.frame.deltaTime = deltaTime;
      buffers.frame.overlays = overlays;
      return buffers.frame;
    }
    return { time: timeMs / 1000, deltaTime, notes, simultaneousLines, holds, particles, hud, stage, overlays };
  }

  private appendHoldPoint(
    points: RenderPathPoint[],
    pool: RenderPathPoint[] | undefined,
    point: PreparedHoldPoint,
    timeMs: number,
    inverseViewTimeMs: number,
    mirror: boolean,
    line: PreparedLine,
  ): void {
    const index = points.length;
    const output = pool
      ? (pool[index] ??= { lane: 0, width: 0, approach: 0, leftEasing: "linear", rightEasing: "linear" })
      : ({ lane: 0, width: 0, approach: 0, leftEasing: "linear", rightEasing: "linear" } satisfies RenderPathPoint);
    output.lane = mirror ? mirrorLane(point.pos, point.size) : point.pos;
    output.width = point.size;
    output.approach = (point.timeMs - timeMs) * inverseViewTimeMs;
    const authoredTimeMs = Math.floor(this.visualTimeMap.toTimeMs(point.timeMs));
    output.lineProgress = Math.fround(Math.fround(authoredTimeMs - line.realStartTimeMs) * line.inverseDuration);
    points.push(output);
  }

  private reusableBuffers(): ReusableFrameBuffers {
    if (this.reusable) return this.reusable;
    const notes: RenderNote[] = [];
    const simultaneousLines: RenderSimultaneousLine[] = [];
    const holds: MutableRenderHold[] = [];
    const particles: RenderParticleEffect[] = [];
    const hudJudgements: RenderJudgementInstance[] = [];
    this.reusable = {
      frame: { time: 0, deltaTime: 0, notes, simultaneousLines, holds, particles, hud: {}, stage: {} },
      notes,
      notePool: [],
      simultaneousLines,
      simultaneousLinePool: [],
      holds,
      holdPool: [],
      particles,
      particlePool: [],
      hudJudgements,
      hudJudgementPool: [],
      rank: { rank: "D", progress: 0 },
    };
    return this.reusable;
  }
}
