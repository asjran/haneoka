/** Provider projections share standard HTTP input across edge and static builds. */
export interface ProviderSourceReader {
  response(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  json(url: string, init?: RequestInit): Promise<unknown>;
  text(url: string, init?: RequestInit): Promise<string>;
}
export interface ProviderExecutionContext { waitUntil(task: Promise<unknown>): void }
export interface ProviderFetchInit extends RequestInit {
  cf?: { cacheTtl?: number; cacheEverything?: boolean };
}
/** Edge cache options are ignored by standard HTTP clients and retained on Workers. */
export const providerFetch = (input: RequestInfo | URL, init?: ProviderFetchInit): Promise<Response> => fetch(input, init);
export const providerEdgeCache = (): Cache => (caches as CacheStorage & { default: Cache }).default;
