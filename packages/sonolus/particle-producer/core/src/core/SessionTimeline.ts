import { FeverState } from "./enums.js";
import type {
  ChartTimeline,
  ChartSkillEvent,
  ChartCallChangeEvent,
  ChartFeverSection,
  ChartFeverTransitionEvent,
} from "./types.js";

export type SessionTimelineEvents = {
  skill: ChartSkillEvent;
  fever: ChartFeverTransitionEvent;
  callChange: ChartCallChangeEvent;
};

/** Presentation callbacks and seek projection, independent of gameplay results. */
export class SessionTimeline {
  lastSkill: ChartSkillEvent | null = null;
  callChange: ChartCallChangeEvent | null = null;
  feverState: FeverState = FeverState.Wait;
  feverSection: ChartFeverSection | null = null;
  private readonly executedSkills: Uint8Array;
  private readonly skillTimelineIsMonotonic: boolean;
  private readonly activeFeverSections: number[] = [];
  private skillCursor = 0;
  private feverStartCursor = 0;
  private callChangeCursor = 0;
  constructor(
    private readonly timeline: ChartTimeline,
    private readonly handlers: {
      [K in keyof SessionTimelineEvents]: (
        event: SessionTimelineEvents[K],
      ) => void;
    },
  ) {
    this.executedSkills = new Uint8Array(timeline.skills.length);
    this.skillTimelineIsMonotonic = timeline.skills.every(
      (row, i, rows) => i === 0 || rows[i - 1]!.timeMs <= row.timeMs,
    );
  }
  private emit<K extends keyof SessionTimelineEvents>(
    kind: K,
    event: SessionTimelineEvents[K],
  ): void {
    this.handlers[kind](event);
  }
  reset(timeMs: number): void {
    this.lastSkill = null;
    this.callChange = null;
    this.feverState = FeverState.Wait;
    this.feverSection = null;
    this.executedSkills.fill(0);
    this.activeFeverSections.length = 0;
    this.skillCursor = this.feverStartCursor = this.callChangeCursor = 0;
    if (timeMs > 0) this.rebuild(timeMs);
  }
  advance(timeMs: number): void {
    if (this.skillTimelineIsMonotonic) {
      while (this.skillCursor < this.timeline.skills.length) {
        const event = this.timeline.skills[this.skillCursor]!;
        if (event.timeMs > timeMs) break;
        this.executedSkills[this.skillCursor] = 1;
        this.skillCursor++;
        this.lastSkill = event;
        this.emit("skill", event);
      }
    } else {
      // BuildSkillList preserves source order. Keep that observable order for
      // malformed/non-monotonic inputs even though ordinary scores use the
      // allocation-free cursor path above.
      for (let index = 0; index < this.timeline.skills.length; index++) {
        if (this.executedSkills[index]) continue;
        const event = this.timeline.skills[index]!;
        if (event.timeMs > timeMs) continue;
        this.executedSkills[index] = 1;
        this.lastSkill = event;
        this.emit("skill", event);
      }
    }

    let retainedFeverCount = 0;
    for (const index of this.activeFeverSections) {
      const section = this.timeline.fever[index]!;
      if (section.endTimeMs <= timeMs)
        this.applyFeverTransition(section, FeverState.End);
      else this.activeFeverSections[retainedFeverCount++] = index;
    }
    this.activeFeverSections.length = retainedFeverCount;

    while (this.feverStartCursor < this.timeline.fever.length) {
      const section = this.timeline.fever[this.feverStartCursor]!;
      if (section.startTimeMs > timeMs) break;
      this.feverStartCursor++;
      this.activeFeverSections.push(section.index);
      this.applyFeverTransition(section, FeverState.Fever);
    }

    while (this.callChangeCursor < this.timeline.callChanges.length) {
      const event = this.timeline.callChanges[this.callChangeCursor]!;
      if (event.timeMs > timeMs) break;
      this.callChangeCursor++;
      this.callChange = event;
      this.emit("callChange", event);
    }
  }

  private applyFeverTransition(
    section: ChartFeverSection,
    state: FeverState.Fever | FeverState.End,
  ): void {
    this.feverState = state;
    this.feverSection = section;
    this.emit("fever", {
      section,
      state,
      timeMs:
        state === FeverState.Fever ? section.startTimeMs : section.endTimeMs,
    });
  }

  private rebuild(timeMs: number): void {
    if (this.skillTimelineIsMonotonic) {
      while (this.skillCursor < this.timeline.skills.length) {
        const event = this.timeline.skills[this.skillCursor]!;
        if (event.timeMs > timeMs) break;
        this.executedSkills[this.skillCursor] = 1;
        this.skillCursor++;
        this.lastSkill = event;
      }
    } else {
      for (let index = 0; index < this.timeline.skills.length; index++) {
        const event = this.timeline.skills[index]!;
        if (event.timeMs > timeMs) continue;
        this.executedSkills[index] = 1;
        this.lastSkill = event;
      }
    }

    let latestFeverTime = Number.NEGATIVE_INFINITY;
    let latestFeverOrder = -1;
    while (this.feverStartCursor < this.timeline.fever.length) {
      const section = this.timeline.fever[this.feverStartCursor]!;
      if (section.startTimeMs > timeMs) break;
      this.feverStartCursor++;
      if (section.endTimeMs <= timeMs) {
        if (
          section.endTimeMs > latestFeverTime ||
          (section.endTimeMs === latestFeverTime &&
            section.index * 2 + 1 >= latestFeverOrder)
        ) {
          latestFeverTime = section.endTimeMs;
          latestFeverOrder = section.index * 2 + 1;
          this.feverState = FeverState.End;
          this.feverSection = section;
        }
      } else {
        this.activeFeverSections.push(section.index);
      }
      if (
        section.startTimeMs > latestFeverTime ||
        (section.startTimeMs === latestFeverTime &&
          section.index * 2 >= latestFeverOrder)
      ) {
        latestFeverTime = section.startTimeMs;
        latestFeverOrder = section.index * 2;
        this.feverState = FeverState.Fever;
        this.feverSection = section;
      }
    }

    while (this.callChangeCursor < this.timeline.callChanges.length) {
      const event = this.timeline.callChanges[this.callChangeCursor]!;
      if (event.timeMs > timeMs) break;
      this.callChangeCursor++;
      this.callChange = event;
    }
  }
}
