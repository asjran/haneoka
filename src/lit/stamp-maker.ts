import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/progress/circular-progress.js";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import { clientText, getI18nClient } from "../i18n/client";
import { canvasToPngBlob, downloadBlob } from "../lib/canvas-capture";
import { beginLoading } from "../lib/loading-progress";
import { readReleaseServer } from "../lib/release-server";
import {
  stampChoices,
  textlessChoices,
  textlessManifestUrl,
  loadStampImage,
  type StampChoice,
} from "../lib/stamp-maker/catalog";
import {
  clampPosition,
  defaultStampText,
  drawStamp,
  hitStampLayer,
  loadStampFont,
  STAMP_FONTS,
  type StampText,
} from "../lib/stamp-maker/render";
import { catalogUrl, fetchJson, type JsonRecord } from "./shared/catalog";
import { segmented, iconButton } from "./ui/controls";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";
import { LazyImages } from "./ui/lazy-images";

import { createStampLayer, copyStampText, type StampLayer } from "../lib/stamp-maker/layers";
import { stampFont } from "../lib/stamp-maker/fonts";

import { stampOutputSize, stampSizeOptions, type StampSize } from "../lib/stamp-maker/sizes";

import { stampCharacterColors } from "../lib/stamp-maker/colors";

import { STAMP_LANGUAGES } from "../lib/stamp-maker/languages";

import { registerImportedFont, removeImportedFont, type StampFont } from "../lib/stamp-maker/fonts";

type Mode = "original" | "textless";
type ValueControl = HTMLElement & { value: string | number };

export class StampMaker extends LitElement {
  static properties = {
    locale: {},
    server: {},
    textlessSrc: { attribute: "textless-src" },
    textless: { attribute: false },
    catalog: { attribute: false },
    mode: { state: true },
    selected: { state: true },
    settings: { state: true },
    catalogLoading: { state: true },
    imageLoading: { state: true },
    fontLoading: { state: true },
    catalogError: { state: true },
    imageError: { state: true },
    manifestError: { state: true },
    exportState: { state: true },
    outputWidth: { state: true },
    importedFonts: { state: true },
    fontError: { state: true },
    imageLanguage: { state: true },
    characters: { state: true },
    characterError: { state: true },
    colorCharacter: { state: true },
    layers: { state: true },
    activeLayerId: { state: true },
    backgroundCharacter: { state: true },
  };
  declare locale: string;
  declare server: string;
  declare textlessSrc: string;
  declare textless: unknown;
  declare catalog: JsonRecord;
  declare mode: Mode;
  declare selected: string;
  declare settings: StampText;
  declare catalogLoading: boolean;
  declare imageLoading: boolean;
  declare fontLoading: boolean;
  declare catalogError: boolean;
  declare imageError: boolean;
  declare manifestError: boolean;
  declare exportState: "" | "saving" | "saved" | "failed";
  declare outputWidth: string;
  declare importedFonts: StampFont[];
  declare fontError: boolean;
  declare imageLanguage: string;
  declare characters: JsonRecord;
  declare characterError: boolean;
  declare colorCharacter: string;
  declare layers: StampLayer[];
  declare activeLayerId: string;
  declare backgroundCharacter: string;
  private readonly layerMenuId = `stamp-layer-menu-${crypto.randomUUID()}`;
  private exportFonts = new Set<string>();
  private colorWasChosen = false;
  private characterRequest?: AbortController;
  private importedFaces: FontFace[] = [];
  private fileSequence = 0;
  private image?: HTMLImageElement;
  private catalogRequest?: AbortController;
  private imageRequest?: AbortController;
  private manifestRequest?: AbortController;
  private fontSequence = 0;
  private readonly thumbnails = new LazyImages();
  private drag?: { pointer: number; x: number; y: number; startX: number; startY: number };
  private readonly localeReady = () => {
    this.locale = getI18nClient()?.committed || this.locale;
    this.requestUpdate();
  };

  constructor() {
    super();
    this.locale = "en";
    this.server = "";
    this.textlessSrc = "";
    this.textless = undefined;
    this.catalog = {};
    this.mode = "original";
    this.selected = "";
    this.settings = defaultStampText();
    this.catalogLoading = false;
    this.imageLoading = false;
    this.fontLoading = false;
    this.catalogError = false;
    this.imageError = false;
    this.manifestError = false;
    this.exportState = "";
    this.outputWidth = "native";
    this.importedFonts = [];
    this.fontError = false;
    this.imageLanguage = "";
    this.characters = {};
    this.characterError = false;
    this.colorCharacter = "custom";
    this.backgroundCharacter = "custom";
    const layer = createStampLayer(this.settings);
    this.layers = [layer];
    this.activeLayerId = layer.id;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.classList.add("stamp-maker-host");
    window.addEventListener("haneoka:locale-ready", this.localeReady);
    if (!this.server) this.server = readReleaseServer();
    if (this.hasUpdated) {
      void this.loadCatalog();
      void this.loadManifest();
      void this.loadCharacters();
      void this.refreshFont();
    }
  }

  disconnectedCallback() {
    this.catalogRequest?.abort();
    this.characterRequest?.abort();
    this.imageRequest?.abort();
    this.manifestRequest?.abort();
    this.fontSequence++;
    this.fileSequence++;
    this.importedFaces.forEach(removeImportedFont);
    this.importedFaces = [];
    this.importedFonts = [];
    this.layers = this.layers.map((layer) =>
      layer.settings.font.startsWith("StampMakerLocal")
        ? { ...layer, settings: { ...layer.settings, font: "auto", weight: 900 } }
        : layer,
    );
    this.selectLayer(this.activeLayerId);
    this.drag = undefined;
    this.image = undefined;
    this.thumbnails.disconnect();
    window.removeEventListener("haneoka:locale-ready", this.localeReady);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has("server")) {
      void this.loadCatalog();
      void this.loadManifest();
      void this.loadCharacters();
    } else if (changed.has("textlessSrc")) void this.loadManifest();
    if (
      changed.has("catalog") ||
      changed.has("textless") ||
      changed.has("mode") ||
      changed.has("locale") ||
      changed.has("imageLanguage")
    ) {
      if (this.mode === "textless" && !textlessChoices(this.originals, this.textless, this.server).length)
        this.selectImageLanguage("");
      const choices = this.choices;
      if (!choices.some((stamp) => stamp.id === this.selected)) this.selected = choices[0]?.id || "";
      void this.loadImage();
    } else if (changed.has("selected")) void this.loadImage();
    const previous = changed.get("settings") as StampText | undefined;
    if (
      changed.has("locale") ||
      (changed.has("settings") &&
        (!previous ||
          previous.text !== this.settings.text ||
          previous.font !== this.settings.font ||
          previous.size !== this.settings.size ||
          previous.weight !== this.settings.weight))
    )
      void this.refreshFont();
    if (changed.has("selected") || changed.has("characters") || changed.has("catalog")) this.defaultCharacterColor();
    this.paint();
    this.thumbnails.observe(this);
  }

  private t(key: string) {
    if (["loading", "retry", "close"].includes(key)) return clientText(this.locale, key);
    return clientText(this.locale, `stampMaker.${key}`);
  }
  private get originals() {
    return stampChoices(this.catalog, this.locale, this.imageLanguage);
  }
  private get choices() {
    return this.mode === "textless" ? textlessChoices(this.originals, this.textless, this.server) : this.originals;
  }
  private get choice() {
    const stamp = this.choices.find((stamp) => stamp.id === this.selected);
    const variant = this.originalVariant;
    return this.mode === "original" && stamp && variant ? { ...stamp, sources: [variant.url] } : stamp;
  }
  private get originalVariant() {
    const stamp = this.originals.find((stamp) => stamp.id === this.selected);
    return stamp?.variants.find((version) => version.url === stamp.sources[0]);
  }
  private versionLabel(language: string) {
    return STAMP_LANGUAGES[language]?.label || (language === "original" ? this.t("original") : language);
  }
  private get fallbackFont() {
    return getComputedStyle(this).getPropertyValue("--app-font").trim() || "sans-serif";
  }
  private get effectiveSize(): StampSize | undefined {
    const image = this.image;
    const declared = this.choice?.effectiveSize;
    if (!image) return declared;
    return {
      width: Math.min(image.naturalWidth, declared?.width || image.naturalWidth),
      height: Math.min(image.naturalHeight, declared?.height || image.naturalHeight),
    };
  }
  private get previewAspect() {
    const size = this.image
      ? { width: this.image.naturalWidth, height: this.image.naturalHeight }
      : this.choice?.effectiveSize;
    return size ? size.width / size.height : 1;
  }
  private get ready() {
    return !!this.image && !this.imageLoading && !this.fontLoading && !this.fontError && !this.imageError;
  }

  private async loadCatalog() {
    this.catalogRequest?.abort();
    const request = new AbortController();
    this.catalogRequest = request;
    this.catalogLoading = true;
    this.catalogError = false;
    this.catalog = {};
    const loading = beginLoading(this.t("choose"), { signal: request.signal });
    try {
      const catalog = await fetchJson<JsonRecord>(catalogUrl("stamps", "", this.server), { signal: request.signal });
      if (request.signal.aborted || !this.isConnected) return;
      if (!stampChoices(catalog, this.locale).length) throw new Error("Stamp catalog is empty");
      this.catalog = catalog;
      loading.finish();
    } catch {
      if (!request.signal.aborted) {
        this.catalogError = true;
        loading.fail();
      }
    } finally {
      if (this.catalogRequest === request) this.catalogLoading = false;
    }
  }

  private get characterColors() {
    return stampCharacterColors(this.characters, this.locale);
  }
  private async loadCharacters() {
    this.characterRequest?.abort();
    const request = new AbortController();
    this.characterRequest = request;
    this.characters = {};
    this.characterError = false;
    try {
      const catalog = await fetchJson<JsonRecord>(catalogUrl("characters", "", this.server), {
        signal: request.signal,
      });
      if (!request.signal.aborted && this.isConnected) this.characters = catalog;
    } catch {
      if (!request.signal.aborted && this.isConnected) this.characterError = true;
    }
  }
  private defaultCharacterColor() {
    if (this.colorWasChosen) return;
    const stamp = this.originals.find((item) => item.id === this.selected);
    const character = this.characterColors.find((item) => stamp?.characterIds.includes(item.id));
    if (character && this.colorCharacter !== character.id) {
      this.colorCharacter = character.id;
      this.change({ fill: character.color });
    }
  }
  private chooseCharacterColor(id: string) {
    this.colorWasChosen = true;
    this.colorCharacter = id;
    const character = this.characterColors.find((item) => item.id === id);
    this.change(character ? { fill: character.color } : {});
  }

  private async loadManifest() {
    this.manifestRequest?.abort();
    this.textless = undefined;
    this.manifestError = false;
    const source = this.textlessSrc || textlessManifestUrl(this.server);
    if (!source) return;
    const request = new AbortController();
    this.manifestRequest = request;
    try {
      const manifest = await fetchJson(source, { signal: request.signal });
      if (!request.signal.aborted && this.isConnected) this.textless = manifest;
    } catch {
      if (!request.signal.aborted) this.manifestError = true;
    }
  }

  private async loadImage() {
    this.imageRequest?.abort();
    const request = new AbortController();
    this.imageRequest = request;
    this.image = undefined;
    this.imageError = false;
    if (this.exportState !== "saving") this.exportState = "";
    this.drag = undefined;
    const choice = this.choice;
    this.imageLoading = !!choice;
    this.paint();
    if (!choice) return;
    const loading = beginLoading(choice.label, { signal: request.signal });
    const deadline = window.setTimeout(
      () => request.abort(new DOMException("Stamp image timed out", "TimeoutError")),
      15000,
    );
    try {
      const image = await loadStampImage(choice.sources, request.signal);
      if (request.signal.aborted || !this.isConnected) return;
      this.image = image;
      if (this.outputWidth !== "native" && Number(this.outputWidth) > (this.effectiveSize?.width || 0))
        this.outputWidth = "native";
      loading.finish();
    } catch {
      if (this.imageRequest === request && this.isConnected) {
        this.imageError = true;
        loading.fail();
      }
    } finally {
      clearTimeout(deadline);
      if (this.imageRequest === request) {
        this.imageLoading = false;
        this.requestUpdate();
      }
    }
  }

  private change(values: Partial<StampText>) {
    if (values.font && values.weight === undefined)
      values = { ...values, weight: stampFont(values.font)?.weight || 900 };
    this.settings = copyStampText({ ...this.settings, ...values });
    this.layers = this.layers.map((layer) =>
      layer.id === this.activeLayerId
        ? {
            ...layer,
            settings: copyStampText(this.settings),
            colorCharacter: this.colorCharacter,
            backgroundCharacter: this.backgroundCharacter,
            colorWasChosen: this.colorWasChosen,
          }
        : layer,
    );
    if (this.exportState !== "saving") this.exportState = "";
  }

  private async refreshFont() {
    const sequence = ++this.fontSequence;
    this.fontLoading = true;
    this.fontError = false;
    try {
      await loadStampFont(this.settings, this.fallbackFont);
    } catch {
      if (sequence === this.fontSequence && this.isConnected) this.fontError = true;
    } finally {
      if (sequence === this.fontSequence && this.isConnected) {
        this.fontLoading = false;
        this.paint();
      }
    }
  }

  private paint() {
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    if (!canvas) return;
    const aspect = this.previewAspect;
    const width = Math.max(1, Math.round(512 * Math.min(1, aspect)));
    const height = Math.max(1, Math.round(width / aspect));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (!this.image) {
      canvas.getContext("2d")?.clearRect(0, 0, width, height);
      return;
    }
    drawStamp(
      canvas,
      this.image,
      this.layers,
      this.fallbackFont,
      getComputedStyle(this).getPropertyValue("--md-sys-color-primary").trim(),
      this.activeLayerId,
    );
  }

  private pointerPoint(event: PointerEvent) {
    const canvas = event.currentTarget as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return {
      canvas,
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  }

  private pointerDown(event: PointerEvent) {
    if (!this.ready || this.drag || (event.pointerType === "mouse" && event.button !== 0)) return;
    const { canvas, x, y } = this.pointerPoint(event);
    const hit = hitStampLayer(canvas, this.layers, this.fallbackFont, x, y);
    if (!hit) return;
    if (hit !== this.activeLayerId) this.selectLayer(hit);
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    this.drag = { pointer: event.pointerId, x, y, startX: this.settings.x, startY: this.settings.y };
  }

  private pointerMove(event: PointerEvent) {
    if (this.drag?.pointer !== event.pointerId) return;
    const { canvas, x, y } = this.pointerPoint(event);
    this.change({
      x: clampPosition(this.drag.startX + ((x - this.drag.x) / canvas.width) * 100),
      y: clampPosition(this.drag.startY + ((y - this.drag.y) / canvas.height) * 100),
    });
  }

  private pointerEnd(event: PointerEvent) {
    if (this.drag?.pointer !== event.pointerId) return;
    const canvas = event.currentTarget as HTMLCanvasElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    this.drag = undefined;
  }

  private canvasKey(event: KeyboardEvent) {
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (
      !direction ||
      !this.ready ||
      (!this.settings.text.trim() && !(this.settings.background && this.settings.background.alpha > 0))
    )
      return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    this.change({
      x: clampPosition(this.settings.x + direction[0] * step),
      y: clampPosition(this.settings.y + direction[1] * step),
    });
  }

  private async exportPng() {
    if (!this.ready || !this.image || this.exportState === "saving") return;
    const image = this.image;
    const layers = this.layers.map((layer) => ({ ...layer, settings: copyStampText(layer.settings) }));
    const fallback = this.fallbackFont;
    const resourceName = `${this.choice?.resourceName || "stamp"}${this.mode === "original" && this.originalVariant ? `-${this.originalVariant.language}` : ""}`;
    const sourceSize = this.effectiveSize;
    if (!sourceSize) return;
    const requestedSize = this.outputWidth;
    this.exportState = "saving";
    this.exportFonts = new Set(layers.map((layer) => layer.settings.font));
    try {
      const { width, height } = stampOutputSize(sourceSize, requestedSize);
      await Promise.all(layers.map((layer) => loadStampFont(layer.settings, fallback)));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      drawStamp(canvas, image, layers, fallback);
      await downloadBlob(await canvasToPngBlob(canvas), `${resourceName}-${width}x${height}.png`);
      this.exportState = "saved";
    } catch {
      this.exportState = "failed";
    } finally {
      this.exportFonts.clear();
    }
  }

  private async importFont(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const sequence = ++this.fileSequence;
    this.fontLoading = true;
    this.fontError = false;
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("Font file is too large");
      const face = new FontFace(`StampMakerLocal${crypto.randomUUID()}`, await file.arrayBuffer());
      await face.load();
      if (sequence !== this.fileSequence || !this.isConnected) return;
      const font = registerImportedFont(face, file.name);
      this.importedFaces.push(face);
      if (this.importedFaces.length > 16) {
        const unused = this.importedFaces.find(
          (item) =>
            item !== face &&
            !this.layers.some((layer) => layer.settings.font === item.family) &&
            !this.exportFonts.has(item.family),
        );
        if (unused) {
          removeImportedFont(unused);
          this.importedFaces = this.importedFaces.filter((item) => item !== unused);
          this.importedFonts = this.importedFonts.filter((item) => item.family !== unused.family);
        } else {
          removeImportedFont(face);
          this.importedFaces = this.importedFaces.filter((item) => item !== face);
          throw new Error("Imported font capacity reached");
        }
      }
      this.importedFonts = [...this.importedFonts, font];
      await this.updateComplete;
      if (sequence === this.fileSequence && this.isConnected) this.change({ font: font.family });
    } catch {
      if (sequence === this.fileSequence && this.isConnected) this.fontError = true;
    } finally {
      if (sequence === this.fileSequence && this.isConnected) this.fontLoading = false;
    }
  }

  private selectLayer(id: string) {
    const layer = this.layers.find((item) => item.id === id);
    if (!layer) return;
    this.activeLayerId = id;
    this.colorCharacter = layer.colorCharacter;
    this.backgroundCharacter = layer.backgroundCharacter;
    this.colorWasChosen = layer.colorWasChosen;
    this.settings = copyStampText(layer.settings);
  }
  private async addLayer(duplicate = false) {
    if (this.layers.length >= 12) return;
    const layer = createStampLayer(duplicate ? this.settings : { ...this.settings, text: "", background: undefined });
    layer.colorCharacter = this.colorCharacter;
    layer.colorWasChosen = this.colorWasChosen;
    if (duplicate) {
      layer.backgroundCharacter = this.backgroundCharacter;
      layer.settings.x = clampPosition(layer.settings.x + 3);
      layer.settings.y = clampPosition(layer.settings.y + 3);
    }
    this.layers = [...this.layers, layer];
    await this.updateComplete;
    this.selectLayer(layer.id);
  }
  private deleteLayer() {
    if (this.layers.length <= 1) return;
    const index = this.layers.findIndex((item) => item.id === this.activeLayerId);
    this.layers = this.layers.filter((item) => item.id !== this.activeLayerId);
    this.selectLayer(this.layers[Math.min(index, this.layers.length - 1)].id);
  }
  private moveLayer(direction: number) {
    const index = this.layers.findIndex((item) => item.id === this.activeLayerId),
      next = index + direction;
    if (next < 0 || next >= this.layers.length) return;
    const layers = [...this.layers];
    [layers[index], layers[next]] = [layers[next], layers[index]];
    this.layers = layers;
  }
  private changeBackground(values: Partial<NonNullable<StampText["background"]>>) {
    this.change({
      background: { color: "#ffffff", alpha: 0, padding: 0, radius: 0.5, ...this.settings.background, ...values },
    });
  }
  private chooseBackgroundColor(id: string) {
    this.backgroundCharacter = id;
    const character = this.characterColors.find((item) => item.id === id);
    this.changeBackground(character ? { color: character.color } : {});
  }
  private backgroundSlider(key: "alpha" | "padding" | "radius", max: number, step = 1) {
    const value = this.settings.background?.[key] || 0;
    const scale = key === "alpha" ? 1 : (this.effectiveSize?.width || 512) / 100;
    const labels = { alpha: "backgroundAlpha", padding: "backgroundPadding", radius: "backgroundRadius" };
    return html`
      <label class="stamp-maker__slider">
        <span>
          ${this.t(labels[key])}
          <output>${Math.round(value * scale * 10) / 10}${key === "alpha" ? "%" : " px"}</output>
        </span>
        <md-slider
          class="md3-slider"
          aria-label=${this.t(labels[key])}
          min="0"
          max=${max * scale}
          step=${key === "alpha" ? step : 0.5}
          .value=${value * scale}
          @input=${(event: Event) => this.changeBackground({ [key]: Number((event.target as ValueControl).value) / scale })}
        ></md-slider>
      </label>
    `;
  }

  private resetText() {
    this.colorWasChosen = false;
    this.colorCharacter = "custom";
    this.backgroundCharacter = "custom";
    this.change({ ...defaultStampText(), text: this.settings.text });
    this.defaultCharacterColor();
  }

  private selectImageLanguage(language: string) {
    this.imageLanguage = language;
    this.mode = language === "textless" ? "textless" : "original";
  }
  private async openChooser() {
    await this.updateComplete;
    this.querySelector<HTMLDialogElement>("dialog")?.showModal();
  }

  private select(stamp: StampChoice) {
    this.selected = stamp.id;
    this.querySelector<HTMLDialogElement>("dialog")?.close();
  }

  private slider(key: "size" | "rotation" | "strokeWidth", min: number, max: number, step = 1) {
    const sourceWidth = this.effectiveSize?.width || 512;
    const pixels = key === "size" || key === "strokeWidth";
    const displayed = pixels ? (this.settings[key] * sourceWidth) / 100 : this.settings[key];
    return html`
      <label class="stamp-maker__slider">
        <span>
          ${this.t(key)}
          <output>
            ${pixels ? (key === "size" ? Math.round(displayed) : Math.round(displayed * 10) / 10) : displayed}${pixels ? " px" : key === "rotation" ? "°" : "%"}
          </output>
        </span>
        <md-slider
          class="md3-slider"
          aria-label=${this.t(key)}
          min=${pixels ? (key === "size" ? Math.max(1, Math.round((min * sourceWidth) / 100)) : (min * sourceWidth) / 100) : min}
          max=${pixels ? (max * sourceWidth) / 100 : max}
          step=${pixels ? (key === "size" ? 1 : 0.5) : step}
          .value=${displayed}
          @input=${(event: Event) => this.change({ [key]: Number((event.target as ValueControl).value) * (pixels ? 100 / sourceWidth : 1) })}
        ></md-slider>
      </label>
    `;
  }

  render() {
    const textlessCount = textlessChoices(this.originals, this.textless, this.server).length;
    return html`
      <section class="stamp-maker" lang=${this.locale}>
        <div class="stamp-maker__source field-stack">
          <div class="stamp-maker__row">
            <button
              class="button button--tonal"
              type="button"
              @click=${this.openChooser}
              ?disabled=${this.catalogLoading || this.catalogError}
            >
              ${icon("image", 20)}
              <span>${this.t("choose")}</span>
            </button>
            <span class="stamp-maker__chosen">${this.choice?.label || ""}</span>
          </div>
          ${
            this.manifestError
              ? html`
                  <p class="field-note" role="alert">
                    ${this.t("textlessFailed")}
                    <button type="button" class="button button--text" @click=${this.loadManifest}>
                      ${this.t("retry")}
                    </button>
                  </p>
                `
              : nothing
          }
        </div>
        <div class="stamp-maker__preview-pane">
          <div
            class="stamp-maker__preview"
            style=${`--stamp-aspect:${this.previewAspect}`}
            aria-busy=${String(this.catalogLoading || this.imageLoading || this.fontLoading)}
          >
            <canvas
              width="512"
              height="512"
              tabindex="0"
              role="img"
              aria-label=${this.t("preview")}
              @pointerdown=${this.pointerDown}
              @pointermove=${this.pointerMove}
              @pointerup=${this.pointerEnd}
              @pointercancel=${this.pointerEnd}
              @lostpointercapture=${() => (this.drag = undefined)}
              @keydown=${this.canvasKey}
            ></canvas>
            ${
              this.catalogLoading || this.imageLoading || this.fontLoading
                ? html`
                    <div class="stamp-maker__overlay">
                      <md-circular-progress indeterminate aria-label=${this.t("loading")}></md-circular-progress>
                    </div>
                  `
                : nothing
            }
            ${
              this.catalogError || this.imageError
                ? html`
                    <div class="stamp-maker__overlay">
                      <p role="alert">${this.t("loadFailed")}</p>
                      <button
                        type="button"
                        class="button button--tonal"
                        @click=${() => (this.catalogError ? this.loadCatalog() : this.loadImage())}
                      >
                        ${this.t("retry")}
                      </button>
                    </div>
                  `
                : nothing
            }
          </div>
        </div>
        <div class="stamp-maker__editor field-stack">
          <div class="stamp-maker__layer-row">
            <md-outlined-select
              label=${this.t("layer")}
              .value=${this.activeLayerId}
              .displayText=${`${this.layers.findIndex((layer) => layer.id === this.activeLayerId) + 1} · ${this.settings.text.trim().slice(0, 24) || this.t("text")}`}
              @change=${(event: Event) => this.selectLayer(String((event.target as ValueControl).value))}
            >
              ${[...this.layers].reverse().map(
                (layer) => html`
                  <md-select-option value=${layer.id}>
                    <div slot="headline">
                      ${this.layers.findIndex((item) => item.id === layer.id) + 1} ·
                      ${layer.settings.text.trim().slice(0, 24) || this.t("text")}
                    </div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
            ${iconButton({ label: this.t("addLayer"), icon: "add", disabled: this.layers.length >= 12, onClick: () => this.addLayer() })}
            <div class="stamp-maker__layer-menu">
              <button
                class="icon-button"
                id=${this.layerMenuId}
                type="button"
                aria-label=${this.t("layerActions")}
                aria-haspopup="menu"
                @click=${() => {
                  const menu = this.querySelector<HTMLElement & { open: boolean }>("md-menu[data-layer-menu]");
                  if (menu) menu.open = !menu.open;
                }}
              >
                ${icon("more_vert", 24)}
              </button>
              <md-menu data-layer-menu anchor=${this.layerMenuId} positioning="popover">
                <md-menu-item ?disabled=${this.layers.length >= 12} @click=${() => this.addLayer(true)}>
                  <div slot="headline">${this.t("duplicateLayer")}</div>
                </md-menu-item>
                <md-menu-item ?disabled=${this.layers.length <= 1} @click=${this.deleteLayer}>
                  <div slot="headline">${this.t("deleteLayer")}</div>
                </md-menu-item>
                <md-menu-item
                  ?disabled=${this.layers.at(-1)?.id === this.activeLayerId}
                  @click=${() => this.moveLayer(1)}
                >
                  <div slot="headline">${this.t("bringForward")}</div>
                </md-menu-item>
                <md-menu-item ?disabled=${this.layers[0]?.id === this.activeLayerId} @click=${() => this.moveLayer(-1)}>
                  <div slot="headline">${this.t("sendBackward")}</div>
                </md-menu-item>
              </md-menu>
            </div>
          </div>
          <md-outlined-text-field
            type="textarea"
            rows="2"
            maxlength="500"
            label=${this.t("text")}
            .value=${live(this.settings.text)}
            @input=${(event: Event) => this.change({ text: String((event.target as ValueControl).value).slice(0, 500) })}
          ></md-outlined-text-field>
          ${segmented({
            label: this.t("writingMode"),
            value: this.settings.writingMode,
            options: [
              { value: "horizontal", label: this.t("horizontal") },
              { value: "vertical-rl", label: `${this.t("vertical")} ←` },
              { value: "vertical-lr", label: `${this.t("vertical")} →` },
            ],
            onSelect: (writingMode) =>
              this.change({
                writingMode,
                ...(writingMode !== "horizontal" && this.settings.y === 18 ? { y: 50 } : {}),
              }),
            grow: true,
          })}
          <div class="stamp-maker__font-row">
            <md-outlined-select
              label=${this.t("font")}
              .value=${this.settings.font}
              @change=${(event: Event) => this.change({ font: String((event.target as ValueControl).value) })}
            >
              <md-select-option value="auto"><div slot="headline">${this.t("fontAuto")}</div></md-select-option>
              ${[...STAMP_FONTS, ...this.importedFonts].map(
                (font) => html`
                  <md-select-option value=${font.family}>
                    <div slot="headline">
                      ${font.family.startsWith("Noto ") ? `${this.t(font.family.startsWith("Noto Sans") ? "fontSans" : "fontSerif")} ${font.family.split(" ")[2]}` : font.family === "Pretendard SemiBold" ? this.t("fontPretendard") : font.label}
                    </div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
            ${iconButton({ label: this.t("importFont"), icon: "upload_file", onClick: () => this.querySelector<HTMLInputElement>("input[data-font-file]")?.click() })}
            <input hidden data-font-file type="file" accept=".woff2,.woff,.ttf,.otf" @change=${this.importFont} />
          </div>
          ${
            this.fontError
              ? html`
                  <p class="field-note" role="alert">
                    ${this.t("fontFailed")}
                    <button class="button button--text" type="button" @click=${this.refreshFont}>
                      ${this.t("retry")}
                    </button>
                  </p>
                `
              : nothing
          }
          ${
            stampFont(this.settings.font)?.weightRange
              ? html`
                  <label class="stamp-maker__slider">
                    <span>
                      ${this.t("fontWeight")}
                      <output>${this.settings.weight || stampFont(this.settings.font)!.weight}</output>
                    </span>
                    <md-slider
                      class="md3-slider"
                      aria-label=${this.t("fontWeight")}
                      min=${stampFont(this.settings.font)!.weightRange![0]}
                      max=${stampFont(this.settings.font)!.weightRange![1]}
                      step="100"
                      .value=${this.settings.weight || stampFont(this.settings.font)!.weight}
                      @input=${(event: Event) => this.change({ weight: Number((event.target as ValueControl).value) })}
                    ></md-slider>
                  </label>
                `
              : nothing
          }
          ${this.slider("size", 3, 25, 0.5)}
          <md-outlined-select
            aria-label=${`${this.t("fill")} ${this.settings.fill}`}
            label=${this.t("fill")}
            .value=${this.colorCharacter}
            @change=${(event: Event) => this.chooseCharacterColor(String((event.target as ValueControl).value))}
          >
            <span
              slot="leading-icon"
              class="stamp-maker__color-swatch"
              style=${`background:${this.settings.fill}`}
              aria-hidden="true"
            ></span>
            ${this.characterColors.map(
              (character) => html`
                <md-select-option value=${character.id}>
                  <span slot="start" class="stamp-maker__character-color">
                    ${
                      character.image
                        ? html`
                            <img src=${character.image} alt="" width="28" height="28" />
                          `
                        : nothing
                    }
                    <i style=${`background:${character.color}`}></i>
                  </span>
                  <div slot="headline">${character.name}</div>
                  <div slot="supporting-text">${character.color}</div>
                </md-select-option>
              `,
            )}
            <md-select-option value="custom"><div slot="headline">${this.t("customColor")}</div></md-select-option>
          </md-outlined-select>
          ${
            this.colorCharacter === "custom"
              ? html`
                  <label class="stamp-maker__custom-color">
                    ${this.t("fill")}
                    <input
                      type="color"
                      aria-label=${this.t("fill")}
                      .value=${this.settings.fill}
                      @input=${(event: Event) => {
                        this.colorWasChosen = true;
                        this.change({ fill: (event.target as HTMLInputElement).value });
                      }}
                    />
                  </label>
                `
              : nothing
          }
          ${
            this.characterError
              ? html`
                  <p class="field-note" role="alert">
                    ${clientText(this.locale, "error")}
                    <button class="button button--text" type="button" @click=${this.loadCharacters}>
                      ${this.t("retry")}
                    </button>
                  </p>
                `
              : nothing
          }
          <details class="stamp-maker__advanced">
            <summary>
              ${icon("tune", 20)}${this.t("positionStyle")}
              <span class="stamp-maker__disclosure">${icon("expand_more", 20)}</span>
            </summary>
            <div class="stamp-maker__row stamp-maker__position">
              ${(["x", "y"] as const).map(
                (axis) => html`
                  <md-outlined-text-field
                    type="number"
                    inputmode="decimal"
                    min="0"
                    max="100"
                    step="1"
                    label=${this.t(axis)}
                    suffix-text="%"
                    .value=${live(String(Math.round(this.settings[axis] * 10) / 10))}
                    @input=${(event: Event) => {
                      const value = String((event.target as ValueControl).value);
                      if (value.trim()) this.change({ [axis]: clampPosition(Number(value)) });
                    }}
                  ></md-outlined-text-field>
                `,
              )}
              ${iconButton({ label: this.t("center"), icon: "center_focus_strong", onClick: () => this.change({ x: 50, y: 50 }) })}
            </div>
            ${this.slider("rotation", -180, 180)}
            <div class="stamp-maker__row stamp-maker__colors">
              <label>
                ${this.t("stroke")}
                <input
                  type="color"
                  aria-label=${this.t("stroke")}
                  .value=${this.settings.stroke}
                  @input=${(event: Event) => this.change({ stroke: (event.target as HTMLInputElement).value })}
                />
              </label>
            </div>
            ${this.slider("strokeWidth", 0, 4, 0.1)}
            <details class="stamp-maker__background">
              <summary>${this.t("background")}</summary>
              ${segmented({
                label: this.t("background"),
                value: (this.settings.background?.alpha || 0) > 0 ? "on" : "off",
                options: [
                  { value: "off", label: this.t("noBackground") },
                  { value: "on", label: this.t("background") },
                ],
                onSelect: (value) => this.changeBackground({ alpha: value === "on" ? 100 : 0 }),
              })}
              ${
                (this.settings.background?.alpha || 0) > 0
                  ? html`
                      <md-outlined-select
                        label=${this.t("backgroundColor")}
                        .value=${this.backgroundCharacter}
                        @change=${(event: Event) => this.chooseBackgroundColor(String((event.target as ValueControl).value))}
                      >
                        <span
                          slot="leading-icon"
                          class="stamp-maker__color-swatch"
                          style=${`background:${this.settings.background!.color}`}
                          aria-hidden="true"
                        ></span>
                        ${this.characterColors.map(
                          (character) => html`
                            <md-select-option value=${character.id}>
                              <span slot="start" class="stamp-maker__character-color">
                                ${
                                  character.image
                                    ? html`
                                        <img src=${character.image} alt="" width="28" height="28" />
                                      `
                                    : nothing
                                }
                                <i style=${`background:${character.color}`}></i>
                              </span>
                              <div slot="headline">${character.name}</div>
                            </md-select-option>
                          `,
                        )}
                        <md-select-option value="custom">
                          <div slot="headline">${this.t("customColor")}</div>
                        </md-select-option>
                      </md-outlined-select>
                      ${
                        this.backgroundCharacter === "custom"
                          ? html`
                              <label class="stamp-maker__custom-color">
                                ${this.t("backgroundColor")}
                                <input
                                  type="color"
                                  aria-label=${this.t("backgroundColor")}
                                  .value=${this.settings.background!.color}
                                  @input=${(event: Event) => this.changeBackground({ color: (event.target as HTMLInputElement).value })}
                                />
                              </label>
                            `
                          : nothing
                      }
                      ${this.backgroundSlider("alpha", 100)}${this.backgroundSlider("padding", 12, 0.25)}${this.backgroundSlider("radius", 10, 0.25)}
                    `
                  : nothing
              }
            </details>
          </details>
          <div class="stamp-maker__row stamp-maker__export">
            <md-outlined-select
              label=${this.t("resolution")}
              .value=${this.outputWidth}
              @change=${(event: Event) => (this.outputWidth = String((event.target as ValueControl).value))}
            >
              ${(this.effectiveSize ? stampSizeOptions(this.effectiveSize) : []).map(
                (size) => html`
                  <md-select-option value=${size.value}>
                    <div slot="headline">${size.width} × ${size.height} px</div>
                  </md-select-option>
                `,
              )}
              <md-select-option value="native">
                <div slot="headline">
                  ${this.t("originalSize")}${this.effectiveSize ? ` · ${this.effectiveSize.width} × ${this.effectiveSize.height} px` : ""}
                </div>
              </md-select-option>
            </md-outlined-select>
            <button
              class="button button--filled"
              type="button"
              ?disabled=${!this.ready || this.exportState === "saving"}
              @click=${this.exportPng}
            >
              ${icon("download", 20)}
              <span>${this.t("export")}</span>
            </button>
            ${iconButton({ label: this.t("reset"), icon: "restart_alt", onClick: () => this.resetText() })}
          </div>
          <p class="field-note" role="status" aria-live="polite">
            ${this.exportState ? this.t(this.exportState) : nothing}
          </p>
        </div>
        <dialog
          class="stamp-maker__chooser"
          aria-label=${this.t("choose")}
          @click=${(event: MouseEvent) => {
            if (event.target === event.currentTarget) (event.currentTarget as HTMLDialogElement).close();
          }}
        >
          <header class="sheet__header">
            <strong>${this.t("choose")}</strong>
            ${iconButton({ label: this.t("close"), icon: "close", onClick: () => this.querySelector<HTMLDialogElement>("dialog")?.close() })}
          </header>
          <div class="stamp-maker__picker-language">
            <div
              class="settings-options stamp-maker__language-options"
              role="radiogroup"
              aria-label=${clientText(this.locale, "language")}
            >
              ${Object.entries(STAMP_LANGUAGES)
                .filter(([language]) =>
                  this.originals.some((stamp) => stamp.variants.some((version) => version.language === language)),
                )
                .map(
                  ([language, option]) => html`
                    <label class="settings-option" title=${option.label}>
                      <input
                        type="radio"
                        name="stamp-variant-language"
                        value=${language}
                        .checked=${this.mode === "original" && (this.imageLanguage || this.originalVariant?.language) === language}
                        aria-label=${option.label}
                        @change=${() => this.selectImageLanguage(language)}
                      />
                      <span class="settings-option__face" aria-hidden="true">
                        <span class="settings-option__image">
                          <img src=${option.flag} width="28" height="28" alt="" />
                        </span>
                      </span>
                      <span class="settings-option__tooltip" aria-hidden="true">${option.label}</span>
                      <span class="stamp-maker__variant-caption" aria-hidden="true">${option.label}</span>
                    </label>
                  `,
                )}
              ${
                textlessCount
                  ? html`
                      <label class="settings-option" title=${this.t("textless")}>
                        <input
                          type="radio"
                          name="stamp-variant-language"
                          value="textless"
                          .checked=${this.mode === "textless"}
                          aria-label=${this.t("textless")}
                          @change=${() => this.selectImageLanguage("textless")}
                        />
                        <span class="settings-option__face" aria-hidden="true">${icon("format_clear", 24)}</span>
                        <span class="settings-option__tooltip" aria-hidden="true">${this.t("textless")}</span>
                        <span class="stamp-maker__variant-caption" aria-hidden="true">${this.t("textless")}</span>
                      </label>
                    `
                  : nothing
              }
            </div>
          </div>
          <div class="collection stamp-maker__grid">
            ${this.choices.map((stamp) =>
              tile({
                kind: "stamp",
                title: stamp.label,
                label: stamp.label,
                subtitle:
                  this.mode === "textless"
                    ? null
                    : this.versionLabel(
                        stamp.variants.find((version) => version.url === stamp.sources[0])?.language || "original",
                      ),
                image: stamp.sources[0],
                aspectRatio: 1,
                fit: "contain",
                selected: stamp.id === this.selected,
                imageCandidates: stamp.sources,
                onOpen: () => this.select(stamp),
              }),
            )}
          </div>
        </dialog>
      </section>
    `;
  }
}

if (!customElements.get("stamp-maker")) customElements.define("stamp-maker", StampMaker);
