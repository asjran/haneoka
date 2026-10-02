import type { Inventory, InventoryKind, MemberEntry, SnapshotEntry } from "../inventory";

type Entry = MemberEntry | SnapshotEntry;
export interface InventoryCardConflict {
  key: string;
  kind: InventoryKind;
  cardId: number;
  choices: Entry[];
}
export interface InventoryUniquenessPreview {
  original: Inventory;
  candidate: Inventory;
  merged: { kind: InventoryKind; cardId: number; removedInstanceIds: string[] }[];
  conflicts: InventoryCardConflict[];
  changed: boolean;
  canApply: boolean;
}
/** Internal IDs do not make a second owned card. Whole practice/flag records must agree. */
export const sameOwnedCardState = (a: Entry, b: Entry) =>
  JSON.stringify(
    Object.entries(a)
      .filter(([key]) => key !== "instanceId")
      .sort(([a], [b]) => a.localeCompare(b)),
  ) ===
  JSON.stringify(
    Object.entries(b)
      .filter(([key]) => key !== "instanceId")
      .sort(([a], [b]) => a.localeCompare(b)),
  );

export function previewInventoryUniqueness(inventory: Inventory): InventoryUniquenessPreview {
  const original = structuredClone(inventory),
    candidate = structuredClone(inventory);
  const merged: InventoryUniquenessPreview["merged"] = [],
    conflicts: InventoryCardConflict[] = [];
  for (const kind of ["members", "snapshots"] as const) {
    const groups = new Map<number, Entry[]>();
    for (const entry of original[kind]) {
      const group = groups.get(entry.cardId);
      if (group) group.push(entry);
      else groups.set(entry.cardId, [entry]);
    }
    const entries: Entry[] = [];
    for (const [cardId, group] of groups) {
      const first = group[0]!;
      entries.push({ ...first });
      if (group.length < 2) continue;
      merged.push({ kind, cardId, removedInstanceIds: group.slice(1).map((entry) => entry.instanceId) });
      if (group.some((entry) => !sameOwnedCardState(first, entry)))
        conflicts.push({ key: `${kind}:${cardId}`, kind, cardId, choices: group.map((entry) => ({ ...entry })) });
    }
    if (kind === "members") candidate.members = entries as MemberEntry[];
    else candidate.snapshots = entries as SnapshotEntry[];
  }
  return { original, candidate, merged, conflicts, changed: merged.length > 0, canApply: conflicts.length === 0 };
}
export function applyInventoryUniqueness(
  preview: InventoryUniquenessPreview,
  choices: Record<string, string> = {},
): Inventory {
  const candidate = structuredClone(preview.candidate);
  for (const conflict of preview.conflicts) {
    const selected = conflict.choices.find((entry) => entry.instanceId === choices[conflict.key]);
    if (!selected) throw new Error(`Inventory card choice required:${conflict.key}`);
    const entry = candidate[conflict.kind].find((entry) => entry.cardId === conflict.cardId)!;
    // Keep the existing stable UI/solver ID; choose one complete observed state, never per-field maxima.
    Object.assign(entry, selected, { instanceId: entry.instanceId });
  }
  return candidate;
}
export class InventoryUniquenessError extends Error {
  readonly preview: InventoryUniquenessPreview;
  readonly local?: { storageKey: string; ownerId: string | null; baseRevision: number };
  constructor(
    preview: InventoryUniquenessPreview,
    local?: { storageKey: string; ownerId: string | null; baseRevision: number },
  ) {
    super("Inventory card uniqueness needs confirmation");
    this.preview = preview;
    this.local = local;
  }
}
export class InventoryCardMergeConflictError extends Error {
  readonly conflicts: { key: string; kind: InventoryKind; cardId: number; cloud: Entry; draft: Entry }[];
  constructor(conflicts: { key: string; kind: InventoryKind; cardId: number; cloud: Entry; draft: Entry }[]) {
    super("Inventory card merge needs a choice");
    this.conflicts = conflicts;
  }
}
