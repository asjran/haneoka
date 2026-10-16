export type CatalogProvider = "bestdori" | "sekai";
const regions: Record<string, string> = { "zh-TW": "tw", "zh-CN": "cn", ko: "kr", en: "en" };
export const providerRegionForLocale = (locale: string): string => regions[locale] || "jp";
export const providerCatalogBase = (provider: CatalogProvider, locale: string): string =>
  `/api/v1/${provider === "sekai" ? "sekai" : "garupa/bestdori"}/${providerRegionForLocale(locale)}`;

export interface ProviderCollectionPayload {
  schema: "haneoka-provider-collection-v1";
  provider: CatalogProvider;
  locale: string;
  resource: string;
  document: Record<string, unknown>;
  bands: unknown;
  characters: unknown;
  songMeta?: Record<string, unknown>;
}
