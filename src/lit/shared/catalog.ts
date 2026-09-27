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
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
