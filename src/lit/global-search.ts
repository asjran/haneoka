import { LitElement, html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { clientText } from "../i18n/client";
import { beginLoading } from "../lib/loading-progress";
import { communityExcerpt } from "../lib/community-markup";
import { communityPostMedia, communityMediaThumbnail } from "../lib/community-artwork";
import { loadingState, emptyState, errorState } from "./ui/state";
import { fetchJson } from "./shared/catalog";

type RecordValue = Record<string, unknown>;
interface SearchResult {
  url: string;
  excerpt: string;
  meta: { title?: string; label?: string; image?: string };
  sub_results?: Array<{ url: string; title: string; excerpt: string }>;
}
interface SearchHit {
  id: string;
  data(): Promise<SearchResult>;
}
interface SearchApi {
  init(): Promise<void>;
  destroy(): Promise<void>;
  search(query: string): Promise<{ results: SearchHit[] }>;
}
const moduleUrl = "/pagefind/pagefind.js";
let indexModule: Promise<SearchApi> | undefined;
let indexLanguage = "";
let initialization = Promise.resolve();

async function searchIndex(): Promise<SearchApi> {
  indexModule ??= import(/* @vite-ignore */ moduleUrl).catch((error) => {
    indexModule = undefined;
    throw error;
  });
  const api = await indexModule;
  const language = document.documentElement.lang;
  initialization = initialization
    .catch(() => undefined)
    .then(async () => {
      if (indexLanguage === language) return;
      if (indexLanguage) await api.destroy();
      await api.init();
      indexLanguage = language;
    });
  await initialization;
  return api;
}

export class GlobalSearch extends LitElement {
  static properties = {
    locale: { type: String },
    query: { state: true },
    busy: { state: true },
    results: { state: true },
    posts: { state: true },
    catalogError: { state: true },
    communityError: { state: true },
    total: { state: true },
  };
  declare locale: string;
  declare query: string;
  declare busy: boolean;
  declare results: SearchResult[];
  declare posts: RecordValue[];
  declare catalogError: string;
  declare communityError: string;
  declare total: number;
  private hits: SearchHit[] = [];
  private cursor = "";
  private request?: AbortController;
  private lifetime?: AbortController;
  private timer?: number;
  constructor() {
    super();
    this.locale = "en";
    this.query = "";
    this.busy = false;
    this.results = [];
    this.posts = [];
    this.catalogError = "";
    this.communityError = "";
    this.total = 0;
  }
  createRenderRoot() {
    return this;
  }
  private label(key: string) {
    return clientText(this.locale, key);
  }
  connectedCallback() {
    super.connectedCallback();
    this.lifetime = new AbortController();
    this.query = new URLSearchParams(location.search).get("q") || "";
    const form = document.querySelector<HTMLFormElement>("[data-global-search-form]");
    const input = form?.querySelector<HTMLElement & { value: string }>("[data-global-search-input]");
    if (input) input.value = this.query;
    const perform = () => {
      window.clearTimeout(this.timer);
      this.query = input?.value.trim() || "";
      const params = new URLSearchParams(location.search);
      if (this.query) params.set("q", this.query);
      else params.delete("q");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
      void this.search();
    };
    form?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        perform();
      },
      { signal: this.lifetime.signal },
    );
    input?.addEventListener(
      "input",
      () => {
        window.clearTimeout(this.timer);
        this.request?.abort();
        this.timer = window.setTimeout(perform, 300);
      },
      { signal: this.lifetime.signal },
    );
    void this.search();
  }
  disconnectedCallback() {
    window.clearTimeout(this.timer);
    this.request?.abort();
    this.lifetime?.abort();
    super.disconnectedCallback();
  }
  private async search(append = false) {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const current = () => this.isConnected && !request.signal.aborted && this.request === request;
    const query = this.query.trim();
    if (!append) {
      this.results = [];
      this.posts = [];
      this.hits = [];
      this.cursor = "";
      this.total = 0;
    }
    this.catalogError = "";
    this.communityError = "";
    if (!query) {
      this.busy = false;
      return;
    }
    this.busy = true;
    const progress = beginLoading(this.label("loading"), { signal: request.signal });
    const catalog = (async () => {
      const api = await searchIndex();
      if (!current()) return;
      if (!append) {
        const found = await api.search(query);
        if (!current()) return;
        this.hits = found.results;
        this.total = this.hits.length;
      }
      const batch = await Promise.all(
        this.hits.slice(this.results.length, this.results.length + 20).map((hit) => hit.data()),
      );
      if (current()) this.results = [...this.results, ...batch];
    })().catch((error) => {
      if (current()) this.catalogError = String(error instanceof Error ? error.message : error);
    });
    const community = (async () => {
      if (append && !this.cursor) return;
      const params = new URLSearchParams({ q: query, scope: "latest", state: "active", limit: "20" });
      if (append) params.set("cursor", this.cursor);
      const data = await fetchJson<{ posts?: RecordValue[]; nextCursor?: string }>(
        `/api/v1/community/posts?${params}`,
        {
          signal: request.signal,
          credentials: "same-origin",
          cache: "no-store",
          headers: { accept: "application/json" },
        },
      );
      if (!current()) return;
      this.posts = [...this.posts, ...(data.posts || [])];
      this.cursor = data.nextCursor || "";
    })().catch((error) => {
      if (current()) this.communityError = String(error instanceof Error ? error.message : error);
    });
    try {
      await Promise.all([catalog, community]);
    } finally {
      progress.finish();
      if (current()) this.busy = false;
    }
  }
  private image(image: string | undefined) {
    const source = image?.trim();
    return source
      ? html`
          <span class="search-result__image">
            <md-circular-progress indeterminate aria-hidden="true"></md-circular-progress>
            <img
              src=${source}
              data-loading="true"
              alt=""
              loading="lazy"
              decoding="async"
              @load=${(event: Event) => {
                const imageElement = event.currentTarget as HTMLImageElement;
                imageElement.removeAttribute("data-loading");
                imageElement.classList.add("is-loaded");
              }}
              @error=${(event: Event) => {
                const imageElement = event.currentTarget as HTMLImageElement;
                imageElement.removeAttribute("data-loading");
                imageElement.classList.add("is-error");
              }}
            />
          </span>
        `
      : nothing;
  }
  private resultHref(rawUrl: string): string {
    try {
      const url = new URL(rawUrl, document.baseURI);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
    }
  }
  render() {
    if (!this.query.trim()) return nothing;
    return html`
      ${this.busy && !this.results.length && !this.posts.length ? loadingState(this.label("loading")) : nothing}
      <section aria-label=${this.label("catalog")}>
        <h2>
          ${this.label("catalog")}
          ${
            this.total
              ? html`
                  <small>${this.total.toLocaleString(this.locale)}</small>
                `
              : nothing
          }
        </h2>
        ${this.catalogError ? errorState(this.label("unavailable"), this.label("retry"), () => void this.search(), this.catalogError) : nothing}
        <ul class="search-results">
          ${this.results.map((result) => {
            const target = result.sub_results?.find((row) => row.url.includes("#")) || result;
            return html`
              <li>
                <a class="search-result state-layer" href=${this.resultHref(target.url)}>
                  ${this.image(result.meta.image)}
                  <span class="search-result__copy">
                    <strong>${result.meta.label || result.meta.title || target.url}</strong>
                    <p>${unsafeHTML(target.excerpt)}</p>
                  </span>
                </a>
              </li>
            `;
          })}
        </ul>
      </section>
      <section aria-label=${this.label("community")}>
        <h2>${this.label("community")}</h2>
        ${this.communityError ? errorState(this.label("unavailable"), this.label("retry"), () => void this.search(), this.communityError) : nothing}
        <ul class="search-results">
          ${this.posts.map(
            (post) => html`
              <li>
                <a
                  class="search-result state-layer"
                  href=${`/${this.locale}/community/posts/${encodeURIComponent(String(post.id))}/`}
                >
                  ${this.image(communityPostMedia(post).map(communityMediaThumbnail).find(Boolean))}
                  <span class="search-result__copy">
                    <strong>${String(post.title || "")}</strong>
                    <p>${communityExcerpt(String(post.excerpt || post.body || "")).slice(0, 180)}</p>
                    <p>${String(post.authorName || post.authorHandle || "")}</p>
                  </span>
                </a>
              </li>
            `,
          )}
        </ul>
      </section>
      ${!this.busy && !this.total && !this.posts.length && !this.catalogError && !this.communityError ? emptyState({ title: this.label("empty") }) : nothing}
      ${
        this.results.length < this.total || this.cursor
          ? html`
              <button
                class="button button--tonal search-page__more"
                type="button"
                ?disabled=${this.busy}
                @click=${() => void this.search(true)}
              >
                ${this.busy ? this.label("loading") : this.label("loadMore")}
              </button>
            `
          : nothing
      }
    `;
  }
}
customElements.define("global-search", GlobalSearch);
