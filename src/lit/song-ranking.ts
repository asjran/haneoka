import "@material/web/progress/linear-progress.js";
import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { clientText } from "../i18n/client";
import { preferredLocale, fetchJson, JsonResponseError } from "./shared/catalog";
import type { ReleaseServer } from "../lib/release-server";
import { RequestScope } from "../lib/request-scope";
import { icon } from "./ui/icon";
import { iconButton } from "./ui/controls";
import "../styles/settings.css";
import type { Locale } from "../i18n/locales";
import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import { entityReturnHref } from "../lib/detail-navigation";
import { localizedText } from "./shared/catalog";
import { resourcePath } from "../lib/resource-route";
import type { RankingCardCatalog, RankingCardArtwork } from "../lib/game-records";
import { emptyState, errorState, loadingState } from "./ui/state";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import jpFlag from "circle-flags/flags/jp.svg?url";
import hkFlag from "circle-flags/flags/hk.svg?url";
import gbFlag from "circle-flags/flags/gb.svg?url";
import krFlag from "circle-flags/flags/kr.svg?url";

import type {
  GameRecordsRegion,
  SongRankingDto,
  SongRankingRowDto,
  PlayerProfileDto,
  GameRecordsErrorDto,
} from "../lib/game-records";
type Region = GameRecordsRegion;
type View = "ranking" | "profile";
type Phase = "idle" | "loading" | "ready" | "error";

type RankingEntry = SongRankingRowDto;
type PlayerProfile = PlayerProfileDto["profile"];
interface RankingCache {
  rows: RankingEntry[];
  storedAt: number;
  reportedAt: number;
  stale: boolean;
}

const CACHE_TTL = 5 * 60 * 1000;
const REGIONS: ReadonlyArray<{ value: Region; key: string; flag: string }> = [
  { value: "jp", key: "regionJp", flag: jpFlag },
  { value: "tw", key: "regionTw", flag: hkFlag },
  { value: "en", key: "regionEn", flag: gbFlag },
  { value: "kr", key: "regionKr", flag: krFlag },
];
let pageAppBarOwnerSequence = 0;

const defaultRegion = (server: ReleaseServer, locale: string): Region => {
  if (server === "jp" || server === "jp-cbt") return "jp";
  if (locale === "en") return "en";
  if (locale === "ko") return "kr";
  return "tw";
};

export class SongRanking extends LitElement {
  static properties = {
    locale: { type: String },
    server: { type: String },
    songId: { type: String, attribute: "song-id" },
    region: { state: true },
    view: { state: true },
    phase: { state: true },
    rows: { state: true },
    stale: { state: true },
    expanded: { state: true },
    profilePhase: { state: true },
    profile: { state: true },
  };

  declare locale: string;
  declare server: ReleaseServer;
  declare songId: string;
  declare region: Region;
  declare view: View;
  declare phase: Phase;
  declare rows: RankingEntry[];
  declare stale: boolean;
  declare expanded: boolean;
  declare profilePhase: Phase | "private";
  declare profile: PlayerProfile | null;

  private rankingRequests = new RequestScope();
  private profileRequests = new RequestScope();
  private lifetime?: AbortController;
  private cardCatalogs: Partial<Record<"jp" | "intl", RankingCardCatalog>> = {};
  private cache = new Map<Region, RankingCache>();
  private selectedEntry: RankingEntry | null = null;
  private rankingFailure: GameRecordsErrorDto["error"] | null = null;
  private retryAt = 0;
  private retryTimer = 0;
  private readyImages = new Set<string>();
  private failedImages = new Set<string>();
  private readonly pageAppBarOwner = `song-ranking-page-${++pageAppBarOwnerSequence}`;
  private pageBackLink?: HTMLAnchorElement;
  private pageBackHref = "";
  private rankingScrollTop = 0;

  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
    this.songId = "";
    this.region = "tw";
    this.view = "ranking";
    this.phase = "idle";
    this.rows = [];
    this.stale = false;
    this.expanded = false;
    this.profilePhase = "idle";
    this.profile = null;
  }

  private initializePage() {
    this.cardCatalogs = readPageData<typeof this.cardCatalogs>(this) || this.cardCatalogs;
    const requested = navigationDocumentUrl().searchParams.get("region");
    this.region = REGIONS.some((option) => option.value === requested)
      ? (requested as Region)
      : defaultRegion(this.server, this.locale);
    this.phase = "loading";
    void this.loadRanking(this.region, true);
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.lifetime = new AbortController();
    addEventListener("haneoka:locale-ready", this.onLocale, { signal: this.lifetime.signal });
    this.initializePage();
  }

  disconnectedCallback() {
    this.rankingRequests.cancel();
    this.profileRequests.cancel();
    this.lifetime?.abort();
    this.lifetime = undefined;
    window.clearTimeout(this.retryTimer);
    this.pageBackLink?.removeEventListener("click", this.onPageBackClick);
    this.pageBackLink = undefined;
    clearAppBarActions(this.pageAppBarOwner);
    super.disconnectedCallback();
  }

  private onLocale = () => {
    this.locale = preferredLocale(this.locale);
    this.requestUpdate();
  };

  private label(key: string, fallback: string) {
    return clientText(this.locale, `songRanking.${key}`, fallback);
  }

  private rankingUrl(region: Region) {
    return `/api/v1/game/records/${region}/songs/${encodeURIComponent(this.songId)}/ranking`;
  }

  private profileUrl(region: Region, profileId: string) {
    return `/api/v1/game/records/${region}/players/${encodeURIComponent(profileId)}`;
  }

  private currentRanking(signal: AbortSignal, region: Region) {
    return this.isConnected && this.region === region && this.rankingRequests.current(signal);
  }

  private async loadRanking(region: Region, force = false) {
    const cached = this.cache.get(region);
    if (!force && cached && Date.now() - cached.storedAt < CACHE_TTL) {
      this.rows = cached.rows;
      this.phase = "ready";
      this.stale = cached.stale;
      return;
    }
    const signal = this.rankingRequests.begin();
    this.rankingFailure = null;
    this.retryAt = 0;
    window.clearTimeout(this.retryTimer);
    this.phase = "loading";
    this.stale = Boolean(cached);
    try {
      const value = await fetchJson<SongRankingDto>(this.rankingUrl(region), {
        signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!this.currentRanking(signal, region)) return;
      const entry = {
        rows: value.rows.slice(0, 100),
        storedAt: Date.now(),
        reportedAt: value.fetchedAtMs ?? 0,
        stale: value.stale,
      };
      this.cache.set(region, entry);
      this.rows = entry.rows;
      this.phase = "ready";
      this.stale = entry.stale;
    } catch (error) {
      if (!this.currentRanking(signal, region)) return;
      if (error instanceof JsonResponseError) {
        const failure = (error.body as GameRecordsErrorDto | null)?.error;
        if (failure && typeof failure.kind === "string") this.rankingFailure = failure;
      }
      const retry = this.rankingFailure?.retryAfter;
      if (retry != null && Number.isFinite(retry) && retry > 0) {
        this.retryAt = Date.now() + retry * 1000;
        this.retryTimer = window.setTimeout(() => this.requestUpdate(), retry * 1000);
      }
      this.phase = this.rankingFailure?.kind === "not_found" ? "ready" : "error";
      this.stale = Boolean(cached);
    }
  }

  private selectRegion(value: string) {
    if (!REGIONS.some((option) => option.value === value) || value === this.region) return;
    const region = value as Region;
    this.rankingFailure = null;
    this.retryAt = 0;
    window.clearTimeout(this.retryTimer);
    this.region = region;
    const url = new URL(location.href);
    url.searchParams.set("region", region);
    history.replaceState(history.state, "", url);
    this.view = "ranking";
    this.profileRequests.cancel();
    this.profile = null;
    this.selectedEntry = null;
    this.profilePhase = "idle";
    this.expanded = false;
    this.rankingRequests.cancel();
    const cached = this.cache.get(region);
    this.rows = cached?.rows || [];
    this.stale = cached ? cached.stale : false;
    this.phase = cached && Date.now() - cached.storedAt < CACHE_TTL ? "ready" : "loading";
    if (this.phase !== "ready") void this.loadRanking(region, true);
  }

  private refresh() {
    if (Date.now() < this.retryAt) return;
    this.rankingRequests.cancel();
    void this.loadRanking(this.region, true);
  }

  private async openProfile(entry: RankingEntry) {
    if (!entry.profileId) return;
    this.rankingScrollTop = document.querySelector<HTMLElement>("#main-content")?.scrollTop || 0;
    const signal = this.profileRequests.begin();
    this.view = "profile";
    this.selectedEntry = entry;
    this.profile = null;
    this.profilePhase = "loading";
    try {
      const value = await fetchJson<PlayerProfileDto>(this.profileUrl(this.region, entry.profileId!), {
        signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!this.isConnected || this.view !== "profile" || !this.profileRequests.current(signal)) return;
      this.profile = value.profile;
      this.profilePhase = "ready";
    } catch (error) {
      if (!this.isConnected || this.view !== "profile" || !this.profileRequests.current(signal)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.profilePhase =
        error instanceof JsonResponseError && (error.status === 403 || error.status === 404)
          ? "private"
          : /\b(?:403|404)\b/u.test(message)
            ? "private"
            : "error";
    }
  }

  private backToRanking() {
    this.profileRequests.cancel();
    this.view = "ranking";
    this.profile = null;
    this.selectedEntry = null;
    this.profilePhase = "idle";
    void this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        const main = document.querySelector<HTMLElement>("#main-content");
        if (main && this.isConnected && this.view === "ranking") main.scrollTop = this.rankingScrollTop;
      });
    });
  }

  private formatScore(value: number | null) {
    return value === null ? "—" : value.toLocaleString(this.locale);
  }

  private formatTime(region: Region) {
    const cached = this.cache.get(region);
    const value = cached?.reportedAt || 0;
    if (!value) return "";
    return new Intl.DateTimeFormat(this.locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  }

  private initials(name: string) {
    const value = name.trim();
    return Array.from(value || "?")
      .slice(0, 2)
      .join("")
      .toLocaleUpperCase(this.locale);
  }

  private profileMedia(name: string, image: string) {
    return image
      ? html`
          <span
            class=${live(`song-ranking__player-media${this.failedImages.has(image) ? " is-error" : this.readyImages.has(image) ? " is-loaded" : ""}`)}
          >
            ${
              !this.readyImages.has(image)
                ? html`
                    <md-circular-progress
                      indeterminate
                      aria-label=${this.label("loading", "Loading")}
                    ></md-circular-progress>
                  `
                : nothing
            }
            <img
              src=${image}
              alt=""
              loading="lazy"
              decoding="async"
              @load=${(event: Event) => {
                this.readyImages.add(image);
                this.failedImages.delete(image);
                const media = (event.currentTarget as HTMLImageElement).parentElement;
                media?.classList.remove("is-error");
                media?.classList.add("is-loaded");
              }}
              @error=${(event: Event) => {
                this.failedImages.add(image);
                (event.currentTarget as HTMLImageElement).parentElement?.classList.add("is-error");
              }}
            />
          </span>
        `
      : html`
          <span class="song-ranking__initial" aria-hidden="true">${this.initials(name)}</span>
        `;
  }

  private renderPageActions() {
    return html`
      <div
        class="settings-options song-ranking__regions"
        role="radiogroup"
        aria-label=${this.label("region", "Ranking region")}
      >
        ${REGIONS.map(
          (option) => html`
            <label class="settings-option" title=${this.label(option.key, option.value)}>
              <input
                type="radio"
                name="ranking-region"
                value=${option.value}
                .checked=${this.region === option.value}
                aria-label=${this.label(option.key, option.value)}
                @change=${() => this.selectRegion(option.value)}
              />
              <span class="settings-option__face" aria-hidden="true">
                <span class="settings-option__image"><img src=${option.flag} width="28" height="28" alt="" /></span>
              </span>
              <span class="settings-option__tooltip" aria-hidden="true">${this.label(option.key, option.value)}</span>
            </label>
          `,
        )}
      </div>
      ${iconButton({ label: this.label("refresh", "Refresh ranking"), icon: "refresh", disabled: this.phase === "loading" || Date.now() < this.retryAt, onClick: () => this.refresh() })}
    `;
  }

  private onPageBackClick = (event: MouseEvent) => {
    if (this.view !== "profile") return;
    event.preventDefault();
    event.stopPropagation();
    this.backToRanking();
  };

  private syncPageChrome() {
    const back = document.querySelector<HTMLAnchorElement>("[data-entity-back]");
    if (back && back !== this.pageBackLink) {
      this.pageBackLink?.removeEventListener("click", this.onPageBackClick);
      this.pageBackLink = back;
      this.pageBackHref = entityReturnHref() || back.href;
      back.addEventListener("click", this.onPageBackClick);
    }
    if (back) {
      if (this.view === "profile") {
        back.href = "#ranking";
        back.setAttribute("aria-label", this.label("back", "Back"));
      } else {
        back.href = entityReturnHref() || this.pageBackHref;
        back.setAttribute("aria-label", clientText(this.locale, "back", "Back"));
      }
    }
    setAppBarActions(this.pageAppBarOwner, this.renderPageActions(), this);
  }

  private cardArtwork(cardId: number | null, support: boolean) {
    if (cardId == null) return undefined;
    const source = this.region === "jp" ? "jp" : "intl";
    const preferred = this.cardCatalogs[source];
    const fallback = this.cardCatalogs[source === "jp" ? "intl" : "jp"];
    const key = support ? "support" : "member";
    return preferred?.[key][String(cardId)] || fallback?.[key][String(cardId)];
  }

  private sourceCatalog() {
    return this.cardCatalogs[this.region === "jp" ? "jp" : "intl"];
  }
  private levelFromExp(rows: Array<{ level: number; exp: number }> | undefined, exp: number | null) {
    if (exp == null || !rows?.length) return null;
    let level = 1;
    for (const row of rows) {
      if (row.exp > exp) break;
      level = row.level;
    }
    return level;
  }
  private cardLevel(artwork: RankingCardArtwork, card: RankingEntry["cards"][number], support: boolean) {
    const catalog = this.cardCatalogs[artwork.server];
    const level = this.levelFromExp(
      catalog?.levels[support ? "support" : "member"][String(artwork.levelGroup)],
      support ? card.supportExp : card.memberExp,
    );
    const cap = support
      ? catalog?.supportLimits[`${artwork.rankGroup}:${card.supportRank ?? 1}`]
      : catalog?.memberLimits[`${artwork.rarity}:${card.memberAwakeCount ?? 1}`];
    return level == null ? null : cap ? Math.min(level, cap) : level;
  }
  private renderCard(card: RankingEntry["cards"][number], support = false) {
    const id = support ? card.supportCardId : card.memberCardId;
    const artwork = this.cardArtwork(id, support);
    const name = artwork ? localizedText(artwork.name, this.locale) : this.label("unavailableCard", "Card unavailable");
    const level = artwork ? this.cardLevel(artwork, card, support) : null;
    const body = html`
      <span class=${`song-ranking__card-media${support ? " song-ranking__card-media--support" : ""}`}>
        ${artwork?.image ? this.profileMedia(name, artwork.image) : icon("broken_image", 24)}
        ${
          artwork?.attributeIcon
            ? html`
                <img class="song-ranking__card-attribute" src=${artwork.attributeIcon} alt="" />
              `
            : nothing
        }
        ${
          artwork?.rarityIcon
            ? html`
                <img class="song-ranking__card-rarity" src=${artwork.rarityIcon} alt="" />
              `
            : nothing
        }
        ${
          level != null
            ? html`
                <span class="song-ranking__card-level">
                  ${this.label("cardLevel", "Lv. {level}").replace("{level}", String(level))}
                </span>
              `
            : nothing
        }
      </span>
    `;
    return artwork
      ? html`
          <a
            class="song-ranking__card"
            href=${resourcePath({ server: artwork.server, locale: this.locale as Locale, kind: support ? "support-cards" : "member-cards", id: String(id) })}
            aria-label=${name}
            title=${name}
          >
            ${body}
          </a>
        `
      : html`
          <span class="song-ranking__card" aria-label=${name}>${body}</span>
        `;
  }
  private renderRow(entry: RankingEntry) {
    const name = entry.name || this.label("privatePlayer", "Unknown player");
    const favorite = this.cardArtwork(entry.favoriteMemberCardId, false);
    const image = entry.profileCard?.thumbnailUrls[0] || "";
    const cardTitle = [
      entry.profileCard?.name,
      entry.profileCard?.slot != null
        ? this.label("profileCardSlot", "Slot {slot}").replace("{slot}", String(entry.profileCard.slot))
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const level = this.levelFromExp(this.sourceCatalog()?.playerLevels, entry.rankExp);
    const identity = html`
      <strong>${name}</strong>
      <small class="song-ranking__player-stats">
        ${
          level != null
            ? html`
                <span>${this.label("cardLevel", "Lv. {level}").replace("{level}", String(level))}</span>
              `
            : nothing
        }
        ${
          entry.totalPower != null
            ? html`
                <span>${this.label("power", "Power")} ${this.formatScore(entry.totalPower)}</span>
              `
            : nothing
        }
      </small>
    `;
    return html`
      <li class="song-ranking__entry">
        <div class="song-ranking__row">
          <span class="song-ranking__rank" aria-label=${`${this.label("rank", "Rank")} ${entry.rank}`}>
            ${entry.rank}
          </span>
          ${
            image
              ? html`
                  <a
                    class="song-ranking__namecard"
                    href=${image}
                    target="_blank"
                    rel="noopener"
                    title=${cardTitle}
                    aria-label=${cardTitle || this.label("profileCard", "Profile card")}
                  >
                    ${this.profileMedia(name, image)}
                  </a>
                `
              : html`
                  <span
                    class="song-ranking__namecard song-ranking__namecard--empty"
                    aria-label=${this.label("noProfileCard", "No profile card")}
                  >
                    ${icon("badge", 24)}
                  </span>
                `
          }
          <span class="song-ranking__avatar">
            ${
              favorite?.avatar
                ? this.profileMedia(name, favorite.avatar)
                : html`
                    <span class="song-ranking__initial" aria-hidden="true">${this.initials(name)}</span>
                  `
            }
          </span>
          ${
            entry.profileId
              ? html`
                  <button
                    class="song-ranking__player-copy state-layer"
                    type="button"
                    data-profile-id=${entry.profileId}
                    @click=${() => void this.openProfile(entry)}
                  >
                    ${identity}
                  </button>
                `
              : html`
                  <span class="song-ranking__player-copy">${identity}</span>
                `
          }
          <span
            class="song-ranking__score"
            aria-label=${`${this.label("score", "Score")} ${this.formatScore(entry.score)}`}
          >
            <strong>${this.formatScore(entry.score)}</strong>
            ${
              entry.tied
                ? html`
                    <small>${this.label("tied", "Tied rank")}</small>
                  `
                : nothing
            }
          </span>
          <span class="song-ranking__deck-preview" aria-label=${this.label("cards", "Cards")}>
            ${entry.cards.map(
              (card) => html`
                <span class="song-ranking__deck-slot">
                  ${this.renderCard(card)}${
                    card.supportCardId != null
                      ? this.renderCard(card, true)
                      : html`
                          <span
                            class="song-ranking__card-media song-ranking__card-media--support song-ranking__card-empty"
                            aria-label=${this.label("noSupportCard", "No support card")}
                          ></span>
                        `
                  }
                </span>
              `,
            )}
          </span>
        </div>
      </li>
    `;
  }
  private renderRanking() {
    const cached = this.cache.get(this.region);
    const visible = this.rows.slice(0, this.expanded ? 100 : 20);
    const showMore = this.rows.length > 20 && !this.expanded;
    const failed = this.rankingFailure?.kind;
    const failureText =
      failed === "pending"
        ? this.label("pending", "Ranking is being collected. Try again in {seconds}s.").replace(
            "{seconds}",
            String(Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000))),
          )
        : failed === "timeout"
          ? this.label("timeout", "The ranking request timed out.")
          : this.label("error", "Ranking unavailable");
    return html`
      <div class="song-ranking__content">
        ${
          this.stale
            ? html`
                <p class="song-ranking__notice song-ranking__notice--stale" role="status">
                  ${this.label("stale", "Showing cached results")}
                </p>
              `
            : nothing
        }
        <div class="song-ranking__meta">
          ${
            cached && cached.reportedAt > 0
              ? html`
                  <p class="song-ranking__fetched" role="status">
                    ${this.label("updated", "Updated")}${this.formatTime(this.region) ? ` · ${this.formatTime(this.region)}` : ""}
                  </p>
                `
              : nothing
          }
          <a
            class="song-ranking__brand"
            href="https://bdon.moe/"
            target="_blank"
            rel="noopener"
            aria-label="Moenotes"
            title="Moenotes"
          >
            <img
              class="song-ranking__brand-light"
              src="https://bdon.moe/assets/brand/moenotes-signature.svg"
              width="104"
              height="40"
              alt="Moenotes"
              decoding="async"
            />
            <img
              class="song-ranking__brand-dark"
              src="https://bdon.moe/assets/brand/moenotes-signature-light.svg"
              width="104"
              height="40"
              alt="Moenotes"
              decoding="async"
            />
          </a>
        </div>
        ${
          this.phase === "error" && !this.rows.length
            ? errorState(failureText, this.label("retry", "Retry"), () => this.refresh())
            : this.phase === "loading" && !this.rows.length
              ? loadingState(this.label("loading", "Loading ranking"))
              : !this.rows.length
                ? emptyState({
                    title:
                      failed === "not_found"
                        ? this.label("notFound", "No ranking is available for this song.")
                        : this.label("empty", "No scores yet"),
                    icon: "leaderboard",
                  })
                : html`
                    ${
                      this.phase === "error"
                        ? html`
                            <div class="song-ranking__notice song-ranking__notice--error" role="alert">
                              <span>${failureText}</span>
                              <button class="button button--text" type="button" @click=${() => this.refresh()}>
                                ${this.label("retry", "Retry")}
                              </button>
                            </div>
                          `
                        : nothing
                    }
                    <ol class="song-ranking__list" aria-label=${this.label("title", "Song ranking")}>
                      ${visible.map((entry) => this.renderRow(entry))}
                    </ol>
                    ${
                      showMore
                        ? html`
                            <button
                              class="button button--tonal song-ranking__more"
                              type="button"
                              @click=${() => (this.expanded = true)}
                            >
                              ${this.label("showMore", "Show top 100")}
                            </button>
                          `
                        : nothing
                    }
                  `
        }
      </div>
    `;
  }

  private renderProfile() {
    if (this.profilePhase === "loading") return loadingState(this.label("loading", "Loading ranking"));
    if (this.profilePhase === "private")
      return emptyState({ title: this.label("profilePrivate", "This profile is private."), icon: "lock" });
    if (this.profilePhase === "error")
      return errorState(
        this.label("profileUnavailable", "Profile unavailable"),
        this.label("retry", "Retry"),
        () => this.selectedEntry && void this.openProfile(this.selectedEntry),
      );
    const profile = this.profile;
    if (!profile) return nothing;
    return html`
      <div class="song-ranking__profile">
        <div class="song-ranking__profile-head">
          ${profile.profileCard?.thumbnailUrls.length ? nothing : this.profileMedia(profile.name || this.label("privatePlayer", "Unknown player"), "")}
          <div>
            <h2>${profile.name || this.label("privatePlayer", "Private player")}</h2>
            <p>${this.label("player", "Player")}</p>
          </div>
        </div>
        ${
          this.selectedEntry?.deckName ||
          this.selectedEntry?.totalPower != null ||
          profile.level !== null ||
          profile.totalFavorite !== null
            ? html`
                <dl class="spec-list spec-list--split song-ranking__profile-facts">
                  ${
                    this.selectedEntry?.deckName
                      ? html`
                          <div>
                            <dt>${this.label("deck", "Deck")}</dt>
                            <dd>${this.selectedEntry?.deckName}</dd>
                          </div>
                        `
                      : nothing
                  }
                  ${
                    this.selectedEntry?.totalPower != null
                      ? html`
                          <div>
                            <dt>${this.label("power", "Power")}</dt>
                            <dd class="tabular">${this.selectedEntry?.totalPower.toLocaleString(this.locale)}</dd>
                          </div>
                        `
                      : nothing
                  }
                  ${
                    profile.level !== null
                      ? html`
                          <div>
                            <dt>${this.label("level", "Level")}</dt>
                            <dd class="tabular">${profile.level.toLocaleString(this.locale)}</dd>
                          </div>
                        `
                      : nothing
                  }
                  ${
                    profile.totalFavorite !== null
                      ? html`
                          <div class="song-ranking__profile-cards">
                            <dt>${this.label("favorites", "Favorites")}</dt>
                            <dd>${profile.totalFavorite?.toLocaleString(this.locale)}</dd>
                          </div>
                        `
                      : nothing
                  }
                </dl>
              `
            : nothing
        }
      </div>
    `;
  }

  updated() {
    this.syncPageChrome();
  }

  render() {
    const loading = this.view === "ranking" ? this.phase === "loading" : this.profilePhase === "loading";
    return html`
      <section class="song-ranking-page" aria-label=${this.label("title", "Song ranking")}>
        <div class="song-ranking__progress" aria-hidden=${loading ? nothing : "true"}>
          ${
            loading
              ? html`
                  <md-linear-progress
                    indeterminate
                    aria-label=${this.label("loading", "Loading ranking")}
                  ></md-linear-progress>
                `
              : nothing
          }
        </div>
        ${this.view === "profile" ? this.renderProfile() : this.renderRanking()}
      </section>
    `;
  }
}

if (!customElements.get("song-ranking")) customElements.define("song-ranking", SongRanking);
