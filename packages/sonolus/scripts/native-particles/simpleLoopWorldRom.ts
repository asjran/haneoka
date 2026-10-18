import { projectSourceViewBillboard } from "../../../../.dependencies/sonolus-our-notes/shared/src/engine/data/sourceViewBillboard.ts";
import { createHash } from "node:crypto";
import { SIMPLE_LOOP_WORLD_ROM as ABI } from "../../../../.dependencies/sonolus-our-notes/shared/src/engine/data/simpleLoopWorldRomAbi.ts";

type Point = { x: number; y: number; z: number };
export interface WorldSourceSample {
  t: number;
  seed: number;
  emission: number;
  birth: number;
  lifetime: number;
  p: Point;
  size: { x: number; y: number };
  rotation: number;
  draws: number[];
  corners: Array<{ x: number; y: number }>;
}
export interface WorldSourceCapture {
  width: number;
  rows: WorldSourceSample[];
}
export interface SourceBirthRecord {
  seed: number;
  emission: number;
  sourceBirth: number;
  birth: number;
  lifetime: number;
}
export interface WorldProjection {
  cameraPosition: readonly number[];
  cameraXDegrees: number;
  cameraFovDegrees: number;
  laneWidth: number;
}
const STAGE_T = 1.115119873136453,
  STAGE_SY = -0.5815420740473228 - STAGE_T;
const STAGE_SX = (16 / 9) * (0.7932747292495311 / 6),
  ASPECT = 16 / 9;
const W_TO_H = STAGE_SX / -STAGE_SY;
const interpolate = (rows: number[][], t: number) => {
  if (t <= rows[0]![0]!) return rows[0]!.slice(1);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!,
      b = rows[i]!;
    if (t <= b[0]!) {
      const q = (t - a[0]!) / (b[0]! - a[0]!);
      return a.slice(1).map((x, j) => x + (b[j + 1]! - x) * q);
    }
  }
  return rows.at(-1)!.slice(1);
};

/** The binary is renderer-neutral world motion; the Sonolus adapter supplies its camera and stage mapping. */
export function compileSimpleLoopWorldRom(options: {
  w4: WorldSourceCapture;
  w12: WorldSourceCapture;
  records: SourceBirthRecord[];
  sizeRom: Buffer;
  projection: WorldProjection;
  startSize: { minScalar: number; scalar: number };
  ownScale: readonly [number, number];
  tile: { expand: readonly [number, number]; offset: readonly [number, number] };
  targetAlive: number;
  phaseOffset?: boolean;
}) {
  if (options.w4.width !== 4 || options.w12.width !== 12)
    throw new Error("World decomposition requires paired W4/W12 Source captures");
  if (options.tile.offset.some((x) => x !== 0))
    throw new Error("Source world point requires the admitted centred tile");
  if (options.projection.cameraPosition[0] !== 0)
    throw new Error("Source world point projection requires a centred camera");
  const byIdentity = (rows: WorldSourceSample[]) => {
    const map = new Map<string, WorldSourceSample[]>();
    for (const row of rows) {
      const k = row.seed + ":" + row.emission,
        a = map.get(k) ?? [];
      a.push(row);
      map.set(k, a);
    }
    return map;
  };
  const a = byIdentity(options.w4.rows),
    b = byIdentity(options.w12.rows);
  const values = Array<number>(ABI.headerSize).fill(0),
    sizeOffset = values.length;
  const read = (i: number) => options.sizeRom.readFloatLE(i * 4),
    originalSizeOffset = read(7),
    sizeCount = read(8);
  if (read(9) !== 5) throw new Error("Source Size ROM must contain local cubic coefficients");
  for (let i = 0; i < sizeCount * 5; i++) values.push(read(originalSizeOffset + i));
  const recordOffset = values.length;
  values.push(...Array<number>(options.records.length * ABI.recordStride).fill(0));
  const pitch = (options.projection.cameraXDegrees * Math.PI) / 180,
    sin = Math.sin(pitch),
    cos = Math.cos(pitch);
  const projectionY = 1 / Math.tan((options.projection.cameraFovDegrees * Math.PI) / 360),
    projectionX = projectionY / ASPECT;
  const frame = [
    options.projection.cameraPosition[1]!,
    options.projection.cameraPosition[2]!,
    sin,
    cos,
    (projectionX * ASPECT) / STAGE_SX,
    projectionY / STAGE_SY,
    -STAGE_T / STAGE_SY,
    options.projection.laneWidth / 12,
    options.tile.expand[0],
    options.tile.expand[1],
    W_TO_H,
  ];
  const size = (phase: number) => {
    let i = 0;
    while (i < sizeCount - 2 && phase >= values[sizeOffset + (i + 1) * 5]!) i++;
    const p = sizeOffset + i * 5;
    if (phase <= values[sizeOffset]!) return Math.max(0, values[sizeOffset + 4]!);
    if (phase >= values[sizeOffset + (sizeCount - 1) * 5]!)
      return Math.max(0, values[sizeOffset + (sizeCount - 1) * 5 + 4]!);
    const dt = phase - values[p]!;
    return Math.max(0, ((values[p + 1]! * dt + values[p + 2]!) * dt + values[p + 3]!) * dt + values[p + 4]!);
  };
  const projectionFrame = {
    cameraY: frame[0]!,
    cameraZ: frame[1]!,
    sinPitch: frame[2]!,
    cosPitch: frame[3]!,
    scaleX: frame[4]!,
    scaleY: frame[5]!,
    offsetY: frame[6]!,
    expandX: frame[8]!,
    expandY: frame[9]!,
  };
  let maximumSizeScale = 0;
  for (let i = 0; i < sizeCount - 1; i++) {
    const p = sizeOffset + i * 5,
      duration = values[p + 5]! - values[p]!,
      a = values[p + 1]!,
      b = values[p + 2]!,
      c = values[p + 3]!,
      d = values[p + 4]!;
    const extrema = [0, duration],
      discriminant = b * b - 3 * a * c;
    if (a !== 0 && discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      extrema.push((-b - root) / (3 * a), (-b + root) / (3 * a));
    } else if (a === 0 && b !== 0) extrema.push(-c / (2 * b));
    for (const t of extrema)
      if (t >= 0 && t <= duration) maximumSizeScale = Math.max(maximumSizeScale, ((a * t + b) * t + c) * t + d);
  }
  const project = (x: number, y: number, z: number, sx: number, sy: number) => {
    const p = projectSourceViewBillboard(x, y, z, sx, sy, projectionFrame);
    return [
      [p.x - p.halfWidth, p.y + p.halfHeight],
      [p.x - p.halfWidth, p.y - p.halfHeight],
      [p.x + p.halfWidth, p.y - p.halfHeight],
      [p.x + p.halfWidth, p.y + p.halfHeight],
    ];
  };
  let maximumCompressionPhonePx = 0,
    squared = 0,
    observations = 0,
    maximumWorldXDrift = 0,
    minimumDepth = Infinity,
    minimumEncodedMotionDepth = Infinity,
    maximumBaseDiameter = 0;
  const rows = [];
  for (let i = 0; i < options.records.length; i++) {
    const record = options.records[i]!,
      key = record.seed + ":" + record.emission,
      left = a.get(key)!,
      right = b.get(key)!;
    if (!left?.length || !right?.length) throw new Error("Paired world Source birth is missing: " + key);
    const p0 = left[0]!,
      q0 = right[0]!,
      slope = (q0.p.x - p0.p.x) / 8,
      intercept = p0.p.x - 4 * slope;
    const base = options.startSize.minScalar + (options.startSize.scalar - options.startSize.minScalar) * p0.draws[4]!;
    const baseX = base * options.ownScale[0],
      baseY = base * options.ownScale[1];
    maximumBaseDiameter = Math.max(maximumBaseDiameter, Math.abs(baseX), Math.abs(baseY));
    const dense = left.map((p) => {
      maximumWorldXDrift = Math.max(maximumWorldXDrift, Math.abs(p.p.x - p0.p.x));
      minimumDepth = Math.min(minimumDepth, -sin * (p.p.y - frame[0]!) - cos * (p.p.z - frame[1]!));
      return [(p.t - p.birth) / p.lifetime, p.p.y, p.p.z];
    });
    // Outside recorded observations extrapolate only the short birth/death remainder.
    const extrapolate = (t: number, first: boolean) => {
      const x = first ? dense[0]! : dense.at(-2)!,
        y = first ? dense[1]! : dense.at(-1)!;
      const q = (t - x[0]!) / (y[0]! - x[0]!);
      return [t, x[1]! + (y[1]! - x[1]!) * q, x[2]! + (y[2]! - x[2]!) * q];
    };
    dense.unshift(extrapolate(0, true));
    dense.push(extrapolate(1, false));
    const kept = new Set([0, dense.length - 1]);
    const error = (actual: number[], approx: number[]) => {
      let maximum = 0;
      const phase = actual[0]!,
        scale = size(phase);
      for (const lane of [-6, 0, 6])
        for (const width of [4, 8, 12, 24]) {
          const x = lane * frame[7]! + intercept + slope * width;
          const p = project(x, actual[1]!, actual[2]!, baseX * scale, baseY * scale),
            q = project(x, approx[0]!, approx[1]!, baseX * scale, baseY * scale);
          for (let corner = 0; corner < 4; corner++)
            maximum = Math.max(
              maximum,
              Math.hypot(
                (((p[corner]![0]! - q[corner]![0]!) * STAGE_SX) / ASPECT) * 195,
                (p[corner]![1]! - q[corner]![1]!) * STAGE_SY * 109.6875,
              ),
            );
        }
      return maximum;
    };
    const simplify = (lo: number, hi: number) => {
      let worst = -1,
        max = 0.1;
      const x = dense[lo]!,
        y = dense[hi]!;
      for (let j = lo + 1; j < hi; j++) {
        const v = dense[j]!,
          q = (v[0]! - x[0]!) / (y[0]! - x[0]!),
          e = error(v, [x[1]! + (y[1]! - x[1]!) * q, x[2]! + (y[2]! - x[2]!) * q]);
        if (e > max) {
          max = e;
          worst = j;
        }
      }
      if (worst >= 0) {
        kept.add(worst);
        simplify(lo, worst);
        simplify(worst, hi);
      }
    };
    simplify(0, dense.length - 1);
    const motion = [...kept].sort((x, y) => x - y).map((j) => dense[j]!.map(Math.fround)),
      motionOffset = values.length;
    for (const key of motion) {
      values.push(...key);
      minimumEncodedMotionDepth = Math.min(
        minimumEncodedMotionDepth,
        -sin * (key[1]! - frame[0]!) - cos * (key[2]! - frame[1]!),
      );
    }
    for (const v of dense) {
      const e = error(v, interpolate(motion, v[0]!));
      maximumCompressionPhonePx = Math.max(maximumCompressionPhonePx, e);
      squared += e * e;
      observations++;
    }
    values.splice(
      recordOffset + i * 8,
      8,
      record.birth,
      record.lifetime,
      slope,
      intercept,
      baseX,
      baseY,
      motionOffset,
      motion.length,
    );
    rows.push({
      ...record,
      shapeSlope: slope,
      xIntercept: intercept,
      baseSizeX: baseX,
      baseSizeY: baseY,
      motionKeys: motion.length,
    });
  }
  if (maximumWorldXDrift > 1e-10)
    throw new Error("Source world X has motion; static birth-shape decomposition does not apply");
  values.splice(
    0,
    32,
    ABI.magic,
    options.phaseOffset ? ABI.phaseVersion : ABI.version,
    1,
    3,
    options.records.length,
    recordOffset,
    8,
    sizeOffset,
    sizeCount,
    5,
    3,
    values.length,
    48,
    8,
    options.targetAlive,
    0,
    ...frame,
    options.phaseOffset ? ABI.phaseCount : 0,
    options.phaseOffset ? ABI.maximumLatePhase : 0,
    0,
    0,
    0,
  );
  const rom = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => rom.writeFloatLE(v, i * 4));
  return {
    rom,
    report: {
      schema: options.phaseOffset ? "source-simple-loop-world-v2-phase" : "source-simple-loop-world-v1",
      phaseOffsetPrograms: options.phaseOffset ? ABI.phaseCount : 1,
      maximumLatePhase: options.phaseOffset ? ABI.maximumLatePhase : 0,
      sourceSystem: "7951268161139044382",
      sourceFrameRate: 60,
      targetAlive: options.targetAlive,
      recordCount: rows.length,
      romBytes: rom.length,
      romSha1: createHash("sha1").update(rom).digest("hex"),
      maximumWorldXDrift,
      minimumDepth,
      minimumEncodedMotionDepth,
      maximumSizeScale,
      maximumProjectedScreenExtent:
        (maximumBaseDiameter * maximumSizeScale * projectionY) / (2 * minimumEncodedMotionDepth),
      maximumCompressionPhonePx,
      rmsCompressionPhonePx: Math.sqrt(squared / observations),
      rows,
    },
  };
}

export function readSimpleLoopWorldRom(bytes: Buffer) {
  const get = (i: number) => bytes.readFloatLE(i * 4);
  if (get(0) !== ABI.magic || (get(1) !== ABI.version && get(1) !== ABI.phaseVersion) || get(11) * 4 !== bytes.length)
    throw new Error("Source world ROM header mismatch");
  const sizeOffset = get(7),
    sizeCount = get(8),
    records = Array.from({ length: get(4) }, (_, i) => {
      const r = get(5) + i * 8;
      return {
        birth: get(r),
        lifetime: get(r + 1),
        slope: get(r + 2),
        intercept: get(r + 3),
        baseX: get(r + 4),
        baseY: get(r + 5),
        motionOffset: get(r + 6),
        motionCount: get(r + 7),
      };
    });
  return {
    records,
    period: get(3),
    phaseOffset: get(1) === ABI.phaseVersion,
    phaseProgramCount: get(27),
    maximumLatePhase: get(28),
    sample(index: number, age: number, lane: number, birthWidth: number) {
      const r = records[index]!,
        phase = Math.max(0, Math.min(1, age / r.lifetime));
      let s = 0,
        m = 0;
      while (s < sizeCount - 2 && phase >= get(sizeOffset + (s + 1) * 5)) s++;
      const a = sizeOffset + s * 5,
        dt = phase - get(a);
      let scale = Math.max(0, ((get(a + 1) * dt + get(a + 2)) * dt + get(a + 3)) * dt + get(a + 4));
      if (phase <= get(sizeOffset)) scale = Math.max(0, get(sizeOffset + 4));
      if (phase >= get(sizeOffset + (sizeCount - 1) * 5))
        scale = Math.max(0, get(sizeOffset + (sizeCount - 1) * 5 + 4));
      while (m < r.motionCount - 2 && phase >= get(r.motionOffset + (m + 1) * 3)) m++;
      const x = r.motionOffset + m * 3,
        y = x + 3,
        q = Math.max(0, Math.min(1, (phase - get(x)) / (get(y) - get(x))));
      const worldY = get(x + 1) + (get(y + 1) - get(x + 1)) * q,
        worldZ = get(x + 2) + (get(y + 2) - get(x + 2)) * q;
      const worldX = lane * get(23) + r.intercept + r.slope * birthWidth;
      const p = projectSourceViewBillboard(worldX, worldY, worldZ, r.baseX * scale, r.baseY * scale, {
        cameraY: get(16),
        cameraZ: get(17),
        sinPitch: get(18),
        cosPitch: get(19),
        scaleX: get(20),
        scaleY: get(21),
        offsetY: get(22),
        expandX: get(24),
        expandY: get(25),
      });
      const cx = p.x,
        cy = p.y,
        hw = p.halfWidth,
        hh = p.halfHeight;
      return {
        world: { x: worldX, y: worldY, z: worldZ },
        size: { x: r.baseX * scale, y: r.baseY * scale },
        corners: [
          [cx - hw, cy + hh],
          [cx - hw, cy - hh],
          [cx + hw, cy - hh],
          [cx + hw, cy + hh],
        ],
      };
    },
  };
}
