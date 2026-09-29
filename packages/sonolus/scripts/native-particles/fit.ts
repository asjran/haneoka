// Least-squares fitting of Sonolus particle channels. A channel is
// `from + (to - from) * ease(q)` where `from` and `to` are linear in the
// instance's random values r1..r8 (particle property expressions). One fit
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

/** Linear expression over c and r1..r8; index 0 is the constant. */
export type Expression = number[];

export interface ChannelFit {
  from: Expression;
  to: Expression;
  ease: EaseName;
  rms: number;
  max: number;
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
        const phi = k === 0 ? 1 : observation.r[features[k - 1]!]!;
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
        const phi = k === 0 ? 1 : observation.r[features[k - 1]!]!;
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
        const expression = new Array<number>(9).fill(0);
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
  for (let k = 1; k < expression.length; k += 1) value += Math.min(0, expression[k]!);
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
    json[index === 0 ? "c" : `r${index}`] = rounded;
  });
  return json;
}

/** Maximum of an expression over r in [0, 1]^8. */
export function expressionMaximum(expression: Expression): number {
  let value = expression[0]!;
  for (let k = 1; k < expression.length; k += 1) value += Math.max(0, expression[k]!);
  return value;
}

/** Scale random terms down so the channel never exceeds `ceiling` for any r. */
export function capToCeiling(fit: ChannelFit, ceiling: number): ChannelFit {
  const cap = (expression: Expression): Expression => {
    const high = expressionMaximum(expression);
    if (high <= ceiling) return expression;
    const random = high - expression[0]!;
    if (random <= 1e-12) return [ceiling, ...expression.slice(1)];
    const factor = Math.max(0, (ceiling - expression[0]!) / random);
    return expression.map((value, index) => (index === 0 ? Math.min(value, ceiling) : value > 0 ? value * factor : value));
  };
  return { ...fit, from: cap(fit.from), to: cap(fit.to) };
}
