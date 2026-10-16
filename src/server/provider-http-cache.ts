import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import CachePolicy from "http-cache-semantics";

interface StoredResponse {
  schema: "haneoka-provider-http-v1";
  url: string;
  method: string;
  status: number;
  sha256: string;
  bytes: number;
  policy: CachePolicy.CachePolicyObject;
  receivedAt: string;
  integrity: string;
}
export interface ProviderHttpCapture {
  status: "network" | "fresh" | "revalidated";
  policySha256: string;
}
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function atomic(file: string, body: string | Uint8Array) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, body, { flag: "wx" });
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function headers(value: CachePolicy.Headers): Headers {
  const result = new Headers();
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result.set(key, Array.isArray(entry) ? entry.join(", ") : entry);
  return result;
}
/** Account for apparent age and transport delay before the policy's resident-time clock. */
function responseMetadata(response: Response, sentAt: number, receivedAt: number): CachePolicy.HttpResponse {
  const result = Object.fromEntries(response.headers);
  const serverDate = Date.parse(result.date || "");
  const apparentAge = Number.isFinite(serverDate) ? Math.max(0, receivedAt - serverDate) : 0;
  const age = /^\d+$/u.test(result.age || "") ? Number(result.age) * 1000 : 0;
  result.age = String(Math.ceil((Math.max(apparentAge, age + receivedAt - sentAt) + Date.now() - receivedAt) / 1000));
  return { status: response.status, headers: result };
}
function reusableFresh(policy: CachePolicy, request: CachePolicy.HttpRequest): boolean {
  if (policy.stale()) return false;
  // 4.2.0 revalidates must-revalidate even before expiry. RFC 9111 applies it
  // once stale; all other policy and request checks remain in the library.
  const serialized = policy.toObject();
  const directives = { ...serialized.rescc };
  delete directives["must-revalidate"];
  return CachePolicy.fromObject({ ...serialized, rescc: directives }).satisfiesWithoutRevalidation(request);
}
/** HTTP freshness is independent from each build's immutable captured-input directory. */
export function createProviderHttpCache(root: string) {
  let integrityError: Error | undefined;
  let requests = 0, fresh = 0, revalidated = 0;
  const indexFile = (key: string) => path.join(root, "urls", key.slice(0, 2), `${key}.json`);
  const bodyFile = (hash: string) => path.join(root, "bodies", hash.slice(0, 2), hash);
  function invalid(message: string): never { integrityError = new Error(message); throw integrityError; }
  function load(key: string, url: string, method: string): { record: StoredResponse; body: Buffer; policy: CachePolicy } | undefined {
    const file = indexFile(key);
    if (!fs.existsSync(file)) return undefined;
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as StoredResponse;
      const { integrity, ...record } = stored;
      if (record.schema !== "haneoka-provider-http-v1" || record.url !== url || record.method !== method || sha(JSON.stringify(record)) !== integrity || !/^[a-f0-9]{64}$/u.test(record.sha256)) invalid(`Provider HTTP metadata mismatch ${url}`);
      const body = fs.readFileSync(bodyFile(record.sha256));
      if (body.length !== record.bytes || sha(body) !== record.sha256) invalid(`Provider HTTP body mismatch ${url}`);
      return { record: stored, body, policy: CachePolicy.fromObject(record.policy) };
    } catch (error) { invalid(`Invalid provider HTTP cache ${url}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  function result(record: Omit<StoredResponse, "integrity">, body: Buffer, policy: CachePolicy, status: ProviderHttpCapture["status"]) {
    const responseHeaders = headers(policy.responseHeaders());
    // Native fetch has decoded the stored representation already.
    responseHeaders.delete("content-encoding"); responseHeaders.delete("content-length"); responseHeaders.delete("transfer-encoding");
    return {
      response: new Response(record.method === "HEAD" || [204, 205, 304].includes(record.status) ? null : new Uint8Array(body), { status: record.status, headers: responseHeaders }),
      capture: { status, policySha256: sha(JSON.stringify(policy.toObject())) } satisfies ProviderHttpCapture,
    };
  }
  return {
    assertConsistent() { if (integrityError) throw integrityError; },
    report() { return { requests, fresh, revalidated }; },
    async get(input: RequestInfo | URL, init?: RequestInit) {
      const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!requestHeaders.has("accept")) requestHeaders.set("accept", "*/*");
      if (!requestHeaders.has("accept-encoding")) requestHeaders.set("accept-encoding", "gzip, deflate, br");
      if (!requestHeaders.has("user-agent")) requestHeaders.set("user-agent", "HaneokaProviderBuild/1.0 (+https://haneoka.org/)");
      const request = new Request(input, { ...init, headers: requestHeaders });
      const { url, method } = request;
      if (method !== "GET" && method !== "HEAD") throw new TypeError("Provider HTTP cache accepts GET/HEAD");
      const key = sha(`${method}\u0000${url}`);
      const old = load(key, url, method);
      const original: CachePolicy.HttpRequest = { url, method, headers: Object.fromEntries(request.headers) };
      if (old && reusableFresh(old.policy, original)) {
        fresh++;
        return result(old.record, old.body, old.policy, "fresh");
      }
      let upstreamHeaders = old ? headers(old.policy.revalidationHeaders(original)) : request.headers;
      let sentAt = Date.now(); requests++;
      let response = await fetch(request, { headers: upstreamHeaders });
      let receivedAt = Date.now();
      let policy: CachePolicy, body: Buffer, status: number, capture: ProviderHttpCapture["status"] = "network";
      if (response.status === 304 && old) {
        const metadata = responseMetadata(response, sentAt, receivedAt);
        const verified = old.policy.revalidatedPolicy({ ...original, headers: Object.fromEntries(upstreamHeaders) }, metadata);
        if (verified.matches && !verified.modified && (upstreamHeaders.has("if-none-match") || upstreamHeaders.has("if-modified-since"))) {
          body = old.body; status = old.record.status;
          policy = new CachePolicy(original, { status, headers: { ...old.record.policy.resh, ...metadata.headers } }, { shared: true, cacheHeuristic: 0, immutableMinTimeToLive: 0 });
          capture = "revalidated"; revalidated++;
        } else {
          upstreamHeaders = new Headers(request.headers); upstreamHeaders.delete("if-none-match"); upstreamHeaders.delete("if-modified-since");
          sentAt = Date.now(); requests++;
          response = await fetch(request, { headers: upstreamHeaders }); receivedAt = Date.now();
          if (response.status === 304) throw new Error(`Unconditional provider response was 304: ${url}`);
          body = Buffer.from(await response.arrayBuffer()); status = response.status;
          policy = new CachePolicy(original, responseMetadata(response, sentAt, receivedAt), { shared: true, cacheHeuristic: 0, immutableMinTimeToLive: 0 });
        }
      } else {
        if (response.status === 304) throw new Error(`Provider returned 304 without a verified body: ${url}`);
        body = Buffer.from(await response.arrayBuffer()); status = response.status;
        policy = new CachePolicy(original, responseMetadata(response, sentAt, receivedAt), { shared: true, cacheHeuristic: 0, immutableMinTimeToLive: 0 });
      }
      const record: Omit<StoredResponse, "integrity"> = { schema: "haneoka-provider-http-v1", url, method, status, sha256: sha(body), bytes: body.length, policy: policy.toObject(), receivedAt: new Date(receivedAt).toISOString() };
      if ([200, 404, 410].includes(status) && policy.storable() && response.url === url) {
        if (fs.existsSync(bodyFile(record.sha256))) {
          const existing = fs.readFileSync(bodyFile(record.sha256));
          if (existing.length !== record.bytes || sha(existing) !== record.sha256) invalid(`Provider HTTP body mismatch ${url}`);
        } else atomic(bodyFile(record.sha256), body);
        atomic(indexFile(key), JSON.stringify({ ...record, integrity: sha(JSON.stringify(record)) }));
      } else if (status < 500 && fs.existsSync(indexFile(key))) fs.unlinkSync(indexFile(key));
      return result(record, body, policy, capture);
    },
  };
}
