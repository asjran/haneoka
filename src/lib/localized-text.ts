import {
  contentLocaleFallbacks,
  normalizeAuthorLocale,
  resolveLocalizedValue,
  scriptForLanguageTag,
  type AuthorLocale,
} from "@haneoka/i18n";

export const TEXT_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;

export interface LocalizedValue {
  text: string;
  locale: AuthorLocale;
  lang: AuthorLocale | "und";
  script: string;
  isFallback: boolean;
}

const localeCache = new Map<string, string>();
const canonicalLocale = (locale: string): string => {
  const cached = localeCache.get(locale);
  if (cached) return cached;
  const value = normalizeAuthorLocale(locale) || locale;
  if (localeCache.size > 128) localeCache.clear();
  localeCache.set(locale, value);
  return value;
};

/**
 * Game-authored fallback is deliberately separate from UI copy. These are the
 * historical content candidates, including cross-script candidates where the
 * authored data policy explicitly permits them.
 */
export function localizedFallbacks(locale: string): string[] {
  const requested = canonicalLocale(locale);
  const language = normalizeAuthorLocale(requested) ? new Intl.Locale(requested) : undefined;
  const script = language?.maximize().script;
  return [
    ...new Set(
      language?.language === "zh" && script === "Hans"
        ? [requested, "zh-CN", "zh-Hans", "zh-TW", "zh-Hant", "ja", "en", "ko"]
        : language?.language === "zh" && script === "Hant"
          ? [requested, "zh-TW", "zh-Hant", "ja", "en", "zh-CN", "ko"]
          : [...contentLocaleFallbacks(requested), "ja", "en", "zh-TW", "zh-CN", "ko"],
    ),
  ];
}

export function resolveLocalizedText(value: unknown, locale: string, sourceLocale?: string): LocalizedValue {
  const requested = canonicalLocale(locale);
  const resolved = resolveLocalizedValue((typeof value === "number" ? String(value) : value) as never, requested, {
    fallbackLocales: localizedFallbacks(requested),
    sourceHint: sourceLocale ?? requested,
  });
  if (!resolved) {
    return {
      text: "",
      locale: requested,
      lang: "und",
      script: scriptForLanguageTag("und"),
      isFallback: false,
    };
  }
  const source = resolved.sourceLocale || requested;
  return {
    text: resolved.text,
    locale: source,
    lang: resolved.lang,
    script: resolved.script,
    isFallback: resolved.isFallback,
  };
}
