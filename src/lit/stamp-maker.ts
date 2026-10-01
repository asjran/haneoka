import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/progress/circular-progress.js";
import { clientText, getI18nClient } from "../i18n/client";
import { canvasToPngBlob, downloadBlob } from "../lib/canvas-capture";
import { beginLoading } from "../lib/loading-progress";
import { readReleaseServer } from "../lib/release-server";
import {
  stampChoices,
  textlessChoices,
  textlessManifestUrl,
  loadStampImage,
  loadStampFile,
  type StampChoice,
} from "../lib/stamp-maker/catalog";
import {
  clampPosition,
  defaultStampText,
  drawStamp,
  hitStampText,
  loadStampFont,
  STAMP_FONTS,
  type StampText,
} from "../lib/stamp-maker/render";
import { catalogUrl, fetchJson, type JsonRecord } from "./shared/catalog";
import { segmented, iconButton } from "./ui/controls";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";
import { LazyImages } from "./ui/lazy-images";

import { stampOutputSize, stampSizeOptions, type StampSize } from "../lib/stamp-maker/sizes";

import { stampCharacterColors } from "../lib/stamp-maker/colors";

import { STAMP_LANGUAGES } from "../lib/stamp-maker/languages";

import { registerImportedFont, removeImportedFont, type StampFont } from "../lib/stamp-maker/fonts";

type Mode = "original" | "textless" | "custom";
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
    customFile: { state: true },
    importedFonts: { state: true },
    fontError: { state: true },
    imageLanguage: { state: true },
    characters: { state: true },
    characterError: { state: true },
    colorCharacter: { state: true },
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
  declare customFile: File | undefined;
  declare importedFonts: StampFont[];
  declare fontError: boolean;
  declare imageLanguage: string;
  declare characters: JsonRecord;
  declare characterError: boolean;
  declare colorCharacter: string;
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
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
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
    if (this.settings.font.startsWith("StampMakerLocal")) this.change({ font: "auto" });
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
      changed.has("customFile") ||
      changed.has("locale") ||
      changed.has("imageLanguage")
    ) {
      if (this.mode === "textless" && !textlessChoices(this.originals, this.textless, this.server).length)
        this.mode = "original";
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
          previous.size !== this.settings.size))
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
    if (this.mode === "custom" && this.customFile)
      return {
        id: "custom",
        resourceName: this.customFile.name.replace(/\.[^.]+$/, ""),
        label: this.customFile.name,
        sources: [],
        variants: [],
        characterIds: [],
      };
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
    if (this.colorWasChosen || this.mode === "custom") return;
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
    if (character) this.change({ fill: character.color });
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
      const image =
        this.mode === "custom" && this.customFile
          ? await loadStampFile(this.customFile, request.signal)
          : await loadStampImage(choice.sources, request.signal);
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
    this.settings = { ...this.settings, ...values };
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
      this.settings,
      this.fallbackFont,
      getComputedStyle(this).getPropertyValue("--md-sys-color-primary").trim(),
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
    if (!hitStampText(canvas, this.settings, this.fallbackFont, x, y)) return;
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
    if (!direction || !this.ready || !this.settings.text.trim()) return;
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
    const settings = { ...this.settings };
    const fallback = this.fallbackFont;
    const resourceName = `${this.choice?.resourceName || "stamp"}${this.mode === "original" && this.originalVariant ? `-${this.originalVariant.language}` : ""}`;
    const sourceSize = this.effectiveSize;
    if (!sourceSize) return;
    const { width, height } = stampOutputSize(sourceSize, this.outputWidth);
    this.exportState = "saving";
    try {
      await loadStampFont(settings, fallback);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      drawStamp(canvas, image, settings, fallback);
      await downloadBlob(await canvasToPngBlob(canvas), `${resourceName}-${width}x${height}.png`);
      this.exportState = "saved";
    } catch {
      this.exportState = "failed";
    }
  }

  private importImage(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) {
      this.imageError = true;
      return;
    }
    this.customFile = file;
    this.mode = "custom";
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
      if (this.importedFaces.length > 8) {
        const oldest = this.importedFaces.shift()!;
        removeImportedFont(oldest);
        this.importedFonts = this.importedFonts.filter((item) => item.family !== oldest.family);
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

  private resetText() {
    this.colorWasChosen = false;
    this.colorCharacter = "custom";
    this.change({ ...defaultStampText(), text: this.settings.text });
    this.defaultCharacterColor();
  }

  private async openChooser() {
    await this.updateComplete;
    this.querySelector<HTMLDialogElement>("dialog")?.showModal();
  }

  private select(stamp: StampChoice) {
    if (this.mode === "custom") this.mode = "original";
    this.selected = stamp.id;
    this.querySelector<HTMLDialogElement>("dialog")?.close();
  }

  private slider(key: "size" | "rotation" | "strokeWidth", min: number, max: number, step = 1) {
    return html`
      <label class="stamp-maker__slider">
        <span>
          ${this.t(key)}
          <output>${this.settings[key]}${key === "rotation" ? "°" : "%"}</output>
        </span>
        <md-slider
          class="md3-slider"
          aria-label=${this.t(key)}
          min=${min}
          max=${max}
          step=${step}
          .value=${this.settings[key]}
          @input=${(event: Event) => this.change({ [key]: Number((event.target as ValueControl).value) })}
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
            <button
              class="button button--text"
              type="button"
              @click=${() => this.querySelector<HTMLInputElement>("input[data-image-file]")?.click()}
            >
              ${icon("upload", 20)}
              <span>${this.t("importImage")}</span>
            </button>
            <input
              hidden
              data-image-file
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              @change=${this.importImage}
            />
            <span class="stamp-maker__chosen">${this.choice?.label || ""}</span>
          </div>
          ${
            textlessCount || this.customFile
              ? segmented({
                  label: this.t("source"),
                  value: this.mode,
                  options: [
                    { value: "original", label: this.t("original") },
                    ...(textlessCount ? [{ value: "textless" as const, label: this.t("textless") }] : []),
                    ...(this.customFile ? [{ value: "custom" as const, label: this.t("customImage") }] : []),
                  ],
                  onSelect: (mode) => (this.mode = mode),
                })
              : nothing
          }
          ${
            this.mode === "original" && this.choice?.variants.length
              ? html`
                  <div class="stamp-maker__language">
                    <span class="stamp-maker__language-label">
                      ${clientText(this.locale, "language")} ·
                      ${this.versionLabel(this.originalVariant?.language || "original")}
                    </span>
                    <div
                      class="settings-options stamp-maker__language-options"
                      role="radiogroup"
                      aria-label=${clientText(this.locale, "language")}
                    >
                      ${this.choice.variants.map(
                        (version) => html`
                          <label class="settings-option" title=${this.versionLabel(version.language)}>
                            <input
                              type="radio"
                              name="stamp-image-language"
                              value=${version.language}
                              .checked=${this.originalVariant?.language === version.language}
                              aria-label=${this.versionLabel(version.language)}
                              @change=${() => (this.imageLanguage = version.language)}
                            />
                            <span class="settings-option__face" aria-hidden="true">
                              ${
                                STAMP_LANGUAGES[version.language]
                                  ? html`
                                      <span class="settings-option__image">
                                        <img
                                          src=${STAMP_LANGUAGES[version.language].flag}
                                          width="28"
                                          height="28"
                                          alt=""
                                        />
                                      </span>
                                    `
                                  : icon("image", 24)
                              }
                            </span>
                            <span class="settings-option__tooltip" aria-hidden="true">
                              ${this.versionLabel(version.language)}
                            </span>
                          </label>
                        `,
                      )}
                    </div>
                  </div>
                `
              : nothing
          }
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
            aria-busy=${String((this.mode !== "custom" && this.catalogLoading) || this.imageLoading || this.fontLoading)}
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
              (this.mode !== "custom" && this.catalogLoading) || this.imageLoading || this.fontLoading
                ? html`
                    <div class="stamp-maker__overlay">
                      <md-circular-progress indeterminate aria-label=${this.t("loading")}></md-circular-progress>
                    </div>
                  `
                : nothing
            }
            ${
              (this.mode !== "custom" && this.catalogError) || this.imageError
                ? html`
                    <div class="stamp-maker__overlay">
                      <p role="alert">${this.t("loadFailed")}</p>
                      <button
                        type="button"
                        class="button button--tonal"
                        @click=${() => (this.mode !== "custom" && this.catalogError ? this.loadCatalog() : this.loadImage())}
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
          <md-outlined-text-field
            type="textarea"
            rows="2"
            maxlength="500"
            label=${this.t("text")}
            .value=${live(this.settings.text)}
            @input=${(event: Event) => this.change({ text: String((event.target as ValueControl).value).slice(0, 500) })}
          ></md-outlined-text-field>
          ${segmented({
            label: this.t("text"),
            value: this.settings.writingMode === "horizontal" ? "horizontal" : "vertical",
            options: [
              { value: "horizontal", label: this.t("horizontal") },
              { value: "vertical", label: this.t("vertical") },
            ],
            onSelect: (value) =>
              this.change({
                writingMode: value === "horizontal" ? "horizontal" : "vertical-rl",
                ...(value === "vertical" && this.settings.y === 18 ? { y: 50 } : {}),
              }),
          })}
          ${
            this.settings.writingMode !== "horizontal"
              ? segmented({
                  label: this.t("columnOrder"),
                  value: this.settings.writingMode,
                  options: [
                    { value: "vertical-rl", label: this.t("rightToLeft") },
                    { value: "vertical-lr", label: this.t("leftToRight") },
                  ],
                  onSelect: (writingMode) => this.change({ writingMode }),
                })
              : nothing
          }
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
                    ${font.family.startsWith("Noto ") ? `${this.t(font.family.startsWith("Noto Sans") ? "fontSans" : "fontSerif")} ${font.family.split(" ")[2]} · 900` : `${font.label}${font.weight === 900 ? " · 900" : ""}`}
                  </div>
                </md-select-option>
              `,
            )}
          </md-outlined-select>
          <div class="stamp-maker__row">
            <button
              class="button button--text"
              type="button"
              @click=${() => this.querySelector<HTMLInputElement>("input[data-font-file]")?.click()}
            >
              ${icon("upload", 20)}
              <span>${this.t("importFont")}</span>
            </button>
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
          ${this.slider("size", 3, 25, 0.5)}
          <md-outlined-select
            label=${this.t("fill")}
            .value=${this.colorCharacter}
            @change=${(event: Event) => this.chooseCharacterColor(String((event.target as ValueControl).value))}
          >
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
            <summary>${icon("tune", 20)}${this.t("positionStyle")}</summary>
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
