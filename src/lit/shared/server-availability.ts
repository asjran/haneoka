import { html, nothing } from "lit";
import { clientText } from "../../i18n/client";
import bushimo from "../../assets/icons/bushimo-circle.svg?url";
import { svg as bilibiliSvg } from "@thesvg/icons/bilibili";

export type FormalCatalogServer = "jp" | "intl";

// Use the same publisher marks as the release selector in SettingsDocument.
const bilibiliBody = bilibiliSvg
  .replace(/^<svg[^>]*>/, "")
  .replace(/<title>.*?<\/title>/, "")
  .replace(/<\/svg>$/, "");
const bilibili = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="256" fill="#00a1d6"/><g fill="#fff" transform="translate(76 76) scale(15)">${bilibiliBody}</g></svg>`)}`;

export function exclusiveServer(availability: readonly FormalCatalogServer[]): FormalCatalogServer | undefined {
  return availability.length === 1 && (availability[0] === "jp" || availability[0] === "intl")
    ? availability[0]
    : undefined;
}

export function serverAvailabilityImage(server: FormalCatalogServer): string {
  return server === "jp" ? bushimo : bilibili;
}

export function serverAvailabilityLabel(availability: readonly FormalCatalogServer[], locale: string): string {
  const server = exclusiveServer(availability);
  return server === "jp"
    ? clientText(locale, "catalogJapanOnly", "Japan only")
    : server === "intl"
      ? clientText(locale, "catalogInternationalOnly", "International only")
      : "";
}

/** Both-server entries reserve no badge; exclusivity uses the existing server emblem. */
export function serverAvailabilityBadge(availability: readonly FormalCatalogServer[], locale: string) {
  const server = exclusiveServer(availability);
  if (!server) return nothing;
  const label = serverAvailabilityLabel(availability, locale);
  return html`
    <img
      class="catalog-server-availability"
      src=${serverAvailabilityImage(server)}
      alt=${label}
      title=${label}
      width="18"
      height="18"
      decoding="async"
    />
  `;
}
