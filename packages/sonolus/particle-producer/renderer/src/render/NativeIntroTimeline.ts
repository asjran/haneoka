import { nativeAnimationClipBindingValue, type NativeAnimationClip } from "./ParticleLayer";

/** Authored TimelineClip data; time is pre-music intro seconds, never the media playhead. */
export interface NativeIntroTimelineClip {
  start: number;
  duration: number;
  clipIn: number;
  timeScale: number;
  preExtrapolationTime: number;
  postExtrapolationTime: number;
  preExtrapolationMode: 0 | 1;
  postExtrapolationMode: 0 | 1;
  animation: NativeAnimationClip;
}
export interface NativeIntroTimelineTrack {
  /** Actual bound animator identity resolved from PlayableDirector.m_SceneBindings. */
  target: string;
  clips: ReadonlyArray<NativeIntroTimelineClip>;
}
export interface NativeIntroSignal {
  time: number;
  /** Original normalized PPtr; caller routes it through the real SignalReceiver. */
  asset: unknown;
  ownerSerializedFile: string;
  emitOnce: boolean;
  retroactive: boolean;
}
export interface NativeIntroBindingSink {
  set(target: string, pathHash: number, attribute: number, component: number, value: number, typeId: number): void;
}

/** None / Hold extrapolation of the real start timeline. Authored clip order is retained. */
export function nativeIntroClipTime(clip: NativeIntroTimelineClip, introSeconds: number): number | undefined {
  const end = clip.start + clip.duration;
  if (introSeconds >= clip.start && introSeconds <= end)
    return Math.min((introSeconds - clip.start) * clip.timeScale + clip.clipIn, clip.animation.duration);
  if (introSeconds < clip.start && introSeconds >= clip.start - clip.preExtrapolationTime)
    return clip.preExtrapolationMode === 1 ? clip.clipIn : undefined;
  if (introSeconds > end && introSeconds <= end + clip.postExtrapolationTime)
    return clip.postExtrapolationMode === 1 ? Math.min(clip.duration * clip.timeScale + clip.clipIn, clip.animation.duration) : undefined;
  return undefined;
}

/** Hand-written timeline binding playback; shader program data is not part of this contract. */
export class NativeIntroTimeline {
  readonly duration: number;
  constructor(private readonly tracks: ReadonlyArray<NativeIntroTimelineTrack>, readonly signals: ReadonlyArray<NativeIntroSignal> = []) {
    let duration = 0;
    for (const track of tracks) for (const clip of track.clips) {
      if (![clip.start, clip.duration, clip.clipIn, clip.timeScale, clip.preExtrapolationTime].every(Number.isFinite) ||
          !(Number.isFinite(clip.postExtrapolationTime) || clip.postExtrapolationTime === Number.POSITIVE_INFINITY) ||
          clip.preExtrapolationTime < 0 || clip.postExtrapolationTime < 0 ||
          clip.duration < 0 || clip.start < 0 || clip.timeScale < 0 ||
          (clip.preExtrapolationMode !== 0 && clip.preExtrapolationMode !== 1) ||
          (clip.postExtrapolationMode !== 0 && clip.postExtrapolationMode !== 1))
        throw new Error("Unsupported native intro timeline clip");
      if (clip.animation.bindings.some((binding) => binding.typeId === undefined))
        throw new Error("Native intro clip binding class identity missing");
      duration = Math.max(duration, clip.start + clip.duration);
    }
    for (const marker of signals) if (!Number.isFinite(marker.time) || marker.time < 0)
      throw new Error("Invalid native intro signal time");
    this.duration = duration;
  }

  sample(introSeconds: number, sink: NativeIntroBindingSink): void {
    if (!Number.isFinite(introSeconds)) throw new Error("Invalid native intro timeline time");
    const time = Math.max(0, Math.min(this.duration, introSeconds));
    for (const track of this.tracks) for (const clip of track.clips) {
      const localTime = nativeIntroClipTime(clip, time);
      if (localTime === undefined) continue;
      for (const binding of clip.animation.bindings) for (let component = 0; component < binding.componentCount; component++) {
        const value = nativeAnimationClipBindingValue(clip.animation, binding.path, binding.attribute, localTime, component, binding.typeId);
        if (value !== undefined) {
          if (binding.typeId === undefined) throw new Error("Native intro binding class identity missing");
          sink.set(track.target, binding.path, binding.attribute, component, value, binding.typeId);
        }
      }
    }
  }
}
