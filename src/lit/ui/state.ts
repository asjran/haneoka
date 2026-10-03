import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { beginLoading, prepareMaterialProgress, type LoadingReporter } from "../../lib/loading-progress";
import "@material/web/progress/linear-progress.js";
import { icon } from "./icon";

/** A loading template owns one shell report for exactly its mounted lifetime. */
class PageLoadingState extends LitElement {
  static properties = {
    label: {},
    local: { type: Boolean },
    shell: { state: true },
  };
  declare label: string;
  declare local: boolean;
  declare private shell: boolean;
  private report?: LoadingReporter;

  constructor() {
    super();
    this.label = "";
    this.local = false;
    this.shell = false;
  }
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback();
    this.syncReport();
  }
  disconnectedCallback() {
    this.report?.cancel();
    this.report = undefined;
    super.disconnectedCallback();
  }
  protected updated() { this.syncReport(); }
  private syncReport() {
    if (!this.isConnected) return;
    const shell = !this.local && !this.closest("dialog") && Boolean(document.querySelector("[data-page-progress]"));
    this.shell = shell;
    this.toggleAttribute("data-shell-loading", shell);
    if (shell) {
      if (!this.report) this.report = beginLoading(this.label);
      else this.report.update({ stageLabel: this.label });
    } else {
      this.report?.cancel();
      this.report = undefined;
    }
  }
  render() {
    return this.shell ? nothing : html`
      <md-linear-progress ${ref(prepareMaterialProgress)} indeterminate aria-label=${this.label}></md-linear-progress>
    `;
  }
}
if (typeof customElements !== "undefined" && !customElements.get("haneoka-loading-state"))
  customElements.define("haneoka-loading-state", PageLoadingState);

export function loadingState(label: string, options: { local?: boolean } = {}): TemplateResult {
  return html`<haneoka-loading-state label=${label} ?local=${options.local}></haneoka-loading-state>`;
}

export interface EmptyStateOptions {
  title: string;
  body?: string;
  icon?: string;
  action?: TemplateResult;
}

export function noticeState(options: EmptyStateOptions): TemplateResult {
  return html`
    <div class="notice notice--construction" role="status">
      <div class="notice__art"><img src="/images/maintenance-characters.png" alt="" decoding="async" /></div>
      <span class="notice__icon">${icon(options.icon || "construction", 36)}</span>
      <h2>${options.title}</h2>
      ${
        options.body
          ? html`
              <p>${options.body}</p>
            `
          : nothing
      }
      ${options.action ?? nothing}
    </div>
  `;
}

export function emptyState(options: EmptyStateOptions): TemplateResult {
  return html`
    <div class="state" role="status">
      <span class="state__icon">${icon(options.icon || "search_off", 28)}</span>
      <p class="state__title">${options.title}</p>
      ${
        options.body
          ? html`
              <p class="state__body">${options.body}</p>
            `
          : nothing
      }
      ${
        options.action
          ? html`
              <div class="state__actions">${options.action}</div>
            `
          : nothing
      }
    </div>
  `;
}

export function errorState(title: string, retryLabel: string, onRetry: () => void, body?: string): TemplateResult {
  return html`
    <div class="state state--error" role="alert">
      <span class="state__icon">${icon("cloud_off", 28)}</span>
      <p class="state__title">${title}</p>
      ${
        body
          ? html`
              <p class="state__body">${body}</p>
            `
          : nothing
      }
      <div class="state__actions">
        <button class="button button--tonal" type="button" @click=${onRetry}>
          ${icon("refresh", 18)}
          <span>${retryLabel}</span>
        </button>
      </div>
    </div>
  `;
}
