import { JudgeTiming, NoteSimulateJudgement, type NoteJudgementType } from "@haneoka/cassiopeia/enums";
import { createTimingPolicy, type TimingPolicy, type TimingWindow } from "@haneoka/cassiopeia/timing-policy";

/** Native timing tables are selected by the game adapter's caller. */
export type OurNotesTimingTable = Readonly<
  Partial<Record<NoteJudgementType, readonly TimingWindow<NoteSimulateJudgement>[]>>
>;

/** Ordinary play keeps native Just data while resolving that row as Perfect. */
export function createOurNotesTimingPolicy(
  table: OurNotesTimingTable,
): TimingPolicy<NoteSimulateJudgement, JudgeTiming> {
  const windows = Object.fromEntries(
    Object.entries(table).map(([type, values]) => [
      type,
      values?.map((window) => ({
        before: window.before,
        after: window.after,
        judgement:
          window.judgement === NoteSimulateJudgement.Just ? NoteSimulateJudgement.Perfect : window.judgement,
      })),
    ]),
  );
  return createTimingPolicy({
    windows,
    miss: NoteSimulateJudgement.Miss,
    neutralWindowMs: 1,
    timing: {
      none: JudgeTiming.None,
      fast: JudgeTiming.Fast,
      late: JudgeTiming.Late,
      outOfTime: JudgeTiming.OutOfTime,
    },
  });
}
