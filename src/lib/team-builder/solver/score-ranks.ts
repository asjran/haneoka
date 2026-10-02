import type { EvidenceGap } from "../contracts.ts";
import { battleScoreThreshold } from "../rewards.ts";
export interface NativeScoreRankRow {
  rank: number;
  requiredScore: number;
  battleRequiredScore: number;
}
export interface NativeRoomPlayerScore {
  liveScore: number | null;
  /** IMultiLivePlayerResult slot27 is get_DisConnected. */
  disConnected: boolean | null;
}
export interface NativeRankInput {
  nativeLiveMode: number;
  soloScore: number | null;
  /** null is missing room data; [] is the known empty-result fallback. */
  roomPlayers: NativeRoomPlayerScore[] | null;
  rankTargetPlayerCount?: number | null;
  rows: NativeScoreRankRow[];
}
export interface NativeRankContext {
  domain: "personal" | "room";
  score: number | null;
  ssThreshold: number | null;
  rank: number | null;
  rankTargetPlayerCount: number | null;
  gaps: EvidenceGap[];
}
const unknown = (domain: NativeRankContext["domain"], code: string): NativeRankContext => ({
  domain,
  score: null,
  ssThreshold: null,
  rank: null,
  rankTargetPlayerCount: null,
  gaps: [{ code, source: "native LiveResultModel.GetLiveScoreRank" }],
});
const intScore = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new RangeError("rank-score-input");
  return value;
};
/** LiveResultModel.GetLiveScoreRank default body: BattleLive=1 with players uses
 * sum of every player's LiveScore; all other branches use cached SoloScore.
 */
export function resolveNativeScoreRank(input: NativeRankInput): NativeRankContext {
  if (!input.rows.length) return unknown(input.nativeLiveMode === 1 ? "room" : "personal", "score-rank-rows-missing");
  const ss = input.rows.find((row) => row.rank === 7);
  const room = input.nativeLiveMode === 1 && (input.roomPlayers === null || input.roomPlayers.length > 0);
  if (room && input.roomPlayers === null) return unknown("room", "room-player-scores-unresolved");
  let score: number;
  let count: number | null = null;
  if (room) {
    const players = input.roomPlayers!;
    if (players.some((player) => player.liveScore === null)) return unknown("room", "room-player-scores-unresolved");
    score = players.reduce((total, player) => total + intScore(player.liveScore!), 0);
    intScore(score); // Reject unsupported LINQ signed-overflow cases explicitly.
    count =
      input.rankTargetPlayerCount ??
      (players.every((player) => player.disConnected !== null)
        ? players.filter((player) => !player.disConnected).length
        : null);
    if (count === null) return unknown("room", "rank-target-player-count-unresolved");
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("rank-player-count");
  } else {
    if (input.soloScore === null) return unknown("personal", "solo-score-unresolved");
    score = intScore(input.soloScore);
  }
  const threshold = (row: NativeScoreRankRow) =>
    room ? battleScoreThreshold(row.battleRequiredScore, count!) : intScore(row.requiredScore);
  let rank =
    input.rows
      .filter((row) => threshold(row) <= score)
      .sort((a, b) => a.rank - b.rank)
      .at(-1)?.rank ?? 0;
  if (room && rank === 1) rank = 2; // Native BattleLive converts E to D.
  const ssThreshold = ss ? threshold(ss) : null;
  return {
    domain: room ? "room" : "personal",
    score,
    ssThreshold,
    rank,
    rankTargetPlayerCount: count,
    gaps:
      ssThreshold !== null && ssThreshold > 0
        ? []
        : [{ code: "positive-ss-threshold-unresolved", source: "same-release native rank group" }],
  };
}
/** Numerator and threshold must have the same native score domain. */
export function calculateSSRatio(
  score: number | null,
  threshold: number | null,
  scoreDomain: "personal" | "room",
  thresholdDomain: "personal" | "room",
): number | null {
  if (
    scoreDomain !== thresholdDomain ||
    score === null ||
    threshold === null ||
    !Number.isFinite(score) ||
    !Number.isFinite(threshold) ||
    score < 0 ||
    threshold <= 0
  )
    return null;
  return score / threshold;
}
