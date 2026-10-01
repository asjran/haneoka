import { createHaneokaBranding } from "@haneoka/embed-core/branding";
import { createEmbedLoader, memoryDataSource, type EmbedLoader } from "@haneoka/embed-core";
import type { CreateHaneokaHomeSpotSceneOptions, HaneokaHomeSpotSceneController } from "@haneoka/vega-plugin-haneoka";
import type { HomeSpotDocument, HomeSpotEvent, HomeSpotHandle, HomeSpotInput, MountHomeSpotOptions } from "./types.js";

export function mountHomeSpot(host: HTMLElement, options: MountHomeSpotOptions): HomeSpotHandle {
  if (!host?.ownerDocument) throw new TypeError("A DOM container is required");
  const ratio = options.aspectRatio ?? 16 / 9;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new RangeError("aspectRatio must be positive");
  const element = host.ownerDocument.createElement("div");
  element.style.cssText = "position:relative;width:100%;overflow:hidden;";
  element.style.aspectRatio = String(ratio);
  element.setAttribute("aria-busy", "true");
  element.appendChild(createHaneokaBranding(host.ownerDocument));
  const listeners = new Set<(event: HomeSpotEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);
  let state: HomeSpotHandle["state"] = "loading";
  let generation = 0;
  let loader: EmbedLoader<HomeSpotDocument> | undefined;
  let controller: HaneokaHomeSpotSceneController | undefined;
  let document: HomeSpotDocument | undefined;
  let request: AbortController | undefined;
  let ready: Promise<void>;
  let disposal: Promise<void> | undefined;
  let selectedCharacterId = options.selectedCharacterId;
  const cleanups = new Set<Promise<void>>();
  const releasedLoaders = new WeakSet<EmbedLoader<HomeSpotDocument>>();
  const cleanupErrors: unknown[] = [];
  const cleanup = (ownedLoader: EmbedLoader<HomeSpotDocument>) => {
    const pending = ownedLoader.dispose();
    if (releasedLoaders.has(ownedLoader)) return pending;
    releasedLoaders.add(ownedLoader);
    cleanups.add(pending);
    void pending.then(
      () => cleanups.delete(pending),
      (error: unknown) => {
        cleanups.delete(pending);
        cleanupErrors.push(error);
      },
    );
    return pending;
  };
  const emit = (event: HomeSpotEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          options.onListenerError?.(error);
        } catch {
          /* Observer errors do not change the scene. */
        }
      }
    }
  };
  const assertLive = () => {
    if (state === "disposed") throw new Error("Home Spot has been disposed");
  };
  const abort = () => request?.abort(new DOMException("Home Spot loading cancelled", "AbortError"));
  const scene = () => {
    assertLive();
    if (!controller || state !== "ready") throw new Error("Home Spot is not ready");
    return controller;
  };
  const clearColor = () => {
    if (options.clearColor !== undefined) return options.clearColor;
    const style = host.ownerDocument.defaultView?.getComputedStyle(host);
    const token = style?.getPropertyValue("--md-sys-color-surface").trim();
    const probe = host.ownerDocument.createElement("span");
    probe.style.backgroundColor = token || "Canvas";
    probe.hidden = true;
    element.appendChild(probe);
    const color = host.ownerDocument.defaultView?.getComputedStyle(probe).backgroundColor;
    probe.remove();
    if (!color) throw new Error("A clearColor or computed MD3 surface color is required");
    return color;
  };
  const load = (input: HomeSpotInput): Promise<void> => {
    assertLive();
    if ((input.document === undefined) === (input.source === undefined))
      throw new TypeError("Provide one document or source");
    const currentLoader = createEmbedLoader({ ...options, source: input.source ?? memoryDataSource(input.document!) });
    const previousLoader = loader;
    generation += 1;
    const currentGeneration = generation;
    abort();
    controller?.dispose();
    controller = undefined;
    document = undefined;
    request = new AbortController();
    const currentRequest = request;
    loader = currentLoader;
    state = "loading";
    element.setAttribute("aria-busy", "true");
    emit({ type: "loading", generation: currentGeneration });
    const unsubscribe = currentLoader.subscribe((event) => {
      if (currentGeneration === generation && state !== "disposed") emit({ type: "resource", event });
    });
    const current = () => {
      currentRequest.signal.throwIfAborted();
      if (currentGeneration !== generation || state === "disposed")
        throw new DOMException("Scene replaced", "AbortError");
    };
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(currentRequest.signal.reason);
      currentRequest.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const initialize = async () => {
      if (previousLoader) void cleanup(previousLoader).catch(() => {});
      current();
      const descriptor = await currentLoader.load({ signal: currentRequest.signal });
      current();
      const [provider, modules] = await Promise.all([
        import("@haneoka/vega-plugin-haneoka"),
        options.modules
          ? Promise.resolve(options.modules)
          : Promise.all([
              import("three"),
              import("three/examples/jsm/loaders/GLTFLoader.js"),
              import("@esotericsoftware/spine-threejs"),
            ]).then(([three, { GLTFLoader }, spine]) => ({ three, GLTFLoader, spine })),
      ]);
      current();
      const sceneOptions: CreateHaneokaHomeSpotSceneOptions = {
        host: element,
        descriptor,
        modules,
        resources: { load: (key, signal) => currentLoader.resourceBytes(key, { signal }) },
        signal: currentRequest.signal,
        clearColor: clearColor(),
        ariaLabel: options.ariaLabel ?? "Home Spot",
        ...(selectedCharacterId === undefined ? {} : { selectedCharacterId }),
        onContextLost: () => {
          if (currentGeneration === generation && state !== "disposed") emit({ type: "contextlost" });
        },
        onContextRestored: () => {
          if (currentGeneration === generation && state !== "disposed") emit({ type: "contextrestored" });
        },
      };
      const created = await provider.createHaneokaThreeSpineHomeSpotScene(sceneOptions);
      try {
        current();
      } catch (error) {
        created.dispose();
        throw error;
      }
      controller = created;
      created.setSelectedCharacter(selectedCharacterId);
      created.canvas.style.cssText += ";display:block;width:100%;height:100%;position:absolute;inset:0;";
      document = descriptor;
      state = "ready";
      element.setAttribute("aria-busy", "false");
      emit({ type: "ready", generation: currentGeneration });
    };
    ready = Promise.race([initialize(), cancelled])
      .catch((error: unknown) => {
        if (currentGeneration === generation && state !== "disposed") {
          state = currentRequest.signal.aborted ? "cancelled" : "error";
          controller?.dispose();
          controller = undefined;
          element.setAttribute("aria-busy", "false");
          if (state === "cancelled") emit({ type: "cancelled", generation: currentGeneration });
          else emit({ type: "error", generation: currentGeneration, error });
        }
        void cleanup(currentLoader).catch(() => {});
        throw error;
      })
      .finally(() => {
        unsubscribe();
        if (rejectAbort) currentRequest.signal.removeEventListener("abort", rejectAbort);
      });
    // Consumers can attach their handler after mount without an unhandled rejection.
    void ready.catch(() => {});
    return ready;
  };
  const pointerMove = (event: PointerEvent) => controller?.pointerMove(event.clientX, event.clientY);
  const pointerLeave = () => controller?.pointerLeave();
  const select = (event: MouseEvent) => {
    if (!controller || state !== "ready") return;
    selectedCharacterId = controller.selectAt(event.clientX, event.clientY);
    controller.setSelectedCharacter(selectedCharacterId);
    emit({ type: "selection", characterId: selectedCharacterId });
  };
  element.addEventListener("pointermove", pointerMove);
  element.addEventListener("pointerleave", pointerLeave);
  element.addEventListener("click", select);
  const onAbort = () => {
    void handle.dispose().catch((error: unknown) => {
      try {
        options.onListenerError?.(error);
      } catch {
        /* Detached cleanup has no caller. */
      }
    });
  };
  const handle: HomeSpotHandle = {
    get ready() {
      return ready;
    },
    get state() {
      return state;
    },
    element,
    get canvas() {
      return controller?.canvas;
    },
    get document() {
      return document;
    },
    update(value) {
      assertLive();
      if (Object.hasOwn(value, "selectedCharacterId")) {
        selectedCharacterId = value.selectedCharacterId;
        controller?.setSelectedCharacter(selectedCharacterId);
      }
      if (value.replay) controller?.replay();
    },
    load,
    replay: () => scene().replay(),
    resize: () => scene().resize(),
    exportPng: async (value) => scene().exportPng(value),
    subscribe(listener) {
      assertLive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel() {
      if (state === "loading") abort();
    },
    dispose() {
      if (disposal) return disposal;
      state = "disposed";
      generation += 1;
      abort();
      controller?.dispose();
      controller = undefined;
      document = undefined;
      options.signal?.removeEventListener("abort", onAbort);
      element.removeEventListener("pointermove", pointerMove);
      element.removeEventListener("pointerleave", pointerLeave);
      element.removeEventListener("click", select);
      element.remove();
      disposal = Promise.resolve().then(async () => {
        if (loader) cleanup(loader);
        await Promise.allSettled([...cleanups]);
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Home Spot source cleanup failed");
      });
      emit({ type: "disposed" });
      listeners.clear();
      return disposal;
    },
  };
  host.appendChild(element);
  try {
    load(options);
  } catch (error) {
    void handle.dispose();
    throw error;
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return handle;
}
