import type { OurNotesRendererStats } from "@haneoka/cassiopeia-plugin-our-notes";

export interface ChartPerfRange {
  min: number;
  p95: number;
  max: number;
}

export interface ChartPerfSummary {
  frameCount: number;
  sessionMs: ChartPerfRange;
  buildMs: ChartPerfRange;
  renderMs: ChartPerfRange;
  totalMs: ChartPerfRange;
  drawCalls: ChartPerfRange;
  triangles: ChartPerfRange;
  maximumActiveNotes: number;
  maximumActiveHolds: number;
  maximumRenderedParticles: number;
  effectRefreshFrames: number;
}

/**
 * Opt-in fixed-storage frame probe. ChartPlayer does not instantiate or call
 * it unless `settings.__perf` is true, keeping the normal render path free of
 * timers, closures and diagnostics allocations.
 */
export class ChartPerfProbe {
  private readonly capacity: number;
  private readonly intervalMs: number;
  private readonly sessionSamples: Float64Array;
  private readonly buildSamples: Float64Array;
  private readonly renderSamples: Float64Array;
  private readonly totalSamples: Float64Array;
  private readonly drawCallSamples: Float64Array;
  private readonly triangleSamples: Float64Array;
  private readonly noteSamples: Uint32Array;
  private readonly holdSamples: Uint32Array;
  private readonly particleSamples: Uint32Array;
  private readonly refreshSamples: Uint8Array;
  private readonly scratch: Float64Array;
  private count = 0;
  private cursor = 0;
  private lastSummaryAt = 0;

  constructor(capacity = 240, intervalMs = 500) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.intervalMs = Math.max(1, intervalMs);
    this.sessionSamples = new Float64Array(this.capacity);
    this.buildSamples = new Float64Array(this.capacity);
    this.renderSamples = new Float64Array(this.capacity);
    this.totalSamples = new Float64Array(this.capacity);
    this.drawCallSamples = new Float64Array(this.capacity);
    this.triangleSamples = new Float64Array(this.capacity);
    this.noteSamples = new Uint32Array(this.capacity);
    this.holdSamples = new Uint32Array(this.capacity);
    this.particleSamples = new Uint32Array(this.capacity);
    this.refreshSamples = new Uint8Array(this.capacity);
    this.scratch = new Float64Array(this.capacity);
  }

  record(sessionMs: number, buildMs: number, renderMs: number, totalMs: number, stats: OurNotesRendererStats): void {
    const index = this.cursor;
    this.sessionSamples[index] = sessionMs;
    this.buildSamples[index] = buildMs;
    this.renderSamples[index] = renderMs;
    this.totalSamples[index] = totalMs;
    this.drawCallSamples[index] = stats.drawCalls;
    this.triangleSamples[index] = stats.triangles;
    this.noteSamples[index] = stats.activeNoteVisuals;
    this.holdSamples[index] = stats.activeHoldVisuals;
    this.particleSamples[index] = stats.renderedParticles;
    this.refreshSamples[index] = stats.effectRefreshed ? 1 : 0;
    this.cursor = (index + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
  }

  takeSummary(now: number): ChartPerfSummary | undefined {
    if (this.count === 0) return undefined;
    if (this.lastSummaryAt === 0) {
      this.lastSummaryAt = now;
      return undefined;
    }
    if (now - this.lastSummaryAt < this.intervalMs) return undefined;
    this.lastSummaryAt = now;
    let maximumActiveNotes = 0;
    let maximumActiveHolds = 0;
    let maximumRenderedParticles = 0;
    let effectRefreshFrames = 0;
    for (let index = 0; index < this.count; index += 1) {
      maximumActiveNotes = Math.max(maximumActiveNotes, this.noteSamples[index]!);
      maximumActiveHolds = Math.max(maximumActiveHolds, this.holdSamples[index]!);
      maximumRenderedParticles = Math.max(maximumRenderedParticles, this.particleSamples[index]!);
      effectRefreshFrames += this.refreshSamples[index]!;
    }
    const summary = {
      frameCount: this.count,
      sessionMs: this.range(this.sessionSamples),
      buildMs: this.range(this.buildSamples),
      renderMs: this.range(this.renderSamples),
      totalMs: this.range(this.totalSamples),
      drawCalls: this.range(this.drawCallSamples),
      triangles: this.range(this.triangleSamples),
      maximumActiveNotes,
      maximumActiveHolds,
      maximumRenderedParticles,
      effectRefreshFrames,
    };
    this.count = 0;
    this.cursor = 0;
    return summary;
  }

  private range(samples: Float64Array): ChartPerfRange {
    for (let index = 0; index < this.count; index += 1) this.scratch[index] = samples[index]!;
    return this.sortedRange();
  }

  private sortedRange(): ChartPerfRange {
    // Insertion sort avoids allocating an Array/subarray on every debug
    // summary. At <=240 entries this is negligible and only runs opt-in.
    for (let index = 1; index < this.count; index += 1) {
      const value = this.scratch[index]!;
      let cursor = index - 1;
      while (cursor >= 0 && this.scratch[cursor]! > value) {
        this.scratch[cursor + 1] = this.scratch[cursor]!;
        cursor -= 1;
      }
      this.scratch[cursor + 1] = value;
    }
    return {
      min: this.scratch[0]!,
      p95: this.scratch[Math.min(this.count - 1, Math.ceil(this.count * 0.95) - 1)]!,
      max: this.scratch[this.count - 1]!,
    };
  }
}

interface GpuTimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
  readonly QUERY_COUNTER_BITS_EXT: number;
}
interface GpuQuerySlot {
  query: WebGLQuery | null;
  pending: boolean;
  frame: number;
  chartTimeMs: number;
  playing: boolean;
  tagged: boolean;
  effectRefreshed: boolean;
  drawCalls: number;
  particles: number;
}
export interface ChartGpuPerfSummary {
  supported: boolean;
  contextLost: boolean;
  metricSource: "EXT_disjoint_timer_query_webgl2 TIME_ELAPSED_EXT";
  sampleEveryFrames: number;
  sampleCount: number;
  pendingCount: number;
  skippedSamples: number;
  disjointDropped: number;
  invalidSamples: number;
  gpuRenderMs?: ChartPerfRange;
  chartWindowMs?: { start: number; end: number };
  playingOnly?: boolean;
  effectRefreshSamples: number;
  effectRefreshGpuMs?: ChartPerfRange;
  nonRefreshGpuMs?: ChartPerfRange;
  maximumRenderedParticles: number;
  maximumDrawCalls: number;
}

/** Diagnostic-only asynchronous GPU queries; the normal renderer never constructs this probe. */
export class ChartGpuTimerProbe {
  private extension?: GpuTimerExtension;
  private readonly slots: GpuQuerySlot[];
  private readonly samples = new Float64Array(240);
  private readonly chartTimes = new Float64Array(240);
  private readonly refresh = new Uint8Array(240);
  private readonly playing = new Uint8Array(240);
  private readonly particleCounts = new Uint32Array(240);
  private readonly drawCalls = new Uint32Array(240);
  private readonly scratch = new Float64Array(240);
  private sampleCount = 0;
  private sampleCursor = 0;
  private frame = 0;
  private active = -1;
  private lost = false;
  private disposed = false;
  private skipped = 0;
  private disjoint = 0;
  private invalid = 0;
  private readonly onLost = (): void => {
    this.lost = true;
    this.releasePool();
    this.sampleCount = 0;
    this.sampleCursor = 0;
  };
  private readonly onRestored = (): void => {
    this.lost = false;
    this.configure();
  };

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly sampleEveryFrames = 6,
    maxPending = 8,
  ) {
    this.slots = Array.from({ length: Math.min(8, Math.max(1, Math.trunc(maxPending))) }, () => ({
      query: null,
      pending: false,
      frame: 0,
      chartTimeMs: 0,
      playing: false,
      tagged: false,
      effectRefreshed: false,
      drawCalls: 0,
      particles: 0,
    }));
    this.configure();
    gl.canvas.addEventListener("webglcontextlost", this.onLost);
    gl.canvas.addEventListener("webglcontextrestored", this.onRestored);
  }

  private configure(): void {
    this.extension = undefined;
    if (this.disposed || this.gl.isContextLost()) return;
    const extension = this.gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (
      !extension ||
      typeof extension.TIME_ELAPSED_EXT !== "number" ||
      typeof extension.GPU_DISJOINT_EXT !== "number" ||
      typeof extension.QUERY_COUNTER_BITS_EXT !== "number"
    )
      return;
    if (!(Number(this.gl.getQuery(extension.TIME_ELAPSED_EXT, extension.QUERY_COUNTER_BITS_EXT)) > 0)) return;
    this.extension = {
      TIME_ELAPSED_EXT: extension.TIME_ELAPSED_EXT,
      GPU_DISJOINT_EXT: extension.GPU_DISJOINT_EXT,
      QUERY_COUNTER_BITS_EXT: extension.QUERY_COUNTER_BITS_EXT,
    };
    for (const slot of this.slots) slot.query = this.gl.createQuery();
  }

  /** Returns an owned query ticket; no query, extension or poll occurs on the default product path. */
  beginFrame(chartTimeMs: number, playing: boolean): number | undefined {
    this.frame += 1;
    if (this.disposed || !this.extension || this.frame % Math.max(1, this.sampleEveryFrames) !== 0) return;
    if (this.lost || this.gl.isContextLost()) return;
    if (this.gl.getQuery(this.extension.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) !== null) {
      this.skipped += 1;
      return;
    }
    if (!this.collect()) return;
    let index = -1;
    for (let candidate = 0; candidate < this.slots.length; candidate += 1) {
      if (this.slots[candidate]!.query && !this.slots[candidate]!.pending) {
        index = candidate;
        break;
      }
    }
    if (index < 0) {
      this.skipped += 1;
      return;
    }
    const slot = this.slots[index]!;
    const query = slot.query;
    if (!query) {
      this.skipped += 1;
      return;
    }
    slot.frame = this.frame;
    slot.chartTimeMs = chartTimeMs;
    slot.playing = playing;
    slot.tagged = false;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    this.active = index;
    return index;
  }

  endFrame(ticket: number | undefined): void {
    if (ticket === undefined || ticket !== this.active || !this.extension) return;
    const slot = this.slots[ticket]!;
    this.active = -1;
    if (this.lost || this.gl.isContextLost()) return;
    // Never end a query owned by another diagnostic consumer.
    if (this.gl.getQuery(this.extension.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) !== slot.query) {
      this.invalid += 1;
      return;
    }
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    slot.pending = true;
  }

  tagFrame(ticket: number | undefined, stats: OurNotesRendererStats): void {
    if (ticket === undefined) return;
    const slot = this.slots[ticket];
    if (!slot?.pending || stats.contextLost) return;
    slot.tagged = true;
    slot.effectRefreshed = stats.effectRefreshed;
    slot.drawCalls = stats.drawCalls;
    slot.particles = stats.renderedParticles;
  }

  private collect(): boolean {
    const extension = this.extension;
    if (!extension || this.lost || this.gl.isContextLost()) return false;
    if (this.gl.getQuery(extension.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) !== null) return false;
    if (this.gl.getParameter(extension.GPU_DISJOINT_EXT)) {
      this.disjoint += this.pendingCount();
      this.releasePool();
      this.sampleCount = 0;
      this.sampleCursor = 0;
      this.configure();
      return false;
    }
    for (const slot of this.slots) {
      // A query issued in this task is deliberately left for a later frame.
      if (!slot.pending || !slot.query || slot.frame >= this.frame) continue;
      if (!this.gl.getQueryParameter(slot.query, this.gl.QUERY_RESULT_AVAILABLE)) continue;
      const nanoseconds = this.gl.getQueryParameter(slot.query, this.gl.QUERY_RESULT);
      slot.pending = false;
      if (!slot.tagged || typeof nanoseconds !== "number" || !Number.isFinite(nanoseconds) || nanoseconds < 0) {
        this.invalid += 1;
        continue;
      }
      const index = this.sampleCursor;
      this.samples[index] = nanoseconds / 1_000_000;
      this.chartTimes[index] = slot.chartTimeMs;
      this.refresh[index] = slot.effectRefreshed ? 1 : 0;
      this.playing[index] = slot.playing ? 1 : 0;
      this.particleCounts[index] = slot.particles;
      this.drawCalls[index] = slot.drawCalls;
      this.sampleCursor = (index + 1) % this.samples.length;
      this.sampleCount = Math.min(this.samples.length, this.sampleCount + 1);
    }
    return true;
  }

  private pendingCount(): number {
    let count = 0;
    for (const slot of this.slots) if (slot.pending) count += 1;
    return count;
  }

  takeSummary(): ChartGpuPerfSummary {
    this.collect();
    let start = Infinity,
      end = -Infinity,
      playingOnly = true;
    let refreshed = 0,
      particles = 0,
      draws = 0;
    for (let index = 0; index < this.sampleCount; index += 1) {
      start = Math.min(start, this.chartTimes[index]!);
      end = Math.max(end, this.chartTimes[index]!);
      playingOnly &&= this.playing[index] === 1;
      refreshed += this.refresh[index]!;
      particles = Math.max(particles, this.particleCounts[index]!);
      draws = Math.max(draws, this.drawCalls[index]!);
    }
    const summary: ChartGpuPerfSummary = {
      supported: this.extension !== undefined,
      contextLost: this.lost || this.gl.isContextLost(),
      metricSource: "EXT_disjoint_timer_query_webgl2 TIME_ELAPSED_EXT",
      sampleEveryFrames: this.sampleEveryFrames,
      sampleCount: this.sampleCount,
      pendingCount: this.pendingCount(),
      skippedSamples: this.skipped,
      disjointDropped: this.disjoint,
      invalidSamples: this.invalid,
      effectRefreshSamples: refreshed,
      maximumRenderedParticles: particles,
      maximumDrawCalls: draws,
    };
    if (this.sampleCount > 0) {
      summary.gpuRenderMs = this.range();
      summary.chartWindowMs = { start, end };
      summary.playingOnly = playingOnly;
      summary.effectRefreshGpuMs = this.range(1);
      summary.nonRefreshGpuMs = this.range(0);
    }
    this.sampleCount = 0;
    this.sampleCursor = 0;
    return summary;
  }

  private range(refresh?: number): ChartPerfRange | undefined {
    let count = 0;
    for (let index = 0; index < this.sampleCount; index += 1) {
      if (refresh !== undefined && this.refresh[index] !== refresh) continue;
      const value = this.samples[index]!;
      let cursor = count;
      while (cursor > 0 && this.scratch[cursor - 1]! > value) {
        this.scratch[cursor] = this.scratch[cursor - 1]!;
        cursor -= 1;
      }
      this.scratch[cursor] = value;
      count += 1;
    }
    return count > 0
      ? { min: this.scratch[0]!, p95: this.scratch[Math.ceil(count * 0.95) - 1]!, max: this.scratch[count - 1]! }
      : undefined;
  }

  private releasePool(): void {
    const validContext = !this.gl.isContextLost();
    for (const slot of this.slots) {
      if (slot.query && validContext) this.gl.deleteQuery(slot.query);
      slot.query = null;
      slot.pending = false;
    }
    this.active = -1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.gl.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    if (
      this.active >= 0 &&
      this.extension &&
      !this.gl.isContextLost() &&
      this.gl.getQuery(this.extension.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) === this.slots[this.active]?.query
    ) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    }
    this.releasePool();
  }
}
