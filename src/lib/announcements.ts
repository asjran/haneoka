import { isLocale, type Locale } from "../i18n/locales";
import { isReleaseServer, type ReleaseServer } from "./resource-route";

/** Current operational data; timestamps are Unix seconds, independent of releases. */
export interface Announcement {
  id: number;
  category: number;
  title: string;
  startAt: number;
  endAt: number;
  updatedAt: number;
  pinned?: boolean;
  bodyImage?: string;
  banner?: string;
  bodyImageWidth?: number;
  bodyImageHeight?: number;
  bannerWidth?: number;
  bannerHeight?: number;
  sourceLanguage?: string;
  html?: string;
}
export interface AnnouncementList {
  server: ReleaseServer;
  available: boolean;
  fetchedAt: string | null;
  announcements: Announcement[];
}
export class AnnouncementRequestError extends Error {
  constructor(readonly status: number) {
    super(`Announcement request failed: ${status}`);
  }
}
export const announcementId = (value: unknown): number | undefined => {
  const id =
    typeof value === "number" ? value : typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};
export function announcementPath(server: ReleaseServer, locale: Locale, id?: number): string {
  if (!isReleaseServer(server) || !isLocale(locale) || (id !== undefined && !announcementId(id)))
    throw new TypeError("Invalid announcement route");
  return `/${server}/${locale}/announcements/${id === undefined ? "" : `${id}/`}`;
}
export function parseAnnouncementRoute(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (!isReleaseServer(parts[0]) || !isLocale(parts[1]) || parts[2] !== "announcements") return undefined;
  if (parts.length === 3) return { server: parts[0], locale: parts[1] };
  const id = announcementId(parts[3]);
  return parts.length === 4 && id ? { server: parts[0], locale: parts[1], id } : undefined;
}
export function announcementLanguage(entry: Announcement, server: ReleaseServer): string {
  try {
    if (entry.sourceLanguage) return Intl.getCanonicalLocales(entry.sourceLanguage)[0] || "und";
  } catch {
    /* Invalid publisher language metadata uses an explicit unknown language. */
  }
  return server === "jp" ? "ja" : "und";
}
export const sortAnnouncements = (entries: readonly Announcement[]): Announcement[] =>
  [...entries].sort(
    (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.startAt - a.startAt || b.id - a.id,
  );
export function announcementDate(seconds: number, locale: string, full = false): string {
  const date = new Date(seconds * 1000);
  if (!seconds || !Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(
    locale,
    full
      ? {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        }
      : { year: "numeric", month: "short", day: "numeric" },
  ).format(date);
}
export const announcementDatetime = (seconds: number): string =>
  seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? new Date(seconds * 1000).toISOString() : "";

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const validAnnouncement = (value: unknown): value is Announcement =>
  record(value) &&
  announcementId(value.id) !== undefined &&
  typeof value.title === "string" &&
  ["category", "startAt", "endAt", "updatedAt"].every(
    (key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
  ) &&
  ["bodyImage", "banner", "sourceLanguage", "html"].every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  ) &&
  (value.pinned === undefined || typeof value.pinned === "boolean");
async function request(path: string, signal: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new AnnouncementRequestError(response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
export async function fetchAnnouncements(server: ReleaseServer, signal: AbortSignal): Promise<AnnouncementList> {
  const value = await request(`/api/v1/announcements?server=${encodeURIComponent(server)}`, signal);
  if (
    !record(value) ||
    value.server !== server ||
    typeof value.available !== "boolean" ||
    (value.fetchedAt !== null && typeof value.fetchedAt !== "string") ||
    !Array.isArray(value.announcements) ||
    value.announcements.length > 100 ||
    !value.announcements.every(validAnnouncement)
  )
    throw new TypeError("Invalid announcement list");
  return value as unknown as AnnouncementList;
}
export async function fetchAnnouncement(server: ReleaseServer, id: number, signal: AbortSignal): Promise<Announcement> {
  const value = await request(`/api/v1/announcements/${id}?server=${encodeURIComponent(server)}`, signal);
  const entry = record(value) && "announcement" in value ? value.announcement : value;
  if (!validAnnouncement(entry) || entry.id !== id || (entry.html !== undefined && typeof entry.html !== "string"))
    throw new TypeError("Invalid announcement detail");
  return entry;
}
