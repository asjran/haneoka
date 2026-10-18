import {
  JudgementAreaOffsetType,
  NoteDirection,
  NoteJudgementType,
  NoteLineEaseType,
  NoteOperateType,
} from "@haneoka/cassiopeia";
import { applyLineEase, laneToX, sizeToWidth } from "@haneoka/cassiopeia";
import { PPQ, TickConverter, type BarPosition } from "@haneoka/cassiopeia";
import { buildChartTimeline } from "./timeline.js";
import type { ChartDocument, ChartLine, ChartNote, SsRawNote, SsRoot } from "@haneoka/cassiopeia";

type Shape = Pick<ChartNote, "pos" | "size">;
type CoincidenceType = "tap" | "flick" | "trace";

/** Synchronous source bindings; treat raw input references as read-only. */
export interface ChartBuildSourceObserver {
  /** Every authored alias of a resolved note, including consumed guide singles. Generated Combo nodes are excluded. */
  onSourceNote?(raw: SsRawNote, nativeId: number): void;
  /** The original long/guide header and its created native line ID. */
  onSourceLine?(raw: SsRawNote, lineId: number): void;
}
// These documents cross a Worker boundary and are rendered by multiple
// canvas/UI layers. Keep a generous ceiling well above real live charts so an
// untrusted score cannot turn a successful worker parse into a giant main
// thread structured-clone and render workload.
const MAX_RENDERABLE_NOTES = 25_000;
const MAX_GENERATED_COMBO_NOTES = 20_000;
interface CoincidenceNote {
  raw: SsRawNote;
  type: CoincidenceType;
  direction: NoteDirection;
  critical: boolean;
  visible: boolean;
}

function mapEase(raw: string | undefined): NoteLineEaseType {
  // Score "in" and "out" names are inverted by the Unity runtime enum mapping.
  if (raw === "in") return NoteLineEaseType.EaseOut;
  if (raw === "out") return NoteLineEaseType.EaseIn;
  return NoteLineEaseType.Linear;
}

function mapDirection(note: SsRawNote): NoteDirection {
  if (note.type !== "flick") return NoteDirection.Normal;
  return note.dir === "left" ? NoteDirection.Left : note.dir === "right" ? NoteDirection.Right : NoteDirection.Normal;
}

function rawEasePair(raw: SsRawNote["ease"] | undefined): [string | undefined, string | undefined] {
  return Array.isArray(raw) ? [raw[0], raw[1]] : [raw, raw];
}

function easePair(note: SsRawNote, fallback: SsRawNote["ease"]): [NoteLineEaseType, NoteLineEaseType] {
  const [left, right] = rawEasePair(note.ease ?? fallback);
  return [mapEase(left), mapEase(right)];
}

function interpolateAutomaticNodes(nodes: SsRawNote[], fallback: SsRawNote["ease"]): Shape[] {
  const shapes = nodes.map((node) =>
    typeof node.pos === "number" ? { pos: node.pos, size: node.size ?? 6 } : { pos: NaN, size: NaN },
  );
  for (let index = 0; index < nodes.length; index++) {
    if (typeof nodes[index]?.pos === "number") continue;
    let previous = index - 1;
    let next = index + 1;
    while (previous >= 0 && typeof nodes[previous]?.pos !== "number") previous--;
    while (next < nodes.length && typeof nodes[next]?.pos !== "number") next++;
    if (previous < 0 && next >= nodes.length) {
      shapes[index] = { pos: 0, size: nodes[index]?.size ?? 6 };
      continue;
    }
    if (previous < 0) {
      shapes[index] = { pos: shapes[next]!.pos, size: nodes[index]?.size ?? shapes[next]!.size };
      continue;
    }
    if (next >= nodes.length) {
      shapes[index] = { pos: shapes[previous]!.pos, size: nodes[index]?.size ?? shapes[previous]!.size };
      continue;
    }
    const head = shapes[previous]!;
    const tail = shapes[next]!;
    const headTick = nodes[previous]?.t ?? nodes[index]?.t ?? 0;
    const tailTick = nodes[next]?.t ?? nodes[index]?.t ?? 0;
    const progress = tailTick === headTick ? 0 : ((nodes[index]?.t ?? 0) - headTick) / (tailTick - headTick);
    const [leftEase, rightEase] = easePair(nodes[previous]!, fallback);
    const pos = head.pos + (tail.pos - head.pos) * applyLineEase(leftEase, progress);
    const headRight = head.pos + head.size;
    const tailRight = tail.pos + tail.size;
    const right = headRight + (tailRight - headRight) * applyLineEase(rightEase, progress);
    shapes[index] = { pos, size: right - pos };
  }
  return shapes;
}

function buildGuideCoincidence(notes: SsRawNote[]): {
  types: Map<string, CoincidenceNote>;
  consumedSingles: Set<SsRawNote>;
} {
  // BuildNoteInfoList first records every concrete guide-start overlap key. It
  // then walks standalone Tap/Flick/Trace notes in source order, consumes the
  // first match for each key, and passes that note to
  // ResolveGuideNodeOperateType. The consumed standalone is not emitted as a
  // second playable note.
  const guideStartKeys = new Set<string>();
  for (const note of notes) {
    if (note.type !== "guide") continue;
    const first = note.node?.[0];
    if (!first || typeof first.t !== "number" || typeof first.pos !== "number") continue;
    guideStartKeys.add(nativeOverlapKey(first.t, first.pos, first.size ?? 6));
  }

  const coincidence = new Map<string, CoincidenceNote>();
  const consumedSingles = new Set<SsRawNote>();
  for (const note of notes) {
    if (note.type === "long" || note.type === "guide" || typeof note.t !== "number" || typeof note.pos !== "number")
      continue;
    const key = nativeOverlapKey(note.t, note.pos, note.size ?? 6);
    if (!guideStartKeys.has(key) || coincidence.has(key)) continue;
    coincidence.set(key, {
      raw: note,
      type: note.type === "flick" ? "flick" : note.type === "trace" ? "trace" : "tap",
      direction: mapDirection(note),
      critical: note.crit === true,
      visible: note.visible !== false,
    });
    consumedSingles.add(note);
  }
  return { types: coincidence, consumedSingles };
}

function resolveLineOperation(
  note: SsRawNote,
  index: number,
  count: number,
  kind: "long" | "guide",
  coincidence: Map<string, CoincidenceNote>,
): NoteOperateType {
  const begin = index === 0;
  const end = index === count - 1;
  const visible = note.visible !== false;
  const automatic = note.pos === "auto";
  const subtype = note.type === "flick" ? "flick" : note.type === "trace" ? "trace" : "tap";
  if (kind === "long") {
    if (begin) {
      if (!visible) return NoteOperateType.HiddenSlideBegin;
      return subtype === "flick"
        ? NoteOperateType.SlideBeginFlick
        : subtype === "trace"
          ? NoteOperateType.SlideBeginTrace
          : NoteOperateType.SlideBegin;
    }
    if (end) {
      if (!visible) return NoteOperateType.HiddenSlideEnd;
      return subtype === "flick"
        ? NoteOperateType.SlideEndFlick
        : subtype === "trace"
          ? NoteOperateType.SlideEndTrace
          : NoteOperateType.SlideEnd;
    }
    if (automatic) return NoteOperateType.SlideConnection;
    if (!visible) return NoteOperateType.Hidden;
    return subtype === "trace" ? NoteOperateType.SlideConnectionTrace : NoteOperateType.SlideConnection;
  }
  if (begin) {
    const key =
      typeof note.t === "number" && typeof note.pos === "number"
        ? nativeOverlapKey(note.t, note.pos, note.size ?? 6)
        : "";
    const coincident = coincidence.get(key)?.type;
    if (coincident === "tap") return NoteOperateType.GuideBeginNormal;
    if (coincident === "flick") return NoteOperateType.GuideBeginFlick;
    if (coincident === "trace") return NoteOperateType.GuideBeginTrace;
    return NoteOperateType.GuideBegin;
  }
  if (end) return visible && subtype === "trace" ? NoteOperateType.GuideEndTrace : NoteOperateType.GuideEnd;
  return visible || automatic ? NoteOperateType.SlideConnectionTrace : NoteOperateType.Hidden;
}

function resolveJudgementType(operation: NoteOperateType, critical: boolean): NoteJudgementType {
  if (critical && operation === NoteOperateType.Normal) return NoteJudgementType.EasyNormal;
  if (critical && operation === NoteOperateType.SlideBegin) return NoteJudgementType.SlideBeginEasy;
  const map: Partial<Record<NoteOperateType, NoteJudgementType>> = {
    [NoteOperateType.Normal]: NoteJudgementType.Normal,
    [NoteOperateType.SlideBegin]: NoteJudgementType.SlideBegin,
    [NoteOperateType.SlideConnection]: NoteJudgementType.Trace,
    [NoteOperateType.SlideEnd]: NoteJudgementType.SlideEnd,
    [NoteOperateType.Flick]: NoteJudgementType.Flick,
    [NoteOperateType.SlideBeginFlick]: NoteJudgementType.Flick,
    [NoteOperateType.SlideEndFlick]: NoteJudgementType.Flick,
    [NoteOperateType.Trace]: NoteJudgementType.Trace,
    [NoteOperateType.SlideBeginTrace]: NoteJudgementType.Trace,
    [NoteOperateType.SlideEndTrace]: NoteJudgementType.SlideEndTrace,
    [NoteOperateType.SlideConnectionTrace]: NoteJudgementType.Trace,
    [NoteOperateType.Combo]: NoteJudgementType.Trace,
    [NoteOperateType.GuideBeginNormal]: NoteJudgementType.Normal,
    [NoteOperateType.GuideBeginFlick]: NoteJudgementType.Flick,
    [NoteOperateType.GuideBeginTrace]: NoteJudgementType.Trace,
    [NoteOperateType.GuideEndTrace]: NoteJudgementType.Trace,
  };
  return map[operation] ?? NoteJudgementType.None;
}

/** MusicScoreNoteCreator's per-operation JudgementAreaOffsetType constructor argument. */
export function resolveJudgementAreaOffsetType(operation: NoteOperateType, critical: boolean): JudgementAreaOffsetType {
  switch (operation) {
    case NoteOperateType.Normal:
      return critical ? JudgementAreaOffsetType.EasyDefault : JudgementAreaOffsetType.Default;
    case NoteOperateType.SlideBegin:
      return critical ? JudgementAreaOffsetType.EasySlideBegin : JudgementAreaOffsetType.SlideBegin;
    case NoteOperateType.SlideConnection:
    case NoteOperateType.Combo:
    case NoteOperateType.ComboSkip:
      return JudgementAreaOffsetType.Slide;
    case NoteOperateType.SlideEnd:
      return JudgementAreaOffsetType.SlideEnd;
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
      return JudgementAreaOffsetType.Flick;
    case NoteOperateType.Trace:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.SlideConnectionTrace:
    case NoteOperateType.HiddenSlideBegin:
    case NoteOperateType.HiddenSlideEnd:
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.GuideEndTrace:
      return JudgementAreaOffsetType.Trace;
    case NoteOperateType.GuideBeginFlick:
      // GuideBeginFlick aliases GuideBeginNote's ctor, which passes Default to
      // NoteBase even though the note itself uses flick judgement timing.
      return JudgementAreaOffsetType.Default;
    case NoteOperateType.None:
    case NoteOperateType.GuideBegin:
    case NoteOperateType.GuideBeginNormal:
    case NoteOperateType.GuideEnd:
    case NoteOperateType.Hidden:
    case NoteOperateType.InvalidHidden:
    default:
      return JudgementAreaOffsetType.Default;
  }
}

function isJudged(type: NoteOperateType): boolean {
  // NoteOperateTypeUtility.IsJudgementNote is operation-only: every operation
  // is judged except this explicit native exclusion set.
  return (
    type !== NoteOperateType.None &&
    type !== NoteOperateType.HiddenSlideBegin &&
    type !== NoteOperateType.HiddenSlideEnd &&
    type !== NoteOperateType.GuideBegin &&
    type !== NoteOperateType.GuideEnd &&
    type !== NoteOperateType.ComboSkip &&
    type !== NoteOperateType.Hidden &&
    type !== NoteOperateType.InvalidHidden
  );
}

function roundToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** SsMusicScoreConverter.MakeOverlapKey. */
function nativeOverlapKey(tick: number, pos: number, size: number): string {
  return `${tick}:${roundToEven(pos)}:${roundToEven(size)}`;
}

/** SsMusicScoreConverter.IsMergeableSlideEndpoint. */
function isMergeableEndpoint(operation: NoteOperateType): boolean {
  return (
    operation === NoteOperateType.SlideBegin ||
    operation === NoteOperateType.SlideEnd ||
    operation === NoteOperateType.SlideBeginFlick ||
    operation === NoteOperateType.SlideEndFlick ||
    operation === NoteOperateType.SlideBeginTrace ||
    operation === NoteOperateType.SlideEndTrace ||
    operation === NoteOperateType.HiddenSlideBegin ||
    operation === NoteOperateType.HiddenSlideEnd ||
    (operation >= NoteOperateType.GuideBegin && operation <= NoteOperateType.GuideEndTrace)
  );
}

function endpointMergeKey(
  tick: number,
  shape: Shape,
  operation: NoteOperateType,
  critical: boolean,
  direction: NoteDirection,
  easeL: NoteLineEaseType,
  easeR: NoteLineEaseType,
): string {
  return `${nativeOverlapKey(tick, shape.pos, shape.size)}:${operation}:${roundToEven(shape.size)}:${Number(critical)}:${direction}:${easeL}:${easeR}`;
}

function sameBarPosition(a: BarPosition, b: BarPosition): boolean {
  // IsSamePosition delegates BarProgress to UnityEngine.Mathf.Approximately.
  // Both operands are float-backed fields.
  if (a.bar !== b.bar) return false;
  const left = Math.fround(a.progress);
  const right = Math.fround(b.progress);
  const tolerance = Math.max(Math.fround(1e-6) * Math.max(Math.abs(left), Math.abs(right)), 1e-45 * 8);
  return Math.abs(left - right) < tolerance;
}

function interpolateAuthoredLine(notes: ChartNote[], timeMs: number): Shape {
  let head = notes[0]!;
  let tail = notes[notes.length - 1]!;
  for (let index = 1; index < notes.length; index++) {
    if (notes[index]!.timeMs < timeMs) continue;
    head = notes[index - 1] ?? notes[index]!;
    tail = notes[index]!;
    break;
  }
  const span = tail.timeMs - head.timeMs;
  const progress = span <= 0 ? 0 : Math.max(0, Math.min(1, (timeMs - head.timeMs) / span));
  const pos = head.pos + (tail.pos - head.pos) * applyLineEase(head.easeL, progress);
  const right =
    head.pos + head.size + (tail.pos + tail.size - head.pos - head.size) * applyLineEase(head.easeR, progress);
  return { pos, size: right - pos };
}

/** MusicScoreNoteCreator's bar-based authored and automatic Combo clock. */
function createNativePositionTiming(root: SsRoot, converter: TickConverter) {
  const signatures = [...root.sig]
    .sort((left, right) => left.t - right.t)
    .map((point) => ({
      ...converter.tickToBarPosition(point.t),
      timeMs: converter.tickToTimeMs(point.t),
      beats: Math.fround(Math.fround(point.sig[0] * 4) / point.sig[1]),
    }));
  const bpmPoints = [...root.bpm].sort((left, right) => left.t - right.t);
  // Match the authored TickConverter's implicit initial BPM event.
  if (!bpmPoints.length || bpmPoints[0]!.t > 0) bpmPoints.unshift({ t: 0, bpm: 120 });
  const bpms = bpmPoints.map((point) => ({
    ...converter.tickToBarPosition(point.t),
    timeMs: converter.tickToTimeMs(point.t),
    bpm: Math.fround(point.bpm),
  }));
  return {
    beatsAtBar(bar: number): number {
      let beats = 4;
      for (const point of signatures) {
        if (point.bar > bar) break;
        beats = point.beats;
      }
      return beats;
    },
    timeAtPosition(position: BarPosition): number {
      let beats = 4;
      let bpm = 160;
      let anchor = { bar: 0, progress: 0, timeMs: 0 };
      const isBefore = (point: BarPosition) =>
        point.bar < position.bar || (point.bar === position.bar && point.progress < position.progress);
      for (const point of signatures) {
        if (!isBefore(point)) break;
        beats = point.beats;
        if (point.timeMs > anchor.timeMs) anchor = point;
      }
      for (const point of bpms) {
        if (!isBefore(point)) break;
        bpm = point.bpm;
        if (point.timeMs > anchor.timeMs) anchor = point;
      }
      // PositionToTimeMs uses float multiply/divide/add, then floors the
      // millisecond offset. CreateNote uses this same clock for authored notes.
      const secondsPerBar = Math.fround(Math.fround(beats * 60) / bpm);
      const seconds = Math.fround(
        Math.fround(secondsPerBar * Math.fround(position.bar - anchor.bar)) +
          Math.fround(secondsPerBar * Math.fround(position.progress - anchor.progress)),
      );
      return anchor.timeMs + Math.floor(Math.fround(seconds * 1000));
    },
  };
}

export function buildChart(root: SsRoot, observer?: ChartBuildSourceObserver): ChartDocument {
  const converter = new TickConverter(root.bpm, root.sig);
  const comboTiming = createNativePositionTiming(root, converter);
  const { types: coincidence, consumedSingles } = buildGuideCoincidence(root.notes);
  const notes: ChartNote[] = [];
  const lines: ChartLine[] = [];
  let nextId = 0;
  const push = (
    tick: number,
    shape: Shape,
    operation: NoteOperateType,
    critical: boolean,
    direction: NoteDirection,
    lineId: number | null,
    indexInLine: number | null,
    easeL: NoteLineEaseType | null,
    easeR: NoteLineEaseType | null,
    visible: boolean,
    override?: { id?: number; timeMs?: number; beat?: number; slideAlong?: boolean },
  ): ChartNote => {
    if (notes.length >= MAX_RENDERABLE_NOTES) {
      throw new RangeError("Chart contains too many renderable notes.");
    }
    const id = override?.id ?? nextId++;
    nextId = Math.max(nextId, id + 1);
    const note: ChartNote = {
      id,
      tick,
      timeMs: override?.timeMs ?? comboTiming.timeAtPosition(converter.tickToBarPosition(tick)),
      beat: override?.beat ?? tick / PPQ,
      pos: shape.pos,
      size: shape.size,
      laneX: laneToX(shape.pos, shape.size),
      width: sizeToWidth(shape.size),
      operateType: operation,
      judgementType: resolveJudgementType(operation, critical),
      judgementAreaOffsetType: resolveJudgementAreaOffsetType(operation, critical),
      direction,
      critical,
      judged: isJudged(operation),
      visible,
      lineIds: lineId === null ? [] : [lineId],
      slideAlong: override?.slideAlong === true,
      indexInLine,
      easeL,
      easeR,
    };
    notes.push(note);
    return note;
  };

  for (const raw of root.notes) {
    if (raw.type === "long" || raw.type === "guide") continue;
    if (consumedSingles.has(raw)) continue;
    const operation =
      raw.type === "flick"
        ? NoteOperateType.Flick
        : raw.type === "trace"
          ? NoteOperateType.Trace
          : NoteOperateType.Normal;
    const shape = { pos: typeof raw.pos === "number" ? raw.pos : 0, size: raw.size ?? 6 };
    const note = push(raw.t ?? 0, shape, operation, raw.crit === true, mapDirection(raw), null, null, null, null, true);
    observer?.onSourceNote?.(raw, note.id);
  }

  // TryMergeSlideEndpoint stores one NoteInfoData with a list of line IDs
  // when equivalent slide/guide endpoints overlap.
  const mergedEndpoints = new Map<string, ChartNote>();
  for (const raw of root.notes) {
    if (raw.type !== "long" && raw.type !== "guide") continue;
    const lineId = lines.length;
    const nodes = [...(raw.node ?? [])]
      .map((note, order) => ({ note, order }))
      .sort((a, b) => (a.note.t ?? 0) - (b.note.t ?? 0) || a.order - b.order)
      .map(({ note }) => note);
    const shapes = interpolateAutomaticNodes(nodes, raw.ease);
    const noteIds = nodes.map((node, index) => {
      const [leftEase, rightEase] = easePair(node, raw.ease);
      const operation = resolveLineOperation(node, index, nodes.length, raw.type as "long" | "guide", coincidence);
      const shape = shapes[index]!;
      const coincident =
        raw.type === "guide" && index === 0 && typeof node.t === "number" && typeof node.pos === "number"
          ? coincidence.get(nativeOverlapKey(node.t, node.pos, node.size ?? 6))
          : undefined;
      const critical = coincident?.critical ?? node.crit === true;
      const direction = coincident?.direction ?? mapDirection(node);
      const visible = coincident?.visible ?? node.visible !== false;
      let resolved: ChartNote | undefined;

      const mergeKey = endpointMergeKey(node.t ?? 0, shape, operation, critical, direction, leftEase, rightEase);
      if (!resolved && isMergeableEndpoint(operation)) resolved = mergedEndpoints.get(mergeKey);
      if (resolved) {
        if (!resolved.lineIds.includes(lineId)) resolved.lineIds.push(lineId);
      } else {
        resolved = push(
          node.t ?? 0,
          shape,
          operation,
          critical,
          direction,
          lineId,
          index,
          leftEase,
          rightEase,
          visible,
          { slideAlong: node.pos === "auto" },
        );
      }
      if (isMergeableEndpoint(operation) && !mergedEndpoints.has(mergeKey)) mergedEndpoints.set(mergeKey, resolved);
      observer?.onSourceNote?.(node, resolved.id);
      if (coincident) observer?.onSourceNote?.(coincident.raw, resolved.id);
      return resolved.id;
    });
    lines.push({
      id: lineId,
      kind: raw.type,
      critical: raw.crit ?? nodes.some((node) => node.crit === true),
      noteIds,
    });
    observer?.onSourceLine?.(raw, lineId);
  }

  const byId = new Map(notes.map((note) => [note.id, note]));
  const viewNotesByBegin = new Map<number, Map<number, ChartNote>>();
  const comboPathByEndpoints = new Map<
    string,
    { line: ChartLine; authored: ChartNote[]; begin: ChartNote; end: ChartNote }
  >();
  for (const line of lines) {
    if (line.kind !== "long") continue;
    const authored = line.noteIds
      .map((id) => byId.get(id))
      .filter((note): note is ChartNote => Boolean(note))
      .sort((a, b) => a.timeMs - b.timeMs || (a.indexInLine ?? 0) - (b.indexInLine ?? 0));
    if (authored.length < 2) continue;
    const begin = authored[0]!;
    const end = authored[authored.length - 1]!;
    const viewNotes = viewNotesByBegin.get(begin.id) ?? new Map<number, ChartNote>();
    for (const note of authored.slice(1)) viewNotes.set(note.id, note);
    viewNotesByBegin.set(begin.id, viewNotes);
    const key = `${begin.id}:${end.id}`;
    if (!comboPathByEndpoints.has(key)) comboPathByEndpoints.set(key, { line, authored, begin, end });
  }

  const comboPaths = [...comboPathByEndpoints.values()].sort(
    (a, b) => a.end.timeMs - b.end.timeMs || a.end.tick - b.end.tick || a.line.id - b.line.id,
  );
  let generatedComboCount = 0;
  for (const { line, authored, begin, end } of comboPaths) {
    if (end.timeMs <= begin.timeMs) continue;
    const runtimeView = [...(viewNotesByBegin.get(begin.id)?.values() ?? [])]
      .filter((note) => note.id !== end.id && note.timeMs < end.timeMs && note.judged)
      .sort((left, right) => {
        const a = converter.tickToBarPosition(left.tick);
        const b = converter.tickToBarPosition(right.tick);
        return a.bar - b.bar || a.progress - b.progress || left.id - right.id;
      });
    const authoredJudgePositions = [...runtimeView, end]
      .filter((note) => note.judged)
      .map((note) => converter.tickToBarPosition(note.tick));
    // Every judged node restarts the native eighth-note interval, including
    // nodes whose lane position is interpolated automatically.
    const midpoints = runtimeView;
    const boundaries = [begin, ...midpoints, end];
    const comboTimes: { timeMs: number; bar: BarPosition }[] = [];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const head = boundaries[index]!;
      const tail = boundaries[index + 1]!;
      let { bar, progress } = converter.tickToBarPosition(head.tick);
      let step = 1 / (comboTiming.beatsAtBar(bar) * 2);
      while (true) {
        if (!Number.isFinite(step) || step <= 0) {
          throw new RangeError("Chart contains an invalid Combo bar interval.");
        }
        const next = progress + step;
        if (!Number.isFinite(next) || next <= progress) {
          throw new RangeError("Chart combo timing does not advance.");
        }
        progress = next;
        if (progress >= 1) {
          bar += 1;
          progress -= 1;
          step = 1 / (comboTiming.beatsAtBar(bar) * 2);
        }
        const position = { bar, progress: Math.fround(progress) };
        const timeMs = comboTiming.timeAtPosition(position);
        if (timeMs >= tail.timeMs) break;
        generatedComboCount += 1;
        if (generatedComboCount > MAX_GENERATED_COMBO_NOTES) {
          throw new RangeError("Chart produces too many generated combo notes.");
        }
        comboTimes.push({ timeMs, bar: position });
      }
    }
    for (let index = 0; index < comboTimes.length; index++) {
      const combo = comboTimes[index]!;
      // TrySetSlideNoteId skips an exact authored position before constructing
      // either Combo or ComboSkip; equal milliseconds alone are not its key.
      if (authoredJudgePositions.some((position) => sameBarPosition(position, combo.bar))) continue;
      const sixteenthMs = 15_000 / converter.bpmAtTimeMs(combo.timeMs);
      const tooClose =
        midpoints.some((note) => note.timeMs - sixteenthMs <= combo.timeMs && combo.timeMs < note.timeMs) ||
        (index === 0 && combo.timeMs - begin.timeMs < sixteenthMs) ||
        (index === comboTimes.length - 1 && end.timeMs - combo.timeMs < sixteenthMs);
      const shape = interpolateAuthoredLine(authored, combo.timeMs);
      const operation = tooClose ? NoteOperateType.ComboSkip : NoteOperateType.Combo;
      const generated = push(
        converter.timeMsToTick(combo.timeMs),
        shape,
        operation,
        false,
        NoteDirection.Normal,
        line.id,
        null,
        null,
        null,
        false,
        { timeMs: combo.timeMs, beat: converter.timeMsToBeat(combo.timeMs) },
      );
      line.noteIds.push(generated.id);
      byId.set(generated.id, generated);
    }
    line.noteIds.sort((left, right) => (byId.get(left)?.beat ?? 0) - (byId.get(right)?.beat ?? 0) || left - right);
  }

  notes.sort((a, b) => a.tick - b.tick || a.id - b.id);
  const timeline = buildChartTimeline(root, converter);
  let durationMs = notes.reduce((maximum, note) => Math.max(maximum, note.timeMs), 0);
  for (const event of timeline.skills) durationMs = Math.max(durationMs, event.timeMs);
  for (const section of timeline.fever) durationMs = Math.max(durationMs, section.endTimeMs);
  for (const event of timeline.callChanges) durationMs = Math.max(durationMs, event.timeMs);
  return {
    version: root.version,
    bpmChanges: root.bpm.map((point) => ({
      tick: point.t,
      beat: point.t / PPQ,
      timeMs: converter.tickToTimeMs(point.t),
      bpm: point.bpm,
    })),
    signatureChanges: root.sig.map((point) => ({
      tick: point.t,
      beat: point.t / PPQ,
      timeMs: converter.tickToTimeMs(point.t),
      numerator: point.sig[0],
      denominator: point.sig[1],
    })),
    timeScaleChanges: [],
    notes,
    lines,
    timeline,
    durationMs,
  };
}
