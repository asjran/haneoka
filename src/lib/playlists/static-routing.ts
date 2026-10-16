import { isLocale, type Locale } from "@haneoka/i18n";

const uuid = /^[0-9a-f-]{36}$/iu;
const validId = (value: string) => Boolean(value) && value.length <= 512 && !uuid.test(value) && !/[\\/\u0000-\u001f\u007f]/u.test(value);
export function playlistStaticId(id: string): string {
  if (!validId(id)) throw new TypeError("Invalid public playlist id");
  return btoa(String.fromCharCode(...new TextEncoder().encode(id))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
export function playlistStaticLocation(locale: unknown, id: string): { locale: Locale; id: string } | undefined {
  if (!isLocale(locale) || !/^[A-Za-z0-9_-]+$/u.test(id)) return;
  try {
    const binary = atob(id.replaceAll("-", "+").replaceAll("_", "/"));
    const value = new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    if (playlistStaticId(value) !== id) return;
    return { locale, id: value };
  } catch { return; }
}
export function playlistStaticDocumentPath(locale: Locale, id: string): string {
  return `/playlist-static/${locale}/${playlistStaticId(id)}.html`;
}
export function playlistStaticLookupPath(pathname: string): string | undefined {
  const match = /^\/playlist-static\/(ja|en|ko|zh-CN|zh-TW)\/([A-Za-z0-9_-]+)\.html$/u.exec(pathname);
  if (!match) return;
  const location = playlistStaticLocation(match[1], match[2]!);
  return location && playlistStaticDocumentPath(location.locale, location.id);
}
export function playlistStaticDocumentFromUrl(url: URL): string | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  if (!isLocale(parts[0]) || parts[1] !== "community" || parts[2] !== "playlists" || parts.length > 4 || url.searchParams.has("edit")) return;
  try {
    const id = url.searchParams.get("playlist") || decodeURIComponent(parts[3] || "");
    return validId(id) ? playlistStaticDocumentPath(parts[0], id) : undefined;
  } catch { return; }
}
