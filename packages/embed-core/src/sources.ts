import { absoluteUrl, readJson } from "./io.js";
import type { DataSource, ResourceResolver } from "./types.js";

export function memoryDataSource<T>(data: T): DataSource<T> {
  return { load: () => data };
}

export function httpDataSource<T = unknown>(options: {
  readonly url: string | URL;
  readonly decode?: (value: unknown) => T;
}): DataSource<T> {
  const url = absoluteUrl(options.url);
  if (!/^https?:/u.test(url)) throw new TypeError("httpDataSource requires an absolute HTTP(S) URL");
  return {
    assetsBase: new URL(".", url).href,
    async load(context) {
      return readJson(
        await context.fetcher(new Request(url, { signal: context.signal })),
        context,
        options.decode ?? ((value) => value as T),
      );
    },
  };
}

/** A File from an input or a Blob supplied by a desktop/Node host. */
export function fileDataSource<T = unknown>(
  file: Blob,
  decode: (value: unknown) => T = (value) => value as T,
): DataSource<T> {
  return { load: (context) => readJson(new Response(file), context, decode) };
}

/** Literal Unicode project paths; the loader owns and revokes generated URLs. */
export function fileResourceResolver(files: ReadonlyMap<string, Blob>): ResourceResolver {
  return (key) => {
    const file = files.get(key);
    if (!file) throw new Error(`Missing local resource: ${key}`);
    return file;
  };
}
