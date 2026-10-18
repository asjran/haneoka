import { JudgeTiming, NoteJudgementType, NoteSimulateJudgement } from "./enums.js";
import { DEFAULT_ASSIST_LEVEL, getAssistTimingTable, type AssistLevel } from "./assist.js";

export interface JudgeWindow {
  judgement: NoteSimulateJudgement;
  before: number;
  after: number;
}

const J = NoteSimulateJudgement;

/** Level-zero compatibility view. Use the assist-aware helpers for new code. */
export const JUDGE_WINDOWS: Readonly<Partial<Record<number, readonly JudgeWindow[]>>> =
  getAssistTimingTable(DEFAULT_ASSIST_LEVEL);

export const MAXIMUM_EARLY_WINDOW = Math.max(
  0,
  ...Object.values(JUDGE_WINDOWS).flatMap((windows) => (windows ?? []).map((item) => item.before)),
);

export interface JudgeResult {
  judgement: NoteSimulateJudgement;
  timing: JudgeTiming;
}

export function judge(
  noteType: NoteJudgementType,
  diffMs: number,
  assistLevel: AssistLevel = DEFAULT_ASSIST_LEVEL,
): JudgeResult {
  const windows = getAssistTimingTable(assistLevel)[noteType];
  if (!windows?.length) return { judgement: J.Miss, timing: JudgeTiming.OutOfTime };
  for (const item of windows) {
    if (diffMs < -item.before) continue;
    if (diffMs <= item.after) {
      const timing = Math.abs(diffMs) <= 1 ? JudgeTiming.None : diffMs > 1 ? JudgeTiming.Late : JudgeTiming.Fast;
      // Just is retained in the raw native table for future Gekisou-only
      // dispatch. Ordinary play currently resolves that row as Perfect.
      const judgement = item.judgement === J.Just ? J.Perfect : item.judgement;
      return { judgement, timing };
    }
  }
  return { judgement: J.Miss, timing: JudgeTiming.OutOfTime };
}

export function maximumLateWindow(
  noteType: NoteJudgementType,
  assistLevel: AssistLevel = DEFAULT_ASSIST_LEVEL,
): number {
  return Math.max(0, ...(getAssistTimingTable(assistLevel)[noteType] ?? []).map((item) => item.after));
}

export function maximumEarlyWindow(
  noteType: NoteJudgementType,
  assistLevel: AssistLevel = DEFAULT_ASSIST_LEVEL,
): number {
  return Math.max(0, ...(getAssistTimingTable(assistLevel)[noteType] ?? []).map((item) => item.before));
}
