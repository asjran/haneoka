import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  Mesh,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  SrcAlphaFactor,
  TextureLoader,
  Vector4,
  type Texture,
} from "three";
import type { RenderOverlaySprite, RenderOverlayTexture } from "@haneoka/cassiopeia-plugin-our-notes";

interface OverlayInstance {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  vertices: InterleavedBuffer;
  indices: BufferAttribute;
  seen: number;
}

/** Consumes the same clip-space xyzw/uv/rgba buffers as the Flutter geometry backend. */
export class OverlayLayer {
  readonly game = new Group();
  readonly effects = new Group();
  readonly screen = new Scene();
  readonly underlay = new Scene();
  readonly screenCamera = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private readonly textures = new Map<string, Texture>();
  private readonly textureLoads = new Map<string, { source: string; pending: Promise<void> }>();
  private readonly materials = new Map<string, ShaderMaterial>();
  private readonly instances = new Map<string, OverlayInstance>();
  private epoch = 0;
  private disposed = false;
  effectsCount = 0;
  screenCount = 0;
  underlayCount = 0;

  async load(manifest: Readonly<Record<string, RenderOverlayTexture>>): Promise<void> {
    if (this.disposed) return;
    const loader = new TextureLoader();
    await Promise.all(
      Object.entries(manifest).map(([key, source]) => {
        const identity = JSON.stringify([source.url, source.origin]);
        const previous = this.textureLoads.get(key);
        if (previous?.source === identity) return previous.pending;
        const pending = loader
          .loadAsync(source.url)
          .then((texture) => {
            if (this.disposed || this.textureLoads.get(key)?.pending !== pending) {
              texture.dispose();
              return;
            }
            texture.colorSpace = NoColorSpace;
            texture.premultiplyAlpha = false;
            texture.flipY = source.origin === "bottom-left";
            texture.generateMipmaps = false;
            texture.minFilter = texture.magFilter = LinearFilter;
            texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
            const old = this.textures.get(key);
            this.textures.set(key, texture);
            if (old) {
              for (const material of this.materials.values())
                if (material.uniforms.uMap!.value === old) material.uniforms.uMap!.value = texture;
              old.dispose();
            }
          })
          .catch((error) => {
            if (this.textureLoads.get(key)?.pending === pending) this.textureLoads.delete(key);
            throw error;
          });
        this.textureLoads.set(key, { source: identity, pending });
        return pending;
      }),
    );
  }

  private material(spec: RenderOverlaySprite): ShaderMaterial {
    const key = JSON.stringify([spec.textureKey, spec.blend, spec.material]);
    const previous = this.materials.get(key);
    if (previous) return previous;
    const texture = this.textures.get(spec.textureKey);
    if (!texture) throw new Error(`Overlay texture was not loaded: ${spec.textureKey}`);
    const additive = spec.blend !== "alpha";
    const hdr = spec.material?.shader === "mobile-add-hdr";
    const material = new ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uTint: { value: new Vector4(...(spec.material?.tint ?? [1, 1, 1, 1])) },
        uTextureTransform: { value: new Vector4(...(spec.material?.textureTransform ?? [1, 1, 0, 0])) },
      },
      vertexShader: `
        attribute vec4 aClipPosition;
        attribute vec4 aTint;
        uniform vec4 uTint;
        uniform vec4 uTextureTransform;
        varying vec2 vUv;
        varying vec4 vTint;
        void main() {
          gl_Position = aClipPosition;
          vUv = uv * uTextureTransform.xy + uTextureTransform.zw;
          vTint = ${hdr ? "2.0 * uTint * uTint * aTint" : "uTint * aTint"};
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec2 vUv;
        varying vec4 vTint;
        float evenRound(float value) {
          float base = floor(value), fraction = value - base;
          return fraction < .5 ? base : fraction > .5 ? base + 1.0 : mod(base, 2.0) == 0.0 ? base : base + 1.0;
        }
        void main() { vec4 tint = vTint; ${hdr ? "tint.a = evenRound(tint.a * 255.0) / 255.0;" : ""}
          gl_FragColor = texture2D(uMap, vUv) * tint; }
      `,
      transparent: true,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: spec.blend === "additive" ? OneFactor : SrcAlphaFactor,
      blendDst: additive ? OneFactor : OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: spec.blend === "source-alpha-additive" ? SrcAlphaFactor : OneFactor,
      blendDstAlpha: additive ? OneFactor : OneMinusSrcAlphaFactor,
    });
    material.forceSinglePass = true;
    material.name = "PortableOverlaySprite";
    this.materials.set(key, material);
    return material;
  }

  update(specs?: ReadonlyArray<RenderOverlaySprite>): void {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.effectsCount = this.screenCount = this.underlayCount = 0;
    for (const spec of specs ?? []) {
      const count = spec.vertices.length / 10;
      if (
        !Number.isInteger(count) ||
        count < 3 ||
        count > 65535 ||
        !spec.indices.length ||
        spec.indices.length % 3 ||
        !Number.isFinite(spec.sortingOrder)
      )
        throw new Error("Invalid overlay geometry layout");
      for (let index = 0; index < spec.vertices.length; index++)
        if (!Number.isFinite(spec.vertices[index])) throw new Error("Non-finite overlay vertex");
      for (let index = 0; index < spec.indices.length; index++)
        if (!Number.isInteger(spec.indices[index]) || spec.indices[index]! < 0 || spec.indices[index]! >= count)
          throw new Error("Overlay index outside vertex buffer");
      let instance = this.instances.get(spec.id);
      if (instance?.seen === epoch) throw new Error(`Duplicate overlay identity: ${spec.id}`);
      if (
        !instance ||
        instance.vertices.array.length < spec.vertices.length ||
        instance.indices.array.length < spec.indices.length
      ) {
        if (instance) {
          instance.mesh.removeFromParent();
          instance.mesh.geometry.dispose();
        }
        const geometry = new BufferGeometry();
        const vertexCapacity = 2 ** Math.ceil(Math.log2(count));
        const indexCapacity = 2 ** Math.ceil(Math.log2(spec.indices.length));
        const vertices = new InterleavedBuffer(new Float32Array(vertexCapacity * 10), 10).setUsage(DynamicDrawUsage);
        const indices = new BufferAttribute(new Uint16Array(indexCapacity), 1).setUsage(DynamicDrawUsage);
        geometry.setAttribute("aClipPosition", new InterleavedBufferAttribute(vertices, 4, 0));
        geometry.setAttribute("uv", new InterleavedBufferAttribute(vertices, 2, 4));
        geometry.setAttribute("aTint", new InterleavedBufferAttribute(vertices, 4, 6));
        geometry.setIndex(indices);
        const mesh = new Mesh(geometry, this.material(spec));
        mesh.name = `Overlay:${spec.id}`;
        mesh.frustumCulled = false;
        instance = { mesh, vertices, indices, seen: epoch };
        this.instances.set(spec.id, instance);
      }
      instance.seen = epoch;
      instance.mesh.material = this.material(spec);
      instance.mesh.renderOrder = spec.sortingOrder;
      (instance.vertices.array as Float32Array).set(spec.vertices);
      (instance.indices.array as Uint16Array).set(spec.indices);
      instance.mesh.geometry.setDrawRange(0, spec.indices.length);
      instance.vertices.clearUpdateRanges();
      instance.indices.clearUpdateRanges();
      instance.vertices.addUpdateRange(0, spec.vertices.length);
      instance.indices.addUpdateRange(0, spec.indices.length);
      instance.vertices.needsUpdate = instance.indices.needsUpdate = true;
      const parent =
        spec.pass === "screen"
          ? this.screen
          : spec.pass === "underlay"
            ? this.underlay
            : spec.pass === "effects"
              ? this.effects
              : this.game;
      if (instance.mesh.parent !== parent) parent.add(instance.mesh);
      if (spec.pass === "effects") this.effectsCount++;
      if (spec.pass === "screen") this.screenCount++;
      if (spec.pass === "underlay") this.underlayCount++;
    }
    for (const [id, instance] of this.instances) {
      if (instance.seen === epoch) continue;
      instance.mesh.removeFromParent();
      instance.mesh.geometry.dispose();
      this.instances.delete(id);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const instance of this.instances.values()) instance.mesh.geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const texture of this.textures.values()) texture.dispose();
    this.instances.clear();
    this.materials.clear();
    this.textures.clear();
    this.textureLoads.clear();
    this.game.clear();
    this.effects.clear();
    this.screen.clear();
    this.underlay.clear();
    this.game.removeFromParent();
    this.effects.removeFromParent();
  }
}
