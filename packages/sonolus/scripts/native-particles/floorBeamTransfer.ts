export type Rgb = readonly [number, number, number];
export interface TintWeight {
  rgb: Rgb;
  alpha: number;
  weight: number;
}
export interface BeamTransfer {
  rgba: readonly [number, number, number, number];
  sourceOverError: number;
  compensatedError: number;
}

/** Fit native alpha blending to the clipped Source additive result across actual tint/alpha phases. */
export function prepareBeamTransfer(tints: readonly TintWeight[], background: Rgb) {
  const total = tints.reduce((sum, tint) => sum + tint.weight, 0);
  const moments = background.map((b, c) => {
    const samples = tints.map((tint) => ({
      x: tint.alpha * tint.rgb[c]!,
      z: tint.alpha * b,
      weight: tint.weight / total,
    }));
    const x2 = samples.reduce((sum, s) => sum + s.weight * s.x * s.x, 0);
    const xz = samples.reduce((sum, s) => sum + s.weight * s.x * s.z, 0);
    const z2 = samples.reduce((sum, s) => sum + s.weight * s.z * s.z, 0);
    return {
      b,
      samples,
      x2,
      xz,
      z2,
      offset: x2 > 0 ? xz / x2 : 0,
      cappedSquare: Math.max(0, x2 - 2 * xz + z2),
      freeSquare: Math.max(0, z2 - (x2 > 0 ? (xz * xz) / x2 : 0)),
    };
  });
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const cache = new Map<number, BeamTransfer>();
  return (rgba: readonly [number, number, number, number]): BeamTransfer => {
    const key = ((rgba[0] << 24) | (rgba[1] << 16) | (rgba[2] << 8) | rgba[3]) >>> 0;
    const cached = cache.get(key);
    if (cached) return cached;
    const sourceAlpha = rgba[3] / 255;
    if (sourceAlpha === 0) return { rgba, sourceOverError: 0, compensatedError: 0 };
    const energy = [0, 1, 2].map((c) => (rgba[c]! / 255) * sourceAlpha);
    const desired = moments.map((m, c) => {
      let xt = 0,
        zt = 0,
        t2 = 0;
      for (const s of m.samples) {
        const target = Math.min(1 - m.b, energy[c]! * s.x);
        xt += s.weight * s.x * target;
        zt += s.weight * s.z * target;
        t2 += s.weight * target * target;
      }
      return { xt, zt, t2, gain: m.x2 > 0 ? xt / m.x2 : 0 };
    });
    const thresholds = moments.map((m, c) => (m.offset < 1 ? desired[c]!.gain / (1 - m.offset) : Infinity));
    const boundaries = [...new Set([0, 1, ...thresholds.filter((a) => a > 0 && a < 1)])].sort((a, b) => a - b);
    const errorAt = (alpha: number, rgb: Rgb) =>
      moments.reduce((sum, m, c) => {
        const r = rgb[c]!,
          t = desired[c]!;
        return sum + alpha * alpha * (r * r * m.x2 - 2 * r * m.xz + m.z2) - 2 * alpha * (r * t.xt - t.zt) + t.t2;
      }, 0);
    const colourAt = (alpha: number): [number, number, number] =>
      moments.map((m, c) => clamp(alpha > 0 ? desired[c]!.gain / alpha + m.offset : 0)) as [number, number, number];
    let bestAlpha = 0,
      bestError = Infinity;
    // Each RGB unit-bound threshold divides the opacity objective into quadratic pieces.
    for (let i = 1; i < boundaries.length; i++) {
      const low = boundaries[i - 1]!,
        high = boundaries[i]!,
        middle = (low + high) / 2;
      let square = 0,
        dot = 0;
      for (let c = 0; c < 3; c++) {
        const m = moments[c]!,
          t = desired[c]!;
        if (middle <= thresholds[c]!) {
          square += m.cappedSquare;
          dot += t.xt - t.zt;
        } else {
          square += m.freeSquare;
          dot += m.offset * t.xt - t.zt;
        }
      }
      const alpha = Math.max(low, Math.min(high, square > 1e-12 ? dot / square : low));
      const error = errorAt(alpha, colourAt(alpha));
      if (error < bestError - 1e-12 || (Math.abs(error - bestError) <= 1e-12 && alpha < bestAlpha)) {
        bestError = error;
        bestAlpha = alpha;
      }
    }
    const candidates = [...new Set([Math.floor(bestAlpha * 255), Math.ceil(bestAlpha * 255)])];
    let output: readonly [number, number, number, number] = rgba,
      quantizedError = Infinity;
    for (const byteAlpha of candidates) {
      const alpha = byteAlpha / 255;
      const rgb = colourAt(alpha).map((value) => Math.round(value * 255)) as [number, number, number];
      const error = errorAt(alpha, rgb.map((value) => value / 255) as [number, number, number]);
      if (error < quantizedError) {
        quantizedError = error;
        output = [...rgb, byteAlpha];
      }
    }
    const result = {
      rgba: output,
      sourceOverError: Math.max(
        0,
        errorAt(sourceAlpha, rgba.slice(0, 3).map((value) => value / 255) as [number, number, number]),
      ),
      compensatedError: Math.max(0, quantizedError),
    };
    cache.set(key, result);
    return result;
  };
}
