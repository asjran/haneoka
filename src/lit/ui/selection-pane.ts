import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { tile, type TileOptions } from "./tile";
import { iconButton, rovingKeydown } from "./controls";

/** Native chooser dialog, matching the stamp selector above the app shell. */
export function selectionPane(options: {
  id: string;
  title: string;
  closeLabel: string;
  close: () => void;
  searchLabel: string;
  filterLabel: string;
  filtersOpen: boolean;
  toggleFilters: () => void;
  query: string;
  search: (value: string) => void;
  filters: unknown;
  kind: "member" | "support" | "song" | "system";
  items: ReadonlyArray<TileOptions & { value: string }>;
  selected: string;
  select: (value: string) => void;
  countLabel: string;
  emptyLabel: string;
  moreLabel: string;
  more?: () => void;
  preview: unknown;
}) {
  const previewId = `${options.id}-preview`;
  const selectedVisible = options.items.some((item) => item.value === options.selected);
  return html`
    <dialog
      class="selection-pane"
      aria-label=${options.title}
      @cancel=${(event: Event) => {
        event.preventDefault();
        options.close();
      }}
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) options.close();
      }}
    >
      <header class="sheet__header">
        <strong>${options.title}</strong>
        <span class="selection-pane__actions">
          ${iconButton({ icon: "filter_alt", label: options.filterLabel, pressed: options.filtersOpen, onClick: options.toggleFilters })}
          ${iconButton({ icon: "close", label: options.closeLabel, onClick: options.close })}
        </span>
      </header>
      <div class="selection-pane__body">
        <md-outlined-text-field
          type="search"
          label=${options.searchLabel}
          .value=${live(options.query)}
          @input=${(event: Event) => options.search((event.currentTarget as HTMLInputElement).value)}
        ></md-outlined-text-field>
        ${
          options.filtersOpen
            ? html`
                <div class="team-builder__fields" aria-label=${options.filterLabel}>${options.filters}</div>
              `
            : nothing
        }
        <p role="status" class="team-builder__hint">${options.countLabel}</p>
        <div
          class=${`collection collection--${options.kind}`}
          role="tablist"
          aria-label=${options.title}
          @keydown=${rovingKeydown(
            options.items.map((item) => item.value),
            options.selected,
            options.select,
          )}
        >
          ${options.items.map((item, index) =>
            tile({
              ...item,
              selected: item.value === options.selected,
              role: "tab",
              controls: previewId,
              tabIndex: item.value === options.selected || (!selectedVisible && index === 0) ? 0 : -1,
              onOpen: () => options.select(item.value),
            }),
          )}
        </div>
        ${
          !options.items.length
            ? html`
                <p>${options.emptyLabel}</p>
              `
            : nothing
        }
        ${
          options.more
            ? html`
                <button class="button button--text" @click=${options.more}>${options.moreLabel}</button>
              `
            : nothing
        }
      </div>
      <footer class="selection-pane__footer">
        <div id=${previewId} role="tabpanel" class="team-builder__picker-preview">${options.preview}</div>
      </footer>
    </dialog>
  `;
}
