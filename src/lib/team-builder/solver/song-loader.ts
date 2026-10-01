import { tickToTimeMs } from "../song-metrics.ts";
import type { SongOption } from "../contracts.ts";
import { dataRows, objectRow, type TeamBuilderData } from "../data.ts";

/** Load selected same-release chart assets in the worker; reuse the player and
 * build metric converter instead of maintaining a second note resolver.
 */
export async function loadSongOptions(
  data: TeamBuilderData,
  selections: readonly { songId: number; difficulty: number }[],
  signal?: AbortSignal,
): Promise<SongOption[]> {
  if (selections.length > 1000) throw new RangeError("song-selection-size");
  const { convertChartAsync } =
    await import("../../../../.dependencies/cassiopeia-plugin-sonolus/src/convert/index.ts");
  const songs: SongOption[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    signal?.throwIfAborted();
    const row = data.songs[String(selection.songId)];
    if (!row) throw new RangeError("unknown-song");
    const difficulty = dataRows(row.difficulty ?? row.difficulties).find(
      (value) => Number(value.difficulty) === selection.difficulty,
    );
    if (!difficulty) throw new RangeError("unknown-song-difficulty");
    const key = `${selection.songId}:${selection.difficulty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = String(difficulty.file ?? objectRow(difficulty.score).file ?? "");
    if (!file) throw new RangeError("chart-file-missing");
    const response = await fetch(file, { signal, credentials: "omit" });
    if (!response.ok) throw new Error(`chart-http:${response.status}`);
    if (Number(response.headers.get("content-length")) > 2 * 1024 * 1024) throw new RangeError("chart-byte-limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) throw new RangeError("chart-byte-limit");
    signal?.throwIfAborted();
    const chart = await convertChartAsync(bytes);
    if (chart.notes.length > 25000) throw new RangeError("chart-node-limit");
    const events = chart.notes
      .filter((note) => note.judged)
      .map((note) => ({
        tick: note.tick,
        timeMs: note.timeMs,
        operateType: note.operateType,
        judgementType: note.judgementType,
      }));
    const missionTypes = objectRow(row.gekisou).missionTypes;
    const missions = Array.isArray(missionTypes) ? missionTypes.map(Number) : [];
    const gaps = [];
    const declaredCount = Number(difficulty.noteCount ?? objectRow(difficulty.meta).n);
    if (!Number.isSafeInteger(declaredCount) || declaredCount < 1)
      gaps.push({ code: "canonical-count-reference-missing", source: key });
    else if (declaredCount !== events.length) gaps.push({ code: "canonical-full-combo-mismatch", source: key });
    songs.push({
      key,
      songId: selection.songId,
      scoreId: Number(difficulty.scoreId ?? difficulty.id),
      difficulty: selection.difficulty,
      playLevel: Number(difficulty.playLevel ?? objectRow(difficulty.meta).playLevel),
      durationMs: chart.durationMs,
      events,
      skillTimesMs: chart.passthrough.skill.map((tick) => tickToTimeMs(chart.bpmChanges, tick)),
      segments: chart.passthrough.fever.map(([startTick, endTick], index) => ({
        startTick,
        endTick,
        mission: missions[index] ?? 0,
      })),
      gaps,
    });
  }
  return songs;
}
