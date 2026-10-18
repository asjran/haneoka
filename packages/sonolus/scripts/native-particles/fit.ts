// Least-squares fitting of Sonolus particle channels. A channel is
// `from + (to - from) * ease(q)` where `from` and `to` are linear in the
// instance's random values and their sine/cosine basis. One fit
// shares a single ease across every particle of a cohort.

export type EaseName =
  | "linear"
  | "none"
  | `${"in" | "out" | "inOut" | "outIn"}${"Sine" | "Quad" | "Cubic" | "Quart" | "Quint" | "Expo" | "Circ" | "Back"}`;

const C1 = 1.70158;
const C3 = C1 + 1;
const IN: Record<string, (t: number) => number> = {
  Sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  Quad: (t) => t * t,
  Cubic: (t) => t ** 3,
  Quart: (t) => t ** 4,
  Quint: (t) => t ** 5,
  Expo: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  Circ: (t) => 1 - Math.sqrt(Math.max(0, 1 - t * t)),
  Back: (t) => C3 * t ** 3 - C1 * t * t,
};
const IN_DERIVATIVE: Record<string, (t: number) => number> = {
  Sine: (t) => Math.PI / 2 * Math.sin(t * Math.PI / 2),
  Quad: (t) => 2 * t,
  Cubic: (t) => 3 * t * t,
  Quart: (t) => 4 * t ** 3,
  Quint: (t) => 5 * t ** 4,
  Expo: (t) => 10 * Math.LN2 * 2 ** (10 * t - 10),
  Circ: (t) => t / Math.sqrt(Math.max(0, 1 - t * t)),
};

function easeDerivative(name: EaseName, t: number): number {
  if (name === "linear") return 1;
  const match = /^(inOut|outIn|in|out)([A-Z]\w*)$/.exec(name);
  const derivative = match && IN_DERIVATIVE[match[2]!];
  if (!derivative) throw new Error(`Continuous fit does not support ${name}`);
  switch (match![1]) {
    case "in": return derivative(t);
    case "out": return derivative(1 - t);
    case "inOut": return t < .5 ? derivative(2 * t) : derivative(2 - 2 * t);
    default: return t < .5 ? derivative(1 - 2 * t) : derivative(2 * t - 1);
  }
}

/** Continuous maximum against the piecewise-linear observations, including easing extrema. */
function linearEnvelopeError(observations: readonly Observation[], from: number, to: number, name: EaseName): number {
  const delta = to - from;
  let maximum = 0;
  for (let i = 1; i < observations.length; i++) {
    const a = observations[i - 1]!, b = observations[i]!;
    if (b.q <= a.q) continue;
    const slope = (b.v - a.v) / (b.q - a.q);
    const error = (q: number) => Math.abs(from + delta * ease(name, q) - a.v - slope * (q - a.q));
    const cuts = a.q < .5 && b.q > .5 ? [a.q, .5, b.q] : [a.q, b.q];
    for (let j = 1; j < cuts.length; j++) {
      let left = cuts[j - 1]!, right = cuts[j]!;
      maximum = Math.max(maximum, error(left), error(right));
      if (name === "linear" || delta === 0) continue;
      // Expo has endpoint limits; the other supported eases are continuous.
      const epsilon = Math.min(1e-12, (right - left) / 1024);
      left += epsilon; right -= epsilon;
      maximum = Math.max(maximum, error(left), error(right));
      const derivative = (q: number) => delta * easeDerivative(name, q) - slope;
      const sign = Math.sign(derivative(left));
      if (sign === Math.sign(derivative(right))) continue;
      for (let step = 0; step < 48; step++) {
        const middle = (left + right) / 2;
        if (Math.sign(derivative(middle)) === sign) left = middle;
        else right = middle;
      }
      maximum = Math.max(maximum, error((left + right) / 2));
    }
  }
  return maximum + 1e-12;
}

/** Sonolus easing semantics (outIn = out on the first half, in on the second). */
export function ease(name: EaseName, t: number): number {
  if (name === "linear") return t;
  if (name === "none") return t >= 1 ? 1 : 0;
  const match = /^(inOut|outIn|in|out)([A-Z]\w*)$/.exec(name)!;
  const fin = IN[match[2]!]!;
  const fout = (x: number) => 1 - fin(1 - x);
  switch (match[1]) {
    case "in":
      return fin(t);
    case "out":
      return fout(t);
    case "inOut":
      return t < 0.5 ? fin(2 * t) / 2 : 1 - fin(2 - 2 * t) / 2;
    default:
      return t < 0.5 ? fout(2 * t) / 2 : 0.5 + fin(2 * t - 1) / 2;
  }
}

export const EASES: readonly EaseName[] = [
  "linear",
  ...(["Sine", "Quad", "Cubic", "Quart", "Quint", "Expo", "Circ"] as const).flatMap(
    (family) => [`in${family}`, `out${family}`, `inOut${family}`, `outIn${family}`] as EaseName[],
  ),
];

/** One observation: normalized time, random features (r1..r8), value. */
export interface Observation {
  q: number;
  r: readonly number[];
  v: number;
  /** Relative weight (defaults to 1). */
  w?: number;
}

/** Coefficients of c, r1..r8, sinr1..sinr8 and cosr1..cosr8. */
export type Expression = number[];

/** Feature indices: r1..r8, sinr1..sinr8, cosr1..cosr8. */
export function randomFeature(draws: readonly number[], feature: number): number {
  if (feature < 8) return draws[feature]!;
  const angle = 2 * Math.PI * draws[feature % 8]!;
  return feature < 16 ? Math.sin(angle) : Math.cos(angle);
}

export function expressionValue(expression: Expression, draws: readonly number[]): number {
  return expression.reduce(
    (sum, coefficient, index) =>
      coefficient === 0 ? sum : sum + coefficient * (index === 0 ? 1 : randomFeature(draws, index - 1)),
    0,
  );
}

export interface ChannelFit {
  from: Expression;
  to: Expression;
  ease: EaseName;
  rms: number;
  max: number;
}

/** A sampled path owns its endpoints; only its interpolation ease is fitted. */
export function fitAnchoredChannel(
  observations: readonly Observation[],
  eases: readonly EaseName[] = EASES,
  metric: "rms" | "max" = "rms",
  maximumError = Infinity,
): ChannelFit {
  const first = observations.find((value) => Math.abs(value.q) < 1e-9);
  const last = observations.find((value) => Math.abs(value.q - 1) < 1e-9);
  if (!first || !last) throw new Error("Sampled particle channel requires both endpoints");
  if (observations.every((observation) => observation.v === first.v))
    return { from: [first.v], to: [last.v], ease: "linear", rms: 0, max: 0 };
  let best: ChannelFit | undefined;
  for (const name of eases) {
    let squared = 0,
      weight = 0,
      maximum = 0;
    for (const observation of observations) {
      const error = Math.abs(first.v + (last.v - first.v) * ease(name, observation.q) - observation.v);
      squared += (observation.w ?? 1) * error * error;
      weight += observation.w ?? 1;
      maximum = Math.max(maximum, error);
    }
    if (metric === "max" && maximum <= maximumError && (!best || maximum < best.max))
      maximum = Math.max(maximum, linearEnvelopeError(observations, first.v, last.v, name));
    const rms = Math.sqrt(squared / Math.max(1e-12, weight));
    if (!best || (metric === "max" ? maximum < best.max - 1e-12 : rms < best.rms - 1e-12))
      best = { from: [first.v], to: [last.v], ease: name, rms, max: maximum };
  }
  return best!;
}

function solve(matrix: Float64Array, vector: Float64Array, size: number): Float64Array | undefined {
  // Gaussian elimination with partial pivoting on a copy.
  const a = Float64Array.from(matrix);
  const b = Float64Array.from(vector);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1)
      if (Math.abs(a[row * size + column]!) > Math.abs(a[pivot * size + column]!)) pivot = row;
    const value = a[pivot * size + column]!;
    if (Math.abs(value) < 1e-12) return undefined;
    if (pivot !== column) {
      for (let k = 0; k < size; k += 1) {
        const tmp = a[column * size + k]!;
        a[column * size + k] = a[pivot * size + k]!;
        a[pivot * size + k] = tmp;
      }
      const tmp = b[column]!;
      b[column] = b[pivot]!;
      b[pivot] = tmp;
    }
    for (let row = column + 1; row < size; row += 1) {
      const factor = a[row * size + column]! / a[column * size + column]!;
      if (factor === 0) continue;
      for (let k = column; k < size; k += 1) a[row * size + k] = a[row * size + k]! - factor * a[column * size + k]!;
      b[row] = b[row]! - factor * b[column]!;
    }
  }
  const x = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = b[row]!;
    for (let k = row + 1; k < size; k += 1) sum -= a[row * size + k]! * x[k]!;
    x[row] = sum / a[row * size + row]!;
  }
  return x;
}

/**
 * Fit one channel. `features` selects which random values may appear in the
 * expressions (indices into r, 0-based); the constant is always present.
 */
export function fitChannel(
  observations: readonly Observation[],
  features: readonly number[],
  eases: readonly EaseName[] = EASES,
): ChannelFit {
  const basis = features.length + 1;
  const size = basis * 2;
  let best: ChannelFit | undefined;
  const row = new Float64Array(size);
  for (const easeName of eases) {
    const normal = new Float64Array(size * size);
    const rhs = new Float64Array(size);
    for (const observation of observations) {
      const e = ease(easeName, observation.q);
      const weight = observation.w ?? 1;
      for (let k = 0; k < basis; k += 1) {
        const phi = k === 0 ? 1 : randomFeature(observation.r, features[k - 1]!);
        row[k] = phi * (1 - e);
        row[basis + k] = phi * e;
      }
      for (let i = 0; i < size; i += 1) {
        const ri = row[i]! * weight;
        if (ri === 0) continue;
        rhs[i] = rhs[i]! + ri * observation.v;
        for (let j = i; j < size; j += 1) normal[i * size + j] = normal[i * size + j]! + ri * row[j]!;
      }
    }
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < i; j += 1) normal[i * size + j] = normal[j * size + i]!;
      // Light ridge keeps unobservable random terms at zero.
      normal[i * size + i] = normal[i * size + i]! + 1e-7;
    }
    const x = solve(normal, rhs, size);
    if (!x) continue;
    let squared = 0;
    let total = 0;
    let max = 0;
    for (const observation of observations) {
      const e = ease(easeName, observation.q);
      let predicted = 0;
      for (let k = 0; k < basis; k += 1) {
        const phi = k === 0 ? 1 : randomFeature(observation.r, features[k - 1]!);
        predicted += phi * (x[k]! * (1 - e) + x[basis + k]! * e);
      }
      const error = Math.abs(predicted - observation.v);
      const weight = observation.w ?? 1;
      squared += weight * error * error;
      total += weight;
      max = Math.max(max, error);
    }
    const rms = Math.sqrt(squared / Math.max(total, 1e-12));
    if (!best || rms < best.rms - 1e-12) {
      const expand = (offset: number): Expression => {
        const expression = new Array<number>(Math.max(9, ...features.map((feature) => feature + 2))).fill(0);
        expression[0] = x[offset]!;
        features.forEach((feature, index) => (expression[feature + 1] = x[offset + index + 1]!));
        return expression;
      };
      best = { from: expand(0), to: expand(basis), ease: easeName, rms, max };
    }
  }
  if (!best) {
    const mean = observations.reduce((sum, observation) => sum + observation.v, 0) / Math.max(1, observations.length);
    const constant = [mean, 0, 0, 0, 0, 0, 0, 0, 0];
    return { from: constant, to: constant.slice(), ease: "linear", rms: 0, max: 0 };
  }
  return best;
}

/** Minimum of an expression over r in [0, 1]^8. */
export function expressionMinimum(expression: Expression): number {
  let value = expression[0]!;
  for (let k = 1; k <= Math.min(8, expression.length - 1); k += 1) value += Math.min(0, expression[k]!);
  for (let k = 0; k < 8; k += 1) value -= Math.hypot(expression[k + 9] ?? 0, expression[k + 17] ?? 0);
  return value;
}

/** Clamp an expression pair so the channel never goes below `floor` for any r. */
export function raiseToFloor(fit: ChannelFit, floor = 0): ChannelFit {
  const from = fit.from.slice();
  const to = fit.to.slice();
  const lowFrom = expressionMinimum(from);
  const lowTo = expressionMinimum(to);
  if (lowFrom < floor) from[0] = from[0]! + (floor - lowFrom);
  if (lowTo < floor) to[0] = to[0]! + (floor - lowTo);
  return { ...fit, from, to };
}

/** Sonolus JSON for an expression; zero terms are omitted. */
export function expressionJson(expression: Expression, digits = 4): Record<string, number> {
  const scale = 10 ** digits;
  const json: Record<string, number> = {};
  expression.forEach((value, index) => {
    const rounded = Math.round(value * scale) / scale;
    if (rounded === 0) return;
    const key = index === 0 ? "c" : index <= 8 ? `r${index}` : index <= 16 ? `sinr${index - 8}` : `cosr${index - 16}`;
    json[key] = rounded;
  });
  return json;
}

/** Maximum of an expression over r in [0, 1]^8. */
export function expressionMaximum(expression: Expression): number {
  let value = expression[0]!;
  for (let k = 1; k <= Math.min(8, expression.length - 1); k += 1) value += Math.max(0, expression[k]!);
  for (let k = 0; k < 8; k += 1) value += Math.hypot(expression[k + 9] ?? 0, expression[k + 17] ?? 0);
  return value;
}

/** Keep every native random endpoint in a measured source position interval. */
export function capToBounds(fit: ChannelFit, minimum: number, maximum: number): ChannelFit {
  const cap = (expression: Expression): Expression => {
    const low = expressionMinimum(expression),
      high = expressionMaximum(expression);
    if (low >= minimum && high <= maximum) return expression;
    const factor = Math.min(1, (maximum - minimum) / Math.max(1e-12, high - low));
    const terms = expression.slice(1).map((value) => value * factor);
    const constantLow = minimum - expressionMinimum([0, ...terms]);
    const constantHigh = maximum - expressionMaximum([0, ...terms]);
    return [Math.max(constantLow, Math.min(constantHigh, expression[0]!)), ...terms];
  };
  return { ...fit, from: cap(fit.from), to: cap(fit.to) };
}

/** Cap a channel, retaining a nonnegative floor when the ceiling allows it. */
export function capToCeiling(fit: ChannelFit, ceiling: number): ChannelFit {
  const cap = (expression: Expression): Expression => {
    const high = expressionMaximum(expression);
    if (high <= ceiling) return expression;
    // Lowering only the constant/positive terms can make negative random
    // coefficients cross the floor established by raiseToFloor. Fit all
    // random terms into the available range, then choose a feasible constant.
    const low = expressionMinimum(expression);
    const floor = Math.min(0, low, ceiling);
    const factor = Math.min(1, (ceiling - floor) / Math.max(1e-12, high - low));
    const terms = expression.slice(1).map((value) => value * factor);
    const minimumConstant = floor - expressionMinimum([0, ...terms]);
    const maximumConstant = ceiling - expressionMaximum([0, ...terms]);
    return [Math.max(minimumConstant, Math.min(maximumConstant, expression[0]!)), ...terms];
  };
  return { ...fit, from: cap(fit.from), to: cap(fit.to) };
}
