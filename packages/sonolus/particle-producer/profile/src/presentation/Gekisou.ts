import { FeverState, getAssistTimingTable, NoteSimulateJudgement } from "@haneoka/cassiopeia";
import type { AutoJudgementContext, ChartDocument, ChartNote, JudgementEvent } from "@haneoka/cassiopeia";

/** MasterLiveMusic._gekisouMission1..3. */
export type OurNotesGekisouMission = 0 | 1 | 2 | 3;

export interface OurNotesGekisouRange {
  readonly index: number;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly mission: OurNotesGekisouMission;
}

/** Source input, independent from renderer, transport, team skills and luck RNG. */
export interface OurNotesGekisouConfiguration {
  readonly enabled: boolean;
  readonly missionTypes: readonly number[];
}

export const OUR_NOTES_GEKISOU_LANE_LIFETIME = 0.44999998807907104;

/** LiveStateProperty.InitializeGekisouController marks each range's canonical note times. */
export class OurNotesGekisouPlan {
  readonly ranges: readonly OurNotesGekisouRange[];
  private readonly rangeByNoteId: ReadonlyMap<number, OurNotesGekisouRange>;
  private readonly justTypes: ReadonlySet<number>;

  constructor(chart: ChartDocument, configuration: OurNotesGekisouConfiguration) {
    if (!configuration.enabled) {
      this.ranges = [];
      this.rangeByNoteId = new Map();
    } else {
      if (configuration.missionTypes.length !== chart.timeline.fever.length)
        throw new RangeError("gekisou-mission-range-count");
      this.ranges = Object.freeze(
        chart.timeline.fever.map((section, index) => {
          const mission = configuration.missionTypes[index]!;
          if (!Number.isInteger(mission) || mission < 0 || mission > 3)
            throw new RangeError(`gekisou-mission:${mission}`);
          return Object.freeze({
            index,
            startTimeMs: section.startTimeMs,
            endTimeMs: section.endTimeMs,
            mission: mission as OurNotesGekisouMission,
          });
        }),
      );
      this.rangeByNoteId = new Map(
        chart.notes.flatMap((note) => {
          const range = this.ranges.find((range) => range.startTimeMs <= note.timeMs && note.timeMs <= range.endTimeMs);
          return range ? [[note.id, range] as const] : [];
        }),
      );
    }
    this.justTypes = new Set(
      Object.entries(getAssistTimingTable(0)).flatMap(([type, windows]) =>
        windows?.some((window) => window.judgement === NoteSimulateJudgement.Just) ? [Number(type)] : [],
      ),
    );
  }

  rangeForNote(noteId: number): OurNotesGekisouRange | undefined {
    return this.rangeByNoteId.get(noteId);
  }

  /** Perfect input at canonical time becomes Just only for the source's eligible JUST mission nodes. */
  readonly autoJudgement = (note: Readonly<ChartNote>, context: AutoJudgementContext): NoteSimulateJudgement =>
    context.feverState === FeverState.Fever &&
    this.ranges[context.feverSection?.index ?? -1]?.mission === 3 &&
    this.justTypes.has(note.judgementType)
      ? NoteSimulateJudgement.Just
      : NoteSimulateJudgement.Perfect;

  /** LiveLaneEffectViewUtility.CheckGekisou: Luck exact timing or a JUST result in a JUST mission. */
  isGekisouLane(
    event: Pick<JudgementEvent, "note" | "judgement" | "diffMs">,
    currentRangeIndex: number | undefined,
  ): boolean {
    if (!this.rangeByNoteId.has(event.note.id)) return false;
    const mission = this.ranges[currentRangeIndex ?? -1]?.mission;
    return (mission === 2 && event.diffMs === 0) || (mission === 3 && event.judgement === NoteSimulateJudgement.Just);
  }
}
