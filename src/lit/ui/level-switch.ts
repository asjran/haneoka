import { html, nothing } from "lit";
import "@material/web/slider/slider.js";
import "../../styles/card-detail.css";

export function renderLevelSwitch(
  label: string,
  levels: number[],
  value: number,
  update: (value: number) => void,
  displayValue: (value: number) => string = String,
) {
  if (levels.length < 2) return nothing;
  const index = Math.max(0, levels.indexOf(value));
  return html`
    <div class="detail-level-switch">
      <span class="detail-level-switch__value">
        <small>${label}</small>
        <strong>${displayValue(value)}</strong>
      </span>
      <button
        class="icon-button"
        ?disabled=${index === 0}
        @click=${() => update(levels[index - 1] ?? value)}
        aria-label=${`${label} ${levels[index - 1] ?? value}`}
      >
        <svg class="material-icon" width="18" height="18"><use href="/icons.svg#remove"></use></svg>
      </button>
      <md-slider
        class="md3-slider"
        min="0"
        max=${levels.length - 1}
        step="1"
        .value=${String(index)}
        @input=${(event: Event) => update(levels[Number((event.target as HTMLElement & { value?: number }).value)] ?? value)}
        aria-label=${label}
        aria-valuetext=${displayValue(value)}
      ></md-slider>
      <button
        class="icon-button"
        ?disabled=${index === levels.length - 1}
        @click=${() => update(levels[index + 1] ?? value)}
        aria-label=${`${label} ${levels[index + 1] ?? value}`}
      >
        <svg class="material-icon" width="18" height="18"><use href="/icons.svg#add"></use></svg>
      </button>
    </div>
  `;
}
