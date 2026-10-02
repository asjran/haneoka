export interface NativeMetaIdentity {
  server: string;
  releaseId: string;
  sourceId: string;
}

export interface NativeMetaPublication extends NativeMetaIdentity {
  schema: "haneoka-meta-reference-publish-receipt-v1";
  published: true;
  dryRun: false;
  key: string;
  recipeSHA256: string;
  requestSHA256: string;
  sha256: string;
  bytes: number;
}

const MAX_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function nativeMetaIdentity(value: unknown): NativeMetaIdentity | undefined {
  const row = record(value);
  return typeof row.server === "string" &&
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(row.server) &&
    typeof row.releaseId === "string" &&
    /^r-[a-f0-9]{20}$/u.test(row.releaseId) &&
    typeof row.sourceId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.sourceId)
    ? { server: row.server, releaseId: row.releaseId, sourceId: row.sourceId }
    : undefined;
}

export function nativeMetaPublication(value: unknown): NativeMetaPublication | undefined {
  const row = record(value),
    identity = nativeMetaIdentity(row);
  if (
    !identity ||
    row.schema !== "haneoka-meta-reference-publish-receipt-v1" ||
    row.published !== true ||
    row.dryRun !== false ||
    typeof row.recipeSHA256 !== "string" ||
    !SHA256.test(row.recipeSHA256) ||
    typeof row.requestSHA256 !== "string" ||
    !SHA256.test(row.requestSHA256) ||
    typeof row.sha256 !== "string" ||
    !SHA256.test(row.sha256) ||
    !Number.isSafeInteger(row.bytes) ||
    Number(row.bytes) < 1 ||
    Number(row.bytes) > MAX_BYTES ||
    row.key !==
      `servers/${identity.server}/meta-reference/${identity.releaseId}/${row.recipeSHA256}/${row.requestSHA256}/reference.json`
  )
    return undefined;
  return {
    ...identity,
    schema: "haneoka-meta-reference-publish-receipt-v1",
    published: true,
    dryRun: false,
    key: row.key as string,
    recipeSHA256: row.recipeSHA256,
    requestSHA256: row.requestSHA256,
    sha256: row.sha256,
    bytes: Number(row.bytes),
  };
}

export function sameNativeMetaIdentity(value: unknown, expected: NativeMetaIdentity): boolean {
  const row = nativeMetaIdentity(value);
  return Boolean(
    row && row.server === expected.server && row.releaseId === expected.releaseId && row.sourceId === expected.sourceId,
  );
}

/** Read T29's immutable object and verify its original UTF-8 bytes; no score calculation. */
export async function fetchNativeMetaSidecar(
  publication: NativeMetaPublication,
  expected: NativeMetaIdentity,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const receipt = nativeMetaPublication(publication);
  if (!receipt || !sameNativeMetaIdentity(receipt, expected)) throw new Error("native-meta-publication-pin");
  signal?.throwIfAborted();
  const url = `/api/v1/meta-reference/${receipt.server}/${receipt.releaseId}/${receipt.recipeSHA256}/${receipt.requestSHA256}`;
  const response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal });
  if (
    response.status !== 200 ||
    !response.body ||
    response.headers.get("x-haneoka-release-id") !== expected.releaseId ||
    response.headers.get("x-haneoka-source-id") !== expected.sourceId ||
    response.headers.get("x-haneoka-recipe-sha256") !== receipt.recipeSHA256 ||
    response.headers.get("x-haneoka-request-sha256") !== receipt.requestSHA256 ||
    response.headers.get("x-haneoka-content-sha256") !== receipt.sha256 ||
    !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") || "")
  ) {
    await response.body?.cancel();
    throw new Error("native-meta-response-identity");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > receipt.bytes) throw new Error("native-meta-response-size");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (length !== receipt.bytes) throw new Error("native-meta-response-size");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  signal?.throwIfAborted();
  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  if (hash !== receipt.sha256) throw new Error("native-meta-response-sha256");
  const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const row = record(document),
    published = record(row.publication),
    recipe = record(published.recipe);
  if (
    row.schema !== "haneoka-meta-reference-v1" ||
    !sameNativeMetaIdentity(row.identity, expected) ||
    published.schema !== "haneoka-meta-reference-publication-v1" ||
    published.recipeSHA256 !== receipt.recipeSHA256 ||
    published.requestSHA256 !== receipt.requestSHA256 ||
    recipe.schema !== "haneoka-team-reference-recipe-v1" ||
    recipe.id !== "normal-baseline-explicit-v1" ||
    record(recipe.metadata).version !== 1
  )
    throw new Error("native-meta-document-identity");
  return document;
}
