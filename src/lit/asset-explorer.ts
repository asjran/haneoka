import { navigationDocumentUrl } from "../lib/document-url";
import { LitElement, html, nothing } from "lit";
import { emptyState, errorState, loadingState } from "./ui/state";
import { catalogUrl, fetchJson, currentReleaseServer, preferredLocale, uiText } from "./shared/catalog";
import { localizedFallbacks } from "../lib/localized-text";
import { localeFromPath } from "../i18n/locales";
import { clearAppBarIdentity, setAppBarIdentity, setAppBarSearch } from "../lib/app-bar";
import { icon } from "./ui/icon";
import { indexSourceTree, plainSourceName, searchSourceTree, sourceEntries, sourceVariant, type SourceNode as AssetNode, type SourceSearchRow } from "../lib/source-tree-search";
type Descriptor = { outputs?: Array<{ path?: string }>; objectArchive?: { path?: string } };

export class AssetExplorer extends LitElement {
  static properties = {
    tree: { state: true },
    path: { state: true },
    files: { state: true },
    selected: { state: true },
    phase: { state: true },
    error: { state: true },
    textPreview: { state: true },
    query: { state: true },
  };
  declare tree: Record<string, AssetNode>;
  declare path: string[];
  declare files: string[];
  declare selected: string;
  declare phase: "loading" | "ready" | "error";
  declare error: string;
  declare textPreview: string;
  declare query: string;
  private columnSignature = "";
  private rows: SourceSearchRow[] = [];
  private releaseSearch?: () => void;
  constructor() {
    super();
    this.tree = {};
    this.path = [];
    this.files = [];
    this.selected = "";
    this.phase = "loading";
    this.error = "";
    this.textPreview = "";
    this.query = "";
  }
  createRenderRoot() {
    return this;
  }
  updated() {
    if (this.path.length || this.selected)
      setAppBarIdentity(
        "asset-explorer",
        html`<div class="browse__crumbs">${this.path.map(
          (part, index) => html`${icon("chevron_right", 20)}<button type="button" class="chip" @click=${() => this.choose(this.path.slice(0, index + 1))}>${AssetExplorer.plainName(part)}</button>`,
        )}${this.selected ? html`${icon("chevron_right", 20)}<span class="chip">${AssetExplorer.plainName(this.displayName(this.selected).split("/").at(-1) || "")}</span>` : nothing}</div>`,
        this,
      );
    else clearAppBarIdentity("asset-explorer");
    requestAnimationFrame(() => {
      const crumbs = document.querySelector<HTMLElement>(".top-app-bar .browse__crumbs");
      if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth;
    });
    // Miller columns: keep the newest column in view at every width.
    const signature = JSON.stringify([this.phase, this.path, this.selected, this.files.length, this.query]);
    if (signature === this.columnSignature) return;
    this.columnSignature = signature;
    requestAnimationFrame(() => {
      const columns = this.querySelector<HTMLElement>(".asset-columns");
      if (columns && (this.path.length || this.selected))
        columns.scrollTo({ left: columns.scrollWidth, behavior: "smooth" });
    });
  }
  /** Original path → the variant the interface language resolves to. */
  private variants = new Map<string, string>();
  private static parseVariant(file: string) {
    return sourceVariant(file);
  }
  /**
   * The release stores one file per language, stitched in at build time
   * (`kadan.png` plus `kadan(zh-Hans).png`, ...). The listing keeps only the
   * source file; opening it resolves to the visitor language's variant
   * through the usual zh fallback order, under the source filename.
   */
  private rebuildVariants(siblings: readonly string[]) {
    this.variants = new Map();
    const byBase = new Map<string, Map<string, string>>();
    for (const file of siblings) {
      const variant = AssetExplorer.parseVariant(file);
      if (!variant) continue;
      // Key by the full source path (extension included): that is the name
      // the listing shows and the name lookups arrive with.
      const original = `${variant.base}${variant.ext ?? ""}`;
      let marks = byBase.get(original);
      if (!marks) byBase.set(original, (marks = new Map()));
      marks.set(variant.mark, file);
    }
    if (!byBase.size) return;
    for (const [base, marks] of byBase) {
      for (const language of localizedFallbacks(preferredLocale())) {
        // ja resolves to the source file itself: no mapping, listing name.
        if (language === "ja") break;
        const hit = marks.get(language);
        if (hit) {
          this.variants.set(base, hit);
          break;
        }
      }
    }
  }
  private localized(file: string) {
    return this.variants.get(file) ?? file;
  }
  /** Variants display under the source filename in the listing. */
  private displayName(file: string) {
    for (const [original, variant] of this.variants) {
      if (variant === file) return original;
    }
    return file;
  }
  private onLocale = () => {
    this.rows = indexSourceTree(this.tree, localizedFallbacks(preferredLocale()));
    this.rebuildVariants(this.siblingNames());
    this.sync();
    if (this.selected) void this.prepareSelected(this.selected);
  };
  connectedCallback() {
    super.connectedCallback();
    addEventListener("haneoka:locale-ready", this.onLocale);
    void import("@material/web/progress/circular-progress.js");
    const documentUrl = navigationDocumentUrl();
    const params = documentUrl.searchParams;
    const routePath = documentUrl.pathname.replace(
      /^\/(?:(?:jp|intl|jp-cbt|intl-cbt)\/(?:ja|en|zh-TW|zh-CN|ko)\/assets|(?:ja|en|zh-TW|zh-CN|ko)\/catalog\/assets)\/?/u,
      "",
    );
    this.path = (routePath || params.get("path") || "")
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    this.selected = params.get("file") || "";
    this.query = params.get("q") || "";
    this.releaseSearch = setAppBarSearch("asset-explorer", {
      value: this.query,
      label: uiText(preferredLocale(), "common.actions.search"),
      onInput: (value) => {
        this.query = value;
        this.sync();
      },
    });
    void this.loadTree();
  }
  disconnectedCallback() {
    removeEventListener("haneoka:locale-ready", this.onLocale);
    this.releaseSearch?.();
    clearAppBarIdentity("asset-explorer");
    super.disconnectedCallback();
  }
  private siblingNames(): string[] {
    const folderNode = this.node(this.path.slice(0, -1));
    const folder = this.path.slice(0, -1).join("/");
    return folderNode && typeof folderNode === "object"
      ? Object.keys(folderNode).map((name) => `${folder}/${name}`)
      : [];
  }
  private node(parts = this.path): AssetNode | undefined {
    let current: AssetNode = this.tree;
    for (const part of parts) {
      if (!current || typeof current !== "object") return undefined;
      current = current[part];
    }
    return current;
  }
  /** Language marks never appear in a shown name: `foo(zh-Hans).png` reads as `foo.png`. */
  private static plainName(name: string) {
    return plainSourceName(name);
  }
  /**
   * One entry per logical file. A source with variants lists once, under its
   * own name; a file that exists only as language variants lists once too,
   * under the plain name, opening the visitor language's variant.
   */
  private entries(parts: string[]) {
    const node = this.node(parts);
    if (!node || typeof node !== "object") return [];
    return sourceEntries(node, localizedFallbacks(preferredLocale()));
  }
  private async loadTree() {
    try {
      this.tree = await fetchJson<Record<string, AssetNode>>(catalogUrl("sources/tree"));
      this.rows = indexSourceTree(this.tree, localizedFallbacks(preferredLocale()));
      this.phase = "ready";
      this.rebuildVariants(this.siblingNames());
      if (typeof this.node() === "number") await this.loadFiles();
      if (this.selected) await this.prepareSelected(this.selected);
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private sync() {
    const params = new URLSearchParams();
    if (this.query.trim()) params.set("q", this.query.trim());
    if (this.selected) params.set("file", this.selected);
    const locale = localeFromPath(location.pathname) || preferredLocale();
    const pathname = `/${this.server()}/${locale}/assets/${this.path.map(encodeURIComponent).join("/")}${this.path.length ? "/" : ""}`;
    history.replaceState(history.state, "", `${pathname}${params.size ? `?${params}` : ""}`);
  }
  private async choose(parts: string[]) {
    this.path = parts;
    this.files = [];
    this.selected = "";
    this.textPreview = "";
    this.error = "";
    this.sync();
    if (typeof this.node() === "number") await this.loadFiles();
  }
  private async loadFiles() {
    try {
      this.rebuildVariants(this.siblingNames());
      const path = this.path.join("/");
      const descriptor = await fetchJson<Descriptor>(catalogUrl(`sources/${this.localized(path)}`));
      if (this.path.join("/") !== path) return;
      this.files = [
        ...(descriptor.outputs || []).map((value) => String(value.path || "")).filter(Boolean),
        ...(descriptor.objectArchive?.path ? [descriptor.objectArchive.path] : []),
      ];
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private url(file: string) {
    const [root, ...parts] = this.localized(file).split("/").filter(Boolean);
    return ["assets", "runtime", "objects"].includes(root || "")
      ? `/${root}/${encodeURIComponent(this.server())}/${parts.map(encodeURIComponent).join("/")}`
      : "";
  }
  private server() {
    return currentReleaseServer();
  }
  private kind(file: string) {
    const ext = file.split(".").pop()?.toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext || "")) return "image";
    if (["mp3", "wav", "ogg", "m4a"].includes(ext || "")) return "audio";
    if (["mp4", "webm"].includes(ext || "")) return "video";
    if (["glb", "gltf"].includes(ext || "")) return "model";
    if (["json", "txt", "xml", "csv", "md", "atlas"].includes(ext || "")) return "text";
    return "binary";
  }
  private async select(file: string) {
    this.selected = file;
    this.textPreview = "";
    this.sync();
    await this.prepareSelected(file);
  }
  private async prepareSelected(file: string) {
    if (this.kind(file) === "text") {
      try {
        const response = await fetch(this.url(file));
        this.textPreview = (await response.text()).slice(0, 200000);
      } catch {
        this.textPreview = uiText(preferredLocale(), "common.states.unavailable");
      }
    }
    if (this.kind(file) === "model") await import("./runtime/model-preview");
  }
  render() {
    const matches = this.query.trim() ? searchSourceTree(this.rows, this.query) : null;
    const columns: Array<{ parts: string[]; entries: Array<{ name: string; label: string; value: AssetNode }> }> = [];
    for (let depth = 0; depth <= this.path.length; depth++) {
      const parts = this.path.slice(0, depth),
        entries = this.entries(parts);
      if (!entries.length) break;
      columns.push({ parts, entries });
    }
    return html`
      <section class="asset-workspace">
        ${
          this.phase === "loading"
            ? html`
                ${loadingState(uiText(preferredLocale(), "common.states.loading"))}
              `
            : this.phase === "error"
              ? errorState(
                  uiText(preferredLocale(), "common.states.unavailable"),
                  uiText(preferredLocale(), "common.actions.retry"),
                  () => void this.loadTree(),
                  this.error,
                )
              : html`
                  <div class="asset-columns">
                    ${matches && !matches.length ? emptyState({ title: uiText(preferredLocale(), "common.states.empty"), icon: "search" }) : matches ? html`
                      <section class="asset-column asset-column--results">
                        ${matches.map(
                          (row) => html`
                            <button class=${this.path.join("/") === row.path ? "selected" : ""} title=${row.label} @click=${() => this.choose([...row.parts])}>
                              <svg class="material-icon" width="20" height="20"><use href="/icons.svg#inventory_2"></use></svg>
                              <span>${row.label.split("/").at(-1)}<small>${row.label.split("/").slice(0, -1).join("/")}</small></span>
                              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#chevron_right"></use></svg>
                            </button>
                          `,
                        )}
                      </section>
                    ` : columns.map(
                      (column, index) => html`
                        <section class="asset-column">
                          ${column.entries.map(
                            ({ name, label, value }) => html`
                              <button
                                class=${this.path[index] === name ? "selected" : ""}
                                @click=${() => this.choose([...column.parts, name])}
                              >
                                <svg class="material-icon" width="20" height="20">
                                  <use
                                    href=${typeof value === "number" ? "/icons.svg#inventory_2" : "/icons.svg#folder"}
                                  ></use>
                                </svg>
                                <span>${label}</span>
                                <small>${typeof value === "number" ? value : Object.keys(value).length}</small>
                                <svg class="material-icon" width="18" height="18">
                                  <use href="/icons.svg#chevron_right"></use>
                                </svg>
                              </button>
                            `,
                          )}
                        </section>
                      `,
                    )}${
                      typeof this.node() === "number"
                        ? html`
                            <section class="asset-column">
                              ${this.files.map(
                                (file) => html`
                                  <button
                                    class=${this.selected === file ? "selected" : ""}
                                    @click=${() => this.select(file)}
                                  >
                                    <svg class="material-icon" width="20" height="20">
                                      <use
                                        href=${`/icons.svg#${this.kind(file) === "image" ? "image" : this.kind(file) === "audio" ? "graphic_eq" : this.kind(file) === "video" ? "movie" : this.kind(file) === "model" ? "view_in_ar" : this.kind(file) === "text" ? "data_object" : "draft"}`}
                                      ></use>
                                    </svg>
                                    <span>${AssetExplorer.plainName(this.displayName(file).split("/").at(-1) || "")}</span>
                                  </button>
                                `,
                              )}
                            </section>
                          `
                        : nothing
                    }${this.selected ? this.renderPreview() : nothing}
                  </div>
                `
        }
      </section>
    `;
  }
  private renderPreview() {
    const url = this.url(this.selected),
      kind = this.kind(this.selected);
    return html`
      <section class="asset-preview">
        <a class="icon-button asset-preview__download" href=${url} download aria-label=${uiText(preferredLocale(), "common.actions.download")} title=${uiText(preferredLocale(), "common.actions.download")}>${icon("download", 20)}</a>
        <div>
          ${
            kind === "image"
              ? html`
                  <img src=${url} alt="" />
                `
              : kind === "audio"
                ? html`
                    <audio src=${url} controls></audio>
                  `
                : kind === "video"
                  ? html`
                      <video src=${url} controls></video>
                    `
                  : kind === "model"
                    ? html`
                        <model-preview-stage src=${url}></model-preview-stage>
                      `
                    : kind === "text"
                      ? html`
                          <pre>${this.textPreview}</pre>
                        `
                      : html`
                          <div class="notice">
                            <svg class="material-icon" width="40" height="40"><use href="/icons.svg#draft"></use></svg>
                            <p>${uiText(preferredLocale(), "navigation.assetOther")}</p>
                          </div>
                        `
          }
        </div>
      </section>
    `;
  }
}
customElements.define("asset-explorer", AssetExplorer);
