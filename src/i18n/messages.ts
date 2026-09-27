import type { MessageCatalog, MessageParams, UiLocale } from "@haneoka/i18n";
import { serverGroup, serverText } from "./server";
import type { Locale } from "./locales";

/**
 * Compatibility facade for existing server callers. Translation values live
 * only in public/i18n; this module owns no catalog and has no mutable locale.
 */
export function t(locale: Locale, path: string, fallback = path): string {
  return serverText(locale as UiLocale, path, undefined, fallback);
}

export function group<T = Record<string, unknown>>(locale: Locale, path: string): T {
  return serverGroup<T>(locale as UiLocale, path);
}

export type { MessageCatalog, MessageParams };
