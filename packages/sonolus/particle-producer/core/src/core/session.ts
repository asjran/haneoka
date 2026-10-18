import { resolveAutomaticJudgement, type AutomaticJudgementPolicy } from "./automatic.js";
import { SessionTimeline } from "./SessionTimeline.js";
import {
  FeverState,
  JudgementAreaOffsetType,
  JudgeTiming,
  NoteJudgementType,
  NoteOperateType,
  NoteSimulateJudgement,
} from "./enums.js";
import type { ChartMode } from "./enums.js";
import { DEFAULT_ASSIST_LEVEL, getAssistJudgementAreaOffset, requireAssistLevel, type AssistLevel } from "./assist.js";
import { isTargetLane, LANE_COUNT } from "./geometry.js";
import {
  judge,
  maximumEarlyWindow as calculateMaximumEarlyWindow,
  maximumLateWindow as calculateMaximumLateWindow,
} from "./judgement.js";
import {
  breaksCombo,
  contribution,
  incrementsCombo,
  LIFE_BASE,
  lifeDamage,
  normalizeScore,
  perfectCeiling,
  perfectCeilingAtNoteTimes,
  type ScoringComboPolicy,
} from "./scoring.js";
import type {
  ChartCallChangeEvent,
  ChartDocument,
  ChartFeverSection,
  ChartFeverTransitionEvent,
  ChartNote,
  ChartSkillEvent,
  JudgementEvent,
  SessionLineState,
  SessionNoteState,
  SessionSnapshot,
  WatchVisualReplayContract,
  WatchVisualState,
} from "./types.js";

export interface AutoJudgementContext {
  readonly observedTimeMs: number;
  readonly feverState: FeverState;
  readonly feverSection: ChartFeverSection | null;
}

export interface SessionOptions {
  automaticPolicy?: AutomaticJudgementPolicy;
  scoringComboPolicy?: ScoringComboPolicy;
  mode?: ChartMode;
  judgementOffsetMs?: number;
  assistLevel?: number;
  /** Pure source policy for automatic judgements; ordinary Watch defaults to Perfect. */
  autoJudgement?: (note: Readonly<ChartNote>, context: AutoJudgementContext) => NoteSimulateJudgement;
}

export interface InputVector {
  dx: number;
  dy: number;
}

type PointerToken = number | typeof DEFAULT_POINTER;

interface ActivePointerState {
  lane: number;
  fresh: boolean;
}

const DEFAULT_POINTER = Symbol("default-pointer");
const EMPTY_LINE_IDS: readonly number[] = Object.freeze([]);
const MAX_ACTIVE_POINTERS = 16;

function integerTimeMs(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

function saturatingIncrement(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

const MAXIMUM_EARLY_BY_LEVEL_AND_TYPE: number[][] = [];
const MAXIMUM_LATE_BY_LEVEL_AND_TYPE: number[][] = [];

function maximumEarlyWindow(type: NoteJudgementType, assistLevel: AssistLevel): number {
  const cache = (MAXIMUM_EARLY_BY_LEVEL_AND_TYPE[assistLevel] ??= []);
  return (cache[type] ??= calculateMaximumEarlyWindow(type, assistLevel));
}

function maximumLateWindow(type: NoteJudgementType, assistLevel: AssistLevel): number {
  const cache = (MAXIMUM_LATE_BY_LEVEL_AND_TYPE[assistLevel] ??= []);
  return (cache[type] ??= calculateMaximumLateWindow(type, assistLevel));
}

export type ChartSessionEventMap = {
  judgement: JudgementEvent;
  skill: ChartSkillEvent;
  fever: ChartFeverTransitionEvent;
  callChange: ChartCallChangeEvent;
  update: SessionSnapshot;
  reset: SessionSnapshot;
};

/**
 * LiveJudgementAreaOffsetSettings.GetJudgementAreaOffset using assist level 0
 * master data. Slide offsets interpolate by native note-lane width (4 -> 5).
 */
export function nativeJudgementAreaOffsetX(
  type: JudgementAreaOffsetType,
  noteLaneWidth: number,
  assistLevel: AssistLevel = DEFAULT_ASSIST_LEVEL,
): number {
  if (type === JudgementAreaOffsetType.EnumMax)
    return getAssistJudgementAreaOffset(JudgementAreaOffsetType.Default, noteLaneWidth, assistLevel).x;
  return getAssistJudgementAreaOffset(type, noteLaneWidth, assistLevel).x;
}

function isFlick(note: ChartNote): boolean {
  return (
    note.operateType === NoteOperateType.Flick ||
    note.operateType === NoteOperateType.SlideBeginFlick ||
    note.operateType === NoteOperateType.SlideEndFlick ||
    note.operateType === NoteOperateType.GuideBeginFlick
  );
}

function isRelease(note: ChartNote): boolean {
  return note.operateType === NoteOperateType.SlideEnd;
}

function isTrace(note: ChartNote): boolean {
  return note.judgementType === NoteJudgementType.Trace || note.judgementType === NoteJudgementType.SlideEndTrace;
}

function isTap(note: ChartNote): boolean {
  return !isFlick(note) && !isRelease(note);
}

function acceptsAnyInput(_note: ChartNote): boolean {
  return true;
}

function isLineEnd(note: ChartNote): boolean {
  return (
    note.operateType === NoteOperateType.SlideEnd ||
    note.operateType === NoteOperateType.SlideEndFlick ||
    note.operateType === NoteOperateType.SlideEndTrace
  );
}

export class ChartSession {
  mode: ChartMode;
  private readonly listeners = new Map<keyof ChartSessionEventMap, Set<(event: never) => void>>();
  private readonly processed = new Set<number>();
  /** Notes that crossed the late boundary on the preceding simulator update. */
  private readonly pendingLastTiming = new Map<number, ChartNote>();
  private readonly noteState: SessionNoteState = Object.freeze({
    isProcessed: (noteId: number): boolean => this.processed.has(noteId),
  });
  private readonly lineState: SessionLineState = Object.freeze({
    isActive: (lineId: number): boolean => this.isLongLineActive(lineId),
  });
  private readonly playableNotes: ChartNote[];
  private readonly longLineIdsByNoteId: ReadonlyMap<number, readonly number[]>;
  private readonly longLineStartIdsByNoteId: ReadonlyMap<number, readonly number[]>;
  private readonly longLineEndIdsByNoteId: ReadonlyMap<number, readonly number[]>;
  private readonly watchLongLineSpans: ReadonlyArray<{ startTimeMs: number; endTimeMs: number }>;
  private readonly longLineSpanById: ReadonlyMap<number, { startTimeMs: number; endTimeMs: number }>;
  private readonly maximumEarlyMs: number;
  private readonly maximumLateMs: number;
  private readonly pointerLines = new Map<PointerToken, number>();
  private readonly linePointers = new Map<number, PointerToken>();
  /** Current lane for active native fingers; entries are cleared on lift/cancel. */
  private readonly activePointers = new Map<PointerToken, ActivePointerState>();
  private readonly presentationTimeline: SessionTimeline;
  private readonly ceiling: number;
  private readonly scoringComboPolicy: ScoringComboPolicy;
  private scoringGroupTime = Number.NaN;
  private scoringGroupCombo = 0;
  private readonly reusableSnapshot: SessionSnapshot;
  private judgementOffsetMs: number;
  private contributionSum = 0;
  private score = 0;
  private combo = 0;
  private allPerfect = true;
  private fullCombo = true;
  private maxCombo = 0;
  private life = LIFE_BASE;
  private lastJudgement: JudgementEvent | null = null;
  private watchVisualState: WatchVisualState | undefined;
  private timeMs = 0;
  /** First note which has not already been consumed; keeps rAF updates O(new notes). */
  private updateCursor = 0;
  readonly assistLevel: AssistLevel;
  private readonly autoJudgement: SessionOptions["autoJudgement"];

  constructor(
    readonly chart: ChartDocument,
    options: SessionOptions = {},
  ) {
    this.mode = options.mode ?? "watch";
    this.scoringComboPolicy = options.scoringComboPolicy ?? "sequential";
    this.requireScoringMode();
    if (options.autoJudgement && options.automaticPolicy) throw new TypeError("Choose callback or automatic result data");
    this.autoJudgement = options.autoJudgement ?? (options.automaticPolicy
      ? (note, context) => resolveAutomaticJudgement(options.automaticPolicy!, note.judgementType, context.observedTimeMs)
      : undefined);
    this.assistLevel = requireAssistLevel(options.assistLevel ?? DEFAULT_ASSIST_LEVEL);
    this.judgementOffsetMs = integerTimeMs(options.judgementOffsetMs ?? 0);
    this.playableNotes = chart.notes.filter((note) => note.judged);
    const longLines = chart.lines.filter((line) => line.kind === "long");
    const memberships = new Map<number, number[]>();
    const starts = new Map<number, number[]>();
    const ends = new Map<number, number[]>();
    const include = (index: Map<number, number[]>, noteId: number | undefined, lineId: number) => {
      if (noteId === undefined) return;
      const lineIds = index.get(noteId);
      if (lineIds) lineIds.push(lineId);
      else index.set(noteId, [lineId]);
    };
    for (const line of longLines) {
      for (const noteId of line.noteIds) include(memberships, noteId, line.id);
      include(starts, line.noteIds[0], line.id);
      include(ends, line.noteIds.at(-1), line.id);
    }
    this.longLineIdsByNoteId = memberships;
    this.longLineStartIdsByNoteId = starts;
    this.longLineEndIdsByNoteId = ends;
    const noteById = new Map(chart.notes.map((note) => [note.id, note] as const));
    const longLineSpans = longLines
      .map((line) => {
        const notes = line.noteIds
          .map((id) => noteById.get(id))
          .filter((note): note is ChartNote => note !== undefined);
        return {
          id: line.id,
          startTimeMs: notes.reduce((minimum, note) => Math.min(minimum, note.timeMs), Number.POSITIVE_INFINITY),
          endTimeMs: notes.reduce((maximum, note) => Math.max(maximum, note.timeMs), Number.NEGATIVE_INFINITY),
        };
      })
      .filter((line) => Number.isFinite(line.startTimeMs) && line.endTimeMs > line.startTimeMs);
    this.longLineSpanById = new Map(longLineSpans.map((line) => [line.id, line] as const));
    const sortedSpans = longLineSpans
      .map(({ startTimeMs, endTimeMs }) => ({ startTimeMs, endTimeMs }))
      .sort((left, right) => left.startTimeMs - right.startTimeMs || left.endTimeMs - right.endTimeMs);
    const mergedSpans: Array<{ startTimeMs: number; endTimeMs: number }> = [];
    for (const span of sortedSpans) {
      const previous = mergedSpans[mergedSpans.length - 1];
      if (previous && span.startTimeMs <= previous.endTimeMs)
        previous.endTimeMs = Math.max(previous.endTimeMs, span.endTimeMs);
      else mergedSpans.push(span);
    }
    this.watchLongLineSpans = mergedSpans;
    this.maximumEarlyMs = this.playableNotes.reduce(
      (maximum, note) => Math.max(maximum, maximumEarlyWindow(note.judgementType, this.assistLevel)),
      0,
    );
    this.maximumLateMs = this.playableNotes.reduce(
      (maximum, note) => Math.max(maximum, maximumLateWindow(note.judgementType, this.assistLevel)),
      0,
    );
    this.ceiling = this.scoringComboPolicy === "strict-prior-note-time" ? perfectCeilingAtNoteTimes(this.playableNotes) : perfectCeiling(this.playableNotes.map((note) => note.operateType));
    this.presentationTimeline = new SessionTimeline(chart.timeline, { skill: event => this.emit("skill", event), fever: event => this.emit("fever", event), callChange: event => this.emit("callChange", event) });
    this.reusableSnapshot = {
      timeMs: 0,
      durationMs: chart.durationMs,
      activeLongLine: false,
      combo: 0,
      fullCombo: true,
      allPerfect: true,
      perfectCombo: false,
      maxCombo: 0,
      score: 0,
      life: LIFE_BASE,
      processed: 0,
      total: this.playableNotes.length,
      lastJudgement: null,
      lastSkill: null,
      callChange: null,
      feverState: FeverState.Wait,
      feverSection: null,
      noteState: this.noteState,
      lineState: this.lineState,
    };
  }

  on<K extends keyof ChartSessionEventMap>(type: K, listener: (event: ChartSessionEventMap[K]) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(type, set);
    return () => set.delete(listener as (event: never) => void);
  }

  setOffset(milliseconds: number): void {
    this.judgementOffsetMs = integerTimeMs(milliseconds);
  }

  setMode(mode: ChartMode): void {
    this.requireScoringMode(mode);
    if (this.mode === mode) return;
    this.mode = mode;
    this.reset(this.timeMs);
  }

  update(timeMs: number): SessionSnapshot {
    this.advance(timeMs);
    const snapshot = this.snapshot();
    this.emit("update", snapshot);
    return snapshot;
  }

  /**
   * Snapshot-reusing rAF variant. The returned object is overwritten by the
   * next reusable update and therefore must not be retained as history.
   */
  updateReusable(timeMs: number): SessionSnapshot {
    this.advance(timeMs);
    const snapshot = this.writeSnapshot(this.reusableSnapshot);
    this.emit("update", snapshot);
    return snapshot;
  }

  /**
   * Settles the score after media playback stops. Exact-duration notes remain
   * eligible until this exclusive terminal update, and play mode preserves the
   * two-update last-timing transition before every note becomes processed.
   */
  finish(timeMs = this.chart.durationMs): SessionSnapshot {
    const terminalTimeMs = saturatingIncrement(integerTimeMs(timeMs));
    if (this.mode === "watch") {
      this.advance(Math.max(this.timeMs, terminalTimeMs));
    } else if (this.mode === "play") {
      const lastNoteTimeMs = this.playableNotes.at(-1)?.timeMs ?? terminalTimeMs;
      const updateCeilingMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(terminalTimeMs, lastNoteTimeMs + 2_000));
      const settleTimeMs = Math.max(this.timeMs, updateCeilingMs);
      this.advance(settleTimeMs);
      if (this.pendingLastTiming.size > 0) this.advance(settleTimeMs);
    } else {
      this.advance(Math.max(this.timeMs, terminalTimeMs));
    }
    const snapshot = this.snapshot();
    this.emit("update", snapshot);
    return snapshot;
  }

  private advance(timeMs: number): void {
    this.requireScoringMode();
    const nextTimeMs = integerTimeMs(timeMs);
    if (nextTimeMs > this.timeMs && this.watchVisualState?.sampledTimeMs !== undefined) {
      // Resume the real visual clock while retaining the reconstructed last
      // event. The business last event still has reset's transport timestamp.
      this.watchVisualState = { ...this.watchVisualState, sampledTimeMs: undefined };
    }
    if (nextTimeMs + 5 < this.timeMs) this.reset(nextTimeMs);
    // Positive BGM offsets create a real pre-roll before chart time zero.
    // Keeping that time negative prevents watch mode from consuming tick-zero
    // notes as soon as the media element starts.
    this.timeMs = nextTimeMs;
    this.advanceTimeline();
    this.advanceUpdateCursor();
    if (this.mode === "watch") {
      while (this.updateCursor < this.playableNotes.length) {
        const note = this.playableNotes[this.updateCursor]!;
        if (note.timeMs >= this.timeMs) break;
        if (this.processed.has(note.id)) this.updateCursor++;
        else this.apply(note, this.automaticJudgement(note, this.timeMs), JudgeTiming.Auto, 0, this.timeMs);
      }
    } else if (this.mode === "play") {
      // Crossing the late boundary only enters PlayingLast. The next updater
      // call commits the terminal result and makes the note Done.
      for (const [noteId, note] of this.pendingLastTiming) {
        this.pendingLastTiming.delete(noteId);
        if (!this.processed.has(noteId)) {
          this.apply(note, NoteSimulateJudgement.Miss, JudgeTiming.LastTiming, 2_147_483_647, this.timeMs);
        }
      }

      const adjustedTimeMs = this.timeMs + this.judgementOffsetMs;
      const heldPointers = this.readyHeldPointers();
      this.advanceHeldSlideEnds(adjustedTimeMs, heldPointers);
      this.advanceHeldTicks(adjustedTimeMs, heldPointers);
      for (let index = this.updateCursor; index < this.playableNotes.length; index++) {
        const note = this.playableNotes[index]!;
        if (note.timeMs >= adjustedTimeMs) break;
        if (this.processed.has(note.id) || this.pendingLastTiming.has(note.id)) continue;
        // Late-window widths vary by note type, so a still-live earlier note
        // cannot terminate the scan for later notes with narrower windows.
        if (note.timeMs + maximumLateWindow(note.judgementType, this.assistLevel) >= adjustedTimeMs) continue;
        this.pendingLastTiming.set(note.id, note);
      }
    }
  }

  tap(lane: number, timeMs = this.timeMs, pointerId?: number): JudgementEvent | null {
    this.rememberPointer(this.pointerToken(pointerId), lane, true);
    return this.consume(lane, timeMs, isTap, pointerId);
  }

  release(lane: number, timeMs = this.timeMs, pointerId?: number): JudgementEvent | null {
    const pointer = this.pointerToken(pointerId);
    // A lifted finger no longer maintains its long-note line even when the
    // release happened before the end judgment window. Clear it before
    // notifying listeners so a callback's new press survives this release.
    this.activePointers.delete(pointer);
    this.unbindPointer(pointer);
    return this.consume(lane, timeMs, (note) => isRelease(note) || isTrace(note), pointerId, true);
  }

  flick(lane: number, _vector: InputVector, timeMs = this.timeMs, pointerId?: number): JudgementEvent | null {
    this.rememberPointer(this.pointerToken(pointerId), lane);
    // Native FlickUpdater records the vector but accepts by scalar lane and
    // timing only. Chart direction remains available to the renderer.
    return this.consume(lane, timeMs, isFlick, pointerId);
  }

  trace(lane: number, timeMs = this.timeMs, pointerId?: number): JudgementEvent | null {
    this.rememberPointer(this.pointerToken(pointerId), lane);
    return this.consume(lane, timeMs, isTrace, pointerId);
  }

  /**
   * Reports whether this pointer is currently over any consumable note,
   * regardless of gesture. LiveLaneFingerState suppresses InVain feedback for
   * a claimed input before a later trace/flick phase performs the judgement;
   * this read-only query lets the browser input adapter preserve that order.
   */
  hasInputCandidate(lane: number, inputTimeMs = this.timeMs, pointerId?: number): boolean {
    if (this.mode !== "play") return false;
    if (!Number.isFinite(lane) || lane < 0 || lane > LANE_COUNT - 1) return false;
    const adjustedTime = integerTimeMs(inputTimeMs) + this.judgementOffsetMs;
    const pointer = this.pointerToken(pointerId);
    let low = 0;
    let high = this.playableNotes.length;
    const earliestCandidateTime = adjustedTime - this.maximumLateMs;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.playableNotes[middle]!.timeMs < earliestCandidateTime) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.playableNotes.length; index++) {
      const note = this.playableNotes[index]!;
      const diff = adjustedTime - note.timeMs;
      if (diff < -this.maximumEarlyMs) break;
      if (this.candidateDistance(note, diff, lane, pointer, acceptsAnyInput) >= 0) return true;
    }
    return false;
  }

  cancel(pointerId?: number): void {
    const pointer = this.pointerToken(pointerId);
    this.activePointers.delete(pointer);
    this.unbindPointer(pointer);
  }

  private requireScoringMode(mode: ChartMode = this.mode): void {
    if (mode === "play" && this.scoringComboPolicy === "strict-prior-note-time")
      throw new RangeError("strict-prior scoring requires canonical history; Play is not enabled");
  }

  reset(timeMs = 0, visualReplay?: WatchVisualReplayContract): SessionSnapshot {
    this.requireScoringMode();
    const nextTimeMs = integerTimeMs(timeMs);
    const visualState = this.mode === "watch" && visualReplay
      ? this.rebuildWatchVisualState(nextTimeMs, visualReplay)
      : undefined;
    this.processed.clear();
    this.pendingLastTiming.clear();
    this.contributionSum = 0;
    this.scoringGroupTime = Number.NaN;
    this.scoringGroupCombo = 0;
    this.score = 0;
    this.combo = 0;
    this.allPerfect = true;
    this.fullCombo = true;
    this.maxCombo = 0;
    this.life = LIFE_BASE;
    this.lastJudgement = null;
    this.watchVisualState = visualState;
    this.timeMs = nextTimeMs;
    this.updateCursor = 0;
    this.pointerLines.clear();
    this.linePointers.clear();
    this.activePointers.clear();
    this.presentationTimeline.reset(nextTimeMs);
    if (this.mode === "watch" && nextTimeMs > 0) {
      // Rebuild watch state without replaying every historical judgement into
      // host UI listeners. A seek has one reset notification; it is not a burst
      // of new player input events.
      while (this.updateCursor < this.playableNotes.length) {
        const note = this.playableNotes[this.updateCursor]!;
        if (note.timeMs >= this.timeMs) break;
        const event = this.apply(note, this.automaticJudgement(note, this.historicalWatchTime(note, visualReplay), true), JudgeTiming.Auto, 0, this.timeMs, false);
        const visualLast = this.watchVisualState?.lastJudgement;
        if (visualLast?.note.id === note.id) {
          this.watchVisualState = {
            ...this.watchVisualState!,
            lastJudgement: { ...visualLast, scoreDelta: event.scoreDelta },
          };
        }
      }
    } else if (this.mode === "play" && nextTimeMs > 0) {
      // A transport seek is not a gameplay miss. Notes whose complete late
      // window is already behind the new playhead become inert without life,
      // score, combo or judgment-event side effects.
      const adjustedTime = this.timeMs + this.judgementOffsetMs;
      for (const note of this.playableNotes) {
        if (note.timeMs + maximumLateWindow(note.judgementType, this.assistLevel) >= adjustedTime) break;
        this.processed.add(note.id);
      }
      // Seeking into the middle of a long note cannot recreate its original
      // finger claim. Once its start is behind the transport position, skip
      // the remaining nodes as one inert line instead of emitting unavoidable
      // trace/end Miss events after the seek.
      const skippedLongLines = new Set<number>();
      for (const note of this.playableNotes) {
        if (this.processed.has(note.id)) {
          for (const lineId of this.longLineStartIds(note)) skippedLongLines.add(lineId);
        }
      }
      for (const note of this.playableNotes) {
        if (this.longLineIdsFor(note).some((lineId) => skippedLongLines.has(lineId))) this.processed.add(note.id);
      }
      this.advanceUpdateCursor();
    }
    const snapshot = this.snapshot();
    this.emit("reset", snapshot);
    return snapshot;
  }

  snapshot(): SessionSnapshot {
    return this.writeSnapshot({ ...this.reusableSnapshot });
  }

  private rebuildWatchVisualState(timeMs: number, replay: WatchVisualReplayContract): WatchVisualState {
    if (typeof replay.sourceKey !== "string" || !replay.sourceKey.trim() ||
        (replay.clockMode !== "fresh-reference" && replay.clockMode !== "canonical-rebuild") ||
        !Number.isFinite(replay.originSeconds) || !Number.isFinite(replay.stepSeconds) || replay.stepSeconds <= 0 ||
        !Number.isFinite(replay.inputOffsetMs) || !Array.isArray(replay.tickTimesMs)) {
      throw new TypeError("Watch visual replay requires an explicit source clock contract");
    }
    let previous = -Infinity;
    let seconds = replay.originSeconds;
    let sampledTimeMs: number | undefined;
    for (const tick of replay.tickTimesMs) {
      const nextSeconds = seconds + replay.stepSeconds;
      if (!Number.isSafeInteger(tick) || tick < previous || nextSeconds <= seconds ||
          tick !== Math.trunc(nextSeconds * 1000)) {
        throw new TypeError("Watch visual replay ticks must match the declared repeated source clock");
      }
      seconds = nextSeconds;
      previous = tick;
      if (tick <= timeMs) sampledTimeMs = tick;
    }
    if (Math.trunc((seconds + replay.stepSeconds) * 1000) <= timeMs) {
      throw new TypeError("Watch visual replay ticks do not cover the seek target");
    }
    let cursor = 0, combo = 0;
    let lastJudgement: WatchVisualState["lastJudgement"] = null;
    for (const note of this.playableNotes) {
      const eligibleAt = note.timeMs + replay.inputOffsetMs;
      while (cursor < replay.tickTimesMs.length && replay.tickTimesMs[cursor]! < eligibleAt) cursor++;
      const tick = replay.tickTimesMs[cursor];
      if (tick === undefined || tick > timeMs) break;
      combo++;
      lastJudgement = {
        note, judgement: this.automaticJudgement(note, tick, true), timing: JudgeTiming.Auto,
        diffMs: 0, judgedAtMs: tick, combo,
      };
    }
    return {
      sourceKey: replay.sourceKey, clockMode: replay.clockMode,
      sampledTimeMs, combo, fullCombo: true, perfectCombo: combo > 0, lastJudgement,
    };
  }

  private historicalWatchTime(note: ChartNote, replay?: WatchVisualReplayContract): number {
    if (replay) {
      const time = note.timeMs + replay.inputOffsetMs;
      let low = 0, high = replay.tickTimesMs.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (replay.tickTimesMs[middle]! < time) low = middle + 1;
        else high = middle;
      }
      const tick = replay.tickTimesMs[low];
      if (tick !== undefined) return tick;
    }
    return Math.floor(note.timeMs) + 1;
  }

  private automaticJudgement(note: ChartNote, observedTimeMs: number, historical = false): NoteSimulateJudgement {
    if (!this.autoJudgement) return NoteSimulateJudgement.Perfect;
    let feverState = this.presentationTimeline.feverState, feverSection = this.presentationTimeline.feverSection;
    if (historical) {
      feverState = FeverState.Wait;
      feverSection = null;
      for (const section of this.chart.timeline.fever) {
        if (section.startTimeMs > observedTimeMs) break;
        feverSection = section;
        feverState = observedTimeMs < section.endTimeMs ? FeverState.Fever : FeverState.End;
      }
    }
    return this.autoJudgement(note, { observedTimeMs, feverState, feverSection });
  }

  private writeSnapshot(target: SessionSnapshot): SessionSnapshot {
    target.timeMs = this.timeMs;
    target.durationMs = this.chart.durationMs;
    target.activeLongLine = this.hasActiveLongLine();
    target.combo = this.combo;
    target.fullCombo = this.fullCombo;
    target.allPerfect = this.allPerfect;
    target.perfectCombo = this.combo > 0 && this.allPerfect;
    target.maxCombo = this.maxCombo;
    target.score = this.score;
    target.life = this.life;
    target.processed = this.processed.size;
    target.total = this.playableNotes.length;
    target.lastJudgement = this.lastJudgement;
    target.watchVisualState = this.watchVisualState;
    target.lastSkill = this.presentationTimeline.lastSkill;
    target.callChange = this.presentationTimeline.callChange;
    target.feverState = this.presentationTimeline.feverState;
    target.feverSection = this.presentationTimeline.feverSection;
    target.noteState = this.noteState;
    target.lineState = this.lineState;
    return target;
  }

  private consume(
    lane: number,
    inputTimeMs: number,
    predicate: (note: ChartNote) => boolean,
    pointerId?: number,
    releaseInput = false,
  ): JudgementEvent | null {
    if (this.mode !== "play") return null;
    if (!Number.isFinite(lane) || lane < 0 || lane > LANE_COUNT - 1) return null;
    const judgedAtMs = integerTimeMs(inputTimeMs);
    const adjustedTime = judgedAtMs + this.judgementOffsetMs;
    const pointer = this.pointerToken(pointerId);
    let low = 0;
    let high = this.playableNotes.length;
    const earliestCandidateTime = adjustedTime - this.maximumLateMs;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.playableNotes[middle]!.timeMs < earliestCandidateTime) low = middle + 1;
      else high = middle;
    }
    let candidate: ChartNote | undefined;
    let candidateDistance = Number.POSITIVE_INFINITY;
    for (let index = low; index < this.playableNotes.length; index++) {
      const note = this.playableNotes[index]!;
      const diff = adjustedTime - note.timeMs;
      if (diff < -this.maximumEarlyMs) {
        break;
      }
      // A Press before a Trace reserves that input; its maintained state
      // judges at the target. PressExit can judge early using the event time.
      if (isTrace(note) && !releaseInput && diff < 0) continue;
      const distance = this.candidateDistance(note, diff, lane, pointer, predicate);
      if (distance < 0) continue;
      if (distance < candidateDistance) {
        candidate = note;
        candidateDistance = distance;
      }
    }
    if (!candidate) return null;

    const tracePress = isTrace(candidate) && !releaseInput;
    const diffMs = tracePress ? 0 : adjustedTime - candidate.timeMs;
    const result = judge(candidate.judgementType, diffMs, this.assistLevel);
    const startLineId = this.availableStartLine(candidate, pointer);
    // Commit ownership with the judgement before listeners can cancel,
    // reset, or supply another input. Their newer intent must stay final.
    if (!releaseInput && startLineId !== null && result.judgement !== NoteSimulateJudgement.Miss) {
      this.bindPointer(pointer, startLineId);
    }
    return this.apply(candidate, result.judgement, result.timing, diffMs, tracePress ? candidate.timeMs : judgedAtMs);
  }

  /** Capture maintained Press once for every held-note phase in this update. */
  private readyHeldPointers(): ReadonlyArray<readonly [PointerToken, ActivePointerState]> {
    const ready: Array<readonly [PointerToken, ActivePointerState]> = [];
    for (const entry of this.activePointers) {
      if (entry[1].fresh) entry[1].fresh = false;
      else ready.push(entry);
    }
    return ready;
  }

  /**
   * Trace ticks judge at their own note time while any held (non-fresh)
   * pointer stays inside the tick's extended lanes (IsJudgementTraceNote
   * accepts maintained Press in Just/After), so a stationary hold follows
   * a slide without emitting a movement event per tick.
   */
  private advanceHeldTicks(
    adjustedTimeMs: number,
    heldPointers: ReadonlyArray<readonly [PointerToken, ActivePointerState]>,
  ): void {
    for (const [pointer, state] of heldPointers) {
      // Judgement listeners can cancel input or reset the session. A captured
      // Press belongs only to the pointer state that is still active.
      if (state.fresh || this.activePointers.get(pointer) !== state) continue;
      let candidate: ChartNote | undefined;
      let candidateDistance = Number.POSITIVE_INFINITY;
      for (const note of this.playableNotes) {
        if (!isTrace(note) || this.processed.has(note.id) || this.pendingLastTiming.has(note.id)) continue;
        const diff = adjustedTimeMs - note.timeMs;
        if (diff < 0) continue;
        if (this.candidateDistance(note, diff, state.lane, pointer, isTrace) < 0) continue;
        const distance = Math.abs(diff);
        if (distance < candidateDistance) {
          candidate = note;
          candidateDistance = distance;
        }
      }
      if (!candidate) continue;

      const result = judge(candidate.judgementType, 0, this.assistLevel);
      this.apply(candidate, result.judgement, result.timing, 0, candidate.timeMs);
    }
  }

  private advanceHeldSlideEnds(
    adjustedTimeMs: number,
    heldPointers: ReadonlyArray<readonly [PointerToken, ActivePointerState]>,
  ): void {
    for (const [pointer, state] of heldPointers) {
      if (state.fresh || this.activePointers.get(pointer) !== state) continue;
      let candidate: ChartNote | undefined;
      let candidateDistance = Number.POSITIVE_INFINITY;
      for (const note of this.playableNotes) {
        if (!isRelease(note) || this.processed.has(note.id) || this.pendingLastTiming.has(note.id)) continue;
        const diff = adjustedTimeMs - note.timeMs;
        if (diff < 0) continue;
        if (this.candidateDistance(note, diff, state.lane, pointer, isRelease) < 0) continue;
        const distance = Math.abs(diff);
        if (distance < candidateDistance) {
          candidate = note;
          candidateDistance = distance;
        }
      }
      if (!candidate) continue;

      const result = judge(candidate.judgementType, 0, this.assistLevel);
      this.apply(candidate, result.judgement, result.timing, 0, candidate.timeMs);
    }
  }

  private candidateDistance(
    note: ChartNote,
    diff: number,
    lane: number,
    pointer: PointerToken,
    predicate: (note: ChartNote) => boolean,
  ): number {
    if (!Number.isFinite(lane) || lane < 0 || lane > LANE_COUNT - 1) return -1;
    if (this.processed.has(note.id) || this.pendingLastTiming.has(note.id) || !predicate(note)) return -1;
    if (
      diff < -maximumEarlyWindow(note.judgementType, this.assistLevel) ||
      diff > maximumLateWindow(note.judgementType, this.assistLevel)
    )
      return -1;
    if (
      !isTargetLane(note, lane, nativeJudgementAreaOffsetX(note.judgementAreaOffsetType, note.size, this.assistLevel))
    )
      return -1;
    // Trace and tail updaters consume the current lane input. Long-line
    // presentation ownership is separate from their judgement eligibility.
    if (!isTrace(note) && !isLineEnd(note) && !this.isAvailableToPointer(note, pointer)) return -1;
    return Math.abs(diff);
  }

  private apply(
    note: ChartNote,
    judgement: NoteSimulateJudgement,
    timing: JudgeTiming,
    diffMs: number,
    judgedAtMs = note.timeMs + diffMs,
    notify = true,
  ): JudgementEvent {
    this.requireScoringMode();
    if (this.scoringComboPolicy === "strict-prior-note-time" && note.timeMs !== this.scoringGroupTime) {
      this.scoringGroupTime = note.timeMs;
      this.scoringGroupCombo = this.combo;
    }
    const previousScore = this.score;
    this.pendingLastTiming.delete(note.id);
    this.processed.add(note.id);
    this.advanceUpdateCursor();
    if (isLineEnd(note)) this.unbindEndingLines(note);
    if (incrementsCombo(judgement)) {
      this.allPerfect =
        this.allPerfect && (judgement === NoteSimulateJudgement.Perfect || judgement === NoteSimulateJudgement.Just);
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    } else if (breaksCombo(judgement)) {
      this.combo = 0;
      this.allPerfect = false;
      this.fullCombo = false;
    }
    this.life = Math.max(0, this.life - lifeDamage(judgement));
    this.contributionSum += contribution(judgement, note.operateType, this.scoringComboPolicy === "strict-prior-note-time" ? this.scoringGroupCombo : this.combo);
    const score = normalizeScore(this.contributionSum, this.ceiling, this.life);
    this.score = score;
    const event: JudgementEvent = {
      note,
      judgement,
      timing,
      diffMs,
      judgedAtMs,
      combo: this.combo,
      maxCombo: this.maxCombo,
      score,
      scoreDelta: Math.max(0, score - previousScore),
      life: this.life,
    };
    this.lastJudgement = event;
    if (notify) this.watchVisualState = undefined;
    if (notify) this.emit("judgement", event);
    return event;
  }

  private pointerToken(pointerId: number | undefined): PointerToken {
    return pointerId ?? DEFAULT_POINTER;
  }

  private rememberPointer(pointer: PointerToken, lane: number, pressed = false): void {
    // Leaving the accepted lane margin is still a held pointer. Remember its
    // current position; candidateDistance rejects it until it re-enters.
    const state = this.activePointers.get(pointer);
    if (state) {
      state.lane = lane;
      state.fresh ||= pressed;
    } else if (this.activePointers.size < MAX_ACTIVE_POINTERS) {
      this.activePointers.set(pointer, { lane, fresh: true });
    }
  }

  private advanceUpdateCursor(): void {
    while (
      this.updateCursor < this.playableNotes.length &&
      this.processed.has(this.playableNotes[this.updateCursor]!.id)
    ) {
      this.updateCursor++;
    }
  }

  /**
   * Advances compatibility events without allocating on rAF. Fever handling
   * emits at most one transition per section and update, so a frame that jumps
   * over both bounds emits Fever now and End on the following update.
   */
  private advanceTimeline(): void {
    this.presentationTimeline.advance(this.timeMs);
  }

  private longLineIdsFor(note: ChartNote): readonly number[] {
    return this.longLineIdsByNoteId.get(note.id) ?? EMPTY_LINE_IDS;
  }

  private longLineStartIds(note: ChartNote): readonly number[] {
    return this.longLineStartIdsByNoteId.get(note.id) ?? EMPTY_LINE_IDS;
  }

  private longLineEndIds(note: ChartNote): readonly number[] {
    return this.longLineEndIdsByNoteId.get(note.id) ?? EMPTY_LINE_IDS;
  }

  private isLongLineActive(lineId: number): boolean {
    if (this.mode !== "watch" && this.mode !== "play") return false;
    const span = this.longLineSpanById.get(lineId);
    return Boolean(
      span &&
      span.startTimeMs <= this.timeMs &&
      this.timeMs < span.endTimeMs &&
      (this.mode === "watch" || this.linePointers.has(lineId)),
    );
  }

  /** LiveSoundPlayer.UpdateLongLineSe. */
  private hasActiveLongLine(): boolean {
    if (this.mode === "watch") {
      // Spans are merged once, so the rightmost start <= time is sufficient.
      let low = 0;
      let high = this.watchLongLineSpans.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.watchLongLineSpans[middle]!.startTimeMs <= this.timeMs) low = middle + 1;
        else high = middle;
      }
      const span = this.watchLongLineSpans[low - 1];
      return Boolean(span && this.timeMs < span.endTimeMs);
    }
    if (this.mode === "play") {
      // At most four native pointers can own a line, independent of chart size.
      for (const lineId of this.linePointers.keys()) {
        const span = this.longLineSpanById.get(lineId);
        if (span && span.startTimeMs <= this.timeMs && this.timeMs < span.endTimeMs) return true;
      }
    }
    return false;
  }

  private isAvailableToPointer(note: ChartNote, pointer: PointerToken): boolean {
    const lineIds = this.longLineIdsFor(note);
    if (lineIds.length === 0) return true;
    if (this.longLineStartIds(note).length > 0) return this.availableStartLine(note, pointer) !== null;
    const lineId = this.pointerLines.get(pointer);
    return lineId !== undefined && lineIds.includes(lineId) && this.linePointers.get(lineId) === pointer;
  }

  private availableStartLine(note: ChartNote, pointer: PointerToken): number | null {
    const startIds = this.longLineStartIds(note);
    const currentLine = this.pointerLines.get(pointer);
    if (currentLine !== undefined && startIds.includes(currentLine) && this.linePointers.get(currentLine) === pointer) {
      return currentLine;
    }
    for (const lineId of startIds) {
      const currentPointer = this.linePointers.get(lineId);
      if (currentLine === undefined && (currentPointer === undefined || currentPointer === pointer)) return lineId;
    }
    return null;
  }

  private unbindEndingLines(note: ChartNote): void {
    for (const lineId of this.longLineEndIds(note)) this.unbindLine(lineId);
  }

  private bindPointer(pointer: PointerToken, lineId: number): void {
    this.unbindPointer(pointer);
    this.unbindLine(lineId);
    this.pointerLines.set(pointer, lineId);
    this.linePointers.set(lineId, pointer);
  }

  private unbindPointer(pointer: PointerToken): void {
    const lineId = this.pointerLines.get(pointer);
    if (lineId === undefined) return;
    this.pointerLines.delete(pointer);
    if (this.linePointers.get(lineId) === pointer) this.linePointers.delete(lineId);
  }

  private unbindLine(lineId: number): void {
    const pointer = this.linePointers.get(lineId);
    if (pointer === undefined) return;
    this.linePointers.delete(lineId);
    if (this.pointerLines.get(pointer) === lineId) this.pointerLines.delete(pointer);
  }

  private emit<K extends keyof ChartSessionEventMap>(type: K, event: ChartSessionEventMap[K]): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) listener(event as never);
  }
}
