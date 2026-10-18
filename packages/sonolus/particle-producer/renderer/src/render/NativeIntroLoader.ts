import { readNativeAnimationClip } from "./ParticleLayer";
import { NativeIntroTimeline, type NativeIntroTimelineClip, type NativeIntroSignal } from "./NativeIntroTimeline";

export interface NativeIntroObjectRecord {
  pathId: string;
  serializedFile: string;
  type: string;
  data: Readonly<Record<string, unknown>>;
  nativeShader?: { type: "Shader"; name: string; serializedFile: string; pathId: string };
}
export interface NativeIntroObjectResolver {
  /** Resolve exact serialized-file/PPtr identity from the active source; no name fallback. */
  resolve(pointer: unknown, owner: NativeIntroObjectRecord): NativeIntroObjectRecord;
  animation(pointer: unknown, owner: NativeIntroObjectRecord, signal: AbortSignal): Promise<unknown>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native intro Timeline record");
  return value as Record<string, unknown>;
};
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid native TimelineClip number");
  return value;
};
const extrapolationTime = (value: unknown): number => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const tag = value as Record<string, unknown>;
    if (Object.keys(tag).length === 1 && tag.$unityFloat === "Infinity") return Number.POSITIVE_INFINITY;
    throw new Error("Unsupported native intro extrapolation scalar tag");
  }
  const time = number(value);
  if (time < 0) throw new Error("Invalid native intro extrapolation time");
  return time;
};
const extrapolation = (value: unknown): 0 | 1 => {
  if (value !== 0 && value !== 1) throw new Error("Unsupported native TimelineClip extrapolation");
  return value;
};

/** Build native clip playback from the projected original TimelineAsset and exact director bindings. */
export async function loadNativeIntroTimeline(
  timeline: NativeIntroObjectRecord,
  boundTargets: ReadonlyMap<string, string>,
  resolver: NativeIntroObjectResolver,
  signal: AbortSignal,
): Promise<NativeIntroTimeline> {
  signal.throwIfAborted();
  const pointers = timeline.data.m_Tracks;
  if (!Array.isArray(pointers)) throw new Error("Original native intro TimelineAsset tracks missing");
  const signals: NativeIntroSignal[] = [];
  const tracks = await Promise.all(pointers.map(async (pointer) => {
    const track = resolver.resolve(pointer, timeline);
    if (track.data.m_Muted === 1 || track.data.m_Muted === true) return undefined;
    const clips = track.data.m_Clips;
    if (!Array.isArray(clips)) throw new Error("Original native intro track clips missing");
    const key = `${track.serializedFile}:${track.pathId}`;
    const target = boundTargets.get(key);
    if (!clips.length) {
      const markers = track.data.m_Markers;
      if (markers && typeof markers === "object" && !Array.isArray(markers)) {
        const pointers = object(markers).m_Objects;
        if (!Array.isArray(pointers)) throw new Error("Original native intro signal markers missing");
        for (const pointer of pointers) {
          const marker = resolver.resolve(pointer, track);
          if (marker.data.m_Enabled !== 1 && marker.data.m_Enabled !== true) continue;
          signals.push({
            time: number(marker.data.m_Time), asset: marker.data.m_Asset,
            ownerSerializedFile: marker.serializedFile,
            emitOnce: marker.data.m_EmitOnce === 1 || marker.data.m_EmitOnce === true,
            retroactive: marker.data.m_Retroactive === 1 || marker.data.m_Retroactive === true,
          });
        }
      }
      return undefined;
    }
    if (!target) throw new Error(`Original native intro track has no bound target: ${key}`);
    const parsed = await Promise.all(clips.map(async (value): Promise<NativeIntroTimelineClip> => {
      signal.throwIfAborted();
      const clip = object(value);
      const asset = resolver.resolve(clip.m_Asset, track);
      const native = await resolver.animation(asset.data.m_Clip, asset, signal);
      signal.throwIfAborted();
      const animation = readNativeAnimationClip(native, { completeTransformBindings: true });
      if (!animation) throw new Error("Original native intro AnimationClip could not be decoded");
      return {
        start: number(clip.m_Start), duration: number(clip.m_Duration),
        clipIn: number(clip.m_ClipIn), timeScale: number(clip.m_TimeScale),
        preExtrapolationTime: number(clip.m_PreExtrapolationTime),
        postExtrapolationTime: extrapolationTime(clip.m_PostExtrapolationTime),
        preExtrapolationMode: extrapolation(clip.m_PreExtrapolationMode),
        postExtrapolationMode: extrapolation(clip.m_PostExtrapolationMode),
        animation,
      };
    }));
    return { target, clips: parsed };
  }));
  signal.throwIfAborted();
  return new NativeIntroTimeline(tracks.filter((track) => track !== undefined), signals.sort((a, b) => a.time - b.time));
}
