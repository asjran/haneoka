import type { GachaHistoryBatch, GachaHistoryPool, GachaHistoryPrize } from "./gacha-history-view";
import { localizedText } from "../lit/shared/catalog";
import { resourcePath } from "./resource-route";

import { historyObject, type HistorySnapshot } from "@haneoka/game-data-exporter/gacha-history";

export * from "@haneoka/game-data-exporter/gacha-history";

export interface HistoryCatalogData {
  metadata: Record<string, unknown>;
  pools: Record<string, unknown>;
  cards: Record<string, unknown>;
  supports: Record<string, unknown>;
  items: Record<string, unknown>;
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
