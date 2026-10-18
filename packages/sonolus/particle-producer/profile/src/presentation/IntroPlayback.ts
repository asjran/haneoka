export type NativeIntroPlaybackPhase = "idle" | "playing" | "paused" | "complete";

/**
 * Separate pre-music timeline. A real host monotonic timestamp is supplied;
 * this object never seeks or rewrites the media clock or chart session.
 */
export class NativeIntroPlayback {
  private phaseValue: NativeIntroPlaybackPhase = "idle";
  private elapsedValue = 0;
  private anchorMs = 0;
  private rateValue = 1;
  private pendingRealtimeSeconds = 0;
  private readonly fixedDelta = 1 / 60;

  constructor(readonly durationSeconds: number) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Original intro duration is invalid");
  }
  get phase(): NativeIntroPlaybackPhase { return this.phaseValue; }
  get playbackRate(): number { return this.rateValue; }

  start(nowMs: number): boolean {
    this.validateTime(nowMs);
    if (this.phaseValue === "complete") return false;
    if (this.phaseValue !== "playing") {
      this.anchorMs = nowMs;
      this.phaseValue = "playing";
    }
    return true;
  }
  pause(nowMs: number): void {
    this.sample(nowMs);
    if (this.phaseValue === "playing") this.phaseValue = "paused";
  }
  setRate(rate: number, nowMs: number): void {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("Intro playback rate is invalid");
    this.sample(nowMs);
    this.rateValue = rate;
  }
  sample(nowMs: number): number {
    this.validateTime(nowMs);
    if (this.phaseValue !== "playing") return this.elapsedValue;
    if (nowMs < this.anchorMs) throw new Error("Intro host clock moved backwards");
    this.pendingRealtimeSeconds += (nowMs - this.anchorMs) / 1000;
    this.anchorMs = nowMs;
    // The real pre-roll follows the reference's repeated double fixed ticks.
    // Render sampling does not invent extra animation steps at high refresh rates.
    while (this.pendingRealtimeSeconds >= this.fixedDelta && this.elapsedValue < this.durationSeconds) {
      this.pendingRealtimeSeconds -= this.fixedDelta;
      this.elapsedValue = Math.min(this.durationSeconds, this.elapsedValue + this.fixedDelta * this.rateValue);
    }
    if (this.elapsedValue >= this.durationSeconds) this.phaseValue = "complete";
    return this.elapsedValue;
  }
  /** Normal transport seek skips the intro and starts from the settled music-start pose. */
  bypass(): void {
    this.elapsedValue = this.durationSeconds;
    this.pendingRealtimeSeconds = 0;
    this.phaseValue = "complete";
  }
  private validateTime(nowMs: number): void {
    if (!Number.isFinite(nowMs)) throw new Error("Intro requires a real monotonic host timestamp");
  }
}
