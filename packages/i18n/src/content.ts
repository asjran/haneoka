import {
  contentLocaleFallbacks,
  matchLocale,
  normalizeAuthorLocale,
  scriptForLanguageTag,
  type AuthorLocale,
  type Locale,
} from "./locales.js";

export type LocalizedValue = string | readonly (string | null | undefined)[] | Readonly<Record<string, unknown>>;
export type LocalizedValueInput = LocalizedValue | null | undefined;

export type ContentFallbackReason = "none" | "content-explicit" | "content-script" | "content-source" | "missing";

export interface ResolvedLocalizedText {
  readonly text: string;
  readonly requestedLocale: AuthorLocale;
  readonly sourceLocale: AuthorLocale | null;
  readonly lang: AuthorLocale | "und";
  readonly script: string;
  readonly isFallback: boolean;
  readonly fallbackReason: ContentFallbackReason;
}

export interface ResolveLocalizedValueOptions {
  readonly candidates?: readonly LocalizedValueInput[];
  readonly fallback?: string | null;
  readonly sourceHint?: AuthorLocale | null;
  readonly fallbackSourceHint?: AuthorLocale | null;
  /** Explicit authored-content policy. No UI-locale chain is appended implicitly. */
  readonly fallbackLocales?: readonly AuthorLocale[];
}

const localeIndexes: Partial<Record<Locale, number>> = {
  ja: 0,
  en: 1,
  "zh-TW": 2,
  "zh-CN": 3,
  ko: 4,
};

const localeObjectAliases: Readonly<Record<string, Locale>> = {
  japanese: "ja",
  english: "en",
  korean: "ko",
  "traditional-chinese": "zh-TW",
  traditionalchinese: "zh-TW",
  "simplified-chinese": "zh-CN",
  simplifiedchinese: "zh-CN",
};

const masterTextPlaceholder =
  /^(?:Music|Story|Character|Card|MemberCard|SupportCard|Stamp|Comic|Band|Chapter|Episode)_(?:Tilte|Title|Name|Text|Description|Desc|Subtitle|CatchCopy|Profile|Lyricist|Composer|Arranger)(?:_[A-Za-z0-9]+)+$/i;

const normalizedObjectKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");

export const isUsableLocalizedText = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return Boolean(text) && !masterTextPlaceholder.test(text);
};

const sourceTag = (sourceLocale: AuthorLocale | null): string => {
  if (!sourceLocale) return "und";
  return normalizeAuthorLocale(sourceLocale) ?? sourceLocale;
};

const resolvedText = (
  text: string,
  sourceLocale: AuthorLocale | null,
  requestedLocale: AuthorLocale,
  fallbackReason: ContentFallbackReason,
): ResolvedLocalizedText => {
  const source = sourceTag(sourceLocale);
  const requested = normalizeAuthorLocale(requestedLocale) ?? requestedLocale;
  const isFallback = fallbackReason !== "none" || (sourceLocale !== null && source !== requested);
  return {
    text,
    requestedLocale,
    sourceLocale,
    lang: source,
    script: scriptForLanguageTag(source),
    isFallback,
    fallbackReason,
  };
};

const canonicalChain = (requested: AuthorLocale, explicit?: readonly AuthorLocale[]): readonly AuthorLocale[] => {
  const chain = explicit ?? contentLocaleFallbacks(requested);
  return [...new Set(chain.map((value) => normalizeAuthorLocale(value) ?? value).filter(Boolean))];
};

const arraySourceLocale = (candidate: AuthorLocale): AuthorLocale => matchLocale(candidate) ?? candidate;

const resolveSingleValue = (
  value: LocalizedValueInput,
  requestedLocale: AuthorLocale,
  chain: readonly AuthorLocale[],
  sourceHint: AuthorLocale | null = null,
): ResolvedLocalizedText | null => {
  if (typeof value === "string") {
    return isUsableLocalizedText(value) ? resolvedText(value, sourceHint, requestedLocale, "none") : null;
  }

  if (Array.isArray(value)) {
    for (const [index, candidateLocale] of chain.entries()) {
      const uiLocale = matchLocale(candidateLocale);
      const valueIndex = uiLocale === null ? undefined : localeIndexes[uiLocale];
      if (valueIndex === undefined) continue;
      const text = value[valueIndex];
      if (isUsableLocalizedText(text)) {
        return resolvedText(
          text,
          arraySourceLocale(candidateLocale),
          requestedLocale,
          index === 0 ? "none" : "content-explicit",
        );
      }
    }
    return null;
  }

  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.values)) {
    return resolveSingleValue(
      record.values as readonly (string | null | undefined)[],
      requestedLocale,
      chain,
      sourceHint,
    );
  }

  const variantSource =
    record.variants && typeof record.variants === "object" && !Array.isArray(record.variants)
      ? (record.variants as Record<string, unknown>)
      : record;
  const localizedEntries = new Map<AuthorLocale, string>();
  for (const [key, text] of Object.entries(variantSource)) {
    if (
      ["id", "raw", "url", "key", "src", "ref", "values", "variants", "text", "value", "lang", "locale"].includes(key)
    )
      continue;
    const entryLocale = localeObjectAliases[normalizedObjectKey(key)] ?? normalizeAuthorLocale(key);
    if (entryLocale && !localizedEntries.has(entryLocale) && isUsableLocalizedText(text)) {
      localizedEntries.set(entryLocale, text);
    }
  }

  for (const [index, candidateLocale] of chain.entries()) {
    const text = localizedEntries.get(candidateLocale);
    if (text !== undefined) {
      const reason =
        index === 0 ? "none" : candidateLocale.toLowerCase().includes("-") ? "content-script" : "content-explicit";
      return resolvedText(text, candidateLocale, requestedLocale, reason);
    }
  }

  if (record.text !== undefined || record.value !== undefined) {
    const nestedSource =
      typeof record.lang === "string" ? record.lang : typeof record.locale === "string" ? record.locale : sourceHint;
    const nested = resolveSingleValue(
      (record.text ?? record.value) as LocalizedValueInput,
      requestedLocale,
      chain,
      nestedSource,
    );
    if (nested) return nested;
  }

  for (const [entryLocale, text] of localizedEntries) {
    if (isUsableLocalizedText(text)) return resolvedText(text, entryLocale, requestedLocale, "content-source");
  }
  return null;
};

export const resolveLocalizedValue = (
  value: LocalizedValueInput,
  requestedLocale: AuthorLocale,
  options: ResolveLocalizedValueOptions = {},
): ResolvedLocalizedText | null => {
  const chain = canonicalChain(requestedLocale, options.fallbackLocales);
  const values: readonly LocalizedValueInput[] = [value, ...(options.candidates ?? [])];
  for (const [index, candidate] of values.entries()) {
    const result = resolveSingleValue(candidate, requestedLocale, chain, options.sourceHint ?? null);
    if (result) {
      return index === 0 ? result : { ...result, isFallback: true, fallbackReason: "content-source" };
    }
  }

  if (!isUsableLocalizedText(options.fallback)) return null;
  const result = resolveSingleValue(options.fallback, requestedLocale, chain, options.fallbackSourceHint ?? null);
  return result ? { ...result, isFallback: true, fallbackReason: "content-source" } : null;
};

export const localizeValue = (value: LocalizedValueInput, locale: Locale): string =>
  resolveLocalizedValue(value, locale)?.text ?? "";
