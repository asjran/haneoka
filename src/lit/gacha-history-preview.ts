import type { GachaTargetProgress } from "@haneoka/game-data-exporter/gacha-history-points";
import type { GachaHistory } from "./gacha-history";
import type { GachaHistoryPageData } from "../server/gacha-history-page-data";
import type { GachaHistoryPrize, GachaHistoryBatch, GachaHistoryPool } from "../lib/gacha-history-view";
import { historyObject, historyDefaultGemConversion } from "../lib/gacha-history-data";
import { localizedText } from "./shared/catalog";
import { clientText } from "../i18n/client";

export function mountGachaHistoryPreview(view: GachaHistory, page: GachaHistoryPageData) {
  const catalog = page.variants.intl ?? page.variants.jp;
  const t = (key: string) => clientText(view.locale, `catalog.gachaHistory.${key}`, "");
  const mark = (name: string) => {
    const value = catalog.marks?.[name];
    return typeof value === "string" ? `/runtime/intl/${value.replace(/^runtime\//u, "")}` : undefined;
  };
  const cards: GachaHistoryPrize[] = [];
  for (const [kind, source] of [
    ["member", catalog.cards],
    ["support", catalog.supports],
  ] as const) {
    for (const [id, value] of Object.entries(source)) {
      const card = historyObject(value);
      const rarity = Number(card.rarity);
      if (![2, 3, 4, 10, 20].includes(rarity)) continue;
      const rarityLabel = { 2: "R", 3: "SR", 4: "SSR", 10: "EX", 20: "BD" }[rarity]!;
      const image = historyObject(card.images).thumbnail ?? card.image;
      cards.push({
        id,
        kind,
        name: localizedText(card.prefix ?? card.cardName ?? card.name, view.locale),
        rarity,
        rarityLabel,
        quantity: 1,
        imageUrl: typeof image === "string" ? image : undefined,
        href: `/intl/${view.locale}/${kind === "member" ? "member-cards" : "support-cards"}/${id}/`,
        attributeImageUrl: mark(
          `CardType-${["", "Red", "Blue", "Green", "Yellow", "Purple"][Number(card.cardType)]}.png`,
        ),
        rarityImageUrl: mark(`RarityIconCenter_${rarityLabel}.png`),
      });
    }
  }
  const pools: GachaHistoryPool[] = [1, 2, 3].map((id) => ({
    id: `preview-pool-${id}`,
    name: `${t("simulatedData")} · ${t("pool")} ${id}`,
    category: t("simulatedData"),
    imageUrl: String(
      historyObject(Object.values(catalog.pools)[id - 1]).logo ??
        historyObject(Object.values(catalog.pools)[id - 1]).image ??
        "",
    ),
  }));
  const exchangeTarget = (
    pool: GachaHistoryPool,
    kind: "member" | "support",
    cardId: string,
    cost: number,
    balance: number | null,
    needed: number | null,
    draws: number | null,
    redeemed: number | null,
    remaining: number | null,
  ): GachaTargetProgress => {
    const card = cards.find((card) => card.kind === kind && card.id === cardId)!;
    return {
      gachaId: pool.id,
      exchangeId: `simulation-${pool.id}`,
      exchangeProductId: `${pool.id}-${kind}-${cardId}`,
      gachaProductId: `${pool.id}-single`,
      supported: true,
      basePointCost: cost,
      pointCost: cost,
      pointBalance: balance,
      pointsNeeded: needed,
      pointGain: 1,
      productUsesNeeded: draws,
      additionalDrawsNeeded: draws,
      limitCount: redeemed != null && remaining != null ? redeemed + remaining : 2,
      resetType: 1,
      recordedExchangeCount: redeemed,
      counterResetType: redeemed == null ? null : 1,
      counterUpdatedAt: redeemed == null ? null : "2026-10-16T12:00:00Z",
      redeemedCount: redeemed,
      redeemedQuantity: redeemed,
      remainingExchangeLimit: remaining,
      exchangeStartAt: null,
      exchangeEndAt: null,
      startAt: null,
      endAt: null,
      reward: {
        kind: kind === "member" ? "MemberCard" : "SupportCard",
        resourceType: kind === "member" ? 2 : 3,
        resourceId: Number(card.id),
        count: 1,
        name: card.name,
        rarity: card.rarity,
        image: card.imageUrl,
        href: card.href,
        attributeImageUrl: card.attributeImageUrl,
        rarityImageUrl: card.rarityImageUrl,
      },
    };
  };
  pools[0].exchangeTargets = [
    exchangeTarget(pools[0], "member", "52", 200, 150, 50, 50, 1, 1),
    exchangeTarget(pools[0], "support", "51", 100, 150, 0, 0, 0, 1),
  ];
  pools[1].exchangeTargets = [
    exchangeTarget(pools[1], "member", "52", 200, null, null, null, null, null),
    exchangeTarget(pools[1], "support", "51", 100, null, null, null, null, null),
  ];
  pools[2].exchangeTargets = [
    exchangeTarget(pools[2], "member", "52", 200, 80, 120, 120, 0, 2),
    exchangeTarget(pools[2], "member", "53", 200, 80, 120, 120, 2, 0),
  ];

  const batches: GachaHistoryBatch[] = [];
  for (let day = 0; day < 12; day++) {
    for (let pool = 0; pool < pools.length; pool++) {
      const prizes = Array.from({ length: 10 }, (_, draw) => {
        const kind = (draw + day) % 3 === 0 ? "support" : "member";
        const rarity = draw === 0 && day % (pool + 1) === 0 ? 4 : draw === 9 ? 3 : 2;
        const matches = cards.filter((card) => card.kind === kind && Number(card.rarity) === rarity);
        const card = matches[(rarity >= 4 ? day % 3 : day + draw) % matches.length] ?? cards[0];
        return {
          ...card,
          pickup: draw === 0 && pool === 0,
          converted: day > 3 && draw % 4 === 0,
        };
      });
      batches.push({
        id: `preview-${day}-${pool}`,
        accountKey: "ui-preview",
        poolId: pools[pool].id,
        pulledAt: new Date(Date.UTC(2026, 9, 5 + day, 9 + pool)).toISOString(),
        drawCount: 10,
        prizes,
        cost: { freeGems: pool === 0 ? 3000 : 0, paidGems: pool === 1 ? 1500 : 0, tickets: pool === 2 ? 10 : 0 },
        expected: { high: 0.6, memberSsr: 0.3, supportSsr: 0.3, pickup: 0.2 },
      });
    }
  }
  view.accounts = [{ key: "ui-preview", server: "intl", serverLabel: "", label: t("simulatedData") }];
  view.pools = pools;
  view.batches = batches;
  view.selectedAccountKey = "ui-preview";
  view.historyLoaded = true;
  view.cloudSignedIn = new URL(location.href).searchParams.get("cloudPreview") !== "signed-out";
  view.cloudLinked = false;
  view.addEventListener("gacha-cloud-link", (event) => {
    view.cloudLinked = (event as CustomEvent).detail.linked;
  });
  view.addEventListener("gacha-cloud-sync", () => {
    view.cloudBusy = true;
    setTimeout(() => {
      view.cloudBusy = false;
    }, 300);
  });
  view.addEventListener("gacha-cloud-refresh", () => {
    view.cloudRefreshPending = true;
  });
  view.canImport = false;
  view.canRefresh = false;
  view.showAppLink = false;
  view.currencyConversion = historyDefaultGemConversion(catalog, "TWD");
  view.addEventListener("gacha-account-change", (event) => {
    view.selectedAccountKey = (event as CustomEvent<{ accountKey: string }>).detail.accountKey;
  });
  const conversions = new Map([[view.currencyConversion.currencyCode, view.currencyConversion]]);
  view.addEventListener("gacha-conversion-change", (event) => {
    const next = (event as CustomEvent).detail;
    if (view.currencyConversion) conversions.set(view.currencyConversion.currencyCode, view.currencyConversion);
    const value =
      view.currencyConversion?.currencyCode !== next.currencyCode
        ? (conversions.get(next.currencyCode) ?? historyDefaultGemConversion(catalog, next.currencyCode))
        : next;
    conversions.set(value.currencyCode, value);
    view.currencyConversion = value;
  });
}
