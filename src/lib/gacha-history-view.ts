export interface GachaHistoryAccount {
  key: string;
  server: string;
  serverLabel: string;
  label: string;
}
export interface GachaHistoryPool {
  id: string;
  name: string;
  category: string;
}
export interface GachaHistoryPrize {
  id: string;
  kind: "member" | "support" | "item" | "unknown";
  name: string;
  rarity: string | number;
  rarityLabel: string;
  quantity: number;
  imageUrl?: string;
  href?: string;
  pickup?: boolean | null;
}
export interface GachaHistoryBatch {
  id: string;
  accountKey: string;
  poolId: string;
  pulledAt: string | null;
  drawCount: number | null;
  prizes: readonly GachaHistoryPrize[];
  source?: string;
  cost?: GachaHistoryCost;
}
export interface GachaHistoryExportDetail {
  accountKey: string;
  batches: readonly GachaHistoryBatch[];
}
export interface GachaHistoryEvents {
  "gacha-catalog-retry": CustomEvent<void>;
  "gacha-open-app": CustomEvent<void>;
  "gacha-account-change": CustomEvent<{ accountKey: string }>;
  "gacha-import": CustomEvent<void>;
  "gacha-import-source": CustomEvent<{ source: GachaHistoryImportSource }>;
  "gacha-refresh": CustomEvent<{ accountKey: string }>;
  "gacha-export": CustomEvent<GachaHistoryExportDetail>;
  "gacha-conversion-change": CustomEvent<GachaHistoryConversion>;
  "gacha-export-image": CustomEvent<{ files: readonly GachaHistoryImageFile[] }>;
}

export interface GachaHistoryCost {
  freeGems?: number;
  paidGems?: number;
  tickets?: number;
}
export interface GachaHistoryConversion {
  currencyCode: string;
  unitGemPrice: number | null;
}
export interface GachaHistoryImageFile {
  blob: Blob;
  filename: string;
}

export type GachaHistoryImportSource = "files" | "adb" | "saved";
