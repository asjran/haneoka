export interface PlaybackControlsSnapshot {
  readonly collapsed: boolean;
  readonly autoHidden: boolean;
}

/**
 * Shared visibility policy for the chart and story transport overlays.
 * The host owns the transport controls; this controller only handles the
 * reversible presentation state and its pointer/focus lifecycle.
 */
export class PlaybackControlsController {
  private controls?: HTMLElement;
  private detachControls?: () => void;
  private hideTimer = 0;
  private fullscreen = false;
  private playing = false;
  private scrubbing = false;
  private pointerInside = false;
  private focusWithin = false;
  private pointerActivation = false;
  private focusOrigin: "pointer" | "keyboard" | undefined;
  private snapshot: PlaybackControlsSnapshot = { collapsed: false, autoHidden: false };

  constructor(private readonly onChange: (snapshot: PlaybackControlsSnapshot) => void) {}

  bind(controls: HTMLElement | null) {
    if (controls === this.controls) return;
    this.detachControls?.();
    this.controls = controls || undefined;
    this.pointerInside = false;
    this.focusWithin = false;
    if (!controls) return;

    const pointerEnter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      this.pointerInside = true;
      if (!this.snapshot.collapsed && !this.snapshot.autoHidden) this.reveal();
    };
    const pointerLeave = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      this.pointerInside = false;
      this.scheduleAutoHide();
    };
    const pointerDown = () => {
      this.pointerActivation = true;
      this.reveal();
    };
    const pointerUp = () => {
      window.setTimeout(() => (this.pointerActivation = false), 0);
    };
    const focusIn = (event: FocusEvent) => {
      const sourceCapabilities = (event as FocusEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
        .sourceCapabilities;
      const pointerFocused = this.pointerActivation || sourceCapabilities?.firesTouchEvents === true;
      this.focusOrigin = pointerFocused ? "pointer" : "keyboard";
      this.focusWithin = !pointerFocused;
      this.reveal();
    };
    const keyDown = () => {
      this.focusOrigin = "keyboard";
      this.focusWithin = true;
      this.reveal();
    };
    const focusOut = () => {
      queueMicrotask(() => {
        this.focusWithin = controls.contains(document.activeElement) && this.focusOrigin !== "pointer";
        if (!this.focusWithin) this.focusOrigin = undefined;
        this.scheduleAutoHide();
      });
    };
    controls.addEventListener("pointerenter", pointerEnter);
    controls.addEventListener("pointerleave", pointerLeave);
    controls.addEventListener("pointerdown", pointerDown);
    controls.addEventListener("pointerup", pointerUp);
    controls.addEventListener("pointercancel", pointerUp);
    controls.addEventListener("focusin", focusIn);
    controls.addEventListener("focusout", focusOut);
    controls.addEventListener("keydown", keyDown);
    this.detachControls = () => {
      controls.removeEventListener("pointerenter", pointerEnter);
      controls.removeEventListener("pointerleave", pointerLeave);
      controls.removeEventListener("pointerdown", pointerDown);
      controls.removeEventListener("pointerup", pointerUp);
      controls.removeEventListener("pointercancel", pointerUp);
      controls.removeEventListener("focusin", focusIn);
      controls.removeEventListener("focusout", focusOut);
      controls.removeEventListener("keydown", keyDown);
    };
    this.scheduleAutoHide();
  }

  setFullscreen(value: boolean) {
    if (this.fullscreen === value) return;
    this.fullscreen = value;
    if (!value) this.setAutoHidden(false);
    this.scheduleAutoHide();
  }

  setPlaying(value: boolean) {
    if (this.playing === value) return;
    this.playing = value;
    this.scheduleAutoHide();
  }

  setScrubbing(value: boolean) {
    if (this.scrubbing === value) return;
    this.scrubbing = value;
    if (value) this.reveal();
    else this.scheduleAutoHide();
  }

  collapse() {
    this.clearAutoHideTimer();
    this.setAutoHidden(false);
    this.setCollapsed(true);
  }

  expand() {
    this.setCollapsed(false);
    this.reveal();
  }

  dispose() {
    this.clearAutoHideTimer();
    this.detachControls?.();
    this.detachControls = undefined;
    this.controls = undefined;
  }

  private reveal() {
    this.setAutoHidden(false);
    this.scheduleAutoHide();
  }

  private setCollapsed(collapsed: boolean) {
    if (this.snapshot.collapsed === collapsed) return;
    this.snapshot = { ...this.snapshot, collapsed };
    this.onChange(this.snapshot);
  }

  private setAutoHidden(autoHidden: boolean) {
    if (this.snapshot.autoHidden === autoHidden) return;
    this.snapshot = { ...this.snapshot, autoHidden };
    this.onChange(this.snapshot);
  }

  private clearAutoHideTimer() {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    this.hideTimer = 0;
  }

  private scheduleAutoHide() {
    this.clearAutoHideTimer();
    if (
      this.snapshot.collapsed ||
      !this.fullscreen ||
      !this.playing ||
      this.scrubbing ||
      this.pointerInside ||
      this.focusWithin
    ) {
      this.setAutoHidden(false);
      return;
    }
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = 0;
      if (this.fullscreen && this.playing && !this.scrubbing && !this.pointerInside && !this.focusWithin)
        this.setAutoHidden(true);
    }, 4000);
  }
}
