import { isLocale } from "@haneoka/i18n";
import { providerEntityHtmlPath, type ProviderEntityLocator } from "./provider-entity-data.ts";

function entityId(value: string | null): string | undefined {
  return value && value.length <= 768 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}
/** Preserve the original public URL while serving its generated document. */
export function providerEntityFromUrl(url: URL): ProviderEntityLocator | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const locale = parts[0];
  if (!isLocale(locale) || parts[1] !== "community") return;
  const tail = parts.slice(2);
  let provider: "bestdori" | "sekai";
  if (tail[0] === "sekai") { provider = "sekai"; tail.shift(); }
  else if (tail[0] === "songs-bestdori" || tail[0] === "stories-bestdori") provider = "bestdori";
  else return;
  if (tail.length !== 2) return;
  const song = tail[0] === (provider === "bestdori" ? "songs-bestdori" : "songs") && tail[1] === "detail";
  if (song) {
    const id = entityId(url.searchParams.get("song"));
    return id ? { provider, locale, resource: "songs", id } : undefined;
  }
  if (tail[0] !== (provider === "bestdori" ? "stories-bestdori" : "stories") || !/^[a-z]+$/u.test(tail[1]!)) return;
  const section = tail[1]!, story = entityId(url.searchParams.get("story"));
  const cardId = provider === "bestdori" && section === "card" ? entityId(url.searchParams.get("card")) : undefined;
  if (story) return { provider, locale, resource: "stories", section, id: story, ...(cardId ? { cardId } : {}) };
  if (cardId) return { provider, locale, resource: "cards", id: cardId };
  return;
}
export function providerEntityPhysicalPath(entry: ProviderEntityLocator): string {
  return providerEntityHtmlPath(entry).replace(/\.html$/u, "/");
}
