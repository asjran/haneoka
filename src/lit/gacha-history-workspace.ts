import type { GachaHistory } from "./gacha-history";
import "./gacha-history";
import { clientText } from "../i18n/client";
import { readPageData } from "../lib/page-data";
import { historyStore, type StoredHistory } from "../lib/gacha-history-store";
import {
  HISTORY_BYTES,
  historyBatchViews,
  historyObject,
  historyPoolViews,
  type HistoryCatalogData,
} from "../lib/gacha-history-data";
import type { GachaHistoryPageData } from "../server/gacha-history-page-data";
import type { GachaHistoryEvents, GachaHistoryImportSource, GachaHistoryConversion } from "../lib/gacha-history-view";
import { fetchJson } from "./shared/catalog";
import { readCompanionHistory } from "../lib/gacha-history-device";
import { downloadBlob } from "../lib/canvas-capture";

class GachaHistoryWorkspace extends HTMLElement {
  private records: StoredHistory[] = [];
  private selected = "";
  private catalog?: GachaHistoryPageData;
  private busy = false;
  private error = "";
  private catalogRequests = new Set<string>();
  private catalogErrors = new Map<string, string>();
  private conversion?: GachaHistoryConversion;
  private controller = new AbortController();
  private usb?: typeof import("@haneoka/game-data-exporter/webusb");
  private get view() {
    return this.querySelector<GachaHistory>("gacha-history")!;
  }
  private t(key: string) {
    return clientText(this.view.locale, `catalog.gachaHistory.${key}`, "");
  }
  private changed = () => {
    void this.reload();
  };
  connectedCallback() {
    this.controller = new AbortController();
    this.catalog = readPageData<GachaHistoryPageData>(this);
    this.on("gacha-account-change", ({ accountKey }) => {
      this.selected = accountKey;
      this.error = "";
      this.update();
    });
    this.on("gacha-import-source", ({ source }) => this.source(source));
    this.on("gacha-catalog-retry", () => {
      void this.loadCatalog();
    });
    this.on("gacha-open-app", () => {
      location.href = "haneoka://gacha-history";
    });
    this.on("gacha-conversion-change", (value) => {
      this.conversion = value;
      this.view.currencyConversion = value;
      try {
        localStorage.setItem("haneoka:gacha-history:conversion", JSON.stringify(value));
      } catch {
        /* The current view keeps this choice. */
      }
    });
    this.on("gacha-export", ({ accountKey, batches }) => {
      const snapshot = this.records.find((row) => row.key === accountKey)?.snapshot;
      if (!snapshot) return;
      const indexes = new Set(batches.map((row) => Number(row.id.split(":").at(-1))));
      const selection = {
        ...snapshot,
        coverage: { ...snapshot.coverage, scope: "selected-records" },
        batches: snapshot.batches.filter((_, index) => indexes.has(index)),
      };
      downloadBlob(
        new Blob([JSON.stringify(selection)], { type: "application/json" }),
        `haneoka-gacha-${snapshot.source.server}.json`,
      );
    });
    historyStore.addEventListener("change", this.changed);
    void import("@haneoka/game-data-exporter/webusb")
      .then((usb) => {
        this.usb = usb;
        this.update();
      })
      .catch(() => {});
    try {
      const stored = historyObject(JSON.parse(localStorage.getItem("haneoka:gacha-history:conversion") ?? "null"));
      if (
        ["JPY", "TWD", "HKD", "MOP", "USD", "KRW", "CNY"].includes(String(stored.currencyCode)) &&
        (stored.unitGemPrice == null ||
          (typeof stored.unitGemPrice === "number" && Number.isFinite(stored.unitGemPrice) && stored.unitGemPrice >= 0))
      )
        this.conversion = {
          currencyCode: String(stored.currencyCode),
          unitGemPrice: stored.unitGemPrice ?? null,
        } as GachaHistoryConversion;
    } catch {
      /* Start with an empty conversion amount. */
    }
    void this.reload();
  }
  disconnectedCallback() {
    this.controller.abort();
    historyStore.removeEventListener("change", this.changed);
  }
  private on<K extends keyof GachaHistoryEvents>(type: K, callback: (detail: GachaHistoryEvents[K]["detail"]) => void) {
    this.addEventListener(type, ((event: GachaHistoryEvents[K]) => callback(event.detail)) as EventListener, {
      signal: this.controller.signal,
    });
  }
  private async reload() {
    try {
      this.records = await historyStore.list();
      if (!this.records.some((row) => row.key === this.selected)) this.selected = this.records[0]?.key ?? "";
    } catch {
      this.error = this.t("errorImportInvalid");
    }
    if (this.isConnected) this.update();
  }
  private source(source: GachaHistoryImportSource) {
    if (source === "saved") {
      this.view.querySelector<HTMLSelectElement>("select")?.focus();
      return;
    }
    if (source === "adb") {
      void this.adb();
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = true;
    input.addEventListener(
      "change",
      () => {
        if (input.files?.length) void this.importFiles([...input.files]);
      },
      { once: true },
    );
    input.click();
  }
  private async importFiles(files: readonly File[], companion = false) {
    this.busy = true;
    this.error = "";
    this.update();
    try {
      if (files.length > 128 || files.reduce((sum, file) => sum + file.size, 0) > HISTORY_BYTES * 4)
        throw new Error("history_import_invalid");
      for (const file of files) {
        if (!file.size || file.size > HISTORY_BYTES * 2) throw new Error("history_import_invalid");
        const record = await historyStore.import(
          JSON.parse(await file.text()),
          companion ? file.name.replace(/\.json$/u, "") : undefined,
        );
        this.selected = record.key;
      }
      await this.reload();
    } catch {
      this.error = this.t("errorImportInvalid");
    } finally {
      this.busy = false;
      if (this.isConnected) this.update();
    }
  }
  private async adb() {
    if (!this.usb || this.busy) return;
    this.busy = true;
    this.error = "";
    this.update();
    try {
      const files = await readCompanionHistory(this.usb.createUsbReader(), this.controller.signal);
      if (files) await this.importFiles(files, true);
    } catch {
      if (!this.controller.signal.aborted) this.error = this.t("errorImportInvalid");
    } finally {
      this.busy = false;
      if (this.isConnected) this.update();
    }
  }
  private async loadCatalog() {
    const current = this.records.find((row) => row.key === this.selected);
    const server = current?.snapshot.source.server === "jp" ? "jp" : "intl";
    if (this.catalogRequests.has(server)) return;
    this.catalogRequests.add(server);
    this.catalogErrors.delete(server);
    this.update();
    try {
      const pin = historyObject(
        await fetchJson<unknown>(`/api/v1/servers/${server}/release?projection=identity`, {
          signal: this.controller.signal,
        }),
      );
      if (pin.server !== server || typeof pin.releaseId !== "string" || !/^r-[a-f0-9]{20}$/u.test(pin.releaseId))
        throw new Error("history_catalog");
      const [gachaValue, cards, supports, items] = await Promise.all(
        ["gacha", "cards", "support-cards", "items"].map((name) =>
          fetchJson<unknown>(`/api/v1/servers/${server}/${name}?release=${pin.releaseId}`, {
            signal: this.controller.signal,
          }),
        ),
      );
      const gacha = historyObject(gachaValue),
        metadata = historyObject(gacha.history);
      if (metadata.schema !== "haneoka-gacha-history-data-v1") throw new Error("history_catalog");
      this.catalog = {
        schema: "haneoka-gacha-history-page-v1",
        variants: {
          ...this.catalog?.variants,
          [server]: {
            metadata,
            pools: historyObject(gacha.entries),
            cards: historyObject(cards),
            supports: historyObject(supports),
            items: historyObject(historyObject(items).items),
          },
        },
      };
    } catch {
      this.catalogErrors.set(server, this.t("errorCatalogUnavailable"));
    } finally {
      this.catalogRequests.delete(server);
      if (this.isConnected) this.update();
    }
  }
  private update() {
    const view = this.view;
    if (!view) return;
    const current = this.records.find((row) => row.key === this.selected),
      snapshot = current?.snapshot;
    const server = snapshot?.source.server === "jp" ? "jp" : "intl";
    const source = this.catalog?.variants[server];
    const catalog: HistoryCatalogData | undefined =
      source?.metadata.schema === "haneoka-gacha-history-data-v1" ? source : undefined;
    view.accounts = this.records.map((row) => ({
      key: row.key,
      server: row.snapshot.source.server,
      serverLabel: this.t(
        { jp: "regionJp", "global-hmt": "regionHmt", "global-en": "regionEn", "global-kr": "regionKo" }[
          row.snapshot.source.server
        ],
      ),
      label: new Date(row.snapshot.queriedAt).toLocaleString(view.locale),
    }));
    view.selectedAccountKey = this.selected;
    view.currencyConversion = this.conversion ?? {
      currencyCode:
        snapshot?.source.server === "jp"
          ? "JPY"
          : snapshot?.source.server === "global-en"
            ? "USD"
            : snapshot?.source.server === "global-kr"
              ? "KRW"
              : "TWD",
      unitGemPrice: null,
    };
    view.pools = catalog
      ? historyPoolViews(catalog, view.locale, (key) =>
          clientText(view.locale, `catalog.recruitments.types.${key}`, key),
        )
      : [];
    view.batches = snapshot ? historyBatchViews(snapshot, this.selected, catalog, view.locale, this.t("unknown")) : [];
    view.historyLoaded = !!snapshot;
    view.busy = this.busy;
    view.error = this.error;
    view.canImport = true;
    view.canExport = !!snapshot;
    view.canRefresh = false;
    view.importSources = [
      ...(this.records.length ? ["saved" as const] : []),
      "files",
      ...(this.usb?.usbAvailable() ? ["adb" as const] : []),
    ];
    view.showAppLink = true;
    view.catalogLoading = this.catalogRequests.has(server);
    view.catalogError =
      this.catalogErrors.get(server) ||
      (snapshot?.batches.length && !catalog ? this.t("errorCatalogUnavailable") : "");
    view.canRetryCatalog = true;
  }
}
if (!customElements.get("gacha-history-workspace"))
  customElements.define("gacha-history-workspace", GachaHistoryWorkspace);
