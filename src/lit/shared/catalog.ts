import { clientText, getI18nClient } from "../../i18n/client";
import { resolveLocalizedText } from "../../lib/localized-text";
import { readReleaseServer } from "../../lib/release-server";

export type JsonRecord = Record<string, unknown>;
export const UI_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;

export function preferredLocale(fallback = "ja"): string {
  const committed = getI18nClient()?.committed;
  if (committed) return committed;
  let stored = "";
  try {
    stored = localStorage.getItem("haneoka.locale") || "";
  } catch {
    // The document bootstrap remains authoritative when storage is unavailable.
  }
  const value = (typeof document === "undefined" ? "" : document.documentElement.dataset.locale) || stored || fallback;
  return (UI_LOCALES as readonly string[]).includes(value) ? value : fallback;
}

/** Compatibility signature; resolution is owned by the central public catalog. */
export function uiText(locale: string, key: string): string {
  return clientText(locale, key, key);
}

export function formatList(
  values: unknown[],
  locale: string,
  type: Intl.ListFormatOptions["type"] = "conjunction",
): string {
  const items = values.map((value) => String(value || "").trim()).filter(Boolean);
  if (items.length < 2) return items[0] || "";
  try {
    return new Intl.ListFormat(locale, { style: "long", type }).format(items);
  } catch {
    return items.join(", ");
  }
}

export function readPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as JsonRecord)[key] : undefined), value);
}

export function recordValues(value: unknown): JsonRecord[] {
  return value && typeof value === "object"
    ? Object.values(value as JsonRecord).filter((item): item is JsonRecord => !!item && typeof item === "object")
    : [];
}

export function localizedText(value: unknown, locale: string): string {
  return resolveLocalizedText(value, locale).text;
}

export function currentReleaseServer(): string {
  return readReleaseServer();
}

export function catalogUrl(resource: string, id = "", server = currentReleaseServer()): string {
  const path = resource.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/v1/servers/${encodeURIComponent(server)}/${path}${id ? `/${encodeURIComponent(id)}` : ""}${!id && ["stories", "songs"].includes(resource) ? "?projection=4" : ""}`;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const controller = new AbortController();
  const source = init?.signal;
  const abort = () => controller.abort(source?.reason);
  if (source?.aborted) abort();
  else source?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetDeadline = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new DOMException(uiText(preferredLocale(), "requestTimedOut"), "TimeoutError")),
      30_000,
    );
  };
  resetDeadline();
  try {
    const response = await fetch(url, { ...init, headers, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) return (await response.json()) as T;
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        resetDeadline();
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(text) as T;
  } catch (error) {
    // WebKit may replace the supplied abort reason with a generic fetch error.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    source?.removeEventListener("abort", abort);
  }
}
