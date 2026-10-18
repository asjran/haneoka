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
import { iconButton, inputChip } from "./ui/controls";
import { icon } from "./ui/icon";
import { accordion } from "./ui/accordion";
import { collectionList, collectionTable, viewSwitch, type CollectionView } from "./ui/collection-view";
import { tile } from "./ui/tile";
import { LazyImages } from "./ui/lazy-images";
import type { GachaHistoryReport } from "../lib/gacha-history-image";
import { emptyState, loadingState } from "./ui/state";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import "../styles/gacha-history.css";
import { renderLocalSaveSourcePicker } from "./shared/local-save-source-picker";

type Axis = "category" | "pool" | "kind" | "rarity";
const OWNER = "gacha-history";
const dayOf = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export class GachaHistory extends LitElement {
  static properties = {
    importSources: { attribute: false },
    importSourceOpen: { state: true },
    currencyConversion: { attribute: false },
    exportingImage: { state: true },
    imageError: { state: true },
    locale: {},
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
  declare importSources: readonly GachaHistoryImportSource[];
  declare private importSourceOpen: boolean;
  declare currencyConversion?: GachaHistoryConversion;
  declare private exportingImage: boolean;
  declare private imageError: string;
  declare locale: string;
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
    this.locale = "ja";
    this.historyLoaded = false;
    this.catalogLoading = false;
    this.catalogError = "";
    this.canRetryCatalog = false;
    this.showAppLink = false;
    this.importSources = [];
    this.importSourceOpen = false;
    this.exportingImage = false;
    this.imageError = "";
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
    this.filters = { category: [], pool: [], kind: [], rarity: [] };
    this.from = "";
    this.to = "";
    this.oldest = false;
    this.view = "grid";
    this.expanded = new Set();
  }
  createRenderRoot() {
    return this;
  }
  private t(key: string, values: Record<string, string | number> = {}) {
    return clientText(this.locale, `catalog.gachaHistory.${key}`, "", values);
  }
  private emit<K extends keyof GachaHistoryEvents>(type: K, detail: GachaHistoryEvents[K]["detail"]) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
  protected update(changed: PropertyValues) {
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
    this.filters = { category: [], pool: [], kind: [], rarity: [] };
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
        day = batch.pulledAt ? dayOf(new Date(batch.pulledAt)) : "";
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
          (!this.query.trim() && !this.filters.kind.length && !this.filters.rarity.length) || this.prizes(batch).length,
      )
      .sort((a, b) => {
        if (!a.pulledAt) return b.pulledAt ? 1 : 0;
        if (!b.pulledAt) return -1;
        return (new Date(a.pulledAt).getTime() - new Date(b.pulledAt).getTime()) * (this.oldest ? 1 : -1);
      });
    const prizes = filtered.flatMap((batch) => this.prizes(batch));
    const unknownDraws = scoped.filter((batch) => batch.drawCount == null).length;
    const total = scoped.some((batch) => batch.drawCount != null)
      ? scoped.reduce((sum, batch) => sum + (batch.drawCount ?? 0), 0)
      : "—";
    const count = (kind: string) =>
      prizes.filter((prize) => prize.kind === kind).reduce((sum, prize) => sum + prize.quantity, 0);
    const rarity = new Map<string, { label: string; count: number }>();
    for (const prize of prizes) {
      if (prize.kind === "item" || !prize.rarityLabel) continue;
      const key = String(prize.rarity),
        current = rarity.get(key);
      rarity.set(key, { label: prize.rarityLabel, count: (current?.count ?? 0) + prize.quantity });
    }
    const groups = new Map<string, GachaHistoryBatch[]>();
    for (const batch of filtered) {
      const day = batch.pulledAt ? dayOf(new Date(batch.pulledAt)) : "unknown";
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
            const value = axis === "kind" ? prize.kind : String(prize.rarity);
            const label = axis === "kind" ? this.t(prize.kind) : prize.rarityLabel;
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
            ${iconButton({ label: this.t("exportImage"), icon: "image", disabled: !scoped.length || this.exportingImage, onClick: () => void this.exportImage(report) })}
            ${iconButton({ label: this.t("import"), icon: "file_upload", disabled: !this.canImport || this.busy, onClick: () => this.openImport() })}
            ${iconButton({ label: this.t("refresh"), icon: "refresh", disabled: !this.canRefresh || this.busy || !this.selectedAccountKey, onClick: () => this.emit("gacha-refresh", { accountKey: this.selectedAccountKey }) })}
            ${iconButton({ label: this.t("export"), icon: "file_download", disabled: !this.canExport || !filtered.length, onClick: () => this.emit("gacha-export", { accountKey: this.selectedAccountKey, batches: filtered }) })}
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
                ${renderDetailSectionHeading(this.t("account"), "accounts")}
                <label class="field">
                  <span class="sr-only">${this.t("account")}</span>
                  <select
                    .value=${this.selectedAccountKey}
                    ?disabled=${!this.accounts.length || this.busy}
                    @change=${(event: Event) => this.emit("gacha-account-change", { accountKey: (event.target as HTMLSelectElement).value })}
                  >
                    <option value="">${this.t("selectAccount")}</option>
                    ${this.accounts.map(
                      (account) => html`
                        <option value=${account.key} ?selected=${account.key === this.selectedAccountKey}>
                          ${account.serverLabel} · ${account.label}
                        </option>
                      `,
                    )}
                  </select>
                </label>
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
                          ${[...rarity].map(
                            ([, value]) => html`
                              <div>
                                <dt>${value.label}</dt>
                                <dd>${value.count.toLocaleString(this.locale)}</dd>
                              </div>
                            `,
                          )}
                        </dl>
                      </section>
                    `
                  : nothing
              }
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
                        ${this.conversionEditor()}
                      </section>
                    `
                  : nothing
              }
              ${
                scoped.length
                  ? [false, true].map((byDate) =>
                      accordion({
                        id: `gacha-summary-${byDate ? "time" : "pool"}`,
                        label: this.t(byDate ? "timeBreakdown" : "poolBreakdown"),
                        expanded: this.expanded.has(byDate ? "summary-time" : "summary-pool"),
                        onExpandedChange: (open) => {
                          const next = new Set(this.expanded);
                          const key = byDate ? "summary-time" : "summary-pool";
                          if (open) next.add(key);
                          else next.delete(key);
                          this.expanded = next;
                        },
                        content: this.breakdown(scoped, byDate),
                      }),
                    )
                  : nothing
              }
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
                                                            ${new Intl.DateTimeFormat(this.locale, { timeStyle: "short" }).format(new Date(batch.pulledAt))}
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
            const input = (event.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>(
              'input[type="number"]',
            )!;
            const price = input.valueAsNumber;
            if (input.validity.valid && Number.isFinite(price) && price >= 0)
              this.emit("gacha-conversion-change", { currencyCode: conversion.currencyCode, unitGemPrice: price });
          }}
        >
          <label class="field">
            <span>${this.t("currency")}</span>
            <select
              .value=${conversion.currencyCode}
              @change=${(event: Event) => this.emit("gacha-conversion-change", { currencyCode: (event.target as HTMLSelectElement).value, unitGemPrice: null })}
            >
              ${["JPY", "TWD", "HKD", "MOP", "USD", "KRW", "CNY"].map(
                (code) => html`
                  <option value=${code} ?selected=${code === conversion.currencyCode}>${code}</option>
                `,
              )}
            </select>
          </label>
          <label class="field">
            <span>${this.t("unitGemPrice")} · ${conversion.currencyCode}</span>
            <input
              type="number"
              min="0"
              step="any"
              inputmode="decimal"
              required
              .value=${conversion.unitGemPrice == null ? "" : String(conversion.unitGemPrice)}
            />
          </label>
          <button class="button button--tonal" type="submit">${this.t("applyPrice")}</button>
        </form>
      `,
    );
  }
  private openImport() {
    if (this.importSources.length) this.importSourceOpen = true;
    else this.emit("gacha-import", undefined);
  }
  private breakdown(batches: readonly GachaHistoryBatch[], byDate: boolean) {
    const groups = new Map<string, GachaHistoryBatch[]>();
    for (const batch of batches) {
      const key = byDate ? (batch.pulledAt ? dayOf(new Date(batch.pulledAt)) : "unknown") : batch.poolId;
      const group = groups.get(key);
      if (group) group.push(batch);
      else groups.set(key, [batch]);
    }
    return collectionTable(
      this.t(byDate ? "timeBreakdown" : "poolBreakdown"),
      [
        this.t(byDate ? "timeBreakdown" : "pool"),
        this.t("total"),
        "SSR",
        "EX",
        "BD",
        this.t("freeGems"),
        this.t("paidGems"),
        this.t("tickets"),
      ],
      [...groups].map(([key, values]) => [
        byDate
          ? key === "unknown"
            ? this.t("unknownTime")
            : new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(new Date(`${key}T12:00:00`))
          : (this.poolMap.get(key)?.name ?? key),
        this.drawSummary(values),
        ...["4", "10", "20"].map((rarity) =>
          values
            .flatMap((batch) => batch.prizes)
            .filter((prize) => String(prize.rarity) === rarity)
            .reduce((sum, prize) => sum + prize.quantity, 0)
            .toLocaleString(this.locale),
        ),
        ...this.costMetrics(values)
          .slice(0, 3)
          .map((metric) => metric.value),
      ]),
    );
  }
  private costMetrics(batches: readonly GachaHistoryBatch[]) {
    const total = (key: keyof GachaHistoryCost) => {
      const values = batches.map((batch) => batch.cost?.[key]);
      return {
        value: values.some((value) => value != null)
          ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
          : null,
        partial: values.some((value) => value == null),
      };
    };
    const costs = { freeGems: total("freeGems"), paidGems: total("paidGems"), tickets: total("tickets") };
    const metrics = (Object.keys(costs) as (keyof GachaHistoryCost)[]).map((key) => ({
      label: this.t(key),
      value:
        costs[key].value == null
          ? "—"
          : `${costs[key].partial ? "≥ " : ""}${costs[key].value!.toLocaleString(this.locale)}`,
    }));
    const conversion = this.currencyConversion;
    if (conversion) {
      const price = conversion.unitGemPrice;
      const money = (value: number | null, partial: boolean) =>
        value == null || price == null
          ? "—"
          : `${partial ? "≥ " : ""}${new Intl.NumberFormat(this.locale, { style: "currency", currency: conversion.currencyCode }).format(value * price)}`;
      metrics.push(
        {
          label: this.t("allGemValue"),
          value: money(
            costs.freeGems.value == null || costs.paidGems.value == null
              ? null
              : costs.freeGems.value + costs.paidGems.value,
            costs.freeGems.partial || costs.paidGems.partial,
          ),
        },
        { label: this.t("paidGemValue"), value: money(costs.paidGems.value, costs.paidGems.partial) },
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
      ...this.costMetrics(batches),
    ];
    if (this.currencyConversion)
      metrics.push({
        label: `${this.t("unitGemPrice")} · ${this.currencyConversion.currencyCode}`,
        value: this.currencyConversion.unitGemPrice?.toLocaleString(this.locale, { maximumFractionDigits: 8 }) ?? "—",
      });
    if (knownDraws.length !== batches.length)
      metrics.push({
        label: this.t("unknownCount"),
        value: this.t("batches", { count: batches.length - knownDraws.length }),
      });
    const rarity = new Map<string, number>();
    for (const prize of prizes)
      if (prize.rarityLabel && (prize.kind === "member" || prize.kind === "support"))
        rarity.set(prize.rarityLabel, (rarity.get(prize.rarityLabel) ?? 0) + prize.quantity);
    for (const [label, count] of rarity) metrics.push({ label, value: count.toLocaleString(this.locale) });
    const groups = ["SSR", "EX", "BD"].map((label) => {
      const cards = new Map<string, { name: string; kindLabel: string; quantity: number; imageUrl?: string }>();
      for (const prize of prizes) {
        const rarityName =
          ({ "4": "SSR", "10": "EX", "20": "BD" } as Record<string, string>)[String(prize.rarity)] ?? prize.rarityLabel;
        if (rarityName !== label || (prize.kind !== "member" && prize.kind !== "support")) continue;
        const key = `${prize.kind}:${prize.id}`;
        const current = cards.get(key);
        cards.set(key, {
          name: prize.name,
          kindLabel: this.t(prize.kind),
          quantity: (current?.quantity ?? 0) + prize.quantity,
          imageUrl: prize.imageUrl,
        });
      }
      return { label, cards: [...cards.values()] };
    });
    const poolNames = [...new Set(batches.map((batch) => this.poolMap.get(batch.poolId)?.name ?? batch.poolId))];
    const dates = batches
      .map((batch) => batch.pulledAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const date = (value: string) =>
      new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(new Date(value));
    const scope = [
      poolNames.join(" · ") || this.t("allPools"),
      dates.length ? `${date(dates[0])} – ${date(dates[dates.length - 1])}` : this.t("unknownTime"),
    ];
    if (dates.length && dates.length !== batches.length) scope.push(this.t("unknownTime"));
    return { title: this.t("title"), scope, metrics, groups };
  }
  private async exportImage(report: GachaHistoryReport) {
    this.exportingImage = true;
    this.imageError = "";
    try {
      const { renderGachaHistoryImages } = await import("../lib/gacha-history-image");
      const images = await renderGachaHistoryImages(report);
      const files = images.map((blob, index) => ({ blob, filename: `haneoka-gacha-history-${index + 1}.png` }));
      const handled = !this.dispatchEvent(
        new CustomEvent("gacha-export-image", { detail: { files }, bubbles: true, composed: true, cancelable: true }),
      );
      if (!handled) {
        let file = files[0];
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
      this.exportingImage = false;
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
      [this.t(prize.kind), prize.rarityLabel, `×${prize.quantity}`, prize.pickup === true ? this.t("pickup") : ""]
        .filter(Boolean)
        .join(" · ");
    if (this.view === "table")
      return collectionTable(
        this.t("records"),
        [this.t("card"), this.t("kind"), this.t("rarity"), this.t("quantity"), this.t("pickup")],
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
      <div class="collection gacha-history__cards">
        ${prizes.map((prize) => tile({ title: prize.name, label: `${prize.name} · ${subtitle(prize)}`, subtitle: this.t(prize.kind), href: prize.href, image: prize.imageUrl ?? "", aspectRatio: 1, fit: "contain", marks: [{ at: "start", text: prize.rarityLabel }, { at: "bottom-end", text: `×${prize.quantity}` }, prize.pickup === true ? { at: "end", text: this.t("pickup"), accent: "var(--md-sys-color-primary-container)" } : null] }))}
      </div>
    `;
  }
}
if (!customElements.get("gacha-history")) customElements.define("gacha-history", GachaHistory);
