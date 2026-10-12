import type { EngineRequest, EngineResponse, SongRef, SongResult } from "./api";

/** Comparable between the page and Workers, whose performance origins may differ. */
export const clock = () => performance.timeOrigin + performance.now();
export const deadlineOf = (request: EngineRequest) => request.deadline ?? (request.timeLimitMs == null ? Infinity : clock() + request.timeLimitMs);
export const remaining = (deadline: number) => Math.max(0, deadline - clock());
export const requestSongs = (request: EngineRequest): (SongRef | null)[] => {
  const goal = request.goal;
  return goal.kind === "power" ? [goal.song] : goal.kind === "potential" ? [null] : goal.kind === "plan"
    ? [...goal.challengeSongs, ...goal.normalSongs] : goal.kind === "event" && !goal.songs.length && goal.route === "skip" ? [null] : goal.songs;
};
export const pendingSong = (song: SongRef | null): SongResult => ({
  song, hits: [], proven: false, bound: Infinity,
  stats: { leaders: 0, memberNodes: 0, snapNodes: 0, candidates: 0, exact: 0, elapsedMs: 0 },
});
export const emptyResponse = (request: EngineRequest): EngineResponse => ({
  results: requestSongs(request).map(song => request.completed?.find(result => result.song?.songId === song?.songId && result.song?.difficulty === song?.difficulty) ?? pendingSong(song)), overall: [], unknownCards: [], elapsedMs: 0,
});
export const completeResponse = (response: EngineResponse) => response.results.length > 0 && response.results.every(result => result.proven || result.exclusion !== undefined || result.excludedBelow !== undefined);

export interface RewardCutoff {
  key: number;
  comparison: "gt" | "gte";
  contextKey: string;
  ranking: "reward-song-difficulty-v1";
}
export const acceptsReward = (key: number, cutoff: RewardCutoff) => cutoff.comparison === "gt" ? key > cutoff.key : key >= cutoff.key;
export const excludesBound = (bound: number, cutoff: RewardCutoff) => cutoff.comparison === "gt" ? bound <= cutoff.key : bound < cutoff.key;

export function improvementPercent(results: readonly SongResult[]): number | null {
  const best = Math.max(...results.flatMap(result => result.hits.map(hit => hit.key)));
  if (!(best > 0) || !results.length) return null;
  let upper = best;
  for (const result of results) {
    if (result.proven) continue;
    const bound = result.exclusion?.key ?? result.bound;
    if (bound === null || !Number.isFinite(bound)) return null;
    upper = Math.max(upper, bound);
  }
  return Math.ceil(Math.max(0, (upper / best - 1) * 1000)) / 10;
}
