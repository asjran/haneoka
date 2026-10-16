import { isReleaseServer } from "./resource-route.ts";

export const CHARACTER_DETAIL_SECTIONS = [
  "profile",
  "cards",
  "stamps",
  "voices",
  "story",
  "friendships",
  "missions",
  "live2d",
  "songs",
] as const;
/** Existing tab/query URLs retain their address and receive their selected HTML. */
export function staticViewFromUrl(url: URL): string | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const [server, locale, kind, id] = parts;
  if (!isReleaseServer(server) || !/^(ja|en|ko|zh-CN|zh-TW)$/u.test(locale || "")) return;
  if (kind === "characters" && id && parts.length === 4) {
    const section = url.searchParams.get("section");
    if (section && section !== "profile" && CHARACTER_DETAIL_SECTIONS.some((value) => value === section))
      return `/static-views/${server}/${locale}/characters/${encodeURIComponent(id)}/${section}/`;
  }
  if (kind === "help" && parts.length === 3) {
    const mode = url.searchParams.get("mode");
    const topic = url.searchParams.get("topic");
    if (mode === "tips") return `/static-views/${server}/${locale}/help/tips/`;
    if (topic && /^\d+$/u.test(topic)) return `/static-views/${server}/${locale}/help/manual-${topic}/`;
  }
  return;
}
