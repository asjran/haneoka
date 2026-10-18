import type { NativeIntroAssembly } from "./NativeIntroAssembler";
import {
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  NoColorSpace,
  ShaderMaterial,
  Texture,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  VideoTexture,
  WebGLRenderer,
} from "three";
import type { Object3D, WebGLRenderTarget } from "three";
import { OUR_NOTES_LIVE_GEOMETRY } from "@haneoka/cassiopeia-plugin-our-notes";
import { SpriteAtlas } from "../assets/SpriteAtlas";
import { dynamicCanvasFrameChanged, refreshDynamicCanvasTexture } from "./backgroundMedia";
import { HoldRibbonLayer } from "./HoldRibbon";
import { HudLayer } from "./HudLayer";
import { liveEffectFrameAction, LiveUrpBloomPipeline, LiveGameCompositor, liveEffectFrameIndex } from "./LiveUrpBloom";
import { NoteLayer } from "./NoteLayer";
import { ParticleLayer } from "./ParticleLayer";
import { OverlayLayer } from "./OverlayLayer";
import { SimultaneousLineLayer } from "./SimultaneousLineLayer";
import { OurNotesStage, ScreenLaneBackdrop, StageProjector } from "./stageGeometry";
import {
  nativeNoteViewAtCanvasPoint,
  projectNativeNoteView,
  type NativeChartPresentation,
  type NativeChartViewport,
  type NativeNoteHit,
  type NativeNoteViewPoint,
  type NativeNoteViewProjection,
} from "./presentation";
import {
  isRenderLaneEffectKind,
  type OurNotesRendererOptions as PortableRendererOptions,
  type OurNotesRendererStats,
  type RenderFrame,
  type RenderNote,
} from "@haneoka/cassiopeia-plugin-our-notes";

export type OurNotesRendererOptions = PortableRendererOptions<HTMLCanvasElement>;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export interface RotatedContentSpace {
  hostLeft: number;
  hostTop: number;
  hostWidth: number;
  hostHeight: number;
  contentWidth: number;
  contentHeight: number;
  angleRadians: number;
}

/** Invert the centered CSS rotation used by RotatableViewport. */
export function clientPointInRotatedContent(
  clientX: number,
  clientY: number,
  space: RotatedContentSpace,
): { x: number; y: number } {
  const cos = Math.cos(space.angleRadians);
  const sin = Math.sin(space.angleRadians);
  const deltaX = clientX - (space.hostLeft + space.hostWidth / 2);
  const deltaY = clientY - (space.hostTop + space.hostHeight / 2);
  return {
    x: cos * deltaX + sin * deltaY + space.contentWidth / 2,
    y: -sin * deltaX + cos * deltaY + space.contentHeight / 2,
  };
}

/** Configure the LiveGameCamera after Unity +Z -> Three -Z reflection. */
export function configureOurNotesCamera(camera: PerspectiveCamera): PerspectiveCamera {
  camera.position.fromArray(OUR_NOTES_LIVE_GEOMETRY.cameraPosition);
  const pitch = (OUR_NOTES_LIVE_GEOMETRY.cameraXDegrees * Math.PI) / 180;
  const forward = new Vector3(0, -Math.sin(pitch), -Math.cos(pitch));
  camera.lookAt(camera.position.clone().add(forward.multiplyScalar(100)));
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * Rendering adapter for the original Our Notes live scene. Simulation and
 * judgement stay outside Three.js and enter as synchronously consumed RenderFrame DTOs.
 */
export class OurNotesRenderer implements NativeChartPresentation {
  readonly scene = new Scene();
  private nativeIntro?: NativeIntroAssembly;
  private nativeIntroActive = false;
  private nativeIntroSeconds = 0;
  private nativeIntroLaneVisible = true;
  private nativeTapFadeDuration?: number;
  private nativeTapFadeStart?: number;
  private nativeTapFadeReserved = false;
  readonly camera: PerspectiveCamera;
  readonly projector: StageProjector;
  readonly renderer: WebGLRenderer;
  readonly assetErrors: Error[] = [];

  private readonly options: OurNotesRendererOptions;
  private readonly stage: OurNotesStage;
  private readonly screenLane: ScreenLaneBackdrop;
  private readonly holds: HoldRibbonLayer;
  private readonly simultaneousLines: SimultaneousLineLayer;
  private readonly notes: NoteLayer;
  private readonly particles: ParticleLayer;
  private readonly overlays = new OverlayLayer();
  private readonly overlayProjection = new Matrix4();
  private readonly stageCoordinateReflection = new Matrix4().makeScale(1, 1, -1);
  private readonly effectScene = new Scene();
  private readonly liveBloom: LiveUrpBloomPipeline;
  private readonly gameCompositor = new LiveGameCompositor();
  private readonly gammaMaterials = new WeakSet<MeshBasicMaterial>();
  private readonly gammaTextures = new WeakSet<Texture>();
  private readonly onNoteVisualAdded = (event: { child: Object3D }): void => {
    this.configureGammaMaterials(event.child);
  };
  private readonly drawEffectScene = (): void => this.renderer.render(this.effectScene, this.camera);
  private readonly drawGameScene = (): void => {
    this.renderer.render(this.screenLane.scene, this.screenLane.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  };
  private readonly drawMainBackground = (): void =>
    this.renderer.render(this.screenLane.backgroundScene, this.screenLane.camera);
  private readonly compositeEffects = (target: WebGLRenderTarget): void =>
    this.liveBloom.composite(this.renderer, target);
  private readonly drawMainUnderlays = (): void => {
    if (this.overlays.underlayCount) this.renderer.render(this.overlays.underlay, this.overlays.screenCamera);
  };
  private readonly screenRoot = new Group();
  private readonly hud?: HudLayer;
  private atlas?: SpriteAtlas;
  private backgroundTexture?: Texture;
  private backgroundCanvas?: HTMLCanvasElement;
  private backgroundCanvasWidth = 0;
  private backgroundCanvasHeight = 0;
  private backgroundCanvasVersion?: number;
  private uploadedBackgroundCanvasVersion?: number;
  private loadPromise?: Promise<void>;
  private assetsReady = false;
  private contextLost = false;
  private disposed = false;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private sized = false;
  private counts = { notes: 0, holds: 0, particleEffects: 0 };
  private readonly laneProjectionLeft = new Vector3();
  private readonly laneProjectionRight = new Vector3();
  private laneProjectionLeftNdcX = -1;
  private laneProjectionRightNdcX = 1;
  private readonly drawingBufferSize = new Vector2();
  private readonly noteRaycaster = new Raycaster();
  private readonly notePointer = new Vector2();
  private lastEffectFrame = -1;
  private effectCacheActive = false;
  private particleStateActive = false;
  private backgroundLoadRevision = 0;
  private effectRefreshed = false;

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.renderer.resetState();
    this.liveBloom.invalidate();
    this.effectCacheActive = false;
    this.lastEffectFrame = -1;
  };

  constructor(options: OurNotesRendererOptions) {
    this.options = options;
    const assets = options.assets;
    this.liveBloom = new LiveUrpBloomPipeline(assets.liveQuality?.effectRenderingScale, assets.liveQuality?.quality);
    this.projector = new StageProjector({
      laneCount: options.laneCount,
      stageWidth: options.stageWidth,
      judgementZ: options.judgementZ,
      horizonZ: options.horizonZ,
      spawnY: options.spawnY,
    });

    this.camera = new PerspectiveCamera(
      OUR_NOTES_LIVE_GEOMETRY.cameraFovDegrees,
      1,
      OUR_NOTES_LIVE_GEOMETRY.cameraNear,
      OUR_NOTES_LIVE_GEOMETRY.cameraFar,
    );
    configureOurNotesCamera(this.camera);
    this.camera.add(this.screenRoot);
    // Unity's camera looks along local +Z, while Three.js looks along -Z.
    // Transform_203.asset is otherwise reproduced verbatim as a camera child.
    this.screenRoot.name = "OurNotesScreenRoot";
    this.screenRoot.position.set(0, 0, -OUR_NOTES_LIVE_GEOMETRY.screenRootZ);
    this.camera.updateMatrixWorld(true);

    this.renderer = new WebGLRenderer({
      canvas: options.canvas,
      // The output framebuffer receives a full-screen copy only. Native game
      // geometry has its own samples=0 target and effects use their FXAA pass.
      antialias: options.antialias ?? false,
      alpha: options.alpha ?? true,
      powerPreference: "high-performance",
      premultipliedAlpha: true,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Accumulate diagnostics across the base, effect and composite passes.
    // The default auto reset would report only the final pass.
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(new Color(options.backgroundColor ?? "#030816"), options.backgroundAlpha ?? 0);

    this.stage = new OurNotesStage(this.projector, assets);
    this.screenLane = new ScreenLaneBackdrop();
    this.holds = new HoldRibbonLayer(this.projector, assets);
    this.simultaneousLines = new SimultaneousLineLayer(this.projector);
    this.notes = new NoteLayer(this.projector, assets);
    this.notes.group.addEventListener("childadded", this.onNoteVisualAdded);
    this.configureGammaMaterials(this.stage.group);
    // Lane tint is authored as native Gamma floats rather than a hex color.
    this.configureGammaMaterials(this.screenLane.scene, false);
    this.configureGammaMaterials(this.screenLane.backgroundScene);
    this.particles = new ParticleLayer(this.projector, assets, options.maxParticleEffects, options.particlesPerEffect);
    this.screenRoot.add(this.holds.group, this.simultaneousLines.group, this.notes.group);
    this.scene.add(this.camera, this.stage.group, this.particles.laneInputGroup, this.overlays.game);
    // LiveEffectCamera.asset is a separate layer-29 HDR camera with URP post
    // processing. Its Transform_131 is an identity child of LiveGameCamera,
    // so rendering the effectScene through this exact same camera preserves
    // the native view/projection without any screenshot-derived offset.
    // Keeping particles out of the layer-25 base scene prevents Bloom from
    // affecting the stage, notes, holds, WebGL background or HUD.
    this.effectScene.add(this.particles.group, this.overlays.effects);
    this.renderer.autoClear = false;
    if (options.hudCanvas) this.hud = new HudLayer(options.hudCanvas, assets);

    options.canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    options.canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
    const initialWidth = Math.max(1, options.canvas.clientWidth || options.canvas.width || 1);
    const initialHeight = Math.max(1, options.canvas.clientHeight || options.canvas.height || 1);
    this.resize(initialWidth, initialHeight, options.pixelRatio);
  }

  /** Idempotently load prepared runtime resources. Missing visual media is omitted. */
  load(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("OurNotesRenderer is disposed"));
    if (!this.loadPromise) this.loadPromise = this.loadAssets();
    return this.loadPromise;
  }

  /** Surface native-resource failures without substituting unrelated visuals. */
  reportAssetError(reason: unknown): Error {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.assetErrors.push(error);
    globalThis.console?.warn?.("[OurNotesRenderer] Native asset omitted", error);
    return error;
  }

  /** Copy the current positive-Z stage-world projection into a caller-owned column-major matrix. */
  copyStageWorldToClip(target: Float64Array): void {
    if (target.length !== 16) throw new Error("Stage projection requires a 4x4 matrix");
    this.camera.updateMatrixWorld(true);
    this.overlayProjection
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(this.stageCoordinateReflection);
    target.set(this.overlayProjection.elements);
  }

  /** A seek or presentation replacement may change geometry inside the same cached effect frame. */
  invalidateEffectFrame(): void {
    this.liveBloom.invalidate();
    this.effectCacheActive = false;
    this.lastEffectFrame = -1;
  }

  /** Toggle the optional critical/ease-note mark treatment. Disabled by default. */
  setShowEaseNote(showEaseNote = false): void {
    if (this.disposed) return;
    this.notes.setShowEaseNote(showEaseNote);
  }

  async loadOverlayTextures(
    manifest: Readonly<Record<string, import("@haneoka/cassiopeia-plugin-our-notes").RenderOverlayTexture>>,
  ): Promise<void> {
    await this.overlays.load(manifest);
  }

  private async loadAssets(): Promise<void> {
    const assets = this.options.assets;
    const results = await Promise.allSettled([
      SpriteAtlas.load(assets.noteAtlas),
      this.screenLane.loadTexture(assets),
      this.stage.loadTextures(assets),
      this.holds.loadTexture(),
      this.particles.loadTextures(),
      this.hud?.loadAssets() ?? Promise.resolve(),
      this.overlays.load(this.options.overlayTextures ?? {}),
      this.hud?.loadOverlayFonts(this.options.overlayFonts ?? {}) ?? Promise.resolve(),
    ]);
    if (this.disposed) {
      if (results[0].status === "fulfilled") results[0].value.dispose();
      return;
    }
    if (results[0].status === "fulfilled") {
      this.notes.setAtlas(undefined);
      this.atlas?.dispose();
      this.atlas = results[0].value;
      this.configureGammaTexture(this.atlas.texture);
      this.notes.setAtlas(this.atlas);
    }
    for (const result of results) {
      if (result.status === "rejected") this.reportAssetError(result.reason);
    }
    // Texture assignments complete asynchronously after constructor registration.
    this.configureGammaMaterials(this.stage.group);
    this.configureGammaMaterials(this.screenLane.scene, false);
    this.configureGammaMaterials(this.screenLane.backgroundScene);
    this.assetsReady = true;
    // A paused frame may stay in one native 30-fps bucket while the decoded
    // effect assets arrive. Force that bucket to be rendered again.
    this.liveBloom.invalidate();
    this.effectCacheActive = false;
  }

  /** Native Gamma textures sample their stored bytes, including bilinear interpolation. */
  private configureGammaTexture(texture: Texture | null | undefined): void {
    if (!texture || this.gammaTextures.has(texture)) return;
    this.gammaTextures.add(texture);
    if (texture.colorSpace !== NoColorSpace) {
      texture.colorSpace = NoColorSpace;
      texture.needsUpdate = true;
    }
  }

  /** Register only this player's materials; preserve each known tint's input domain. */
  private configureGammaMaterials(root: Object3D, colorFromHex = true): void {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material instanceof MeshBasicMaterial) this.configureGammaTexture(material.map);
        else if (material instanceof ShaderMaterial) {
          for (const uniform of Object.values(material.uniforms)) {
            if (uniform.value instanceof Texture) this.configureGammaTexture(uniform.value);
          }
        }
        if (!(material instanceof MeshBasicMaterial) || this.gammaMaterials.has(material)) continue;
        this.gammaMaterials.add(material);
        // Three decodes hex inputs on construction. Native float tints already
        // carry Gamma values; converting those would brighten the lane again.
        if (colorFromHex) material.color.convertLinearToSRGB();
        const previousCompile = material.onBeforeCompile;
        const previousKey = material.customProgramCacheKey();
        material.onBeforeCompile = (shader, renderer) => {
          previousCompile.call(material, shader, renderer);
          // Game materials now sample and blend in Gamma directly. The final
          // screen copy also preserves those values without another encoding.
          shader.fragmentShader = shader.fragmentShader.replace("#include <colorspace_fragment>", "");
        };
        material.customProgramCacheKey = () => `${previousKey}:our-notes-game-gamma-v2`;
        material.needsUpdate = true;
      }
    });
  }

  configureNativeIntroTapFade(duration: number, ease: number): void {
    if (!Number.isFinite(duration) || duration <= 0 || ease !== 2)
      throw new Error("Unsupported original tap-area fade parameters");
    this.nativeTapFadeDuration = duration;
  }

  attachNativeIntro(intro: NativeIntroAssembly): void {
    this.nativeIntro?.dispose();
    this.nativeIntro = intro;
    this.scene.add(intro.game);
    this.effectScene.add(intro.effects);
    if (this.nativeTapFadeDuration === undefined) throw new Error("Original tap-area fade data missing");
    this.nativeTapFadeReserved = true;
    this.nativeTapFadeStart = undefined;
    this.stage.setTapAnimationAlpha(0);
    this.nativeIntroActive = true;
    this.nativeIntroSeconds = 0;
  }

  sampleNativeIntro(seconds: number, bypass = false): void {
    if (!this.nativeIntro) return;
    this.camera.updateMatrixWorld(true);
    if (bypass) this.nativeIntro.bypass(this.camera);
    else this.nativeIntro.advance(seconds, this.camera);
    if (bypass) {
      this.nativeTapFadeReserved = false;
      this.nativeTapFadeStart = undefined;
      this.stage.setTapAnimationAlpha(1);
    } else if (this.nativeTapFadeStart !== undefined) {
      const age = Math.max(0, this.nativeIntro.evaluationSeconds - this.nativeTapFadeStart);
      const progress = Math.min(1, age / this.nativeTapFadeDuration!);
      this.stage.setTapAnimationAlpha(1 - Math.cos((progress * Math.PI) / 2));
    }
    this.nativeIntroSeconds = seconds;
    this.nativeIntroActive = !bypass && seconds < this.nativeIntro.timeline.duration;
  }

  setNativeIntroLaneVisible(visible: boolean): void {
    if (visible && !this.nativeIntroLaneVisible && this.nativeTapFadeReserved && this.nativeIntro) {
      this.nativeTapFadeStart = this.nativeIntro.evaluationSeconds;
      this.nativeTapFadeReserved = false;
    }
    this.nativeIntroLaneVisible = visible;
  }

  setNativeIntroBackgroundScale(scale: readonly [number, number, number]): void {
    this.screenLane.setBackgroundScale(scale[0], scale[1]);
  }

  render(frame: RenderFrame): void {
    if (this.disposed || this.contextLost) return;
    this.refreshBackgroundCanvas();
    this.renderer.info.reset();
    this.stage.update(frame.stage);
    this.stage.group.visible = !this.nativeIntroActive || this.nativeIntroLaneVisible;
    this.screenLane.scene.visible = !this.nativeIntroActive || this.nativeIntroLaneVisible;
    this.screenRoot.visible = !this.nativeIntroActive;
    this.screenLane?.setOpacity(frame.stage?.laneOpacity ?? 1);
    this.screenLane?.setBackgroundBrightness(frame.stage?.backgroundBrightness ?? 0.7);
    this.holds.update(frame.holds, frame.time);
    this.simultaneousLines.update(frame.simultaneousLines);
    this.notes.update(frame.notes, frame.time);
    this.particles.updateLaneInput(frame.particles);
    this.overlays.update(frame.overlays);
    const particleEffectCount = frame.particles?.length ?? 0;
    let noteParticleEffectCount = 0;
    for (const effect of frame.particles ?? []) if (!isRenderLaneEffectKind(effect.kind)) noteParticleEffectCount += 1;
    const effectAction = liveEffectFrameAction(
      noteParticleEffectCount + this.overlays.effectsCount,
      this.particleStateActive,
      this.effectCacheActive,
      this.lastEffectFrame,
      frame.time,
    );
    const introEffectFrame = liveEffectFrameIndex(this.nativeIntroSeconds);
    const activeEffectAction = this.nativeIntroActive
      ? introEffectFrame !== this.lastEffectFrame || !this.effectCacheActive
        ? "refresh"
        : "reuse"
      : effectAction;
    this.effectRefreshed = activeEffectAction === "refresh";
    if (activeEffectAction === "refresh") {
      const nativeEffectFrame = liveEffectFrameIndex(this.nativeIntroActive ? this.nativeIntroSeconds : frame.time);
      // FullInitialize overrides the serialized effect camera rate to 60 fps.
      // Absolute-age particles and the HDR output are reused within one such
      // bucket; paused frames therefore preserve the finished effect image.
      this.particles.update(frame.particles);
      this.particleStateActive = true;
      this.camera.updateMatrixWorld(true);
      this.liveBloom.renderEffect(this.renderer, this.drawEffectScene);
      this.effectCacheActive = true;
      this.lastEffectFrame = nativeEffectFrame;
    } else if (activeEffectAction === "release") {
      if (this.particleStateActive) this.particles.update(undefined);
      this.particleStateActive = false;
      this.liveBloom.invalidate();
      this.effectCacheActive = false;
      this.lastEffectFrame = -1;
    }
    this.gameCompositor.renderGame(this.renderer, this.drawGameScene);
    this.gameCompositor.renderMain(
      this.renderer,
      this.drawMainBackground,
      this.compositeEffects,
      this.drawMainUnderlays,
    );
    if (this.overlays.screenCount) {
      this.renderer.clearDepth();
      this.renderer.render(this.overlays.screen, this.overlays.screenCamera);
    }
    if (this.nativeIntroActive) this.hud?.drawIntroduction(frame.hud ?? {}, frame.overlayTexts);
    else this.hud?.draw(frame.hud, frame.overlayTexts);
    let noteCount = 0;
    for (const note of frame.notes ?? []) if (note.visible !== false) noteCount += 1;
    let holdCount = 0;
    for (const hold of frame.holds ?? []) if (hold.visible !== false) holdCount += 1;
    this.counts.notes = noteCount;
    this.counts.holds = holdCount;
    this.counts.particleEffects = particleEffectCount;
  }

  resize(
    width: number,
    height: number,
    pixelRatio = this.options.pixelRatio ?? globalThis.devicePixelRatio ?? 1,
  ): void {
    if (this.disposed) return;
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    const nextPixelRatio = clamp(pixelRatio, 0.5, 3);
    if (
      this.sized &&
      Math.abs(nextWidth - this.width) < 0.01 &&
      Math.abs(nextHeight - this.height) < 0.01 &&
      nextPixelRatio === this.pixelRatio
    )
      return;
    const pixelRatioChanged = !this.sized || nextPixelRatio !== this.pixelRatio;
    this.width = nextWidth;
    this.height = nextHeight;
    this.pixelRatio = nextPixelRatio;
    this.sized = true;
    if (pixelRatioChanged) this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.options.canvas.style.width = `${this.width}px`;
    this.options.canvas.style.height = `${this.height}px`;
    const currentAspect = this.width / this.height;
    const boundedAspect = Math.min(currentAspect, 16 / 9);
    const baseHalfFov = (OUR_NOTES_LIVE_GEOMETRY.cameraFovDegrees * Math.PI) / 360;
    this.camera.fov = (2 * Math.atan((Math.tan(baseHalfFov) * (16 / 9)) / boundedAspect) * 180) / Math.PI;
    this.camera.aspect = currentAspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.updateLaneProjection();
    this.screenLane?.resize(this.width, this.height);
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    this.liveBloom.setSize(this.drawingBufferSize.x, this.drawingBufferSize.y);
    this.gameCompositor.setSize(this.drawingBufferSize.x, this.drawingBufferSize.y);
    this.effectCacheActive = false;
    this.lastEffectFrame = -1;
    this.particles.setPixelRatio(this.pixelRatio);
    this.hud?.resize(this.width, this.height, this.pixelRatio);
  }

  /** Convert DOM client coordinates to a half-lane, or -1 outside the judgement span. */
  clientPointToLane(clientX: number, clientY: number): number {
    const point = this.clientPointOnCanvas(clientX, clientY);
    return this.canvasPointToLane(point.x, point.y, point.width, point.height);
  }

  private clientPointOnCanvas(
    clientX: number,
    clientY: number,
  ): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const canvas = this.options.canvas;
    const rotationRoot = canvas.closest<HTMLElement>("[data-runtime-rotation]");
    const rotationHost = rotationRoot?.parentElement;
    if (rotationRoot && rotationHost) {
      let offsetX = 0;
      let offsetY = 0;
      let node: HTMLElement | null = canvas;
      while (node && node !== rotationRoot) {
        offsetX += node.offsetLeft;
        offsetY += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }

      if (node === rotationRoot) {
        const transform = getComputedStyle(rotationRoot).transform;
        const matrix = transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
        const angle = Math.atan2(matrix.b, matrix.a);
        const hostRect = rotationHost.getBoundingClientRect();
        const point = clientPointInRotatedContent(clientX, clientY, {
          hostLeft: hostRect.left,
          hostTop: hostRect.top,
          hostWidth: hostRect.width,
          hostHeight: hostRect.height,
          contentWidth: rotationRoot.clientWidth,
          contentHeight: rotationRoot.clientHeight,
          angleRadians: angle,
        });
        return {
          x: point.x - offsetX,
          y: point.y - offsetY,
          width: canvas.clientWidth,
          height: canvas.clientHeight,
        };
      }
    }

    const rect = canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  getViewport(): NativeChartViewport | undefined {
    if (this.disposed || !this.sized) return;
    return {
      width: this.width,
      height: this.height,
      pixelRatio: this.pixelRatio,
      laneCount: this.projector.laneCount,
    };
  }

  projectNoteView(note: Pick<RenderNote, "lane" | "width" | "approach">): NativeNoteViewProjection | undefined {
    const viewport = this.getViewport();
    if (!viewport) return;
    return projectNativeNoteView(note, this.projector, viewport, this.camera.projectionMatrix.elements);
  }

  canvasPointToNoteView(x: number, y: number): NativeNoteViewPoint | undefined {
    const viewport = this.getViewport();
    if (!viewport) return;
    return nativeNoteViewAtCanvasPoint(x, y, this.projector, viewport, this.camera.projectionMatrix.elements);
  }

  clientPointToNoteView(clientX: number, clientY: number): NativeNoteViewPoint | undefined {
    if (this.disposed) return;
    const point = this.clientPointOnCanvas(clientX, clientY);
    if (point.width <= 0 || point.height <= 0) return;
    return this.canvasPointToNoteView((point.x * this.width) / point.width, (point.y * this.height) / point.height);
  }

  pickNoteAtCanvasPoint(x: number, y: number): NativeNoteHit | undefined {
    if (this.disposed || this.contextLost || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < 0 || y < 0 || x > this.width || y > this.height) return;
    this.notePointer.set((2 * x) / this.width - 1, 1 - (2 * y) / this.height);
    this.camera.updateMatrixWorld(true);
    this.noteRaycaster.setFromCamera(this.notePointer, this.camera);
    return this.notes.pickNote(this.noteRaycaster);
  }

  pickNoteAtClientPoint(clientX: number, clientY: number): NativeNoteHit | undefined {
    if (this.disposed) return;
    const point = this.clientPointOnCanvas(clientX, clientY);
    if (point.width <= 0 || point.height <= 0) return;
    return this.pickNoteAtCanvasPoint((point.x * this.width) / point.width, (point.y * this.height) / point.height);
  }

  /** Convert CSS-pixel canvas coordinates to native continuous lane centres (0..23). */
  canvasPointToLane(x: number, y: number, canvasWidth = this.width, canvasHeight = this.height): number {
    const width = Math.max(1, canvasWidth);
    const height = Math.max(1, canvasHeight);
    void y;
    // ScreenTouchInputProvider and LiveNoteViewJudgementRoot2D consume the
    // same LaneViewSettings.JudgementPositions array. In this renderer those
    // are the screen_root-local endpoints, not the physical 3D effect root.
    const left = (this.laneProjectionLeftNdcX * 0.5 + 0.5) * width;
    const right = (this.laneProjectionRightNdcX * 0.5 + 0.5) * width;
    // MasterLiveJudgementAreaOffset assist=0 stores maxOffset.x=3. Native
    // multiplies that by its 100 px/unit constant before the bounds check.
    const referenceScale = Math.min(width / 1920, height / 1080);
    const margin = 300 * referenceScale;
    if (x < left - margin || x > right + margin) return -1;
    if (x <= left) return 0;
    if (x >= right) return this.projector.laneCount - 1;
    return ((x - left) / Math.max(0.000001, right - left)) * (this.projector.laneCount - 1);
  }

  /** Camera and screen_root are static between resizes, so cache their projected lane span. */
  private updateLaneProjection(): void {
    this.laneProjectionLeftNdcX = this.screenRoot
      .localToWorld(
        this.laneProjectionLeft.set(this.projector.laneCenterToX(0, 1), OUR_NOTES_LIVE_GEOMETRY.screenJudgementY, 0),
      )
      .project(this.camera).x;
    this.laneProjectionRightNdcX = this.screenRoot
      .localToWorld(
        this.laneProjectionRight.set(
          this.projector.laneCenterToX(this.projector.laneCount - 1, 1),
          OUR_NOTES_LIVE_GEOMETRY.screenJudgementY,
          0,
        ),
      )
      .project(this.camera).x;
    this.hud?.setLaneProjection(this.laneProjectionLeftNdcX, this.laneProjectionRightNdcX);
  }

  async setBackgroundTexture(url?: string, loader = new TextureLoader()): Promise<void> {
    const revision = ++this.backgroundLoadRevision;
    if (!url) {
      this.backgroundCanvas = undefined;
      this.backgroundCanvasWidth = 0;
      this.backgroundCanvasHeight = 0;
      this.backgroundCanvasVersion = undefined;
      this.uploadedBackgroundCanvasVersion = undefined;
      this.backgroundTexture?.dispose();
      this.backgroundTexture = undefined;
      this.screenLane.setBackgroundTexture(undefined);
      return;
    }
    // Do not clear the current stage while the replacement is in flight. A
    // rapid 1 -> 2 -> 1 switch can resolve out of order on the asset proxy, so
    // only the latest request may swap ownership into the renderer.
    const texture = await loader.loadAsync(url);
    if (this.disposed || revision !== this.backgroundLoadRevision) {
      texture.dispose();
      return;
    }
    this.configureGammaTexture(texture);
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    const previous = this.backgroundTexture;
    this.backgroundCanvas = undefined;
    this.backgroundCanvasWidth = 0;
    this.backgroundCanvasHeight = 0;
    this.backgroundCanvasVersion = undefined;
    this.uploadedBackgroundCanvasVersion = undefined;
    this.backgroundTexture = texture;
    this.screenLane.setBackgroundTexture(texture);
    previous?.dispose();
  }

  /** Bind a muted host-owned video as the lowest live-stage layer. */
  setBackgroundVideo(video?: HTMLVideoElement): void {
    if (this.disposed) return;
    this.backgroundLoadRevision += 1;
    const previous = this.backgroundTexture;
    this.backgroundCanvas = undefined;
    this.backgroundCanvasWidth = 0;
    this.backgroundCanvasHeight = 0;
    this.backgroundCanvasVersion = undefined;
    this.uploadedBackgroundCanvasVersion = undefined;
    if (!video) {
      this.backgroundTexture = undefined;
      this.screenLane.setBackgroundTexture(undefined);
      previous?.dispose();
      return;
    }
    const texture = new VideoTexture(video);
    this.configureGammaTexture(texture);
    texture.generateMipmaps = false;
    this.backgroundTexture = texture;
    this.screenLane.setBackgroundTexture(texture);
    previous?.dispose();
  }

  /** Bind a host-owned dynamic canvas inside the WebGL base framebuffer. */
  setBackgroundCanvas(canvas?: HTMLCanvasElement, version?: number): void {
    if (this.disposed) return;
    this.backgroundLoadRevision += 1;
    if (canvas && canvas === this.backgroundCanvas && this.backgroundTexture) {
      this.backgroundCanvasVersion = Number.isFinite(version) ? version : undefined;
      this.refreshBackgroundCanvas();
      return;
    }
    const previous = this.backgroundTexture;
    if (!canvas) {
      this.backgroundCanvas = undefined;
      this.backgroundCanvasWidth = 0;
      this.backgroundCanvasHeight = 0;
      this.backgroundCanvasVersion = undefined;
      this.uploadedBackgroundCanvasVersion = undefined;
      this.backgroundTexture = undefined;
      this.screenLane.setBackgroundTexture(undefined);
      previous?.dispose();
      return;
    }
    const texture = new CanvasTexture(canvas);
    this.configureGammaTexture(texture);
    texture.generateMipmaps = false;
    this.backgroundCanvas = canvas;
    this.backgroundCanvasWidth = canvas.width;
    this.backgroundCanvasHeight = canvas.height;
    this.backgroundCanvasVersion = Number.isFinite(version) ? version : undefined;
    this.uploadedBackgroundCanvasVersion = this.backgroundCanvasVersion;
    this.backgroundTexture = texture;
    this.screenLane.setBackgroundTexture(texture);
    previous?.dispose();
  }

  private refreshBackgroundCanvas(): void {
    const canvas = this.backgroundCanvas;
    const texture = this.backgroundTexture;
    if (!canvas || !texture) return;
    if (!dynamicCanvasFrameChanged(this.backgroundCanvasVersion, this.uploadedBackgroundCanvasVersion)) return;
    const resized = refreshDynamicCanvasTexture(
      texture,
      canvas,
      this.backgroundCanvasWidth,
      this.backgroundCanvasHeight,
    );
    this.uploadedBackgroundCanvasVersion = this.backgroundCanvasVersion;
    if (!resized) return;
    this.backgroundCanvasWidth = canvas.width;
    this.backgroundCanvasHeight = canvas.height;
    this.screenLane.refreshBackgroundLayout();
  }

  refreshBackgroundLayout(): void {
    if (this.disposed) return;
    this.screenLane.refreshBackgroundLayout();
  }

  get stats(): OurNotesRendererStats {
    const noteStats = this.notes.stats;
    const holdStats = this.holds.stats;
    const particleStats = this.particles.stats;
    return {
      ...this.counts,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      activeNoteVisuals: noteStats.activeVisuals,
      activeHoldVisuals: holdStats.activeVisuals,
      renderedParticles: particleStats.renderedParticles,
      effectRefreshed: this.effectRefreshed,
      cachedSpriteTextureViews: this.atlas?.stats.cachedTextureViews ?? 0,
      assetsReady: this.assetsReady,
      contextLost: this.contextLost,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.backgroundLoadRevision += 1;
    this.options.canvas.removeEventListener("webglcontextlost", this.onContextLost, false);
    this.options.canvas.removeEventListener("webglcontextrestored", this.onContextRestored, false);
    this.notes.group.removeEventListener("childadded", this.onNoteVisualAdded);
    this.notes.dispose();
    this.simultaneousLines.dispose();
    this.holds.dispose();
    this.particles.dispose();
    this.overlays.dispose();
    this.nativeIntro?.dispose();
    this.nativeIntro = undefined;
    this.liveBloom.dispose();
    this.gameCompositor.dispose();
    this.stage.dispose();
    this.screenLane?.dispose();
    this.hud?.dispose();
    this.atlas?.dispose();
    this.atlas = undefined;
    this.backgroundTexture?.dispose();
    this.backgroundTexture = undefined;
    this.backgroundCanvas = undefined;
    this.backgroundCanvasWidth = 0;
    this.backgroundCanvasHeight = 0;
    this.backgroundCanvasVersion = undefined;
    this.uploadedBackgroundCanvasVersion = undefined;
    this.scene.clear();
    this.effectScene.clear();
    this.renderer.setAnimationLoop(null);
    const context = this.renderer.getContext();
    if (!context.isContextLost()) {
      // A replacement renderer on this canvas creates typed-byte 3D placeholder textures.
      // Restore their required unpack defaults after the final 2D upload of this owner.
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
      context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    this.renderer.dispose();
  }
}
