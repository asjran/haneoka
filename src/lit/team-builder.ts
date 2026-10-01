import { LitElement, html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/progress/linear-progress.js";
import { clientText } from "../i18n/client";
import { resolveLocalizedText } from "../lib/localized-text";
import { readPageData } from "../lib/page-data";
import { readReleaseServer } from "../lib/release-server";
import { fetchTeamBuilderData } from "../lib/team-builder/data/fetch";
import { clearAppBarActions, setAppBarActions, clearAppBarSearch, setAppBarSearch } from "../lib/app-bar";
import { dataRows, type TeamBuilderData, type MemberCatalog, type SnapshotCatalog } from "../lib/team-builder/data";
import type {
  Objective,
  PlayMode,
  SearchConstraints,
  SearchResult,
  SearchProgress,
  OptimizationInput,
  SolverResponse,
  WorkerPreparationInput,
} from "../lib/team-builder/contracts";
import {
  addInventoryEntry,
  updateInventoryEntries,
  removeInventoryEntry,
  validateInventory,
  practiceRanges,
  type InventoryV1,
  type MemberEntry,
  type SnapshotEntry,
} from "../lib/team-builder/inventory";
import { renderPane, PaneFocus } from "./ui/pane";
import { specList } from "./ui/spec";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { segmented, iconButton, rovingKeydown } from "./ui/controls";
import { tile, tileMedia, type TileOptions } from "./ui/tile";
import { LazyImages } from "./ui/lazy-images";
import { difficultyKey, difficultyPicker } from "./ui/difficulty-picker";
import { loadingState } from "./ui/state";
import {
  InventoryStore,
  importInventory,
  exportInventory,
  type InventoryStoreState,
} from "../lib/team-builder/storage";
import { downloadBlob } from "../lib/canvas-capture";

type Kind = "members" | "snapshots";
type Panel = "library" | "goals" | "results";
type Control = HTMLElement & { value: string; checked: boolean };
const OWNER = "team-builder";
const OBJECTIVES: Objective[] = ["base-score", "score", "ss-surplus", "event-points", "event-items"];
const MODES: PlayMode[] = ["normal", "gekiso", "multi", "battle"];

export class TeamBuilder extends LitElement {
  static properties = {
    locale: {},
    server: {},
    data: { attribute: false },
    inventory: { state: true },
    panel: { state: true },
    kind: { state: true },
    mode: { state: true },
    objectives: { state: true },
    excludeJust: { state: true },
    justRate: { state: true },
    budgetSeconds: { state: true },
    selectedSong: { state: true },
    selectedDifficulty: { state: true },
    selectedEvent: { state: true },
    error: { state: true },
    result: { state: true },
    progress: { state: true },
    running: { state: true },
    searchStatus: { state: true },
    picker: { state: true },
    query: { state: true },
    selectedIds: { state: true },
    bulkField: { state: true },
    bulkValue: { state: true },
    saveState: { state: true },
    visibleLimit: { state: true },
    mergePriority: { state: true },
    optimizationInput: { attribute: false },
    addingCards: { state: true },
    editingId: { state: true },
    pickerBand: { state: true },
    pickerRarity: { state: true },
  };
  declare locale: string;
  declare server: string;
  declare data: TeamBuilderData | null;
  declare inventory: InventoryV1 | null;
  declare panel: Panel;
  declare kind: Kind;
  declare mode: PlayMode;
  declare objectives: Objective[];
  declare excludeJust: boolean;
  declare justRate: number;
  declare budgetSeconds: number;
  declare selectedSong: string;
  declare selectedDifficulty: string;
  declare selectedEvent: string;
  declare error: string;
  declare result: SearchResult | null;
  declare progress: SearchProgress | null;
  declare running: boolean;
  declare searchStatus: string;
  declare picker: string;
  declare query: string;
  declare selectedIds: Set<string>;
  declare bulkField: string;
  declare bulkValue: number | null;
  declare saveState: string;
  declare visibleLimit: number;
  declare mergePriority: "cloud" | "draft";
  declare optimizationInput: OptimizationInput | null;
  declare addingCards: boolean;
  declare editingId: string;
  declare pickerBand: string;
  declare pickerRarity: string;
  private images = new LazyImages();
  private paneFocus = new PaneFocus();
  private worker?: Worker;
  private requestId = 0;
  private store?: InventoryStore;
  private storeState: InventoryStoreState | null = null;
  private authController?: AbortController;
  private authGeneration = 0;
  private currentOwner: string | null | undefined;
  private dataController?: AbortController;
  private readonly refreshAccount = () => {
    void this.checkAccount();
  };
  private readonly localeReady = () => this.requestUpdate();

  private bindStore(): void {
    if (!this.data) return;
    try {
      this.store = new InventoryStore(this.data, {
        storage: localStorage,
        onChange: (state) => {
          this.storeState = state;
          this.saveState = state.phase;
          if (state.phase === "loading" || state.phase === "auth-loading") this.closePane();
          if (state.inventory) this.inventory = state.inventory;
          else if (state.ownerId !== this.currentOwner && this.currentOwner) this.inventory = null;
          this.requestUpdate();
        },
      });
      void this.checkAccount();
    } catch {
      this.saveState = "error";
      this.error = this.t("saveFailed", "Save failed. Your draft is retained.");
    }
  }
  private async loadSource(server: string): Promise<void> {
    this.cancelSearch();
    this.closePane();
    this.authController?.abort();
    ++this.authGeneration;
    this.store?.dispose();
    this.store = undefined;
    this.storeState = null;
    this.currentOwner = undefined;
    this.inventory = null;
    this.result = null;
    this.optimizationInput = null;
    this.selectedIds = new Set();
    this.dataController?.abort();
    const controller = (this.dataController = new AbortController());
    this.server = server;
    this.data = null;
    this.error = "";
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const data = await fetchTeamBuilderData(server, controller.signal);
      if (this.dataController !== controller || !this.isConnected) return;
      this.data = data;
      this.bindStore();
    } catch {
      if (this.dataController === controller && this.isConnected) {
        this.saveState = "error";
        this.error = this.t("dataError", "Could not load card data.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async checkAccount(force = false): Promise<void> {
    if (!this.store || !this.data || readReleaseServer() !== this.data.identity.server) return;
    this.authController?.abort();
    const controller = (this.authController = new AbortController());
    const generation = ++this.authGeneration;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);
    try {
      const response = await fetch("/api/auth/get-session", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("session-unavailable");
      const session = (await response.json()) as { user?: { id?: string } } | null;
      if (generation !== this.authGeneration || !this.isConnected) return;
      if (session !== null && (typeof session !== "object" || (session.user && typeof session.user.id !== "string")))
        throw new Error("session-shape");
      const owner = typeof session?.user?.id === "string" ? session.user.id : null;
      if (owner !== this.currentOwner || force) {
        this.cancelSearch();
        this.result = null;
        await this.store.setAccount(owner);
        if (generation !== this.authGeneration || !this.isConnected) return;
        this.currentOwner = owner;
      }
    } catch {
      if ((!controller.signal.aborted || timedOut) && generation === this.authGeneration) {
        this.error = this.t("authUnavailable", "Sign-in status could not be checked.");
        if (this.currentOwner === undefined) this.saveState = "auth-error";
      }
    } finally {
      clearTimeout(timer);
    }
  }
  private get canEdit(): boolean {
    return Boolean(
      this.storeState?.inventory &&
      ["anonymous", "saved", "pending", "saving", "offline"].includes(this.storeState.phase),
    );
  }
  private renderStorage() {
    const labels: Record<string, string> = {
      "auth-loading": "authLoading",
      "auth-error": "authUnavailable",
      loading: "cloudLoading",
      anonymous: "local",
      saved: "saved",
      pending: "saving",
      saving: "saving",
      offline: "saveFailed",
      error: "saveFailed",
      conflict: "conflict",
      "merge-required": "merge",
      "release-mismatch": "releaseMismatch",
    };
    const label = this.t(labels[this.saveState] ?? "authLoading", "Checking sign-in status");
    return html`
      <section class="team-builder__section">
        <div class="team-builder__actions">
          <span role="status">${label}</span>
          ${
            !this.storeState?.ownerId
              ? html`
                  <a
                    class="button button--text"
                    href=${`/${this.locale}/account/?next=${encodeURIComponent(`/${this.locale}/team-builder/?server=${this.server}`)}`}
                  >
                    ${this.t("signIn", "Sign in to Haneoka")}
                  </a>
                `
              : nothing
          }
          ${
            ["error", "offline", "auth-error"].includes(this.saveState)
              ? html`
                  <button
                    class="button button--outlined"
                    @click=${() => {
                      if (this.saveState === "offline") void this.store?.saveNow();
                      else void this.checkAccount(true);
                    }}
                  >
                    ${this.t("retrySave", "Retry save")}
                  </button>
                `
              : nothing
          }
        </div>
        ${
          this.saveState === "merge-required" || this.saveState === "conflict"
            ? html`
                <div class="team-builder__actions">
                  ${this.select(
                    this.t("mergePriority", "Conflicting training values"),
                    this.mergePriority,
                    [
                      { value: "cloud", label: this.t("cloudPriority", "Keep cloud training values") },
                      { value: "draft", label: this.t("draftPriority", "Keep draft training values") },
                    ],
                    (value) => {
                      this.mergePriority = value as "cloud" | "draft";
                    },
                  )}
                  <button class="button" @click=${() => this.resolveInventory("merge")}>
                    ${this.t("merge", "Merge draft")}
                  </button>
                  <button class="button button--outlined" @click=${() => this.resolveInventory("cloud")}>
                    ${this.t("keepCloud", "Use cloud inventory")}
                  </button>
                </div>
              `
            : nothing
        }
        <div class="team-builder__actions">
          ${
            this.store &&
            ["error", "auth-error"].includes(this.saveState) &&
            this.currentOwner === undefined &&
            !this.storeState?.ownerId
              ? html`
                  <button
                    class="button button--outlined"
                    @click=${async () => {
                      await this.store?.setAccount(null);
                      this.currentOwner = null;
                      this.error = "";
                    }}
                  >
                    ${this.t("localOnly", "Continue with local draft")}
                  </button>
                `
              : nothing
          }
          <button
            class="button button--outlined"
            ?disabled=${!this.canEdit}
            @click=${() => this.querySelector<HTMLInputElement>("[data-inventory-import]")?.click()}
          >
            ${clientText(this.locale, "import", "Import")}
          </button>
          <input hidden data-inventory-import type="file" accept="application/json,.json" @change=${this.importFile} />
          <button
            class="button button--outlined"
            ?disabled=${!this.inventory}
            @click=${() => {
              if (this.inventory)
                downloadBlob(
                  new Blob([exportInventory(this.inventory)], { type: "application/json" }),
                  `haneoka-inventory-${this.server}.json`,
                );
            }}
          >
            ${clientText(this.locale, "export", "Export")}
          </button>
        </div>
      </section>
    `;
  }
  private resolveInventory(strategy: "merge" | "cloud") {
    try {
      if (this.saveState === "merge-required")
        this.store?.resolveAnonymous(strategy, strategy === "merge" ? this.mergePriority : undefined);
      else if (this.saveState === "conflict")
        this.store?.resolveConflict(
          strategy === "cloud" ? "remote" : "merge",
          strategy === "merge" ? this.mergePriority : undefined,
        );
      this.error = "";
    } catch {
      this.error = this.t("conflict", "Inventory changed on another device.");
    }
  }
  private readonly importFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !this.data || !this.canEdit) return;
    const generation = this.authGeneration;
    try {
      if (file.size > 1024 * 1024) throw new Error("inventory-size");
      const next = importInventory(await file.text(), this.data);
      if (generation !== this.authGeneration || !this.isConnected) return;
      this.replaceInventory(next);
    } catch {
      this.error = this.t("importError", "Check the inventory JSON. Existing cards are retained.");
    }
  };

  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
    this.data = null;
    this.inventory = null;
    this.panel = "library";
    this.kind = "members";
    this.mode = "normal";
    this.objectives = ["base-score"];
    this.excludeJust = true;
    this.justRate = 0;
    this.budgetSeconds = 5;
    this.selectedSong = "";
    this.selectedDifficulty = "";
    this.selectedEvent = "";
    this.error = "";
    this.result = null;
    this.progress = null;
    this.running = false;
    this.searchStatus = "";
    this.picker = "";
    this.query = "";
    this.selectedIds = new Set();
    this.bulkField = "level";
    this.bulkValue = null;
    this.saveState = "auth-loading";
    this.visibleLimit = 30;
    this.mergePriority = "cloud";
    this.optimizationInput = null;
    this.addingCards = false;
    this.editingId = "";
    this.pickerBand = "";
    this.pickerRarity = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.data ??= readPageData<TeamBuilderData>(this) ?? null;
    const requested = readReleaseServer();
    if (this.data && requested === this.data.identity.server) {
      this.server = this.data.identity.server;
      this.bindStore();
    } else void this.loadSource(requested);
    document.addEventListener("haneoka:locale-ready", this.localeReady);
    window.addEventListener("focus", this.refreshAccount);
  }
  disconnectedCallback() {
    this.cancelSearch();
    ++this.authGeneration;
    this.authController?.abort();
    this.dataController?.abort();
    this.store?.dispose();
    this.store = undefined;
    this.images.disconnect();
    this.paneFocus.detach();
    clearAppBarActions(OWNER);
    clearAppBarSearch(OWNER);
    document.removeEventListener("haneoka:locale-ready", this.localeReady);
    window.removeEventListener("focus", this.refreshAccount);
    super.disconnectedCallback();
  }
  protected updated() {
    if (!this.isConnected) return;
    this.images.observe(this);
    const modal = this.addingCards || Boolean(this.editingId);
    this.paneFocus.sync(modal ? this.querySelector<HTMLElement>("[data-detail-pane].is-open") : null, () =>
      this.closePane(),
    );
    const content = this.querySelector<HTMLElement>(".team-builder__content");
    if (content) content.inert = modal;

    setAppBarActions(
      OWNER,
      segmented({
        label: this.t("title", "Team builder"),
        value: this.panel,
        iconOnly: true,
        options: [
          { value: "library", label: this.t("cards", "Cards"), icon: "style" },
          { value: "goals", label: this.t("goals", "Goals"), icon: "tune" },
          { value: "results", label: this.t("results", "Candidates"), icon: "groups" },
        ],
        onSelect: (value) => {
          this.panel = value;
          this.query = "";
          this.closePane();
        },
      }),
    );
    if (this.panel === "library" && !modal)
      setAppBarSearch(OWNER, {
        value: this.query,
        label: clientText(this.locale, "search", "Search"),
        onInput: (value) => {
          this.query = value;
          this.visibleLimit = 30;
        },
      });
    else clearAppBarSearch(OWNER);
  }
  private t(key: string, fallback: string) {
    return clientText(this.locale, `teamBuilder.${key}`, fallback);
  }
  private text(value: unknown) {
    return resolveLocalizedText(value, this.locale).text;
  }
  private fieldName(key: string): string {
    const labels: Record<string, string> = {
      level: "Level",
      training: "Training",
      awakening: "Awakening",
      liveSkillLevel: "LIVE skill level",
      gekisoSkillLevel: "GEKISO skill level",
      supportSkillLevel: "Support skill level",
    };
    return this.t(key.replace(/Level$/u, key === "level" ? "level" : ""), labels[key] ?? key);
  }
  private numericField(
    label: string,
    value: number | null,
    change: (value: number | null) => void,
    limits: { min?: number; max?: number; step?: number } = {},
  ) {
    return html`
      <md-outlined-text-field
        type="number"
        label=${label}
        .value=${live(value === null ? "" : String(value))}
        min=${limits.min ?? nothing}
        max=${limits.max ?? nothing}
        step=${limits.step ?? 1}
        supporting-text=${value === null ? this.t("unknown", "Unknown or not entered") : ""}
        @change=${(event: Event) => {
          const raw = (event.currentTarget as Control).value;
          const parsed = raw === "" ? null : Number(raw);
          if (parsed !== null && !Number.isFinite(parsed)) return;
          change(parsed);
        }}
      ></md-outlined-text-field>
    `;
  }
  private select(
    label: string,
    value: string,
    entries: { value: string; label: string }[],
    change: (value: string) => void,
  ) {
    return html`
      <md-outlined-select
        label=${label}
        .value=${value}
        .displayText=${entries.find((entry) => entry.value === value)?.label ?? ""}
        @change=${(event: Event) => change((event.currentTarget as Control).value)}
      >
        ${entries.map(
          (entry) => html`
            <md-select-option value=${entry.value} ?selected=${entry.value === value}>
              <div slot="headline">${entry.label}</div>
            </md-select-option>
          `,
        )}
      </md-outlined-select>
    `;
  }
  private check(label: string, checked: boolean, change: (value: boolean) => void, disabled = false) {
    return html`
      <label class="team-builder__check">
        <md-checkbox
          .checked=${checked}
          ?disabled=${disabled}
          aria-label=${label}
          @change=${(event: Event) => change((event.currentTarget as Control).checked)}
        ></md-checkbox>
        <span>${label}</span>
      </label>
    `;
  }
  private replaceInventory(next: InventoryV1) {
    this.cancelSearch();
    this.result = null;
    this.optimizationInput = null;
    if (!this.data || !validateInventory(next, this.data).valid) {
      this.error = this.t("incomplete", "Some training values or rules are unresolved.");
      return;
    }
    try {
      this.store?.edit(next);
      this.inventory = next;
      this.error = "";
    } catch {
      this.error = this.t("saveFailed", "Save failed. Your draft is retained.");
      return;
    }
    this.dispatchEvent(new CustomEvent("inventory-change", { detail: next, bubbles: true }));
  }
  private patch(ids: string[], patch: Record<string, number | null | boolean>) {
    if (this.inventory) this.replaceInventory(updateInventoryEntries(this.inventory, this.kind, ids, patch));
  }
  private catalogEntry(id: number, kind: Kind = this.kind): MemberCatalog | SnapshotCatalog | undefined {
    return (kind === "members" ? this.data?.members : this.data?.snapshots)?.[String(id)];
  }
  private characterNames(card: MemberCatalog | SnapshotCatalog | undefined): string {
    if (!card) return "";
    const ids = "characterId" in card ? [card.characterId] : card.characterIds;
    return ids
      .map((id) => this.text(this.data?.characters[String(id)]?.characterName))
      .filter(Boolean)
      .join(" · ");
  }
  private bandsFor(card: MemberCatalog | SnapshotCatalog): number[] {
    return "bandId" in card
      ? [card.bandId]
      : [
          ...new Set(
            card.characterIds
              .map((id) => Number(this.data?.characters[String(id)]?.bandId ?? 0))
              .filter((id) => id > 0),
          ),
        ];
  }
  private rarityName(card: MemberCatalog | SnapshotCatalog): string {
    return ({ 2: "R", 3: "SR", 4: "SSR", 10: "EX", 20: "BD" } as Record<number, string>)[card.rarity] ?? "";
  }
  private attributeName(card: MemberCatalog | SnapshotCatalog): string {
    const key = ["", "red", "blue", "green", "yellow", "purple"][card.attribute];
    return key ? clientText(this.locale, `liveMusicTypes.${key}`, key) : "";
  }
  private cardOptions(card: MemberCatalog | SnapshotCatalog, kind: Kind = this.kind): TileOptions {
    const rarity = this.rarityName(card),
      attribute = this.attributeName(card);
    return {
      kind: kind === "members" ? "member" : "support",
      title: this.text(card.name),
      subtitle: this.characterNames(card),
      label: [this.text(card.name), this.characterNames(card), rarity, attribute].filter(Boolean).join(" · "),
      image: card.image,
      aspectRatio: kind === "members" ? "224 / 294" : 1,
      fit: "contain",
      marks: [
        rarity ? { at: "end", text: rarity, label: clientText(this.locale, "rarity", "Rarity") + ": " + rarity } : null,
      ],
    };
  }
  private artwork(card: MemberCatalog | SnapshotCatalog | undefined, kind: Kind = this.kind) {
    if (!card) return nothing;
    return html`
      <span class="team-builder__artwork">${tileMedia(this.cardOptions(card, kind))}</span>
    `;
  }
  private closePane() {
    this.addingCards = false;
    this.editingId = "";
  }
  private renderEntry(entry: MemberEntry | SnapshotEntry) {
    const card = this.catalogEntry(entry.cardId);
    const name = this.text(card?.name) || this.t("unavailable", "Required data or formula is unavailable");
    return html`
      <li class="team-builder__owned-row">
        <div class="team-builder__identity">
          ${this.check(
            this.t("selected", "Selected") + ": " + name,
            this.selectedIds.has(entry.instanceId),
            (selected) => {
              const ids = new Set(this.selectedIds);
              if (selected) ids.add(entry.instanceId);
              else ids.delete(entry.instanceId);
              this.selectedIds = ids;
            },
          )}
          ${this.artwork(card)}
          <span class="list-item__body">
            <strong class="list-item__headline">${name}</strong>
            <span class="list-item__supporting">
              ${this.characterNames(card)}${card ? " · " + this.rarityName(card) + " · " + this.attributeName(card) : ""}
            </span>
            <small class="team-builder__hint">
              ${this.fieldName("level")}: ${entry.level ?? this.t("unknown", "Unknown or not entered")} ·
              ${this.fieldName("awakening")}: ${entry.awakening ?? this.t("unknown", "Unknown or not entered")}
              ${entry.locked ? " · " + this.t("locked", "Locked") : entry.excluded ? " · " + this.t("excluded", "Excluded") : ""}
            </small>
          </span>
          ${iconButton({
            icon: "edit",
            label: this.t("editPractice", "Edit training") + ": " + name,
            onClick: () => {
              this.editingId = entry.instanceId;
            },
          })}
        </div>
      </li>
    `;
  }
  private renderCardPane() {
    if (!this.data || (!this.addingCards && !this.editingId)) return nothing;
    if (this.addingCards) {
      const cards = Object.values(this.kind === "members" ? this.data.members : this.data.snapshots);
      const matching = cards.filter(
        (card) =>
          (!this.pickerBand || this.bandsFor(card).includes(Number(this.pickerBand))) &&
          (!this.pickerRarity || String(card.rarity) === this.pickerRarity) &&
          [this.text(card.name), this.characterNames(card)]
            .join(" ")
            .toLocaleLowerCase()
            .includes(this.query.toLocaleLowerCase()),
      );
      const visible = matching.slice(0, this.visibleLimit);
      const chosen = this.catalogEntry(Number(this.picker));
      const bands = Object.entries(this.data.bands)
        .map(([id, band]) => ({ value: id, label: this.text(band.bandName ?? band.name) }))
        .filter((row) => row.label);
      return renderPane({
        title: this.t("choose", "Choose card"),
        open: true,
        backLabel: clientText(this.locale, "back", "Back"),
        onClose: () => this.closePane(),
        id: "team-card-picker",
        actions: html`
          <md-outlined-text-field
            class="team-builder__picker-search"
            type="search"
            label=${clientText(this.locale, "search", "Search")}
            .value=${live(this.query)}
            @input=${(event: Event) => {
              this.query = (event.currentTarget as Control).value;
              this.visibleLimit = 30;
            }}
          ></md-outlined-text-field>
        `,
        body: html`
          <section class="detail-section">
            <div class="team-builder__fields">
              ${this.select(
                clientText(this.locale, "band", "Band"),
                this.pickerBand,
                [{ value: "", label: clientText(this.locale, "all", "All") }, ...bands],
                (value) => {
                  this.pickerBand = value;
                },
              )}
              ${this.select(
                clientText(this.locale, "rarity", "Rarity"),
                this.pickerRarity,
                [
                  { value: "", label: clientText(this.locale, "all", "All") },
                  ...[...new Set(cards.map((card) => card.rarity))].map((value) => ({
                    value: String(value),
                    label: this.rarityName(cards.find((card) => card.rarity === value)!),
                  })),
                ],
                (value) => {
                  this.pickerRarity = value;
                },
              )}
            </div>
            <div
              class=${`collection collection--${this.kind === "members" ? "member" : "support"}`}
              role="tablist"
              aria-label=${this.t("choose", "Choose card")}
              @keydown=${rovingKeydown(
                visible.map((card) => String(card.id)),
                this.picker,
                (value) => {
                  this.picker = value;
                },
              )}
            >
              ${visible.map((card, index) =>
                tile({
                  ...this.cardOptions(card),
                  selected: String(card.id) === this.picker,
                  role: "tab",
                  controls: "team-card-preview",
                  tabIndex:
                    String(card.id) === this.picker ||
                    (!visible.some((candidate) => String(candidate.id) === this.picker) && index === 0)
                      ? 0
                      : -1,
                  onOpen: () => {
                    this.picker = String(card.id);
                  },
                }),
              )}
            </div>
            ${
              matching.length > this.visibleLimit
                ? html`
                    <button
                      class="button button--text"
                      @click=${() => {
                        this.visibleLimit += 30;
                      }}
                    >
                      ${clientText(this.locale, "more", "More")}
                    </button>
                  `
                : nothing
            }
          </section>
        `,
        footer: html`
          <div id="team-card-preview" role="tabpanel" class="team-builder__picker-preview">
            ${
              chosen
                ? html`
                    <strong>${this.text(chosen.name)}</strong>
                    <span>
                      ${this.characterNames(chosen)} · ${this.rarityName(chosen)} · ${this.attributeName(chosen)}
                    </span>
                  `
                : html`
                    <span>${this.t("choose", "Choose card")}</span>
                  `
            }
            <button
              class="button"
              ?disabled=${!chosen || !this.canEdit}
              @click=${() => {
                if (!chosen || !this.inventory) return;
                const next = addInventoryEntry(this.inventory, this.kind, chosen.id);
                this.replaceInventory(next);
                if (!this.error) {
                  this.addingCards = false;
                  this.editingId = next[this.kind].at(-1)?.instanceId ?? "";
                }
              }}
            >
              ${this.t("addOwnedCopy", "Add owned copy")}
            </button>
          </div>
        `,
      });
    }
    const entry = this.inventory?.[this.kind].find((row) => row.instanceId === this.editingId);
    if (!entry) return nothing;
    const card = this.catalogEntry(entry.cardId);
    const ranges = practiceRanges(this.data, this.kind, entry.cardId, entry);
    const fields =
      this.kind === "members"
        ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"]
        : ["level", "awakening"];
    return renderPane({
      title: this.text(card?.name),
      subtitle: this.characterNames(card),
      open: true,
      backLabel: clientText(this.locale, "back", "Back"),
      onClose: () => this.closePane(),
      id: "team-card-edit",
      leading: this.artwork(card),
      body: html`
        <section class="detail-section">
          ${renderDetailSectionHeading(this.t("editPractice", "Edit training"), "stats", { level: 2 })}
          ${
            this.error
              ? html`
                  <p class="team-builder__error" role="alert">${this.error}</p>
                `
              : nothing
          }
          <div class="team-builder__fields">
            ${fields.map((field) => {
              const value = (entry as unknown as Record<string, number | null>)[field];
              return field === "level"
                ? this.numericField(
                    this.fieldName(field),
                    value,
                    (value) => this.patch([entry.instanceId], { [field]: value }),
                    { min: ranges[field]?.at(0), max: ranges[field]?.at(-1) },
                  )
                : this.select(
                    this.fieldName(field),
                    value === null ? "" : String(value),
                    [
                      { value: "", label: this.t("unknown", "Unknown or not entered") },
                      ...(ranges[field] ?? []).map((value) => ({ value: String(value), label: String(value) })),
                    ],
                    (value) => this.patch([entry.instanceId], { [field]: value === "" ? null : Number(value) }),
                  );
            })}
          </div>
          ${specList([
            { label: clientText(this.locale, "rarity", "Rarity"), value: card ? this.rarityName(card) : "" },
            { label: clientText(this.locale, "attribute", "Attribute"), value: card ? this.attributeName(card) : "" },
          ])}
          <div class="team-builder__actions">
            ${this.check(this.t("locked", "Locked"), entry.locked, (value) => this.patch([entry.instanceId], { locked: value, ...(value ? { excluded: false } : {}) }))}
            ${this.check(this.t("excluded", "Excluded"), entry.excluded, (value) => this.patch([entry.instanceId], { excluded: value, ...(value ? { locked: false } : {}) }))}
          </div>
        </section>
      `,
      footer: html`
        <div class="team-builder__actions">
          <button class="button" @click=${() => this.closePane()}>${clientText(this.locale, "close", "Close")}</button>
          <button
            class="button button--text"
            @click=${() => {
              if (this.inventory)
                this.replaceInventory(removeInventoryEntry(this.inventory, this.kind, entry.instanceId));
              this.closePane();
            }}
          >
            ${clientText(this.locale, "remove", "Remove")}
          </button>
        </div>
      `,
    });
  }
  private renderLibrary() {
    const entries = this.inventory?.[this.kind] ?? [];
    const visible = entries.filter((entry) =>
      [this.text(this.catalogEntry(entry.cardId)?.name), this.characterNames(this.catalogEntry(entry.cardId))]
        .join(" ")
        .toLocaleLowerCase()
        .includes(this.query.toLocaleLowerCase()),
    );
    return html`
      <section class="team-builder__section">
        <div class="team-builder__section-header">
          ${renderDetailSectionHeading(this.t("library", "Card library"), "cards", { count: entries.length, level: 2 })}
          <button
            class="button"
            ?disabled=${!this.canEdit}
            @click=${() => {
              this.addingCards = true;
              this.picker = "";
              this.query = "";
              this.visibleLimit = 30;
            }}
          >
            ${this.t("add", "Add card")}
          </button>
        </div>
        ${segmented({
          label: this.t("library", "Card library"),
          value: this.kind,
          options: [
            { value: "members", label: this.t("members", "Members") },
            { value: "snapshots", label: this.t("snapshots", "Snapshots") },
          ],
          onSelect: (value) => {
            this.kind = value;
            this.closePane();
            this.selectedIds = new Set();
          },
        })}
        ${
          this.selectedIds.size
            ? html`
                <div class="team-builder__fields">
                  ${this.select(
                    this.t("bulk", "Apply to selected cards"),
                    this.bulkField,
                    (this.kind === "members"
                      ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"]
                      : ["level", "awakening"]
                    ).map((value) => ({ value, label: this.fieldName(value) })),
                    (value) => {
                      this.bulkField = value;
                    },
                  )}
                  ${this.numericField(this.fieldName(this.bulkField), this.bulkValue, (value) => {
                    this.bulkValue = value;
                  })}
                  <button
                    class="button button--tonal"
                    @click=${() => this.patch([...this.selectedIds], { [this.bulkField]: this.bulkValue })}
                  >
                    ${this.t("bulk", "Apply to selected cards")}
                  </button>
                </div>
              `
            : nothing
        }
        ${
          entries.length
            ? html`
                <ul class="list team-builder__owned">
                  ${visible.slice(0, this.visibleLimit).map((entry) => this.renderEntry(entry))}
                </ul>
              `
            : html`
                <p>${this.t("emptyLibrary", "Add owned cards or import inventory JSON.")}</p>
              `
        }
        ${
          visible.length > this.visibleLimit
            ? html`
                <button
                  class="button button--text"
                  @click=${() => {
                    this.visibleLimit += 30;
                  }}
                >
                  ${clientText(this.locale, "more", "More")}
                </button>
              `
            : nothing
        }
      </section>
    `;
  }
  private songIdentity() {
    const song = this.data?.songs[this.selectedSong];
    if (!song) return nothing;
    const title = this.text(song.musicTitle ?? song.title ?? song.name);
    const band = this.data?.bands[String(song.bandId ?? (Array.isArray(song.bandIds) ? song.bandIds[0] : ""))];
    return html`
      <div class="list-item list-item--two-line team-builder__song-row">
        <span class="list-item__leading team-builder__artwork">
          ${tileMedia({ title, label: title, image: String(song.jacketThumbUrl ?? song.jacketUrl ?? ""), aspectRatio: 1, fit: "contain" })}
        </span>
        <span class="list-item__body">
          <strong class="list-item__headline">${title}</strong>
          <span class="list-item__supporting">${this.text(band?.bandName ?? band?.name)}</span>
        </span>
      </div>
    `;
  }
  private renderGoals() {
    const songs = Object.entries(this.data?.songs ?? {})
      .map(([id, row]) => ({ value: id, label: this.text(row.title ?? row.name ?? row.musicTitle) }))
      .filter((row) => row.label);
    const events = Object.entries(this.data?.events ?? {})
      .map(([id, row]) => ({ value: id, label: this.text(row.title ?? row.name) }))
      .filter((row) => row.label);
    return html`
      <section class="team-builder__section">
        ${renderDetailSectionHeading(this.t("goals", "Goals"), "difficulty", { level: 2 })}
        <div class="team-builder__fields">
          ${this.select(
            this.t("mode", "Play mode"),
            this.mode,
            MODES.map((value) => ({ value, label: this.t(value, value) })),
            (value) => {
              this.cancelSearch();
              this.optimizationInput = null;
              this.mode = value as PlayMode;
              this.result = null;
            },
          )}
          ${this.select(
            this.t("song", "Song"),
            this.selectedSong,
            [{ value: "", label: this.t("chooseSong", "Choose song") }, ...songs],
            (value) => {
              this.cancelSearch();
              this.result = null;
              this.selectedSong = value;
              this.selectedDifficulty = this.difficulties.at(0)?.value ?? "";
            },
          )}
          ${
            events.length && this.mode === "gekiso"
              ? html`
                  ${this.select(
                    this.t("event", "Event"),
                    this.selectedEvent,
                    [{ value: "", label: clientText(this.locale, "unavailable", "Unavailable") }, ...events],
                    (value) => {
                      this.cancelSearch();
                      this.result = null;
                      this.optimizationInput = null;
                      this.selectedEvent = value;
                    },
                  )}
                `
              : nothing
          }
          ${this.numericField(
            this.t("budget", "Search budget (seconds)"),
            this.budgetSeconds,
            (value) => {
              this.budgetSeconds = value ?? 5;
            },
            { min: 1, max: 60 },
          )}
        </div>
        ${
          this.selectedSong
            ? html`
                <div class="team-builder__song-context">
                  ${this.songIdentity()}
                  ${difficultyPicker({
                    rows: dataRows(this.data?.songs[this.selectedSong]?.difficulty),
                    selected: difficultyKey({ difficulty: this.selectedDifficulty }),
                    locale: this.locale,
                    onSelect: (_key, index) => {
                      this.cancelSearch();
                      this.result = null;
                      this.selectedDifficulty = String(
                        dataRows(this.data?.songs[this.selectedSong]?.difficulty)[index]?.difficulty ?? "",
                      );
                    },
                  })}
                </div>
              `
            : nothing
        }
        <fieldset class="team-builder__objectives">
          <legend>${this.t("objectives", "Objectives to compare")}</legend>
          ${OBJECTIVES.map((objective) =>
            this.check(
              this.t(objective, objective),
              this.objectives.includes(objective),
              (checked) => {
                this.cancelSearch();
                this.result = null;
                this.objectives = checked
                  ? [...this.objectives, objective]
                  : this.objectives.filter((value) => value !== objective);
              },
              objective !== "base-score" &&
                (objective === "score"
                  ? !this.optimizationInput || this.optimizationInput.evaluation.scope === "growth-only"
                  : objective !== "ss-surplus" ||
                    this.mode === "battle" ||
                    !Object.values(this.optimizationInput?.evaluation.songContexts ?? {}).some(
                      (row) => row.personalSS !== null,
                    )),
            ),
          )}
        </fieldset>
        ${
          this.mode === "gekiso"
            ? html`
                ${this.check(this.t("excludeJust", "Exclude JUST mission charts"), this.excludeJust, (value) => {
                  this.cancelSearch();
                  this.result = null;
                  this.excludeJust = value;
                })}
                ${
                  this.excludeJust
                    ? nothing
                    : this.numericField(
                        this.t("justRate", "JUST rate (%)"),
                        this.justRate * 100,
                        (value) => {
                          this.cancelSearch();
                          this.result = null;
                          this.justRate = (value ?? 0) / 100;
                        },
                        { min: 0, max: 100, step: 1 },
                      )
                }
              `
            : nothing
        }
        <p class="team-builder__hint">${this.t("perfect", "Other judgments: 100% PERFECT")}</p>
        ${
          this.objectives.includes("base-score")
            ? html`
                <p class="team-builder__hint">
                  ${this.t("baseScope", "Normal-live growth component. Skills, snapshots, song and player bonuses are separate.")}
                </p>
              `
            : nothing
        }
        <button class="button" ?disabled=${!this.canOptimize || this.running} @click=${() => this.startOptimization()}>
          ${this.t("optimize", "Find candidates")}
        </button>
        ${
          !this.canOptimize
            ? html`
                <p class="team-builder__hint">${this.t("unavailable", "Required data or formula is unavailable")}</p>
              `
            : nothing
        }
      </section>
    `;
  }
  private renderBands() {
    if (!this.inventory || !this.data) return nothing;
    return html`
      <section class="team-builder__section">
        <details>
          <summary>${this.t("bands", "Band upgrades")}</summary>
          <div class="team-builder__fields">
            ${Object.entries(this.data.bands).map(([id, band]) => {
              const name = this.text(band.bandName ?? band.name);
              if (!name) return nothing;
              return this.numericField(name, this.inventory!.bandRanks[id] ?? null, (value) => {
                if (this.inventory)
                  this.replaceInventory({ ...this.inventory, bandRanks: { ...this.inventory.bandRanks, [id]: value } });
              });
            })}
          </div>
          <details>
            <summary>${clientText(this.locale, "bandItems", "Band items")}</summary>
            <div class="team-builder__fields">
              ${Object.entries(this.data.bandItems).map(([id, item]) => {
                const name = this.text(item.name ?? item.itemName);
                if (!name) return nothing;
                return this.numericField(name, this.inventory!.bandItems[id] ?? null, (value) => {
                  if (this.inventory)
                    this.replaceInventory({
                      ...this.inventory,
                      bandItems: { ...this.inventory.bandItems, [id]: value },
                    });
                });
              })}
            </div>
          </details>
        </details>
      </section>
    `;
  }
  get constraints(): SearchConstraints {
    return {
      lockedMemberIds: this.inventory?.members.filter((row) => row.locked).map((row) => row.instanceId) ?? [],
      excludedMemberIds: this.inventory?.members.filter((row) => row.excluded).map((row) => row.instanceId) ?? [],
      lockedSnapshotIds: this.inventory?.snapshots.filter((row) => row.locked).map((row) => row.instanceId) ?? [],
      excludedSnapshotIds: this.inventory?.snapshots.filter((row) => row.excluded).map((row) => row.instanceId) ?? [],
      excludedSongKeys: [],
      excludeJustMissions: this.mode === "gekiso" && this.excludeJust,
      justRate: this.mode === "gekiso" && !this.excludeJust ? this.justRate : 0,
      teamSize: 5,
    };
  }
  cancelSearch() {
    ++this.requestId;
    this.worker?.terminate();
    this.worker = undefined;
    this.running = false;
  }
  private get difficulties(): { value: string; label: string }[] {
    return dataRows(
      this.data?.songs[this.selectedSong]?.difficulty ?? this.data?.songs[this.selectedSong]?.difficulties,
    )
      .filter((row) => Number.isSafeInteger(Number(row.difficulty)))
      .map((row) => ({
        value: String(row.difficulty),
        label: `${difficultyKey(row).toUpperCase()} ${row.playLevel ?? row.level ?? ""}`.trim(),
      }));
  }
  private get canOptimize(): boolean {
    if (
      !this.data ||
      !this.inventory ||
      !this.canEdit ||
      !this.objectives.length ||
      !this.selectedSong ||
      !this.difficulties.some((row) => row.value === this.selectedDifficulty) ||
      !Number.isFinite(this.budgetSeconds) ||
      this.budgetSeconds < 1 ||
      this.budgetSeconds > 60 ||
      this.justRate < 0 ||
      this.justRate > 1
    )
      return false;
    if (this.optimizationInput)
      return (
        this.optimizationInput.server === this.server &&
        this.optimizationInput.releaseId === this.data.identity.releaseId &&
        this.optimizationInput.evaluation.mode === this.mode
      );
    return (
      this.mode === "normal" &&
      this.objectives.every((objective) => objective === "base-score") &&
      validateInventory(this.inventory, this.data).valid
    );
  }
  startOptimization(): void {
    if (!this.canOptimize || !this.data || !this.inventory) return;
    this.cancelSearch();
    this.error = "";
    this.result = null;
    this.progress = null;
    this.searchStatus = "";
    const generation = this.requestId;
    const runId = crypto.randomUUID();
    const budget = {
      maxEvaluations: 100000,
      maxMilliseconds: Math.round(this.budgetSeconds * 1000),
      maxCandidates: 50,
    };
    let worker: Worker;
    try {
      worker = this.worker = new Worker(new URL("../lib/team-builder/solver/worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      this.error = this.t("unavailable", "Required data or formula is unavailable");
      return;
    }
    this.running = true;
    this.panel = "results";
    worker.onmessage = (event: MessageEvent<SolverResponse>) => {
      const message = event.data;
      if (generation !== this.requestId || message.runId !== runId || !this.isConnected) return;
      if (message.type === "progress") this.progress = message.progress;
      else {
        if (message.type === "result") this.result = message.result;
        else this.error = this.t("unavailable", "Required data or formula is unavailable");
        this.running = false;
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
      }
    };
    worker.onerror = () => {
      if (generation !== this.requestId || !this.isConnected) return;
      this.error = this.t("unavailable", "Required data or formula is unavailable");
      this.cancelSearch();
    };
    try {
      if (this.optimizationInput) {
        const input: OptimizationInput = {
          ...this.optimizationInput,
          objectives: [...this.objectives],
          constraints: this.constraints,
          songs: this.optimizationInput.songs.filter(
            (song) => String(song.songId) === this.selectedSong && String(song.difficulty) === this.selectedDifficulty,
          ),
          budget,
        };
        worker.postMessage({ type: "start", runId, input });
      } else {
        const request: WorkerPreparationInput = {
          data: this.data,
          inventory: this.inventory,
          selections: [{ songId: Number(this.selectedSong), difficulty: Number(this.selectedDifficulty) }],
          mode: this.mode,
          objectives: [...this.objectives],
          constraints: this.constraints,
          budget,
        };
        worker.postMessage({ type: "prepare", runId, request });
      }
    } catch {
      this.cancelSearch();
      this.error = this.t("unavailable", "Required data or formula is unavailable");
    }
  }
  private renderResults() {
    return html`
      <section class="team-builder__section">
        ${renderDetailSectionHeading(this.t("results", "Candidates"), "stats", { level: 2 })}
        ${
          this.running
            ? html`
                <md-linear-progress
                  indeterminate
                  aria-label=${this.t("searching", "Finding candidates")}
                ></md-linear-progress>
                <p role="status">
                  ${this.progress?.phase === "loading" ? clientText(this.locale, "loading", "Loading") : this.t("evaluated", "Evaluated configurations") + ": " + (this.progress?.evaluated.toLocaleString(this.locale) ?? "0")}
                </p>
                <button
                  class="button button--outlined"
                  @click=${() => {
                    this.cancelSearch();
                    this.searchStatus = this.t("cancelled", "Search cancelled");
                  }}
                >
                  ${clientText(this.locale, "cancel", "Cancel")}
                </button>
              `
            : nothing
        }
        ${
          this.searchStatus
            ? html`
                <p role="status">${this.searchStatus}</p>
              `
            : nothing
        }
        ${
          this.result
            ? html`
                <p role="status">${this.t(this.result.completeness, this.result.completeness)}</p>
                ${this.result.candidates.map(
                  (candidate) => html`
                    <article class="team-builder__candidate">
                      ${this.songIdentity()}
                      <div class="team-builder__team-strip" role="group" aria-label=${this.t("members", "Members")}>
                        ${candidate.assignment.memberInstanceIds.map((id) => {
                          const member = this.inventory?.members.find((entry) => entry.instanceId === id);
                          const card = this.catalogEntry(member?.cardId ?? 0, "members");
                          return card
                            ? html`
                                <figure title=${this.cardOptions(card, "members").label}>
                                  ${tileMedia({ ...this.cardOptions(card, "members"), marks: [] })}
                                  ${
                                    id === candidate.assignment.leaderInstanceId
                                      ? html`
                                          <figcaption>${this.t("leader", "Leader")}</figcaption>
                                        `
                                      : nothing
                                  }
                                </figure>
                              `
                            : nothing;
                        })}
                      </div>
                      <details>
                        <summary>${this.t("configuration", "Team configuration")}</summary>
                        <div class="team-builder__lineup">
                          ${candidate.assignment.memberInstanceIds.map((id, index) => {
                            const member = this.inventory?.members.find((entry) => entry.instanceId === id);
                            const snapshot = this.inventory?.snapshots.find(
                              (entry) => entry.instanceId === candidate.assignment.snapshotInstanceIds[index],
                            );
                            return html`
                              <div>
                                <div class="team-builder__identity">
                                  ${this.artwork(this.catalogEntry(member?.cardId ?? 0, "members"), "members")}
                                  <span>${this.text(this.catalogEntry(member?.cardId ?? 0, "members")?.name)}</span>
                                </div>
                                <small>
                                  ${this.fieldName("level")}:
                                  ${member?.level ?? this.t("unknown", "Unknown or not entered")} ·
                                  ${this.fieldName("training")}:
                                  ${member?.training ?? this.t("unknown", "Unknown or not entered")} ·
                                  ${this.fieldName("awakening")}:
                                  ${member?.awakening ?? this.t("unknown", "Unknown or not entered")}
                                </small>
                                <small>
                                  ${this.fieldName("liveSkillLevel")}:
                                  ${member?.liveSkillLevel ?? this.t("unknown", "Unknown or not entered")} ·
                                  ${this.fieldName("gekisoSkillLevel")}:
                                  ${member?.gekisoSkillLevel ?? this.t("unknown", "Unknown or not entered")}
                                </small>
                                ${
                                  id === candidate.assignment.leaderInstanceId
                                    ? html`
                                        <strong>${this.t("leader", "Leader")}</strong>
                                      `
                                    : nothing
                                }
                                ${
                                  snapshot
                                    ? html`
                                        <small>
                                          ${this.text(this.catalogEntry(snapshot.cardId, "snapshots")?.name)} ·
                                          ${this.fieldName("level")}:
                                          ${snapshot.level ?? this.t("unknown", "Unknown or not entered")} ·
                                          ${this.fieldName("awakening")}:
                                          ${snapshot.awakening ?? this.t("unknown", "Unknown or not entered")}
                                        </small>
                                      `
                                    : nothing
                                }
                              </div>
                            `;
                          })}
                        </div>
                      </details>
                      <dl class="team-builder__metrics">
                        ${this.objectives.map((objective) => {
                          const metric = candidate.metrics[objective];
                          return html`
                            <dt>${this.t(objective, objective)}</dt>
                            <dd>
                              ${metric.value === null ? this.t("unavailable", "Required data or formula is unavailable") : metric.value.toLocaleString(this.locale)}
                              <small>${this.t(metric.status, metric.status)}</small>
                            </dd>
                          `;
                        })}
                      </dl>
                      <details>
                        <summary>${this.t("whyRecommended", "Why this candidate")}</summary>
                        <p class="team-builder__hint">
                          ${this.t("comparisonScope", "Compared within the entered cards and selected chart.")}
                        </p>
                        ${specList([
                          {
                            label: this.t("evaluated", "Evaluated configurations"),
                            value: this.result!.evaluated.toLocaleString(this.locale),
                          },
                          {
                            label: this.t("elapsed", "Elapsed seconds"),
                            value: (this.result!.elapsedMs / 1000).toLocaleString(this.locale, {
                              maximumFractionDigits: 2,
                            }),
                          },
                          { label: this.t("budget", "Search budget (seconds)"), value: this.budgetSeconds },
                        ])}
                        ${this.objectives
                          .flatMap((objective) => candidate.metrics[objective].assumptions)
                          .map(
                            (value) => html`
                              <p class="team-builder__hint">
                                ${value.startsWith("growth-only-unboosted-component") ? this.t("baseScope", "Normal-live growth component. Skills, snapshots, song and player bonuses are separate.") : value}
                              </p>
                            `,
                          )}
                      </details>
                    </article>
                  `,
                )}
                ${
                  this.result.candidates.length
                    ? nothing
                    : html`
                        <p>
                          ${this.result.gaps.length || this.result.completeness === "unavailable" ? this.t("unavailable", "Required data or formula is unavailable") : this.t("noCandidates", "No candidates match these constraints.")}
                        </p>
                      `
                }
              `
            : this.searchStatus
              ? nothing
              : html`
                  <p>${this.t("unavailable", "Required data or formula is unavailable")}</p>
                `
        }
      </section>
    `;
  }
  render(): TemplateResult {
    return html`
      <div class="team-builder">
        <div class="team-builder__content">
          ${this.select(
            clientText(this.locale, "server", "Server"),
            this.server,
            [
              { value: "intl", label: clientText(this.locale, "settingsGlobal", "Global") },
              { value: "jp", label: clientText(this.locale, "settingsJapan", "Japan") },
            ],
            (server) => {
              const url = new URL(location.href);
              url.searchParams.set("server", server);
              history.replaceState(history.state, "", url);
              void this.loadSource(server);
            },
          )}
          ${
            this.error
              ? html`
                  <p class="team-builder__error" role="alert">${this.error}</p>
                `
              : nothing
          }
          ${
            this.data
              ? html`
                  <details class="team-builder__source-info">
                    <summary>${this.t("release", "Data release")}</summary>
                    ${specList([
                      { label: clientText(this.locale, "server", "Server"), value: this.server },
                      { label: this.t("release", "Data release"), value: this.data.identity.releaseId },
                    ])}
                  </details>
                  ${this.renderStorage()}
                  ${
                    this.inventory && this.saveState !== "release-mismatch"
                      ? html`
                          <div class="team-builder__panels" ?inert=${!this.canEdit && this.panel !== "results"}>
                            ${
                              this.panel === "library"
                                ? html`
                                    ${this.renderLibrary()}${this.renderBands()}
                                  `
                                : this.panel === "goals"
                                  ? this.renderGoals()
                                  : this.renderResults()
                            }
                          </div>
                        `
                      : ["loading", "auth-loading", "authLoading"].includes(this.saveState)
                        ? loadingState(this.t("cloudLoading", "Loading account inventory"))
                        : nothing
                  }
                `
              : this.error
                ? html`
                    <button class="button button--outlined" @click=${() => this.loadSource(this.server)}>
                      ${clientText(this.locale, "retry", "Retry")}
                    </button>
                  `
                : loadingState(clientText(this.locale, "loading", "Loading"))
          }
        </div>
        ${this.renderCardPane()}
      </div>
    `;
  }
}
if (!customElements.get("team-builder")) customElements.define("team-builder", TeamBuilder);
