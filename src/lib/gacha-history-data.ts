import type { GachaHistoryBatch, GachaHistoryPool, GachaHistoryPrize } from "./gacha-history-view";
import { localizedText } from "../lit/shared/catalog";
import { resourcePath } from "./resource-route";

export const HISTORY_SCHEMA = "haneoka-gacha-history-v1";
export const HISTORY_BYTES = 16 * 1024 * 1024;
export const HISTORY_REGIONS = ["jp", "global-hmt", "global-en", "global-kr"] as const;
export type HistoryRegion = (typeof HISTORY_REGIONS)[number];
export interface HistoryPrize {
  prizeId: string;
  converted: boolean;
}
export interface HistoryExecution {
  poolId: string | null;
  productId: string | null;
  executedAt: number | null;
  freeGems: number | null;
  paidGems: number | null;
  tickets: number | null;
  prizes: HistoryPrize[];
}
export interface HistorySnapshot {
  schema: typeof HISTORY_SCHEMA;
  source: { server: HistoryRegion; clientVersion: string };
  queriedAt: string;
  historyKind: string;
  legacyOmittedCount: number;
  coverage: { scope: string; retentionDays: null; orderWithinBatch: null };
  batches: HistoryExecution[];
}
export const historyObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
function amount(value: unknown, maximum = 2147483647): number | null {
  if (value == null) return null;
  const result = typeof value === "number" ? value : /^\d+$/u.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new Error("history_import_invalid");
  return result;
}
function id(value: unknown, nullable = false): string | null {
  if (value == null && nullable) return null;
  const text = String(value);
  if (!/^[1-9][0-9]{0,18}$/u.test(text) || BigInt(text) > 9223372036854775807n)
    throw new Error("history_import_invalid");
  return text;
}
/** Projects the portable contract; credentials and unrelated save fields never enter history storage. */
export function parseHistory(value: unknown): HistorySnapshot {
  const root = historyObject(value),
    source = historyObject(root.source),
    coverage = historyObject(root.coverage);
  if (root.schema !== HISTORY_SCHEMA && !(root.format === "otonote-gacha-history" && root.schemaVersion === 1))
    throw new Error("history_import_invalid");
  const server = source.server ?? source.serverId;
  if (
    !(HISTORY_REGIONS as readonly unknown[]).includes(server) ||
    !Array.isArray(root.batches) ||
    root.batches.length > 100000
  )
    throw new Error("history_import_invalid");
  if (typeof root.queriedAt !== "string" || !Number.isFinite(Date.parse(root.queriedAt)))
    throw new Error("history_import_invalid");
  let count = 0;
  const batches = root.batches.map((value): HistoryExecution => {
    const row = historyObject(value);
    if (!Array.isArray(row.prizes) || !row.prizes.length) throw new Error("history_import_invalid");
    return {
      poolId: id(row.poolId, true),
      productId: id(row.productId, true),
      executedAt: amount(row.executedAt, 253402271999),
      freeGems: amount(row.freeGems),
      paidGems: amount(row.paidGems),
      tickets: amount(row.tickets),
      prizes: row.prizes.map((value): HistoryPrize => {
        const prize = historyObject(value);
        if (++count > 250000 || typeof prize.converted !== "boolean") throw new Error("history_import_invalid");
        return { prizeId: id(prize.prizeId)!, converted: prize.converted };
      }),
    };
  });
  return {
    schema: HISTORY_SCHEMA,
    source: { server: server as HistoryRegion, clientVersion: String(source.clientVersion ?? "").slice(0, 32) },
    queriedAt: new Date(root.queriedAt).toISOString(),
    historyKind: String(root.historyKind ?? coverage.historyKind ?? "execution").slice(0, 32),
    legacyOmittedCount: amount(root.legacyOmittedCount ?? coverage.legacyOmittedCount) ?? 0,
    coverage: {
      scope: ["server-returned", "local-collected", "selected-records"].includes(String(coverage.scope))
        ? String(coverage.scope)
        : "server-returned",
      retentionDays: null,
      orderWithinBatch: null,
    },
    batches,
  };
}
export interface HistoryCatalogData {
  metadata: Record<string, unknown>;
  pools: Record<string, unknown>;
  cards: Record<string, unknown>;
  supports: Record<string, unknown>;
  items: Record<string, unknown>;
}

/** Union snapshots of one known account, preserving repeated identical draws. */
export function mergeHistory(newer: HistorySnapshot, older: HistorySnapshot): HistorySnapshot {
  if (newer.source.server !== older.source.server) throw new Error("history_import_invalid");
  if (!newer.batches.length && older.batches.length)
    return {
      ...newer,
      batches: older.batches,
      historyKind: older.historyKind,
      coverage: { ...newer.coverage, scope: "local-collected" },
    };
  if (newer.historyKind !== older.historyKind) return newer;
  const identity = (row: HistoryExecution) =>
    JSON.stringify([
      row.poolId,
      row.productId,
      row.executedAt,
      row.freeGems,
      row.paidGems,
      row.tickets,
      row.prizes.map((prize) => `${prize.prizeId}:${prize.converted}`).sort(),
    ]);
  const remaining = new Map<string, number>(),
    batches = [...newer.batches];
  for (const row of newer.batches) remaining.set(identity(row), (remaining.get(identity(row)) ?? 0) + 1);
  for (const row of older.batches) {
    const key = identity(row),
      count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1);
    else batches.push(row);
  }
  return batches.length === newer.batches.length
    ? newer
    : { ...newer, batches, coverage: { ...newer.coverage, scope: "local-collected" } };
}
export function historyPoolViews(
  catalog: HistoryCatalogData,
  locale: string,
  categoryLabel: (key: string) => string,
): GachaHistoryPool[] {
  return Object.entries(catalog.pools).map(([id, value]) => {
    const row = historyObject(value);
    return { id, name: localizedText(row.title, locale), category: categoryLabel(String(row.category ?? "other")) };
  });
}
export function historyBatchViews(
  snapshot: HistorySnapshot,
  accountKey: string,
  catalog: HistoryCatalogData | undefined,
  locale: string,
  unknown: string,
): GachaHistoryBatch[] {
  const prizeMap = historyObject(catalog?.metadata.prizes),
    poolMap = historyObject(catalog?.metadata.pools);
  const server = snapshot.source.server === "jp" ? "jp" : "intl";
  return snapshot.batches.map((batch, index) => ({
    id: `${snapshot.queriedAt}:${index}`,
    accountKey,
    poolId: batch.poolId ?? "",
    pulledAt: batch.executedAt === null ? null : new Date(batch.executedAt * 1000).toISOString(),
    drawCount: batch.prizes.length,
    cost: {
      freeGems: batch.freeGems ?? undefined,
      paidGems: batch.paidGems ?? undefined,
      tickets: batch.tickets ?? undefined,
    },
    source: snapshot.source.server,
    prizes: batch.prizes.map((prize): GachaHistoryPrize => {
      const row = historyObject(prizeMap[prize.prizeId]),
        type = row.resourceType,
        id = String(row.resourceId ?? "");
      const kind = type === 2 ? "member" : type === 3 ? "support" : type === 1 ? "item" : "unknown";
      const card = historyObject(
        (type === 2 ? catalog?.cards : type === 3 ? catalog?.supports : type === 1 ? catalog?.items : undefined)?.[id],
      );
      const image = historyObject(card.images).thumbnail ?? card.image;
      const pool = historyObject(poolMap[batch.poolId ?? ""]),
        groups = pool.prizeGroupIds;
      const rarity = typeof card.rarity === "number" || typeof card.rarity === "string" ? card.rarity : "";
      return {
        id: id || `prize:${prize.prizeId}`,
        kind,
        name: Object.keys(card).length
          ? localizedText(card.prefix ?? card.cardName ?? card.name, locale)
          : `${unknown} · ${prize.prizeId}`,
        rarity,
        rarityLabel:
          type === 1
            ? ""
            : (({ 2: "R", 3: "SR", 4: "SSR", 10: "EX", 20: "BD" } as Record<string, string>)[rarity] ?? unknown),
        quantity: typeof row.count === "number" && Number.isSafeInteger(row.count) && row.count > 0 ? row.count : 1,
        imageUrl: typeof image === "string" && image ? image : undefined,
        href:
          type === 2 || type === 3
            ? resourcePath({
                server,
                locale: locale as Parameters<typeof resourcePath>[0]["locale"],
                kind: type === 2 ? "member-cards" : "support-cards",
                id,
              })
            : undefined,
        pickup: Array.isArray(groups) && groups.includes(row.groupId) ? row.pickupType === 2 : null,
      };
    }),
  }));
}
