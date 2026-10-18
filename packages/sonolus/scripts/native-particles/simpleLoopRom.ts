import { createHash } from "node:crypto";
import {
  SIMPLE_LOOP_ROM,
  simpleLoopHermite,
} from "../../../../.dependencies/sonolus-our-notes/shared/src/engine/data/simpleLoopRomAbi.ts";
import type { ParticleData } from "./merge.ts";
import { SIMPLE_LOOP_PHASE_EFFECTS } from "../../../../.dependencies/sonolus-our-notes/shared/src/engine/data/simpleLoopPhaseEffects.ts";
import { SIMPLE_LOOP_WORLD_ROM } from "../../../../.dependencies/sonolus-our-notes/shared/src/engine/data/simpleLoopWorldRomAbi.ts";

type Point = { x: number; y: number };
export interface SimpleLoopSourceRow {
  t: number;
  seed: number;
  emission: number;
  birth: number;
  lifetime: number;
  corners: Point[];
  materialAlpha: number;
  emissionRgb: number[];
}
export interface SimpleLoopSourceCapture {
  width: number;
  window: number[];
  seeds: number[];
  sourceSystem: string;
  producerHashes: Record<string, string>;
  rows: SimpleLoopSourceRow[];
}
interface SizeKey {
  time: number;
  value: number;
  inSlope: number;
  outSlope: number;
  weightedMode: number;
}
type NumericRecord = Record<string, unknown>;
const record = (value: unknown) => value as NumericRecord;

export function sourceSimpleLoopSizeKeys(source: unknown): SizeKey[] {
  const data = record(record(source).data);
  const module = record(data.SizeModule);
  const curve = record(module.curve);
  const keys = record(curve.maxCurve).m_Curve as SizeKey[];
  if (module.separateAxes || keys.some((key) => key.weightedMode !== 0))
    throw new Error("SimpleLoop ROM v1 requires the authored shared unweighted Size curve");
  return keys;
}

function sizeAt(keys: readonly SizeKey[], time: number): number {
  if (time <= keys[0]!.time) return Math.max(0, keys[0]!.value);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!,
      b = keys[i]!;
    if (time <= b.time) return simpleLoopHermite(time, a.time, a.value, a.outSlope, b.time, b.value, b.inSlope);
  }
  return Math.max(0, keys.at(-1)!.value);
}

const mix = (a: number[], b: number[], q: number) => a.map((v, i) => v + (b[i]! - v) * q);
function interpolate(rows: number[][], time: number): number[] {
  if (time <= rows[0]![0]!) return rows[0]!.slice(1);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!,
      b = rows[i]!;
    if (time <= b[0]!) return mix(a.slice(1), b.slice(1), (time - a[0]!) / (b[0]! - a[0]!));
  }
  return rows.at(-1)!.slice(1);
}

/** AOT authoring adapter: a six-seed Source birth census becomes shared Size plus short motion tracks. */
export function compileSimpleLoopRom(
  capture: SimpleLoopSourceCapture,
  source: unknown,
  targetAlive: number,
  tileMapping: { expand: readonly [number, number]; offset: readonly [number, number] },
) {
  if (capture.width !== 8 || capture.sourceSystem !== "7951268161139044382")
    throw new Error("SimpleLoop ROM v1 is admitted only for the active Source W8 point system");
  if (record(source).pathId !== capture.sourceSystem)
    throw new Error("Source system identity does not match its captured particles");
  const keys = sourceSimpleLoopSizeKeys(source);
  const trajectories = new Map<string, SimpleLoopSourceRow[]>();
  for (const row of capture.rows) {
    const identity = `${row.seed}:${row.emission}`;
    const rows = trajectories.get(identity) ?? [];
    rows.push(row);
    trajectories.set(identity, rows);
  }
  const lower = capture.window[0]!,
    period = 3;
  const complete = [...trajectories.values()]
    .filter((rows) => {
      const row = rows[0]!;
      return (
        row.birth >= lower &&
        row.birth < lower + period &&
        row.birth + row.lifetime < capture.window[1]! &&
        rows.length >= 3
      );
    })
    .sort((a, b) => a[0]!.birth - b[0]!.birth || a[0]!.seed - b[0]!.seed);
  const meanLife = complete.reduce((v, rows) => v + rows[0]!.lifetime, 0) / complete.length;
  const count = Math.round((targetAlive * period) / meanLife);
  const selected: SimpleLoopSourceRow[][] = [];
  for (let i = 0; i < count; i++) {
    const seed = capture.seeds[i % capture.seeds.length]!;
    const desiredBirth = lower + (period * (i + 0.5)) / count;
    const pool = complete.filter((rows) => rows[0]!.seed === seed && !selected.includes(rows));
    pool.sort((a, b) => Math.abs(a[0]!.birth - desiredBirth) - Math.abs(b[0]!.birth - desiredBirth));
    if (pool[0]) selected.push(pool[0]);
  }
  selected.sort((a, b) => a[0]!.birth - b[0]!.birth);
  const values = Array<number>(SIMPLE_LOOP_ROM.headerSize).fill(0);
  const sizeOffset = values.length;
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i]!,
      b = keys[i + 1];
    if (!b) {
      values.push(a.time, 0, 0, 0, a.value);
      continue;
    }
    const dt = b.time - a.time;
    values.push(
      a.time,
      (2 * a.value - 2 * b.value + dt * (a.outSlope + b.inSlope)) / (dt * dt * dt),
      (-3 * a.value + 3 * b.value - dt * (2 * a.outSlope + b.inSlope)) / (dt * dt),
      a.outSlope,
      a.value,
    );
  }
  const recordsOffset = values.length;
  values.push(...Array<number>(selected.length * SIMPLE_LOOP_ROM.recordStride).fill(0));
  let maximumCornerErrorPhonePx = 0,
    sumCornerErrorSquared = 0,
    observations = 0;
  const reports = [];
  for (let index = 0; index < selected.length; index++) {
    const rows = selected[index]!,
      first = rows[0]!;
    const observationsRaw = rows.map((row) => {
      const age = (row.t - row.birth) / row.lifetime;
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([u, v]) => {
        const x = 0.5 + tileMapping.offset[0] + (u! * tileMapping.expand[0]) / 2;
        const y = 0.5 + tileMapping.offset[1] + (v! * tileMapping.expand[1]) / 2;
        const weights = [(1 - x) * (1 - y), x * (1 - y), x * y, (1 - x) * y];
        return {
          x: row.corners.reduce((s, p, i) => s + p.x * weights[i]!, 0),
          y: row.corners.reduce((s, p, i) => s + p.y * weights[i]!, 0),
        };
      });
      const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
      const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
      const scale = sizeAt(keys, age);
      return { age, cx, cy, scale, corners };
    });
    const basis = observationsRaw
      .filter((row) => row.scale > 0.005)
      .map((row) => [
        row.age,
        row.cx,
        row.cy,
        ...row.corners.flatMap((p) => [(p.x - row.cx) / row.scale, (p.y - row.cy) / row.scale]),
      ]);
    if (!basis.length) throw new Error("Selected SimpleLoop birth has no measurable Source geometry");
    const dense = observationsRaw.map((row) => {
      const values = interpolate(basis, row.age);
      return [row.age, row.cx, row.cy, ...values.slice(2)];
    });
    dense.unshift([0, ...interpolate(dense, 0)]);
    dense.push([1, ...interpolate(dense, 1)]);
    const retained = new Set([0, dense.length - 1]);
    function simplify(a: number, b: number) {
      let worst = -1,
        error = 0.12;
      for (let i = a + 1; i < b; i++) {
        const row = dense[i]!,
          q = (row[0]! - dense[a]![0]!) / (dense[b]![0]! - dense[a]![0]!);
        const approx = mix(dense[a]!.slice(1), dense[b]!.slice(1), q),
          scale = sizeAt(keys, row[0]!);
        for (let corner = 0; corner < 4; corner++) {
          const dx = row[1]! + row[3 + corner * 2]! * scale - (approx[0]! + approx[2 + corner * 2]! * scale);
          const dy = row[2]! + row[4 + corner * 2]! * scale - (approx[1]! + approx[3 + corner * 2]! * scale);
          const distance = Math.hypot((dx * 2 * 390) / 12, dy * 48);
          if (distance > error) {
            error = distance;
            worst = i;
          }
        }
      }
      if (worst >= 0) {
        retained.add(worst);
        simplify(a, worst);
        simplify(worst, b);
      }
    }
    simplify(0, dense.length - 1);
    const motion = [...retained].sort((a, b) => a - b).map((i) => dense[i]!.map(Math.fround));
    for (const row of observationsRaw) {
      const p = interpolate(motion, row.age),
        scale = sizeAt(keys, row.age);
      for (let corner = 0; corner < 4; corner++) {
        const distance = Math.hypot(
          ((row.corners[corner]!.x - p[0]! - p[2 + corner * 2]! * scale) * 2 * 390) / 12,
          (row.corners[corner]!.y - p[1]! - p[3 + corner * 2]! * scale) * 48,
        );
        maximumCornerErrorPhonePx = Math.max(maximumCornerErrorPhonePx, distance);
        sumCornerErrorSquared += distance * distance;
        observations++;
      }
    }
    const motionOffset = values.length;
    for (const key of motion) values.push(...key);
    const offset = recordsOffset + index * SIMPLE_LOOP_ROM.recordStride;
    values.splice(
      offset,
      SIMPLE_LOOP_ROM.recordStride,
      first.birth - lower,
      first.lifetime,
      motionOffset,
      motion.length,
    );
    reports.push({
      seed: first.seed,
      emission: first.emission,
      sourceBirth: first.birth,
      birth: first.birth - lower,
      lifetime: first.lifetime,
      sourceSamples: rows.length,
      motionKeys: motion.length,
    });
  }
  values.splice(
    0,
    SIMPLE_LOOP_ROM.headerSize,
    SIMPLE_LOOP_ROM.magic,
    SIMPLE_LOOP_ROM.version,
    8,
    period,
    selected.length,
    recordsOffset,
    SIMPLE_LOOP_ROM.recordStride,
    sizeOffset,
    keys.length,
    SIMPLE_LOOP_ROM.sizeStride,
    SIMPLE_LOOP_ROM.motionStride,
    values.length,
    SIMPLE_LOOP_ROM.maxResidents,
    1,
    targetAlive,
    0,
  );
  const rom = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => rom.writeFloatLE(value, i * 4));
  return {
    rom,
    report: {
      schema: 1,
      sourceSystem: capture.sourceSystem,
      width: 8,
      period,
      targetAlive,
      birthCount: selected.length,
      producerHashes: capture.producerHashes,
      sourceCadence: 60,
      romBytes: rom.length,
      romSha1: createHash("sha1").update(rom).digest("hex"),
      tileMapping,
      sharedSizeKeys: keys.length,
      maximumCornerErrorPhonePx,
      rmsCornerErrorPhonePx: Math.sqrt(sumCornerErrorSquared / observations),
      boundaryPolicy:
        "Applied birth drives both native alpha and ROM geometry; half-open lifetime; three-second deterministic repetition.",
      records: reports,
    },
  };
}

/** Append the source-slot capability without changing any existing effect or sprite. */
export function appendSimpleLoopSourceSlot(
  data: ParticleData,
  colorTimes: number[],
  gray: number[],
  alphaRise: number,
  phaseOffset = false,
) {
  const base = data.effects.find((effect) => effect.name === "Our Notes Native Slide Loop W8 P0");
  if (!base) throw new Error("Source SimpleLoop W8 P0 is absent");
  const group = (base.groups as Array<{ particles: Array<{ sprite: number }> }>)[0]!;
  const sprite = group.particles[0]!.sprite;
  const constant = (c: number) => ({ from: { c }, to: { c }, ease: "none" });
  const value = (t: number) => {
    let g = gray.at(-1)!;
    for (let i = 1; i < colorTimes.length; i++)
      if (t <= colorTimes[i]!) {
        g =
          gray[i - 1]! + ((gray[i]! - gray[i - 1]!) * (t - colorTimes[i - 1]!)) / (colorTimes[i]! - colorTimes[i - 1]!);
        break;
      }
    return g * Math.min(1, t / alphaRise);
  };
  const authoredTimes = [...new Set([0, alphaRise, ...colorTimes])].sort((a, b) => a - b);
  // A binary grid keeps adjacent start/end values shared in Float32 too.
  const phaseGrid = 2 ** 24;
  const names = [SIMPLE_LOOP_ROM.effectName, ...Object.values(SIMPLE_LOOP_PHASE_EFFECTS)];
  const effects = Array.from({ length: phaseOffset ? SIMPLE_LOOP_WORLD_ROM.phaseCount : 1 }, (_, index) => {
    const phase = phaseOffset
      ? (index * SIMPLE_LOOP_WORLD_ROM.maximumLatePhase) / (SIMPLE_LOOP_WORLD_ROM.phaseCount - 1)
      : 0;
    const sourceTimes = [phase, ...authoredTimes.filter((time) => time > phase)];
    const times = sourceTimes.map((time) => Math.round(((time - phase) / (1 - phase)) * phaseGrid) / phaseGrid);
    const particles = sourceTimes.slice(1).map((t, i) => ({
      sprite,
      color: "#ffffff",
      start: times[i]!,
      duration: times[i + 1]! - times[i]!,
      x: constant(0),
      y: constant(0),
      w: { from: { c: 1 }, to: { c: 0 }, ease: "none" },
      h: constant(1),
      r: constant(0),
      a: { from: { c: value(sourceTimes[i]!) }, to: { c: value(t) }, ease: "linear" },
    }));
    return {
      name: names[index]!,
      groups: [{ count: 1, particles }],
      transform: Object.fromEntries(
        ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"].map((name) => [name, { [name]: 1 }]),
      ),
    };
  });
  return {
    ...data,
    effects: [...data.effects, ...effects],
  } as ParticleData;
}

/** Authoring readback uses shipped Float32 bytes, the shared Hermite curve and native corner order. */
export function readSimpleLoopRom(buffer: Buffer) {
  if (buffer.length % 4) throw new Error("SimpleLoop ROM byte length is not a Float32 list");
  const values = Array.from({ length: buffer.length / 4 }, (_, i) => buffer.readFloatLE(i * 4));
  if (values[0] !== SIMPLE_LOOP_ROM.magic || values[1] !== SIMPLE_LOOP_ROM.version || values[11] !== values.length)
    throw new Error("SimpleLoop ROM header does not match its paired source-slot compiler");
  const recordCount = values[4]!,
    recordOffset = values[5]!,
    sizeOffset = values[7]!,
    sizeCount = values[8]!;
  const size = (phase: number) => {
    let i = 0;
    while (i < sizeCount - 2 && phase >= values[sizeOffset + (i + 1) * 5]!) i++;
    const offset = sizeOffset + i * 5;
    if (phase <= values[sizeOffset]!) return Math.max(0, values[sizeOffset + 4]!);
    if (phase >= values[sizeOffset + (sizeCount - 1) * 5]!)
      return Math.max(0, values[sizeOffset + (sizeCount - 1) * 5 + 4]!);
    const dt = phase - values[offset]!;
    return Math.max(
      0,
      ((values[offset + 1]! * dt + values[offset + 2]!) * dt + values[offset + 3]!) * dt + values[offset + 4]!,
    );
  };
  const records = Array.from({ length: recordCount }, (_, i) => {
    const offset = recordOffset + i * 4;
    const motionOffset = values[offset + 2]!,
      count = values[offset + 3]!;
    const motion = Array.from({ length: count }, (_, key) =>
      values.slice(motionOffset + key * 11, motionOffset + (key + 1) * 11),
    );
    return { birth: values[offset]!, lifetime: values[offset + 1]!, motion };
  });
  return {
    period: values[3]!,
    records,
    size,
    sample(index: number, age: number) {
      const record = records[index]!;
      const phase = Math.max(0, Math.min(1, age / record.lifetime));
      const point = interpolate(record.motion, phase),
        scale = size(phase);
      return {
        lifetime: record.lifetime,
        corners: [0, 3, 2, 1].map((corner) => ({
          x: point[0]! + point[2 + corner * 2]! * scale,
          y: point[1]! + point[3 + corner * 2]! * scale,
        })),
      };
    },
  };
}
