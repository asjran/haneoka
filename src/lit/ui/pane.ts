import { html, nothing, type TemplateResult } from "lit";
import { trapFocus } from "../../lib/overlay";
import { icon } from "./icon";
import { appBarTakeover } from "../../lib/app-bar-takeover";

/**
 * Detail pane.
 *
 * A full-screen surface at every size (Material's full-screen dialog): the
 * shell's app bar carries its Back, title and actions while it is open,
 * focus is contained and Escape closes. The
 * detail is a destination rather than a preview beside the list, so it never
 * competes with the collection for width.
 */

export interface PaneOptions {
  /** Heading. `title` is the entity, `subtitle` its supporting line. */
  title: unknown;
  titleLanguage?: string;
  subtitle?: unknown;
  /** Presentation hook: `.sheet--detail-{kind}`. */
  kind?: string;
  open: boolean;
  backLabel: string;
  onClose: () => void;
  /** Leading emblem (rarity, attribute, band). */
  leading?: unknown;
  /** Trailing header actions. */
  actions?: unknown;
  body: unknown;
  footer?: unknown;
  /** id used for aria-labelledby wiring. */
  id?: string;
  style?: string;
  /** Canonical entity pages already own the shell's app bar. */
  hideHeader?: boolean;
  /** Render a canonical entity as normal page flow instead of a modal dialog. */
  page?: boolean;
}

export function renderPane(options: PaneOptions): TemplateResult {
  const classes = [
    "sheet",
    "sheet--detail",
    options.kind ? `sheet--detail-${options.kind}` : "",
    options.page ? "sheet--detail-page" : "",
    options.open ? "is-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const content = html`
    <div class="sheet__body">${options.body}</div>
    ${
      options.footer
        ? html`
            <footer class="sheet__footer">${options.footer}</footer>
          `
        : nothing
    }
  `;
  return options.page
    ? html`
        <article
          class=${classes}
          aria-label=${options.title}
          ?inert=${!options.open}
          tabindex="-1"
          data-detail-pane
          style=${options.style || nothing}
        >
          ${content}
        </article>
      `
    : html`
        <aside
          class=${classes}
          role="dialog"
          aria-modal="true"
          aria-label=${typeof options.title === "string" ? options.title : nothing}
          ${appBarTakeover(
            options.open && !options.hideHeader
              ? {
                  title: typeof options.title === "string" ? options.title : "",
                  titleLanguage: options.titleLanguage,
                  backLabel: options.backLabel,
                  onBack: options.onClose,
                  identity:
                    options.leading || options.subtitle
                      ? html`${options.leading ?? nothing}${
                          options.subtitle
                            ? html`<div class="browse__crumbs">${icon("chevron_right", 20)}<span>${options.subtitle}</span></div>`
                            : nothing
                        }`
                      : nothing,
                  actions: options.actions ? html`${options.actions}` : nothing,
                }
              : null,
          )}
          ?inert=${!options.open}
          tabindex="-1"
          data-detail-pane
          style=${options.style || nothing}
        >
          ${content}
        </aside>
      `;
}

/**
 * Keeps focus inside whichever overlay is currently open.
 * A component owns one of these and calls sync() from updated().
 */
export class PaneFocus {
  private release?: () => void;
  private current?: HTMLElement;

  /** Attach to `root` (or detach when it is null / closed). */
  sync(root: HTMLElement | null, onDismiss: () => void) {
    // Native modal dialogs already own focus/inertness, including nested dialogs.
    if (root?.closest("dialog")) {
      this.detach();
      return;
    }
    if (!root) {
      this.detach();
      return;
    }
    if (this.current === root) return;
    this.detach();
    this.current = root;
    this.release = trapFocus(root, { onDismiss });
  }

  detach() {
    this.release?.();
    this.release = undefined;
    this.current = undefined;
  }
}

/**
 * Section heading inside a pane, with an emblem and an optional count.
 * `emblem` is an already-rendered 20dp icon, because the sprite builder only
 * sees icon names written as literals at the call site.
 */
export function paneSection(
  label: unknown,
  emblem: unknown,
  body: unknown,
  count?: number,
  level: 2 | 3 = 2,
): TemplateResult {
  const heading = html`
    <span class="detail-section-title__icon">${emblem}</span>
    <span class="detail-section-title__label">${label}</span>
    ${
      count === undefined
        ? nothing
        : html`
            <span class="detail-section-title__count">${count}</span>
          `
    }
  `;
  return html`
    <section class="detail-section">
      ${
        level === 2
          ? html`
              <h2 class="detail-section-title detail-section-title--h2">${heading}</h2>
            `
          : html`
              <h3 class="detail-section-title">${heading}</h3>
            `
      }
      ${body}
    </section>
  `;
}
