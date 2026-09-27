import type * as Spine from "@esotericsoftware/spine-threejs";
import type * as THREE from "three";
import { viewerBufferSize } from "./viewer-resolution";

type Value = Record<string, unknown>;
type Resource = { name?: string; url?: string };
export type SpineTransform = { offsetX: number; offsetY: number; scale: number };
export type SpineBackground = { r: number; g: number; b: number } | null;
interface Entry extends Value {
  animations?: string[];
  atlases?: Array<{ pages?: Resource[] }>;
  runtime?: { atlas?: Resource; json?: Resource; scale?: number; status?: string };
  scale?: number;
  skins?: string[];
}
interface Loaded {
  three: typeof THREE;
  spine: typeof Spine;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: Spine.SkeletonMesh;
  atlas: Spine.TextureAtlas;
  bitmaps: ImageBitmap[];
}
type Batcher = THREE.Mesh & {
  clear(): unknown;
  findMaterialGroup(texture: THREE.Texture, blend: unknown): number;
  newMaterial(): THREE.Material & { map: THREE.Texture | null };
  material: THREE.Material[];
};

export function installPainterOrder(mesh: Spine.SkeletonMesh, spine: typeof Spine) {
  const internals = mesh as unknown as { nextBatch(): Batcher };
  const next = internals.nextBatch.bind(mesh);
  const configured = new WeakSet<Batcher>();
  internals.nextBatch = () => {
    const batch = next();
    if (configured.has(batch)) return batch;
    configured.add(batch);
    let cursor = 0;
    const clear = batch.clear.bind(batch);
    batch.clear = () => {
      cursor = 0;
      return clear();
    };
    batch.findMaterialGroup = (texture, blend) => {
      const index = cursor++;
      const material =
        (batch.material[index] as (THREE.Material & { map: THREE.Texture | null }) | undefined) ?? batch.newMaterial();
      if (!batch.material[index]) batch.material.push(material);
      material.map = texture;
      Object.assign(material, spine.ThreeJsTexture.toThreeJsBlending(blend as Spine.BlendMode));
      material.needsUpdate = true;
      return index;
    };
    return batch;
  };
}

export class SpineStage {
  private active?: Loaded;
  private request?: AbortController;
  private frame = 0;
  private lastFrame = 0;
  private observer?: ResizeObserver;
  private paused = false;
  private loop = true;
  private animation = "";
  private playbackRate = 1;
  private background: SpineBackground = null;
  private transform: SpineTransform = { offsetX: 0, offsetY: 0, scale: 1 };
  private fit?: { centerX: number; centerY: number; width: number; height: number };
  private skin = "";

  constructor(private readonly host: HTMLElement) {}

  async load(entry: Entry, signal?: AbortSignal) {
    this.dispose();
    const controller = new AbortController();
    this.request = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const check = () => {
      if (controller.signal.aborted || this.request !== controller)
        throw new DOMException("Spine loading was cancelled", "AbortError");
    };
    const partial: {
      atlas?: Spine.TextureAtlas;
      mesh?: Spine.SkeletonMesh;
      renderer?: THREE.WebGLRenderer;
      bitmaps: ImageBitmap[];
    } = { bitmaps: [] };
    let committed = false;
    try {
      check();
      const runtime = entry.runtime;
      const atlasUrl = String(runtime?.atlas?.url || "");
      const jsonUrl = String(runtime?.json?.url || "");
      const pages = (entry.atlases || []).flatMap((atlas) => atlas.pages || []).filter((page) => page.name && page.url);
      if (runtime?.status !== "ready" || !atlasUrl || !jsonUrl || !pages.length)
        throw new Error("Spine model is not browser-ready");
      const [three, spine, atlasResponse, jsonResponse] = await Promise.all([
        import("three"),
        import("@esotericsoftware/spine-threejs"),
        fetch(atlasUrl, { signal: controller.signal }),
        fetch(jsonUrl, { signal: controller.signal }),
      ]);
      check();
      if (!atlasResponse.ok || !jsonResponse.ok) throw new Error("Spine runtime asset request failed");
      const atlasText = await atlasResponse.text();
      check();
      const atlas = new spine.TextureAtlas(atlasText);
      partial.atlas = atlas;
      const exactPages = new Map(pages.map((page) => [String(page.name), page]));
      const bitmaps = partial.bitmaps;
      for (const page of atlas.pages) {
        const resource = exactPages.get(page.name);
        if (!resource?.url) throw new Error(`Missing atlas page: ${page.name}`);
        const response = await fetch(resource.url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Texture request failed: ${page.name}`);
        const bitmap = await createImageBitmap(await response.blob(), {
          premultiplyAlpha: page.pma ? "none" : "premultiply",
          colorSpaceConversion: "none",
        });
        bitmaps.push(bitmap);
        check();
        page.setTexture(new spine.ThreeJsTexture(bitmap, true));
      }
      const parser = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas));
      parser.scale = Number(runtime.scale ?? entry.scale ?? 1);
      const skeletonJson = await jsonResponse.json();
      check();
      const skeletonData = parser.readSkeletonData(skeletonJson);
      const mesh = new spine.SkeletonMesh({
        skeletonData,
        twoColorTint: true,
        materialFactory: (parameters) =>
          new three.MeshBasicMaterial({ ...parameters, depthTest: false, depthWrite: false, forceSinglePass: true }),
      });
      partial.mesh = mesh;
      installPainterOrder(mesh, spine);
      const skins = entry.skins || [];
      const availableSkins = skeletonData.skins.map((value) => value.name).filter(Boolean);
      const initialSkin =
        ["skin", "default", ...skins, ...availableSkins].find((value) => availableSkins.includes(value)) || "";
      if (initialSkin) mesh.skeleton.setSkinByName(initialSkin);
      this.skin = initialSkin;
      mesh.skeleton.setToSetupPose();
      this.animation =
        (entry.animations || []).find((name) => name === "f_idle") ||
        (entry.animations || []).find((name) => name === "idle") ||
        entry.animations?.[0] ||
        "";
      if (this.animation) mesh.state.setAnimation(0, this.animation, this.loop);
      mesh.update(0);
      const renderer = new three.WebGLRenderer({ alpha: true, antialias: true });
      partial.renderer = renderer;
      this.applyBackground(renderer, three);
      renderer.sortObjects = false;
      const scene = new three.Scene();
      scene.add(mesh);
      const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
      check();
      this.active = { three, spine, renderer, scene, camera, mesh, atlas, bitmaps };
      committed = true;
      this.host.replaceChildren(renderer.domElement);
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.host);
      this.resize();
      this.frame = requestAnimationFrame(this.render);
    } catch (error) {
      if (!committed) this.releaseResources(partial);
      else if (this.active?.renderer === partial.renderer) this.dispose();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.request === controller) this.request = undefined;
    }
  }

  captureFrame(): boolean {
    const stage = this.active;
    if (!stage || stage.renderer.getContext().isContextLost()) return false;
    stage.renderer.render(stage.scene, stage.camera);
    return true;
  }
  skins(): string[] {
    const skins = this.active?.mesh.skeleton.data.skins;
    return Array.isArray(skins) ? skins.map((value) => String(value.name || "")).filter(Boolean) : [];
  }
  skinName(): string {
    return this.skin;
  }
  setSkin(name: string): boolean {
    const stage = this.active;
    const value = String(name || "");
    if (!stage || !value || !this.skins().includes(value)) return false;
    stage.mesh.skeleton.setSkinByName(value);
    stage.mesh.skeleton.setToSetupPose();
    if (this.animation) stage.mesh.state.setAnimation(0, this.animation, this.loop);
    this.applyPlaybackRate(stage.mesh.state);
    stage.mesh.update(0);
    this.skin = value;
    this.resize();
    return true;
  }
  setPlaybackRate(value: number) {
    this.playbackRate = Math.min(2, Math.max(0.25, Number.isFinite(value) ? value : 1));
    if (this.active) this.applyPlaybackRate(this.active.mesh.state);
  }
  setBackgroundColor(color: SpineBackground) {
    this.background = color;
    const stage = this.active;
    if (stage) this.applyBackground(stage.renderer, stage.three);
  }
  setTransform(transform: SpineTransform): SpineTransform {
    this.transform = {
      offsetX: Math.min(1.25, Math.max(-1.25, Number.isFinite(transform.offsetX) ? transform.offsetX : 0)),
      offsetY: Math.min(1.25, Math.max(-1.25, Number.isFinite(transform.offsetY) ? transform.offsetY : 0)),
      scale: Math.min(4, Math.max(0.5, Number.isFinite(transform.scale) ? transform.scale : 1)),
    };
    this.applyCameraTransform();
    return { ...this.transform };
  }
  resetTransform(): SpineTransform {
    return this.setTransform({ offsetX: 0, offsetY: 0, scale: 1 });
  }
  setPaused(value: boolean) {
    this.paused = value;
  }
  setLoop(value: boolean) {
    this.loop = value;
    if (this.active && this.animation) {
      this.active.mesh.state.setAnimation(0, this.animation, value);
      this.applyPlaybackRate(this.active.mesh.state);
    }
  }
  replay() {
    if (this.active && this.animation) {
      this.active.mesh.state.setAnimation(0, this.animation, this.loop);
      this.applyPlaybackRate(this.active.mesh.state);
      this.paused = false;
    }
  }
  play(name: string) {
    if (!this.active || !name) return false;
    this.animation = name;
    this.active.mesh.state.setAnimation(0, name, this.loop);
    this.applyPlaybackRate(this.active.mesh.state);
    this.paused = false;
    return true;
  }
  private resize() {
    const stage = this.active;
    if (!stage) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const gl = stage.renderer.getContext();
    if (gl.isContextLost()) return;
    const size = viewerBufferSize(width, height, gl);
    stage.renderer.setPixelRatio(1);
    stage.renderer.setSize(size.width, size.height, false);
    const bounds = stage.mesh.skeleton.getBoundsRect();
    if (
      !(bounds.width > 0 && bounds.height > 0) ||
      !Number.isFinite(bounds.x + bounds.y + bounds.width + bounds.height)
    )
      return;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const aspect = width / height;
    let w = bounds.width * 1.12;
    let h = bounds.height * 1.12;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    this.fit = { centerX: center.x, centerY: center.y, width: w, height: h };
    this.applyCameraTransform();
  }
  private render = (now: number) => {
    const stage = this.active;
    if (!stage) return;
    const delta = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0;
    this.lastFrame = now;
    if (!this.paused) stage.mesh.update(delta);
    if (stage.renderer.getContext().isContextLost()) {
      this.frame = requestAnimationFrame(this.render);
      return;
    }
    stage.renderer.render(stage.scene, stage.camera);
    this.frame = requestAnimationFrame(this.render);
  };
  dispose() {
    this.request?.abort();
    this.request = undefined;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastFrame = 0;
    this.observer?.disconnect();
    this.fit = undefined;
    this.skin = "";
    const stage = this.active;
    this.active = undefined;
    if (stage) this.releaseResources(stage);
  }

  private releaseResources(stage: {
    mesh?: Spine.SkeletonMesh;
    atlas?: Spine.TextureAtlas;
    renderer?: THREE.WebGLRenderer;
    bitmaps: ImageBitmap[];
  }) {
    stage.mesh?.dispose();
    stage.atlas?.dispose();
    for (const bitmap of stage.bitmaps) bitmap.close();
    stage.bitmaps.length = 0;
    stage.renderer?.dispose();
    stage.renderer?.forceContextLoss();
    stage.renderer?.domElement.remove();
  }

  private applyPlaybackRate(state: { timeScale: number }) {
    state.timeScale = this.playbackRate;
  }

  private applyBackground(renderer: THREE.WebGLRenderer, three: typeof THREE) {
    if (!this.background) {
      renderer.setClearColor(0x000000, 0);
      return;
    }
    renderer.setClearColor(new three.Color(this.background.r, this.background.g, this.background.b), 1);
  }

  private applyCameraTransform() {
    const stage = this.active;
    const fit = this.fit;
    if (!stage || !fit) return;
    const width = fit.width / this.transform.scale;
    const height = fit.height / this.transform.scale;
    const centerX = fit.centerX - (this.transform.offsetX * fit.width) / 2;
    const centerY = fit.centerY + (this.transform.offsetY * fit.height) / 2;
    Object.assign(stage.camera, {
      left: -width / 2,
      right: width / 2,
      top: height / 2,
      bottom: -height / 2,
    });
    stage.camera.position.set(centerX, centerY, 10);
    stage.camera.lookAt(centerX, centerY, 0);
    stage.camera.updateProjectionMatrix();
  }
}
