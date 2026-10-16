import { TEXT_LOCALES } from "./localized-text";

export interface Mission extends Record<string, unknown> {
  id: string;
  kind?: string;
  category?: number;
  groupId?: number;
  groupCategory?: number;
  releaseDay?: number;
  priority?: number;
  goal?: number;
  image?: string;
  imageVariants?: Record<string, unknown>;
  rewards?: Record<string, unknown>[];
}

export interface MissionGroup {
  key: string;
  category: number;
  releaseDay: number;
  timed: boolean;
  window: { start: number; end: number };
  rows: Mission[];
}

// App.Master.MissionCategory; order follows the authored mission tab labels.
export const MISSION_CATEGORY_ORDER = [1, 2, 4, 5, 15, 16, 6, 11, 12, 8, 3, 7, 10, 13, 14, 9, 0];

export function missionTimestamp(value: unknown, locale: string): number {
  const index = TEXT_LOCALES.indexOf(locale as (typeof TEXT_LOCALES)[number]);
  return Number(Array.isArray(value) ? (value[index] ?? value[0]) : value) || 0;
}

export function missionCategory(mission: Mission): number {
  if (mission.groupCategory) return mission.groupCategory;
  if (mission.category !== undefined) return mission.category;
  // Older regular-mission projections encode category × 100,000,000 + sequence.
  const id = /^regular-mission-(\d+)$/u.exec(mission.id)?.[1];
  return id ? Math.floor(Number(id) / 100_000_000) : 0;
}

export function missionGroupStatus(group: MissionGroup, now: number): "ongoing" | "upcoming" | "ended" {
  if (group.window.end && group.window.end <= now) return "ended";
  if (group.window.start > now) return "upcoming";
  return "ongoing";
}

export function groupMissions(missions: Mission[], locale: string): MissionGroup[] {
  const groups = new Map<string, MissionGroup>();
  for (const mission of missions) {
    const category = missionCategory(mission);
    const releaseDay = category === 5 ? Number(mission.releaseDay || 0) : 0;
    const start = missionTimestamp(mission.startAt, locale);
    const end = missionTimestamp(mission.endAt, locale);
    const timed = [2, 3, 10, 13, 14].includes(category) || end > 0;
    const window = timed ? { start, end } : { start: 0, end: 0 };
    const key =
      timed || category === 5
        ? [category, mission.kind, mission.groupId || 0, window.start, window.end, releaseDay].join(":")
        : String(category);
    const group = groups.get(key);
    if (group) group.rows.push(mission);
    else groups.set(key, { key, category, releaseDay, timed, window, rows: [mission] });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      rows: group.rows.sort(
        (a, b) =>
          Number(a.priority || 0) - Number(b.priority || 0) || a.id.localeCompare(b.id, "en", { numeric: true }),
      ),
    }))
    .sort(
      (a, b) =>
        MISSION_CATEGORY_ORDER.indexOf(a.category) - MISSION_CATEGORY_ORDER.indexOf(b.category) ||
        a.releaseDay - b.releaseDay ||
        b.window.start - a.window.start ||
        a.key.localeCompare(b.key),
    );
}
