import type { Candidate, Objective, OptimizationInput, SongSearchRanking } from "../contracts.ts";

const assignmentKey = (candidate: Candidate) => JSON.stringify(candidate.assignment);
/** Per-chart rankings survive global dominance. Equal values use stable IDs;
 * each entry represents a distinct complete member/leader/equipment assignment.
 */
export function createSongRankingCollector(input: OptimizationInput) {
  const rankings = new Map<string, SongSearchRanking>(
    input.songs.map((song) => [
      song.key,
      {
        songKey: song.key,
        songId: song.songId,
        difficulty: song.difficulty,
        top3: Object.fromEntries(input.objectives.map((objective) => [objective, []])),
        evaluated: 0,
        proven: false,
      },
    ]),
  );
  const incomplete = new Set<string>();
  return {
    offer(candidate: Candidate) {
      const ranking = rankings.get(candidate.songKey);
      if (!ranking) throw new RangeError("candidate-song-identity");
      ranking.evaluated++;
      if (!candidate.vector.every(Number.isFinite)) incomplete.add(candidate.songKey);
      for (const objective of input.objectives) {
        const metric = candidate.metrics[objective];
        if (
          metric.value === null ||
          !Number.isFinite(metric.value) ||
          metric.status === "unavailable" ||
          metric.gaps.length
        ) {
          incomplete.add(candidate.songKey);
          continue;
        }
        const rows = ranking.top3[objective]!;
        const key = assignmentKey(candidate);
        if (rows.some((previous) => assignmentKey(previous) === key)) continue;
        rows.push(candidate);
        rows.sort(
          (a, b) =>
            b.metrics[objective].value! - a.metrics[objective].value! ||
            assignmentKey(a).localeCompare(assignmentKey(b), "en"),
        );
        rows.length = Math.min(rows.length, 3);
      }
    },
    finish(exhaustive: boolean, allowedSongs: ReadonlySet<string>): SongSearchRanking[] {
      return [...rankings.values()]
        .filter((ranking) => allowedSongs.has(ranking.songKey))
        .map((ranking) => ({
          ...ranking,
          proven: exhaustive && !incomplete.has(ranking.songKey),
        }));
    },
  };
}
