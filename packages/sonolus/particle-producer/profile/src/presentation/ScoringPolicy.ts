import {
  getAssistTimingTable,
  NoteSimulateJudgement,
  type NoteJudgementType,
  type AutomaticJudgementPolicy,
} from "@haneoka/cassiopeia";
import type { OurNotesGekisouPlan } from "./Gekisou.js";
import type { SessionOptions } from "@haneoka/cassiopeia";

/** Source score queries use combo history strictly before canonical note time. */
export function createOurNotesSessionOptions(
  options: SessionOptions = {},
): SessionOptions {
  return {
    ...options,
    scoringComboPolicy:
      (options.mode ?? "watch") === "watch"
        ? "strict-prior-note-time"
        : "sequential",
  };
}

/** Source mission rules serialized for the shared automatic runtime. */
export function createOurNotesAutomaticPolicy(
  plan?: OurNotesGekisouPlan,
): AutomaticJudgementPolicy {
  if (!plan) return { rules: [] };
  const types = Object.entries(getAssistTimingTable(0)).flatMap(
    ([type, windows]) =>
      windows?.some((window) => window.judgement === NoteSimulateJudgement.Just)
        ? [Number(type) as NoteJudgementType]
        : [],
  );
  return {
    rules: plan.ranges.flatMap((range, i, ranges) => {
      const end = Math.min(
        range.endTimeMs,
        ranges[i + 1]?.startTimeMs ?? Infinity,
      );
      return range.mission === 3 && end > range.startTimeMs
        ? [
            {
              startMicros: range.startTimeMs * 1000,
              endMicros: end * 1000,
              judgementTypes: types,
              judgement: NoteSimulateJudgement.Just,
            },
          ]
        : [];
    }),
  };
}
