import type { ReleaseIdentity, TeamAssignment } from "./contracts";
import { dataRows, nativeRow, type TeamBuilderData } from "./data";

export interface MemberEntry {
  instanceId: string;
  cardId: number;
  level: number | null;
  training: number | null;
  awakening: number | null;
  liveSkillLevel: number | null;
  gekisoSkillLevel: number | null;
  locked: boolean;
  excluded: boolean;
}
export interface SnapshotEntry {
  instanceId: string;
  cardId: number;
  level: number | null;
  awakening: number | null;
  locked: boolean;
  excluded: boolean;
}
export interface InventoryV1 extends ReleaseIdentity {
  schema: "haneoka-team-inventory-v1";
  members: MemberEntry[];
  snapshots: SnapshotEntry[];
  bandItems: Record<string, number | null>;
  characterRanks: Record<string, number | null>;
  bandRanks: Record<string, number | null>;
}
export interface InventoryIssue {
  path: string;
  code: string;
  values?: number[];
}
export type InventoryKind = "members" | "snapshots";
export const MAX_INVENTORY_ENTRIES = 5000;
const MEMBER_FIELDS = ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"] as const;
const SNAPSHOT_FIELDS = ["level", "awakening"] as const;
const rangeCache = new WeakMap<TeamBuilderData, Map<string, Record<string, number[]>>>();
const values = (rows: Record<string, unknown>[], key: string) =>
  [...new Set(rows.map((row) => Number(row[key])))].filter(Number.isFinite).sort((a, b) => a - b);

export function createEmptyInventory(identity: ReleaseIdentity): InventoryV1 {
  return {
    schema: "haneoka-team-inventory-v1",
    server: identity.server,
    releaseId: identity.releaseId,
    members: [],
    snapshots: [],
    bandItems: {},
    characterRanks: {},
    bandRanks: {},
  };
}
export function addInventoryEntry(
  inventory: InventoryV1,
  kind: InventoryKind,
  cardId: number,
  instanceId: string = crypto.randomUUID(),
): InventoryV1 {
  const flags = { instanceId, cardId, locked: false, excluded: false };
  return kind === "members"
    ? {
        ...inventory,
        members: [
          ...inventory.members,
          { ...flags, level: null, training: null, awakening: null, liveSkillLevel: null, gekisoSkillLevel: null },
        ],
      }
    : { ...inventory, snapshots: [...inventory.snapshots, { ...flags, level: null, awakening: null }] };
}
export function updateInventoryEntries(
  inventory: InventoryV1,
  kind: InventoryKind,
  ids: readonly string[],
  patch: Partial<MemberEntry | SnapshotEntry>,
): InventoryV1 {
  const allowed = new Set<string>([...(kind === "members" ? MEMBER_FIELDS : SNAPSHOT_FIELDS), "locked", "excluded"]);
  const clean = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key)));
  const selected = new Set(ids);
  return {
    ...inventory,
    [kind]: inventory[kind].map((entry) => (selected.has(entry.instanceId) ? { ...entry, ...clean } : entry)),
  };
}
export function removeInventoryEntry(inventory: InventoryV1, kind: InventoryKind, id: string): InventoryV1 {
  return { ...inventory, [kind]: inventory[kind].filter((entry) => entry.instanceId !== id) };
}

export function practiceRanges(
  data: TeamBuilderData,
  kind: InventoryKind,
  cardId: number,
  state?: Partial<MemberEntry | SnapshotEntry>,
): Record<string, number[]> {
  const support = kind === "snapshots";
  const card = support ? data.snapshots[String(cardId)] : data.members[String(cardId)];
  if (!card) return {};
  let cache = rangeCache.get(data);
  if (!cache) {
    cache = new Map();
    rangeCache.set(data, cache);
  }
  const key = `${kind}/${cardId}/${(state as Partial<MemberEntry> | undefined)?.training ?? "?"}/${state?.awakening ?? "?"}`;
  const cached = cache.get(key);
  if (cached) return Object.fromEntries(Object.entries(cached).map(([field, values]) => [field, [...values]]));
  const progression = data.progression;
  const ranks = (progression[support ? "supportCardRanks" : "memberCardRanks"] || []).filter(
    (row) => Number(row.group) === card.awakeningGroup,
  );
  const levels = (progression[support ? "supportCardLevels" : "memberCardLevels"] || []).filter(
    (row) => Number(row.group) === card.levelGroup,
  );
  const ranges: Record<string, number[]> = { awakening: values(ranks, "rank"), level: values(levels, "level") };
  let cap: number | undefined;
  if (support) cap = Number(ranks.find((row) => Number(row.rank) === state?.awakening)?.limitLevel);
  else {
    const member = data.members[String(cardId)];
    if (!member) return {};
    ranges.training = values(
      (progression.memberCardAwake || []).filter((row) => Number(row.group) === member.trainingGroup),
      "awakeCount",
    );
    const training = (state as Partial<MemberEntry> | undefined)?.training;
    cap = Number(
      (progression.memberCardLevelLimits || []).find(
        (row) => Number(row.rarity) === member.rarity && Number(row.awakeCount) === training,
      )?.limitLevel,
    );
    for (const [field, group, skillId] of [
      ["liveSkillLevel", "live", member.liveSkillId],
      ["gekisoSkillLevel", "gekiso", member.gekisoSkillId],
    ] as const) {
      ranges[field] =
        skillId > 0 ? values(dataRows(data.skills[group]?.[String(skillId)]?.effects).map(nativeRow), "level") : [];
    }
  }
  if (Number.isFinite(cap) && cap! > 0) ranges.level = (ranges.level || []).filter((level) => level <= cap!);
  if (cache.size < 4096)
    cache.set(key, Object.fromEntries(Object.entries(ranges).map(([field, values]) => [field, [...values]])));
  return ranges;
}

/** Unknown practice is editable; requirePractice turns it into a solver input error. */
export function validateInventory(
  value: unknown,
  data: TeamBuilderData,
  options: { requirePractice?: boolean; allowDifferentRelease?: boolean } = {},
): { valid: boolean; issues: InventoryIssue[] } {
  const issues: InventoryIssue[] = [];
  const problem = (path: string, code: string, allowed?: number[]) =>
    issues.push({ path, code, ...(allowed ? { values: allowed } : {}) });
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { valid: false, issues: [{ path: "", code: "invalid-document" }] };
  const inventory = value as InventoryV1;
  const rootKeys = new Set([
    "schema",
    "server",
    "releaseId",
    "members",
    "snapshots",
    "bandItems",
    "characterRanks",
    "bandRanks",
  ]);
  for (const field of Object.keys(inventory)) if (!rootKeys.has(field)) problem(field, "unknown-field");
  if (inventory.schema !== "haneoka-team-inventory-v1") problem("schema", "unsupported-schema");
  if (inventory.server !== data.identity.server) problem("server", "different-server");
  if (
    typeof inventory.releaseId !== "string" ||
    (!options.allowDifferentRelease && inventory.releaseId !== data.identity.releaseId)
  )
    problem("releaseId", "different-release");
  const seen = new Set<string>();
  for (const kind of ["members", "snapshots"] as const) {
    if (!Array.isArray(inventory[kind]) || inventory[kind].length > MAX_INVENTORY_ENTRIES) {
      problem(kind, "invalid-entry-list");
      continue;
    }
    inventory[kind].forEach((entry, index) => {
      const path = `${kind}.${index}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        problem(path, "invalid-entry");
        return;
      }
      const fields = kind === "members" ? MEMBER_FIELDS : SNAPSHOT_FIELDS;
      const allowedKeys = new Set<string>(["instanceId", "cardId", "locked", "excluded", ...fields]);
      for (const field of Object.keys(entry)) if (!allowedKeys.has(field)) problem(`${path}.${field}`, "unknown-field");
      if (
        typeof entry.instanceId !== "string" ||
        !entry.instanceId ||
        entry.instanceId.length > 128 ||
        seen.has(entry.instanceId)
      )
        problem(`${path}.instanceId`, "invalid-or-duplicate-instance");
      else seen.add(entry.instanceId);
      const card = (kind === "members" ? data.members : data.snapshots)[String(entry.cardId)];
      if (!Number.isSafeInteger(entry.cardId) || !card) problem(`${path}.cardId`, "unknown-card");
      if (typeof entry.locked !== "boolean" || typeof entry.excluded !== "boolean" || (entry.locked && entry.excluded))
        problem(path, "invalid-flags");
      const ranges = practiceRanges(data, kind, entry.cardId, entry);
      for (const field of kind === "members" ? MEMBER_FIELDS : SNAPSHOT_FIELDS) {
        const number = (entry as unknown as Record<string, unknown>)[field];
        if (number === null) {
          if (options.requirePractice) problem(`${path}.${field}`, "unknown-practice");
          continue;
        }
        if (!Number.isSafeInteger(number) || !ranges[field]?.includes(number as number))
          problem(`${path}.${field}`, "out-of-range", ranges[field] || []);
      }
      if (options.requirePractice && kind === "members" && (entry as MemberEntry).training === null)
        problem(`${path}.level`, "unknown-level-cap");
      if (options.requirePractice && kind === "snapshots" && entry.awakening === null)
        problem(`${path}.level`, "unknown-level-cap");
    });
  }
  for (const field of ["bandItems", "characterRanks", "bandRanks"] as const) {
    const map = inventory[field];
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      problem(field, "invalid-level-map");
      continue;
    }
    if (Object.keys(map).length > 2048) {
      problem(field, "too-many-levels");
      continue;
    }
    for (const [id, level] of Object.entries(map)) {
      const record =
        field === "bandItems" ? data.bandItems[id] : field === "characterRanks" ? data.characters[id] : data.bands[id];
      if (!/^[1-9]\d*$/u.test(id) || !record) {
        problem(`${field}.${id}`, "unknown-entity");
        continue;
      }
      const allowed =
        field === "bandItems"
          ? values(dataRows(record.levels).map(nativeRow), "level")
          : values(data.progression[field] || [], "rank");
      if (level === null) {
        if (options.requirePractice) problem(`${field}.${id}`, "unknown-practice");
      } else if (!Number.isSafeInteger(level) || !allowed.includes(level))
        problem(`${field}.${id}`, "out-of-range", allowed);
    }
  }
  return { valid: issues.length === 0, issues };
}

/** Instance uniqueness is established; native equip/character restrictions are reported separately by the solver. */
export function validateAssignment(assignment: TeamAssignment, inventory: InventoryV1): InventoryIssue[] {
  const issues: InventoryIssue[] = [];
  const members = new Map(inventory.members.map((entry) => [entry.instanceId, entry]));
  const snapshots = new Map(inventory.snapshots.map((entry) => [entry.instanceId, entry]));
  if (assignment.snapshotInstanceIds.length !== assignment.memberInstanceIds.length)
    issues.push({ path: "assignment", code: "slot-count-mismatch" });
  const used = new Set<string>();
  const slots = [
    ...assignment.memberInstanceIds.map((id) => ({ id, entry: members.get(id) })),
    ...assignment.snapshotInstanceIds
      .filter((id): id is string => id !== null)
      .map((id) => ({ id, entry: snapshots.get(id) })),
  ];
  for (const { id, entry } of slots) {
    if (!entry || entry.excluded || used.has(id))
      issues.push({ path: id, code: "missing-excluded-or-reused-instance" });
    used.add(id);
  }
  if (!assignment.memberInstanceIds.includes(assignment.leaderInstanceId))
    issues.push({ path: "leaderInstanceId", code: "leader-not-in-team" });
  for (const entry of [...inventory.members, ...inventory.snapshots])
    if (entry.locked && !used.has(entry.instanceId))
      issues.push({ path: entry.instanceId, code: "locked-instance-missing" });
  return issues;
}
