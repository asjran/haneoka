import { NoteDirection, NoteJudgementType, NoteOperateType, JudgementAreaOffsetType } from "./enums.js";
import { requireAssistLevel } from "./assist.js";
import type { ChartDocument } from "./types.js";

/** JSON wire form shared with the Rust/native candidate selector. */
export interface RuntimeChartContract {
  format: "org.haneoka.cassiopeia.runtime";
  version: 1;
  laneCount: 24;
  assistLevel: number;
  notes: Array<{
    id: number;
    time: number;
    position: number;
    size: number;
    operateType: string;
    judgementType: string;
    judgementAreaOffsetType: string;
    direction: string;
    judged: boolean;
  }>;
  lines: Array<{ id: number; kind: "long" | "guide"; noteIds: number[] }>;
}
const name = (names: Record<number, string>, value: number) => {
  const result = names[value];
  if (!result) throw new TypeError(`Unknown native enum ${value}`);
  return result[0]!.toLowerCase() + result.slice(1);
};
const integer = (value: number, scale: number, label: string) => {
  const result = Math.round(value * scale);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} is not a safe wire integer`);
  return result;
};
export function toRuntimeChart(chart: ChartDocument, assistLevel = 0): RuntimeChartContract {
  return {
    format: "org.haneoka.cassiopeia.runtime",
    version: 1,
    laneCount: 24,
    assistLevel: requireAssistLevel(assistLevel),
    notes: chart.notes.map((note) => ({
      id: note.id,
      time: integer(Math.floor(note.timeMs), 1000, "time"),
      position: integer(note.pos, 1_000_000, "position"),
      size: integer(note.size, 1_000_000, "size"),
      operateType: name(NoteOperateType, note.operateType),
      judgementType: name(NoteJudgementType, note.judgementType),
      judgementAreaOffsetType: name(JudgementAreaOffsetType, note.judgementAreaOffsetType),
      direction: name(NoteDirection, note.direction),
      judged: note.judged,
    })),
    lines: chart.lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      noteIds: [...line.noteIds],
    })),
  };
}
