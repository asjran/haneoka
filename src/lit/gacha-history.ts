// L3 — GEB
// Input: 工作区提供的账号、规范记录、统计及云状态。
// Output: 卡池分析、图表、统一卡牌、兑换进度和显式操作事件。
// Pos: [Map](L2-2.md)；抽卡历史展示与资料边界。
// Effects/Dependencies: light DOM 与 SSR 共用；消费共享图表／卡牌，导入及云状态由工作区持有。
import type { GachaTargetProgress } from "@haneoka/game-data-exporter/gacha-history-points";
import { modal } from "./ui/modal";
import "./ui/image-gallery";
import {
  analyzeGachaHistory,
  gachaHistoryDay,
  gachaHistoryProgress,
  summarizeGachaHistoryMoney,
} from "@haneoka/game-data-exporter/gacha-history-analysis";
import "./shared/gacha-history-chart";
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { keyed } from "lit/directives/keyed.js";
import { clientText } from "../i18n/client";
import { clearAppBarSearch, setAppBarSearch } from "../lib/app-bar";
import type {
  GachaHistoryAccount,
  GachaHistoryPool,
  GachaHistoryBatch,
  GachaHistoryPrize,
  GachaHistoryEvents,
  GachaHistoryConversion,
  GachaHistoryCost,
  GachaHistoryImportSource,
} from "../lib/gacha-history-view";
import { renderBrowse, clearBrowseBar } from "./ui/browse";
import { facet } from "./ui/facet";
import { iconButton, inputChip, segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { accordion } from "./ui/accordion";
import { collectionList, collectionTable, viewSwitch, type CollectionView } from "./ui/collection-view";
import { gachaPrizeCard } from "./shared/gacha-prize-card";
import { LazyImages } from "./ui/lazy-images";
import type { GachaHistoryReport, GachaHistoryReportCard } from "../lib/gacha-history-image";
import { emptyState, loadingState } from "./ui/state";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import "../styles/gacha-history.css";
import { renderLocalSaveSourcePicker } from "./shared/local-save-source-picker";

type Axis = "category" | "pool" | "kind" | "rarity" | "pickup";
const OWNER = "gacha-history";
export class GachaHistory extends LitElement {
  static properties = {
    cloudSignedIn: { type: Boolean },
    cloudBusy: { type: Boolean },
    cloudLinked: { type: Boolean },
    cloudRefreshPending: { type: Boolean },
    cloudErrorCode: {},
    imageFiles: { state: true },
    savingImage: { state: true },
    albumKind: { state: true },
    onlyPickup: { state: true },
    allCards: { state: true },
    importSources: { attribute: false },
    importSourceOpen: { state: true },
    currencyConversion: { attribute: false },
    exportingImage: { state: true },
    imageError: { state: true },
    locale: {},
    historyKinds: { attribute: false },
    selectedHistoryKind: {},
    accounts: { attribute: false },
    pools: { attribute: false },
    batches: { attribute: false },
    selectedAccountKey: {},
    busy: { type: Boolean },
    historyLoaded: { type: Boolean },
    catalogLoading: { type: Boolean },
    catalogError: {},
    canRetryCatalog: { type: Boolean },
    showAppLink: { type: Boolean },
    error: {},
    canImport: { type: Boolean },
    canRefresh: { type: Boolean },
    canExport: { type: Boolean },
    query: { state: true },
    filtersOpen: { state: true },
    filters: { state: true },
    from: { state: true },
    to: { state: true },
    oldest: { state: true },
    view: { state: true },
    expanded: { state: true },
  };
  declare cloudSignedIn: boolean;
  declare cloudBusy: boolean;
  declare cloudLinked: boolean;
  declare cloudRefreshPending: boolean;
  declare cloudErrorCode: string;
  private imageRequest?: AbortController;
  private imageGeneration = 0;
  declare private imageFiles: Array<{ blob: Blob; filename: string; url: string; width: number; height: number }>;
  declare private savingImage: boolean;
  declare private albumKind: "all" | "member" | "support";
  declare private onlyPickup: boolean;
  declare private allCards: boolean;
  declare importSources: readonly GachaHistoryImportSource[];
  declare private importSourceOpen: boolean;
  declare currencyConversion?: GachaHistoryConversion;
  declare private exportingImage: boolean;
  declare private imageError: string;
  declare locale: string;
  declare historyKinds: readonly string[];
  declare selectedHistoryKind: string;
  declare accounts: readonly GachaHistoryAccount[];
  declare pools: readonly GachaHistoryPool[];
  declare batches: readonly GachaHistoryBatch[];
  declare selectedAccountKey: string;
  declare busy: boolean;
  declare historyLoaded: boolean;
  declare catalogLoading: boolean;
  declare catalogError: string;
  declare canRetryCatalog: boolean;
  declare showAppLink: boolean;
  declare error: string;
  declare canImport: boolean;
  declare canRefresh: boolean;
  declare canExport: boolean;
  declare private query: string;
  declare private filtersOpen: boolean;
  declare private filters: Record<Axis, string[]>;
  declare private from: string;
  declare private to: string;
  declare private oldest: boolean;
  declare private view: CollectionView;
  declare private expanded: Set<string>;
  private images = new LazyImages();
  private indexedPools?: readonly GachaHistoryPool[];
  private poolIndex = new Map<string, GachaHistoryPool>();
  private expansionReady = false;
  private get poolMap() {
    if (this.indexedPools !== this.pools) {
      this.indexedPools = this.pools;
      this.poolIndex = new Map(this.pools.map((pool) => [pool.id, pool]));
    }
    return this.poolIndex;
  }
  constructor() {
    super();
    this.cloudSignedIn = false;
    this.cloudBusy = false;
    this.cloudLinked = false;
    this.cloudRefreshPending = false;
    this.cloudErrorCode = "";
    this.locale = "ja";
    this.imageFiles = [];
    this.savingImage = false;
    this.albumKind = "all";
    this.onlyPickup = false;
    this.allCards = false;
    this.historyLoaded = false;
    this.catalogLoading = false;
    this.catalogError = "";
    this.canRetryCatalog = false;
    this.showAppLink = false;
    this.importSources = [];
    this.importSourceOpen = false;
    this.exportingImage = false;
    this.imageError = "";
    this.historyKinds = [];
    this.selectedHistoryKind = "";
    this.accounts = [];
    this.pools = [];
    this.batches = [];
    this.selectedAccountKey = "";
    this.busy = false;
    this.error = "";
    this.canImport = false;
    this.canRefresh = false;
    this.canExport = false;
    this.query = "";
    this.filtersOpen = false;
    this.filters = { category: [], pool: [], kind: [], rarity: [], pickup: [] };
    this.from = "";
    this.to = "";
    this.oldest = false;
    this.view = "grid";
    this.expanded = new Set();
  }
  connectedCallback() {
    super.connectedCallback();
    void Promise.all([
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/progress/linear-progress.js"),
    ]);
  }
  createRenderRoot() {
    return this;
  }
  private percent(value: number, total: number) {
    return total
      ? new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 2 }).format(value / total)
      : "—";
  }
  private get offsetMinutes() {
    const account = this.accounts.find((row) => row.key === this.selectedAccountKey);
    return (
      account?.offsetMinutes ??
      ({ jp: 540, "global-hmt": 480, "global-en": 0, "global-kr": 540 } as Record<string, number>)[
        account?.server ?? ""
      ] ??
      480
    );
  }
  private analysis(batches: readonly GachaHistoryBatch[]) {
    return analyzeGachaHistory(batches, this.offsetMinutes);
  }
  private serverTime(value: string, kind: "time" | "date") {
    return new Intl.DateTimeFormat(this.locale, {
      timeZone: "UTC",
      ...(kind === "time" ? { timeStyle: "short" as const } : { dateStyle: "medium" as const }),
    }).format(new Date(new Date(value).getTime() + this.offsetMinutes * 60000));
  }
  private t(key: string, values: Record<string, string | number> = {}) {
    return clientText(this.locale, `catalog.gachaHistory.${key}`, "", values);
  }
  private emit<K extends keyof GachaHistoryEvents>(type: K, detail: GachaHistoryEvents[K]["detail"]) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
  protected update(changed: PropertyValues) {
    const priorFilters = changed.get("filters") as Record<Axis, string[]> | undefined;
    if (
      ["selectedAccountKey", "selectedHistoryKind", "batches", "from", "to"].some((key) => changed.has(key)) ||
      (priorFilters &&
        ["pool", "category"].some((key) => priorFilters[key as Axis].join("|") !== this.filters[key as Axis].join("|")))
    )
      this.cancelImageExport();
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  renderStaticChrome() {
    setAppBarSearch(OWNER, {
      value: this.query,
      label: this.t("search"),
      onInput: (value) => {
        this.query = value;
      },
    });
  }
  protected updated(changed: PropertyValues) {
    this.renderStaticChrome();
    this.images.observe(this);
    if (changed.has("selectedAccountKey")) {
      this.expansionReady = false;
      this.expanded = new Set();
      this.reset();
    }
  }
  disconnectedCallback() {
    this.cancelImageExport();
    this.images.disconnect();
    clearAppBarSearch(OWNER);
    clearBrowseBar();
    super.disconnectedCallback();
  }
  private toggle(axis: Axis, value: string) {
    this.filters = {
      ...this.filters,
      [axis]: this.filters[axis].includes(value)
        ? this.filters[axis].filter((v) => v !== value)
        : [...this.filters[axis], value],
    };
  }
  private reset() {
    this.filters = { category: [], pool: [], kind: [], rarity: [], pickup: [] };
    this.from = "";
    this.to = "";
  }
  private prizes(batch: GachaHistoryBatch) {
    const query = this.query.normalize("NFKC").toLocaleLowerCase(this.locale).trim();
    const poolMatches = this.poolMap
      .get(batch.poolId)
      ?.name.normalize("NFKC")
      .toLocaleLowerCase(this.locale)
      .includes(query);
    return batch.prizes.filter(
      (prize) =>
        (!this.filters.pickup.length ||
          this.filters.pickup.includes(prize.pickup == null ? "unknown" : prize.pickup ? "yes" : "no")) &&
        (!this.filters.kind.length || this.filters.kind.includes(prize.kind)) &&
        (!this.filters.rarity.length || this.filters.rarity.includes(String(prize.rarity))) &&
        (!query || poolMatches || prize.name.normalize("NFKC").toLocaleLowerCase(this.locale).includes(query)),
    );
  }
  render() {
    const poolMap = this.poolMap;
    const accountBatches = this.batches.filter((batch) => batch.accountKey === this.selectedAccountKey);
    const scoped = accountBatches.filter((batch) => {
      const pool = poolMap.get(batch.poolId),
        day = gachaHistoryDay(batch.pulledAt, this.offsetMinutes) ?? "";
      return (
        (!this.filters.pool.length || this.filters.pool.includes(batch.poolId)) &&
        (!this.filters.category.length || (pool && this.filters.category.includes(pool.category))) &&
        (!this.from || (day && day >= this.from)) &&
        (!this.to || (day && day <= this.to))
      );
    });
    const filtered = scoped
      .filter(
        (batch) =>
          (!this.query.trim() &&
            !this.filters.kind.length &&
            !this.filters.rarity.length &&
            !this.filters.pickup.length) ||
          this.prizes(batch).length,
      )
      .sort((a, b) => {
        if (!a.pulledAt) return b.pulledAt ? 1 : 0;
        if (!b.pulledAt) return -1;
        return (new Date(a.pulledAt).getTime() - new Date(b.pulledAt).getTime()) * (this.oldest ? 1 : -1);
      });
    const prizes = scoped.flatMap((batch) => batch.prizes);
    const unknownDraws = scoped.filter((batch) => batch.drawCount == null).length;
    const total = scoped.some((batch) => batch.drawCount != null)
      ? scoped.reduce((sum, batch) => sum + (batch.drawCount ?? 0), 0)
      : "—";
    const count = (kind: string) =>
      prizes.filter((prize) => prize.kind === kind).reduce((sum, prize) => sum + prize.quantity, 0);
    const groups = new Map<string, GachaHistoryBatch[]>();
    for (const batch of filtered) {
      const day = gachaHistoryDay(batch.pulledAt, this.offsetMinutes) ?? "unknown";
      const group = groups.get(day);
      if (group) group.push(batch);
      else groups.set(day, [batch]);
    }
    if (!this.expansionReady && groups.size) {
      const first = groups.keys().next().value!;
      if (first !== "unknown") this.expanded.add(first);
      this.expansionReady = true;
    }
    const options = (axis: Axis) => {
      const entries = new Map<string, { value: string; label: string; count: number }>();
      for (const batch of accountBatches) {
        const pool = poolMap.get(batch.poolId);
        if (axis === "pool" || axis === "category") {
          const value = axis === "pool" ? batch.poolId : pool?.category;
          if (value) {
            const current = entries.get(value);
            entries.set(value, {
              value,
              label: axis === "pool" ? (pool?.name ?? value) : value,
              count: (current?.count ?? 0) + 1,
            });
          }
        } else
          for (const prize of batch.prizes) {
            if (axis === "pickup" && prize.pickup == null) continue;
            const value =
              axis === "pickup"
                ? prize.pickup == null
                  ? "unknown"
                  : prize.pickup
                    ? "yes"
                    : "no"
                : axis === "kind"
                  ? prize.kind
                  : String(prize.rarity);
            const label =
              axis === "pickup"
                ? this.t(prize.pickup ? "pickup" : "nonPickup")
                : axis === "kind"
                  ? this.t(prize.kind)
                  : prize.rarityLabel;
            if (label) {
              const current = entries.get(value);
              entries.set(value, { value, label, count: (current?.count ?? 0) + prize.quantity });
            }
          }
      }
      return [...entries.values()];
    };
    const applied = (Object.keys(this.filters) as Axis[]).flatMap((axis) =>
      this.filters[axis].map((value) =>
        inputChip(options(axis).find((option) => option.value === value)?.label ?? value, this.t("remove"), () =>
          this.toggle(axis, value),
        ),
      ),
    );
    if (this.from)
      applied.push(
        inputChip(`${this.t("from")} · ${this.from}`, this.t("remove"), () => {
          this.from = "";
        }),
      );
    if (this.to)
      applied.push(
        inputChip(`${this.t("to")} · ${this.to}`, this.t("remove"), () => {
          this.to = "";
        }),
      );
    const report = this.report(scoped);
    const pickupKnown = prizes.length > 0 && prizes.every((prize) => prize.pickup != null);
    const pickup = prizes.filter((prize) => prize.pickup === true).reduce((sum, prize) => sum + prize.quantity, 0);
    return html`
      <div class="gacha-history">
        ${this.renderImagePreview()}
        ${
          this.importSourceOpen
            ? renderLocalSaveSourcePicker({
                locale: this.locale,
                sources: this.importSources,
                historyGuidance: true,
                onClose: () => {
                  this.importSourceOpen = false;
                },
                onSelect: (source) => {
                  this.importSourceOpen = false;
                  this.emit("gacha-import-source", { source });
                },
              })
            : nothing
        }
        ${renderBrowse({
          kind: "gacha-history",
          count: { value: filtered.length, label: this.t("batches", { count: filtered.length }) },
          controls: html`
            ${this.canImport ? iconButton({ label: this.t("import"), icon: "file_upload", disabled: this.busy, onClick: () => this.openImport() }) : nothing}
            ${iconButton({ label: this.t("exportImage"), icon: "image", disabled: !scoped.length || this.exportingImage, onClick: () => void this.exportImage(report) })}
            ${this.canExport ? iconButton({ label: this.t("export"), icon: "file_download", disabled: !filtered.length, onClick: () => this.emit("gacha-export", { accountKey: this.selectedAccountKey, historyKind: this.selectedHistoryKind, batches: filtered }) }) : nothing}
            ${this.canRefresh ? iconButton({ label: this.t("refresh"), icon: "refresh", disabled: this.busy || !this.selectedAccountKey, onClick: () => this.emit("gacha-refresh", { accountKey: this.selectedAccountKey }) }) : nothing}
            ${iconButton({
              label: this.oldest ? this.t("oldest") : this.t("newest"),
              icon: "swap_vert",
              pressed: this.oldest,
              onClick: () => {
                this.oldest = !this.oldest;
              },
            })}
          `,
          modes: viewSwitch(this.locale, this.view, (view) => {
            this.view = view;
          }),
          applied,
          filters: {
            label: this.t("filter"),
            open: this.filtersOpen,
            count: applied.length,
            closeLabel: this.t("close"),
            resetLabel: this.t("reset"),
            onOpen: () => {
              this.filtersOpen = true;
            },
            onClose: () => {
              this.filtersOpen = false;
            },
            onReset: () => this.reset(),
            body: html`
              ${(Object.keys(this.filters) as Axis[]).map((axis) => facet(this.t(axis), this.locale, options(axis), this.filters[axis], (value) => this.toggle(axis, value)))}
              <div class="stack">
                <label class="field">
                  <span>${this.t("from")}</span>
                  <input
                    type="date"
                    ?disabled=${!accountBatches.some((batch) => batch.pulledAt)}
                    .value=${this.from}
                    max=${this.to || nothing}
                    @change=${(e: Event) => {
                      this.from = (e.target as HTMLInputElement).value;
                    }}
                  />
                </label>
                <label class="field">
                  <span>${this.t("to")}</span>
                  <input
                    type="date"
                    ?disabled=${!accountBatches.some((batch) => batch.pulledAt)}
                    .value=${this.to}
                    min=${this.from || nothing}
                    @change=${(e: Event) => {
                      this.to = (e.target as HTMLInputElement).value;
                    }}
                  />
                </label>
              </div>
            `,
          },
          results: html`
            <div class="stack stack--loose" aria-busy=${String(this.busy)}>
              <section class="surface stack">
                ${this.accounts.length > 1 || !this.historyLoaded ? renderDetailSectionHeading(this.t("account"), "accounts") : nothing}
                <md-outlined-select
                  label=${this.t("account")}
                  .value=${this.selectedAccountKey}
                  .displayText=${this.accounts.find((account) => account.key === this.selectedAccountKey)?.label ?? ""}
                  ?disabled=${!this.accounts.length || this.busy}
                  @change=${(event: Event) => this.emit("gacha-account-change", { accountKey: (event.target as HTMLSelectElement).value })}
                >
                  <md-select-option value=""><div slot="headline">${this.t("selectAccount")}</div></md-select-option>
                  ${this.accounts.map(
                    (account) => html`
                      <md-select-option value=${account.key} ?selected=${account.key === this.selectedAccountKey}>
                        <div slot="headline">${[account.serverLabel, account.label].filter(Boolean).join(" · ")}</div>
                      </md-select-option>
                    `,
                  )}
                </md-outlined-select>
                ${
                  this.historyKinds.length > 1
                    ? html`
                        <md-outlined-select
                          label=${this.t("historyKind")}
                          .value=${this.selectedHistoryKind}
                          .displayText=${this.t(this.selectedHistoryKind === "legacy" ? "historyLegacy" : "historyExecution")}
                          @change=${(event: Event) => this.emit("gacha-history-kind-change", { historyKind: (event.target as HTMLSelectElement).value })}
                        >
                          ${this.historyKinds.map(
                            (kind) => html`
                              <md-select-option value=${kind} ?selected=${kind === this.selectedHistoryKind}>
                                <div slot="headline">
                                  ${this.t(kind === "legacy" ? "historyLegacy" : "historyExecution")}
                                </div>
                              </md-select-option>
                            `,
                          )}
                        </md-outlined-select>
                      `
                    : nothing
                }
                ${this.cloudControls()}
                ${
                  this.canRefresh
                    ? html`
                        <button
                          class="button button--filled"
                          type="button"
                          ?disabled=${this.busy || !this.selectedAccountKey}
                          @click=${() => this.emit("gacha-refresh", { accountKey: this.selectedAccountKey })}
                        >
                          ${icon("history")}${this.t("readHistory")}
                        </button>
                      `
                    : nothing
                }
                ${
                  this.showAppLink
                    ? html`
                        <p class="gacha-history__help">${this.t("browserHistoryHelp")}</p>
                        <button
                          type="button"
                          class="button button--tonal"
                          @click=${() => this.dispatchEvent(new CustomEvent("gacha-open-app", { bubbles: true, composed: true }))}
                        >
                          ${icon("open_in_new")}${this.t("openApp")}
                        </button>
                      `
                    : nothing
                }
                ${
                  this.catalogLoading || this.catalogError
                    ? html`
                        <div class="gacha-history__catalog stack" role="status" aria-live="polite">
                          <span>${this.catalogLoading ? this.t("catalogLoading") : this.catalogError}</span>
                          ${
                            this.canRetryCatalog && this.catalogError
                              ? html`
                                  <button
                                    type="button"
                                    class="button button--tonal"
                                    ?disabled=${this.catalogLoading}
                                    @click=${() => this.dispatchEvent(new CustomEvent("gacha-catalog-retry", { bubbles: true, composed: true }))}
                                  >
                                    ${icon("refresh")}${this.t("retryCatalog")}
                                  </button>
                                `
                              : nothing
                          }
                        </div>
                      `
                    : nothing
                }
                <span role="status" aria-live="polite" class="gacha-history__error">
                  ${this.imageError || this.error}
                </span>
              </section>
              ${this.busy || this.exportingImage ? loadingState(this.t(this.exportingImage ? "exportingImage" : "loading")) : nothing}
              ${
                scoped.length
                  ? html`
                      <section class="surface stack">
                        ${renderDetailSectionHeading(this.t("overview"), "stats")}
                        <dl class="gacha-history__metrics">
                          ${[
                            [this.t("total"), total],
                            [this.t("member"), count("member")],
                            [this.t("support"), count("support")],
                            [this.t("pickup"), pickupKnown || pickup > 0 ? pickup : "—"],
                          ].map(
                            ([label, value]) => html`
                              <div>
                                <dt>${label}</dt>
                                <dd>${typeof value === "number" ? value.toLocaleString(this.locale) : value}</dd>
                              </div>
                            `,
                          )}
                        </dl>
                        <dl class="spec-list">
                          ${
                            unknownDraws
                              ? html`
                                  <div>
                                    <dt>${this.t("unknownCount")}</dt>
                                    <dd>${this.t("batches", { count: unknownDraws })}</dd>
                                  </div>
                                `
                              : nothing
                          }
                        </dl>
                      </section>
                    `
                  : nothing
              }
              ${scoped.length ? this.renderAnalysis(scoped, true) : nothing}
              ${
                this.historyLoaded && scoped.length
                  ? html`
                      <section class="surface stack">
                        ${renderDetailSectionHeading(this.t("cost"), "stats")}
                        <dl class="spec-list">
                          ${this.costMetrics(scoped).map(
                            (metric) => html`
                              <div>
                                <dt>${metric.label}</dt>
                                <dd>${metric.value}</dd>
                              </div>
                            `,
                          )}
                        </dl>
                        ${accordion({
                          id: "gacha-conversion",
                          label: this.t("conversion"),
                          expanded: this.expanded.has("conversion"),
                          onExpandedChange: (open) => {
                            const next = new Set(this.expanded);
                            if (open) next.add("conversion");
                            else next.delete("conversion");
                            this.expanded = next;
                          },
                          content: this.conversionEditor(),
                        })}
                      </section>
                    `
                  : nothing
              }
              ${scoped.length ? this.renderAnalysis(scoped) : nothing}
              ${
                !filtered.length
                  ? emptyState({
                      title: !this.selectedAccountKey
                        ? this.t("emptyAccount")
                        : !accountBatches.length
                          ? this.t(this.historyLoaded ? "empty" : "historyNotLoaded")
                          : this.t("noResults"),
                      icon: "history",
                      action:
                        !this.accounts.length && this.canImport
                          ? html`
                              <button
                                class="button button--filled"
                                ?disabled=${this.busy}
                                @click=${() => this.openImport()}
                              >
                                ${icon("file_upload")}${this.t("import")}
                              </button>
                            `
                          : undefined,
                    })
                  : html`
                      <section class="stack">
                        ${renderDetailSectionHeading(this.t("records"), "cards", { level: 2 })}
                        ${repeat(
                          [...groups],
                          ([day]) => day,
                          ([day, batches]) =>
                            accordion({
                              id: `gacha-day-${day}`,
                              label:
                                day === "unknown"
                                  ? this.t("unknownTime")
                                  : new Intl.DateTimeFormat(this.locale, { dateStyle: "long" }).format(
                                      new Date(`${day}T12:00:00`),
                                    ),
                              metadata: this.drawSummary(batches),
                              expanded: this.expanded.has(day),
                              onExpandedChange: (expanded) => {
                                const next = new Set(this.expanded);
                                if (expanded) next.add(day);
                                else next.delete(day);
                                this.expanded = next;
                              },
                              content: this.expanded.has(day)
                                ? html`
                                    <div class="stack stack--loose">
                                      ${repeat(
                                        batches,
                                        (batch) => batch.id,
                                        (batch) => html`
                                          <article class="stack">
                                            <div class="row row--wrap row--between">
                                              <div>
                                                <strong>${poolMap.get(batch.poolId)?.name ?? batch.poolId}</strong>
                                                <div class="md-body-small">
                                                  ${
                                                    batch.pulledAt
                                                      ? html`
                                                          <time datetime=${batch.pulledAt}>
                                                            ${this.serverTime(batch.pulledAt, "time")}
                                                          </time>
                                                        `
                                                      : this.t("unknownTime")
                                                  }
                                                  ·
                                                  ${batch.drawCount == null ? this.t("unknownCount") : this.t("draws", { count: batch.drawCount })}
                                                </div>
                                              </div>
                                            </div>
                                            ${this.renderPrizes(this.prizes(batch))}
                                          </article>
                                        `,
                                      )}
                                    </div>
                                  `
                                : nothing,
                            }),
                        )}
                      </section>
                    `
              }
            </div>
          `,
        })}
      </div>
    `;
  }
  private cloudControls() {
    const disabled = this.cloudBusy || this.busy || !this.selectedAccountKey;
    const accountError = ["authentication_required", "email_verification_required", "account_restricted"].includes(
      this.cloudErrorCode,
    );
    const errors: Record<string, string> = {
      authentication_required: "cloudSignIn",
      email_verification_required: "cloudVerifyEmail",
      account_restricted: "cloudAccountRestricted",
      history_too_large: "cloudTooLarge",
      history_account_limit: "cloudAccountLimit",
      history_account_mismatch: "cloudAccountMismatch",
      history_server_mismatch: "cloudServerMismatch",
      history_session_expired: "errorSessionExpired",
      history_network_error: "cloudNetworkError",
      history_cloud_unavailable: "cloudUnavailable",
    };
    return accordion({
      id: "gacha-cloud",
      label: this.t("cloudTitle"),
      expanded: this.expanded.has("cloud"),
      onExpandedChange: (open) => {
        const next = new Set(this.expanded);
        if (open) next.add("cloud");
        else next.delete("cloud");
        this.expanded = next;
      },
      content: html`
        <div class="stack">
          ${
            !this.cloudSignedIn || accountError
              ? html`
                  <a class="button button--tonal" href=${`/${this.locale}/account/`}>
                    ${this.t(this.cloudSignedIn ? "cloudAccount" : "cloudSignIn")}
                  </a>
                `
              : nothing
          }
          ${
            this.cloudSignedIn
              ? html`
                  <div class="row row--wrap">
                    <button
                      class="button button--tonal"
                      type="button"
                      ?disabled=${disabled}
                      @click=${() => this.emit("gacha-cloud-link", { accountKey: this.selectedAccountKey, linked: !this.cloudLinked })}
                    >
                      ${this.t(this.cloudLinked ? "cloudUnlink" : "cloudLink")}
                    </button>
                    <button
                      class="button button--tonal"
                      type="button"
                      ?disabled=${disabled || !this.cloudLinked}
                      @click=${() => this.emit("gacha-cloud-sync", { accountKey: this.selectedAccountKey })}
                    >
                      ${this.t(this.cloudBusy ? "cloudSyncing" : "cloudSync")}
                    </button>
                    <button
                      class="button button--tonal"
                      type="button"
                      ?disabled=${disabled || !this.cloudLinked || this.cloudRefreshPending}
                      @click=${() => this.emit("gacha-cloud-refresh", { accountKey: this.selectedAccountKey })}
                    >
                      ${this.t(this.cloudRefreshPending ? "cloudRefreshPending" : "cloudRefresh")}
                    </button>
                  </div>
                `
              : nothing
          }
          ${
            errors[this.cloudErrorCode]
              ? html`
                  <span role="alert">${this.t(errors[this.cloudErrorCode])}</span>
                `
              : nothing
          }
        </div>
      `,
    });
  }
  private exchangeProgress(pool: GachaHistoryPool | undefined) {
    const targets = pool?.exchangeTargets ?? [];
    if (!targets.length) return nothing;
    const groups = new Map<string, GachaTargetProgress[]>();
    for (const target of targets) {
      const key = JSON.stringify([
        target.reward.resourceType,
        target.pointCost,
        target.basePointCost,
        target.pointBalance,
        target.pointsNeeded,
        target.additionalDrawsNeeded,
        target.remainingExchangeLimit,
        target.resetType,
      ]);
      const group = groups.get(key) ?? [];
      group.push(target);
      groups.set(key, group);
    }
    const fold = (id: string, label: string, content: unknown) =>
      accordion({
        id,
        label,
        expanded: this.expanded.has(id),
        onExpandedChange: (open) => {
          const next = new Set(this.expanded);
          if (open) next.add(id);
          else next.delete(id);
          this.expanded = next;
        },
        content,
      });
    const number = (value: number) => value.toLocaleString(this.locale);
    return fold(
      `exchange-${pool!.id}`,
      this.t("exchangeProgress"),
      html`
        <div class="stack stack--loose">
          ${[...groups.values()].map((group) => {
            const target = group[0];
            const facts: Array<[string, number]> = [
              [target.pointCost == null ? "basePointCost" : "pointCost", target.pointCost ?? target.basePointCost],
            ];
            if (target.pointBalance != null) facts.push(["pointBalance", target.pointBalance]);
            if (target.pointsNeeded != null) facts.push(["pointsNeeded", target.pointsNeeded]);
            if (target.additionalDrawsNeeded != null)
              facts.push(["additionalDrawsNeeded", target.additionalDrawsNeeded]);
            if (target.remainingExchangeLimit != null)
              facts.push(["remainingExchangeLimit", target.remainingExchangeLimit]);
            return html`
              <section class="stack">
                <h4 class="detail-section-title">${this.t(target.reward.resourceType === 2 ? "member" : "support")}</h4>
                <dl class="spec-list">
                  ${facts.map(
                    ([label, value]) => html`
                      <div>
                        <dt>${this.t(label)}</dt>
                        <dd>${number(value)}</dd>
                      </div>
                    `,
                  )}
                </dl>
                ${
                  target.pointBalance != null && target.pointCost != null
                    ? html`
                        <md-linear-progress
                          .value=${target.pointCost === 0 ? 1 : Math.min(1, target.pointBalance / target.pointCost)}
                          aria-label=${`${this.t("pointBalance")} ${number(target.pointBalance)} / ${this.t("pointCost")} ${number(target.pointCost)}`}
                        ></md-linear-progress>
                      `
                    : nothing
                }
                ${fold(
                  `exchange-targets-${pool!.id}-${target.exchangeProductId}`,
                  `${this.t("exchangeTargets")} · ${number(group.length)}`,
                  group.map((entry) => {
                    const reward = entry.reward;
                    const name = String(reward.name ?? reward.resourceId ?? "");
                    const details: Array<[string, string]> = [
                      [
                        this.t(entry.pointCost == null ? "basePointCost" : "pointCost"),
                        number(entry.pointCost ?? entry.basePointCost),
                      ],
                    ];
                    if (entry.redeemedCount != null)
                      details.push([this.t("redeemedCount"), number(entry.redeemedCount)]);
                    if (entry.remainingExchangeLimit != null)
                      details.push([this.t("remainingExchangeLimit"), number(entry.remainingExchangeLimit)]);
                    if (entry.resetType != null)
                      details.push([
                        this.t("resetType"),
                        this.t(
                          (
                            { 1: "resetNever", 2: "resetDaily", 3: "resetWeekly", 4: "resetMonthly" } as Record<
                              number,
                              string
                            >
                          )[entry.resetType],
                        ),
                      ]);
                    return html`
                      <section class="stack">
                        ${collectionList([
                          {
                            id: entry.exchangeProductId,
                            title: name,
                            subtitle: details[0].join(" · "),
                            href: typeof reward.href === "string" ? reward.href : undefined,
                            media: html`
                              <span style="display:block;width:56px;height:56px">
                                ${gachaPrizeCard({
                                  label: name,
                                  kind: reward.resourceType === 2 ? "member" : "support",
                                  rarity:
                                    typeof reward.rarity === "number" || typeof reward.rarity === "string"
                                      ? reward.rarity
                                      : "",
                                  image: String(reward.image ?? ""),
                                  attribute: String(reward.attributeImageUrl ?? ""),
                                  rarityMark: String(reward.rarityImageUrl ?? ""),
                                  count: Number(reward.count ?? 1),
                                })}
                              </span>
                            `,
                          },
                        ])}
                        <dl class="spec-list">
                          ${details.slice(1).map(
                            ([label, value]) => html`
                              <div>
                                <dt>${label}</dt>
                                <dd>${value}</dd>
                              </div>
                            `,
                          )}
                        </dl>
                      </section>
                    `;
                  }),
                )}
              </section>
            `;
          })}
        </div>
      `,
    );
  }

  private renderAnalysis(batches: readonly GachaHistoryBatch[], chartsOnly = false) {
    const stats = this.analysis(batches);
    const progress = gachaHistoryProgress(batches);
    const interval = (range: { min: number; max: number } | null) =>
      range == null
        ? "—"
        : range.min === range.max
          ? range.min.toLocaleString(this.locale, { maximumFractionDigits: 2 })
          : `${range.min.toLocaleString(this.locale, { maximumFractionDigits: 2 })}–${range.max.toLocaleString(this.locale, { maximumFractionDigits: 2 })}`;
    const chart = (
      label: string,
      categories: string[],
      series: Array<{ name: string; values: number[] }>,
      horizontal = false,
      grouped = false,
      caption = "",
      details: string[] = [],
    ) => html`
      <section class="surface stack">
        ${renderDetailSectionHeading(label, "cards", { level: 3 })}
        ${
          caption
            ? html`
                <div class="md-body-small">${caption}</div>
              `
            : nothing
        }
        <gacha-history-chart .data=${{ label, categories, series, horizontal, grouped, details }}></gacha-history-chart>
      </section>
    `;
    const composition = (rows: Array<{ member: number; support: number; other: number }>) =>
      (["member", "support", "other"] as const).map((key) => ({
        name: this.t(key === "other" ? "item" : key),
        values: rows.map((row) => row[key]),
      }));
    const cards = new Map(
      batches.flatMap((batch) => batch.prizes).map((prize) => [`${prize.kind}:${prize.id}`, prize]),
    );
    if (chartsOnly)
      return html`
        <div class="gacha-history__charts">
          ${stats.kinds
            .filter((kind) => kind.kind === "member" || kind.kind === "support")
            .map((kind) =>
              chart(
                `${this.t(kind.kind)} · ${this.t("rarityDistribution")}`,
                kind.distribution
                  .filter(
                    (row) =>
                      ["SSR", "SR", "R"].includes(row.rarity) ||
                      (row.count > 0 && row.rarity !== "item" && row.rarity !== "unknown"),
                  )
                  .map((row) => `${row.rarity} · ${this.percent(row.count, kind.total)}`),
                (["nonPickup", "pickup"] as const).map((key) => ({
                  name: this.t(key),
                  values: kind.distribution
                    .filter(
                      (row) =>
                        ["SSR", "SR", "R"].includes(row.rarity) ||
                        (row.count > 0 && row.rarity !== "item" && row.rarity !== "unknown"),
                    )
                    .map((row) => row[key]),
                })),
                true,
                false,
                `${this.t(kind.kind)} ${kind.total.toLocaleString(this.locale)} · ${this.t("ssrRate")} ${this.percent(kind.ssr, kind.total)}`,
              ),
            )}
          ${chart(
            this.t("dailyTrend"),
            stats.days.map((day) => day.day ?? this.t("unknownTime")),
            composition(stats.days),
            false,
            false,
            "",
            stats.days.map((day) => `${this.t("pickup")} ${day.pickup}`),
          )}
          ${chart(
            this.t("poolComposition"),
            stats.pools.map((pool) => this.poolMap.get(pool.poolId ?? "")?.name ?? pool.poolId ?? this.t("unknown")),
            composition(stats.pools),
            true,
          )}
        </div>
      `;
    return html`
      <section class="stack">
        ${renderDetailSectionHeading(this.t("luck"), "cards", { level: 2 })}
        <div class="gacha-history__charts">
          ${stats.pools.map(
            (pool) => html`
              <section class="surface stack">
                <h3 class="detail-section-title">
                  ${
                    this.poolMap.get(pool.poolId ?? "")?.imageUrl
                      ? html`
                          <img
                            src=${this.poolMap.get(pool.poolId ?? "")!.imageUrl!}
                            width="96"
                            height="48"
                            loading="lazy"
                            alt=""
                            class="gacha-history__pool-image"
                            @error=${(event: Event) => {
                              (event.currentTarget as HTMLImageElement).hidden = true;
                            }}
                          />
                        `
                      : nothing
                  }
                  <span>${this.poolMap.get(pool.poolId ?? "")?.name ?? pool.poolId ?? this.t("unknown")}</span>
                </h3>
                <dl class="spec-list">
                  <div>
                    <dt>${this.t("total")}</dt>
                    <dd>${pool.total.toLocaleString(this.locale)}</dd>
                  </div>
                  <div>
                    <dt>SSR / EX / BD</dt>
                    <dd>
                      ${pool.high} ·
                      ${pool.observedHighRate == null ? "—" : new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 }).format(pool.observedHighRate)}
                    </dd>
                  </div>
                  <div>
                    <dt>${this.t("expected")}</dt>
                    <dd>
                      ${pool.expectedHigh == null ? "—" : pool.expectedHigh.toLocaleString(this.locale, { maximumFractionDigits: 2 })}
                    </dd>
                  </div>
                  <div>
                    <dt>${this.t("difference")}</dt>
                    <dd>
                      ${pool.delta == null ? "—" : new Intl.NumberFormat(this.locale, { maximumFractionDigits: 2, signDisplay: "always" }).format(pool.delta)}
                    </dd>
                  </div>
                  <div>
                    <dt>${this.t("pickup")}</dt>
                    <dd>${pool.pickup}</dd>
                  </div>
                </dl>
                ${this.exchangeProgress(this.poolMap.get(pool.poolId ?? ""))}
                ${progress.pools
                  .find((row) => row.poolId === pool.poolId)
                  ?.kinds.map(
                    (kind) => html`
                      <section class="stack">
                        <h4 class="detail-section-title">${this.t(kind.kind)}</h4>
                        ${collectionTable(
                          this.t(kind.kind),
                          [
                            this.t("resultType"),
                            this.t("quantity"),
                            this.t("averageHitDraws"),
                            this.t("trailingMisses"),
                          ],
                          (["high", "pickup"] as const).map((target) => [
                            target === "high"
                              ? html`
                                  <span title="SSR / EX / BD">${this.t("highRarity")}</span>
                                `
                              : this.t("pickup"),
                            kind[target].count,
                            kind[target].count
                              ? (pool.total / kind[target].count).toLocaleString(this.locale, {
                                  maximumFractionDigits: 2,
                                })
                              : "—",
                            interval(kind[target].trailingMisses),
                          ]),
                          { numeric: true },
                        )}
                        ${(["high", "pickup"] as const).map((target) =>
                          accordion({
                            id: `gacha-${target}-${pool.poolId}-${kind.kind}`,
                            label: this.t(target === "high" ? "highHistory" : "pickupHistory"),
                            expanded: this.expanded.has(`${target}-${pool.poolId}-${kind.kind}`),
                            onExpandedChange: (open) => {
                              const key = `${target}-${pool.poolId}-${kind.kind}`;
                              const next = new Set(this.expanded);
                              if (open) next.add(key);
                              else next.delete(key);
                              this.expanded = next;
                            },
                            content: html`
                              <div class="stack">
                                <dl class="spec-list">
                                  <div>
                                    <dt>${this.t("shortestMissGap")}</dt>
                                    <dd>${interval(kind[target].gaps.shortest)}</dd>
                                  </div>
                                  <div>
                                    <dt>${this.t("longestMissGap")}</dt>
                                    <dd>${interval(kind[target].gaps.longest)}</dd>
                                  </div>
                                  <div>
                                    <dt>${this.t("meanMissGap")}</dt>
                                    <dd>${interval(kind[target].gaps.mean)}</dd>
                                  </div>
                                </dl>
                                ${collectionTable(
                                  this.t(target === "high" ? "highHistory" : "pickupHistory"),
                                  [this.t("poolPosition"), this.t("quantity")],
                                  kind[target].hitBatches.map((hit) => [interval(hit.poolPosition), hit.count]),
                                )}
                              </div>
                            `,
                          }),
                        )}
                      </section>
                    `,
                  )}
              </section>
            `,
          )}
        </div>
      </section>
      <section class="stack">
        <div class="row row--between row--wrap">
          ${renderDetailSectionHeading(this.t("highlights"), "cards", { level: 2 })}
          <label class="row gacha-history__toggle">
            <input
              type="checkbox"
              .checked=${this.allCards}
              @change=${(event: Event) => {
                this.allCards = (event.target as HTMLInputElement).checked;
              }}
            />
            ${this.t("allCards")}
          </label>
          <label class="row">
            <input
              type="checkbox"
              .checked=${this.onlyPickup}
              @change=${(event: Event) => {
                this.onlyPickup = (event.target as HTMLInputElement).checked;
              }}
            />
            ${this.t("onlyPickup")}
          </label>
        </div>
        ${segmented({
          label: `${this.t("highlights")} · ${this.t("kind")}`,
          value: this.albumKind,
          options: [
            { value: "all", label: this.t("allKinds") },
            { value: "member", label: this.t("member") },
            { value: "support", label: this.t("support") },
          ],
          onSelect: (value) => {
            this.albumKind = value;
          },
        })}
        ${stats.pools.map((pool) => {
          const poolCards = this.analysis(batches.filter((batch) => batch.poolId === pool.poolId)).cards;
          return html`
            <section class="stack">
              <h3 class="detail-section-title">
                ${
                  this.poolMap.get(pool.poolId ?? "")?.imageUrl
                    ? html`
                        <img
                          class="gacha-history__pool-image"
                          @error=${(event: Event) => {
                            (event.currentTarget as HTMLImageElement).hidden = true;
                          }}
                          src=${this.poolMap.get(pool.poolId ?? "")!.imageUrl!}
                          width="96"
                          height="48"
                          loading="lazy"
                          alt=""
                        />
                      `
                    : nothing
                }
                ${this.poolMap.get(pool.poolId ?? "")?.name ?? pool.poolId ?? this.t("unknown")}
              </h3>
              ${(["member", "support"] as const)
                .filter((kind) => this.albumKind === "all" || this.albumKind === kind)
                .map(
                  (kind) => html`
                    <section class="stack">
                      <h4 class="detail-section-title">${this.t(kind)}</h4>
                      <div class="gacha-stats" data-kind=${kind}>
                        ${poolCards
                          .filter(
                            (card) =>
                              card.kind === kind &&
                              (this.allCards ||
                                [4, 10, 20].includes(Number(cards.get(card.key)?.rarity)) ||
                                card.pickup > 0) &&
                              (!this.onlyPickup || card.pickup > 0),
                          )
                          .map((card) => {
                            const prize = cards.get(card.key)!;
                            return gachaPrizeCard({
                              label: `${prize.name} · ×${card.count} · ${this.t("pickup")} ${card.pickup}`,
                              kind,
                              rarity: prize.rarity,
                              href: prize.href,
                              image: prize.imageUrl,
                              attribute: prize.attributeImageUrl,
                              rarityMark: prize.rarityImageUrl,
                              count: card.count,
                              pickupCount: card.pickup,
                              pickup: card.pickup > 0,
                            });
                          })}
                      </div>
                    </section>
                  `,
                )}
            </section>
          `;
        })}
      </section>
    `;
  }

  private conversionEditor() {
    const conversion = this.currencyConversion;
    if (!conversion) return nothing;
    return keyed(
      this.selectedAccountKey,
      html`
        <form
          class="stack"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const form = event.currentTarget as HTMLFormElement;
            if (form.reportValidity())
              this.emit("gacha-conversion-change", {
                currencyCode: conversion.currencyCode,
                freeUnitGemPrice:
                  (form.elements.namedItem("freeUnitGemPrice") as HTMLInputElement).value === ""
                    ? null
                    : (form.elements.namedItem("freeUnitGemPrice") as HTMLInputElement).valueAsNumber,
                paidUnitGemPrice:
                  (form.elements.namedItem("paidUnitGemPrice") as HTMLInputElement).value === ""
                    ? null
                    : (form.elements.namedItem("paidUnitGemPrice") as HTMLInputElement).valueAsNumber,
              });
          }}
        >
          <md-outlined-select
            label=${this.t("currency")}
            .value=${conversion.currencyCode}
            .displayText=${conversion.currencyCode}
            @change=${(event: Event) => this.emit("gacha-conversion-change", { currencyCode: (event.target as HTMLSelectElement).value, freeUnitGemPrice: 0, paidUnitGemPrice: null })}
          >
            ${["JPY", "TWD", "HKD", "MOP", "USD", "KRW", "CNY"].map(
              (code) => html`
                <md-select-option value=${code} ?selected=${code === conversion.currencyCode}>
                  <div slot="headline">${code}</div>
                </md-select-option>
              `,
            )}
          </md-outlined-select>
          ${(["freeUnitGemPrice", "paidUnitGemPrice"] as const).map(
            (key) => html`
              <label class="field">
                <span>${this.t(key)} · ${conversion.currencyCode}</span>
                <input
                  name=${key}
                  type="number"
                  min="0"
                  step="any"
                  inputmode="decimal"
                  .value=${conversion[key] == null ? "" : String(conversion[key])}
                />
              </label>
            `,
          )}
          <button class="button button--tonal" type="submit">${this.t("applyPrice")}</button>
        </form>
      `,
    );
  }
  private openImport() {
    if (this.importSources.length) this.importSourceOpen = true;
    else this.emit("gacha-import", undefined);
  }
  private costMetrics(batches: readonly GachaHistoryBatch[]) {
    const costs = this.analysis(batches).cost;
    const metrics = (Object.keys(costs) as (keyof GachaHistoryCost)[]).map((key) => ({
      label: this.t(key),
      value:
        costs[key].value == null
          ? "—"
          : `${costs[key].partial ? "≥ " : ""}${costs[key].value!.toLocaleString(this.locale)}`,
    }));
    const conversion = this.currencyConversion;
    if (conversion) {
      const amounts = summarizeGachaHistoryMoney(costs, conversion);
      const money = (amount: { value: number | null; partial: boolean }) =>
        amount.value == null
          ? "—"
          : `${amount.partial ? "≥ " : ""}${new Intl.NumberFormat(this.locale, { style: "currency", currency: conversion.currencyCode }).format(amount.value)}`;
      metrics.push(
        { label: this.t("freeValue"), value: money(amounts.freeGems) },
        { label: this.t("paidValue"), value: money(amounts.paidGems) },
      );
    }
    return metrics;
  }
  private report(batches: readonly GachaHistoryBatch[]): GachaHistoryReport {
    const prizes = batches.flatMap((batch) => batch.prizes);
    const knownDraws = batches.filter((batch) => batch.drawCount != null);
    const metrics = [
      {
        label: this.t("total"),
        value: knownDraws.length
          ? knownDraws.reduce((sum, batch) => sum + batch.drawCount!, 0).toLocaleString(this.locale)
          : "—",
      },
      ...["member", "support"].map((kind) => ({
        label: this.t(kind),
        value: prizes
          .filter((prize) => prize.kind === kind)
          .reduce((sum, prize) => sum + prize.quantity, 0)
          .toLocaleString(this.locale),
      })),
      { label: this.t("pickup"), value: this.analysis(batches).pickup.toLocaleString(this.locale) },
    ];
    const stats = this.analysis(batches);
    const groups = stats.pools.flatMap((pool) => {
      const selected = batches.filter((batch) => batch.poolId === pool.poolId);
      const cardMap = new Map(
        selected.flatMap((batch) => batch.prizes).map((prize) => [`${prize.kind}:${prize.id}`, prize]),
      );
      const poolStats = this.analysis(selected);
      return (["member", "support"] as const).map((kind) => ({
        label: `${this.poolMap.get(pool.poolId ?? "")?.name ?? pool.poolId ?? this.t("unknown")} · ${this.t(kind)}`,
        imageUrl: this.poolMap.get(pool.poolId ?? "")?.imageUrl,
        cards: poolStats.cards
          .filter(
            (card) =>
              card.kind === kind && ([4, 10, 20].includes(Number(cardMap.get(card.key)?.rarity)) || card.pickup > 0),
          )
          .map((card): GachaHistoryReportCard => {
            const prize = cardMap.get(card.key)!;
            return {
              name: prize.name,
              kindLabel: this.t(kind),
              quantity: card.count,
              imageUrl: prize.imageUrl,
              attributeImageUrl: prize.attributeImageUrl,
              rarityImageUrl: prize.rarityImageUrl,
              pickup: card.pickup,
            };
          }),
      }));
    });
    const charts = stats.kinds
      .filter((kind) => kind.kind === "member" || kind.kind === "support")
      .map((kind) => ({
        label: `${this.t(kind.kind)} · ${this.t("rarityDistribution")}`,
        caption: `${this.t(kind.kind)} ${kind.total.toLocaleString(this.locale)} · ${this.t("ssrRate")} ${this.percent(kind.ssr, kind.total)}`,
        legend: [this.t("nonPickup"), this.t("pickup")],
        rows: kind.distribution
          .filter(
            (row) =>
              ["SSR", "SR", "R"].includes(row.rarity) ||
              (row.count > 0 && row.rarity !== "item" && row.rarity !== "unknown"),
          )
          .map((row) => ({
            label: `${row.rarity} · ${this.percent(row.count, kind.total)}`,
            values: [row.nonPickup, row.pickup],
          })),
      }));
    const dates = batches
      .map((batch) => batch.pulledAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const date = (value: string) => this.serverTime(value, "date");
    const scope = [dates.length ? `${date(dates[0])} – ${date(dates[dates.length - 1])}` : this.t("unknownTime")];
    if (dates.length && dates.length !== batches.length) scope.push(this.t("unknownTime"));
    return { title: this.t("title"), scope, metrics, groups, charts };
  }
  private cancelImageExport() {
    ++this.imageGeneration;
    this.imageRequest?.abort();
    this.imageRequest = undefined;
    for (const file of this.imageFiles) URL.revokeObjectURL(file.url);
    if (this.imageFiles.length) this.imageFiles = [];
    this.exportingImage = false;
  }
  private renderImagePreview() {
    if (!this.imageFiles.length) return nothing;
    return html`
      <dialog class="dialog" aria-label=${this.t("imagePreview")} ${modal(() => this.cancelImageExport())}>
        <header class="dialog__header">
          <div class="row row--between">
            <h2>${this.t("imagePreview")}</h2>
            ${iconButton({ icon: "close", label: this.t("close"), onClick: () => this.cancelImageExport() })}
          </div>
        </header>
        <div class="dialog__body">
          <image-gallery
            natural
            .locale=${this.locale}
            .title=${this.t("imagePreview")}
            .images=${this.imageFiles.map((file, index) => ({ id: file.filename, source: file.url, label: `${index + 1} / ${this.imageFiles.length}`, width: file.width, height: file.height }))}
          ></image-gallery>
        </div>
        <footer class="dialog__actions">
          <button
            class="button button--filled"
            ?disabled=${this.savingImage}
            @click=${() => void this.saveImageFiles()}
          >
            ${icon("file_download")}${this.t("saveImage")}
          </button>
        </footer>
      </dialog>
    `;
  }
  private async exportImage(report: GachaHistoryReport) {
    this.cancelImageExport();
    const request = (this.imageRequest = new AbortController());
    this.exportingImage = true;
    this.imageError = "";
    try {
      const { renderGachaHistoryImages } = await import("../lib/gacha-history-image");
      const images = await renderGachaHistoryImages(report, { signal: request.signal });
      const files = [];
      for (const [index, blob] of images.entries()) {
        const bitmap = await createImageBitmap(blob);
        files.push({
          blob,
          filename: `haneoka-gacha-history-${index + 1}.png`,
          width: bitmap.width,
          height: bitmap.height,
        });
        bitmap.close();
      }
      request.signal.throwIfAborted();
      this.imageFiles = files.map((file) => ({ ...file, url: URL.createObjectURL(file.blob) }));
    } catch {
      if (!request.signal.aborted) this.imageError = this.t("exportImageFailed");
    } finally {
      if (this.imageRequest === request) {
        this.imageRequest = undefined;
        this.exportingImage = false;
      }
    }
  }
  private async saveImageFiles() {
    const files = this.imageFiles,
      generation = this.imageGeneration;
    if (!files.length || this.savingImage) return;
    this.savingImage = true;
    try {
      const handled = !this.dispatchEvent(
        new CustomEvent("gacha-export-image", { detail: { files }, bubbles: true, composed: true, cancelable: true }),
      );
      if (!handled) {
        let file: { blob: Blob; filename: string } = files[0];
        if (files.length > 1) {
          const { zipSync } = await import("fflate");
          const entries = Object.fromEntries(
            await Promise.all(
              files.map(async (item) => [item.filename, new Uint8Array(await item.blob.arrayBuffer())]),
            ),
          );
          const archive = Uint8Array.from(zipSync(entries, { level: 0 }));
          file = {
            filename: "haneoka-gacha-history.zip",
            blob: new Blob([archive.buffer], { type: "application/zip" }),
          };
        }
        if (generation !== this.imageGeneration) return;
        const url = URL.createObjectURL(file.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch {
      this.imageError = this.t("exportImageFailed");
    } finally {
      this.savingImage = false;
    }
  }
  private drawSummary(batches: readonly GachaHistoryBatch[]) {
    const known = batches.filter((batch) => batch.drawCount != null);
    const unknown = batches.length - known.length;
    return [
      known.length ? this.t("draws", { count: known.reduce((sum, batch) => sum + batch.drawCount!, 0) }) : "",
      unknown ? this.t("unknownDraws", { count: unknown }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  private renderPrizes(prizes: readonly GachaHistoryPrize[]) {
    const subtitle = (prize: GachaHistoryPrize) =>
      [
        this.t(prize.kind),
        prize.rarityLabel,
        `×${prize.quantity}`,
        prize.pickup === true ? this.t("pickup") : "",
        prize.converted ? this.t("converted") : "",
      ]
        .filter(Boolean)
        .join(" · ");
    if (this.view === "table")
      return collectionTable(
        this.t("records"),
        [this.t("card"), this.t("kind"), this.t("rarity"), this.t("quantity"), this.t("pickup"), this.t("converted")],
        prizes.map((prize) => [
          prize.href
            ? html`
                <a href=${prize.href}>${prize.name}</a>
              `
            : prize.name,
          this.t(prize.kind),
          prize.rarityLabel || "—",
          prize.quantity,
          prize.pickup == null ? "—" : prize.pickup ? this.t("yes") : this.t("no"),
          prize.converted == null ? "—" : prize.converted ? this.t("yes") : this.t("no"),
        ]),
      );
    if (this.view === "list")
      return collectionList(
        prizes.map((prize, index) => ({
          id: `${prize.id}-${index}`,
          title: prize.name,
          subtitle: subtitle(prize),
          href: prize.href,
          media: prize.imageUrl
            ? html`
                <img src=${prize.imageUrl} alt="" loading="lazy" decoding="async" width="56" height="56" />
              `
            : icon("image"),
        })),
      );
    return html`
      <div class="gacha-pulls__cards">
        ${prizes.map((prize) => gachaPrizeCard({ label: `${prize.name} · ${subtitle(prize)}`, kind: prize.kind, rarity: prize.rarity, href: prize.href, image: prize.imageUrl, attribute: prize.attributeImageUrl, rarityMark: prize.rarityImageUrl, count: prize.quantity, pickup: prize.pickup === true }))}
      </div>
    `;
  }
}
if (!customElements.get("gacha-history")) customElements.define("gacha-history", GachaHistory);
