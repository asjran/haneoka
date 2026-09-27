import type { UiLocale } from "./locales.js";
import type { Catalog, MessageCatalog } from "./messages.js";

/** DOM-free signal shape so the package remains usable in workers and Node. */
export interface I18nSignal {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

export type Namespace = string;

export interface CatalogSource {
  load(locale: UiLocale, namespace: Namespace, signal: I18nSignal): Promise<MessageCatalog>;
}

export interface CatalogEnsureOptions {
  readonly signal?: I18nSignal;
  readonly version?: string;
}

export interface CatalogStore {
  ensure(locale: UiLocale, namespaces: readonly Namespace[], options?: CatalogEnsureOptions): Promise<Catalog>;
  current(): Catalog;
  subscribe(listener: (catalog: Catalog) => void): () => void;
}

export interface I18nSeed {
  readonly version: string;
  readonly locale: UiLocale;
  readonly namespaces: Readonly<Record<Namespace, MessageCatalog>>;
  /** Namespaces required for the route that produced this document. */
  readonly requiredNamespaces?: readonly Namespace[];
  /** Only fallback leaves absent from the requested locale, retaining source metadata. */
  readonly fallbacks?: Readonly<Record<Namespace, MessageCatalog>>;
}
