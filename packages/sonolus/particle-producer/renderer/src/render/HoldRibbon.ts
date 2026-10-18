import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  DynamicDrawUsage,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  Mesh,
  NormalBlending,
  RGBAFormat,
  ShaderMaterial,
  NoColorSpace,
  TextureLoader,
  UnsignedByteType,
  Vector4,
} from "three";
import type { Texture } from "three";
import {
  OUR_NOTES_LIVE_GEOMETRY,
  type OurNotesAssetManifest,
  type OurNotesSlideLineGradient,
  type OurNotesSlideLineStyle,
} from "@haneoka/cassiopeia-plugin-our-notes";
import type { RenderEasing, RenderHold, RenderPathPoint } from "@haneoka/cassiopeia-plugin-our-notes";
import { StageProjector } from "./stageGeometry";

type NativeRenderPathPoint = RenderPathPoint & { lineProgress?: number };
type NativeRenderHold = Omit<RenderHold, "points"> & {
  points: ReadonlyArray<NativeRenderPathPoint>;
  missed?: boolean;
  minimumWidth?: number;
};

type NativeSlideLineStyle = OurNotesSlideLineStyle & {
  disabled?: OurNotesSlideLineGradient;
  widthScale?: number;
  glowRangeScale?: number;
};

interface ResolvedSlideLineStyle extends OurNotesSlideLineStyle {
  readonly disabled: OurNotesSlideLineGradient;
  readonly widthScale: number;
  readonly glowRangeScale: number;
}

interface HoldVisual {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  geometry: BufferGeometry;
  material: ShaderMaterial;
  capacity: number;
  vertices: Float32Array;
  guideUvs: Float32Array;
  vertexBuffer?: InterleavedBuffer;
  vertexUpdateRange: { start: number; count: number };
  lastSeen: number;
  lastState: number;
  lastGuide: number;
}

interface GradientTextureResult {
  texture: DataTexture;
  normalMaxAlpha: number;
}

const EMPTY_FLOATS = new Float32Array(0);
// position3, color4, localBounds2, texCoord4 share one active vertex prefix.
const RIBBON_VERTEX_STRIDE = 13;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const f32 = Math.fround;
// LiveNoteLineViewBase._offsetValue from class init. One mesh unit is three
// trapezia / eight vertices, with the two cap strips occupying the authored
// 0..1/8 and 7/8..1 texture ranges.
const RIBBON_U = [0, 0.125, 0.875, 1] as const;
const RIBBON_COLUMNS = RIBBON_U.length;
// Native type-10 slide lines use a time-derived m and V=.833333373. The
// selected main material's evidenced default MainTex is white, so m has no
// visible effect until a caller explicitly supplies a custom MainTex. The DTO
// does not carry the native begin-time binding, so retain the existing safe
// fixed blend while keeping the native row V.
const MAIN_TEX_ROW_BLEND = 0.5;
const MAIN_TEX_ROW_V = 0.833333373;
const NATIVE_EPSILON = 1e-5;
const NATIVE_FADE_RANGE = 0.01;
const NATIVE_Z_MIN = 0;
const NATIVE_Z_MAX = 217.60000610351562;

function easing(value: number, mode: RenderEasing | undefined): number {
  const t = clamp01(value);
  if (typeof mode === "number") {
    const exponent = Math.max(0.05, Math.abs(mode));
    return mode < 0 ? 1 - (1 - t) ** exponent : t ** exponent;
  }
  switch (mode) {
    case "in":
      return t * t;
    case "out":
      return 1 - (1 - t) * (1 - t);
    case "in-out":
      return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    default:
      return t;
  }
}

function leftEdge(point: RenderPathPoint): number {
  return point.lane - (point.leftLineOffset ?? 0);
}

function rightEdge(point: RenderPathPoint): number {
  return point.lane + point.width + (point.rightLineOffset ?? 0);
}

function isLinear(mode: RenderEasing | undefined): boolean {
  return mode === undefined || mode === "linear";
}

function segmentSteps(from: RenderPathPoint, to: RenderPathPoint): number {
  if (isLinear(to.leftEasing ?? from.leftEasing) && isLinear(to.rightEasing ?? from.rightEasing)) return 1;
  return Math.max(2, Math.min(24, Math.ceil(Math.abs(to.approach - from.approach) * 28)));
}

function sampleCount(points: ReadonlyArray<RenderPathPoint>): number {
  if (points.length < 2) return 0;
  let count = 1;
  for (let index = 0; index < points.length - 1; index += 1) count += segmentSteps(points[index]!, points[index + 1]!);
  return count;
}

function makeFallbackTexture(hasAuthoredTexture: boolean): DataTexture {
  // An unbound native _MainTex uses the shader's white default. An explicit
  // custom texture stays transparent until its resource has loaded.
  const rgba = hasAuthoredTexture ? [0, 0, 0, 0] : [255, 255, 255, 255];
  const texture = new DataTexture(new Uint8Array(rgba), 1, 1, RGBAFormat, UnsignedByteType);
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function resolveStyle(
  style: OurNotesSlideLineStyle,
  noteSkin: OurNotesAssetManifest["source"]["noteSkin"],
): ResolvedSlideLineStyle {
  const native = style as NativeSlideLineStyle;
  return {
    ...style,
    // The root-owned DTO/style change supplies this field. Falling back to
    // normal keeps an older manifest drawable without changing the new path.
    disabled: native.disabled ?? style.normal,
    widthScale: native.widthScale ?? 0.9,
    glowRangeScale: native.glowRangeScale ?? (noteSkin === "skin002" ? 2 : 2.5),
  };
}

function sampleGradientColor(gradient: OurNotesSlideLineGradient, time: number): [number, number, number] {
  const keys = gradient.colors;
  if (keys.length === 0) return [1, 1, 1];
  if (time <= keys[0]![0]) return [keys[0]![1], keys[0]![2], keys[0]![3]];
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1]!;
    const current = keys[index]!;
    if (time <= current[0]) {
      const amount = clamp01((time - previous[0]) / Math.max(NATIVE_EPSILON, current[0] - previous[0]));
      return [
        previous[1] + (current[1] - previous[1]) * amount,
        previous[2] + (current[2] - previous[2]) * amount,
        previous[3] + (current[3] - previous[3]) * amount,
      ];
    }
  }
  const last = keys[keys.length - 1]!;
  return [last[1], last[2], last[3]];
}

function sampleGradientAlpha(gradient: OurNotesSlideLineGradient, time: number): number {
  const [startTime, startAlpha, endTime, endAlpha] = gradient.alpha;
  const amount = clamp01((time - startTime) / Math.max(NATIVE_EPSILON, endTime - startTime));
  return startAlpha + (endAlpha - startAlpha) * amount;
}

function toTextureByte(value: number): number {
  return Math.round(clamp01(value) * 255);
}

function makeGradientTexture(style: ResolvedSlideLineStyle): GradientTextureResult {
  const rows = [style.disabled, style.normal, style.pressed] as const;
  const data = new Uint8Array(256 * 3 * 4);
  let normalMaxAlpha = 0;
  for (let row = 0; row < rows.length; row += 1) {
    const gradient = rows[row]!;
    for (let index = 0; index < 256; index += 1) {
      const time = index / 255;
      const color = sampleGradientColor(gradient, time);
      const alpha = sampleGradientAlpha(gradient, time);
      if (row === 1) normalMaxAlpha = Math.max(normalMaxAlpha, alpha);
      const offset = (row * 256 + index) * 4;
      data[offset] = toTextureByte(color[0]);
      data[offset + 1] = toTextureByte(color[1]);
      data[offset + 2] = toTextureByte(color[2]);
      data[offset + 3] = toTextureByte(alpha);
    }
  }
  const texture = new DataTexture(data, 256, 3, RGBAFormat, UnsignedByteType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, normalMaxAlpha };
}

function makeMaterial(
  mainTexture: Texture,
  gradientTexture: Texture,
  normalAlphaScale: number,
  style: ResolvedSlideLineStyle,
): ShaderMaterial {
  const material = new ShaderMaterial({
    uniforms: {
      uMap: { value: mainTexture },
      uGradientTex: { value: gradientTexture },
      uColor: { value: new Vector4(1, 1, 1, normalAlphaScale) },
      uGradientState: { value: 1 },
      uGuide: { value: 0 },
      uZMin: { value: NATIVE_Z_MIN },
      uZMax: { value: NATIVE_Z_MAX },
      uGlowColor: { value: new Vector4(...style.glow.color) },
      uGlowIntensity: { value: style.glow.intensity },
      uGlowFalloff: { value: style.glow.falloff },
      uGlowWidth: { value: style.glow.width },
      uGlowDisabledScale: { value: style.glow.disabledScale },
      uGlowEnabledScale: { value: style.glow.enabledScale },
      uGlowPressedScale: { value: style.glow.pressedScale },
      uGuideColor: { value: new Vector4(...style.guide) },
    },
    vertexShader: `
      attribute vec2 aLocalBounds;
      attribute vec4 aTexCoord;
      varying vec2 vUv;
      varying vec3 vLocalPosition;
      varying vec4 vColor;
      varying vec2 vLocalBounds;
      varying vec4 vTexCoord;
      void main() {
        vUv = uv;
        vLocalPosition = position;
        vColor = color;
        vLocalBounds = aLocalBounds;
        vTexCoord = aTexCoord;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform sampler2D uGradientTex;
      uniform vec4 uColor;
      uniform float uGradientState;
      uniform float uGuide;
      uniform float uZMin;
      uniform float uZMax;
      uniform vec4 uGlowColor;
      uniform float uGlowIntensity;
      uniform float uGlowFalloff;
      uniform float uGlowWidth;
      uniform float uGlowDisabledScale;
      uniform float uGlowEnabledScale;
      uniform float uGlowPressedScale;
      uniform vec4 uGuideColor;
      varying vec2 vUv;
      varying vec3 vLocalPosition;
      varying vec4 vColor;
      varying vec2 vLocalBounds;
      varying vec4 vTexCoord;

      float saturate(float value) {
        return clamp(value, 0.0, 1.0);
      }

      vec3 rgbToHsv(vec3 value) {
        const float epsilon = 1.0e-10;
        vec4 k = vec4(0.0, -0.3333333333, 0.6666666667, -1.0);
        vec4 p = mix(vec4(value.bg, k.wz), vec4(value.gb, k.xy), step(value.b, value.g));
        vec4 q = mix(vec4(p.xyw, value.r), vec4(value.r, p.yzx), step(p.x, value.r));
        float chroma = q.x - min(q.w, q.y);
        float hue = abs(q.z + (q.w - q.y) / (6.0 * chroma + epsilon));
        float saturation = chroma / (q.x + epsilon);
        return vec3(hue, saturation, q.x);
      }

      vec3 hsvToRgb(vec3 value) {
        vec3 profile = abs(fract(value.xxx + vec3(1.0, 0.6666666667, 0.3333333333)) * 6.0 - 3.0);
        profile = clamp(profile - 1.0, 0.0, 1.0);
        return value.z * mix(vec3(1.0), profile, value.y);
      }

      void main() {
        if (vLocalPosition.z < uZMin || uZMax < vLocalPosition.z) discard;

        float width = vLocalBounds.y - vLocalBounds.x;
        float across = width > 0.00001
          ? saturate((vLocalPosition.x - vLocalBounds.x) / width)
          : 0.5;
        vec2 mainUv = vec2(mix(vTexCoord.x, vTexCoord.y, across), vTexCoord.w);
        vec4 mainA = texture2D(uMap, mainUv);
        vec3 mainB = texture2D(uMap, mainUv + vec2(0.0, 0.166666001)).rgb;
        vec3 sampledMain = mix(mainA.rgb, mainB, vTexCoord.z);
        vec4 gradient = texture2D(uGradientTex, vec2(vColor.r, uGradientState * 0.333333343 + 0.166666672));
        float baseAlpha = mainA.a * uColor.a * vColor.a;

        // Guide ribbons are not proven to share the selected main slide-line
        // material contract. Keep their established visual path separate.
        if (uGuide > 0.5) {
          vec4 guideTexel = texture2D(uMap, vUv);
          vec4 guideOutput = guideTexel * uGuideColor;
          float guideScale = uGradientState >= 1.5 ? uGlowPressedScale : uGlowEnabledScale;
          float guideGlow = exp(
            -uGlowFalloff * abs(vUv.x - 0.5) * 2.0 /
            max(0.0001, uGlowWidth * guideScale)
          );
          guideOutput.rgb += uGlowColor.rgb * (uGlowIntensity * guideGlow * guideTexel.a);
          guideOutput.a *= vColor.a;
          if (guideOutput.a < 0.001) discard;
          gl_FragColor = guideOutput;
          return;
        }

        vec3 baseRgb = sampledMain * gradient.rgb * uColor.rgb;
        float stateScale = uGradientState < 0.5
          ? uGlowDisabledScale
          : (uGradientState < 1.5 ? uGlowEnabledScale : uGlowPressedScale);
        float glowBase = saturate(vColor.g / max(uGlowWidth, 0.001));
        float glowPower = glowBase <= 0.0 ? 0.0 : exp2(log2(glowBase) * uGlowFalloff);
        float glow = glowPower * uGlowIntensity * stateScale;
        vec3 hsv = rgbToHsv(baseRgb);
        vec3 adjusted = hsvToRgb(vec3(hsv.x, saturate(hsv.y - glow), saturate(hsv.z + glow)));
        vec3 outputRgb = mix(adjusted, uGlowColor.rgb, glow);

        float coverageDistance = width * (1.0 - vColor.g);
        float derivative = abs(dFdx(coverageDistance)) + abs(dFdy(coverageDistance));
        float coverage = width > 0.00001
          ? saturate(coverageDistance / max(derivative, 0.00001))
          : 1.0;
        float outputAlpha = mix(baseAlpha * gradient.a, baseAlpha, glow) * coverage;
        gl_FragColor = vec4(outputRgb, outputAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: BackSide,
    blending: NormalBlending,
    toneMapped: false,
    vertexColors: true,
  });
  return material;
}

/** Slide/guide ribbon mesh rendered with the selected native gradient. */
export class HoldRibbonLayer {
  readonly group = new Group();

  private readonly projector: StageProjector;
  private readonly assets: OurNotesAssetManifest;
  private readonly style: ResolvedSlideLineStyle;
  private readonly visuals = new Map<RenderHold["id"], HoldVisual>();
  private readonly pool: HoldVisual[] = [];
  private readonly maximumSamplesById = new Map<RenderHold["id"], number>();
  private readonly fallbackTexture: DataTexture;
  private readonly gradientTexture: DataTexture;
  private readonly normalAlphaScale: number;
  private slideTexture?: Texture;
  private disposed = false;
  private updateEpoch = 0;
  private visualAllocations = 0;
  private visualReuses = 0;
  private visualReleases = 0;
  private capacityGrowths = 0;

  constructor(projector: StageProjector, assets: OurNotesAssetManifest) {
    this.projector = projector;
    this.assets = assets;
    this.style = resolveStyle(assets.slideLineStyle, assets.source.noteSkin);
    const gradient = makeGradientTexture(this.style);
    this.gradientTexture = gradient.texture;
    this.normalAlphaScale = gradient.normalMaxAlpha > 0 ? 1 / gradient.normalMaxAlpha : 1;
    this.fallbackTexture = makeFallbackTexture(Boolean(assets.particles.slideLineTextureUrl));
    this.group.name = "OurNotesHoldRibbons";
  }

  async loadTexture(loader = new TextureLoader()): Promise<void> {
    if (!this.assets.particles.slideLineTextureUrl) return;
    const texture = await loader.loadAsync(this.assets.particles.slideLineTextureUrl);
    // Native HSV/glow calculations consume Gamma texels, not decoded linear RGB.
    texture.colorSpace = NoColorSpace;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    if (this.disposed) {
      texture.dispose();
      return;
    }
    this.slideTexture?.dispose();
    this.slideTexture = texture;
    for (const visual of this.visuals.values()) visual.material.uniforms.uMap.value = texture;
    for (const visual of this.pool) visual.material.uniforms.uMap.value = texture;
  }

  update(holds: ReadonlyArray<RenderHold> | undefined, _time: number): void {
    const epoch = ++this.updateEpoch;
    for (const hold of holds ?? []) {
      const nativeHold = hold as NativeRenderHold;
      if (nativeHold.visible === false || nativeHold.points.length < 2) continue;
      const requiredSamples = sampleCount(nativeHold.points);
      const knownMaximum = this.maximumSamplesById.get(nativeHold.id) ?? 0;
      if (requiredSamples > knownMaximum) this.maximumSamplesById.set(nativeHold.id, requiredSamples);
      let visual = this.visuals.get(nativeHold.id);
      if (!visual) {
        visual = this.acquireVisual(nativeHold, Math.max(requiredSamples, knownMaximum));
        this.visuals.set(nativeHold.id, visual);
        this.group.add(visual.mesh);
      }
      visual.lastSeen = epoch;
      const opacity = clamp01(nativeHold.alpha ?? 1);
      this.updateGeometry(visual, nativeHold.points, requiredSamples, opacity, nativeHold.minimumWidth);
      const state = nativeHold.active ? 2 : nativeHold.missed ? 0 : 1;
      if (visual.lastState !== state) {
        visual.material.uniforms.uGradientState.value = state;
        visual.lastState = state;
      }
      const guide = nativeHold.kind === "guide" ? 1 : 0;
      if (visual.lastGuide !== guide) {
        visual.material.uniforms.uGuide.value = guide;
        visual.lastGuide = guide;
      }
      visual.mesh.visible = true;
    }

    for (const [id, visual] of this.visuals) {
      if (visual.lastSeen !== epoch) this.releaseVisual(id, visual);
    }
  }

  private acquireVisual(hold: NativeRenderHold, requiredSamples: number): HoldVisual {
    let selected = -1;
    let selectedCapacity = Number.POSITIVE_INFINITY;
    let largest = -1;
    for (let index = 0; index < this.pool.length; index += 1) {
      const capacity = this.pool[index]!.capacity;
      if (largest < 0 || capacity > this.pool[largest]!.capacity) largest = index;
      if (capacity >= requiredSamples && capacity < selectedCapacity) {
        selected = index;
        selectedCapacity = capacity;
      }
    }
    if (selected < 0) selected = largest;
    const pooled = selected < 0 ? undefined : this.pool[selected];
    if (pooled) {
      const last = this.pool.pop()!;
      if (selected < this.pool.length) this.pool[selected] = last;
      this.visualReuses += 1;
      pooled.mesh.name = `HoldRibbon:${String(hold.id)}`;
      pooled.mesh.visible = true;
      return pooled;
    }
    this.visualAllocations += 1;
    return this.createVisual(hold);
  }

  private createVisual(hold: NativeRenderHold): HoldVisual {
    const geometry = new BufferGeometry();
    const material = makeMaterial(
      this.slideTexture ?? this.fallbackTexture,
      this.gradientTexture,
      this.normalAlphaScale,
      this.style,
    );
    const mesh = new Mesh(geometry, material);
    mesh.name = `HoldRibbon:${String(hold.id)}`;
    mesh.frustumCulled = false;
    // Slide line view MeshRenderer: m_SortingOrder=4999.
    mesh.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.holdLine;
    return {
      mesh,
      geometry,
      material,
      capacity: 0,
      vertices: EMPTY_FLOATS,
      guideUvs: EMPTY_FLOATS,
      vertexUpdateRange: { start: 0, count: 0 },
      lastSeen: 0,
      lastState: Number.NaN,
      lastGuide: Number.NaN,
    };
  }

  private ensureCapacity(visual: HoldVisual, requiredSamples: number): void {
    if (requiredSamples <= visual.capacity) return;
    const previousGeometry = visual.geometry;
    const geometry = new BufferGeometry();
    let capacity = Math.max(16, visual.capacity || 16);
    while (capacity < requiredSamples) capacity *= 2;
    visual.capacity = capacity;
    this.capacityGrowths += 1;
    const vertexCount = capacity * RIBBON_COLUMNS;
    visual.vertices = new Float32Array(vertexCount * RIBBON_VERTEX_STRIDE);
    visual.guideUvs = new Float32Array(vertexCount * 2);
    for (let sample = 0; sample < capacity; sample += 1) {
      for (let column = 0; column < RIBBON_COLUMNS; column += 1) {
        const uvOffset = (sample * RIBBON_COLUMNS + column) * 2;
        visual.guideUvs[uvOffset] = RIBBON_U[column]!;
        visual.guideUvs[uvOffset + 1] = 0.5;
      }
    }
    const indices = new Uint32Array(Math.max(0, capacity - 1) * 18);
    for (let index = 0; index < capacity - 1; index += 1) {
      const near = index * RIBBON_COLUMNS;
      const far = near + RIBBON_COLUMNS;
      for (let strip = 0; strip < 3; strip += 1) {
        const offset = index * 18 + strip * 6;
        indices[offset] = near + strip;
        indices[offset + 1] = far + strip;
        indices[offset + 2] = near + strip + 1;
        indices[offset + 3] = far + strip;
        indices[offset + 4] = far + strip + 1;
        indices[offset + 5] = near + strip + 1;
      }
    }
    const vertices = new InterleavedBuffer(visual.vertices, RIBBON_VERTEX_STRIDE).setUsage(DynamicDrawUsage);
    visual.vertexBuffer = vertices;
    geometry.setAttribute("position", new InterleavedBufferAttribute(vertices, 3, 0));
    geometry.setAttribute("color", new InterleavedBufferAttribute(vertices, 4, 3));
    geometry.setAttribute("aLocalBounds", new InterleavedBufferAttribute(vertices, 2, 7));
    geometry.setAttribute("aTexCoord", new InterleavedBufferAttribute(vertices, 4, 9));
    const guideUv = new BufferAttribute(visual.guideUvs, 2);
    geometry.setAttribute("uv", guideUv);
    geometry.setIndex(new BufferAttribute(indices, 1));
    visual.geometry = geometry;
    visual.mesh.geometry = geometry;
    // BufferAttribute has no public dispose event. Disposing the complete old
    // geometry is what lets WebGLGeometries release every superseded GPU
    // buffer after a capacity growth.
    previousGeometry.dispose();
  }

  private updateGeometry(
    visual: HoldVisual,
    points: ReadonlyArray<NativeRenderPathPoint>,
    count: number,
    opacity: number,
    minimumWidthOverride: number | undefined,
  ): void {
    if (count < 2) {
      visual.geometry.setDrawRange(0, 0);
      return;
    }
    this.ensureCapacity(visual, count);
    const minimumWidth = this.minimumAuthoredWidth(points, minimumWidthOverride);
    const widthInset = Math.min(Math.max(0, 6 * (1 - this.style.widthScale)), minimumWidth / 2);
    let sampleIndex = 0;

    for (let index = 0; index < points.length - 1; index += 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const steps = segmentSteps(from, to);
      const fromLeft = leftEdge(from);
      const fromRight = rightEdge(from);
      const toLeft = leftEdge(to);
      const toRight = rightEdge(to);
      for (let step = index === 0 ? 0 : 1; step <= steps; step += 1) {
        const t = step / steps;
        const leftT = easing(t, to.leftEasing ?? from.leftEasing);
        const rightT = easing(t, to.rightEasing ?? from.rightEasing);
        const approach = from.approach + (to.approach - from.approach) * t;
        const lineProgress = this.interpolateLineProgress(from, to, t);
        this.writeSample(
          visual,
          sampleIndex,
          fromLeft + (toLeft - fromLeft) * leftT,
          fromRight + (toRight - fromRight) * rightT,
          approach,
          lineProgress,
          widthInset,
          opacity,
        );
        sampleIndex += 1;
      }
    }

    visual.geometry.setDrawRange(0, Math.max(0, sampleIndex - 1) * 18);
    const vertexCount = sampleIndex * RIBBON_COLUMNS;
    const vertices = visual.vertexBuffer!;
    visual.vertexUpdateRange.count = vertexCount * RIBBON_VERTEX_STRIDE;
    vertices.updateRanges.length = 1;
    vertices.updateRanges[0] = visual.vertexUpdateRange;
    vertices.needsUpdate = true;
  }

  private minimumAuthoredWidth(points: ReadonlyArray<NativeRenderPathPoint>, override: number | undefined): number {
    if (typeof override === "number" && Number.isFinite(override)) return Math.max(0, override);
    let minimum = Number.POSITIVE_INFINITY;
    for (const point of points) minimum = Math.min(minimum, Math.max(0, point.width));
    return Number.isFinite(minimum) ? minimum : 0;
  }

  private interpolateLineProgress(from: NativeRenderPathPoint, to: NativeRenderPathPoint, t: number): number {
    // Root supplies whole-line authored progress, already preserved through
    // visible clipping. A zero fallback keeps older DTOs safe but is not a
    // claim of native parity for callers that omit the new field.
    const start = typeof from.lineProgress === "number" ? from.lineProgress : 0;
    const end = typeof to.lineProgress === "number" ? to.lineProgress : start;
    const amount = f32(t);
    return f32(f32(start) + f32(f32(end - start) * amount));
  }

  private writeSample(
    visual: HoldVisual,
    sampleIndex: number,
    leftLane: number,
    rightLane: number,
    approach: number,
    lineProgress: number,
    widthInset: number,
    opacity: number,
  ): void {
    // Native widthScale applies an authored-unit inset before projection. The
    // input width is a whole ribbon width, so shrink symmetrically around its
    // authored center before asking StageProjector for projected edges.
    const authoredCenter = (leftLane + rightLane) / 2;
    const authoredWidth = Math.max(rightLane - leftLane - widthInset, 0);
    const adjustedLeftLane = authoredCenter - authoredWidth / 2;
    const adjustedRightLane = authoredCenter + authoredWidth / 2;
    const viewProgress = this.projector.viewProgress(approach);
    const projectedLeft = this.projector.laneEdgeToXAtViewProgress(adjustedLeftLane, viewProgress);
    const projectedRight = this.projector.laneEdgeToXAtViewProgress(adjustedRightLane, viewProgress);
    const outerLeft = Math.min(projectedLeft, projectedRight);
    const outerRight = Math.max(projectedLeft, projectedRight);
    const glowHalfWidth = Math.min(
      (viewProgress * this.style.glowRangeScale) / 2,
      Math.max(outerRight - outerLeft, 0) / 2,
    );
    // NoteLineTrapezoidCalculator clips each column against the same
    // progress-scaled lane boundaries. Preserve the unclipped glow width so
    // a cut border narrows its UV interval along with its geometry.
    const laneLeft = this.projector.laneEdgeToXAtViewProgress(0, viewProgress);
    const laneRight = this.projector.laneEdgeToXAtViewProgress(this.projector.laneCount, viewProgress);
    const columns = [
      clamp(outerLeft, laneLeft, laneRight),
      clamp(outerLeft + glowHalfWidth, laneLeft, laneRight),
      clamp(outerRight - glowHalfWidth, laneLeft, laneRight),
      clamp(outerRight, laneLeft, laneRight),
    ];
    const leftBorderWidth = columns[1]! - columns[0]!;
    const rightBorderWidth = columns[3]! - columns[2]!;
    const leftUvAmount = glowHalfWidth >= 1e-6 ? clamp01(leftBorderWidth / glowHalfWidth) : 0;
    const rightUvAmount = glowHalfWidth >= 1e-6 ? clamp01(rightBorderWidth / glowHalfWidth) : 0;
    const leftInnerU = 0.5 + (0.125 - 0.5) * leftUvAmount;
    const rightInnerU = 0.5 + (0.875 - 0.5) * rightUvAmount;
    const y = this.projector.yAtViewProgress(viewProgress);
    const z = 0;
    const fade = approach <= 1 || NATIVE_FADE_RANGE <= 0 ? 1 : 1 - clamp01((approach - 1) / NATIVE_FADE_RANGE);
    const alpha = opacity * fade;
    for (let column = 0; column < RIBBON_COLUMNS; column += 1) {
      const vertex = sampleIndex * RIBBON_COLUMNS + column;
      const positionOffset = vertex * RIBBON_VERTEX_STRIDE;
      const colorOffset = positionOffset + 3;
      const boundsOffset = positionOffset + 7;
      const texCoordOffset = positionOffset + 9;
      const leftBorder = column < 2;
      const referenceLeft = leftBorder ? columns[0]! : columns[2]!;
      const referenceRight = leftBorder ? columns[1]! : columns[3]!;
      const textureLeft = leftBorder ? 0.5 * (1 - leftUvAmount) : rightInnerU;
      const textureRight = leftBorder ? leftInnerU : 0.5 + 0.5 * rightUvAmount;
      visual.vertices[positionOffset] = columns[column]!;
      visual.vertices[positionOffset + 1] = y;
      visual.vertices[positionOffset + 2] = z;
      visual.vertices[colorOffset] = lineProgress;
      visual.vertices[colorOffset + 1] = column === 0 || column === 3 ? 1 : 0;
      visual.vertices[colorOffset + 2] = 0;
      visual.vertices[colorOffset + 3] = alpha;
      visual.vertices[boundsOffset] = referenceLeft;
      visual.vertices[boundsOffset + 1] = referenceRight;
      visual.vertices[texCoordOffset] = textureLeft;
      visual.vertices[texCoordOffset + 1] = textureRight;
      visual.vertices[texCoordOffset + 2] = MAIN_TEX_ROW_BLEND;
      visual.vertices[texCoordOffset + 3] = MAIN_TEX_ROW_V;
    }
  }

  private releaseVisual(id: RenderHold["id"], visual: HoldVisual): void {
    this.group.remove(visual.mesh);
    visual.mesh.visible = false;
    this.visuals.delete(id);
    this.pool.push(visual);
    this.visualReleases += 1;
  }

  private disposeVisual(visual: HoldVisual): void {
    visual.geometry.dispose();
    visual.material.dispose();
  }

  get stats(): {
    activeVisuals: number;
    pooledVisuals: number;
    visualAllocations: number;
    visualReuses: number;
    visualReleases: number;
    capacityGrowths: number;
    sampleCapacity: number;
  } {
    let sampleCapacity = 0;
    for (const visual of this.visuals.values()) sampleCapacity += visual.capacity;
    for (const visual of this.pool) sampleCapacity += visual.capacity;
    return {
      activeVisuals: this.visuals.size,
      pooledVisuals: this.pool.length,
      visualAllocations: this.visualAllocations,
      visualReuses: this.visualReuses,
      visualReleases: this.visualReleases,
      capacityGrowths: this.capacityGrowths,
      sampleCapacity,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const visual of this.visuals.values()) this.disposeVisual(visual);
    this.visuals.clear();
    for (const visual of this.pool) this.disposeVisual(visual);
    this.pool.length = 0;
    this.maximumSamplesById.clear();
    this.slideTexture?.dispose();
    this.gradientTexture.dispose();
    this.fallbackTexture.dispose();
    this.group.clear();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
