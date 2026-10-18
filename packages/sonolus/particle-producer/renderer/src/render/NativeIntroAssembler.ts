import { Group, Vector4, type Camera, type ShaderMaterial, type Texture } from "three";
import { parseNativeIntroMesh, parseNativeIntroSprite, unityStringHash } from "@haneoka/cassiopeia-plugin-our-notes";
import { NativeIntroScene } from "./NativeIntroScene";
import { NativeIntroSourceIndex } from "./NativeIntroSourceIndex";
import { loadNativeIntroTimeline, type NativeIntroObjectRecord } from "./NativeIntroLoader";
import { createNativeIntroHdrMaterial, createNativeIntroSpriteUnlitMaterial, NativeIntroSkinnedMesh } from "./NativeIntroMesh";
import { NativeIntroSpriteLayer, type NativeIntroSpriteVisual } from "./NativeIntroSpriteLayer";
import { NativeIntroEmitter } from "./NativeIntroParticles";
import { NativeIntroParticleLayer, type NativeIntroParticleVisual } from "./NativeIntroParticleLayer";
import { NativeIntroSignalPlayer, readNativeIntroVoiceSignals } from "./NativeIntroSignals";
import type { NativeIntroBindingSink, NativeIntroTimeline } from "./NativeIntroTimeline";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid intro component");
  return value as Record<string, unknown>;
};
const finite = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid intro component number"); return value;
};
const colour = (value: unknown): [number, number, number, number] => {
  const c = object(value); return [finite(c.r), finite(c.g), finite(c.b), finite(c.a)];
};
const pairs = (value: unknown): Map<string, unknown> => {
  if (!Array.isArray(value)) throw new Error("Invalid intro material properties");
  return new Map(value.map(item => {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string") throw new Error("Invalid intro material property");
    return [item[0], item[1]];
  }));
};
export interface NativeIntroTexture { texture: Texture; width: number; height: number }
export interface NativeIntroAssemblyOptions {
  records: ReadonlyArray<NativeIntroObjectRecord>;
  director: NativeIntroObjectRecord;
  externalPreloads: ReadonlyMap<string, ReadonlySet<string>>;
  signal: AbortSignal;
  /** Current source's original texture PPtr resolution; texture ownership stays with the source cache. */
  texture: (pointer: unknown, owner: NativeIntroObjectRecord, signal: AbortSignal) => Promise<NativeIntroTexture>;
  /** Null serialized bindings are original runtime-injected roles, bound to the actual host adapters. */
  runtimeTracks: ReadonlyMap<string, NativeIntroBindingSink>;
  notifyVoice: (target: NativeIntroObjectRecord) => void;
  nextLifecycleSeed: () => number;
}

/** The exact director, its prefab components, and original external clip graph form one source-owned scene. */
export class NativeIntroAssembly {
  readonly game = new Group();
  readonly effects = new Group();
  private elapsed = 0;
  private evaluatedSeconds = 0;
  get evaluationSeconds(): number { return this.evaluatedSeconds; }
  private requestedSeconds = 0;
  private disposed = false;
  private constructor(
    readonly timeline: NativeIntroTimeline,
    readonly scene: NativeIntroScene,
    private readonly sprites: NativeIntroSpriteLayer,
    private readonly stars: NativeIntroParticleLayer,
    private readonly meshes: ReadonlyArray<{ skin: NativeIntroSkinnedMesh; transform: string; bones: string[]; layer: 25 | 29; sortingGroup?: { key: string; order: number } }>,
    private readonly materials: ReadonlyArray<ShaderMaterial>,
    private readonly sink: NativeIntroBindingSink,
    private readonly signals: NativeIntroSignalPlayer,
    private readonly index: NativeIntroSourceIndex,
  ) {
    this.game.add(sprites.game); this.effects.add(sprites.effects, stars.group);
    for (const { skin, layer, sortingGroup } of meshes) sprites.attachVisual(skin.mesh, layer, sortingGroup);
  }
  static async load(options: NativeIntroAssemblyOptions): Promise<NativeIntroAssembly> {
    const { signal, director } = options;
    const index = new NativeIntroSourceIndex(options.records, signal, options.externalPreloads);
    const local = options.records.filter(r => r.serializedFile === director.serializedFile);
    const bindings = director.data.m_SceneBindings;
    if (!Array.isArray(bindings)) throw new Error("Original intro director bindings missing");
    const targets = new Map<string, string>(), runtime = new Map<string, NativeIntroBindingSink>();
    let animator: NativeIntroObjectRecord | undefined;
    for (const raw of bindings) {
      const binding = object(raw), track = index.resolve(binding.key, director), key = `${track.serializedFile}:${track.pathId}`;
      if (object(binding.value).m_PathID === "0") {
        const name = track.data.m_Name;
        if (typeof name !== "string") throw new Error("Intro runtime track name missing");
        if (name === "Signal Track") continue;
        const adapter = options.runtimeTracks.get(name);
        if (!adapter) throw new Error(`Intro runtime role unavailable: ${name}`);
        targets.set(key, key); runtime.set(key, adapter);
      } else {
        const bound = index.resolve(binding.value, director);
        if (bound.type !== "Animator" || animator) throw new Error("Unsupported original intro animator bindings");
        animator = bound; targets.set(key, `${bound.serializedFile}:${bound.pathId}`);
      }
    }
    if (!animator) throw new Error("Original intro LaneEffect animator missing");
    const rootObject = index.resolve(animator.data.m_GameObject, animator);
    const rootTransform = local.find(r => r.type === "Transform" && object(r.data.m_GameObject).m_PathID === rootObject.pathId);
    if (!rootTransform) throw new Error("Original intro animator transform missing");
    const materialBindings = new Map<string, ShaderMaterial[]>(), spriteColours = new Map<string, [number, number, number, number]>();
    let sprites: NativeIntroSpriteLayer | undefined;
    let particles: NativeIntroParticleLayer | undefined;
    const tintAttributes = [0, 1, 2, 3].map(channel => ((unityStringHash("_TintColor") & 0x0fffffff) | ((channel + 4) << 28)) >>> 0);
    const colourAttributes = ["r", "g", "b", "a"].map(c => unityStringHash(`m_Color.${c}`));
    const scene = new NativeIntroScene(local, `${animator.serializedFile}:${animator.pathId}`, rootTransform.pathId,
      (transform, type, attribute, component, value) => {
        if (type === 212 && colourAttributes.includes(attribute) && component === 0) {
          const current = spriteColours.get(transform);
          if (!current || !sprites) throw new Error("Intro animated sprite colour target unavailable");
          current[colourAttributes.indexOf(attribute)] = value; sprites.setColour(transform, current);
        } else if (type === 137) {
          const channel = tintAttributes.indexOf(attribute), materials = materialBindings.get(transform);
          if (channel < 0 || !materials) throw new Error("Unsupported intro animated material property");
          for (const material of materials) (material.uniforms.uTintColor!.value as Vector4).setComponent(channel, value);
        } else throw new Error(`Unsupported intro component animation: ${type}/${attribute}`);
      });
    const transform = (component: NativeIntroObjectRecord): string => scene.transformForGameObject(index.resolve(component.data.m_GameObject, component).pathId);
    const materials: ShaderMaterial[] = [];
    const materialFor = async (component: NativeIntroObjectRecord, texture: NativeIntroTexture | undefined, vertexColour: [number, number, number, number]): Promise<ShaderMaterial> => {
      const pointers = component.data.m_Materials;
      if (!Array.isArray(pointers) || pointers.length !== 1) throw new Error("Intro renderer material count mismatch");
      const original = index.resolve(pointers[0], component), saved = object(original.data.m_SavedProperties);
      const pointer = object(original.data.m_Shader);
      let shader: unknown;
      if (pointer.m_FileID === 0) {
        const metadata = original.nativeShader;
        if (!metadata || metadata.type !== "Shader" || metadata.serializedFile !== original.serializedFile || metadata.pathId !== pointer.m_PathID)
          throw new Error("Original intro local shader identity metadata missing");
        shader = metadata.name;
      } else shader = object(pointer.reference).name;
      let material: ShaderMaterial;
      if (shader === "Custom/Mobile/MobileAddHdrColor") {
        const tex = object(pairs(saved.m_TexEnvs).get("_MainTex"));
        const image = texture ?? await options.texture(tex.m_Texture, original, signal);
        const scale = object(tex.m_Scale), offset = object(tex.m_Offset);
        material = createNativeIntroHdrMaterial(image.texture, colour(pairs(saved.m_Colors).get("_TintColor")),
          [finite(scale.x), finite(scale.y), finite(offset.x), finite(offset.y)], vertexColour);
      } else if (shader === "Universal Render Pipeline/2D/Sprite-Unlit-Default") {
        if (!texture) throw new Error("Intro Sprite-Unlit requires its original Sprite texture");
        material = createNativeIntroSpriteUnlitMaterial(texture.texture, vertexColour);
      } else throw new Error(`Unsupported intro material shader: ${String(shader)}`);
      materials.push(material);
      const id = transform(component); let list = materialBindings.get(id);
      if (!list) materialBindings.set(id, list = []); list.push(material);
      return material;
    };
    const spriteSpecs: NativeIntroSpriteVisual[] = [];
    const sorting = local.filter(r => r.type === "SortingGroup" && r.data.m_Enabled === 1).map(r => ({ key: r.pathId, transform: transform(r), order: finite(r.data.m_SortingOrder) }));
    const sortingGroupFor = (id: string) => {
      const candidates = sorting.filter(group => scene.isDescendantOf(id, group.transform));
      const nearest = candidates.find(group => !candidates.some(other => other !== group && scene.isDescendantOf(other.transform, group.transform)));
      return nearest && { key: nearest.key, order: nearest.order };
    };
    const skins: { skin: NativeIntroSkinnedMesh; transform: string; bones: string[]; layer: 25 | 29; sortingGroup?: { key: string; order: number } }[] = [];
    const stars: NativeIntroParticleVisual[] = [];
    try {
      for (const component of local) {
        signal.throwIfAborted();
        if (component.type === "SpriteRenderer" && component.data.m_Enabled === true) {
          const sprite = index.resolve(component.data.m_Sprite, component), image = await options.texture(object(sprite.data.m_RD).texture, sprite, signal);
          const id = transform(component), c = colour(component.data.m_Color), size = object(component.data.m_Size);
          const go = index.resolve(component.data.m_GameObject, component), layer = finite(go.data.m_Layer);
          if (layer !== 25 && layer !== 29) throw new Error("Unsupported intro sprite pass");
          const material = await materialFor(component, image, c);
          spriteColours.set(id, c);
          // Select the nearest authored SortingGroup by ancestry depth, retaining prefab order.
          const nearest = sortingGroupFor(id);
          spriteSpecs.push({ transformId: id, sprite: parseNativeIntroSprite(sprite, image.width, image.height),
            drawMode: finite(component.data.m_DrawMode) as 0 | 1, size: [finite(size.x), finite(size.y)],
            flipX: component.data.m_FlipX === true, flipY: component.data.m_FlipY === true, layer,
            sortingLayerId: finite(component.data.m_SortingLayerID) as 0, sortingOrder: finite(component.data.m_SortingOrder),
            sortingGroup: nearest, material,
            setColour: next => (material.uniforms.uVertexColour!.value as Vector4).set(...next) });
        } else if (component.type === "SkinnedMeshRenderer" && component.data.m_Enabled === true) {
          const bones = component.data.m_Bones;
          if (!Array.isArray(bones) || bones.length !== 4) throw new Error("Original intro four-bone mesh missing");
          const material = await materialFor(component, undefined, [1, 1, 1, 1]);
          const skin = new NativeIntroSkinnedMesh(parseNativeIntroMesh(index.resolve(component.data.m_Mesh, component)), material);
          const id = transform(component), go = index.resolve(component.data.m_GameObject, component), layer = finite(go.data.m_Layer);
          if ((layer !== 25 && layer !== 29) || component.data.m_SortingLayerID !== 0) throw new Error("Unsupported original intro mesh pass");
          skin.mesh.renderOrder = finite(component.data.m_SortingOrder);
          skins.push({ skin, transform: id, bones: bones.map(p => index.resolve(p, component).pathId), layer, sortingGroup: sortingGroupFor(id) });
        } else if (component.type === "ParticleSystem") {
          const id = transform(component), go = index.resolve(component.data.m_GameObject, component);
          const renderer = local.find(r => r.type === "ParticleSystemRenderer" && object(r.data.m_GameObject).m_PathID === go.pathId);
          if (!renderer || renderer.data.m_RenderMode !== 3 || renderer.data.m_SortingLayerID !== 0 || go.data.m_Layer !== 29)
            throw new Error("Original intro vertical particle renderer missing");
          stars.push({ transformId: id, emitter: new NativeIntroEmitter(component, options.nextLifecycleSeed),
            material: await materialFor(renderer, undefined, [1, 1, 1, 1]), sortingOrder: finite(renderer.data.m_SortingOrder),
            minParticleSize: finite(renderer.data.m_MinParticleSize), maxParticleSize: finite(renderer.data.m_MaxParticleSize) });
        }
      }
      if (stars.length !== 7 || skins.length !== 1) throw new Error("Original intro component graph differs from seven stars/one lane mesh");
      sprites = new NativeIntroSpriteLayer(scene, spriteSpecs);
      particles = new NativeIntroParticleLayer(scene, stars);
      const timeline = await loadNativeIntroTimeline(index.resolve(director.data.m_PlayableAsset, director), targets, index, signal);
      const receiver = local.find(r => r.type === "MonoBehaviour" && r.data.m_Events && object(r.data.m_Events).m_Signals);
      if (!receiver) throw new Error("Original intro SignalReceiver unavailable");
      const routes = readNativeIntroVoiceSignals(receiver, (p, owner) => index.referenceKey(p, owner));
      const signals = new NativeIntroSignalPlayer(timeline.signals, routes,
        s => index.referenceKey(s.asset, { ...director, serializedFile: s.ownerSerializedFile }),
        key => { const target = local.find(r => `${r.serializedFile}:${r.pathId}` === key); if (!target) throw new Error("Intro voice target missing"); options.notifyVoice(target); });
      const sink: NativeIntroBindingSink = { set: (target, path, attribute, component, value, type) => {
        const adapter = runtime.get(target);
        if (adapter) adapter.set(target, path, attribute, component, value, type);
        else scene.set(target, path, attribute, component, value, type);
      } };
      const result = new NativeIntroAssembly(timeline, scene, sprites, particles, skins, materials, sink, signals, index);
      result.evaluate(0); signal.addEventListener("abort", () => result.dispose(), { once: true });
      signal.throwIfAborted(); return result;
    } catch (error) {
      particles?.dispose(); sprites?.dispose(); for (const { skin } of skins) skin.dispose(); for (const material of materials) material.dispose(); index.dispose(); throw error;
    }
  }
  private evaluate(seconds: number): void {
    this.evaluatedSeconds = seconds;
    this.timeline.sample(seconds, this.sink); this.scene.updateWorldMatrices();
    this.sprites.update();
    for (const { skin, transform, bones } of this.meshes) skin.update(bones.map(id => this.scene.boneWorldMatrix(id)), this.scene.isActive(transform));
  }
  advance(seconds: number, camera: Camera): void {
    if (this.disposed) return;
    if (!Number.isFinite(seconds) || seconds < this.requestedSeconds) throw new Error("Intro scene needs monotonic fixed-tick time");
    this.requestedSeconds = seconds;
    const end = Math.min(this.timeline.duration, seconds), fixedStep = 1 / 60;
    while (this.elapsed + fixedStep <= end) {
      const next = this.elapsed + fixedStep;
      this.evaluate(next); this.stars.tick(fixedStep); this.signals.advance(next); this.elapsed = next;
    }
    if (seconds >= this.timeline.duration && this.elapsed < this.timeline.duration) {
      // The director's exact terminal pose is applied once; display remainders never simulate particles.
      this.evaluate(this.timeline.duration); this.signals.advance(this.timeline.duration);
      this.stars.tick(0); this.elapsed = this.timeline.duration;
    }
    this.stars.update(camera);
  }
  bypass(camera: Camera): void {
    this.signals.bypass(this.timeline.duration); this.elapsed = this.timeline.duration; this.requestedSeconds = this.timeline.duration;
    this.evaluate(this.elapsed); this.stars.tick(0); this.stars.update(camera);
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.signals.dispose(); this.sprites.dispose(); this.stars.dispose();
    for (const { skin } of this.meshes) skin.dispose(); for (const material of this.materials) material.dispose();
    this.game.removeFromParent(); this.effects.removeFromParent(); this.index.dispose();
  }
}
