import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Matrix3,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  ShaderMaterial,
} from "three";
import type { Raycaster } from "three";
import type { NativeNoteHit } from "./presentation";
import { SpriteAtlas, type SpriteMesh, type SpriteRegion } from "../assets/SpriteAtlas";
import { OUR_NOTES_LIVE_GEOMETRY, type OurNotesAssetManifest } from "@haneoka/cassiopeia-plugin-our-notes";
import {
  layoutNoteSkinArrow,
  layoutNoteSkinBody,
  layoutNoteSkinDecoration,
  noteSkinArrowName,
  noteSkinDecorationName,
  noteSkinEffectiveDirection,
  noteSkinSpriteBounds,
  noteSkinTightHorizontalSlices,
  selectNoteSkinParts,
  type NoteSkinParts,
  type NoteSkinSpriteBounds,
  type NoteSkinOverlayLayout,
} from "./noteSkinLayout";
import type { RenderNote, RenderNoteKind } from "@haneoka/cassiopeia-plugin-our-notes";
import { StageProjector } from "./stageGeometry";

interface NoteVisual {
  root: Group;
  signature: string;
  materials: MeshBasicMaterial[];
  /** Merged body: native cap meshes + three sliced main strips in one mesh. */
  body: Mesh<BufferGeometry, MeshBasicMaterial>;
  bodyPositions: BufferAttribute;
  bodyCaps: readonly [BodyCap, BodyCap];
  decoration?: Mesh<BufferGeometry, MeshBasicMaterial>;
  /** skin003 flick arrows use a shader-driven gradient instead of the atlas material. */
  arrow?: Mesh<BufferGeometry, MeshBasicMaterial | ShaderMaterial>;
  arrowLayout?: NoteSkinOverlayLayout;
  arrowGradientMaterial?: ShaderMaterial;
  gradientStartedAt: number;
  parts: NoteSkinParts;
  decorationName?: string;
  arrowName?: string;
  lastSeen: number;
  layoutWidth: number;
  layoutScale: number;
  lastAlpha: number;
  /** Cached ease-note mark state; retained across pooling so reuse can restore it. */
  lastEaseMarkEmphasized?: boolean;
}

/** Three source quads retain SpriteRenderer drawMode=Sliced borders. */
const MAIN_BODY_QUADS = 3;

interface BodyCap {
  region?: SpriteRegion;
  mesh?: SpriteMesh;
  vertexOffset: number;
}

interface NoteDescriptor {
  kind: RenderNoteKind;
  lane: number;
  width: number;
  direction: RenderNote["direction"];
  parts: NoteSkinParts;
  signature: string;
  decorationName?: string;
  arrowName?: string;
}

export interface EaseNoteMarkPresentation {
  /** Whether this note view owns the mark SpriteRenderer affected by the option. */
  hasMark: boolean;
  emphasized: boolean;
  /** Native mark Transform.localScale multiplier, including its Z component. */
  scaleMultiplier: 1 | 2;
  /** SpriteRenderer tint expressed as a Three.js hexadecimal color. */
  color: 0x000000 | 0xffffff;
}

/**
 * Resolve the ease-note mark branch independently of body and flick-arrow
 * presentation. Slide-end views do not own a rendered mark.
 */
export function resolveEaseNoteMarkPresentation(
  kind: RenderNoteKind,
  critical: boolean,
  isShowEaseNote: boolean,
): EaseNoteMarkPresentation {
  const hasMark = noteSkinDecorationName(kind) !== undefined;
  const emphasized = hasMark && critical && isShowEaseNote;
  return {
    hasMark,
    emphasized,
    scaleMultiplier: emphasized ? 2 : 1,
    color: emphasized ? 0x000000 : 0xffffff,
  };
}

/** Sprite-atlas note renderer using the selected native note skin. */
export class NoteLayer {
  readonly group = new Group();

  private readonly projector: StageProjector;
  private readonly assets: OurNotesAssetManifest;
  private readonly plane = new PlaneGeometry(1, 1);
  private readonly visuals = new Map<RenderNote["id"], NoteVisual>();
  private readonly pools = new Map<string, NoteVisual[]>();
  private readonly descriptors = new Map<RenderNote["id"], NoteDescriptor>();
  private readonly bounds = new Map<string, NoteSkinSpriteBounds>();
  private atlas?: SpriteAtlas;
  private updateEpoch = 0;
  private visualAllocations = 0;
  private visualReuses = 0;
  private visualReleases = 0;
  private meshAllocations = 0;
  private isShowEaseNote = false;

  constructor(projector: StageProjector, assets: OurNotesAssetManifest) {
    this.projector = projector;
    this.assets = assets;
    this.group.name = "OurNotesNotes";
  }

  setAtlas(atlas: SpriteAtlas | undefined): void {
    this.destroyVisuals();
    this.descriptors.clear();
    this.bounds.clear();
    this.atlas = atlas;
  }

  /** Mirrors the live-view ease-note option; disabled by default. */
  setShowEaseNote(isShowEaseNote: boolean): void {
    this.isShowEaseNote = isShowEaseNote;
  }

  update(notes: ReadonlyArray<RenderNote> | undefined, timeSeconds = 0): void {
    const epoch = ++this.updateEpoch;
    let drawOrdinal = 0;
    for (const note of notes ?? []) {
      if (note.visible === false) continue;
      const descriptor = this.descriptor(note);
      let visual = this.visuals.get(note.id);
      if (!visual || visual.signature !== descriptor.signature) {
        if (visual) this.releaseVisual(note.id, visual);
        visual = this.acquireVisual(note, descriptor);
        visual.gradientStartedAt = timeSeconds;
        this.visuals.set(note.id, visual);
        this.group.add(visual.root);
      }
      visual.lastSeen = epoch;
      this.setSortOrder(visual, drawOrdinal++);
      this.layout(visual, note, timeSeconds);
    }
    for (const [id, visual] of this.visuals) {
      if (visual.lastSeen !== epoch) this.releaseVisual(id, visual);
    }
    if (this.assets.arrowGradient) this.updateArrowGradient(timeSeconds);
  }

  /** Hit the currently displayed native sprite triangles, including flick arrows and marks. */
  pickNote(raycaster: Raycaster): NativeNoteHit | undefined {
    this.group.updateWorldMatrix(true, true);
    let selected: NativeNoteHit | undefined;
    let order = Number.NEGATIVE_INFINITY;
    for (const [id, visual] of this.visuals) {
      if (!visual.root.visible) continue;
      const parts = [
        [visual.body, "body"],
        [visual.decoration, "mark"],
        [visual.arrow, "arrow"],
      ] as const;
      for (const [mesh, part] of parts) {
        if (!mesh?.visible || mesh.renderOrder < order) continue;
        const opacity =
          mesh.material instanceof ShaderMaterial
            ? (mesh.material.uniforms.uOpacity?.value ?? 1)
            : mesh.material.opacity;
        if (opacity <= 0.001 || !mesh.material.colorWrite) continue;
        if (raycaster.intersectObject(mesh, false).length === 0) continue;
        selected = { id, part };
        order = mesh.renderOrder;
      }
    }
    return selected;
  }

  /** Each ArrowGradientAnimator starts its sweep when its note view is acquired. */
  private updateArrowGradient(timeSeconds: number): void {
    const gradient = this.assets.arrowGradient!;
    const cycle = Math.max(1e-4, gradient.durationSeconds + gradient.pauseSeconds);
    for (const visual of this.visuals.values()) {
      const material = visual.arrowGradientMaterial;
      if (!material) continue;
      if (timeSeconds < visual.gradientStartedAt) visual.gradientStartedAt = timeSeconds;
      const phase = (timeSeconds - visual.gradientStartedAt) % cycle;
      material.uniforms.uGradientOffset!.value = Math.min(1, phase / Math.max(1e-4, gradient.durationSeconds));
    }
  }

  private setSortOrder(visual: NoteVisual, ordinal: number): void {
    // The old allocate/dispose path used Object3D.id as Three's final stable
    // transparent-sort tie breaker. Pool reuse changes those ids, so retain
    // the same frame-note order explicitly with a sub-order far below the
    // next native sorting-order integer.
    const tieBreaker = ordinal * 0.000001;
    const noteOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.note + tieBreaker;
    if (visual.body.renderOrder !== noteOrder) {
      visual.body.renderOrder = noteOrder;
      if (visual.arrow) visual.arrow.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.noteArrow + tieBreaker;
      if (visual.decoration) {
        visual.decoration.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.noteDecoration + tieBreaker;
      }
    }
  }

  private descriptor(note: RenderNote): NoteDescriptor {
    const cached = this.descriptors.get(note.id);
    if (
      cached &&
      cached.kind === note.kind &&
      cached.lane === note.lane &&
      cached.width === note.width &&
      cached.direction === note.direction
    ) {
      return cached;
    }
    const skin = this.assets.source?.noteSkin ?? "skin001";
    const parts = selectNoteSkinParts(note, this.assets.tiltThresholds, skin);
    const arrowName = noteSkinArrowName(note, this.assets.source?.noteSkin ?? "skin001");
    const decorationName = noteSkinDecorationName(note.kind, skin);
    const descriptor: NoteDescriptor = {
      kind: note.kind,
      lane: note.lane,
      width: note.width,
      direction: note.direction,
      parts,
      signature: `${note.kind}:${parts.left.spriteName}:${parts.left.flipX ? 1 : 0}:${parts.right.spriteName}:${parts.right.flipX ? 1 : 0}:${arrowName ?? ""}:${decorationName ?? ""}`,
      decorationName,
      arrowName,
    };
    this.descriptors.set(note.id, descriptor);
    return descriptor;
  }

  private acquireVisual(note: RenderNote, descriptor: NoteDescriptor): NoteVisual {
    const pool = this.pools.get(descriptor.signature);
    const pooled = pool?.pop();
    if (pooled) {
      this.visualReuses += 1;
      pooled.root.name = `RenderNote:${String(note.id)}`;
      pooled.root.visible = true;
      return pooled;
    }
    const visual = this.createVisual(note, descriptor);
    this.visualAllocations += 1;
    this.meshAllocations += visual.materials.length;
    return visual;
  }

  private createVisual(note: RenderNote, descriptor: NoteDescriptor): NoteVisual {
    const { parts, signature, decorationName, arrowName } = descriptor;
    const root = new Group();
    root.name = `RenderNote:${String(note.id)}`;
    const materials: MeshBasicMaterial[] = [];

    // The three sliced main strips and both native cap meshes share one
    // geometry/material over the raw atlas. Simple endpoint Sprites must keep
    // their authored triangles: their packed textureRect is a tight crop and
    // a bounding quad samples neighboring atlas corners. Positions are filled
    // by layout(); UVs and the index are fixed for the visual's lifetime.
    const bodyGeometry = new BufferGeometry();
    const leftRegion = this.atlas?.region(parts.left.spriteName);
    const rightRegion = this.atlas?.region(parts.right.spriteName);
    const bodyCaps: [BodyCap, BodyCap] = [
      { region: leftRegion, mesh: leftRegion?.mesh, vertexOffset: MAIN_BODY_QUADS * 4 },
      {
        region: rightRegion,
        mesh: rightRegion?.mesh,
        vertexOffset: MAIN_BODY_QUADS * 4 + (leftRegion?.mesh?.positions.length ?? 4),
      },
    ];
    const bodyVertexCount =
      MAIN_BODY_QUADS * 4 + (leftRegion?.mesh?.positions.length ?? 4) + (rightRegion?.mesh?.positions.length ?? 4);
    const bodyPositions = new BufferAttribute(new Float32Array(bodyVertexCount * 3), 3);
    bodyPositions.setUsage(DynamicDrawUsage);
    const bodyUv = new BufferAttribute(new Float32Array(bodyVertexCount * 2), 2);
    const capIndexCount = bodyCaps.reduce((total, cap) => total + (cap.mesh?.indices.length ?? 6), 0);
    const bodyIndex = new Uint16Array(MAIN_BODY_QUADS * 6 + capIndexCount);
    for (let quad = 0; quad < MAIN_BODY_QUADS; quad += 1) {
      const base = quad * 4;
      const offset = quad * 6;
      bodyIndex[offset] = base;
      bodyIndex[offset + 1] = base + 1;
      bodyIndex[offset + 2] = base + 2;
      bodyIndex[offset + 3] = base;
      bodyIndex[offset + 4] = base + 2;
      bodyIndex[offset + 5] = base + 3;
    }
    const mainRegion = this.atlas?.region(parts.mainSpriteName);
    const mainSlices = mainRegion ? noteSkinTightHorizontalSlices(mainRegion) : undefined;
    const mainUvTransforms = [
      mainSlices ? this.atlas?.regionUvTransform(parts.mainSpriteName, mainSlices[0]) : undefined,
      mainSlices ? this.atlas?.regionUvTransform(parts.mainSpriteName, mainSlices[1]) : undefined,
      mainSlices ? this.atlas?.regionUvTransform(parts.mainSpriteName, mainSlices[2]) : undefined,
    ];
    const uvArray = bodyUv.array as Float32Array;
    for (let quad = 0; quad < MAIN_BODY_QUADS; quad += 1) {
      NoteLayer.bakeQuadUv(uvArray, quad * 8, mainUvTransforms[quad]);
    }
    const bodyCapUvTransforms = bodyCaps.map((cap, index) =>
      this.atlas?.regionUvTransform(index === 0 ? parts.left.spriteName : parts.right.spriteName),
    );
    for (let index = 0; index < bodyCaps.length; index += 1) {
      const cap = bodyCaps[index]!;
      const uvOffset = cap.vertexOffset * 2;
      const transform = bodyCapUvTransforms[index];
      if (cap.mesh && cap.region && transform) {
        NoteLayer.bakeNativeSpriteUv(uvArray, uvOffset, cap.mesh, cap.region, transform);
      } else {
        NoteLayer.bakeQuadUv(uvArray, uvOffset, transform);
      }
    }
    let indexOffset = MAIN_BODY_QUADS * 6;
    for (const cap of bodyCaps) {
      const base = cap.vertexOffset;
      if (cap.mesh) {
        for (const index of cap.mesh.indices) bodyIndex[indexOffset++] = base + index;
      } else {
        bodyIndex[indexOffset++] = base;
        bodyIndex[indexOffset++] = base + 1;
        bodyIndex[indexOffset++] = base + 2;
        bodyIndex[indexOffset++] = base;
        bodyIndex[indexOffset++] = base + 2;
        bodyIndex[indexOffset++] = base + 3;
      }
    }
    bodyUv.needsUpdate = true;
    bodyGeometry.setAttribute("position", bodyPositions);
    bodyGeometry.setAttribute("uv", bodyUv);
    bodyGeometry.setIndex(new BufferAttribute(bodyIndex, 1));

    const bodyMaterial = this.bodyMaterial();
    materials.push(bodyMaterial);
    const body = new Mesh(bodyGeometry, bodyMaterial);
    // A missing endpoint or main slice must not turn into the full atlas via
    // identity UVs. Keep the note closed until every native body part exists.
    body.visible =
      mainUvTransforms.every(Boolean) &&
      bodyCapUvTransforms.every(
        (transform, index) => Boolean(transform) || !(index === 0 ? parts.left.spriteName : parts.right.spriteName),
      );
    // Positions are rewritten by layout(); disable culling so a stale bounding
    // sphere never hides the note. Active notes are always in the view window.
    body.frustumCulled = false;
    body.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.note;
    root.add(body);

    let decoration: NoteVisual["decoration"];
    if (decorationName) {
      const material = this.material(decorationName);
      materials.push(material);
      decoration = new Mesh(this.spriteGeometry(decorationName), material);
      decoration.name = "note-mark";
      decoration.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.noteDecoration;
      root.add(decoration);
    }

    let arrow: NoteVisual["arrow"];
    let arrowGradientMaterial: NoteVisual["arrowGradientMaterial"];
    if (arrowName) {
      arrowGradientMaterial = this.arrowGradientMaterial(arrowName);
      const material: MeshBasicMaterial | ShaderMaterial = arrowGradientMaterial ?? this.material(arrowName);
      if (!arrowGradientMaterial) materials.push(material as MeshBasicMaterial);
      arrow = new Mesh(this.spriteGeometry(arrowName), material);
      arrow.name = "flick-arrow";
      arrow.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.noteArrow;
      root.add(arrow);
    }

    return {
      root,
      signature,
      materials,
      body,
      bodyPositions,
      bodyCaps,
      decoration,
      arrow,
      arrowLayout: arrow ? { centerX: 0, centerY: 0, width: 0, height: 0, rotation: 0, alpha: 1 } : undefined,
      arrowGradientMaterial,
      gradientStartedAt: 0,
      parts,
      decorationName,
      arrowName,
      lastSeen: 0,
      layoutWidth: Number.NaN,
      layoutScale: Number.NaN,
      lastAlpha: Number.NaN,
    };
  }

  /** One shared material over the raw atlas; regions are selected by baked UVs. */
  private bodyMaterial(): MeshBasicMaterial {
    if (this.atlas) {
      const material = new MeshBasicMaterial({
        map: this.atlas.texture,
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: NormalBlending,
        side: DoubleSide,
        toneMapped: false,
      });
      material.forceSinglePass = true;
      return material;
    }
    const material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
    });
    material.forceSinglePass = true;
    return material;
  }

  /**
   * Build a Simple Sprite geometry from the authored native mesh. Overlay
   * meshes keep normalized tight-crop UVs because their material owns the
   * atlas region transform. The shared PlaneGeometry remains a compatibility
   * fallback for projections that predate inline mesh metadata.
   */
  private spriteGeometry(spriteName: string): BufferGeometry {
    const region = this.atlas?.region(spriteName);
    const mesh = region?.mesh;
    if (!region || !mesh) return this.plane;
    const bounds = noteSkinSpriteBounds(region);
    const geometry = new BufferGeometry();
    const positions = new BufferAttribute(new Float32Array(mesh.positions.length * 3), 3);
    const uv = new BufferAttribute(new Float32Array(mesh.positions.length * 2), 2);
    const positionArray = positions.array as Float32Array;
    const uvArray = uv.array as Float32Array;
    mesh.positions.forEach((position, index) => {
      // Keep the common overlay layout in charge of scale, pivot and rotation.
      positionArray[index * 3] = (position[0] - bounds.centerX) / bounds.width;
      positionArray[index * 3 + 1] = (position[1] - bounds.centerY) / bounds.height;
      positionArray[index * 3 + 2] = position[2];
      NoteLayer.bakeTightSpriteUv(uvArray, index * 2, position, region);
    });
    geometry.setAttribute("position", positions);
    geometry.setAttribute("uv", uv);
    geometry.setIndex(new BufferAttribute(new Uint16Array(mesh.indices), 1));
    return geometry;
  }

  /** Convert native Sprite-unit coordinates into normalized tight-crop UVs. */
  private static bakeTightSpriteUv(
    uv: Float32Array,
    offset: number,
    position: readonly [number, number, number],
    region: SpriteRegion,
  ): void {
    const tightWidth = region.packingRotation === 4 ? region.rect.height : region.rect.width;
    const tightHeight = region.packingRotation === 4 ? region.rect.width : region.rect.height;
    const sourceX = position[0] * region.pixelsToUnits + region.pivot.x * region.sourceSize.width;
    const sourceY = position[1] * region.pixelsToUnits + region.pivot.y * region.sourceSize.height;
    uv[offset] = Math.max(0, Math.min(1, (sourceX - region.offset.x) / Math.max(1e-6, tightWidth)));
    uv[offset + 1] = Math.max(0, Math.min(1, (sourceY - region.offset.y) / Math.max(1e-6, tightHeight)));
  }

  /** Bake one native cap mesh into atlas UVs for the shared body material. */
  private static bakeNativeSpriteUv(
    uv: Float32Array,
    offset: number,
    mesh: SpriteMesh,
    region: SpriteRegion,
    transform: { a: number; b: number; c: number; d: number; e: number; f: number },
  ): void {
    const tightUv = new Float32Array(2);
    mesh.positions.forEach((position, index) => {
      NoteLayer.bakeTightSpriteUv(tightUv, 0, position, region);
      uv[offset + index * 2] = transform.a * tightUv[0]! + transform.b * tightUv[1]! + transform.e;
      uv[offset + index * 2 + 1] = transform.c * tightUv[0]! + transform.d * tightUv[1]! + transform.f;
    });
  }

  /** Write one body quad's four baked UV corners for base uv (0,0)(1,0)(1,1)(0,1). */
  private static bakeQuadUv(
    uv: Float32Array,
    offset: number,
    transform: { a: number; b: number; c: number; d: number; e: number; f: number } | undefined,
  ): void {
    if (!transform) {
      uv[offset] = 0;
      uv[offset + 1] = 0;
      uv[offset + 2] = 1;
      uv[offset + 3] = 0;
      uv[offset + 4] = 1;
      uv[offset + 5] = 1;
      uv[offset + 6] = 0;
      uv[offset + 7] = 1;
      return;
    }
    const { a, b, c, d, e, f } = transform;
    uv[offset] = e;
    uv[offset + 1] = f;
    uv[offset + 2] = a + e;
    uv[offset + 3] = c + f;
    uv[offset + 4] = a + b + e;
    uv[offset + 5] = c + d + f;
    uv[offset + 6] = b + e;
    uv[offset + 7] = d + f;
  }

  /** Write one body quad's four vertex positions from a center and a size. */
  private static bakeQuadPositions(
    positions: Float32Array,
    offset: number,
    centerX: number,
    centerY: number,
    sizeX: number,
    sizeY: number,
  ): void {
    const halfX = sizeX / 2;
    const halfY = sizeY / 2;
    positions[offset] = centerX - halfX;
    positions[offset + 1] = centerY - halfY;
    positions[offset + 2] = 0;
    positions[offset + 3] = centerX + halfX;
    positions[offset + 4] = centerY - halfY;
    positions[offset + 5] = 0;
    positions[offset + 6] = centerX + halfX;
    positions[offset + 7] = centerY + halfY;
    positions[offset + 8] = 0;
    positions[offset + 9] = centerX - halfX;
    positions[offset + 10] = centerY + halfY;
    positions[offset + 11] = 0;
  }

  /**
   * Skin003 brightness sweep, with a minimum alpha and separate band widths
   * for upper and directional arrows.
   */
  private arrowGradientMaterial(spriteName: string): ShaderMaterial | undefined {
    const gradient = this.assets.arrowGradient;
    const directional = spriteName.includes("_left_") || spriteName.includes("_right_");
    if (!gradient || !spriteName.startsWith("notes_flick_arrow_")) return undefined;
    const settings = directional ? gradient.directional : gradient.center;
    const transform = this.atlas?.regionUvTransform(spriteName);
    const map = this.atlas?.createTexture(spriteName);
    if (!transform || !map) return undefined;
    const region = this.atlas?.region(spriteName);
    let uvMin = Number.POSITIVE_INFINITY;
    let uvMax = Number.NEGATIVE_INFINITY;
    const vertices = region?.mesh?.positions;
    if (region && vertices) {
      const tightUv = new Float32Array(2);
      for (const position of vertices) {
        NoteLayer.bakeTightSpriteUv(tightUv, 0, position, region);
        const u = transform.a * tightUv[0]! + transform.b * tightUv[1]! + transform.e;
        uvMin = Math.min(uvMin, u);
        uvMax = Math.max(uvMax, u);
      }
    } else {
      const corners = [
        transform.e,
        transform.a + transform.e,
        transform.b + transform.e,
        transform.a + transform.b + transform.e,
      ];
      uvMin = Math.min(...corners);
      uvMax = Math.max(...corners);
    }
    const material = new ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uUvTransform: {
          value: new Matrix3().set(
            transform.a,
            transform.b,
            transform.e,
            transform.c,
            transform.d,
            transform.f,
            0,
            0,
            1,
          ),
        },
        uGradientOffset: { value: 1 },
        uBandWidth: { value: settings.bandWidth },
        uMinAlpha: { value: settings.minAlpha },
        uUvMin: { value: uvMin },
        uUvRange: { value: uvMax - uvMin },
        uDirectional: { value: directional ? 1 : 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform mat3 uUvTransform;
        uniform float uGradientOffset;
        uniform float uBandWidth;
        uniform float uMinAlpha;
        uniform float uUvMin;
        uniform float uUvRange;
        uniform float uDirectional;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          vec2 atlasUv = (uUvTransform * vec3(vUv, 1.0)).xy;
          vec4 texel = texture2D(uMap, atlasUv);
          float across = fract((atlasUv.x - uUvMin) / (uUvRange > 0.0001 ? uUvRange : 1.0));
          float distance = uDirectional > 0.5
            ? abs(across - uGradientOffset)
            : abs(abs(across - 0.5) - uGradientOffset * 0.5);
          float band = 1.0 - clamp(distance / uBandWidth, 0.0, 1.0);
          float alpha = (band * (1.0 - uMinAlpha) + uMinAlpha) * texel.a * uOpacity;
          gl_FragColor = vec4(texel.rgb * alpha, alpha);
        }
      `,
      transparent: true,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    material.forceSinglePass = true;
    return material;
  }

  private material(spriteName: string): MeshBasicMaterial {
    const atlasMaterial = this.atlas?.createMaterial(spriteName);
    if (atlasMaterial) {
      atlasMaterial.side = DoubleSide;
      atlasMaterial.blending = NormalBlending;
      atlasMaterial.forceSinglePass = true;
      return atlasMaterial;
    }
    const material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
    });
    material.forceSinglePass = true;
    return material;
  }

  private spriteBounds(spriteName: string | undefined): NoteSkinSpriteBounds | undefined {
    if (spriteName === undefined) return undefined;
    // A null native cap reference leaves that endpoint SpriteRenderer empty.
    if (spriteName === "") return { width: 0, height: 0, centerX: 0, centerY: 0 };
    const cached = this.bounds.get(spriteName);
    if (cached) return cached;
    const region = this.atlas?.region(spriteName);
    if (!region) return undefined;
    const bounds = noteSkinSpriteBounds(region);
    this.bounds.set(spriteName, bounds);
    return bounds;
  }

  /** Place an authored Simple Sprite mesh in the same pivot frame as Unity. */
  private static bakeNativeSpritePositions(
    positions: Float32Array,
    offset: number,
    mesh: SpriteMesh,
    bounds: NoteSkinSpriteBounds,
    centerX: number,
    centerY: number,
    scale: number,
    flipX: boolean,
  ): void {
    const sourceCenterX = (flipX ? -bounds.centerX : bounds.centerX) * scale;
    const sourceCenterY = bounds.centerY * scale;
    const originX = centerX - sourceCenterX;
    const originY = centerY - sourceCenterY;
    mesh.positions.forEach((position, index) => {
      const x = flipX ? -position[0] : position[0];
      positions[offset + index * 3] = originX + x * scale;
      positions[offset + index * 3 + 1] = originY + position[1] * scale;
      positions[offset + index * 3 + 2] = position[2] * scale;
    });
  }

  private layout(visual: NoteVisual, note: RenderNote, timeSeconds: number): void {
    const scale = Math.max(0.05, note.scale ?? 1);
    const layoutChanged = visual.layoutWidth !== note.width || visual.layoutScale !== scale;
    if (layoutChanged) {
      const viewWidth = this.projector.widthToWorld(note.width) * scale;
      const leftBounds = this.spriteBounds(visual.parts.left.spriteName);
      const rightBounds = this.spriteBounds(visual.parts.right.spriteName);
      const mainBounds = this.spriteBounds(visual.parts.mainSpriteName);
      const mainRegion = this.atlas?.region(visual.parts.mainSpriteName);
      const bodyLayout =
        leftBounds && rightBounds && mainBounds && mainRegion
          ? layoutNoteSkinBody({
              parts: visual.parts,
              leftBounds,
              rightBounds,
              mainBounds,
              mainRegion,
              viewWidth,
              scale,
            })
          : undefined;
      if (!bodyLayout) {
        visual.body.visible = false;
      } else if (visual.body.visible) {
        const positions = visual.bodyPositions.array as Float32Array;
        const mainQuads = [bodyLayout.mainLeft, bodyLayout.mainMiddle, bodyLayout.mainRight];
        mainQuads.forEach((quad, index) => {
          NoteLayer.bakeQuadPositions(positions, index * 12, quad.centerX, quad.centerY, quad.width, quad.height);
        });
        const capQuads = [bodyLayout.left, bodyLayout.right] as const;
        const capBounds = [leftBounds, rightBounds] as const;
        const capFlips = [visual.parts.left.flipX, visual.parts.right.flipX] as const;
        capQuads.forEach((quad, index) => {
          const cap = visual.bodyCaps[index]!;
          const bounds = capBounds[index]!;
          const offset = cap.vertexOffset * 3;
          if (cap.mesh) {
            NoteLayer.bakeNativeSpritePositions(
              positions,
              offset,
              cap.mesh,
              bounds,
              quad.centerX,
              quad.centerY,
              scale,
              capFlips[index],
            );
          } else {
            NoteLayer.bakeQuadPositions(positions, offset, quad.centerX, quad.centerY, quad.width, quad.height);
          }
        });
        visual.bodyPositions.needsUpdate = true;
        // Mesh.raycast uses this bound; a previous width must not hide a resized note.
        visual.body.geometry.boundingSphere = null;
      }

      visual.layoutWidth = note.width;
      visual.layoutScale = scale;
    }

    if (visual.decoration) {
      const presentation = resolveEaseNoteMarkPresentation(note.kind, note.critical === true, this.isShowEaseNote);
      if (layoutChanged || visual.lastEaseMarkEmphasized !== presentation.emphasized) {
        const bounds = this.spriteBounds(visual.decorationName);
        visual.decoration.visible = Boolean(bounds && presentation.hasMark);
        if (bounds && presentation.hasMark) {
          // The mark's sprite pivot offset is part of its local geometry, so
          // doubling the native local scale doubles both its bounds and centre.
          const layout = layoutNoteSkinDecoration(bounds, scale * presentation.scaleMultiplier);
          visual.decoration.scale.set(layout.width, layout.height, presentation.scaleMultiplier);
          visual.decoration.position.set(layout.centerX, layout.centerY, 0);
        }
        visual.decoration.material.color.setHex(presentation.color);
        visual.lastEaseMarkEmphasized = presentation.emphasized;
      }
    }

    const alpha = Math.max(0, Math.min(1, note.alpha ?? 1));
    if (visual.lastAlpha !== alpha) {
      for (const material of visual.materials) material.opacity = alpha;
      if (visual.arrowGradientMaterial) visual.arrowGradientMaterial.uniforms.uOpacity!.value = alpha;
      visual.lastAlpha = alpha;
    }
    if (visual.arrow) {
      const bounds = this.spriteBounds(visual.arrowName);
      visual.arrow.visible = Boolean(bounds && visual.arrowName);
      if (bounds && visual.arrowName) {
        const layout = layoutNoteSkinArrow(
          visual.arrowName,
          noteSkinEffectiveDirection(note),
          bounds,
          scale,
          this.assets.source?.noteSkin ?? "skin001",
          timeSeconds,
          visual.arrowLayout,
        );
        visual.arrow.scale.set(layout.width, layout.height, 1);
        visual.arrow.rotation.z = layout.rotation;
        visual.arrow.position.set(layout.centerX, layout.centerY, 0);
        if (visual.arrowGradientMaterial) visual.arrowGradientMaterial.uniforms.uOpacity!.value = alpha * layout.alpha;
        else visual.arrow.material.opacity = alpha * layout.alpha;
      }
    }
    // LiveNoteViewBase.UpdateView multiplies every component of Vector3.one by
    // the converted view progress before Transform.set_localScale. Width is
    // already authored at judgement size.
    const viewProgress = this.projector.viewProgress(note.approach);
    visual.root.scale.setScalar(viewProgress);
    this.projector.pointAtViewProgress(note.lane, note.width, viewProgress, 0, visual.root.position);
    visual.root.visible = alpha > 0.001 && visual.body.visible;
  }

  private releaseVisual(id: RenderNote["id"], visual: NoteVisual): void {
    this.group.remove(visual.root);
    visual.root.visible = false;
    this.visuals.delete(id);
    const pool = this.pools.get(visual.signature);
    if (pool) pool.push(visual);
    else this.pools.set(visual.signature, [visual]);
    this.visualReleases += 1;
  }

  private disposeVisual(visual: NoteVisual): void {
    visual.body.geometry.dispose();
    if (visual.decoration && visual.decoration.geometry !== this.plane) visual.decoration.geometry.dispose();
    if (visual.arrow && visual.arrow.geometry !== this.plane) visual.arrow.geometry.dispose();
    for (const material of visual.materials) {
      if (material.map && this.atlas) this.atlas.releaseMaterial(material);
      else material.dispose();
    }
    if (visual.arrowGradientMaterial) visual.arrowGradientMaterial.dispose();
  }

  private destroyVisuals(): void {
    for (const visual of this.visuals.values()) this.disposeVisual(visual);
    this.visuals.clear();
    for (const pool of this.pools.values()) {
      for (const visual of pool) this.disposeVisual(visual);
    }
    this.pools.clear();
    this.group.clear();
  }

  get stats(): {
    activeVisuals: number;
    pooledVisuals: number;
    visualAllocations: number;
    visualReuses: number;
    visualReleases: number;
    meshAllocations: number;
    cachedDescriptors: number;
    cachedBounds: number;
  } {
    let pooledVisuals = 0;
    for (const pool of this.pools.values()) pooledVisuals += pool.length;
    return {
      activeVisuals: this.visuals.size,
      pooledVisuals,
      visualAllocations: this.visualAllocations,
      visualReuses: this.visualReuses,
      visualReleases: this.visualReleases,
      meshAllocations: this.meshAllocations,
      cachedDescriptors: this.descriptors.size,
      cachedBounds: this.bounds.size,
    };
  }

  dispose(): void {
    this.destroyVisuals();
    this.descriptors.clear();
    this.bounds.clear();
    this.plane.dispose();
  }
}
