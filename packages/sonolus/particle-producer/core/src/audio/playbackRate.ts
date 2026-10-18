export const MIN_PLAYBACK_RATE = 0.25;
export const MAX_PLAYBACK_RATE = 4;
export const DEFAULT_PLAYBACK_RATE = 1;

/** One playback-rate policy shared by media, input timing, and stage video. */
export function normalizePlaybackRate(value: number, fallback = DEFAULT_PLAYBACK_RATE): number {
  const normalizedFallback = Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_PLAYBACK_RATE;
  const numeric = Number.isFinite(value) && value > 0 ? value : normalizedFallback;
  return Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, numeric));
}
