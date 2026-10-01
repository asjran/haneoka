import { resolveLocalizedText } from "../lib/localized-text";
import { releaseServerFromPath } from "../lib/resource-route";
export const LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ja";
export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (LOCALES as readonly string[]).includes(value);
export const localeTag = (locale: Locale) =>
  ({ ja: "ja-JP", en: "en", "zh-TW": "zh-TW", "zh-CN": "zh-CN", ko: "ko" })[locale];
export const localeFallbacks = (locale: Locale): readonly Locale[] =>
  locale === "zh-CN" ? ["zh-CN", "zh-TW", "ja", "en", "ko"] : [locale, "ja", ...LOCALES];
/** Change the interface language while retaining an explicitly addressed server. */
export const localePath = (route: string, locale: Locale): string => {
  const path = route.split(/[?#]/u, 1)[0] || "/";
  const suffix = route.slice(path.length);
  const parts = path.split("/").filter(Boolean);
  const server = releaseServerFromPath(path);
  if (server && isLocale(parts[1])) {
    parts[1] = locale;
    return `/${parts.join("/")}/${suffix}`;
  }
  if (isLocale(parts[0])) parts.shift();
  return `/${locale}/${parts.length ? `${parts.join("/")}/` : ""}${suffix}`;
};

/** The locale baked into a pathname prefix, if any. */
export const localeFromPath = (pathname: string): Locale | undefined => {
  const parts = pathname.replace(/^\/+/, "").split("/");
  const prefix = parts[releaseServerFromPath(pathname) ? 1 : 0] || "";
  return isLocale(prefix) ? prefix : undefined;
};
export function localizeValue(value: unknown, locale: Locale): string {
  return resolveLocalizedText(value, locale).text;
}
