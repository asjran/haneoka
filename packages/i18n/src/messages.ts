import { languageTagFor, scriptForLanguageTag, uiLocaleFallbacks, type Locale } from "./locales.js";

export type MessageList = readonly MessageNode[];
export interface MessageTree {
  readonly [key: string]: MessageNode;
}
export type MessageNode = string | MessageTree | MessageList;
export type MessageCatalog = MessageTree;
export type MessageCatalogs = Partial<Record<Locale, MessageCatalog>>;
export type MessageParams = Readonly<Record<string, string | number>> | ReadonlyArray<string | number>;

export type UiFallbackReason = "none" | "ui-default" | "missing";

export interface ResolvedMessage {
  readonly key: string;
  readonly text: string;
  readonly requestedLocale: Locale;
  readonly sourceLocale: Locale | null;
  readonly lang: string;
  readonly script: string;
  readonly isFallback: boolean;
  readonly fallbackReason: UiFallbackReason;
}

export interface Catalog {
  readonly locale: Locale;
  resolve(key: string, params?: MessageParams): ResolvedMessage;
  text(key: string, params?: MessageParams, fallback?: string): string;
  plural(key: string, count: number, params?: MessageParams): ResolvedMessage;
  has(key: string): boolean;
  group<T = MessageTree>(path: string): T | undefined;
}

export type TranslationShape<Value> = Value extends string
  ? string
  : Value extends readonly (infer Item)[]
    ? ReadonlyArray<TranslationShape<Item>>
    : Value extends Readonly<Record<string, unknown>>
      ? { readonly [Key in keyof Value]: TranslationShape<Value[Key]> }
      : never;

export type MessagePath<Value> = {
  [Key in keyof Value & string]: Value[Key] extends string
    ? Key
    : Value[Key] extends readonly unknown[]
      ? never
      : Value[Key] extends Readonly<Record<string, unknown>>
        ? `${Key}.${MessagePath<Value[Key]>}`
        : never;
}[keyof Value & string];

export type MessageGroupKey<Value> = {
  [Key in keyof Value & string]: Value[Key] extends Readonly<Record<string, unknown>> ? Key : never;
}[keyof Value & string];

const isMessageTree = (value: unknown): value is MessageTree =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMessageNode = (value: unknown): value is MessageNode => {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isMessageNode);
  return isMessageTree(value) && Object.values(value).every(isMessageNode);
};

export const isMessageCatalog = (value: unknown): value is MessageCatalog =>
  isMessageTree(value) && Object.values(value).every(isMessageNode);

export const messageNodeAtPath = (catalog: MessageCatalog | undefined, path: string): MessageNode | undefined => {
  let value: MessageNode | undefined = catalog;
  for (const segment of path.split(".")) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index)) return undefined;
      value = value[index];
      continue;
    }
    if (!isMessageTree(value)) return undefined;
    value = Object.prototype.hasOwnProperty.call(value, segment) ? value[segment] : undefined;
  }
  return value;
};

export const messageAtPath = (catalog: MessageCatalog | undefined, path: string): string | undefined => {
  const value = messageNodeAtPath(catalog, path);
  return typeof value === "string" ? value : undefined;
};

export const interpolateMessage = (message: string, params?: MessageParams): string => {
  if (!params) return message;
  return message.replace(/\{([^{}]+)\}/gu, (placeholder, key: string) => {
    const value = Array.isArray(params)
      ? params[Number.parseInt(key, 10)]
      : (params as Readonly<Record<string, string | number>>)[key];
    return value === undefined ? placeholder : String(value);
  });
};

export const resolveUiMessageResult = (
  catalogs: MessageCatalogs,
  requested: Locale,
  key: string,
  params?: MessageParams,
): ResolvedMessage => {
  for (const locale of uiLocaleFallbacks(requested)) {
    const message = messageAtPath(catalogs[locale], key);
    if (message !== undefined) {
      const isFallback = locale !== requested;
      return {
        key,
        text: interpolateMessage(message, params),
        requestedLocale: requested,
        sourceLocale: locale,
        lang: languageTagFor(locale),
        script: scriptForLanguageTag(languageTagFor(locale)),
        isFallback,
        fallbackReason: isFallback ? "ui-default" : "none",
      };
    }
  }
  return {
    key,
    text: key,
    requestedLocale: requested,
    sourceLocale: null,
    lang: "und",
    script: "und",
    isFallback: true,
    fallbackReason: "missing",
  };
};

/** Resolve requested UI copy, then Japanese, and finally expose the key. */
export const resolveUiMessage = (
  catalogs: MessageCatalogs,
  requested: Locale,
  key: string,
  params?: MessageParams,
): string => resolveUiMessageResult(catalogs, requested, key, params).text;

export const mergeMessageNodes = (
  fallback: MessageNode | undefined,
  preferred: MessageNode | undefined,
): MessageNode | undefined => {
  if (preferred === undefined) return fallback;
  if (!isMessageTree(fallback) || !isMessageTree(preferred)) return preferred;

  const merged: Record<string, MessageNode> = { ...fallback };
  for (const key of Object.keys(preferred)) {
    const value = mergeMessageNodes(fallback[key], preferred[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};

export const resolveUiCatalog = (catalogs: MessageCatalogs, requested: Locale): MessageCatalog => {
  const fallback = requested === "ja" ? undefined : catalogs.ja;
  const merged = mergeMessageNodes(fallback, catalogs[requested]);
  return isMessageTree(merged) ? merged : {};
};

export const createCatalog = (requested: Locale, catalogs: MessageCatalogs): Catalog => ({
  locale: requested,
  resolve: (key, params) => resolveUiMessageResult(catalogs, requested, key, params),
  text: (key, params, fallback = key) => {
    const result = resolveUiMessageResult(catalogs, requested, key, params);
    return result.fallbackReason === "missing" ? fallback : result.text;
  },
  plural: (key, count, params) => {
    const category = new Intl.PluralRules(languageTagFor(requested)).select(count);
    const values: MessageParams = Array.isArray(params) ? params : { ...(params || {}), count };
    const candidate = resolveUiMessageResult(catalogs, requested, `${key}.${category}`, values);
    return candidate.fallbackReason === "missing"
      ? resolveUiMessageResult(catalogs, requested, key, values)
      : { ...candidate, key };
  },
  has: (key) => uiLocaleFallbacks(requested).some((locale) => messageAtPath(catalogs[locale], key) !== undefined),
  group: <T = MessageTree>(path: string) => resolveUiMessageNode(catalogs, requested, path) as T | undefined,
});

/** Resolve a message subtree while retaining Japanese values for missing leaves. */
export const resolveUiMessageNode = (
  catalogs: MessageCatalogs,
  requested: Locale,
  path: string,
): MessageNode | undefined => {
  const [first, second] = uiLocaleFallbacks(requested);
  const preferred = messageNodeAtPath(first ? catalogs[first] : undefined, path);
  const fallback = second ? messageNodeAtPath(catalogs[second], path) : undefined;
  return mergeMessageNodes(fallback, preferred);
};
