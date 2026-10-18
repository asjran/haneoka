import type { WatchVisualReplayContract } from "./types.js";

/** Validates the caller's actual repeated source clock once per seek. */
export function inspectWatchReplay(
  timeMs: number,
  replay: WatchVisualReplayContract,
) {
  if (
    typeof replay.sourceKey !== "string" ||
    !replay.sourceKey.trim() ||
    (replay.clockMode !== "fresh-reference" &&
      replay.clockMode !== "canonical-rebuild") ||
    !Number.isFinite(replay.originSeconds) ||
    !Number.isFinite(replay.stepSeconds) ||
    replay.stepSeconds <= 0 ||
    !Number.isFinite(replay.inputOffsetMs) ||
    !Array.isArray(replay.tickTimesMs)
  ) {
    throw new TypeError(
      "Watch visual replay requires an explicit source clock contract",
    );
  }
  let previous = -Infinity,
    seconds = replay.originSeconds,
    sampledTimeMs: number | undefined;
  for (const tick of replay.tickTimesMs) {
    const nextSeconds = seconds + replay.stepSeconds;
    if (
      !Number.isSafeInteger(tick) ||
      tick < previous ||
      nextSeconds <= seconds ||
      tick !== Math.trunc(nextSeconds * 1000)
    )
      throw new TypeError(
        "Watch visual replay ticks must match the declared repeated source clock",
      );
    seconds = nextSeconds;
    previous = tick;
    if (tick <= timeMs) sampledTimeMs = tick;
  }
  if (Math.trunc((seconds + replay.stepSeconds) * 1000) <= timeMs)
    throw new TypeError(
      "Watch visual replay ticks do not cover the seek target",
    );
  return { sampledTimeMs };
}

export function watchReplayObservation(
  noteTimeMs: number,
  replay: WatchVisualReplayContract,
  strict: boolean,
): number | undefined {
  const time = noteTimeMs + replay.inputOffsetMs;
  let low = 0,
    high = replay.tickTimesMs.length;
  while (low < high) {
    const middle = (low + high) >>> 1,
      tick = replay.tickTimesMs[middle]!;
    if (strict ? tick <= time : tick < time) low = middle + 1;
    else high = middle;
  }
  return replay.tickTimesMs[low];
}
