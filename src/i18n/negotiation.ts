import { isLocale, matchLocale, type UiLocale } from "@haneoka/i18n/locales";

/** Saved UI choice, then the device's ordered language preferences. */
export function preferredUiLocale(saved: unknown, languages: readonly string[], fallback: UiLocale = "en"): UiLocale {
  if (isLocale(saved)) return saved;
  for (const language of languages) {
    const matched = matchLocale(language);
    if (matched) return matched;
  }
  return fallback;
}

export function preferredDeviceLocale(): UiLocale {
  let saved: string | null = null;
  try {
    saved = globalThis.localStorage?.getItem("haneoka.locale") ?? null;
  } catch {}
  const languages =
    typeof navigator === "undefined" ? [] : navigator.languages.length ? navigator.languages : [navigator.language];
  return preferredUiLocale(saved, languages);
}

/** HTTP equivalent of device selection; malformed cookies remain recoverable. */
export function negotiateRequestLocale(cookie: string, acceptLanguage: string): UiLocale {
  let saved: string | undefined;
  const encoded = /(?:^|;\s*)haneoka\.locale=([^;]*)/u.exec(cookie)?.[1];
  if (encoded) {
    try {
      saved = decodeURIComponent(encoded);
    } catch {}
  }
  const languages = acceptLanguage
    .split(",")
    .map((entry, index) => {
      const [tag = "", ...parameters] = entry.trim().split(";");
      const qualityParameter = parameters.find((parameter) => /^\s*q\s*=/iu.test(parameter));
      const quality = qualityParameter === undefined ? 1 : Number(qualityParameter.split("=")[1]?.trim());
      return { tag: tag.trim(), quality, index };
    })
    .filter(({ quality }) => Number.isFinite(quality) && quality > 0 && quality <= 1)
    .sort((left, right) => right.quality - left.quality || left.index - right.index)
    .map(({ tag }) => tag);
  return preferredUiLocale(saved, languages);
}
