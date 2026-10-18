export type TimingTag = string | number;

export interface TimingWindow<Judgement extends TimingTag> {
  readonly judgement: Judgement;
  /** Inclusive early extent in milliseconds. Array order defines priority. */
  readonly before: number;
  /** Inclusive late extent in milliseconds. Windows need not be nested. */
  readonly after: number;
}

export interface TimingResult<Judgement extends TimingTag, Timing extends TimingTag> {
  readonly judgement: Judgement;
  readonly timing: Timing;
}

export interface TimingPolicyOptions<Judgement extends TimingTag, Timing extends TimingTag> {
  readonly windows: Readonly<Record<string | number, readonly TimingWindow<Judgement>[] | undefined>>;
  readonly miss: Judgement;
  readonly timing: { readonly none: Timing; readonly fast: Timing; readonly late: Timing; readonly outOfTime: Timing };
  /** Timing-display neutral interval; defaults to an exact zero difference. */
  readonly neutralWindowMs?: number;
}

export interface TimingPolicy<Judgement extends TimingTag, Timing extends TimingTag> {
  /** Returns a stable immutable result without allocating a result object on each hit. */
  judge(noteType: string | number, diffMs: number): TimingResult<Judgement, Timing>;
  maximumEarlyWindow(noteType: string | number): number;
  maximumLateWindow(noteType: string | number): number;
}

const extent = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and nonnegative`);
  return value;
};

/** Compile one explicit game's timing data without game imports or global caches. */
export function createTimingPolicy<Judgement extends TimingTag, Timing extends TimingTag>(
  options: TimingPolicyOptions<Judgement, Timing>,
): TimingPolicy<Judgement, Timing> {
  const neutral = extent(options.neutralWindowMs ?? 0, "neutralWindowMs");
  const makeResult = (judgement: Judgement, timing: Timing): TimingResult<Judgement, Timing> =>
    Object.freeze({ judgement, timing });
  const miss = makeResult(options.miss, options.timing.outOfTime);
  const profiles = new Map<
    string,
    {
      windows: Array<{
        before: number;
        after: number;
        none: TimingResult<Judgement, Timing>;
        fast: TimingResult<Judgement, Timing>;
        late: TimingResult<Judgement, Timing>;
      }>;
      early: number;
      late: number;
    }
  >();
  for (const [type, input] of Object.entries(options.windows)) {
    if (input === undefined) continue;
    if (!Array.isArray(input)) throw new TypeError(`Timing windows for ${type} must be an array`);
    const windows = input.map((window) => ({
      before: extent(window.before, `${type}.before`),
      after: extent(window.after, `${type}.after`),
      none: makeResult(window.judgement, options.timing.none),
      fast: makeResult(window.judgement, options.timing.fast),
      late: makeResult(window.judgement, options.timing.late),
    }));
    profiles.set(type, {
      windows,
      early: windows.reduce((maximum, window) => Math.max(maximum, window.before), 0),
      late: windows.reduce((maximum, window) => Math.max(maximum, window.after), 0),
    });
  }
  return Object.freeze({
    judge(noteType: string | number, diffMs: number): TimingResult<Judgement, Timing> {
      if (!Number.isFinite(diffMs)) return miss;
      const profile = profiles.get(String(noteType));
      if (!profile) return miss;
      for (const window of profile.windows) {
        if (diffMs < -window.before || diffMs > window.after) continue;
        return Math.abs(diffMs) <= neutral ? window.none : diffMs > neutral ? window.late : window.fast;
      }
      return miss;
    },
    maximumEarlyWindow: (noteType: string | number): number => profiles.get(String(noteType))?.early ?? 0,
    maximumLateWindow: (noteType: string | number): number => profiles.get(String(noteType))?.late ?? 0,
  });
}
