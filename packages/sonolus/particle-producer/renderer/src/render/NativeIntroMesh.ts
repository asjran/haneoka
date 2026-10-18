import {
  AddEquation, BufferAttribute, BufferGeometry, CustomBlending, DoubleSide,
  DynamicDrawUsage, LessEqualDepth, Matrix4, Mesh, NoColorSpace, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial,
  SrcAlphaFactor, Vector4, type Texture,
} from "three";
import type { NativeIntroMeshData } from "@haneoka/cassiopeia-plugin-our-notes";

/**
 * The actual lane-in centre mesh has eight vertices and four inverse-bind matrices.
 * Keep its authored weighted skinning, rather than replacing it with a screen quad.
 * Pose matrices stay in Unity world coordinates until the one final Z reflection,
 * matching configureOurNotesCamera's coordinate contract.
 */
export class NativeIntroSkinnedMesh {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly position: BufferAttribute;
  private readonly skinMatrices: Matrix4[];
  private readonly bindMatrices: Matrix4[];
  private readonly updateRange: { start: number; count: number };

  constructor(private readonly source: NativeIntroMeshData, material: ShaderMaterial) {
    const geometry = new BufferGeometry();
    this.position = new BufferAttribute(new Float32Array(source.positions.length), 3).setUsage(DynamicDrawUsage);
    geometry.setAttribute("position", this.position);
    geometry.setAttribute("uv", new BufferAttribute(source.uv, 2));
    geometry.setIndex(new BufferAttribute(source.indices, 1));
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = "OurNotesNativeIntroLaneMesh";
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.bindMatrices = source.bindPoses.map((matrix) => new Matrix4().fromArray(matrix));
    this.skinMatrices = source.bindPoses.map(() => new Matrix4());
    this.updateRange = { start: 0, count: source.positions.length };
  }

  /** Native world bone matrices, in the SkinnedMeshRenderer.m_Bones order. */
  update(boneWorldMatrices: ReadonlyArray<ArrayLike<number>>, active: boolean): void {
    this.mesh.visible = active;
    if (!active) return;
    if (boneWorldMatrices.length !== this.skinMatrices.length) throw new Error("Native intro bone pose count mismatch");
    for (let bone = 0; bone < this.skinMatrices.length; bone++) {
      const world = boneWorldMatrices[bone]!;
      if (world.length !== 16) throw new Error("Native intro bone pose is not a matrix");
      for (let component = 0; component < 16; component++)
        if (!Number.isFinite(world[component])) throw new Error("Non-finite native intro bone pose");
      this.skinMatrices[bone]!.fromArray(world).multiply(this.bindMatrices[bone]!);
    }
    const out = this.position.array as Float32Array;
    const inputs = this.source.positions;
    const influences = this.source.influencesPerVertex;
    for (let vertex = 0; vertex < inputs.length / 3; vertex++) {
      const positionOffset = vertex * 3, weightOffset = vertex * influences;
      const x = inputs[positionOffset]!, y = inputs[positionOffset + 1]!, z = inputs[positionOffset + 2]!;
      let total = 0, sx = 0, sy = 0, sz = 0;
      for (let influence = 0; influence < influences; influence++) {
        const offset = weightOffset + influence;
        const weight = this.source.boneWeights[offset]!;
        if (!weight) continue;
        const matrix = this.skinMatrices[this.source.boneIndices[offset]!]!.elements;
        total += weight;
        sx += weight * (matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!);
        sy += weight * (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!);
        sz += weight * (matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!);
      }
      if (!(total > 0) || !Number.isFinite(total)) throw new Error("Native intro vertex has invalid skin weights");
      out[positionOffset] = sx / total;
      out[positionOffset + 1] = sy / total;
      out[positionOffset + 2] = -sz / total;
    }
    this.position.updateRanges.length = 1;
    this.position.updateRanges[0] = this.updateRange;
    this.position.needsUpdate = true;
  }

  /** The caller owns the hand-written shared material and its texture. */
  dispose(): void {
    this.mesh.visible = false;
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
  }
}

/** Hand-written Custom/Mobile/MobileAddHdrColor behavior, shared with owned effect shader math. */
export function createNativeIntroHdrMaterial(
  map: Texture,
  tint: readonly [number, number, number, number],
  textureTransform: readonly [number, number, number, number] = [1, 1, 0, 0],
  vertexColour: readonly [number, number, number, number] = [1, 1, 1, 1],
): ShaderMaterial {
  if (map.colorSpace !== NoColorSpace) throw new Error("Native intro requires an owned Gamma texture");
  if (![...tint, ...textureTransform, ...vertexColour].every(Number.isFinite)) throw new Error("Invalid native intro material parameters");
  const material = new ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uTintColor: { value: new Vector4(...tint) },
      uVertexColour: { value: new Vector4(...vertexColour) },
      uTextureTransform: { value: new Vector4(...textureTransform) },
    },
    vertexShader: `
      uniform vec4 uTintColor;
      uniform vec4 uVertexColour;
      uniform vec4 uTextureTransform;
      varying vec2 vUv;
      varying vec4 vHdrColor;
      void main() {
        vUv = uv * uTextureTransform.xy + uTextureTransform.zw;
        // The mesh defaults white; original SpriteRenderer colour is supplied by its timeline owner.
        vHdrColor = 2.0 * uTintColor * uTintColor * uVertexColour;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying vec4 vHdrColor;
      float evenRoundPositive(float value) {
        float base = floor(value);
        float fraction = value - base;
        if (fraction < 0.5) return base;
        if (fraction > 0.5) return base + 1.0;
        return mod(base, 2.0) == 0.0 ? base : base + 1.0;
      }
      void main() {
        vec4 texel = texture2D(uMap, vUv);
        float alpha = texel.a * evenRoundPositive(vHdrColor.a * 255.0) / 255.0;
        gl_FragColor = vec4(texel.rgb * vHdrColor.rgb, alpha);
      }
    `,
    transparent: true,
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: SrcAlphaFactor,
    blendDst: OneFactor,
    blendEquationAlpha: AddEquation,
    blendSrcAlpha: SrcAlphaFactor,
    blendDstAlpha: OneFactor,
  });
  material.forceSinglePass = true;
  material.name = "OurNotesNativeIntroMobileHdr";
  return material;
}

/** Hand-written original intro Sprite-Unlit-Default subset: Gamma texture and separate colour/alpha factors. */
export function createNativeIntroSpriteUnlitMaterial(
  map: Texture,
  rendererColour: readonly [number, number, number, number],
): ShaderMaterial {
  if (map.colorSpace !== NoColorSpace || !rendererColour.every(Number.isFinite))
    throw new Error("Native intro unlit requires an owned Gamma texture and actual renderer colour");
  const material = new ShaderMaterial({
    uniforms: { uMap: { value: map }, uVertexColour: { value: new Vector4(...rendererColour) } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec4 uVertexColour;
      varying vec2 vUv;
      void main() { gl_FragColor = texture2D(uMap, vUv) * uVertexColour; }
    `,
    transparent: true, side: DoubleSide, depthTest: true, depthFunc: LessEqualDepth,
    depthWrite: false, toneMapped: false, blending: CustomBlending,
    blendEquation: AddEquation, blendSrc: SrcAlphaFactor, blendDst: OneMinusSrcAlphaFactor,
    blendEquationAlpha: AddEquation, blendSrcAlpha: OneFactor, blendDstAlpha: OneMinusSrcAlphaFactor,
  });
  material.forceSinglePass = true;
  material.name = "OurNotesNativeIntroSpriteUnlit";
  return material;
}
