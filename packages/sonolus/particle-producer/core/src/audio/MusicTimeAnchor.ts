/**
 * Convert a DOM event timestamp to the same monotonic epoch as
 * `performance.now()`. Modern browsers already use that epoch; the absolute
 * timestamp branch keeps older WebKit events deterministic.
 */
export function normalizeEventRealtimeMs(
  timeStamp: number,
  currentRealtimeMs = performance.now(),
  timeOriginMs = performance.timeOrigin,
): number {
  if (!Number.isFinite(timeStamp) || timeStamp <= 0) return currentRealtimeMs;
  const monotonic = timeStamp > 1_000_000_000_000 ? timeStamp - timeOriginMs : timeStamp;
  return Number.isFinite(monotonic) ? monotonic : currentRealtimeMs;
}

/**
 * A frame-stable mapping from realtime input timestamps to music time.
 *
 * Sampling once per rendered simulation frame reproduces
 * `inputRealtime - frameRealtime + frameMusicTime` without reading the media
 * element late inside an input callback.
 */
export class MusicTimeAnchor {
  private frameRealtimeMs = 0;
  private frameMusicTimeMs = -1;
  private framePlaybackRate = 1;
  private sampled = false;

  sample(frameMusicTimeMs: number, frameRealtimeMs = performance.now(), playbackRate = 1): void {
    if (
      !Number.isFinite(frameMusicTimeMs) ||
      !Number.isFinite(frameRealtimeMs) ||
      !Number.isFinite(playbackRate) ||
      playbackRate <= 0
    )
      return;
    this.frameMusicTimeMs = Math.floor(frameMusicTimeMs);
    this.frameRealtimeMs = Math.floor(frameRealtimeMs);
    this.framePlaybackRate = playbackRate;
    this.sampled = true;
  }

  timeAt(inputRealtimeMs: number, fallbackMusicTimeMs: number): number {
    if (!this.sampled || !Number.isFinite(inputRealtimeMs)) return Math.floor(fallbackMusicTimeMs);
    const elapsedRealtimeMs = Math.floor(inputRealtimeMs) - this.frameRealtimeMs;
    return Math.floor(this.frameMusicTimeMs + elapsedRealtimeMs * this.framePlaybackRate);
  }

  reset(): void {
    this.sampled = false;
    this.frameRealtimeMs = 0;
    this.frameMusicTimeMs = -1;
    this.framePlaybackRate = 1;
  }
}

/** Last-valid music time used when an output clock is temporarily unavailable. */
export class MusicSyncTimeCache {
  private hasSoundInfo = false;
  private cachedTimeMs = -1;

  setSoundInfo(available: boolean): void {
    this.hasSoundInfo = available;
    this.cachedTimeMs = -1;
  }

  read(playbackUsable: boolean, sampledTimeMs?: number): number {
    if (!this.hasSoundInfo) return -1;
    if (playbackUsable && sampledTimeMs !== undefined && Number.isFinite(sampledTimeMs)) {
      this.cachedTimeMs = Math.floor(sampledTimeMs);
    }
    return this.cachedTimeMs;
  }

  seek(timeMs: number): number {
    if (!this.hasSoundInfo || !Number.isFinite(timeMs)) return this.cachedTimeMs;
    this.cachedTimeMs = Math.floor(timeMs);
    return this.cachedTimeMs;
  }
}
