import type { DataContext } from "./types.js";

export class EmbedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`Request failed with HTTP ${status}: ${url}`);
    this.name = "EmbedHttpError";
  }
}

export function absoluteUrl(value: string | URL, base?: string): string {
  const url = new URL(String(value), base);
  if (!["http:", "https:", "blob:", "data:"].includes(url.protocol)) {
    throw new TypeError(`Unsupported resource URL protocol: ${url.protocol}`);
  }
  return url.href;
}

export function directoryUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
    throw new TypeError("assetsBase must be an absolute HTTP(S) directory URL without query or fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export async function readBytes(
  response: Response,
  context: DataContext,
  checkStatus = true,
): Promise<Uint8Array<ArrayBuffer>> {
  context.signal.throwIfAborted();
  if (checkStatus && !response.ok) {
    await response.body?.cancel();
    throw new EmbedHttpError(response.status, response.url);
  }
  const length = Number(response.headers.get("content-length"));
  const total =
    response.headers.has("content-length") &&
    !response.headers.has("content-encoding") &&
    Number.isSafeInteger(length) &&
    length >= 0
      ? length
      : undefined;
  if (total !== undefined && total > context.maxBytes) {
    await response.body?.cancel();
    throw new RangeError(`Response exceeds maxBytes (${context.maxBytes})`);
  }
  if (!response.body) {
    context.progress({ loaded: 0, ...(total === undefined ? {} : { total }) });
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const abort = () => {
    void reader.cancel(context.signal.reason).catch(() => {});
  };
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const item = await reader.read();
      context.signal.throwIfAborted();
      if (item.done) break;
      loaded += item.value.byteLength;
      if (loaded > context.maxBytes) throw new RangeError(`Response exceeds maxBytes (${context.maxBytes})`);
      chunks.push(item.value);
      context.progress({ loaded, ...(total === undefined ? {} : { total }) });
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    context.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function readJson<T>(response: Response, context: DataContext, decode: (value: unknown) => T): Promise<T> {
  const bytes = await readBytes(response, context);
  context.signal.throwIfAborted();
  return decode(JSON.parse(new TextDecoder().decode(bytes)));
}
