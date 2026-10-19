import { html, nothing } from "lit";
import "../../styles/components/gacha-prize-card.css";

export interface GachaPrizeCardOptions {
  label: string;
  kind: string;
  rarity: string | number;
  image?: string;
  href?: string;
  attribute?: string;
  rarityMark?: string;
  pickup?: boolean;
  pickupCount?: number;
  count?: number;
}

export function gachaPrizeCard({
  label,
  kind,
  rarity,
  image,
  href,
  attribute,
  rarityMark,
  pickup,
  pickupCount = 0,
  count = 0,
}: GachaPrizeCardOptions) {
  const body = html`
    ${
      image
        ? html`
            <img class="gacha-card__art" src=${image} alt="" loading="lazy" decoding="async" />
          `
        : nothing
    }
    ${
      attribute
        ? html`
            <img class="gacha-card__attribute" src=${attribute} alt="" />
          `
        : nothing
    }
    ${
      rarityMark
        ? html`
            <img class="gacha-card__rarity" src=${rarityMark} alt="" />
          `
        : nothing
    }
    ${
      pickup
        ? html`
            <span class="gacha-card__pickup">${pickupCount ? `UP ×${pickupCount}` : "UP"}</span>
          `
        : nothing
    }
    ${
      count
        ? html`
            <span class="gacha-card__count tabular">×${count}</span>
          `
        : nothing
    }
  `;
  return href
    ? html`
        <a class="gacha-card" data-kind=${kind} data-rarity=${rarity} href=${href} title=${label} aria-label=${label}>
          ${body}
        </a>
      `
    : html`
        <span class="gacha-card" data-kind=${kind} data-rarity=${rarity} title=${label} role="img" aria-label=${label}>
          ${body}
        </span>
      `;
}
