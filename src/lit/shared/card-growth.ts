import { html, nothing } from "lit";
import type { CardGrowthIcons } from "../../lib/ui-marks";

export interface CardGrowth {
  kind: "member" | "support";
  icons: CardGrowthIcons;
  level?: number | null;
  training?: number | null;
  rank?: number | null;
  skill?: number | null;
  unknown?: string;
  trainingLabel: string;
  rankLabel: string;
  skillLabel?: string;
  skillShortLabel?: string;
}

export function cardGrowth(options: CardGrowth) {
  const value = (number: number | null | undefined) => number ?? options.unknown ?? "?";
  const rank = options.kind === "member" ? options.icons.memberRanks : options.icons.supportRanks;
  const rankImage = rank[options.rank ?? 0];
  return html`<span class=${`card-growth card-growth--${options.kind}`}>
    ${options.level !== undefined
      ? html`<span class="card-growth__level"><small>Lv.</small>${value(options.level)}</span>`
      : nothing}
    ${options.kind === "member" && options.training !== undefined
      ? html`<span class="card-growth__training" title=${`${options.trainingLabel} ${value(options.training)}`}>
          ${options.icons.training ? html`<img src=${options.icons.training} alt=${options.trainingLabel} />` : options.trainingLabel}
          <span>${value(options.training)}</span>
          ${options.skill !== undefined ? html`<small title=${options.skillLabel}>${options.skillShortLabel}${value(options.skill)}</small>` : nothing}
        </span>`
      : nothing}
    ${options.rank !== undefined
      ? html`<span class="card-growth__rank" title=${`${options.rankLabel} ${value(options.rank)}`}>
          ${rankImage ? html`<img src=${rankImage} alt=${`${options.rankLabel} ${value(options.rank)}`} />` : html`<span>${options.rankLabel} ${value(options.rank)}</span>`}
          ${options.rank === null && rankImage ? html`<strong>${value(options.rank)}</strong>` : nothing}
        </span>`
      : nothing}
  </span>`;
}
