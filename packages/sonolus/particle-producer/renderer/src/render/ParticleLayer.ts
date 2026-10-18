import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  CustomBlending,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  NoColorSpace,
  OneFactor,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  SrcAlphaFactor,
  TextureLoader,
  UnsignedByteType,
  Vector2,
  Vector3,
} from "three";
import type { OneMinusSrcAlphaFactor, Texture } from "three";
import { EFFECT001_PREFAB_IDS } from "@haneoka/cassiopeia-plugin-our-notes";
import { unityStringHash } from "@haneoka/cassiopeia-plugin-our-notes";
import type {
  Effect001AnimationJudgement,
  Effect001ParticleSystemAssetRef,
  Effect001PrefabAssetRef,
  Effect001SpriteAssetRef,
  Effect001SpriteName,
  Effect001TextureKey,
  LaneEffectAssetKey,
  LaneEffectParticleAssetRef,
  OurNotesAssetManifest,
} from "@haneoka/cassiopeia-plugin-our-notes";
import {
  isRenderLaneEffectKind,
  type RenderLaneEffectKind,
  type RenderParticleEffect,
} from "@haneoka/cassiopeia-plugin-our-notes";
import {
  evaluateNativeMinMaxCurve,
  evaluateNativeMinMaxGradient,
  nativeParticleRandom as random,
  prepareNativeCurveLuts,
  NativeParticleMotionClock,
  OUR_NOTES_MAXIMUM_PARTICLE_TIMESTEP,
  readNativeParticleMotionSource,
  type NativeParticleMotionState,
  type NativeParticleMotionSource,
  quantizeParticleColor,
  serializedColor,
  type NativeColor,
} from "@haneoka/cassiopeia-plugin-our-notes/authored";
export {
  evaluateNativeAnimationCurve,
  evaluateNativeMinMaxCurve,
  evaluateNativeMinMaxCurveExact,
  evaluateNativeMinMaxGradient,
  getNativeCurveLutStats,
  nativeParticleRandom,
  prepareNativeCurveLuts,
  resetNativeCurveLutCache,
  type NativeCurveLutStats,
} from "@haneoka/cassiopeia-plugin-our-notes/authored";
import { StageProjector } from "./stageGeometry";

type NativeRecord = Record<string, unknown>;
type BillboardTextureKey = Exclude<Effect001TextureKey, "wall">;
type LoadedTextureKey = Effect001TextureKey | "line" | "pillar" | "laneEffect";
type EffectMeshShaderMode = "mobileAddHdr" | "uiAdditive";

export interface NativeParticleSystemData {
  raw: NativeRecord;
  length: number;
  simulationSpeed: number;
  looping: boolean;
  maxParticles: number;
  /** Serialized `moveWithTransform`; Unity ParticleSystemSimulationSpace. */
  simulationSpace: 0 | 1 | 2;
  /** Serialized ParticleSystemScalingMode. */
  scalingMode: number;
}

interface LoadedParticleSystem extends NativeParticleSystemData {
  ref: Effect001ParticleSystemAssetRef;
  /** Cached once when the authored system is loaded; read on every effect frame. */
  animationPathHash?: number;
  readonly animationPathHierarchy: ReadonlyArray<number>;
  readonly baseActiveByPath: ReadonlyMap<number, boolean>;
  readonly nameHash: number;
  readonly motionSource: NativeParticleMotionSource;
  emissionBuffer: ParticleEmission[];
  emissionPool: ParticleEmission[];
}

interface NativeClipFrame {
  time: number;
  coefficients: Map<number, readonly [number, number, number, number]>;
}

interface NativeClipBinding {
  path: number;
  attribute: number;
  curveStart: number;
  componentCount: number;
  typeId?: number;
}

export interface NativeAnimationClip {
  duration: number;
  streamedCurveCount: number;
  constantValues: ReadonlyArray<number>;
  frames: ReadonlyArray<NativeClipFrame>;
  /** Loader-owned sparse frame lists; external clips retain the linear fallback. */
  curveFrames?: ReadonlyMap<number, ReadonlyArray<NativeClipFrame>>;
  bindings: ReadonlyArray<NativeClipBinding>;
  bindingLookup: ReadonlyMap<number, ReadonlyMap<number, NativeClipBinding>>;
}

interface LoadedPrefab {
  manifest: Effect001PrefabAssetRef;
  systems: ReadonlyArray<LoadedParticleSystem>;
  animation?: NativeAnimationClip;
  animations: ReadonlyMap<Effect001AnimationJudgement, NativeAnimationClip>;
  distanceAnimation?: NativeAnimationClip;
  wallSystem?: LoadedParticleSystem;
}

interface ParticleEmission {
  simulationTime: number;
  originX: number;
  originY: number;
  originZ: number;
  index: number;
  shapeBirthWidth?: number;
  motion?: CachedParticleMotion;
}

interface CachedParticleMotion extends NativeParticleMotionState {
  lastSeen: number;
}

interface ParticleMotionSystem {
  initialized: boolean;
  seed: number;
  lastAge: number;
  animationTimeOffset: number;
  epoch: number;
  readonly clock: NativeParticleMotionClock;
  readonly particles: Map<number, CachedParticleMotion>;
  readonly pool: CachedParticleMotion[];
}

interface ParticleShapeBirthWidths {
  seed: number;
  lastAge: number;
  epoch: number;
  readonly widths: Map<number, { width: number; lastSeen: number }>;
}

interface EmissionRing {
  readonly records: ParticleEmission[];
  head: number;
  count: number;
}

interface IncrementalEmissionState {
  initialized: boolean;
  seed: number;
  lastAge: number;
  nextRateStart: number;
  rateRemainder: number;
  emitted: number;
  stepRemainder: number;
  stepEmitted: number;
  stepEvaluations: number;
  rebuilds: number;
  readonly persistent: EmissionRing;
  readonly transient: EmissionRing;
  readonly output: ParticleEmission[];
}

interface ParticleSample {
  x: number;
  y: number;
  z: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  color: NativeColor;
  rotation: number;
  /** Simulated seconds since emission, and the particle's simulated lifetime. */
  age: number;
  lifetime: number;
}

/** One rendered billboard with its stable particle identity. */
export interface NativeBillboardTrace {
  texture: BillboardTextureKey;
  /** Index of the ParticleSystem inside its prefab. */
  system: number;
  /** Emission index within that system; stable across ages for one seed. */
  emission: number;
  /** Per-particle seed: draws are `nativeParticleRandom(particleSeed + k)`. */
  particleSeed: number;
  simulationSpeed: number;
  /** Offline trace clock; playback seconds are mapped by the live evaluator. */
  clock?: {
    readonly realTimeOffset: number;
    readonly currentSimulationTime: number;
    readonly emissionSimulationTime: number;
    readonly simulationTimeAt: (playbackSeconds: number) => number;
  };
  materialTint?: readonly [number, number, number, number];
  age: number;
  lifetime: number;
  x: number;
  y: number;
  z: number;
  sizeX: number;
  sizeY: number;
  color: Readonly<NativeColor>;
  rotation: number;
  maxParticleSize: number;
  /** Unity billboard mode; omitted retains the established vertical renderer. */
  renderMode?: 0 | 2 | 3;
  pivotX: number;
  pivotY: number;
}

/** One rendered frame/pillar sprite, wall mesh or lane fill (EffectMeshBatch space). */
export interface NativeMeshTrace {
  kind: "frame" | "pillar" | "wall" | "lane";
  name: string;
  x: number;
  y: number;
  z: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  color: Readonly<NativeColor>;
  rotationX: number;
  materialTint?: readonly [number, number, number, number];
}

/**
 * Receives every instance ParticleLayer.update() emits. Offline compilers
 * (the native Sonolus particle build) use it so both targets share one
 * evaluator instead of maintaining a second copy of the Unity math.
 */
export interface NativeEffectTraceSink {
  billboard(entry: NativeBillboardTrace): void;
  mesh(entry: NativeMeshTrace): void;
}

export type NativeJsonReader = (url: string) => Promise<unknown>;

/**
 * A ParticleSystem GameObject can be enabled partway through an Animator
 * state. Its simulation time starts at that authored edge, while a moving
 * parent Transform continues to use the state's absolute time.
 */
interface ParticlePlayback {
  age: number;
  animationTimeOffset: number;
}

/**
 * ParticleSystem.simulationSpeed is animatable in tap_flick. The Animator
 * value is a rate in simulated seconds per real second, so every particle
 * property must use its integral rather than `age * serializedSpeed`.
 */
interface ParticleSimulationClock {
  current: number;
  timeAt(realTime: number): number;
}

interface ImpactVisual {
  root: Group;
  lastSeen: number;
  prefabId: number;
  readonly emissionStates: Map<LoadedParticleSystem, IncrementalEmissionState>;
  readonly shapeBirthWidths: Map<LoadedParticleSystem, ParticleShapeBirthWidths>;
  readonly motionStates: Map<LoadedParticleSystem, ParticleMotionSystem>;
}

const EMPTY_EFFECTS: ReadonlyArray<RenderParticleEffect> = [];
const EMPTY_VALUES: ReadonlyArray<unknown> = [];
const EMPTY_PATH_HASHES: ReadonlyArray<number> = [];
const LANE_EFFECT_EMISSION: ParticleEmission = {
  simulationTime: 0,
  originX: 0,
  originY: 0,
  originZ: 0,
  index: 0,
};
// The native lane-effect prefab root is +90° around Unity X. StageProjector
// reflects Unity Z into Three space, so the equivalent rendered rotation is
// -90°. Keeping the Unity sign here flips the long normal-lane fill behind
// the judgement line and makes it look like an invented lateral sweep.
const LANE_EFFECT_UNITY_TO_THREE_ROTATION_X = -Math.PI / 2;
function laneEffectAssetKey(kind: RenderLaneEffectKind): LaneEffectAssetKey {
  switch (kind) {
    case "lane-input-blank-miss":
      return "inVain";
    case "lane-effect-normal":
      return "normal";
    case "lane-effect-slide":
      return "slide";
    case "lane-effect-flick":
      return "flick";
    case "lane-effect-flick-left":
      return "flickLeft";
    case "lane-effect-flick-right":
      return "flickRight";
    case "lane-effect-gekisou":
      return "gekisou";
  }
}
const SPRITE_NAMES: ReadonlyArray<Effect001SpriteName> = [
  "frame",
  "pillar01",
  "pillar02",
  "pillar03",
  "pillar04",
];
const PATH_HASH: Readonly<Record<Effect001SpriteName, number>> = {
  frame: unityStringHash("frame"),
  pillar01: unityStringHash("pillar01"),
  pillar02: unityStringHash("pillar02"),
  pillar03: unityStringHash("pillar03"),
  pillar04: unityStringHash("pillar04"),
};
const ATTRIBUTE_COLOR_ALPHA = unityStringHash("m_Color.a");
const COLOR_CHANNELS = ["r", "g", "b", "a"] as const;
const SPRITE_COLOR_ATTRIBUTES = COLOR_CHANNELS.map((channel) => unityStringHash(`m_Color.${channel}`));
const START_MAX_COLOR_ATTRIBUTES = COLOR_CHANNELS.map((channel) =>
  unityStringHash(`InitialModule.startColor.maxColor.${channel}`),
);
const START_MIN_COLOR_ATTRIBUTES = COLOR_CHANNELS.map((channel) =>
  unityStringHash(`InitialModule.startColor.minColor.${channel}`),
);
const ATTRIBUTE_PARTICLE_DISTANCE_RATE = unityStringHash("EmissionModule.rateOverDistance.scalar");

const ATTRIBUTE_SIZE_X = unityStringHash("m_Size.x");
const ATTRIBUTE_ACTIVE = unityStringHash("m_IsActive");
const ATTRIBUTE_TRANSFORM_POSITION = 1;
const ATTRIBUTE_PARTICLE_SIMULATION_SPEED = unityStringHash("simulationSpeed");
const EMISSION_STEP = 1 / 60;
// The source up-flick reaches 144 non-wall particles inside one Animator
// window. This is a GPU allocation budget only: Unity's max-particle limit is
// per ParticleSystem, so a shared, prefab-order cap would incorrectly remove
// the late long-star and center-pillar systems.
const SOURCE_EFFECT_PARTICLE_BUFFER_PER_EFFECT = 160;
// External references in every effect001 prefab resolve to these three
// Custom/Mobile/MobileAddHdrColor materials. The compiled GLES3 shader
// multiplies _TintColor in both vertex and fragment stages and doubles the
// fragment color; omitting this made the HDR beams 18-36x dimmer.
export const MOBILE_ADD_HDR_TINT_NORMAL = [
  2.9960782527923584, 2.9960782527923584, 2.9960782527923584, 0.615686297416687,
] as const;
// ef_tap_normal_long_glow.mat: same HDR RGB as normal stars but a distinct
// alpha. The shader applies this tint twice, so treating it as normal makes
// the long streaks visibly overexposed.
export const MOBILE_ADD_HDR_TINT_LONG_STAR = [
  2.9960782527923584, 2.9960782527923584, 2.9960782527923584, 0.4901960790157318,
] as const;
// ef_tap_pillar_glow(.02).mat: both authored center-pillar masks use half
// the HDR RGB of the normal particle material. Reusing the normal tint here
// quadruples the final RGB because MobileAddHdrColor multiplies twice.
export const MOBILE_ADD_HDR_TINT_CENTER_PILLAR = [
  1.4980392456054688, 1.4980392456054688, 1.4980392456054688, 0.4901960790157318,
] as const;
// note_point_simple.mat: effect001Simple point emitters use a dimmer HDR tint
// than the star materials; MobileAddHdrColor still applies it twice.
export const MOBILE_ADD_HDR_TINT_CIRCLE_ICON = [1.1509433985, 1.1509433985, 1.1509433985, 1] as const;
export const MOBILE_ADD_HDR_TINT_STRONG = [
  4.237094402313232, 4.237094402313232, 4.237094402313232, 0.5490196347236633,
] as const;
export const MOBILE_ADD_HDR_TINT_WALL = [
  1.0592737197875977, 1.0592737197875977, 1.0592737197875977, 0.7176470756530762,
] as const;
// `ef_wall.png` is not anchored by its lower image edge. Its alpha ridge is
// at source row 198/256 (Unity UV ~= .2246), followed by the authored
// reflection towards the image bottom. On the 2.408502817-high wall mesh that
// ridge is at y ~= .534. ParticleSystemRenderer_3 serializes m_Pivot.y=-.21
// as a fraction of the rendered particle diameter; applying it as a raw
// mesh-space coordinate (the old -0.21 uniform) moved the ridge up instead of
// putting it on the judgement origin. Keep the renderer value and mesh
// diameter as their f32 values so the GPU receives Unity's diameter-scaled
// vertical anchor. X needs no visible correction because the renderer pivot
// is zero. Z already uses +0.5 in Three: the wall mesh's depth is exactly 1,
// and reflecting Unity's -0.5 pivot together with the mesh turns it into the
// existing +0.5 shader pivot. Y is the only component whose non-unit mesh
// diameter changes the serialized number.
const WALL_MESH_HEIGHT = Math.fround(2.4085028171539307);
const WALL_RENDERER_PIVOT_Y = Math.fround(-0.21);
export const WALL_MESH_SHADER_PIVOT_Y = Math.fround(-WALL_RENDERER_PIVOT_Y * WALL_MESH_HEIGHT);
const FRAME_SLICE_BORDER = [0.408, 0.4] as const;
const PARTICLE_COLOR_SCRATCH: NativeColor = { r: 0, g: 0, b: 0, a: 0 };
const INITIAL_MIN_COLOR_SCRATCH: NativeColor = { r: 0, g: 0, b: 0, a: 0 };
const INITIAL_MAX_COLOR_SCRATCH: NativeColor = { r: 0, g: 0, b: 0, a: 0 };
const PARTICLE_LIFETIME_COLOR_SCRATCH: NativeColor = { r: 0, g: 0, b: 0, a: 0 };
const SHAPE_POSITION_SCRATCH: [number, number, number] = [0, 0, 0];
const SHAPE_INITIAL_VELOCITY_SCRATCH: [number, number, number] = [0, 0, 0];
const VELOCITY_POSITION_SCRATCH: [number, number, number] = [0, 0, 0];
const MOVEMENT_PREVIOUS_SCRATCH: [number, number, number] = [0, 0, 0];
const MOVEMENT_CURRENT_SCRATCH: [number, number, number] = [0, 0, 0];
const UNIT_SCALE = [1, 1, 1] as const;
const PARTICLE_SAMPLE_SCRATCH: ParticleSample = {
  x: 0,
  y: 0,
  z: 0,
  sizeX: 0,
  sizeY: 0,
  sizeZ: 0,
  color: PARTICLE_COLOR_SCRATCH,
  rotation: 0,
  age: 0,
  lifetime: 0,
};

function record(value: unknown): NativeRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as NativeRecord)
    : undefined;
}

function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : EMPTY_VALUES;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, progress: number): number {
  return a + (b - a) * progress;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

const zeroOrbitRadialModules = new WeakSet<NativeRecord>();
function knownPositiveZeroCurve(value: unknown): boolean {
  const curve = record(value);
  if (!curve || (curve.minMaxState !== 0 && curve.minMaxState !== 3)) return false;
  return (
    typeof curve.scalar === "number" &&
    Number.isFinite(curve.scalar) &&
    curve.scalar === 0 &&
    !Object.is(curve.scalar, -0) &&
    typeof curve.minScalar === "number" &&
    Number.isFinite(curve.minScalar) &&
    curve.minScalar === 0 &&
    !Object.is(curve.minScalar, -0)
  );
}

export function readNativeParticleSystem(
  value: unknown,
  originalIdentity?: Effect001ParticleSystemAssetRef["originalIdentity"],
): NativeParticleSystemData | undefined {
  const root = record(value);
  if (
    originalIdentity &&
    (root?.serializedFile !== originalIdentity.serializedFile || root?.pathId !== originalIdentity.pathId)
  )
    throw new Error("Simple Circle original particle identity changed");
  if (root?.type !== "ParticleSystem") return undefined;
  const data = record(root.data);
  const initial = record(data?.InitialModule);
  if (!data || !initial || initial.enabled !== true) return undefined;
  const shape = record(data.ShapeModule);
  if (originalIdentity) {
    if (!shape || shape.enabled !== true || shape.type !== 10)
      throw new Error("Simple Circle original Shape owner changed");
    const radius = record(shape.radius),
      arc = record(shape.arc),
      rotation = record(shape.m_Rotation);
    const speed = record(initial.startSpeed),
      circleVelocity = record(data.VelocityModule),
      limit = record(data.ClampVelocityModule);
    const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
    const modifier = record(circleVelocity?.speedModifier);
    if (
      !radius ||
      radius.mode !== 0 ||
      radius.spread !== 0 ||
      !numeric(radius.value) ||
      radius.value < 0 ||
      !arc ||
      arc.mode !== 0 ||
      arc.spread !== 0 ||
      !numeric(arc.value) ||
      arc.value <= 0 ||
      arc.value > 360 ||
      !numeric(shape.radiusThickness) ||
      shape.radiusThickness < 0 ||
      shape.radiusThickness > 1 ||
      !rotation ||
      rotation.y !== 0 ||
      rotation.z !== 0 ||
      !numeric(rotation.x) ||
      shape.alignToDirection !== false ||
      shape.randomDirectionAmount !== 0 ||
      shape.randomPositionAmount !== 0 ||
      shape.sphericalDirectionAmount !== 0 ||
      !speed ||
      (speed.minMaxState !== 0 && speed.minMaxState !== 3) ||
      !numeric(speed.scalar) ||
      !numeric(speed.minScalar) ||
      data.moveWithTransform !== 0 ||
      data.scalingMode !== 1 ||
      circleVelocity?.enabled !== true ||
      circleVelocity.inWorldSpace !== false ||
      !modifier ||
      modifier.minMaxState !== 0 ||
      modifier.scalar !== 1 ||
      limit?.enabled !== true ||
      limit.inWorldSpace !== false ||
      limit.multiplyDragByParticleSize !== false ||
      limit.multiplyDragByParticleVelocity !== false
    )
      throw new Error("Unsupported original Simple Circle particle contract");
  }
  // Loading is the one-time point at which paying LUT construction and
  // validation cannot disturb a dense effect frame.
  prepareNativeCurveLuts(data);
  const velocity = record(data.VelocityModule);
  if (
    velocity &&
    [
      "orbitalOffsetX",
      "orbitalOffsetY",
      "orbitalOffsetZ",
      "orbitalX",
      "orbitalY",
      "orbitalZ",
      "radial",
    ].every((key) => knownPositiveZeroCurve(velocity[key]))
  )
    zeroOrbitRadialModules.add(velocity);
  return {
    raw: data,
    length: Math.max(0, finite(data.lengthInSec)),
    simulationSpeed: Math.max(Number.EPSILON, finite(data.simulationSpeed, 1)),
    looping: data.looping === true,
    maxParticles: Math.max(0, Math.round(finite(initial.maxNumParticles, 1000))),
    // UnityEngine.ParticleSystemSimulationSpace is Local=0, World=1,
    // Custom=2. The Unity asset serializer stores that enum under the legacy
    // field name `moveWithTransform`.
    simulationSpace: Math.max(0, Math.min(2, Math.round(finite(data.moveWithTransform)))) as 0 | 1 | 2,
    scalingMode: Math.round(finite(data.scalingMode, 1)),
  };
}

function bitsToFloat(value: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, value >>> 0, true);
  return view.getFloat32(0, true);
}

function bindingComponentCount(binding: NativeRecord, completeTransformBindings = false): number {
  const typeId = Math.round(finite(binding.typeID));
  const attribute = Math.round(finite(binding.attribute));
  if (typeId === 4 && attribute === ATTRIBUTE_TRANSFORM_POSITION) return 3;
  if (completeTransformBindings && typeId === 4 && (attribute === 3 || attribute === 4)) return 3;
  if (completeTransformBindings && typeId === 4 && attribute === 2) return 4;
  return 1;
}

export function readNativeAnimationClip(
  value: unknown,
  options?: { completeTransformBindings?: boolean },
): NativeAnimationClip | undefined {
  const root = record(value);
  if (root?.type !== "AnimationClip") return undefined;
  const data = record(root.data);
  const muscle = record(data?.m_MuscleClip);
  const clip = record(muscle?.m_Clip);
  const clipData = record(clip?.data);
  const streamed = record(clipData?.m_StreamedClip);
  const words = array(streamed?.data).map((word) => Math.round(finite(word)) >>> 0);
  const curveCount = Math.max(0, Math.round(finite(streamed?.curveCount)));
  const constant = record(clipData?.m_ConstantClip);
  const constantValues = array(constant?.data).map((entry) => finite(entry));
  if (words.length === 0 && constantValues.length === 0) return undefined;
  const frames: NativeClipFrame[] = [];
  let cursor = 0;
  while (cursor + 2 <= words.length) {
    const time = bitsToFloat(words[cursor++]!);
    const keyCount = words[cursor++]!;
    if (keyCount > curveCount || cursor + keyCount * 5 > words.length) break;
    const coefficients = new Map<number, readonly [number, number, number, number]>();
    for (let index = 0; index < keyCount; index += 1) {
      const curveIndex = words[cursor++]!;
      const a = bitsToFloat(words[cursor++]!);
      const b = bitsToFloat(words[cursor++]!);
      const c = bitsToFloat(words[cursor++]!);
      const d = bitsToFloat(words[cursor++]!);
      coefficients.set(curveIndex, [a, b, c, d]);
    }
    frames.push({ time, coefficients });
  }
  const bindings: NativeClipBinding[] = [];
  let curveStart = 0;
  const totalCurveCount = curveCount + constantValues.length;
  const bindingRoot = record(data?.m_ClipBindingConstant);
  for (const rawBinding of array(bindingRoot?.genericBindings)) {
    const binding = record(rawBinding);
    if (!binding) continue;
    const componentCount = bindingComponentCount(binding, options?.completeTransformBindings);
    if (curveStart >= totalCurveCount) break;
    bindings.push({
      path: Math.round(finite(binding.path)) >>> 0,
      attribute: Math.round(finite(binding.attribute)) >>> 0,
      curveStart,
      typeId: Math.round(finite(binding.typeID)),
      componentCount: Math.min(componentCount, totalCurveCount - curveStart),
    });
    curveStart += componentCount;
  }
  const bindingLookup = new Map<number, Map<number, NativeClipBinding>>();
  for (const binding of bindings) {
    let attributes = bindingLookup.get(binding.path);
    if (!attributes) {
      attributes = new Map();
      bindingLookup.set(binding.path, attributes);
    }
    attributes.set(binding.attribute, binding);
  }
  return {
    duration: Math.max(
      0,
      finite(muscle?.m_StopTime, frames.filter((frame) => Number.isFinite(frame.time)).at(-1)?.time ?? 0),
    ),
    streamedCurveCount: curveCount,
    constantValues,
    frames,
    curveFrames: indexNativeCurveFrames(frames),
    bindings,
    bindingLookup,
  };
}

function indexNativeCurveFrames(
  frames: ReadonlyArray<NativeClipFrame>,
): ReadonlyMap<number, ReadonlyArray<NativeClipFrame>> | undefined {
  let previous = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    if (Number.isNaN(frame.time) || frame.time < previous) return undefined;
    previous = frame.time;
  }
  const indexed = new Map<number, NativeClipFrame[]>();
  for (const frame of frames)
    for (const curveIndex of frame.coefficients.keys()) {
      let values = indexed.get(curveIndex);
      if (!values) indexed.set(curveIndex, (values = []));
      values.push(frame);
    }
  return indexed;
}

function clipCurveValue(
  clip: NativeAnimationClip | undefined,
  curveIndex: number,
  time: number,
): number | undefined {
  if (!clip) return undefined;
  if (curveIndex >= clip.streamedCurveCount) return clip.constantValues[curveIndex - clip.streamedCurveCount];
  let frame: NativeClipFrame | undefined;
  if (clip.curveFrames && Number.isFinite(time)) {
    const values = clip.curveFrames.get(curveIndex);
    if (values) {
      let left = 0,
        right = values.length;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (values[middle]!.time <= time) left = middle + 1;
        else right = middle;
      }
      frame = values[left - 1];
    }
  } else {
    for (const candidate of clip.frames) {
      if (candidate.time > time) break;
      if (candidate.coefficients.has(curveIndex)) frame = candidate;
    }
  }
  const coefficients = frame?.coefficients.get(curveIndex);
  if (!frame || !coefficients) return undefined;
  const delta = time - frame.time;
  return ((coefficients[0] * delta + coefficients[1]) * delta + coefficients[2]) * delta + coefficients[3];
}

function clipBindingValue(
  clip: NativeAnimationClip | undefined,
  path: number,
  attribute: number,
  time: number,
  component = 0,
): number | undefined {
  const binding = clip?.bindingLookup.get(path)?.get(attribute);
  if (!binding || component >= binding.componentCount) return undefined;
  return clipCurveValue(clip, binding.curveStart + component, time);
}

/** Read a native clip's authored scalar/vector component without changing its shared animation sampler. */
export function nativeAnimationClipBindingValue(
  clip: NativeAnimationClip | undefined,
  path: number,
  attribute: number,
  time: number,
  component = 0,
  typeId?: number,
): number | undefined {
  if (typeId === undefined) return clipBindingValue(clip, path, attribute, time, component);
  const binding = clip?.bindings.find(
    (value) => value.path === path && value.attribute === attribute && value.typeId === typeId,
  );
  if (!binding || component >= binding.componentCount) return undefined;
  return clipCurveValue(clip, binding.curveStart + component, time);
}

export function nativeAnimationClipPosition(
  clip: NativeAnimationClip | undefined,
  path: number,
  time: number,
  target: [number, number, number],
): void {
  target[0] = clipBindingValue(clip, path, ATTRIBUTE_TRANSFORM_POSITION, time, 0) ?? 0;
  target[1] = clipBindingValue(clip, path, ATTRIBUTE_TRANSFORM_POSITION, time, 1) ?? 0;
  target[2] = clipBindingValue(clip, path, ATTRIBUTE_TRANSFORM_POSITION, time, 2) ?? 0;
}

function animationPathHierarchy(path: string): number[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => unityStringHash(parts.slice(0, index + 1).join("/")));
}

function loadedParticleSystem(
  data: NativeParticleSystemData,
  ref: Effect001ParticleSystemAssetRef,
): LoadedParticleSystem {
  const animationPath = ref.animationPath;
  const hierarchy = ref.baseActiveHierarchy;
  return {
    ...data,
    ref,
    animationPathHash: animationPath ? unityStringHash(animationPath) : undefined,
    animationPathHierarchy: hierarchy
      ? hierarchy.map((entry) => unityStringHash(entry.path))
      : animationPath ? animationPathHierarchy(animationPath) : EMPTY_PATH_HASHES,
    baseActiveByPath: new Map(hierarchy?.map((entry) => [unityStringHash(entry.path), entry.active]) ?? []),
    nameHash: hash(ref.name),
    motionSource: readNativeParticleMotionSource(data.raw),
    emissionBuffer: [],
    emissionPool: [],
  };
}

function particleSystemActiveAt(
  clip: NativeAnimationClip,
  system: LoadedParticleSystem,
  time: number,
): boolean {
  return system.animationPathHierarchy.every((path) => {
    const active = clipBindingValue(clip, path, ATTRIBUTE_ACTIVE, time);
    return active === undefined ? (system.baseActiveByPath?.get(path) ?? true) : active >= 0.5;
  });
}

/**
 * Mirrors Animator-driven GameObject lifetime for a ParticleSystem. This is
 * evaluated before emission: merely hiding an initially inactive system would
 * preserve particles that have not started in the native prefab yet.
 */
function particleSystemPlayback(
  system: LoadedParticleSystem,
  manifest: Effect001PrefabAssetRef,
  animation: NativeAnimationClip | undefined,
  effectAge: number,
): ParticlePlayback | undefined {
  if (system.ref.rendererEnabled === false) return undefined;
  if (!animation || animation.duration <= 0)
    return system.animationPathHierarchy.every((path) => system.baseActiveByPath?.get(path) ?? true)
      ? { age: effectAge, animationTimeOffset: 0 } : undefined;
  let cycleStart = 0;
  let animationTime = Math.max(0, effectAge);
  if (manifest.loopAnimation) {
    cycleStart = Math.floor(animationTime / animation.duration) * animation.duration;
    animationTime -= cycleStart;
  } else {
    animationTime = Math.min(animationTime, animation.duration);
  }
  if (!particleSystemActiveAt(animation, system, animationTime)) return undefined;

  let active = particleSystemActiveAt(animation, system, 0);
  let activeStart = active ? 0 : undefined;
  for (const frame of animation.frames) {
    if (frame.time <= 0 || frame.time > animationTime) continue;
    const nextActive = particleSystemActiveAt(animation, system, frame.time);
    if (!active && nextActive) activeStart = frame.time;
    active = nextActive;
  }
  if (activeStart === undefined) return undefined;
  // An Animator loop does not restart a ParticleSystem whose GameObject
  // stays active for the entire clip. Keep its emission/simulation age from
  // the effect's activation; animated properties still sample the loop phase.
  if (
    manifest.loopAnimation &&
    particleSystemActiveAt(animation, system, 0) &&
    particleSystemActiveAt(animation, system, animation.duration) &&
    animation.frames.every(
      (frame) =>
        frame.time <= 0 ||
        frame.time > animation.duration ||
        particleSystemActiveAt(animation, system, frame.time),
    )
  )
    return { age: Math.max(0, effectAge), animationTimeOffset: 0 };
  return { age: Math.max(0, animationTime - activeStart), animationTimeOffset: cycleStart + activeStart };
}

function animationPlaybackTime(
  manifest: Effect001PrefabAssetRef,
  animation: NativeAnimationClip | undefined,
  absoluteTime: number,
): number {
  if (!animation || animation.duration <= 0) return 0;
  const time = Math.max(0, absoluteTime);
  return manifest.loopAnimation ? time % animation.duration : Math.min(time, animation.duration);
}

function particleSystemSimulationSpeedAt(
  system: LoadedParticleSystem,
  manifest: Effect001PrefabAssetRef,
  animation: NativeAnimationClip | undefined,
  absoluteAnimationTime: number,
): number {
  const animated =
    system.animationPathHash === undefined
      ? undefined
      : clipBindingValue(
          animation,
          system.animationPathHash,
          ATTRIBUTE_PARTICLE_SIMULATION_SPEED,
          animationPlaybackTime(manifest, animation, absoluteAnimationTime),
        );
  return Math.max(Number.EPSILON, animated ?? system.simulationSpeed);
}

function particleSystemDistanceEmissionRate(system: LoadedParticleSystem, seed: number): number {
  const emission = record(system.raw.EmissionModule);
  if (!emission || emission.enabled !== true) return 0;
  return Math.max(0, evaluateNativeMinMaxCurve(emission.rateOverDistance, 0, random(seed + 67)));
}

function particleSystemHasAnimatedSimulationSpeed(
  system: LoadedParticleSystem,
  animation: NativeAnimationClip | undefined,
): boolean {
  const path = system.animationPathHash;
  return (
    path !== undefined &&
    animation?.bindingLookup.get(path)?.has(ATTRIBUTE_PARTICLE_SIMULATION_SPEED) === true
  );
}

function particleSimulationClock(
  system: LoadedParticleSystem,
  manifest: Effect001PrefabAssetRef,
  animation: NativeAnimationClip | undefined,
  animationTimeOffset: number,
  seed: number,
  age: number,
): ParticleSimulationClock {
  const delay = evaluateNativeMinMaxCurve(system.raw.startDelay, 0, random(seed + 1));
  const timeAt = (realTime: number): number => {
    const duration = Math.max(0, realTime);
    let simulated = 0;
    for (let start = 0; start < duration; start += EMISSION_STEP) {
      const step = Math.min(EMISSION_STEP, duration - start);
      simulated +=
        particleSystemSimulationSpeedAt(system, manifest, animation, animationTimeOffset + start + step / 2) *
        step;
    }
    return Math.max(0, simulated - delay);
  };
  return { current: timeAt(age), timeAt };
}

/**
 * Constant-speed systems can derive simulated time in O(1). Keep the sampled
 * clock only for authored speed animation and distance emission, whose old
 * path needs timeAt(realTime) while walking the moving emitter.
 */
function particleSimulationClockFor(
  system: LoadedParticleSystem,
  manifest: Effect001PrefabAssetRef,
  animation: NativeAnimationClip | undefined,
  animationTimeOffset: number,
  seed: number,
  age: number,
): ParticleSimulationClock | undefined {
  if (
    !particleSystemHasAnimatedSimulationSpeed(system, animation) &&
    particleSystemDistanceEmissionRate(system, seed) <= 0
  )
    return undefined;
  return particleSimulationClock(system, manifest, animation, animationTimeOffset, seed, age);
}

function constantParticleSimulationTime(system: LoadedParticleSystem, age: number, seed: number): number {
  const delay = evaluateNativeMinMaxCurve(system.raw.startDelay, 0, random(seed + 1));
  return Math.max(0, Math.max(0, age) * system.simulationSpeed - delay);
}

function transparentTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

function configure(texture: Texture): Texture {
  // PlayerSettings.m_ActiveColorSpace is Gamma. The effect shader samples
  // authored texels directly; an sRGB decode here changes both HDR thresholding
  // and the apparent particle colors.
  texture.colorSpace = NoColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

class ParticleQuadBatch {
  readonly geometry: InstancedBufferGeometry;
  readonly material: ShaderMaterial;
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;

  private readonly instances: InstancedInterleavedBuffer;
  private readonly center: InterleavedBufferAttribute;
  private readonly size: InterleavedBufferAttribute;
  private readonly color: InterleavedBufferAttribute;
  private readonly rotation: InterleavedBufferAttribute;
  private readonly pivot: InterleavedBufferAttribute;
  private readonly maxParticleSize: InterleavedBufferAttribute;
  private readonly renderMode: InterleavedBufferAttribute;
  private readonly tint: InterleavedBufferAttribute;
  private readonly defaultTint: readonly [number, number, number, number];
  private readonly capacity: number;
  private cursor = 0;

  constructor(
    name: string,
    capacity: number,
    texture: Texture,
    tint: readonly [number, number, number, number],
  ) {
    this.capacity = capacity;
    this.defaultTint = tint;
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    this.geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    // One active-prefix upload retains every authored per-instance value.
    this.instances = new InstancedInterleavedBuffer(new Float32Array(capacity * 18), 18).setUsage(
      DynamicDrawUsage,
    );
    this.center = new InterleavedBufferAttribute(this.instances, 3, 0);
    this.size = new InterleavedBufferAttribute(this.instances, 2, 3);
    this.color = new InterleavedBufferAttribute(this.instances, 4, 5);
    this.rotation = new InterleavedBufferAttribute(this.instances, 1, 9);
    this.pivot = new InterleavedBufferAttribute(this.instances, 2, 10);
    this.maxParticleSize = new InterleavedBufferAttribute(this.instances, 1, 12);
    this.renderMode = new InterleavedBufferAttribute(this.instances, 1, 13);
    this.geometry.setAttribute("aCenter", this.center);
    this.geometry.setAttribute("aSize", this.size);
    this.geometry.setAttribute("aColor", this.color);
    this.geometry.setAttribute("aRotation", this.rotation);
    this.geometry.setAttribute("aPivot", this.pivot);
    this.geometry.setAttribute("aMaxParticleSize", this.maxParticleSize);
    this.geometry.setAttribute("aRenderMode", this.renderMode);
    this.tint = new InterleavedBufferAttribute(this.instances, 4, 14);
    this.geometry.setAttribute("aTint", this.tint);
    this.geometry.instanceCount = 0;
    this.material = new ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
      },
      vertexShader: `
        attribute vec3 aCenter;
        attribute vec2 aSize;
        attribute vec4 aColor;
        attribute float aRotation;
        attribute vec2 aPivot;
        attribute float aMaxParticleSize;
        attribute float aRenderMode;
        attribute vec4 aTint;

        varying vec2 vUv;
        varying vec4 vColor;
        void main() {
          float cosine = cos(aRotation);
          float sine = sin(aRotation);
          // ParticleSystemRenderer.pivot is expressed in particle-diameter
          // units. It is a translation of the rendered quad: positive Y
          // lifts the streak above its emitter (0.3 on effect001 up-flick beams).
          vec2 offset = (position.xy + aPivot) * aSize;
          offset = mat2(cosine, -sine, sine, cosine) * offset;
          vUv = uv;
          // Compiled Custom/Mobile/MobileAddHdrColor GLES3 vertex program:
          //     vs_COLOR0 = in_COLOR0 * _TintColor * _TintColor * 2
          vColor = aColor * aTint * aTint * 2.0;
          // Vertical billboards share the camera direction and retain world Y,
          // matching the authored renderer and the other rendering backends.
          vec4 worldCenter = modelMatrix * vec4(aCenter, 1.0);
          vec3 right;
          vec3 up = vec3(0.0, 1.0, 0.0);
          if (aRenderMode < 0.5) {
            right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          } else if (aRenderMode < 2.5) {
            right = vec3(1.0, 0.0, 0.0);
            up = vec3(0.0, 0.0, -1.0);
          } else if (aRenderMode < 3.5) {
            vec2 cameraBackward = vec2(viewMatrix[0][2], viewMatrix[2][2]);
            float horizontalLength = length(cameraBackward);
            right = horizontalLength > 0.0
              ? vec3(cameraBackward.y, 0.0, -cameraBackward.x) / horizontalLength
              : vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          } else {
            vec2 horizontal = (cameraPosition - worldCenter.xyz).xz;
            float horizontalLength = max(length(horizontal), 0.000001);
            right = vec3(horizontal.y, 0.0, -horizontal.x) / horizontalLength;
          }
          // Clamp size at the particle centre, before the pivot offset.
          // Projecting the unbounded/pivot-shifted corners first can cross
          // the near plane and collapse a large beam almost to zero. The
          // Our Notes 0.3.2 up-flick reference at video 06hRcPjHaRg / 60s
          // exposes both that failure and the reversed pivot direction.
          vec4 viewCenter = viewMatrix * worldCenter;
          float diameter = max(abs(aSize.x), abs(aSize.y));
          float screenExtent = diameter * abs(projectionMatrix[1][1])
            / (2.0 * max(abs(viewCenter.z), 0.000001));
          float particleScale = aMaxParticleSize > 0.0
            ? min(1.0, aMaxParticleSize / max(screenExtent, 0.000001))
            : 1.0;
          vec3 worldPosition = worldCenter.xyz + right * offset.x * particleScale + up * offset.y * particleScale;
          gl_Position = projectionMatrix * viewMatrix * vec4(worldPosition, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;

        varying vec2 vUv;
        varying vec4 vColor;
        float roundEvenPositive(float value) {
          float lower = floor(value);
          float fraction = value - lower;
          if (fraction < 0.5) return lower;
          if (fraction > 0.5) return lower + 1.0;
          return mod(lower, 2.0) == 0.0 ? lower : lower + 1.0;
        }
        void main() {
          vec4 texel = texture2D(uMap, vUv);
          // Compiled fragment program quantizes vertex alpha to Color32,
          // after the vertex stage has applied both tint factors and doubled it.
          vec4 hdrColor;
          hdrColor.rgb = vColor.rgb;
          hdrColor.a = roundEvenPositive(vColor.a * 255.0) / 255.0;
          float alpha = texel.a * hdrColor.a;
          gl_FragColor = vec4(texel.rgb * hdrColor.rgb, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Shader state rtBlend0: srcBlend=5 (SrcAlpha), destBlend=1
      // (One), Add; rtSeparateBlend=false uses the same factors for alpha.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: OneFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: SrcAlphaFactor,
      blendDstAlpha: OneFactor,
      side: DoubleSide,
      toneMapped: false,
    });
    // Every particle is a flat billboard. A single unculled DoubleSide pass
    // has identical coverage and avoids Three's transparent back/front draws.
    this.material.forceSinglePass = true;
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = `Effect001Particles:${name}`;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6002;
  }

  reset(): void {
    this.cursor = 0;
  }

  push(
    x: number,
    y: number,
    z: number,
    sizeX: number,
    sizeY: number,
    color: NativeColor,
    rotation: number,
    maxParticleSize = 1,
    pivotX = 0,
    pivotY = 0,
    materialTint?: readonly [number, number, number, number],
    renderMode: 0 | 2 | 3 = 3,
  ): boolean {
    if (this.cursor >= this.capacity) return false;
    this.center.setXYZ(this.cursor, x, y, z);
    this.size.setXY(this.cursor, sizeX, sizeY);
    this.color.setXYZW(this.cursor, color.r, color.g, color.b, color.a);
    this.rotation.setX(this.cursor, rotation);
    this.maxParticleSize.setX(this.cursor, maxParticleSize);
    this.renderMode.setX(this.cursor, renderMode);
    this.pivot.setXY(this.cursor, pivotX, pivotY);
    this.tint.setXYZW(this.cursor, ...(materialTint ?? this.defaultTint));
    this.cursor += 1;
    return true;
  }

  finish(): void {
    this.geometry.instanceCount = this.cursor;
    this.mesh.visible = this.cursor > 0;
    if (this.cursor === 0) return;
    this.instances.clearUpdateRanges();
    this.instances.addUpdateRange(0, this.cursor * this.instances.stride);
    this.instances.needsUpdate = true;
  }

  setTexture(texture: Texture): void {
    this.material.uniforms.uMap.value = texture;
  }

  get count(): number {
    return this.cursor;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Instanced native SpriteRenderer/wall-mesh batch; one draw call per source texture. */
class EffectMeshBatch {
  readonly geometry: InstancedBufferGeometry;
  readonly material: ShaderMaterial;
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;

  private readonly instances: InstancedInterleavedBuffer;
  private readonly center: InterleavedBufferAttribute;
  private readonly scale: InterleavedBufferAttribute;
  private readonly color: InterleavedBufferAttribute;
  private readonly rotationX: InterleavedBufferAttribute;
  private readonly tint: InterleavedBufferAttribute;
  private readonly defaultTint: readonly [number, number, number, number];
  private readonly capacity: number;
  private cursor = 0;

  constructor(
    name: string,
    source: BufferGeometry,
    capacity: number,
    texture: Texture,
    tint: readonly [number, number, number, number],
    sliceBorder?: readonly [number, number],
    meshPivot: readonly [number, number, number] = [0, 0, 0],
    blendDestination: typeof OneFactor | typeof OneMinusSrcAlphaFactor = OneFactor,
    blendSourceAlpha: typeof SrcAlphaFactor | typeof OneFactor = SrcAlphaFactor,
    shaderMode: EffectMeshShaderMode = "mobileAddHdr",
  ) {
    this.capacity = capacity;
    this.defaultTint = tint;
    this.geometry = new InstancedBufferGeometry();
    const position = source.getAttribute("position");
    const uv = source.getAttribute("uv");
    this.geometry.setAttribute("position", position.clone());
    if (uv) this.geometry.setAttribute("uv", uv.clone());
    if (source.index) this.geometry.setIndex(source.index.clone());
    // One active-prefix upload retains every authored per-instance value.
    this.instances = new InstancedInterleavedBuffer(new Float32Array(capacity * 15), 15).setUsage(
      DynamicDrawUsage,
    );
    this.center = new InterleavedBufferAttribute(this.instances, 3, 0);
    this.scale = new InterleavedBufferAttribute(this.instances, 3, 3);
    this.color = new InterleavedBufferAttribute(this.instances, 4, 6);
    this.rotationX = new InterleavedBufferAttribute(this.instances, 1, 10);
    this.geometry.setAttribute("aCenter", this.center);
    this.geometry.setAttribute("aScale", this.scale);
    this.geometry.setAttribute("aColor", this.color);
    this.geometry.setAttribute("aRotationX", this.rotationX);
    this.tint = new InterleavedBufferAttribute(this.instances, 4, 11);
    this.geometry.setAttribute("aTint", this.tint);
    this.geometry.instanceCount = 0;
    this.material = new ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uSliceBorder: { value: new Vector2(...(sliceBorder ?? [0, 0])) },
        uSliced: { value: sliceBorder ? 1 : 0 },
        uMeshPivot: { value: new Vector3(...meshPivot) },
      },
      vertexShader: `
        attribute vec3 aCenter;
        attribute vec3 aScale;
        attribute vec4 aColor;
        attribute float aRotationX;
        attribute vec4 aTint;

        uniform vec2 uSliceBorder;
        uniform float uSliced;
        uniform vec3 uMeshPivot;
        varying vec2 vUv;
        varying vec4 vColor;
        void main() {
          vec3 offset = (position - uMeshPivot) * aScale;
          if (uSliced > 0.5) {
            // position.xy stores one of four signed slice tags. Unity's
            // SpriteDrawMode.Sliced keeps the 40px/100PPU borders at a fixed
            // world width while SetWidth stretches only the center region.
            offset.x = position.x < -1.0
              ? -aScale.x * 0.5
              : position.x < 0.0
                ? -aScale.x * 0.5 + uSliceBorder.x
                : position.x < 1.0
                  ? aScale.x * 0.5 - uSliceBorder.x
                  : aScale.x * 0.5;
            offset.y = position.y < -1.0
              ? -aScale.y * 0.5
              : position.y < 0.0
                ? -aScale.y * 0.5 + uSliceBorder.y
                : position.y < 1.0
                  ? aScale.y * 0.5 - uSliceBorder.y
                  : aScale.y * 0.5;
          }
          float cosine = cos(aRotationX);
          float sine = sin(aRotationX);
          offset.yz = mat2(cosine, sine, -sine, cosine) * offset.yz;
          vUv = uv;
          vColor = ${shaderMode === "uiAdditive" ? "aColor * aTint" : "aColor * aTint * aTint * 2.0"};
          gl_Position = projectionMatrix * modelViewMatrix * vec4(aCenter + offset, 1.0);
        }
      `,
      fragmentShader:
        shaderMode === "uiAdditive"
          ? `
            uniform sampler2D uMap;
            varying vec2 vUv;
            varying vec4 vColor;
            void main() {
              vec4 color = texture2D(uMap, vUv) * vColor;
              // Compiled UI/Additive GLES3 program premultiplies RGB, then
              // the fixed One/One blend state adds it to the framebuffer.
              gl_FragColor = vec4(color.rgb * color.a, color.a);
            }
          `
          : `
            uniform sampler2D uMap;

            varying vec2 vUv;
            varying vec4 vColor;
            float roundEvenPositive(float value) {
              float lower = floor(value);
              float fraction = value - lower;
              if (fraction < 0.5) return lower;
              if (fraction > 0.5) return lower + 1.0;
              return mod(lower, 2.0) == 0.0 ? lower : lower + 1.0;
            }
            void main() {
              vec4 texel = texture2D(uMap, vUv);
              vec4 hdrColor;
              hdrColor.rgb = vColor.rgb;
              hdrColor.a = roundEvenPositive(vColor.a * 255.0) / 255.0;
              float alpha = texel.a * hdrColor.a;
              gl_FragColor = vec4(texel.rgb * hdrColor.rgb, alpha);
            }
          `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: shaderMode === "uiAdditive" ? OneFactor : SrcAlphaFactor,
      blendDst: blendDestination,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: blendSourceAlpha,
      blendDstAlpha: blendDestination,
      side: DoubleSide,
      toneMapped: false,
    });
    // These additive sprite/wall triangles do not need the transparent
    // DoubleSide two-pass ordering used for closed alpha-blended surfaces.
    this.material.forceSinglePass = true;
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = `Effect001Mesh:${name}`;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6001;
  }

  reset(): void {
    this.cursor = 0;
  }

  push(
    x: number,
    y: number,
    z: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    red: number,
    green: number,
    blue: number,
    alpha: number,
    rotationX = 0,
    materialTint?: readonly [number, number, number, number],
  ): boolean {
    if (this.cursor >= this.capacity) return false;
    this.center.setXYZ(this.cursor, x, y, z);
    this.scale.setXYZ(this.cursor, scaleX, scaleY, scaleZ);
    this.color.setXYZW(this.cursor, red, green, blue, alpha);
    this.rotationX.setX(this.cursor, rotationX);
    this.tint.setXYZW(this.cursor, ...(materialTint ?? this.defaultTint));
    this.cursor += 1;
    return true;
  }

  finish(): void {
    this.geometry.instanceCount = this.cursor;
    this.mesh.visible = this.cursor > 0;
    if (this.cursor === 0) return;
    this.instances.clearUpdateRanges();
    this.instances.addUpdateRange(0, this.cursor * this.instances.stride);
    this.instances.needsUpdate = true;
  }

  setTexture(texture: Texture): void {
    this.material.uniforms.uMap.value = texture;
  }

  get count(): number {
    return this.cursor;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function createSlicedSpriteGeometry(): BufferGeometry {
  // ef_tap_line Sprite: full 128x128 rect with 40px borders on every side.
  // Position components are slice tags interpreted by EffectMeshBatch so the
  // borders remain 0.4 world units instead of stretching with note width.
  const tags = [-1.5, -0.5, 0.5, 1.5] as const;
  const uv = [0, 40 / 128, 88 / 128, 1] as const;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      positions.push(tags[x]!, tags[y]!, 0);
      uvs.push(uv[x]!, uv[y]!);
    }
  }
  const indices: number[] = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const lowerLeft = y * 4 + x;
      const lowerRight = lowerLeft + 1;
      const upperLeft = lowerLeft + 4;
      const upperRight = upperLeft + 1;
      indices.push(lowerLeft, lowerRight, upperRight, lowerLeft, upperRight, upperLeft);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  return geometry;
}

function createWallGeometry(): BufferGeometry {
  const positions = [
    -0.966932595, 0, -0.00000006, -0.966932595, 2.408502817, 0.000000014, -0.983466268, 2.408502817,
    -0.00443018, -0.983466268, 0, -0.004430255, -0.995569766, 2.408502817, -0.016533695, -0.995569766,
    -0.000000001, -0.01653377, -1, 2.408502817, -0.033067405, -1, -0.000000001, -0.03306748, 1, -0.000000001,
    -0.03306748, 1, 2.408502817, -0.033067405, 0.995569766, 2.408502817, -0.016533695, 0.995569766,
    -0.000000001, -0.01653377, 0.983466268, 2.408502817, -0.00443018, 0.983466268, 0, -0.004430255,
    0.966932595, 2.408502817, 0.000000014, 0.966932595, 0, -0.00000006, -1, -0.000000044, -1, -1,
    -0.000000001, -0.03306748, -1, 2.408502817, -0.033067405, -1, 2.408502817, -1, -0.966932595, 0,
    -0.00000006, 0.966932595, 0, -0.00000006, 0.966932595, 2.408502817, 0.000000014, -0.966932595,
    2.408502817, 0.000000014, 1, -0.000000001, -0.03306748, 1, -0.000000044, -1, 1, 2.408502817, -1, 1,
    2.408502817, -0.033067405,
  ];
  const uvs = [
    0.2742908, 0.003899515, 0.2742908, 0.999999642, 0.257075697, 0.999999642, 0.257075697, 0.003899515,
    0.241160661, 0.999999642, 0.241160661, 0.003899515, 0.224267989, 1, 0.224267989, 0.003899902, 0.770728827,
    0.003899515, 0.770728827, 0.999999642, 0.756421268, 0.999999642, 0.756421268, 0.003899515, 0.74077493,
    0.999999642, 0.74077493, 0.003899515, 0.725790977, 0.999999642, 0.725790977, 0.003899515, 0, 0.003899515,
    0.224267989, 0.003899902, 0.224267989, 1, 0, 1, 0.2742908, 0.003899515, 0.725790977, 0.003899515,
    0.725790977, 0.999999642, 0.2742908, 0.999999642, 0.770728827, 0.003899515, 1, 0.003899515, 1, 1,
    0.770728827, 0.999999642,
  ];
  // effect.bundle vertices are Unity world-local coordinates. Reflect every
  // authored Z component together with the rest of the scene.
  for (let index = 2; index < positions.length; index += 3) positions[index] = -positions[index]!;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex([
    0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5, 5, 4, 6, 5, 6, 7, 8, 9, 10, 8, 10, 11, 11, 10, 12, 11, 12, 13, 13, 12,
    14, 13, 14, 15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23, 24, 25, 26, 24, 26, 27,
  ]);
  return geometry;
}

/** A world-space textured quad: corners in (u0,v0) (u1,v0) (u1,v1) (u0,v1) order. */
export interface NativeWorldQuad {
  corners: [Vector3, Vector3, Vector3, Vector3];
  uv: readonly [u0: number, v0: number, u1: number, v1: number];
}

/**
 * TypeScript mirror of the ParticleQuadBatch vertex shader for Unity View,
 * Horizontal and Vertical billboards, with pivot and max-size clamp at centre.
 */
export function nativeBillboardQuad(
  trace: NativeBillboardTrace,
  cameraPosition: Vector3,
  viewMatrix: { elements: ArrayLike<number> },
  projectionScaleY: number,
): NativeWorldQuad {
  const e = viewMatrix.elements;
  const mode = trace.renderMode ?? 3;
  let right: number[];
  if (mode === 0) right = [e[0]!, e[4]!, e[8]!];
  else if (mode === 2) right = [1, 0, 0];
  else if (mode === 3) {
    // Three reflects authored Z: the camera backward row supplies the same
    // world-Y-locked basis as cross(worldUp, cameraForward) in authored space.
    const horizontalLength = Math.hypot(e[2]!, e[10]!);
    right = horizontalLength > 0
      ? [e[10]! / horizontalLength, 0, -e[2]! / horizontalLength]
      : [e[0]!, e[4]!, e[8]!];
  } else {
    const toCameraX = cameraPosition.x - trace.x;
    const toCameraZ = cameraPosition.z - trace.z;
    const horizontalLength = Math.max(Math.hypot(toCameraX, toCameraZ), 0.000001);
    right = [toCameraZ / horizontalLength, 0, -toCameraX / horizontalLength];
  }
  const up = mode === 0 ? [e[1]!, e[5]!, e[9]!] : mode === 2 ? [0, 0, -1] : [0, 1, 0];
  const viewZ = e[2]! * trace.x + e[6]! * trace.y + e[10]! * trace.z + e[14]!;
  const diameter = Math.max(Math.abs(trace.sizeX), Math.abs(trace.sizeY));
  const screenExtent = (diameter * Math.abs(projectionScaleY)) / (2 * Math.max(Math.abs(viewZ), 0.000001));
  const particleScale =
    trace.maxParticleSize > 0 ? Math.min(1, trace.maxParticleSize / Math.max(screenExtent, 0.000001)) : 1;
  const cosine = Math.cos(trace.rotation);
  const sine = Math.sin(trace.rotation);
  const corner = (px: number, py: number): Vector3 => {
    const ox = (px + trace.pivotX) * trace.sizeX;
    const oy = (py + trace.pivotY) * trace.sizeY;
    // GLSL mat2(c, -s, s, c) * v is column-major: (c*x + s*y, -s*x + c*y).
    const rx = (cosine * ox + sine * oy) * particleScale;
    const ry = (-sine * ox + cosine * oy) * particleScale;
    return new Vector3(
      trace.x + right[0]! * rx + up[0]! * ry,
      trace.y + right[1]! * rx + up[1]! * ry,
      trace.z + right[2]! * rx + up[2]! * ry,
    );
  };
  return {
    corners: [corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)],
    uv: [0, 0, 1, 1],
  };
}

const NATIVE_MESH_QUADS = new Map<
  NativeMeshTrace["kind"],
  ReadonlyArray<{ position: number[][]; uv: number[][] }>
>();

function meshQuads(kind: NativeMeshTrace["kind"]): ReadonlyArray<{ position: number[][]; uv: number[][] }> {
  let quads = NATIVE_MESH_QUADS.get(kind);
  if (quads) return quads;
  if (kind === "pillar" || kind === "lane") {
    // PlaneGeometry(1, 1): the unit quad around the origin.
    quads = [
      {
        position: [
          [-0.5, -0.5, 0],
          [0.5, -0.5, 0],
          [0.5, 0.5, 0],
          [-0.5, 0.5, 0],
        ],
        uv: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
    ];
    NATIVE_MESH_QUADS.set(kind, quads);
    return quads;
  }
  const geometry = kind === "frame" ? createSlicedSpriteGeometry() : createWallGeometry();
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const index = geometry.index!;
  const result: Array<{ position: number[][]; uv: number[][] }> = [];
  // Every source mesh is a list of (a, b, c, a, c, d) triangle pairs.
  for (let offset = 0; offset + 5 < index.count; offset += 6) {
    const ids = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2), index.getX(offset + 5)];
    result.push({
      position: ids.map((id) => [position.getX(id), position.getY(id), position.getZ(id)]),
      uv: ids.map((id) => [uv.getX(id), uv.getY(id)]),
    });
  }
  geometry.dispose();
  quads = result;
  NATIVE_MESH_QUADS.set(kind, quads);
  return quads;
}

/** TypeScript mirror of the EffectMeshBatch vertex shader (sliced frame, pillar plane, wall mesh). */
export function nativeMeshQuads(trace: NativeMeshTrace): NativeWorldQuad[] {
  const pivot = trace.kind === "wall" ? [0, WALL_MESH_SHADER_PIVOT_Y, 0.5] : [0, 0, 0];
  const cosine = Math.cos(trace.rotationX);
  const sine = Math.sin(trace.rotationX);
  const transform = ([px, py, pz]: number[]): Vector3 => {
    let x = (px! - pivot[0]!) * trace.scaleX;
    let y = (py! - pivot[1]!) * trace.scaleY;
    const z = (pz! - pivot[2]!) * trace.scaleZ;
    if (trace.kind === "frame") {
      const slice = (tag: number, scale: number, border: number): number =>
        tag < -1
          ? -scale * 0.5
          : tag < 0
            ? -scale * 0.5 + border
            : tag < 1
              ? scale * 0.5 - border
              : scale * 0.5;
      x = slice(px!, trace.scaleX, FRAME_SLICE_BORDER[0]);
      y = slice(py!, trace.scaleY, FRAME_SLICE_BORDER[1]);
    }
    // GLSL mat2(c, s, -s, c) * (y, z) = (c*y - s*z, s*y + c*z).
    return new Vector3(trace.x + x, trace.y + cosine * y - sine * z, trace.z + sine * y + cosine * z);
  };
  return meshQuads(trace.kind).map((quad) => {
    const us = quad.uv.map((value) => value[0]!);
    const vs = quad.uv.map((value) => value[1]!);
    // Reorder the four corners to (u0,v0) (u1,v0) (u1,v1) (u0,v1).
    const u0 = Math.min(...us);
    const u1 = Math.max(...us);
    const v0 = Math.min(...vs);
    const v1 = Math.max(...vs);
    const pick = (u: number, v: number): Vector3 => {
      let best = 0;
      let bestDistance = Infinity;
      for (let index = 0; index < 4; index += 1) {
        const distance = Math.abs(quad.uv[index]![0]! - u) + Math.abs(quad.uv[index]![1]! - v);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      return transform(quad.position[best]!);
    };
    return { corners: [pick(u0, v0), pick(u1, v0), pick(u1, v1), pick(u0, v1)], uv: [u0, v0, u1, v1] };
  });
}

function shapePosition(
  system: LoadedParticleSystem,
  seed: number,
  nativeWidth: number,
  target: [number, number, number],
  initialDirection: [number, number, number],
): void {
  initialDirection[0] = 0;
  initialDirection[1] = 0;
  initialDirection[2] = 0;
  const shape = record(system.raw.ShapeModule);
  if (!shape || shape.enabled !== true) {
    target[0] = 0;
    target[1] = 0;
    target[2] = 0;
    return;
  }
  const scale = record(shape.m_Scale);
  const width =
    system.ref.shapeWidthOffset === undefined
      ? finite(scale?.x)
      : Math.max(0, nativeWidth + system.ref.shapeWidthOffset);
  const height = finite(scale?.y);
  const depth = finite(scale?.z);
  const type = Math.round(finite(shape.type));
  let x: number;
  let y: number;
  let z: number;
  if (type === 10) {
    const angle = (random(seed + 3) * finite(record(shape.arc)?.value) * Math.PI) / 180;
    const radius = finite(record(shape.radius)?.value),
      inner = 1 - finite(shape.radiusThickness);
    const radialDistance = radius * Math.sqrt(inner * inner + (1 - inner * inner) * random(seed + 5));
    const directionX = radialDistance > 0 ? Math.cos(angle) : 1;
    const directionY = radialDistance > 0 ? Math.sin(angle) : 0;
    x = Math.cos(angle) * radialDistance * width;
    y = Math.sin(angle) * radialDistance * height;
    z = 0;
    // Shape.scale changes the birth ellipse; it does not mirror or stretch the radial direction.
    const rotation = record(shape.m_Rotation),
      rx = (finite(rotation?.x) * Math.PI) / 180;
    initialDirection[0] = directionX;
    initialDirection[1] = directionY * Math.cos(rx);
    initialDirection[2] = directionY * Math.sin(rx);
  } else if (type === 16) {
    const perimeter = random(seed + 3) * Math.max(Number.EPSILON, 2 * (width + height));
    if (perimeter < width) {
      x = -width / 2 + perimeter;
      y = -height / 2;
    } else if (perimeter < width + height) {
      x = width / 2;
      y = -height / 2 + perimeter - width;
    } else if (perimeter < 2 * width + height) {
      x = width / 2 - (perimeter - width - height);
      y = height / 2;
    } else {
      x = -width / 2;
      y = height / 2 - (perimeter - 2 * width - height);
    }
    z = 0;
  } else {
    x = (random(seed + 3) - 0.5) * width;
    y = (random(seed + 5) - 0.5) * height;
    z = (random(seed + 7) - 0.5) * depth;
  }
  const offset = record(shape.m_Position);
  const rotation = record(shape.m_Rotation);
  const rx = (finite(rotation?.x) * Math.PI) / 180;
  const ry = (finite(rotation?.y) * Math.PI) / 180;
  const rz = (finite(rotation?.z) * Math.PI) / 180;
  const rotatedY = y * Math.cos(rx) - z * Math.sin(rx);
  z = y * Math.sin(rx) + z * Math.cos(rx);
  y = rotatedY;
  const rotatedX = x * Math.cos(ry) + z * Math.sin(ry);
  z = -x * Math.sin(ry) + z * Math.cos(ry);
  x = rotatedX;
  const finalX = x * Math.cos(rz) - y * Math.sin(rz);
  y = x * Math.sin(rz) + y * Math.cos(rz);
  x = finalX;
  target[0] = x + finite(offset?.x);
  target[1] = y + finite(offset?.y);
  target[2] = z + finite(offset?.z);
}

/** Only literal constant states are independent of the integration midpoint. */
function timeIndependentCurveValue(value: unknown, curveRandom: number): number | undefined {
  const curve = record(value);
  if (!curve || (curve.minMaxState !== 0 && curve.minMaxState !== 3)) return undefined;
  return evaluateNativeMinMaxCurve(value, 0, curveRandom);
}

function integratedUnconstrainedVelocity(
  system: LoadedParticleSystem,
  particleAge: number,
  lifetime: number,
  curveRandom: number,
  initialPosition: readonly [number, number, number],
  initialVelocity: readonly [number, number, number],
  target: [number, number, number],
): void {
  const velocity = record(system.raw.VelocityModule);
  const initial = record(system.raw.InitialModule);
  const gravityCurve = initial?.gravityModifier;
  const gravityEnabled =
    evaluateNativeMinMaxCurve(gravityCurve, 0.5, curveRandom) !== 0 ||
    evaluateNativeMinMaxCurve(gravityCurve, 1, curveRandom) !== 0;
  const hasInitialVelocity = initialVelocity[0] !== 0 || initialVelocity[1] !== 0 || initialVelocity[2] !== 0;
  if ((velocity?.enabled !== true && !gravityEnabled && !hasInitialVelocity) || particleAge <= 0) {
    target[0] = 0;
    target[1] = 0;
    target[2] = 0;
    return;
  }
  const delta = particleAge;
  const velocityXValue =
    velocity?.enabled === true ? timeIndependentCurveValue(velocity.x, curveRandom) : undefined;
  const velocityYValue =
    velocity?.enabled === true ? timeIndependentCurveValue(velocity.y, curveRandom) : undefined;
  const velocityZValue =
    velocity?.enabled === true ? timeIndependentCurveValue(velocity.z, curveRandom) : undefined;
  const speedModifierValue =
    velocity?.enabled === true && velocity.speedModifier
      ? timeIndependentCurveValue(velocity.speedModifier, curveRandom)
      : undefined;
  const gravityValue = timeIndependentCurveValue(gravityCurve, curveRandom);
  let px = initialPosition[0];
  let py = initialPosition[1];
  let pz = initialPosition[2];
  let baseVelocityX = initialVelocity[0];
  let baseVelocityY = initialVelocity[1];
  let baseVelocityZ = initialVelocity[2];
  const normalized = clamp((0.5 * delta) / Math.max(Number.EPSILON, lifetime));
  let vx =
    velocity?.enabled === true
      ? (velocityXValue ?? evaluateNativeMinMaxCurve(velocity.x, normalized, curveRandom))
      : 0;
  let vy =
    velocity?.enabled === true
      ? (velocityYValue ?? evaluateNativeMinMaxCurve(velocity.y, normalized, curveRandom))
      : 0;
  let vz =
    velocity?.enabled === true
      ? (velocityZValue ?? evaluateNativeMinMaxCurve(velocity.z, normalized, curveRandom))
      : 0;
  if (velocity?.enabled === true) {
    if (
      zeroOrbitRadialModules.has(velocity) &&
      Number.isFinite(px) &&
      Number.isFinite(py) &&
      Number.isFinite(pz)
    ) {
      // Preserve the original signed-zero additions without evaluating seven known-zero curves.
      const relativeX = px - 0,
        relativeY = py - 0,
        relativeZ = pz - 0;
      vx += 0 * relativeZ - 0 * relativeY;
      vy += 0 * relativeX - 0 * relativeZ;
      vz += 0 * relativeY - 0 * relativeX;
      // Away from the tiny origin neighbourhood, any component >epsilon proves hypot >epsilon.
      // Near zero retain the exact threshold; sign(x)*0 equals (x/positiveLength)*0.
      if (
        Math.max(Math.abs(relativeX), Math.abs(relativeY), Math.abs(relativeZ)) > Number.EPSILON ||
        Math.hypot(relativeX, relativeY, relativeZ) > Number.EPSILON
      ) {
        vx += Math.sign(relativeX) * 0;
        vy += Math.sign(relativeY) * 0;
        vz += Math.sign(relativeZ) * 0;
      }
    } else {
      const offsetX = evaluateNativeMinMaxCurve(velocity.orbitalOffsetX, normalized, curveRandom);
      const offsetY = evaluateNativeMinMaxCurve(velocity.orbitalOffsetY, normalized, curveRandom);
      const offsetZ = evaluateNativeMinMaxCurve(velocity.orbitalOffsetZ, normalized, curveRandom);
      const angularX = evaluateNativeMinMaxCurve(velocity.orbitalX, normalized, curveRandom);
      const angularY = evaluateNativeMinMaxCurve(velocity.orbitalY, normalized, curveRandom);
      const angularZ = evaluateNativeMinMaxCurve(velocity.orbitalZ, normalized, curveRandom);
      const relativeX = px - offsetX;
      const relativeY = py - offsetY;
      const relativeZ = pz - offsetZ;
      vx += angularY * relativeZ - angularZ * relativeY;
      vy += angularZ * relativeX - angularX * relativeZ;
      vz += angularX * relativeY - angularY * relativeX;
      const radialLength = Math.hypot(relativeX, relativeY, relativeZ);
      if (radialLength > Number.EPSILON) {
        const radial = evaluateNativeMinMaxCurve(velocity.radial, normalized, curveRandom);
        vx += (relativeX / radialLength) * radial;
        vy += (relativeY / radialLength) * radial;
        vz += (relativeZ / radialLength) * radial;
      }
    }
    const speedModifier = velocity.speedModifier
      ? (speedModifierValue ?? evaluateNativeMinMaxCurve(velocity.speedModifier, normalized, curveRandom))
      : 1;
    vx *= speedModifier;
    vy *= speedModifier;
    vz *= speedModifier;
  }
  const gravity = gravityValue ?? evaluateNativeMinMaxCurve(gravityCurve, normalized, curveRandom);
  baseVelocityY -= 9.81 * gravity * delta;
  vx += baseVelocityX;
  vy += baseVelocityY;
  vz += baseVelocityZ;
  px += vx * delta;
  py += vy * delta;
  pz += vz * delta;
  target[0] = px - initialPosition[0];
  target[1] = py - initialPosition[1];
  target[2] = pz - initialPosition[2];
}

function applyAnimatedStartColor(
  system: LoadedParticleSystem,
  animation: NativeAnimationClip | undefined,
  time: number,
  factor: number,
  color: NativeColor,
): void {
  const path = system.animationPathHash;
  if (!animation || path === undefined || !animation.bindingLookup.has(path)) return;
  const gradient = record(record(system.raw.InitialModule)?.startColor);
  const state = Math.round(finite(gradient?.minMaxState));
  if (state !== 0 && state !== 2) return;
  serializedColor(gradient?.minColor, INITIAL_MIN_COLOR_SCRATCH);
  serializedColor(gradient?.maxColor, INITIAL_MAX_COLOR_SCRATCH);
  for (let i = 0; i < COLOR_CHANNELS.length; i++) {
    const channel = COLOR_CHANNELS[i]!;
    const max = clipBindingValue(animation, path, START_MAX_COLOR_ATTRIBUTES[i]!, time);
    const min = clipBindingValue(animation, path, START_MIN_COLOR_ATTRIBUTES[i]!, time);
    if (state === 0 && max !== undefined) color[channel] = max;
    else if (state === 2 && (min !== undefined || max !== undefined))
      color[channel] = lerp(
        min ?? INITIAL_MIN_COLOR_SCRATCH[channel],
        max ?? INITIAL_MAX_COLOR_SCRATCH[channel],
        factor,
      );
  }
}

function sampleParticle(
  system: LoadedParticleSystem,
  emission: ParticleEmission,
  currentSimulationTime: number,
  nativeWidth: number,
  baseSeed: number,
  startSizeXOverride?: number,
  animation?: NativeAnimationClip,
  animationTimeOffset = 0,
): ParticleSample | undefined {
  const initial = record(system.raw.InitialModule);
  if (!initial) return undefined;
  const seed = baseSeed ^ Math.imul(emission.index + 1, 0x9e3779b9);
  // Keep deterministic, independent channels for different particle modules.
  // Reusing one factor artificially ties large particles to short lifetimes
  // and slow velocities whenever the authored ranges run in opposite orders.
  const lifetimeRandom = random(seed + 11);
  const sizeRandom = random(seed + 17);
  const velocityRandom = random(seed + 23);
  const rotationRandom = random(seed + 29);
  const colorRandom = random(seed + 37);
  const lifetime = Math.max(0, evaluateNativeMinMaxCurve(initial.startLifetime, 0, lifetimeRandom));
  const age = currentSimulationTime - (emission.motion?.birthTime ?? emission.simulationTime);
  if (lifetime <= 0 || age < 0 || age >= lifetime) return undefined;
  const normalized = clamp(age / lifetime);
  if (!emission.motion) {
    shapePosition(
      system,
      seed,
      emission.shapeBirthWidth ?? nativeWidth,
      SHAPE_POSITION_SCRATCH,
      SHAPE_INITIAL_VELOCITY_SCRATCH,
    );
    if (record(system.raw.ShapeModule)?.enabled === true && record(system.raw.ShapeModule)?.type === 10) {
      // The actual eight Circle sources use constant/two-constant start speeds, sampled once at birth.
      const startSpeed = evaluateNativeMinMaxCurve(initial.startSpeed, 0, random(seed + 43));
      for (let axis = 0; axis < 3; axis++)
        SHAPE_INITIAL_VELOCITY_SCRATCH[axis] = SHAPE_INITIAL_VELOCITY_SCRATCH[axis]! * startSpeed;
    }
    integratedUnconstrainedVelocity(
      system,
      age,
      lifetime,
      velocityRandom,
      SHAPE_POSITION_SCRATCH,
      SHAPE_INITIAL_VELOCITY_SCRATCH,
      VELOCITY_POSITION_SCRATCH,
    );
  }
  // SetWidth writes the wall Transform.localScale.x, replacing its serialized
  // prefab value 4.9. Applying both would multiply the native width twice.
  const transformScale =
    system.ref.renderer === "wallMesh" ? UNIT_SCALE : (system.ref.localScale ?? UNIT_SCALE);
  PARTICLE_SAMPLE_SCRATCH.x =
    (emission.motion
      ? emission.originX + emission.motion.x
      : emission.originX + SHAPE_POSITION_SCRATCH[0] + VELOCITY_POSITION_SCRATCH[0]) * transformScale[0];
  PARTICLE_SAMPLE_SCRATCH.y =
    (emission.motion
      ? emission.originY + emission.motion.y
      : emission.originY + SHAPE_POSITION_SCRATCH[1] + VELOCITY_POSITION_SCRATCH[1]) * transformScale[1];
  PARTICLE_SAMPLE_SCRATCH.z =
    (emission.motion
      ? emission.originZ + emission.motion.z
      : emission.originZ + SHAPE_POSITION_SCRATCH[2] + VELOCITY_POSITION_SCRATCH[2]) * transformScale[2];
  const baseSize = evaluateNativeMinMaxCurve(initial.startSize, 0, sizeRandom);
  const baseY =
    initial.size3D === true ? evaluateNativeMinMaxCurve(initial.startSizeY, 0, sizeRandom) : baseSize;
  const baseZ =
    initial.size3D === true ? evaluateNativeMinMaxCurve(initial.startSizeZ, 0, sizeRandom) : baseSize;
  const sizeModule = record(system.raw.SizeModule);
  let sizeX = startSizeXOverride ?? baseSize;
  let sizeY = baseY;
  let sizeZ = baseZ;
  if (sizeModule?.enabled === true) {
    sizeX *= evaluateNativeMinMaxCurve(sizeModule.curve, normalized, sizeRandom);
    const separate = sizeModule.separateAxes === true;
    sizeY *= evaluateNativeMinMaxCurve(separate ? sizeModule.y : sizeModule.curve, normalized, sizeRandom);
    sizeZ *= evaluateNativeMinMaxCurve(separate ? sizeModule.z : sizeModule.curve, normalized, sizeRandom);
  }
  const initialColor = evaluateNativeMinMaxGradient(
    initial.startColor,
    0,
    colorRandom,
    PARTICLE_COLOR_SCRATCH,
  );
  // Bad clips override the initial min/max colours. These bindings are
  // constant in effect001; sample at birth so later particles retain theirs.
  const birthTime =
    animationTimeOffset + (emission.motion?.birthTime ?? emission.simulationTime) / system.simulationSpeed;
  applyAnimatedStartColor(system, animation, birthTime, colorRandom, initialColor);
  quantizeParticleColor(initialColor);

  const colorModule = record(system.raw.ColorModule);
  if (colorModule?.enabled === true) {
    const lifetimeColor = evaluateNativeMinMaxGradient(
      colorModule.gradient,
      normalized,
      colorRandom,
      PARTICLE_LIFETIME_COLOR_SCRATCH,
    );
    initialColor.r *= lifetimeColor.r;
    initialColor.g *= lifetimeColor.g;
    initialColor.b *= lifetimeColor.b;
    initialColor.a *= lifetimeColor.a;
  }
  quantizeParticleColor(initialColor);
  const rotation = evaluateNativeMinMaxCurve(initial.startRotation, 0, rotationRandom);
  const rotationModule = record(system.raw.RotationModule);
  const rotationOverLifetime =
    rotationModule?.enabled === true
      ? evaluateNativeMinMaxCurve(rotationModule.curve, normalized, rotationRandom) * age
      : 0;
  PARTICLE_SAMPLE_SCRATCH.sizeX = sizeX * transformScale[0];
  PARTICLE_SAMPLE_SCRATCH.sizeY = sizeY * transformScale[1];
  PARTICLE_SAMPLE_SCRATCH.sizeZ = sizeZ * transformScale[2];
  PARTICLE_SAMPLE_SCRATCH.color = initialColor;
  PARTICLE_SAMPLE_SCRATCH.rotation = rotation + rotationOverLifetime;
  PARTICLE_SAMPLE_SCRATCH.age = age;
  PARTICLE_SAMPLE_SCRATCH.lifetime = lifetime;
  return PARTICLE_SAMPLE_SCRATCH;
}

function movementAt(
  prefab: LoadedPrefab,
  judgementAnimation: NativeAnimationClip | undefined,
  realTime: number,
  target: [number, number, number],
): void {
  const path = prefab.manifest.distanceEmitterPathHash;
  const clip = prefab.distanceAnimation ?? judgementAnimation;
  if (!clip || path === undefined || clip.duration <= 0) {
    target[0] = 0;
    target[1] = 0;
    target[2] = 0;
    return;
  }
  // An explicitly separate emitter controller loops. Directional flick uses
  // its current one-shot judgement clip and holds the last keyed transform.
  const animationTime = prefab.distanceAnimation
    ? realTime % clip.duration
    : clamp(realTime, 0, clip.duration);
  nativeAnimationClipPosition(clip, path, animationTime, target);
}

function appendEmission(
  system: LoadedParticleSystem,
  simulationTime: number,
  originX: number,
  originY: number,
  originZ: number,
  index: number,
): void {
  const emission = system.emissionPool.pop() ?? {
    simulationTime: 0,
    originX: 0,
    originY: 0,
    originZ: 0,
    index: 0,
  };
  emission.simulationTime = simulationTime;
  emission.originX = originX;
  emission.originY = originY;
  emission.originZ = originZ;
  emission.index = index;
  emission.shapeBirthWidth = undefined;
  emission.motion = undefined;
  const result = system.emissionBuffer;
  const capacity = system.maxParticles;
  if (capacity <= 0) {
    system.emissionPool.push(emission);
    return;
  }

  // This renderer applies the serialized maxParticles limit by retaining the
  // newest emitted records. The old implementation appended the complete
  // history from time zero and trimmed it after sorting. A looping SlideLoop
  // therefore left every discarded ParticleEmission in emissionPool: at age
  // 300s one native system retained 72k records for maxParticles=1000. Keep
  // that same newest-K selection as a bounded min heap instead. At most K+1
  // records are needed, and the final sort preserves the old visible order.
  if (result.length < capacity) {
    let child = result.length;
    result.push(emission);
    while (child > 0) {
      const parent = (child - 1) >>> 1;
      const parentEmission = result[parent]!;
      if (compareEmission(parentEmission, emission) <= 0) break;
      result[child] = parentEmission;
      child = parent;
    }
    result[child] = emission;
    return;
  }

  const oldest = result[0]!;
  if (compareEmission(emission, oldest) <= 0) {
    system.emissionPool.push(emission);
    return;
  }
  let parent = 0;
  while (true) {
    const left = parent * 2 + 1;
    if (left >= result.length) break;
    const right = left + 1;
    const child = right < result.length && compareEmission(result[right]!, result[left]!) < 0 ? right : left;
    if (compareEmission(result[child]!, emission) >= 0) break;
    result[parent] = result[child]!;
    parent = child;
  }
  result[parent] = emission;
  system.emissionPool.push(oldest);
}

function compareEmission(left: ParticleEmission, right: ParticleEmission): number {
  return left.simulationTime - right.simulationTime || left.index - right.index;
}

function captureEmissionShapeWidths(
  caches: Map<LoadedParticleSystem, ParticleShapeBirthWidths>,
  system: LoadedParticleSystem,
  emissions: ReadonlyArray<ParticleEmission>,
  age: number,
  seed: number,
  width: number,
): void {
  if (system.ref.shapeWidthOffset === undefined) return;
  let state = caches.get(system);
  if (!state) {
    state = { seed, lastAge: age, epoch: 0, widths: new Map() };
    caches.set(system, state);
  } else if (state.seed !== seed || age < state.lastAge) {
    state.seed = seed;
    state.widths.clear();
  }
  state.lastAge = age;
  const epoch = ++state.epoch;
  // ShapeModule.scale affects new births. Local-space particles retain their
  // birth shape while the prefab's current Transform continues to move/scale.
  for (const emission of emissions) {
    let birth = state.widths.get(emission.index);
    if (!birth) {
      birth = { width, lastSeen: epoch };
      state.widths.set(emission.index, birth);
    } else birth.lastSeen = epoch;
    emission.shapeBirthWidth = birth.width;
  }
  for (const [index, birth] of state.widths) if (birth.lastSeen !== epoch) state.widths.delete(index);
}

function emissionEvents(
  system: LoadedParticleSystem,
  prefab: LoadedPrefab,
  age: number,
  seed: number,
  judgementAnimation?: NativeAnimationClip,
  animationTimeOffset = 0,
  simulationClock?: ParticleSimulationClock,
  distanceScaleX = 1,
): ParticleEmission[] {
  while (system.emissionBuffer.length > 0) system.emissionPool.push(system.emissionBuffer.pop()!);
  const result = system.emissionBuffer;
  const delay = evaluateNativeMinMaxCurve(system.raw.startDelay, 0, random(seed + 1));
  const elapsedAfterDelay = age - delay / system.simulationSpeed;
  const realDuration = simulationClock ? Math.max(0, age) : Math.max(0, elapsedAfterDelay);
  const simulationDuration = simulationClock
    ? simulationClock.current
    : Math.max(0, elapsedAfterDelay) * system.simulationSpeed;
  if (simulationDuration <= 0) return result;
  const emission = record(system.raw.EmissionModule);
  if (!emission || emission.enabled !== true) return result;
  let emissionIndex = 0;
  const cycleCount =
    system.looping && system.length > 0 ? Math.floor(simulationDuration / system.length) + 1 : 1;
  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    const cycleStart = cycle * system.length;
    for (const rawBurst of array(emission.m_Bursts)) {
      const burst = record(rawBurst);
      if (!burst) continue;
      const baseTime = cycleStart + finite(burst.time);
      const repeats = Math.max(1, Math.round(finite(burst.cycleCount, 1)));
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const time = baseTime + repeat * finite(burst.repeatInterval);
        if (time > simulationDuration || random(seed + emissionIndex + 53) > finite(burst.probability, 1))
          continue;
        const count = Math.max(
          0,
          Math.round(evaluateNativeMinMaxCurve(burst.countCurve, 0, random(seed + emissionIndex + 59))),
        );
        for (let index = 0; index < count; index += 1) appendEmission(system, time, 0, 0, 0, emissionIndex++);
      }
    }
  }
  let accumulator = 0;
  const maximumSimulationTime = system.looping
    ? simulationDuration
    : Math.min(simulationDuration, system.length);
  for (let start = 0; start < maximumSimulationTime; start += EMISSION_STEP) {
    const step = Math.min(EMISSION_STEP, maximumSimulationTime - start);
    const sampleTime = start + step / 2;
    const cycleTime = system.length > 0 ? sampleTime % system.length : sampleTime;
    const normalized = system.length > 0 ? cycleTime / system.length : 0;
    const rate = Math.max(0, evaluateNativeMinMaxCurve(emission.rateOverTime, normalized, random(seed + 61)));
    accumulator += rate * step;
    while (accumulator >= 1) {
      appendEmission(system, sampleTime, 0, 0, 0, emissionIndex++);
      accumulator -= 1;
    }
  }
  const distanceRate = Math.max(
    0,
    evaluateNativeMinMaxCurve(emission.rateOverDistance, 0, random(seed + 67)),
  );
  const distancePath = system.animationPathHash;
  const hasAnimatedRate =
    distancePath !== undefined &&
    judgementAnimation?.bindingLookup.get(distancePath)?.has(ATTRIBUTE_PARTICLE_DISTANCE_RATE);
  if ((distanceRate > 0 || hasAnimatedRate) && (prefab.distanceAnimation || judgementAnimation)) {
    movementAt(prefab, judgementAnimation, animationTimeOffset, MOVEMENT_PREVIOUS_SCRATCH);
    let distanceAccumulator = 0;
    let hasSimulationTime = !simulationClock;
    for (let realTime = EMISSION_STEP; realTime <= realDuration + Number.EPSILON; realTime += EMISSION_STEP) {
      const currentTime = Math.min(realDuration, realTime);
      movementAt(prefab, judgementAnimation, animationTimeOffset + currentTime, MOVEMENT_CURRENT_SCRATCH);
      const currentSimulationTime =
        simulationClock?.timeAt(currentTime) ?? currentTime * system.simulationSpeed;
      if (currentSimulationTime <= 0) {
        MOVEMENT_PREVIOUS_SCRATCH[0] = MOVEMENT_CURRENT_SCRATCH[0];
        MOVEMENT_PREVIOUS_SCRATCH[1] = MOVEMENT_CURRENT_SCRATCH[1];
        MOVEMENT_PREVIOUS_SCRATCH[2] = MOVEMENT_CURRENT_SCRATCH[2];
        continue;
      }
      if (!hasSimulationTime) {
        hasSimulationTime = true;
        MOVEMENT_PREVIOUS_SCRATCH[0] = MOVEMENT_CURRENT_SCRATCH[0];
        MOVEMENT_PREVIOUS_SCRATCH[1] = MOVEMENT_CURRENT_SCRATCH[1];
        MOVEMENT_PREVIOUS_SCRATCH[2] = MOVEMENT_CURRENT_SCRATCH[2];
        continue;
      }
      const rate = hasAnimatedRate
        ? Math.max(
            0,
            clipBindingValue(
              judgementAnimation,
              distancePath!,
              ATTRIBUTE_PARTICLE_DISTANCE_RATE,
              animationPlaybackTime(prefab.manifest, judgementAnimation, animationTimeOffset + currentTime),
            ) ?? distanceRate,
          )
        : distanceRate;
      // Unity 6000.3.12f1, matching libunity build ID 6b68c0ee...:
      // Update1b derives emitter velocity with real delta time (0x132d274),
      // then EmitOverDistance multiplies rate * |velocity| * scaled delta
      // (0x12ddc5c). Therefore distance emission includes simulationSpeed.
      // Animator motion is local; measure its distance after parent scaling.
      const emittedDistanceCount =
        Math.hypot(
          (MOVEMENT_CURRENT_SCRATCH[0] - MOVEMENT_PREVIOUS_SCRATCH[0]) * distanceScaleX,
          MOVEMENT_CURRENT_SCRATCH[1] - MOVEMENT_PREVIOUS_SCRATCH[1],
          MOVEMENT_CURRENT_SCRATCH[2] - MOVEMENT_PREVIOUS_SCRATCH[2],
        ) *
        rate *
        particleSystemSimulationSpeedAt(
          system,
          prefab.manifest,
          judgementAnimation,
          animationTimeOffset + currentTime,
        );
      const previousRemainder = distanceAccumulator;
      distanceAccumulator += emittedDistanceCount;
      const previousTime = Math.max(0, currentTime - EMISSION_STEP);
      const previousSimulationTime =
        simulationClock?.timeAt(previousTime) ?? previousTime * system.simulationSpeed;
      let crossing = 1 - previousRemainder;
      while (distanceAccumulator >= 1) {
        // StartModules distributes births using emission spacing and the
        // fractional remainder (0x1330cd8..0x1330d88), then subtracts emitter
        // displacement at 0x1330f84. Do not stack a whole frame at one point.
        const fraction = clamp(crossing / Math.max(Number.EPSILON, emittedDistanceCount));
        appendEmission(
          system,
          lerp(previousSimulationTime, currentSimulationTime, fraction),
          lerp(MOVEMENT_PREVIOUS_SCRATCH[0], MOVEMENT_CURRENT_SCRATCH[0], fraction),
          lerp(MOVEMENT_PREVIOUS_SCRATCH[1], MOVEMENT_CURRENT_SCRATCH[1], fraction),
          lerp(MOVEMENT_PREVIOUS_SCRATCH[2], MOVEMENT_CURRENT_SCRATCH[2], fraction),
          emissionIndex++,
        );
        distanceAccumulator -= 1;
        crossing += 1;
      }
      MOVEMENT_PREVIOUS_SCRATCH[0] = MOVEMENT_CURRENT_SCRATCH[0];
      MOVEMENT_PREVIOUS_SCRATCH[1] = MOVEMENT_CURRENT_SCRATCH[1];
      MOVEMENT_PREVIOUS_SCRATCH[2] = MOVEMENT_CURRENT_SCRATCH[2];
    }
  }
  result.sort(compareEmission);
  return result;
}

function createEmissionRing(): EmissionRing {
  return { records: [], head: 0, count: 0 };
}

function createIncrementalEmissionState(): IncrementalEmissionState {
  return {
    initialized: false,
    seed: 0,
    lastAge: Number.NEGATIVE_INFINITY,
    nextRateStart: 0,
    rateRemainder: 0,
    emitted: 0,
    stepRemainder: 0,
    stepEmitted: 0,
    stepEvaluations: 0,
    rebuilds: 0,
    persistent: createEmissionRing(),
    transient: createEmissionRing(),
    output: [],
  };
}

function clearEmissionRing(ring: EmissionRing): void {
  ring.head = 0;
  ring.count = 0;
}

function resetIncrementalEmissionState(state: IncrementalEmissionState, seed: number): void {
  state.rebuilds += 1;
  state.initialized = true;
  state.seed = seed;
  state.lastAge = Number.NEGATIVE_INFINITY;
  state.nextRateStart = 0;
  state.rateRemainder = 0;
  state.emitted = 0;
  state.stepRemainder = 0;
  state.stepEmitted = 0;
  clearEmissionRing(state.persistent);
  clearEmissionRing(state.transient);
  state.output.length = 0;
}

/** Append an already chronological rate-over-time emission to a bounded ring. */
function appendRateEmission(
  ring: EmissionRing,
  capacity: number,
  simulationTime: number,
  index: number,
): void {
  if (capacity <= 0) return;
  let slot: number;
  if (ring.count < capacity) {
    slot = (ring.head + ring.count) % capacity;
    ring.count += 1;
  } else {
    slot = ring.head;
    ring.head = (ring.head + 1) % capacity;
  }
  const emission = (ring.records[slot] ??= {
    simulationTime: 0,
    originX: 0,
    originY: 0,
    originZ: 0,
    index: 0,
  });
  emission.simulationTime = simulationTime;
  emission.originX = 0;
  emission.originY = 0;
  emission.originZ = 0;
  emission.index = index;
  emission.shapeBirthWidth = undefined;
  emission.motion = undefined;
}

function emissionRingAt(ring: EmissionRing, index: number): ParticleEmission {
  return ring.records[(ring.head + index) % ring.records.length]!;
}

function writeIncrementalOutput(state: IncrementalEmissionState, capacity: number): ParticleEmission[] {
  const total = state.persistent.count + state.transient.count;
  let skip = Math.max(0, total - capacity);
  let outputIndex = 0;
  for (let index = 0; index < state.persistent.count; index += 1) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    state.output[outputIndex++] = emissionRingAt(state.persistent, index);
  }
  for (let index = 0; index < state.transient.count; index += 1) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    state.output[outputIndex++] = emissionRingAt(state.transient, index);
  }
  state.output.length = outputIndex;
  return state.output;
}

/**
 * Rate-only systems are the long-lived SlideLoop hot path. Their emissions are
 * chronological, so a per effect-id/system ring can advance only the newly
 * elapsed 1/60-second steps. Bursts and distance emission retain the complete
 * replay fallback below; all shipped SlideLoop systems satisfy this predicate.
 */
function supportsIncrementalRateEmission(system: LoadedParticleSystem, seed: number): boolean {
  const emission = record(system.raw.EmissionModule);
  if (!emission || emission.enabled !== true || array(emission.m_Bursts).length > 0) return false;
  return particleSystemDistanceEmissionRate(system, seed) <= 0;
}

function processRateStep(
  state: IncrementalEmissionState,
  system: LoadedParticleSystem,
  emission: NativeRecord,
  seed: number,
  start: number,
  step: number,
  remainder: number,
  emitted: number,
  target: EmissionRing,
): void {
  const sampleTime = start + step / 2;
  const cycleTime = system.length > 0 ? sampleTime % system.length : sampleTime;
  const normalized = system.length > 0 ? cycleTime / system.length : 0;
  const rate = Math.max(0, evaluateNativeMinMaxCurve(emission.rateOverTime, normalized, random(seed + 61)));
  let nextRemainder = remainder + rate * step;
  let nextEmitted = emitted;
  while (nextRemainder >= 1) {
    appendRateEmission(target, system.maxParticles, sampleTime, nextEmitted++);
    nextRemainder -= 1;
  }
  state.stepRemainder = nextRemainder;
  state.stepEmitted = nextEmitted;
}

function incrementalRateEmissionEvents(
  state: IncrementalEmissionState,
  system: LoadedParticleSystem,
  age: number,
  seed: number,
): ParticleEmission[] {
  if (!state.initialized || state.seed !== seed || age < state.lastAge)
    resetIncrementalEmissionState(state, seed);
  clearEmissionRing(state.transient);
  const emission = record(system.raw.EmissionModule);
  const delay = evaluateNativeMinMaxCurve(system.raw.startDelay, 0, random(seed + 1));
  const elapsedAfterDelay = age - delay / system.simulationSpeed;
  if (!emission || emission.enabled !== true || elapsedAfterDelay < 0) {
    state.lastAge = age;
    state.output.length = 0;
    return state.output;
  }
  const simulationDuration = Math.max(0, elapsedAfterDelay) * system.simulationSpeed;
  const maximumSimulationTime = system.looping
    ? simulationDuration
    : Math.min(simulationDuration, system.length);

  // Commit complete native 60 Hz steps. The final fractional step is rebuilt
  // into a separate ring each frame because the full replay changes its sample
  // midpoint until that step becomes complete.
  while (state.nextRateStart < maximumSimulationTime) {
    const available = maximumSimulationTime - state.nextRateStart;
    if (available < EMISSION_STEP) break;
    processRateStep(
      state,
      system,
      emission,
      seed,
      state.nextRateStart,
      EMISSION_STEP,
      state.rateRemainder,
      state.emitted,
      state.persistent,
    );
    state.rateRemainder = state.stepRemainder;
    state.emitted = state.stepEmitted;
    state.stepEvaluations += 1;
    state.nextRateStart += EMISSION_STEP;
  }
  if (state.nextRateStart < maximumSimulationTime) {
    processRateStep(
      state,
      system,
      emission,
      seed,
      state.nextRateStart,
      maximumSimulationTime - state.nextRateStart,
      state.rateRemainder,
      state.emitted,
      state.transient,
    );
    state.stepEvaluations += 1;
  }
  state.lastAge = age;
  return writeIncrementalOutput(state, system.maxParticles);
}

/** Exact SetWidth input: no minimum two-lane width and no simulator-only multiplier. */
export function nativeEffectWidth(projector: StageProjector, chartWidth: number): number {
  return Math.max(0, projector.effectWidthToWorld(chartWidth));
}

/** LiveGameNoteEffectBase.SetWidth TransformScaleXSetRangeParam branch. */
export function nativeEffectWidthRangeScale(
  projector: StageProjector,
  nativeWidth: number,
  range: readonly [number, number] | undefined,
): number {
  if (!range) return 1;
  // SetWidth loads LiveGameNoteEffectBase._baseLaneWidth and divides the
  // supplied width by it. FullInitialize loads LiveLaneView._laneWidth, passes
  // it through Container.Initialize/BeforeInitialize, and
  // OnInitializeElementView forwards that full 19.12-unit width into
  // Base.Initialize. EarlyFloatLerp(min,max,width/fullLaneWidth,true) then
  // replaces (rather than multiplies) Transform.localScale.x.
  const progress = clamp(nativeWidth / Math.max(Number.EPSILON, projector.stageWidth));
  return lerp(range[0], range[1], progress);
}

/**
 * Apply a raw ParticleSystem Transform X rotation, then reflect Unity Z into
 * Three. `widthScaleX` is an inherited TransformScaleXSetRangeParam value.
 */
export function nativeParticleLocalPosition(
  ref: Effect001ParticleSystemAssetRef,
  sampleX: number,
  sampleY: number,
  sampleZ: number,
  widthScaleX: number,
  target = new Vector3(),
): Vector3 {
  const rotation = ref.localRotationX ?? 0;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const rotatedY = sampleY * cosine - sampleZ * sine;
  const rotatedZ = sampleY * sine + sampleZ * cosine;
  return target.set(
    (ref.localPosition[0] + sampleX) * widthScaleX,
    ref.localPosition[1] + rotatedY,
    -(ref.localPosition[2] + rotatedZ),
  );
}

/**
 * Parent X scale contribution for Unity ParticleSystemScalingMode.
 * Hierarchy(0) scales particle positions and sizes; Local(1) explicitly
 * ignores parent scale. The effect001 width-scaled systems use only 0 or 1.
 */
export function nativeParticleHierarchyScaleX(scalingMode: number, parentScaleX: number): number {
  return scalingMode === 0 ? parentScaleX : 1;
}

/**
 * World-space particles retain the emitter's position at spawn. A scaled
 * parent still scales the animated child Transform position, even when the
 * ParticleSystem's Local scaling mode prevents that parent scale from
 * changing particle size or velocity.
 */
export function nativeParticleEmitterScaledSampleX(
  sampleX: number,
  emissionOriginX: number,
  ownTransformScaleX: number,
  scalingMode: number,
  parentScaleX: number,
): number {
  return scalingMode === 0 ? sampleX : sampleX + emissionOriginX * ownTransformScaleX * (parentScaleX - 1);
}

/** Maps the render DTO to the LiveNoteEffectAssetSettings slot. */
export function effect001PrefabId(effect: RenderParticleEffect): number {
  if (isRenderLaneEffectKind(effect.kind)) return 0;
  if (effect.kind === "excellent") return EFFECT001_PREFAB_IDS.Excellent;
  if (effect.kind === "slide-loop") return EFFECT001_PREFAB_IDS.SlideLoop;
  if (effect.kind === "connect") return EFFECT001_PREFAB_IDS.Connect;
  if (effect.kind === "slide") return EFFECT001_PREFAB_IDS.Slide;
  if (effect.kind === "trace") return EFFECT001_PREFAB_IDS.Connect;
  if (effect.kind === "flick") {
    if (effect.direction === "left") return EFFECT001_PREFAB_IDS.Left;
    if (effect.direction === "right") return EFFECT001_PREFAB_IDS.Right;
    return EFFECT001_PREFAB_IDS.Flick;
  }
  return EFFECT001_PREFAB_IDS.Normal;
}

function effectAnimationJudgement(effect: RenderParticleEffect): Effect001AnimationJudgement {
  if (effect.judgement === "great") return "great";
  if (effect.judgement === "good") return "good";
  if (effect.judgement === "bad") return "bad";
  return "perfect";
}

export class ParticleLayer {
  readonly group = new Group();
  /** Layer-25 lane feedback, rendered by the base camera instead of HDR effect001. */
  readonly laneInputGroup = new Group();

  private readonly projector: StageProjector;
  private readonly assets: OurNotesAssetManifest;
  private readonly maxEffects: number;
  private readonly laneEffectCapacity: number;
  private readonly particlesPerEffect: number;
  private readonly capacity: number;
  private readonly plane = new PlaneGeometry(1, 1);
  private readonly slicedSpriteGeometry = createSlicedSpriteGeometry();
  private readonly wallGeometry = createWallGeometry();
  private readonly fallbackTexture = transparentTexture();
  // Missing decoded Unity media must fail closed: an invented visible strip
  // is more misleading than omitting an effect whose source sprite is absent.
  private readonly laneEffectFallbackTexture = transparentTexture();
  private readonly batches: Readonly<Record<BillboardTextureKey, ParticleQuadBatch>>;
  private readonly batchList: ReadonlyArray<ParticleQuadBatch>;
  private readonly frameBatch: EffectMeshBatch;
  private readonly pillarBatch: EffectMeshBatch;
  private readonly wallBatch: EffectMeshBatch;
  private readonly laneEffectBatch: EffectMeshBatch;
  private readonly impactBatchList: ReadonlyArray<EffectMeshBatch>;
  private readonly prefabManifests = new Map<number, Effect001PrefabAssetRef>();
  private readonly prefabSpriteMaps = new Map<
    number,
    ReadonlyMap<Effect001SpriteName, Effect001SpriteAssetRef>
  >();
  private readonly loadedPrefabs = new Map<number, LoadedPrefab>();
  private readonly impacts = new Map<string, ImpactVisual>();
  private readonly impactPool: ImpactVisual[] = [];
  private readonly emissionStatePools = new Map<LoadedParticleSystem, IncrementalEmissionState[]>();
  private readonly motionStatePools = new Map<LoadedParticleSystem, ParticleMotionSystem[]>();
  private readonly nextImpactIds = new Set<string>();
  private readonly effectIdScratch: string[] = [];
  private readonly noteEffectScratch: RenderParticleEffect[] = [];
  private readonly pointScratch = new Vector3();
  private readonly localPointScratch = new Vector3();
  private readonly textures = new Map<LoadedTextureKey, Texture>();
  private readonly loadedLaneEffectSystems = new Map<LaneEffectAssetKey, LoadedParticleSystem>();
  private disposed = false;
  private traceSink: NativeEffectTraceSink | undefined;
  /** Test-only parity switch; production always keeps the incremental path on. */
  private incrementalEmissions = true;
  private updateEpoch = 0;
  private impactAllocations = 0;

  constructor(
    projector: StageProjector,
    assets: OurNotesAssetManifest,
    maxEffects = 64,
    particlesPerEffect = SOURCE_EFFECT_PARTICLE_BUFFER_PER_EFFECT,
  ) {
    this.projector = projector;
    this.assets = assets;
    this.maxEffects = Math.max(1, Math.round(maxEffects));
    // Native FullInitialize owns one persistent instance for every
    // (LiveLaneEffectViewType, lane), independently from note effect001 pools.
    this.laneEffectCapacity = Math.max(
      this.maxEffects,
      Math.ceil(projector.laneCount) * Object.keys(assets.particles.laneEffects).length,
    );
    // This sizes the per-texture instance buffers. It must not be reused as a
    // cross-system emission quota: effect001's authored hierarchy order is
    // not an importance ordering.
    this.particlesPerEffect = Math.max(1, Math.round(particlesPerEffect));
    this.capacity = this.maxEffects * this.particlesPerEffect;
    this.batches = {
      star: new ParticleQuadBatch("star", this.capacity, this.fallbackTexture, MOBILE_ADD_HDR_TINT_NORMAL),
      longStar: new ParticleQuadBatch(
        "longStar",
        this.capacity,
        this.fallbackTexture,
        MOBILE_ADD_HDR_TINT_LONG_STAR,
      ),
      centerPillar: new ParticleQuadBatch(
        "centerPillar",
        this.capacity,
        this.fallbackTexture,
        MOBILE_ADD_HDR_TINT_CENTER_PILLAR,
      ),
      centerPillar02: new ParticleQuadBatch(
        "centerPillar02",
        this.capacity,
        this.fallbackTexture,
        MOBILE_ADD_HDR_TINT_CENTER_PILLAR,
      ),
      circleIcon: new ParticleQuadBatch(
        "circleIcon",
        this.capacity,
        this.fallbackTexture,
        MOBILE_ADD_HDR_TINT_CIRCLE_ICON,
      ),
    };
    this.batchList = [
      this.batches.star,
      this.batches.longStar,
      this.batches.centerPillar,
      this.batches.centerPillar02,
      this.batches.circleIcon,
    ];
    this.frameBatch = new EffectMeshBatch(
      "frame",
      this.slicedSpriteGeometry,
      this.maxEffects,
      this.fallbackTexture,
      MOBILE_ADD_HDR_TINT_STRONG,
      FRAME_SLICE_BORDER,
    );
    this.pillarBatch = new EffectMeshBatch(
      "pillars",
      this.plane,
      this.maxEffects * 4,
      this.fallbackTexture,
      MOBILE_ADD_HDR_TINT_NORMAL,
    );
    this.wallBatch = new EffectMeshBatch(
      "wall",
      this.wallGeometry,
      this.maxEffects,
      this.fallbackTexture,
      MOBILE_ADD_HDR_TINT_WALL,
      undefined,
      [0, WALL_MESH_SHADER_PIVOT_Y, 0.5],
    );
    // LiveLaneEffectViewType selects one of six lane ParticleSystems. Their XY
    // mesh roots are rotated +90 degrees onto the lane plane and use the
    // compiled UI/Additive premultiplied fragment program with One/One blend.
    this.laneEffectBatch = new EffectMeshBatch(
      "lane-effects",
      this.plane,
      this.laneEffectCapacity,
      this.laneEffectFallbackTexture,
      [1, 1, 1, 1],
      undefined,
      [0, 0, 0],
      OneFactor,
      OneFactor,
      "uiAdditive",
    );
    this.laneEffectBatch.mesh.renderOrder = 4141;
    this.impactBatchList = [this.frameBatch, this.pillarBatch, this.wallBatch];
    for (const prefab of Object.values(assets.particles.effect001Prefabs)) {
      this.prefabManifests.set(prefab.id, prefab);
      this.prefabSpriteMaps.set(prefab.id, new Map(prefab.sprites.map((sprite) => [sprite.name, sprite])));
    }
    this.group.name = "OurNotesEffect001";
    this.laneInputGroup.name = "OurNotesLaneEffects";
    for (const batch of this.batchList) this.group.add(batch.mesh);
    for (const batch of this.impactBatchList) this.group.add(batch.mesh);
    this.laneInputGroup.add(this.laneEffectBatch.mesh);
  }

  setPixelRatio(_pixelRatio: number): void {
    // effect001 billboards use authored world sizes; point-size/pixel-ratio
    // scaling was a simulator invention and is intentionally absent.
  }

  /**
   * Route every emitted instance to `sink` as well as the GPU batches. With a
   * sink, frame/pillar/wall instances are traced even without decoded textures.
   */
  setTraceSink(sink: NativeEffectTraceSink | undefined): void {
    this.traceSink = sink;
  }

  /** Load ParticleSystem/AnimationClip definitions only (no textures); Node-safe. */
  async loadDefinitions(readJson: NativeJsonReader): Promise<void> {
    const loadErrors: Error[] = [];
    const { laneEffectSystemResults, prefabResults } = await this.readDefinitions(readJson, loadErrors);
    if (this.disposed) return;
    this.applyDefinitions(laneEffectSystemResults, prefabResults, loadErrors);
    if (loadErrors.length > 0)
      throw new AggregateError(loadErrors, "One or more native particle resources failed to load");
  }

  async loadTextures(loader = new TextureLoader()): Promise<void> {
    const loadErrors: Error[] = [];
    const errorOf = (reason: unknown, context?: string): Error => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      return context ? new Error(`${context}: ${error.message}`, { cause: error }) : error;
    };
    const textureRequests: ReadonlyArray<readonly [LoadedTextureKey, string]> = [
      ["star", this.assets.particles.starTextureUrl],
      ["longStar", this.assets.particles.longStarTextureUrl],
      ["line", this.assets.particles.tapLineTextureUrl],
      ["pillar", this.assets.particles.tapPillarTextureUrl],
      ["wall", this.assets.particles.wallTextureUrl],
      ["centerPillar", this.assets.particles.centerPillarTextureUrl],
      ["centerPillar02", this.assets.particles.centerPillar02TextureUrl],
      ["circleIcon", this.assets.particles.circleIconTextureUrl],
      ["laneEffect", this.assets.particles.laneEffects.inVain.textureUrl],
    ];
    const definitions = this.readDefinitions(async (url) => {
      const response = await fetch(url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.json();
    }, loadErrors);
    const textureResults = await Promise.allSettled(
      textureRequests.map(async ([key, url]) => [key, configure(await loader.loadAsync(url))] as const),
    );
    const { laneEffectSystemResults, prefabResults } = await definitions;
    if (this.disposed) {
      for (const result of textureResults) if (result.status === "fulfilled") result.value[1].dispose();
      return;
    }
    for (let index = 0; index < textureResults.length; index += 1) {
      const result = textureResults[index]!;
      if (result.status !== "fulfilled") {
        loadErrors.push(errorOf(result.reason, textureRequests[index]?.[1]));
        continue;
      }
      const [key, texture] = result.value;
      this.textures.get(key)?.dispose();
      this.textures.set(key, texture);
      if (
        key === "star" ||
        key === "longStar" ||
        key === "centerPillar" ||
        key === "centerPillar02" ||
        key === "circleIcon"
      )
        this.batches[key].setTexture(texture);
      if (key === "line") this.frameBatch.setTexture(texture);
      if (key === "pillar") this.pillarBatch.setTexture(texture);
      if (key === "wall") this.wallBatch.setTexture(texture);
      if (key === "laneEffect") this.laneEffectBatch.setTexture(texture);
    }
    this.applyDefinitions(laneEffectSystemResults, prefabResults, loadErrors);
    if (loadErrors.length > 0)
      throw new AggregateError(loadErrors, "One or more native particle resources failed to load");
  }

  private async readDefinitions(
    readJson: NativeJsonReader,
    loadErrors: Error[],
  ): Promise<{
    laneEffectSystemResults: PromiseSettledResult<readonly [LaneEffectAssetKey, LoadedParticleSystem]>[];
    prefabResults: LoadedPrefab[];
  }> {
    const errorOf = (reason: unknown): Error =>
      reason instanceof Error ? reason : new Error(String(reason));
    const laneEffectEntries = Object.entries(this.assets.particles.laneEffects) as Array<
      [LaneEffectAssetKey, LaneEffectParticleAssetRef]
    >;
    const laneEffectSystemResultsPromise = Promise.allSettled(
      laneEffectEntries.map(
        async ([key, ref]): Promise<readonly [LaneEffectAssetKey, LoadedParticleSystem]> => {
          const parsed = readNativeParticleSystem(await readJson(ref.particleSystemMetadataUrl));
          if (!parsed) throw new Error(`${ref.particleSystemMetadataUrl}: invalid ParticleSystem projection`);
          return [
            key,
            loadedParticleSystem(parsed, {
              name: `lane-effect/${key}`,
              metadataUrl: ref.particleSystemMetadataUrl,
              texture: "star",
              localPosition: [0, 0, 0],
              // Lane effects render through EffectMeshBatch, not the
              // effect001 billboard shader that consumes this field.
              rendererMaxParticleSize: 0,
            }),
          ] as const;
        },
      ),
    );
    const animationRequests = new Map<string, Promise<NativeAnimationClip | undefined>>();
    const loadAnimation = (url: string): Promise<NativeAnimationClip | undefined> => {
      let request = animationRequests.get(url);
      if (!request) {
        request = readJson(url)
          .then((json) => {
            const animation = readNativeAnimationClip(json);
            if (!animation) throw new Error(`${url}: invalid AnimationClip projection`);
            return animation;
          })
          .catch((reason) => {
            loadErrors.push(errorOf(reason));
            return undefined;
          });
        animationRequests.set(url, request);
      }
      return request;
    };
    const prefabResults = await Promise.all(
      Object.values(this.assets.particles.effect001Prefabs).map(async (manifest): Promise<LoadedPrefab> => {
        const animationEntries = Object.entries(manifest.animationClipUrls ?? {}) as Array<
          [Effect001AnimationJudgement, string]
        >;
        const [systemResults, animationResult, animationResults, distanceResult] = await Promise.all([
          Promise.allSettled(
            manifest.particleSystems.map(async (ref): Promise<LoadedParticleSystem | undefined> => {
              const parsed = readNativeParticleSystem(await readJson(ref.metadataUrl), ref.originalIdentity);
              if (!parsed) throw new Error(`${ref.metadataUrl}: invalid ParticleSystem projection`);
              return loadedParticleSystem(parsed, ref);
            }),
          ),
          loadAnimation(manifest.animationClipUrl),
          Promise.all(
            animationEntries.map(async ([judgement, url]) => {
              const animation = await loadAnimation(url);
              return [judgement, animation] as const;
            }),
          ),
          manifest.distanceEmitterAnimationClipUrl
            ? loadAnimation(manifest.distanceEmitterAnimationClipUrl)
            : Promise.resolve(undefined),
        ]);
        const systems = systemResults.flatMap((result) => {
          if (result.status === "fulfilled" && result.value) return [result.value];
          if (result.status === "rejected") loadErrors.push(errorOf(result.reason));
          return [];
        });
        const animations = new Map<Effect001AnimationJudgement, NativeAnimationClip>();
        for (const [judgement, animation] of animationResults)
          if (animation) animations.set(judgement, animation);
        return {
          manifest,
          systems,
          animation: animationResult,
          animations,
          distanceAnimation: distanceResult,
          wallSystem: systems.find((system) => system.ref.renderer === "wallMesh"),
        };
      }),
    );
    const laneEffectSystemResults = await laneEffectSystemResultsPromise;
    return { laneEffectSystemResults, prefabResults };
  }

  private applyDefinitions(
    laneEffectSystemResults: PromiseSettledResult<readonly [LaneEffectAssetKey, LoadedParticleSystem]>[],
    prefabResults: LoadedPrefab[],
    loadErrors: Error[],
  ): void {
    this.loadedLaneEffectSystems.clear();
    for (const result of laneEffectSystemResults) {
      if (result.status === "fulfilled") this.loadedLaneEffectSystems.set(...result.value);
      else loadErrors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    }
    this.loadedPrefabs.clear();
    for (const prefab of prefabResults) this.loadedPrefabs.set(prefab.manifest.id, prefab);
  }

  update(effects: ReadonlyArray<RenderParticleEffect> | undefined): void {
    for (const batch of this.batchList) batch.reset();
    for (const batch of this.impactBatchList) batch.reset();
    const epoch = ++this.updateEpoch;
    this.noteEffectScratch.length = 0;
    for (const effect of effects ?? EMPTY_EFFECTS) {
      if (this.noteEffectScratch.length >= this.maxEffects) break;
      if (!isRenderLaneEffectKind(effect.kind)) this.noteEffectScratch.push(effect);
    }
    const effectList = this.noteEffectScratch;
    const effectCount = effectList.length;
    this.nextImpactIds.clear();
    this.effectIdScratch.length = effectCount;
    for (let effectIndex = 0; effectIndex < effectCount; effectIndex += 1) {
      const effect = effectList[effectIndex]!;
      const id = String(effect.id);
      this.effectIdScratch[effectIndex] = id;
      if (
        effect.age >= 0 &&
        (effect.lifetime === undefined || effect.age <= effect.lifetime) &&
        this.prefabManifests.has(effect001PrefabId(effect))
      )
        this.nextImpactIds.add(id);
    }
    // Release stale rigs before acquiring this frame's rigs. A completely
    // changing ID set therefore remains within maxEffects instead of briefly
    // allocating a second generation before end-of-frame cleanup.
    for (const [id, impact] of this.impacts) if (!this.nextImpactIds.has(id)) this.removeImpact(id, impact);
    for (let effectIndex = 0; effectIndex < effectCount; effectIndex += 1) {
      const effect = effectList[effectIndex]!;
      if (effect.age < 0 || (effect.lifetime !== undefined && effect.age > effect.lifetime)) continue;
      const prefabId = effect001PrefabId(effect);
      const manifest = this.prefabManifests.get(prefabId);
      if (!manifest) continue;
      const width = nativeEffectWidth(this.projector, effect.width ?? 1);
      // Native one-shot effects never use the screen_root approach curve.
      // PlayNoteEffect places their root directly on noteJudgementRoot3D.
      this.projector.effectPoint(effect.lane, effect.width ?? 1, this.pointScratch);
      const id = this.effectIdScratch[effectIndex]!;
      const loaded = this.loadedPrefabs.get(prefabId);
      const judgement = effectAnimationJudgement(effect);
      const movementAnimation = loaded?.animations.get(judgement) ?? loaded?.animation;
      const effectSeed = effect.seed ?? hash(id);
      const impact = this.updateImpact(
        id,
        manifest,
        loaded,
        effect.age,
        judgement,
        width,
        this.pointScratch,
        epoch,
        effectSeed,
      );
      if (!loaded) continue;
      // The per-texture instance batch is the only capacity guard. It is
      // intentionally independent from prefab system order so an earlier
      // high-rate star stream cannot erase authored late glow systems.
      for (let systemIndex = 0; systemIndex < loaded.systems.length; systemIndex += 1) {
        const system = loaded.systems[systemIndex]!;
        if (system.ref.renderer === "wallMesh") continue;
        const playback = particleSystemPlayback(system, manifest, movementAnimation, effect.age);
        if (!playback) continue;
        const systemSeed = effectSeed ^ system.nameHash;
        const simulationClock = particleSimulationClockFor(
          system,
          manifest,
          movementAnimation,
          playback.animationTimeOffset,
          systemSeed,
          playback.age,
        );
        const systemTime =
          simulationClock?.current ?? constantParticleSimulationTime(system, playback.age, systemSeed);
        const parentWidthScaleX = nativeEffectWidthRangeScale(
          this.projector,
          width,
          system.ref.widthScaleRange,
        );
        const emissions = this.emissionEventsFor(
          impact,
          system,
          loaded,
          playback.age,
          systemSeed,
          movementAnimation,
          playback.animationTimeOffset,
          simulationClock,
          parentWidthScaleX,
        );
        captureEmissionShapeWidths(
          impact.shapeBirthWidths,
          system,
          emissions,
          playback.age,
          systemSeed,
          width,
        );
        this.advanceImpactMotions(
          impact,
          system,
          emissions,
          playback.age,
          systemSeed,
          width,
          systemTime,
          playback.animationTimeOffset,
        );
        for (const emission of emissions) {
          const sample = sampleParticle(
            system,
            emission,
            systemTime,
            width,
            systemSeed,
            undefined,
            movementAnimation,
            playback.animationTimeOffset,
          );
          if (!sample || system.ref.texture === "wall") continue;
          const mirror = manifest.rootScaleX;
          const hierarchyScaleX = nativeParticleHierarchyScaleX(system.scalingMode, parentWidthScaleX);
          const ownTransformScaleX = system.ref.localScale?.[0] ?? 1;
          const sampleX = nativeParticleEmitterScaledSampleX(
            sample.x,
            emission.originX,
            ownTransformScaleX,
            system.scalingMode,
            parentWidthScaleX,
          );
          nativeParticleLocalPosition(
            system.ref,
            sampleX,
            sample.y,
            sample.z,
            hierarchyScaleX,
            this.localPointScratch,
          );
          const worldX = this.pointScratch.x + this.localPointScratch.x * mirror;
          const worldY = this.pointScratch.y + this.localPointScratch.y;
          const worldZ = this.pointScratch.z + this.localPointScratch.z;
          const sizeX = sample.sizeX * hierarchyScaleX * mirror;
          const rotation = sample.rotation * mirror;
          const pivotX = system.ref.rendererPivot?.[0] ?? 0;
          const pivotY = system.ref.rendererPivot?.[1] ?? 0;
          this.batches[system.ref.texture].push(
            worldX,
            worldY,
            worldZ,
            sizeX,
            sample.sizeY,
            sample.color,
            rotation,
            system.ref.rendererMaxParticleSize,
            pivotX,
            pivotY,
            system.ref.materialTint,
            system.ref.rendererRenderMode,
          );
          this.traceSink?.billboard({
            texture: system.ref.texture,
            system: systemIndex,
            emission: emission.index,
            particleSeed: systemSeed ^ Math.imul(emission.index + 1, 0x9e3779b9),
            simulationSpeed: system.simulationSpeed,
            clock: {
              realTimeOffset: effect.age - playback.age,
              currentSimulationTime: systemTime,
              emissionSimulationTime: emission.motion?.birthTime ?? emission.simulationTime,
              simulationTimeAt:
                simulationClock?.timeAt ?? ((age) => constantParticleSimulationTime(system, age, systemSeed)),
            },
            materialTint: system.ref.materialTint,
            age: sample.age,
            lifetime: sample.lifetime,
            x: worldX,
            y: worldY,
            z: worldZ,
            sizeX,
            sizeY: sample.sizeY,
            color: { ...sample.color },
            rotation,
            maxParticleSize: system.ref.rendererMaxParticleSize,
            renderMode: system.ref.rendererRenderMode,
            pivotX,
            pivotY,
          });
        }
      }
    }
    for (const batch of this.batchList) batch.finish();
    for (const batch of this.impactBatchList) batch.finish();
    for (const [id, impact] of this.impacts) if (impact.lastSeen !== epoch) this.removeImpact(id, impact);
  }

  updateLaneInput(effects: ReadonlyArray<RenderParticleEffect> | undefined): void {
    this.laneEffectBatch.reset();
    let rendered = 0;
    for (const effect of effects ?? EMPTY_EFFECTS) {
      if (rendered >= this.laneEffectCapacity) break;
      if (!isRenderLaneEffectKind(effect.kind)) continue;
      if (effect.age < 0 || (effect.lifetime !== undefined && effect.age > effect.lifetime)) continue;
      this.renderLaneEffect(effect, laneEffectAssetKey(effect.kind));
      rendered += 1;
    }
    this.laneEffectBatch.finish();
  }

  private renderLaneEffect(effect: RenderParticleEffect, assetKey: LaneEffectAssetKey): void {
    const width = nativeEffectWidth(this.projector, effect.width ?? 2);
    this.projector.effectPoint(effect.lane, effect.width ?? 2, this.pointScratch);
    const system = this.loadedLaneEffectSystems.get(assetKey);
    // A texture plus guessed size/color curves is not the authored effect.
    // Both the ParticleSystem projection and its original texture are needed.
    if (!system) return;
    const seed = effect.seed ?? hash(String(effect.id));
    const sample = sampleParticle(
      system,
      LANE_EFFECT_EMISSION,
      effect.age * system.simulationSpeed,
      width,
      seed,
      width,
    );
    if (!sample) return;
    const color = sample.color;
    const alpha = color.a;
    if (alpha <= 0) return;
    this.traceSink?.mesh({
      kind: "lane",
      name: assetKey,
      x: this.pointScratch.x + sample.x,
      y: this.pointScratch.y + sample.z,
      z: this.pointScratch.z - sample.y,
      scaleX: sample.sizeX,
      scaleY: sample.sizeY,
      scaleZ: sample.sizeZ,
      color: { ...color },
      rotationX: LANE_EFFECT_UNITY_TO_THREE_ROTATION_X,
    });
    this.laneEffectBatch.push(
      this.pointScratch.x + sample.x,
      // LiveGameLaneEffectBase.SetPosition copies the lane root position
      // exactly. The source lane prefabs have no local Y offset, so a
      // renderer-only nudge here shifts the fill away from its native plane.
      this.pointScratch.y + sample.z,
      this.pointScratch.z - sample.y,
      // LiveGameLaneEffectBase.SetWidth replaces the active ParticleSystem's
      // startSizeX with one initialized lane width (19.12 / 24); it does not
      // multiply the authored 1.0/1.8 value.
      sample.sizeX,
      sample.sizeY,
      sample.sizeZ,
      color.r,
      color.g,
      color.b,
      alpha,
      LANE_EFFECT_UNITY_TO_THREE_ROTATION_X,
    );
  }

  private updateImpact(
    id: string,
    manifest: Effect001PrefabAssetRef,
    loaded: LoadedPrefab | undefined,
    age: number,
    judgement: Effect001AnimationJudgement,
    width: number,
    position: Vector3,
    epoch: number,
    seed: number,
  ): ImpactVisual {
    let impact = this.impacts.get(id);
    if (!impact) {
      impact = this.createImpact(id);
      this.impacts.set(id, impact);
      this.group.add(impact.root);
    }
    if (impact.prefabId !== manifest.id) {
      this.releaseImpactEmissionStates(impact);
      impact.prefabId = manifest.id;
    }
    impact.lastSeen = epoch;
    impact.root.position.copy(position);
    impact.root.scale.set(manifest.rootScaleX, 1, 1);
    const animation = loaded?.animations.get(judgement) ?? loaded?.animation;
    const animationTime =
      animation && manifest.loopAnimation && animation.duration > 0 ? age % animation.duration : age;
    for (let index = 0; index < SPRITE_NAMES.length; index += 1) {
      const name = SPRITE_NAMES[index]!;
      const spec = this.prefabSpriteMaps.get(manifest.id)?.get(name);
      if (!spec) continue;
      const path = PATH_HASH[name];
      const activeValue = clipBindingValue(animation, path, ATTRIBUTE_ACTIVE, animationTime);
      const alphaValue = clipBindingValue(animation, path, ATTRIBUTE_COLOR_ALPHA, animationTime);
      const sizeValue = clipBindingValue(animation, path, ATTRIBUTE_SIZE_X, animationTime);
      const active = activeValue === undefined ? spec.baseActive : activeValue >= 0.5;
      const alpha = alphaValue === undefined ? spec.baseColor[3] : clamp(alphaValue);
      if (
        !active ||
        alpha <= 0 ||
        (!this.traceSink && !this.textures.has(name === "frame" ? "line" : "pillar"))
      )
        continue;
      const x =
        name === "pillar01" || name === "pillar03"
          ? -width / 2
          : name === "pillar02" || name === "pillar04"
            ? width / 2
            : spec.localPosition[0];
      const sizeX = name === "frame" ? Math.max(0, width + 0.4) : Math.max(0, sizeValue ?? spec.baseSize[0]);
      const batch = name === "frame" ? this.frameBatch : this.pillarBatch;
      const flipX = spec.flipX ? -1 : 1;
      const rotationX = -spec.localRotationX;
      const pivotOffsetX = (0.5 - spec.pivot[0]) * sizeX * spec.localScale[0] * flipX;
      const pivotOffsetY = (0.5 - spec.pivot[1]) * spec.baseSize[1] * spec.localScale[1];
      const rotatedPivotY = pivotOffsetY * Math.cos(rotationX);
      const rotatedPivotZ = pivotOffsetY * Math.sin(rotationX);
      const spriteX = position.x + (x + pivotOffsetX) * manifest.rootScaleX;
      const spriteY = position.y + spec.localPosition[1] + rotatedPivotY;
      const spriteZ = position.z - spec.localPosition[2] + rotatedPivotZ;
      const scaleX = sizeX * spec.localScale[0] * manifest.rootScaleX * flipX;
      const scaleY = spec.baseSize[1] * spec.localScale[1];
      const red =
        clipBindingValue(animation, path, SPRITE_COLOR_ATTRIBUTES[0]!, animationTime) ?? spec.baseColor[0];
      const green =
        clipBindingValue(animation, path, SPRITE_COLOR_ATTRIBUTES[1]!, animationTime) ?? spec.baseColor[1];
      const blue =
        clipBindingValue(animation, path, SPRITE_COLOR_ATTRIBUTES[2]!, animationTime) ?? spec.baseColor[2];
      batch.push(
        spriteX,
        spriteY,
        spriteZ,
        scaleX,
        scaleY,
        spec.localScale[2],
        red,
        green,
        blue,
        alpha,
        rotationX,
        spec.materialTint,
      );
      this.traceSink?.mesh({
        kind: name === "frame" ? "frame" : "pillar",
        name,
        x: spriteX,
        y: spriteY,
        z: spriteZ,
        scaleX,
        scaleY,
        scaleZ: spec.localScale[2],
        color: { r: red, g: green, b: blue, a: alpha },
        rotationX,
        materialTint: spec.materialTint,
      });
    }
    const wallSystem = loaded?.wallSystem;
    const wallTexture = this.textures.get("wall");
    if (!loaded || !wallSystem || (!wallTexture && !this.traceSink)) return impact;
    const playback = particleSystemPlayback(wallSystem, manifest, animation, age);
    if (!playback) return impact;
    const wallSeed = seed ^ wallSystem.nameHash;
    const simulationClock = particleSimulationClockFor(
      wallSystem,
      manifest,
      animation,
      playback.animationTimeOffset,
      wallSeed,
      playback.age,
    );
    const emissions = this.emissionEventsFor(
      impact,
      wallSystem,
      loaded,
      playback.age,
      wallSeed,
      animation,
      playback.animationTimeOffset,
      simulationClock,
    );
    const wallTime =
      simulationClock?.current ?? constantParticleSimulationTime(wallSystem, playback.age, wallSeed);
    this.advanceImpactMotions(
      impact,
      wallSystem,
      emissions,
      playback.age,
      wallSeed,
      width,
      wallTime,
      playback.animationTimeOffset,
    );
    for (const emission of emissions) {
      const sample = sampleParticle(
        wallSystem,
        emission,
        wallTime,
        width,
        wallSeed,
        undefined,
        animation,
        playback.animationTimeOffset,
      );
      if (!sample) continue;
      if (sample.color.a <= 0) continue;
      nativeParticleLocalPosition(wallSystem.ref, sample.x, sample.y, sample.z, 1, this.localPointScratch);
      const wallX = position.x + this.localPointScratch.x * manifest.rootScaleX;
      const wallY = position.y + this.localPointScratch.y;
      const wallZ = position.z + this.localPointScratch.z;
      const wallScaleX = Math.max(0, width - 0.15) * sample.sizeX * manifest.rootScaleX;
      this.wallBatch.push(
        wallX,
        wallY,
        wallZ,
        wallScaleX,
        sample.sizeY,
        sample.sizeZ,
        sample.color.r,
        sample.color.g,
        sample.color.b,
        sample.color.a,
        0,
        wallSystem.ref.materialTint,
      );
      this.traceSink?.mesh({
        kind: "wall",
        name: "wall",
        x: wallX,
        y: wallY,
        z: wallZ,
        scaleX: wallScaleX,
        scaleY: sample.sizeY,
        scaleZ: sample.sizeZ,
        color: { ...sample.color },
        rotationX: 0,
        materialTint: wallSystem.ref.materialTint,
      });
      break;
    }
    return impact;
  }

  private advanceImpactMotions(
    impact: ImpactVisual,
    system: LoadedParticleSystem,
    emissions: ReadonlyArray<ParticleEmission>,
    age: number,
    seed: number,
    width: number,
    simulationTime: number,
    animationTimeOffset: number,
  ): void {
    if (record(system.raw.ClampVelocityModule)?.enabled !== true) return;
    let state = impact.motionStates.get(system);
    if (!state) {
      state = this.motionStatePools.get(system)?.pop() ?? {
        initialized: false,
        seed,
        lastAge: 0,
        animationTimeOffset: 0,
        epoch: 0,
        clock: new NativeParticleMotionClock(
          system.motionSource.maximumLifetime,
          OUR_NOTES_MAXIMUM_PARTICLE_TIMESTEP,
        ),
        particles: new Map(),
        pool: [],
      };
      impact.motionStates.set(system, state);
    }
    if (
      !state.initialized ||
      state.seed !== seed ||
      age < state.lastAge ||
      state.animationTimeOffset !== animationTimeOffset
    ) {
      state.clock.reset();
      for (const particle of state.particles.values()) state.pool.push(particle);
      state.particles.clear();
      state.seed = seed;
      state.animationTimeOffset = animationTimeOffset;
      state.initialized = true;
    }
    state.lastAge = age;
    state.clock.beginFrame(simulationTime);
    const epoch = ++state.epoch;
    for (const [index, motion] of state.particles)
      if (simulationTime - motion.birthTime >= motion.lifetime) {
        state.particles.delete(index);
        state.pool.push(motion);
      }
    const initial = record(system.raw.InitialModule)!;
    for (const emission of emissions) {
      emission.motion = undefined;
      let motion = state.particles.get(emission.index);
      if (!motion) {
        const particleSeed = seed ^ Math.imul(emission.index + 1, 0x9e3779b9);
        const lifetime = Math.max(
          0,
          evaluateNativeMinMaxCurve(initial.startLifetime, 0, random(particleSeed + 11)),
        );
        const age = simulationTime - emission.simulationTime;
        if (lifetime <= 0 || age < 0 || age >= lifetime) continue;
        shapePosition(
          system,
          particleSeed,
          emission.shapeBirthWidth ?? width,
          SHAPE_POSITION_SCRATCH,
          SHAPE_INITIAL_VELOCITY_SCRATCH,
        );
        const shape = record(system.raw.ShapeModule);
        const speed =
          shape?.enabled === true && shape.type === 10
            ? evaluateNativeMinMaxCurve(initial.startSpeed, 0, random(particleSeed + 43))
            : 0;
        motion = state.pool.pop() ?? {
          birthTime: 0,
          simulationTime: 0,
          age: 0,
          lifetime: 0,
          curveRandom: 0,
          x: 0,
          y: 0,
          z: 0,
          velocityX: 0,
          velocityY: 0,
          velocityZ: 0,
          lastSeen: 0,
        };
        motion.birthTime = emission.simulationTime;
        motion.simulationTime = emission.simulationTime;
        motion.age = 0;
        motion.lifetime = lifetime;
        motion.curveRandom = random(particleSeed + 23);
        motion.x = SHAPE_POSITION_SCRATCH[0];
        motion.y = SHAPE_POSITION_SCRATCH[1];
        motion.z = SHAPE_POSITION_SCRATCH[2];
        motion.velocityX = SHAPE_INITIAL_VELOCITY_SCRATCH[0] * speed;
        motion.velocityY = SHAPE_INITIAL_VELOCITY_SCRATCH[1] * speed;
        motion.velocityZ = SHAPE_INITIAL_VELOCITY_SCRATCH[2] * speed;
        state.particles.set(emission.index, motion);
      }
      if (simulationTime - motion.birthTime >= motion.lifetime) continue;
      motion.lastSeen = epoch;
      state.clock.advance(system.motionSource, motion);
      emission.motion = motion;
    }
    for (const [index, motion] of state.particles)
      if (motion.lastSeen !== epoch) {
        state.particles.delete(index);
        state.pool.push(motion);
      }
    state.clock.endFrame();
  }

  private emissionEventsFor(
    impact: ImpactVisual,
    system: LoadedParticleSystem,
    prefab: LoadedPrefab,
    age: number,
    seed: number,
    judgementAnimation?: NativeAnimationClip,
    animationTimeOffset = 0,
    simulationClock?: ParticleSimulationClock,
    distanceScaleX = 1,
  ): ParticleEmission[] {
    if (
      !this.incrementalEmissions ||
      (system.ref.animationPath && (!prefab.manifest.loopAnimation || animationTimeOffset !== 0)) ||
      simulationClock ||
      !supportsIncrementalRateEmission(system, seed)
    ) {
      return emissionEvents(
        system,
        prefab,
        age,
        seed,
        judgementAnimation,
        animationTimeOffset,
        simulationClock,
        distanceScaleX,
      );
    }
    let state = impact.emissionStates.get(system);
    if (!state) {
      const pool = this.emissionStatePools.get(system);
      state = pool?.pop() ?? createIncrementalEmissionState();
      impact.emissionStates.set(system, state);
    }
    return incrementalRateEmissionEvents(state, system, age, seed);
  }

  private releaseImpactEmissionStates(impact: ImpactVisual): void {
    impact.shapeBirthWidths.clear();
    for (const [system, state] of impact.motionStates) {
      state.initialized = false;
      state.clock.reset();
      for (const particle of state.particles.values()) state.pool.push(particle);
      state.particles.clear();
      let pool = this.motionStatePools.get(system);
      if (!pool) {
        pool = [];
        this.motionStatePools.set(system, pool);
      }
      if (pool.length < this.maxEffects) pool.push(state);
    }
    impact.motionStates.clear();
    for (const [system, state] of impact.emissionStates) {
      state.initialized = false;
      clearEmissionRing(state.persistent);
      clearEmissionRing(state.transient);
      state.output.length = 0;
      let pool = this.emissionStatePools.get(system);
      if (!pool) {
        pool = [];
        this.emissionStatePools.set(system, pool);
      }
      if (pool.length < this.maxEffects) pool.push(state);
    }
    impact.emissionStates.clear();
  }

  private createImpact(id: string): ImpactVisual {
    const pooled = this.impactPool.pop();
    if (pooled) {
      pooled.root.name = `Effect001:${id}`;
      pooled.prefabId = -1;
      return pooled;
    }
    const root = new Group();
    root.name = `Effect001:${id}`;
    this.impactAllocations += 1;
    return {
      root,
      lastSeen: 0,
      prefabId: -1,
      emissionStates: new Map(),
      shapeBirthWidths: new Map(),
      motionStates: new Map(),
    };
  }

  private removeImpact(id: string, impact: ImpactVisual): void {
    this.group.remove(impact.root);
    this.impacts.delete(id);
    this.releaseImpactEmissionStates(impact);
    impact.prefabId = -1;
    if (this.impactPool.length < this.maxEffects) this.impactPool.push(impact);
    else this.destroyImpact(impact);
  }

  private destroyImpact(impact: ImpactVisual): void {
    this.releaseImpactEmissionStates(impact);
  }

  get stats(): {
    activeImpacts: number;
    pooledImpacts: number;
    allocatedImpacts: number;
    impactPoolCapacity: number;
    impactInstanceCapacity: number;
    pointCapacity: number;
    totalParticleCapacity: number;
    renderedParticles: number;
    renderedImpactInstances: number;
    particleDrawCalls: number;
    impactDrawCalls: number;
  } {
    let renderedParticles = 0;
    let particleDrawCalls = 0;
    for (const batch of this.batchList) {
      renderedParticles += batch.count;
      if (batch.count > 0) particleDrawCalls += 1;
    }
    let renderedImpactInstances = 0;
    let impactDrawCalls = 0;
    for (const batch of this.impactBatchList) {
      renderedImpactInstances += batch.count;
      if (batch.count > 0) impactDrawCalls += 1;
    }
    renderedImpactInstances += this.laneEffectBatch.count;
    if (this.laneEffectBatch.count > 0) impactDrawCalls += 1;
    return {
      activeImpacts: this.impacts.size,
      pooledImpacts: this.impactPool.length,
      allocatedImpacts: this.impactAllocations,
      impactPoolCapacity: this.maxEffects,
      impactInstanceCapacity: this.maxEffects * 6 + this.laneEffectCapacity,
      pointCapacity: this.capacity,
      totalParticleCapacity: this.capacity * this.batchList.length,
      renderedParticles,
      renderedImpactInstances,
      particleDrawCalls,
      impactDrawCalls,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const impact of this.impacts.values()) this.destroyImpact(impact);
    for (const impact of this.impactPool) this.destroyImpact(impact);
    this.impacts.clear();
    this.impactPool.length = 0;
    this.emissionStatePools.clear();
    this.motionStatePools.clear();
    for (const batch of this.batchList) batch.dispose();
    for (const batch of this.impactBatchList) batch.dispose();
    this.laneEffectBatch.dispose();
    this.plane.dispose();
    this.slicedSpriteGeometry.dispose();
    this.wallGeometry.dispose();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.loadedPrefabs.clear();
    this.fallbackTexture.dispose();
    this.laneEffectFallbackTexture.dispose();
    this.group.clear();
    this.laneInputGroup.clear();
  }
}
