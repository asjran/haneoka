import type { OurNotesGekisouMission, OurNotesGekisouRange } from "./Gekisou.js";
import type { RenderOverlaySprite } from "../render/types.js";

export interface OurNotesGekisouPresentationJudgement {
  readonly noteId: number;
  readonly noteTimeMs: number;
  readonly judgedAtMs: number;
  readonly judgement: number;
}

/** LiveSettingCreator supplies 500 ms plus the maximum of every MasterLiveJudgementTiming row. */
export interface OurNotesGekisouPresentationTiming {
  readonly completeDelayMs: number;
  readonly lastNoteSlowJudgeDelayMs: number;
}

export const OUR_NOTES_GEKISOU_PRESENTATION_TIMING: OurNotesGekisouPresentationTiming = Object.freeze({
  completeDelayMs: 500,
  lastNoteSlowJudgeDelayMs: 251,
});

export interface OurNotesGekisouCountdownPresentation {
  readonly rangeIndex: number | null;
  readonly mission: OurNotesGekisouMission | null;
  readonly count: 1 | 2 | 3 | null;
  readonly clip: "number1" | "number2" | "number3" | "out" | null;
  readonly clipTimeSeconds: number;
  readonly visible: boolean;
}

export interface OurNotesGekisouJustPresentation {
  readonly rangeIndex: number | null;
  readonly visible: boolean;
  readonly count: number;
  readonly lastJudgedAtMs: number | null;
  readonly lastAddedCount: number;
}

export interface OurNotesGekisouPresentationFrame {
  readonly enabled: boolean;
  readonly observedTimeMs: number;
  readonly countdown: OurNotesGekisouCountdownPresentation;
  readonly just: OurNotesGekisouJustPresentation;
}

export interface OurNotesGekisouProjectionContext {
  readonly width: number;
  readonly height: number;
  /** Column-major Unity world to homogeneous clip coordinates. */
  readonly worldToClip: ArrayLike<number>;
  readonly displayPositionChanged: boolean;
  readonly small?: boolean;
  readonly displayScale?: number;
}

export interface OurNotesGekisouPresentationProjector {
  project(
    frame: OurNotesGekisouPresentationFrame,
    context: OurNotesGekisouProjectionContext,
  ): readonly RenderOverlaySprite[];
}

interface JustEvent {
  readonly noteId: number;
  readonly judgedAtMs: number;
}

function upperBound(events: readonly JustEvent[], timeMs: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle]!.judgedAtMs <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Range-local results use canonical note membership and actual judgement timestamps. */
export class OurNotesGekisouPresentation {
  private readonly events: JustEvent[][];
  private readonly counted = new Map<number, { range: number; event: JustEvent }>();

  constructor(
    readonly ranges: readonly OurNotesGekisouRange[],
    public timing: OurNotesGekisouPresentationTiming = OUR_NOTES_GEKISOU_PRESENTATION_TIMING,
  ) {
    this.events = ranges.map(() => []);
  }

  record(result: OurNotesGekisouPresentationJudgement): void {
    const old = this.counted.get(result.noteId);
    if (old) {
      if (
        result.judgement === 6 &&
        old.event.judgedAtMs === result.judgedAtMs &&
        this.ranges[old.range]!.startTimeMs <= result.noteTimeMs &&
        result.noteTimeMs <= this.ranges[old.range]!.endTimeMs
      )
        return;
      const events = this.events[old.range]!;
      events.splice(events.indexOf(old.event), 1);
      this.counted.delete(result.noteId);
    }
    if (result.judgement !== 6) return;
    const rangeIndex = this.ranges.findIndex(
      (range) => range.startTimeMs <= result.noteTimeMs && result.noteTimeMs <= range.endTimeMs,
    );
    if (rangeIndex < 0 || this.ranges[rangeIndex]!.mission !== 3) return;
    const event = { noteId: result.noteId, judgedAtMs: result.judgedAtMs };
    const events = this.events[rangeIndex]!;
    events.splice(upperBound(events, result.judgedAtMs), 0, event);
    this.counted.set(result.noteId, { range: rangeIndex, event });
  }

  reset(results: Iterable<OurNotesGekisouPresentationJudgement> = []): void {
    this.counted.clear();
    for (const events of this.events) events.length = 0;
    for (const result of results) this.record(result);
  }

  sample(
    observedTimeMs: number,
    options: { readonly enabled?: boolean; readonly completedRangeCount?: number } = {},
  ): OurNotesGekisouPresentationFrame {
    const enabled = options.enabled ?? true;
    const countdown: OurNotesGekisouCountdownPresentation = this.countdown(
      observedTimeMs,
      enabled,
      options.completedRangeCount,
    );
    let rangeIndex = -1;
    if (enabled) {
      for (let index = 0; index < this.ranges.length; index++) {
        if (this.ranges[index]!.startTimeMs > observedTimeMs) break;
        rangeIndex = index;
      }
    }
    const range = this.ranges[rangeIndex];
    const events = this.events[rangeIndex];
    const count = events ? upperBound(events, observedTimeMs) : 0;
    const lastJudgedAtMs = count ? events![count - 1]!.judgedAtMs : null;
    let lastAddedCount = 0;
    for (let index = count - 1; index >= 0 && events![index]!.judgedAtMs === lastJudgedAtMs; index--) lastAddedCount++;
    return {
      enabled,
      observedTimeMs,
      countdown,
      just: {
        rangeIndex: range?.index ?? null,
        visible: range?.mission === 3 && observedTimeMs < range.endTimeMs,
        count,
        lastJudgedAtMs,
        lastAddedCount,
      },
    };
  }

  private countdown(timeMs: number, enabled: boolean, completedCount?: number): OurNotesGekisouCountdownPresentation {
    const hidden: OurNotesGekisouCountdownPresentation = {
      rangeIndex: null,
      mission: null,
      count: null,
      clip: null,
      clipTimeSeconds: 0,
      visible: false,
    };
    if (!enabled) return hidden;
    const completeDelay = this.timing.lastNoteSlowJudgeDelayMs + this.timing.completeDelayMs;
    const index = completedCount ?? this.ranges.findIndex((range) => timeMs < range.endTimeMs + completeDelay);
    const range = this.ranges[index];
    if (!range) return hidden;
    // Source TimeToGekisouRangeMs is an Int32, converted to Float32 before division.
    const remaining = Math.trunc(range.startTimeMs - Math.trunc(timeMs));
    const count = Math.floor(Math.fround(Math.fround(remaining) / 1000)) + 1;
    if (count > 3) return hidden;
    if (count < 1) {
      return {
        rangeIndex: range.index,
        mission: range.mission,
        count: null,
        clip: "out",
        clipTimeSeconds: Math.max(0, (timeMs - range.startTimeMs) / 1000),
        visible: true,
      };
    }
    const value = count as 1 | 2 | 3;
    return {
      rangeIndex: range.index,
      mission: range.mission,
      count: value,
      clip: `number${value}`,
      clipTimeSeconds: Math.max(0, (timeMs - (range.startTimeMs - value * 1000)) / 1000),
      visible: true,
    };
  }
}
