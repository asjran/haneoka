import { html, nothing } from "lit";
import "../../styles/rarity-icon.css";

export function cardRarityName(value: unknown): string {
  return ({ 2: "R", 3: "SR", 4: "SSR", 10: "EX", 20: "BD" } as Record<number, string>)[Number(value)] || "";
}

/** Keep the native sprite square, including while its source is loading. */
export function rarityIcon(source: string, label: string) {
  return source
    ? html`
        <img class="rarity-icon" src=${source} alt=${label} title=${label} width="24" height="24" decoding="async" />
      `
    : html`
        <span class="rarity-icon" role="img" aria-label=${label || nothing} title=${label || nothing}></span>
      `;
}
