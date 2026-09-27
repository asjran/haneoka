interface ViewportFullscreenOptions {
  owner: HTMLElement;
  onChange?: (active: boolean) => void;
}

/**
 * iOS/WebKit has no element fullscreen API. This controller keeps the
 * renderer in place and expands its existing pane over the visual viewport,
 * restoring every inline style it temporarily touches when it leaves.
 */
export class ViewportFullscreenController {
  private readonly owner: HTMLElement;
  private readonly onChange?: (active: boolean) => void;
  private active = false;
  private layer?: HTMLElement;
  private layerAttribute?: string | null;
  private layerStyle?: string | null;
  private bodyStyle?: string | null;
  private main?: HTMLElement;
  private mainStyle?: string | null;
  private visualViewport?: VisualViewport;
  private listenersInstalled = false;

  constructor(options: ViewportFullscreenOptions) {
    this.owner = options.owner;
    this.onChange = options.onChange;
  }

  isActive() {
    return this.active;
  }

  enter() {
    if (this.active) return true;
    const layer = this.owner.closest<HTMLElement>(".story-detail, .pane-layer");
    if (!layer) return false;
    this.layer = layer;
    this.layerAttribute = layer.getAttribute("data-story-fullscreen");
    this.layerStyle = layer.getAttribute("style");
    this.bodyStyle = document.body?.getAttribute("style");
    this.main = layer.closest<HTMLElement>(".app-shell__main") ?? undefined;
    this.mainStyle = this.main?.getAttribute("style");
    this.main?.style.setProperty("clip-path", "none");
    this.main?.style.setProperty("overflow", "visible");
    this.active = true;
    layer.setAttribute("data-story-fullscreen", "true");
    document.body?.style.setProperty("overflow", "hidden");
    document.body?.style.setProperty("overscroll-behavior", "none");
    this.installListeners();
    this.emitChange();
    return true;
  }

  exit() {
    const layer = this.layer;
    const wasActive = this.active || Boolean(layer);
    const previousAttribute = this.layerAttribute;
    const previousLayerStyle = this.layerStyle;
    const previousBodyStyle = this.bodyStyle;
    const main = this.main;
    const previousMainStyle = this.mainStyle;
    this.active = false;
    this.removeListeners();
    this.layer = undefined;
    this.layerAttribute = undefined;
    this.layerStyle = undefined;
    this.bodyStyle = undefined;
    this.main = undefined;
    this.mainStyle = undefined;

    // The host may already be disconnected when a mode changes. Restore the
    // exact captured attributes on whichever nodes still exist.
    if (layer && previousAttribute !== undefined) {
      if (previousAttribute === null) layer.removeAttribute("data-story-fullscreen");
      else layer.setAttribute("data-story-fullscreen", previousAttribute);
    }
    if (layer && previousLayerStyle !== undefined) {
      if (previousLayerStyle === null) layer.removeAttribute("style");
      else layer.setAttribute("style", previousLayerStyle);
    }
    const body = document.body;
    if (main && previousMainStyle !== undefined) {
      if (previousMainStyle === null) main.removeAttribute("style");
      else main.setAttribute("style", previousMainStyle);
    }
    if (body && previousBodyStyle !== undefined) {
      if (previousBodyStyle === null) body.removeAttribute("style");
      else body.setAttribute("style", previousBodyStyle);
    }
    if (wasActive) this.emitChange();
    return true;
  }

  dispose() {
    this.exit();
  }

  private emitChange() {
    this.onChange?.(this.active);
  }

  private installListeners() {
    if (this.listenersInstalled) return;
    this.listenersInstalled = true;
    window.addEventListener("resize", this.geometryChanged);
    window.addEventListener("orientationchange", this.geometryChanged);
    window.addEventListener("keydown", this.keydown, true);
    this.visualViewport = window.visualViewport ?? undefined;
    this.visualViewport?.addEventListener("resize", this.geometryChanged);
    this.visualViewport?.addEventListener("scroll", this.geometryChanged);
    this.syncGeometry();
  }

  private removeListeners() {
    if (!this.listenersInstalled) return;
    window.removeEventListener("resize", this.geometryChanged);
    window.removeEventListener("orientationchange", this.geometryChanged);
    window.removeEventListener("keydown", this.keydown, true);
    this.visualViewport?.removeEventListener("resize", this.geometryChanged);
    this.visualViewport?.removeEventListener("scroll", this.geometryChanged);
    this.visualViewport = undefined;
    this.listenersInstalled = false;
  }

  private geometryChanged = () => this.syncGeometry();

  private keydown = (event: KeyboardEvent) => {
    if (!this.active || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.exit();
  };

  private syncGeometry() {
    const layer = this.layer;
    if (!layer) return;
    const visualViewport = this.visualViewport;
    const width = visualViewport?.width || window.innerWidth;
    const height = visualViewport?.height || window.innerHeight;
    const offsetLeft = visualViewport?.offsetLeft || 0;
    const offsetTop = visualViewport?.offsetTop || 0;
    layer.style.setProperty("--story-visual-viewport-width", `${width}px`);
    layer.style.setProperty("--story-visual-viewport-height", `${height}px`);
    layer.style.setProperty("--story-visual-viewport-left", `${offsetLeft}px`);
    layer.style.setProperty("--story-visual-viewport-top", `${offsetTop}px`);
  }
}
