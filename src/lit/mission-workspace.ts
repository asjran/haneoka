import { SYSTEM_LABEL_PATHS } from "../i18n/system-labels";

import { LitElement, html, nothing } from "lit";
import { readPageData } from "../lib/page-data";
import { adoptPrerenderedWorkspace } from "../lib/workspace-page-data";
import type { CatalogSystemPayload } from "../lib/catalog-system-data";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { navigationDocumentUrl } from "../lib/document-url";
import {
  groupMissions,
  missionCategory,
  missionGroupStatus,
  type Mission,
  type MissionGroup,
} from "../lib/mission-groups";
import { syncEntityNavigation, updateEntityHeading } from "../lib/detail-navigation";
import { beginLoading, type LoadingReporter } from "../lib/loading-progress";
import { entityHref, parseResourceRoute, resourcePath, type ReleaseServer } from "../lib/resource-route";
import { fetchCrossServerCatalog } from "../lib/cross-server/fetch";
import { crossCatalogPresentation, type CrossCatalogPresentation } from "../lib/cross-server/presentation";
import { OFFICIAL_CATALOG_SERVERS, type OfficialCatalogServer } from "../lib/cross-server/catalog";
import { serverAvailabilityBadge } from "./shared/server-availability";
import { segmented } from "./ui/controls";
import { errorState, loadingState } from "./ui/state";
import {
  catalogUrl,
  currentReleaseServer,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  type JsonRecord,
  uiText,
} from "./shared/catalog";
import { icon } from "./ui/icon";
import { clientText } from "../i18n/client";
import type { Locale } from "@haneoka/i18n";
import "../styles/mission.css";

type Mode = "all" | "regular" | "limited";
const CATEGORY_LABELS: Record<number, [string, string]> = {
  0: ["categoryOther", "Other missions"],
  1: ["categoryDaily", "Daily"],
  2: ["categoryPeriod", "Limited Time"],
  3: ["categoryEvent", "Event"],
  4: ["categoryNormal", "Normal"],
  5: ["categoryBeginner", "Beginner"],
  6: ["categoryComeback", "Comeback"],
  7: ["categoryCharacter", "Character"],
  8: ["categoryInvitation", "Friend Invite"],
  9: ["categorySecret", "Hidden missions"],
  10: ["categoryEventDaily", "Event Daily"],
  11: ["categoryCircle", "Group"],
  12: ["categoryCircleDaily", "Group Daily"],
  13: ["categoryEventCircle", "Group Event"],
  14: ["categoryEventCircleDaily", "Group Event Daily"],
  15: ["categoryUnlockMusic", "Song Unlock"],
  16: ["categoryUnlockHome", "Home Unlock"],
};

function categoryIcon(category: number) {
  if ([1, 10, 12, 14].includes(category)) return icon("event_repeat", 24);
  if ([2, 3, 13].includes(category)) return icon("schedule", 24);
  if ([15, 16].includes(category)) return icon("lock_open", 24);
  if (category === 9) return icon("visibility_off", 24);
  if ([8, 11].includes(category)) return icon("group", 24);
  return icon("fact_check", 24);
}

export class MissionWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    entityId: { state: true },
    phase: { state: true },
    missions: { state: true },
    mode: { state: true },
    groupKey: { state: true },
    now: { state: true },
  };
  declare groupKey: string;
  declare locale: string;
  declare entityId: string;
  declare phase: "loading" | "ready" | "error";
  declare missions: Mission[];
  declare mode: Mode;
  declare private now: number;
  private clock?: ReturnType<typeof setInterval>;
  private server: ReleaseServer = "intl";
  private error = "";
  private request?: AbortController;
  private loading?: LoadingReporter;
  private localeListener = () => {
    this.locale = preferredLocale(this.locale);
    this.syncEntityHeading();
  };
  constructor() {
    super();
    this.locale = "ja";
    this.entityId = "";
    this.phase = "loading";
    this.missions = [];
    this.mode = "all";
    this.groupKey = "";
    this.now = Date.now();
  }
  createRenderRoot() {
    return this;
  }
  preparePage(payload: CatalogSystemPayload, locale: string) {
    adoptPrerenderedWorkspace(this);
    this.locale = locale;
    this.server = payload.server;
    if (payload.entityId) {
      this.entityId = payload.entityId;
      this.unionMissions = undefined;
      this.applyDocument(payload.document!);
      if (this.isConnected) this.syncEntityHeading();
      return;
    }
    const document = payload.catalog ? this.applyCatalog(payload.catalog) : payload.document!;
    this.applyDocument(document);
  }
  private applyCatalog(dto: NonNullable<CatalogSystemPayload["catalog"]>): JsonRecord {
    this.unionMissions = crossCatalogPresentation(dto);
    return { entries: Object.fromEntries(this.unionMissions.items.map((mission) => [String(mission.id), mission])) };
  }
  private applyDocument(document: JsonRecord) {
    if (this.entityId) {
      if (String(document.id || "") !== this.entityId)
        throw new Error(uiText(this.locale, "common.states.unavailable"));
      this.missions = [document as Mission];
    } else {
      this.missions = recordValues(document.entries) as Mission[];
    }
    this.phase = "ready";
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    const url = navigationDocumentUrl();
    const route = parseResourceRoute(url.pathname);
    this.entityId = route?.kind === "missions" ? route.id || "" : "";
    this.server = route?.kind === "missions" ? route.server : (currentReleaseServer() as ReleaseServer);
    addEventListener("haneoka:locale-ready", this.localeListener);
    void import("@material/web/progress/circular-progress.js");
    const params = url.searchParams;
    this.mode =
      params.get("mode") === "regular" || params.get("mode") === "limited" ? (params.get("mode") as Mode) : "all";
    this.groupKey = params.get("group") || "";
    addEventListener("popstate", this.popState);
    this.clock = setInterval(() => {
      this.now = Date.now();
    }, 60_000);
    syncEntityNavigation();
    void this.load();
  }
  private popState = () => {
    const params = new URLSearchParams(location.search);
    this.groupKey = params.get("group") || "";
    this.mode =
      params.get("mode") === "regular" || params.get("mode") === "limited" ? (params.get("mode") as Mode) : "all";
    if (!this.groupKey) this.openedInPlace = false;
  };
  disconnectedCallback() {
    clearInterval(this.clock);
    this.request?.abort();
    this.request = undefined;
    this.loading?.cancel();
    clearAppBarActions("missions");
    removeEventListener("popstate", this.popState);
    removeEventListener("haneoka:locale-ready", this.localeListener);
    super.disconnectedCallback();
  }
  private text(key: string, fallback: string, params?: Record<string, string | number>) {
    return clientText(this.locale, SYSTEM_LABEL_PATHS[key] ?? key, fallback, params);
  }
  private name(value: unknown, locale = this.locale) {
    return localizedText(value, locale);
  }
  private image(value: JsonRecord) {
    const source = String(value.image || "");
    const variants = value.imageVariants;
    if (!source || !variants || typeof variants !== "object") return source;
    const localized = (variants as JsonRecord)[source];
    if (!localized || typeof localized !== "object") return source;
    const key = ({ "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" } as Record<string, string>)[this.locale] || this.locale;
    return typeof (localized as JsonRecord)[key] === "string" ? String((localized as JsonRecord)[key]) : source;
  }
  private entityLink(id: string) {
    return entityHref({
      server: this.unionMissions?.byId.get(id)?.displayServer || this.server,
      locale: this.locale as Locale,
      kind: "missions",
      id,
    });
  }
  private unionMissions?: CrossCatalogPresentation;
  private syncEntityHeading() {
    if (!this.entityId || !this.missions[0]) return;
    const title = this.name(this.missions[0].title) || this.entityId;
    updateEntityHeading(this, title, this.locale);
    syncEntityNavigation();
  }
  private async load() {
    const page = readPageData<CatalogSystemPayload>(this);
    if (
      page?.schema === "haneoka-catalog-system-v1" &&
      page.kind === "missions" &&
      (page.entityId || "") === this.entityId
    ) {
      this.preparePage(page, this.locale);
      return;
    }
    this.request?.abort();
    this.loading?.cancel();
    const controller = new AbortController();
    const progress = beginLoading(uiText(this.locale, "common.states.loading"), {
      scope: "owner",
      signal: controller.signal,
    });
    this.request = controller;
    this.loading = progress;
    this.phase = "loading";
    this.error = "";
    try {
      let document: JsonRecord;
      if (!this.entityId && OFFICIAL_CATALOG_SERVERS.includes(this.server as OfficialCatalogServer)) {
        const dto = await fetchCrossServerCatalog("missions", this.server as OfficialCatalogServer, this.locale, {
          signal: controller.signal,
        });
        if (Object.values(dto.sourceAvailability).every((value) => value !== "loaded"))
          throw new Error("Mission catalog unavailable");
        document = this.applyCatalog(dto);
      } else {
        this.unionMissions = undefined;
        document = await fetchJson<JsonRecord>(catalogUrl("missions", this.entityId, this.server), {
          signal: controller.signal,
        });
      }
      if (this.request !== controller || controller.signal.aborted) {
        progress.cancel();
        return;
      }
      this.applyDocument(document);
      this.syncEntityHeading();
      progress.finish();
    } catch (error) {
      if (controller.signal.aborted || this.request !== controller) {
        progress.cancel();
        return;
      }
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
      progress.fail(error);
    } finally {
      if (this.request === controller && this.phase !== "error") {
        this.request = undefined;
        this.loading = undefined;
      }
    }
  }
  private sync() {
    const params = new URLSearchParams(location.search);
    params.delete("mode");
    if (this.mode !== "all") params.set("mode", this.mode);
    params.delete("group");
    if (this.groupKey) params.set("group", this.groupKey);
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private categoryLabel(category: number) {
    const [key, fallback] = CATEGORY_LABELS[category] || CATEGORY_LABELS[0];
    return this.text(`catalog.missions.${key}`, fallback);
  }
  private groupTitle(group: MissionGroup) {
    return this.name(group.rows[0]?.group) || this.categoryLabel(group.category);
  }
  private groups() {
    return groupMissions(this.missions, this.locale).filter(
      (group) => this.mode === "all" || (this.mode === "limited" ? group.timed : !group.timed),
    );
  }
  /** Rewards summed across a group's missions, in first-seen order. */
  private rewardTotals(rows: Mission[]) {
    const totals = new Map<string, JsonRecord>();
    for (const mission of rows)
      for (const reward of Array.isArray(mission.rewards) ? (mission.rewards as JsonRecord[]) : []) {
        // Rows show only named rewards; the totals follow them.
        if (!this.name(reward.name)) continue;
        const key = `${String(reward.kind || "")}:${String(reward.resourceType ?? "")}:${String(reward.resourceId ?? this.name(reward.name))}`;
        const entry = totals.get(key);
        if (entry) entry.count = Number(entry.count || 0) + Number(reward.count || 1);
        else totals.set(key, { ...reward, count: Number(reward.count || 1), href: "" });
      }
    return [...totals.values()];
  }
  private windowText(group: MissionGroup) {
    if ([1, 12].includes(group.category) && !group.timed) return this.text("missionDailyReset", "Resets daily");
    if (group.releaseDay) return this.text("catalog.missions.releaseDay", "Day {day}", { day: group.releaseDay });
    const { start, end } = group.window;
    if (!start && !end) return this.text("missionNoEnd", "No end date");
    return start && end ? `${this.date(start)} – ${this.date(end)}` : this.date(start || end);
  }
  private openGroup(event: MouseEvent, key: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    this.groupKey = key;
    this.openedInPlace = true;
    const params = new URLSearchParams(location.search);
    params.set("group", key);
    history.pushState(history.state, "", `${location.pathname}?${params}`);
    this.closest<HTMLElement>("#main-content")?.scrollTo({ top: 0 });
  }
  /** True while the open group was pushed from the overview, so Back can simply pop it. */
  private openedInPlace = false;
  private closeGroup() {
    if (this.openedInPlace) {
      this.openedInPlace = false;
      history.back();
      return;
    }
    this.groupKey = "";
    this.sync();
  }
  private groupHref(key: string) {
    const url = this.isConnected ? navigationDocumentUrl() : undefined;
    const params = new URLSearchParams(url?.search);
    params.set("group", key);
    const pathname = this.isConnected
      ? url!.pathname
      : resourcePath({ server: this.server, locale: this.locale as Locale, kind: "missions" });
    return `${pathname}?${params}`;
  }
  private groupCard(group: MissionGroup) {
    const totals = this.rewardTotals(group.rows);
    const shown = totals.slice(0, 4);
    return html`
      <li>
        <a
          class="mission-card"
          data-category=${group.category}
          href=${this.groupHref(group.key)}
          @click=${(event: MouseEvent) => this.openGroup(event, group.key)}
        >
          <span class="mission-card__head">
            <span class="mission-card__icon">${categoryIcon(group.category)}</span>
            <span class="mission-card__count tabular">
              ${this.text("missionCount", "{count} missions", { count: group.rows.length.toLocaleString(this.locale) })}
            </span>
          </span>
          <strong class="mission-card__title">${this.groupTitle(group)}</strong>
          ${
            group.timed
              ? html`
                  <span class="mission-card__status">${this.text(missionGroupStatus(group, this.now), "")}</span>
                `
              : nothing
          }
          <span class="mission-card__window">
            ${icon("schedule", 16)}
            <span>${this.windowText(group)}</span>
          </span>
          ${
            shown.length
              ? html`
                  <span class="mission-card__rewards" aria-label=${this.text("missionRewardTotal", "Total rewards")}>
                    ${shown.map((reward) => this.reward(reward))}
                    ${
                      totals.length > shown.length
                        ? html`
                            <span class="mission-card__more tabular">+${totals.length - shown.length}</span>
                          `
                        : nothing
                    }
                  </span>
                `
              : nothing
          }
        </a>
      </li>
    `;
  }
  private groupView(group: MissionGroup) {
    return html`
      <section class="mission-group">
        <header class="mission-group__header">
          <button
            class="icon-button"
            type="button"
            @click=${() => this.closeGroup()}
            aria-label=${uiText(this.locale, "common.actions.back")}
          >
            ${icon("arrow_back", 24)}
          </button>
          <span class="mission-group__icon">${categoryIcon(group.category)}</span>
          <span class="mission-group__heading">
            <h2>${this.groupTitle(group)}</h2>
            <small class="mission-group__window">${this.windowText(group)}</small>
          </span>
          <span class="mission-group__count tabular">${group.rows.length}</span>
        </header>
        <ul class="mission-list" role="list">
          ${group.rows.map(
            (mission) => html`
              <li class="mission-row">
                <span class="mission-row__condition">
                  <a href=${this.entityLink(mission.id)}>${this.name(mission.title) || "—"}</a>
                  ${this.goal(mission)}
                  ${(() => {
                    const entry = this.unionMissions?.byId.get(mission.id);
                    return entry?.exclusive ? serverAvailabilityBadge([entry.exclusive], this.locale) : nothing;
                  })()}
                </span>
                <span class="mission-row__rewards">
                  ${(Array.isArray(mission.rewards) ? mission.rewards : []).map((reward) =>
                    this.reward(reward as JsonRecord),
                  )}
                </span>
              </li>
            `,
          )}
        </ul>
      </section>
    `;
  }
  private date(value: number) {
    return value && Number.isFinite(value)
      ? new Intl.DateTimeFormat(this.locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Tokyo",
          timeZoneName: "short",
        }).format(new Date(value))
      : "";
  }
  private goal(mission: Mission) {
    const goal = Number(mission.goal || 0);
    return goal > 0
      ? html`
          <span class="mission-row__goal tabular">
            ${this.text("catalog.missions.goal", "Goal")} ·
            <b>${goal.toLocaleString(this.locale)}</b>
          </span>
        `
      : nothing;
  }
  private overview(groups: MissionGroup[]) {
    const permanent = groups.filter((group) => !group.timed && group.category !== 1);
    const sections = [
      {
        label: this.text("missionDaily", "Daily missions"),
        groups: groups.filter((group) => group.category === 1 && !group.timed),
      },
      ...(["ongoing", "upcoming", "ended"] as const).map((status) => ({
        label: `${this.text("limitedMission", "Limited missions")} · ${this.text(status, "")}`,
        groups: groups
          .filter((group) => group.timed && missionGroupStatus(group, this.now) === status)
          .sort((a, b) => (status === "upcoming" ? a.window.start - b.window.start : b.window.start - a.window.start)),
      })),
    ];
    sections.splice(3, 0, { label: this.text("catalog.missions.permanent", "Permanent missions"), groups: permanent });
    return sections
      .filter((section) => section.groups.length)
      .map(
        (section) => html`
          <section class="mission-section stack">
            <h2 class="detail-section-title">${section.label}</h2>
            <ul class="mission-cards" role="list">
              ${section.groups.map((group) => this.groupCard(group))}
            </ul>
          </section>
        `,
      );
  }
  private reward(reward: JsonRecord) {
    const title = this.name(reward.name);
    if (!title) return nothing;
    const image = this.image(reward);
    const count = Number(reward.count || 0);
    const href = String(reward.href || "");
    const body = html`
      ${
        image
          ? html`
              <img src=${image} alt="" loading="lazy" decoding="async" />
            `
          : icon("redeem", 18)
      }
      <span>${title}</span>
      ${
        count > 1
          ? html`
              <b class="tabular">×${count.toLocaleString(this.locale)}</b>
            `
          : nothing
      }
    `;
    return href
      ? html`
          <a class="mission-chip state-layer" href=${href}>${body}</a>
        `
      : html`
          <span class="mission-chip">${body}</span>
        `;
  }
  private entityView(mission: Mission) {
    const title = this.name(mission.title) || mission.id;
    const kind = this.categoryLabel(missionCategory(mission));
    const window = this.windowText(groupMissions([mission], this.locale)[0]!);
    const description = this.name(mission.description);
    return html`
      <section class="mission-group mission-group--entity">
        <header class="mission-group__header">
          <h2>${title}</h2>
          <span>${kind}</span>
          ${
            window
              ? html`
                  <small class="mission-group__window">${window}</small>
                `
              : nothing
          }
        </header>
        <ul class="mission-list" role="list">
          <li class="mission-row">
            <span class="mission-row__condition">
              ${
                description
                  ? html`
                      <small>${description}</small>
                    `
                  : nothing
              }
              ${this.goal(mission)}
            </span>
            <span class="mission-row__rewards">
              ${(Array.isArray(mission.rewards) ? mission.rewards : []).map((reward) => this.reward(reward as JsonRecord))}
            </span>
          </li>
        </ul>
      </section>
    `;
  }
  private modeFilter() {
    return html`
      <div class="mission-workspace__filter">
        ${segmented({
          label: uiText(this.locale, "common.actions.view"),
          value: this.mode,
          options: [
            { value: "all" as const, label: uiText(this.locale, "common.states.all"), icon: "apps" },
            {
              value: "regular" as const,
              label: this.text("catalog.missions.permanent", "Permanent missions"),
              icon: "fact_check",
            },
            { value: "limited" as const, label: this.text("limitedMission", "Limited mission"), icon: "schedule" },
          ],
          onSelect: (mode) => {
            this.mode = mode;
            this.sync();
          },
        })}
      </div>
    `;
  }
  render() {
    if (this.entityId || this.groupKey) clearAppBarActions("missions");
    else setAppBarActions("missions", this.modeFilter());
    const groups = this.groups();
    const selected = this.groupKey ? groups.find((group) => group.key === this.groupKey) : undefined;
    return html`
      <section class="mission-workspace">
        ${
          this.phase === "loading"
            ? loadingState(uiText(this.locale, "common.states.loading"))
            : this.phase === "error"
              ? errorState(
                  uiText(this.locale, "common.states.unavailable"),
                  uiText(this.locale, "common.actions.retry"),
                  () => void this.load(),
                  this.error,
                )
              : html`
                  ${
                    this.entityId && this.missions[0]
                      ? this.entityView(this.missions[0])
                      : selected
                        ? this.groupView(selected)
                        : html`
                            ${this.overview(groups)}
                          `
                  }
                `
        }
      </section>
    `;
  }
}
if (!customElements.get("mission-workspace")) customElements.define("mission-workspace", MissionWorkspace);
