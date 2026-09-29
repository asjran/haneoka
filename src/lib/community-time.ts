export type CommunityRecord = Record<string, unknown>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

/** Convert the timestamp formats used by the community API to milliseconds. */
export const communityTimestamp = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 1e12 ? value * 1_000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    const milliseconds = Math.abs(numeric) < 1e12 ? numeric * 1_000 : numeric;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The API's lastEditedAt field is a SQL fallback for unedited records. A
 * version change is authoritative; otherwise require a strictly later time
 * so a createdAt/default timestamp alias cannot produce a false edit marker.
 */
export const isEdited = (record: CommunityRecord): boolean => {
  const version = Number(record.version);
  if (Number.isFinite(version) && version >= 2) return true;
  const createdAt = communityTimestamp(record.createdAt);
  const lastEditedAt = communityTimestamp(record.lastEditedAt);
  return createdAt !== null && lastEditedAt !== null && lastEditedAt > createdAt;
};

export interface CommunityTime {
  text: string;
  dateTime: string;
  title: string;
}

const relativeUnit = (deltaMs: number): { value: number; unit: Intl.RelativeTimeFormatUnit } => {
  const seconds = deltaMs / 1_000;
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds >= 86_400) return { value: Math.round(seconds / 86_400), unit: "day" };
  if (absoluteSeconds >= 3_600) return { value: Math.round(seconds / 3_600), unit: "hour" };
  if (absoluteSeconds >= 60) return { value: Math.round(seconds / 60), unit: "minute" };
  return { value: Math.round(seconds), unit: "second" };
};

/**
 * Format nearby community timestamps relatively for one week, then with a
 * precise local date/time. Intl defaults keep the absolute value in the
 * visitor's timezone. The ISO value is suitable for the time element.
 */
export const formatCommunityTime = (value: unknown, locale: string, now = Date.now()): CommunityTime | null => {
  const timestamp = communityTimestamp(value);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const exact = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(date);
  const delta = timestamp - now;
  const relative = relativeUnit(delta);
  const text =
    Math.abs(delta) < WEEK_MS
      ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(relative.value, relative.unit)
      : exact;
  return { text, dateTime: date.toISOString(), title: exact };
};
