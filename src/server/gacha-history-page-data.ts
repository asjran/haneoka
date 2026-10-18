import { fetchStaticCatalog, staticCatalogRelease } from "../lib/static-catalog-source";
import { historyObject, type HistoryCatalogData } from "../lib/gacha-history-data";

export interface GachaHistoryPageData {
  schema: "haneoka-gacha-history-page-v1";
  variants: Record<string, HistoryCatalogData>;
}
let pending: Promise<GachaHistoryPageData> | undefined;
/** The same pinned public catalog is embedded for all five locale pages. */
export function gachaHistoryPageData(): Promise<GachaHistoryPageData> {
  return (pending ??= (async () => {
    const entries = await Promise.all(
      ["intl", "jp"].map(async (server) => {
        const identity = await staticCatalogRelease(server);
        const [gachaValue, cards, supports, itemValue] = await Promise.all(
          ["gacha", "cards", "support-cards", "items"].map((resource) =>
            fetchStaticCatalog(resource, server, identity),
          ),
        );
        const gacha = historyObject(gachaValue);
        return [
          server,
          {
            metadata: historyObject(gacha.history),
            pools: historyObject(gacha.entries),
            cards: historyObject(cards),
            supports: historyObject(supports),
            items: historyObject(historyObject(itemValue).items),
          },
        ] as const;
      }),
    );
    return { schema: "haneoka-gacha-history-page-v1", variants: Object.fromEntries(entries) };
  })());
}
