import { NoteOperateType, NoteJudgementType, type ChartMode } from "./enums.js";
import {
  DEFAULT_ASSIST_LEVEL,
  requireAssistLevel,
  type AssistLevel,
} from "./assist.js";
import { automaticPolicyWire } from "./automatic.js";
import { SessionTimeline } from "./SessionTimeline.js";
import {
  inspectWatchReplay,
  watchReplayObservation,
} from "./WatchReplayClock.js";
import type {
  SessionOptions,
  ChartSessionEventMap,
  InputVector,
} from "./session.js";
import type {
  ChartDocument,
  ChartNote,
  JudgementEvent,
  SessionSnapshot,
  WatchVisualReplayContract,
  WatchVisualState,
} from "./types.js";
import type { CassiopeiaSessionPort } from "../plugin.js";

export interface WasmWatchRuntime {
  free(): void;
  update(time: bigint): number;
  finish(time: bigint): number;
  reset_observed_json(time: bigint, observations: string): number;
  project_watch_observed_json(time: bigint, observations: string): number;
  set_judgement_offset(time: bigint): void;
  event_buffer_ptr(): number;
  event_buffer_len(): number;
  event_count(): number;
  event_stride(): number;
  snapshot_buffer_ptr(): number;
  snapshot_buffer_len(): number;
}
export interface WasmWatchBindings {
  readonly CassiopeiaRuntime: {
    fromWatchNotes(json: string): WasmWatchRuntime;
  };
  cassiopeiaMemory(): WebAssembly.Memory;
}
const integerMs = (value: number) =>
  Number.isFinite(value) ? Math.floor(value) : 0;
const micros = (milliseconds: number) => {
  const value = milliseconds * 1000;
  if (!Number.isSafeInteger(value))
    throw new RangeError("Observation exceeds integer microsecond range");
  return BigInt(value);
};
const name = (names: Record<number, string>, value: number) => {
  const text = names[value];
  if (!text) throw new TypeError(`Unknown source enum: ${value}`);
  return text[0]!.toLowerCase() + text.slice(1);
};

/** One Rust gameplay owner. TypeScript projects only source geometry and timeline metadata. */
export class WasmWatchSession implements CassiopeiaSessionPort {
  readonly backend = "rust-wasm" as const;
  mode: ChartMode = "watch";
  readonly assistLevel: AssistLevel;
  private readonly rust: WasmWatchRuntime;
  private readonly notes: readonly ChartNote[];
  private readonly byId: ReadonlyMap<number, ChartNote>;
  private readonly processed = new Set<number>();
  private readonly observed = new Map<number, number>();
  private readonly history = new Map<number, JudgementEvent>();
  private readonly listeners = new Map<
    keyof ChartSessionEventMap,
    Set<(event: never) => void>
  >();
  private readonly timeline: SessionTimeline;
  private readonly spans = new Map<number, { start: number; end: number }>();
  private readonly mergedSpans: Array<{ start: number; end: number }> = [];
  private snapshotView?: BigInt64Array;
  private readonly noteState = Object.freeze({
    isProcessed: (id: number) => this.processed.has(id),
  });
  private readonly lineState = Object.freeze({
    isActive: (id: number) => {
      const span = this.spans.get(id);
      return Boolean(
        span && span.start <= this.timeMs && this.timeMs < span.end,
      );
    },
  });
  private timeMs = 0;
  private lastJudgement: JudgementEvent | null = null;
  private watchVisualState: WatchVisualState | undefined;
  private disposed = false;
  private generation = 0;
  private readonly snapshotWords = new Float64Array(16);
  private readonly reusable: SessionSnapshot;

  constructor(
    readonly chart: ChartDocument,
    private readonly bindings: WasmWatchBindings,
    options: SessionOptions = {},
  ) {
    if ((options.mode ?? "watch") !== "watch")
      throw new RangeError(
        "WASM Watch session does not support Play or Chart mode",
      );
    if (options.autoJudgement)
      throw new TypeError(
        "WASM Watch requires serializable automaticPolicy; callbacks are unsupported",
      );
    this.assistLevel = requireAssistLevel(
      options.assistLevel ?? DEFAULT_ASSIST_LEVEL,
    );
    this.notes = chart.notes.filter((note) => note.judged);
    this.byId = new Map(this.notes.map((note) => [note.id, note]));
    this.rust = bindings.CassiopeiaRuntime.fromWatchNotes(
      JSON.stringify({
        mode: "watch",
        assistLevel: this.assistLevel,
        offsetMicros: integerMs(options.judgementOffsetMs ?? 0) * 1000,
        scoringComboPolicy: options.scoringComboPolicy ?? "sequential",
        automaticPolicy: automaticPolicyWire(options.automaticPolicy),
        notes: this.notes.map((note) => ({
          id: String(note.id),
          time: Math.floor(note.timeMs) * 1000,
          operateType: name(NoteOperateType, note.operateType),
          judgementType: name(NoteJudgementType, note.judgementType),
        })),
      }),
    );
    if (
      this.rust.snapshot_buffer_len() !== 16 ||
      this.rust.event_stride() !== 12
    ) {
      this.rust.free();
      throw new Error("Unsupported Cassiopeia fixed observation ABI");
    }
    this.timeline = new SessionTimeline(chart.timeline, {
      skill: (event) => this.emit("skill", event),
      fever: (event) => this.emit("fever", event),
      callChange: (event) => this.emit("callChange", event),
    });
    const allNotes = new Map(chart.notes.map((note) => [note.id, note]));
    for (const line of chart.lines)
      if (line.kind === "long") {
        const times = line.noteIds.flatMap((id) => {
          const note = allNotes.get(id);
          return note ? [note.timeMs] : [];
        });
        if (times.length)
          this.spans.set(line.id, {
            start: Math.min(...times),
            end: Math.max(...times),
          });
      }
    for (const span of [...this.spans.values()].sort(
      (a, b) => a.start - b.start || a.end - b.end,
    )) {
      const previous = this.mergedSpans.at(-1);
      if (previous && span.start <= previous.end)
        previous.end = Math.max(previous.end, span.end);
      else this.mergedSpans.push({ ...span });
    }
    this.copySnapshot();
    this.reusable = this.writeSnapshot({} as SessionSnapshot);
  }
  private assertLive(): void {
    if (this.disposed) throw new Error("Cassiopeia session is disposed");
    if (this.mode !== "watch")
      throw new RangeError("WASM session supports Watch only");
  }
  on<K extends keyof ChartSessionEventMap>(
    kind: K,
    listener: (event: ChartSessionEventMap[K]) => void,
  ): () => void {
    this.assertLive();
    const set = this.listeners.get(kind) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(kind, set);
    return () => set.delete(listener as (event: never) => void);
  }
  private emit<K extends keyof ChartSessionEventMap>(
    kind: K,
    event: ChartSessionEventMap[K],
  ) {
    for (const listener of this.listeners.get(kind) ?? [])
      listener(event as never);
  }
  private copySnapshot() {
    const buffer = this.bindings.cassiopeiaMemory().buffer,
      pointer = this.rust.snapshot_buffer_ptr();
    if (
      this.snapshotView?.buffer !== buffer ||
      this.snapshotView.byteOffset !== pointer
    )
      this.snapshotView = new BigInt64Array(buffer, pointer, 16);
    for (let i = 0; i < 16; i++)
      this.snapshotWords[i] = Number(this.snapshotView[i]);
  }
  private readEvents(): JudgementEvent[] {
    const words = new BigInt64Array(
      this.bindings.cassiopeiaMemory().buffer,
      this.rust.event_buffer_ptr(),
      this.rust.event_buffer_len(),
    );
    const events: JudgementEvent[] = [];
    for (let i = 0; i < this.rust.event_count(); i++) {
      const at = i * 12,
        note = this.byId.get(Number(words[at]));
      if (!note) throw new Error(`Unknown Rust event ID: ${words[at]}`);
      events.push({
        note,
        judgement: Number(words[at + 1]),
        timing: Number(words[at + 2]),
        diffMs: Number(words[at + 3]) / 1000,
        judgedAtMs: Number(words[at + 4]) / 1000,
        combo: Number(words[at + 6]),
        maxCombo: Number(words[at + 7]),
        score: Number(words[at + 8]),
        scoreDelta: Number(words[at + 9]),
        life: Number(words[at + 10]),
      });
    }
    return events;
  }
  private consume(notify: boolean): void {
    if (this.rust.event_count() === 0) {
      this.copySnapshot();
      return;
    }
    const epoch = this.generation,
      events = this.readEvents();
    this.copySnapshot();
    if (notify && events.length) this.watchVisualState = undefined;
    for (const event of events) {
      this.processed.add(event.note.id);
      this.lastJudgement = event;
      this.history.set(event.note.id, event);
      if (notify) {
        this.observed.set(event.note.id, event.judgedAtMs);
        this.emit("judgement", event);
        if (this.disposed || epoch !== this.generation) return;
      }
    }
  }
  update(timeMs: number): SessionSnapshot {
    this.updateReusable(timeMs);
    return this.snapshot();
  }
  updateReusable(timeMs: number): SessionSnapshot {
    this.assertLive();
    const time = integerMs(timeMs);
    if (time + 5 < this.timeMs) this.reset(time);
    if (
      time > this.timeMs &&
      this.watchVisualState?.sampledTimeMs !== undefined
    )
      this.watchVisualState = {
        ...this.watchVisualState,
        sampledTimeMs: undefined,
      };
    const epoch = this.generation;
    this.timeMs = time;
    this.timeline.advance(time);
    if (this.disposed || epoch !== this.generation) return this.reusable;
    this.rust.update(micros(time));
    this.consume(true);
    if (this.disposed) return this.reusable;
    this.writeSnapshot(this.reusable);
    this.emit("update", this.reusable);
    return this.reusable;
  }
  finish(timeMs = this.chart.durationMs): SessionSnapshot {
    this.assertLive();
    const epoch = this.generation;
    this.timeMs = Math.max(this.timeMs, integerMs(timeMs) + 1);
    this.timeline.advance(this.timeMs);
    if (this.disposed || epoch !== this.generation) return this.reusable;
    this.rust.finish(micros(integerMs(timeMs)));
    this.consume(true);
    if (this.disposed || epoch !== this.generation) return this.reusable;
    this.timeMs = this.snapshotWords[3]! / 1000;
    const snapshot = this.snapshot();
    this.emit("update", snapshot);
    return snapshot;
  }
  reset(timeMs = 0, replay?: WatchVisualReplayContract): SessionSnapshot {
    this.assertLive();
    ++this.generation;
    const target = integerMs(timeMs);
    const business: Record<string, number> = {},
      visual: Record<string, number> = {};
    for (const note of this.notes) {
      const old = this.observed.get(note.id);
      const replayed = replay
        ? watchReplayObservation(note.timeMs, replay, true)
        : undefined;
      const observed = old !== undefined && old <= target ? old : replayed;
      if (
        observed !== undefined &&
        observed > note.timeMs &&
        observed <= target
      )
        business[note.id] = observed * 1000;
      if (replay) {
        const tick = watchReplayObservation(note.timeMs, replay, false);
        if (tick !== undefined && tick <= target) visual[note.id] = tick * 1000;
      }
    }
    let projected: WatchVisualState | undefined;
    if (replay) {
      const { sampledTimeMs } = inspectWatchReplay(target, replay);
      this.rust.project_watch_observed_json(
        micros(target),
        JSON.stringify(visual),
      );
      const events = this.readEvents(),
        words = Array.from(
          new BigInt64Array(
            this.bindings.cassiopeiaMemory().buffer,
            this.rust.snapshot_buffer_ptr(),
            16,
          ),
          Number,
        );
      const last = events.at(-1);
      projected = {
        sourceKey: replay.sourceKey,
        clockMode: replay.clockMode,
        sampledTimeMs,
        combo: words[5]!,
        fullCombo: Boolean(words[8]),
        perfectCombo: Boolean(words[6]),
        lastJudgement: last
          ? {
              note: last.note,
              judgement: last.judgement,
              timing: last.timing,
              diffMs: last.diffMs,
              judgedAtMs: last.judgedAtMs,
              combo: last.combo,
            }
          : null,
      };
    }
    this.rust.reset_observed_json(micros(target), JSON.stringify(business));
    this.processed.clear();
    this.history.clear();
    this.lastJudgement = null;
    this.consume(false);
    if (projected?.lastJudgement) {
      const businessEvent = this.history.get(projected.lastJudgement.note.id);
      if (businessEvent)
        projected = {
          ...projected,
          lastJudgement: {
            ...projected.lastJudgement,
            scoreDelta: businessEvent.scoreDelta,
          },
        };
    }
    this.timeMs = target;
    this.timeline.reset(target);
    this.watchVisualState = projected;
    for (const [id, observed] of this.observed)
      if (observed > target) this.observed.delete(id);
    const snapshot = this.snapshot();
    this.emit("reset", snapshot);
    return snapshot;
  }
  getWatchHistory(): readonly JudgementEvent[] {
    this.assertLive();
    return [...this.history.values()];
  }
  snapshot(): SessionSnapshot {
    this.assertLive();
    return this.writeSnapshot({} as SessionSnapshot);
  }
  private writeSnapshot(target: SessionSnapshot): SessionSnapshot {
    const w = this.snapshotWords;
    return Object.assign(target, {
      timeMs: this.timeMs,
      durationMs: this.chart.durationMs,
      activeLongLine: this.hasActiveLongLine(),
      combo: w[5],
      fullCombo: Boolean(w[8]),
      allPerfect: Boolean(w[7]),
      perfectCombo: Boolean(w[6]),
      maxCombo: w[9],
      score: w[10],
      life: w[11],
      processed: w[12],
      total: w[13],
      lastJudgement: this.lastJudgement,
      watchVisualState: this.watchVisualState,
      lastSkill: this.timeline.lastSkill,
      callChange: this.timeline.callChange,
      feverState: this.timeline.feverState,
      feverSection: this.timeline.feverSection,
      noteState: this.noteState,
      lineState: this.lineState,
    });
  }
  private hasActiveLongLine(): boolean {
    let low = 0,
      high = this.mergedSpans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.mergedSpans[middle]!.start <= this.timeMs) low = middle + 1;
      else high = middle;
    }
    const span = this.mergedSpans[low - 1];
    return Boolean(span && this.timeMs < span.end);
  }
  setOffset(value: number): void {
    this.assertLive();
    this.rust.set_judgement_offset(micros(integerMs(value)));
    this.copySnapshot();
  }
  setMode(mode: ChartMode): void {
    this.assertLive();
    if (mode !== "watch")
      throw new RangeError("WASM Watch session cannot switch mode");
  }
  private unsupported(): never {
    throw new RangeError(
      "WASM Watch session does not implement interactive Play",
    );
  }
  tap(
    _lane: number,
    _timeMs?: number,
    _pointerId?: number,
  ): JudgementEvent | null {
    return this.unsupported();
  }
  release(
    _lane: number,
    _timeMs?: number,
    _pointerId?: number,
  ): JudgementEvent | null {
    return this.unsupported();
  }
  flick(
    _lane: number,
    _vector: InputVector,
    _timeMs?: number,
    _pointerId?: number,
  ): JudgementEvent | null {
    return this.unsupported();
  }
  trace(
    _lane: number,
    _timeMs?: number,
    _pointerId?: number,
  ): JudgementEvent | null {
    return this.unsupported();
  }
  hasInputCandidate(
    _lane: number,
    _timeMs?: number,
    _pointerId?: number,
  ): boolean {
    return this.unsupported();
  }
  cancel(_pointerId?: number): void {
    this.unsupported();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    this.listeners.clear();
    this.rust.free();
  }
}

export function createWasmWatchSessionFactory(bindings: WasmWatchBindings) {
  return (
    chart: ChartDocument,
    options?: SessionOptions,
  ): CassiopeiaSessionPort => new WasmWatchSession(chart, bindings, options);
}
