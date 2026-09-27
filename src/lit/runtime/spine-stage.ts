import type * as Spine from "@esotericsoftware/spine-threejs";
import type * as THREE from "three";

type Value = Record<string, unknown>;
type Resource = { name?: string; url?: string };
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
      const skin = skins.includes("skin") ? "skin" : skins.includes("default") ? "default" : skins[0];
      if (skin) mesh.skeleton.setSkinByName(skin);
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
      renderer.setClearColor(0x000000, 0);
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
  setPaused(value: boolean) {
    this.paused = value;
  }
  setLoop(value: boolean) {
    this.loop = value;
    if (this.active && this.animation) this.active.mesh.state.setAnimation(0, this.animation, value);
  }
  replay() {
    if (this.active && this.animation) {
      this.active.mesh.state.setAnimation(0, this.animation, this.loop);
      this.paused = false;
    }
  }
  play(name: string) {
    if (!this.active || !name) return false;
    this.animation = name;
    this.active.mesh.state.setAnimation(0, name, this.loop);
    this.paused = false;
    return true;
  }
  private resize() {
    const stage = this.active;
    if (!stage) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const maximum = stage.renderer.capabilities.maxTextureSize;
    const scale = Math.min(1, Math.sqrt(2_000_000 / (width * height)), maximum / width, maximum / height);
    stage.renderer.setPixelRatio(1);
    stage.renderer.setSize(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)), false);
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
    Object.assign(stage.camera, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 });
    stage.camera.position.set(center.x, center.y, 10);
    stage.camera.lookAt(center.x, center.y, 0);
    stage.camera.updateProjectionMatrix();
  }
  private render = (now: number) => {
    const stage = this.active;
    if (!stage) return;
    const delta = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0;
    this.lastFrame = now;
    if (!this.paused) stage.mesh.update(delta);
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
}
