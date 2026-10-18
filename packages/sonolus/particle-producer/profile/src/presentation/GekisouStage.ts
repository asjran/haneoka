import type source from "../assets/gekisou-effect-profile.json";
import {
  eulerZxy,
  identity,
  multiply,
  multiplyQuaternion,
  trs,
  type Quaternion,
  type Vec3,
} from "../authored/sourceTransform.js";
import type { OurNotesGekisouRange } from "./Gekisou.js";

export type OurNotesGekisouEffectProfile = typeof source;
export type OurNotesGekisouEffectMode = 0 | 1 | 2;
export type OurNotesGekisouStagePhase = "fade" | "in" | "loop" | "out";
export { OUR_NOTES_GEKISOU_STAGE_PROFILE_URL } from "./gekisouStageSource.js";

export interface OurNotesGekisouStageState {
  readonly rangeIndex: number;
  readonly phase: OurNotesGekisouStagePhase;
  readonly phaseSeconds: number;
  readonly effectSeconds: number;
  readonly startTimeMs: number;
  readonly outTimeMs: number;
}

/** Nominal media boundaries; authoritative Source range edges can override them. */
export function ourNotesGekisouStageState(
  profile: OurNotesGekisouEffectProfile,
  ranges: readonly Pick<OurNotesGekisouRange, "startTimeMs" | "endTimeMs">[],
  timeMs: number,
): OurNotesGekisouStageState | undefined {
  const lifecycle = profile.lifecycle;
  const clip = (phase: OurNotesGekisouStagePhase) =>
    profile.clips.find((value) => value.name === profile.stateClipAliases[phase])!;
  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index]!;
    const fadeMs = range.startTimeMs - lifecycle.standbyLeadMs;
    const outMs = range.endTimeMs + lifecycle.lastNoteSlowJudgeMs + lifecycle.completeDelayMs;
    if (timeMs < fadeMs || timeMs >= outMs + clip("out").duration * 1000) continue;
    let phase: OurNotesGekisouStagePhase, phaseStart: number;
    if (timeMs >= outMs) {
      phase = "out";
      phaseStart = outMs;
    } else if (timeMs >= range.startTimeMs + clip("in").duration * 1000) {
      phase = "loop";
      phaseStart = range.startTimeMs + clip("in").duration * 1000;
    } else if (timeMs >= range.startTimeMs) {
      phase = "in";
      phaseStart = range.startTimeMs;
    } else {
      phase = "fade";
      phaseStart = fadeMs;
    }
    return {
      rangeIndex: index,
      phase,
      phaseSeconds: (timeMs - phaseStart) / 1000,
      effectSeconds: (timeMs - fadeMs) / 1000,
      startTimeMs: range.startTimeMs,
      outTimeMs: outMs,
    };
  }
  return undefined;
}

export interface OurNotesGekisouStagePose {
  readonly id: string;
  readonly transformId: string;
  readonly layer: number;
  active: boolean;
  position: Vec3;
  rotation: Quaternion;
  worldRotation: Quaternion;
  scale: Vec3;
  world: Float64Array;
  alpha: number;
  sprite: unknown;
  readonly particleValues: Map<number, number>;
  readonly scriptValues: Map<number, number>;
}

export type OurNotesGekisouStageVariant = OurNotesGekisouEffectProfile["profiles"]["standard"];
type Clip = OurNotesGekisouEffectProfile["clips"][number];

const sampleCurve = (rows: Clip["streamedCurves"][number], time: number): number => {
  if (!rows.length) return 0;
  let low = 0,
    high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle]!.time <= time) low = middle + 1;
    else high = middle;
  }
  const row = rows[Math.max(0, low - 1)]!,
    [a, b, c, d] = row.coefficients;
  const dt = time - row.time;
  return ((a! * dt + b!) * dt + c!) * dt + d!;
};

export function sampleOurNotesGekisouStageScalar(clip: Clip, index: number, seconds: number): number {
  const time = Math.fround(Math.max(0, Math.min(clip.duration, seconds)));
  if (index < clip.streamedCurves.length) return sampleCurve(clip.streamedCurves[index]!, time);
  index -= clip.streamedCurves.length;
  const dense = clip.dense;
  if (index < dense.m_CurveCount) {
    const frame = Math.max(0, Math.min(dense.m_FrameCount - 1, (time - dense.m_BeginTime) * dense.m_SampleRate));
    const before = Math.floor(frame),
      after = Math.min(dense.m_FrameCount - 1, before + 1);
    return (
      (dense.m_SampleArray[before * dense.m_CurveCount + index] ?? 0) * (1 - frame + before) +
      (dense.m_SampleArray[after * dense.m_CurveCount + index] ?? 0) * (frame - before)
    );
  }
  return clip.constant[index - dense.m_CurveCount]!;
}

/** The exact Animator hierarchy is evaluated independently of any renderer SDK. */
export class OurNotesGekisouStageScene {
  readonly variant: OurNotesGekisouStageVariant;
  readonly poses = new Map<string, OurNotesGekisouStagePose>();
  private readonly byPath = new Map<number, OurNotesGekisouStagePose>();
  private readonly byTransform = new Map<string, OurNotesGekisouStagePose>();
  private readonly parent = new Map<string, string>();
  private readonly baseAlpha = new Map<string, number>();
  private readonly clipByPhase: Record<OurNotesGekisouStagePhase, Clip>;

  constructor(
    readonly source: OurNotesGekisouEffectProfile,
    mode: Exclude<OurNotesGekisouEffectMode, 0>,
  ) {
    this.variant = source.profiles[mode === source.defaults.modes.light ? "light" : "standard"];
    this.clipByPhase = Object.fromEntries(
      Object.entries(source.stateClipAliases).map(([key, name]) => [
        key,
        source.clips.find((clip) => clip.name === name)!,
      ]),
    ) as typeof this.clipByPhase;
    for (const node of this.variant.nodes) {
      const pose: OurNotesGekisouStagePose = {
        id: node.id,
        transformId: node.transformId,
        layer: node.layer,
        active: node.active,
        position: { ...node.localPosition },
        rotation: { ...node.localRotation },
        worldRotation: { ...node.localRotation },
        scale: { ...node.localScale },
        world: new Float64Array(16),
        alpha: 1,
        sprite: undefined,
        particleValues: new Map(),
        scriptValues: new Map(),
      };
      this.poses.set(node.id, pose);
      this.byTransform.set(node.transformId, pose);
      if (node.pathHash !== null) this.byPath.set(node.pathHash, pose);
      this.parent.set(node.id, node.parentTransform);
    }
    for (const component of this.variant.components) {
      if (component.type === "SpriteRenderer")
        this.baseAlpha.set(component.data.m_GameObject!.m_PathID, component.data.m_Color!.a);
      else if (component.type === "CanvasGroup")
        this.baseAlpha.set(component.data.m_GameObject!.m_PathID, component.data.m_Alpha!);
    }
  }

  clip(phase: OurNotesGekisouStagePhase): Clip {
    return this.clipByPhase[phase];
  }

  sample(phase: OurNotesGekisouStagePhase, seconds: number): ReadonlyMap<string, OurNotesGekisouStagePose> {
    for (const node of this.variant.nodes) {
      const pose = this.poses.get(node.id)!;
      pose.active = node.active;
      Object.assign(pose.position, node.localPosition);
      Object.assign(pose.rotation, node.localRotation);
      Object.assign(pose.scale, node.localScale);
      pose.alpha = this.baseAlpha.get(node.id) ?? 1;
      pose.sprite = undefined;
      pose.particleValues.clear();
      pose.scriptValues.clear();
    }
    const clip = this.clipByPhase[phase];
    const time = clip.loopTime && clip.duration > 0 ? seconds % clip.duration : Math.min(seconds, clip.duration);
    for (const binding of clip.bindings) {
      const pose = this.byPath.get(binding.path);
      if (!pose) continue;
      const values = Array.from({ length: binding.dimensions }, (_, axis) =>
        sampleOurNotesGekisouStageScalar(clip, binding.scalarOffset + axis, time),
      );
      if (binding.isPPtrCurve) {
        const mapping = clip.raw.m_ClipBindingConstant.pptrCurveMapping;
        pose.sprite = mapping[Math.round(values[0]!)];
      } else if (binding.typeID === 1 && binding.attribute === 2086281974) pose.active = values[0]! >= 0.5;
      else if (binding.typeID === 4) {
        const vector = { x: values[0]!, y: values[1]!, z: values[2]! };
        if (binding.attribute === 1) pose.position = vector;
        else if (binding.attribute === 3) pose.scale = vector;
        else if (binding.attribute === 4) pose.rotation = eulerZxy(vector);
        else if (binding.attribute === 2) pose.rotation = { ...vector, w: values[3]! };
      } else if (
        (binding.typeID === 212 && binding.attribute === 304273561) ||
        (binding.typeID === 225 && binding.attribute === 1574349066)
      )
        pose.alpha = values[0]!;
      else if (binding.typeID === 198) pose.particleValues.set(binding.attribute, values[0]!);
      else if (binding.typeID === 114) pose.scriptValues.set(binding.attribute, values[0]!);
    }
    const resolved = new Set<string>();
    const resolve = (pose: OurNotesGekisouStagePose): void => {
      if (resolved.has(pose.id)) return;
      const parent = this.byTransform.get(this.parent.get(pose.id)!);
      if (parent) resolve(parent);
      pose.worldRotation = parent ? multiplyQuaternion(parent.worldRotation, pose.rotation) : { ...pose.rotation };
      pose.world = multiply(parent?.world ?? identity, trs(pose.position, pose.rotation, pose.scale));
      pose.active &&= parent?.active ?? true;
      resolved.add(pose.id);
    };
    for (const pose of this.poses.values()) resolve(pose);
    return this.poses;
  }
}
