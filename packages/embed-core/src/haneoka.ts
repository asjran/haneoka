import { createHaneokaClient, type HaneokaJson } from "@haneoka/api-client/haneoka";
import { ApiClientError } from "@haneoka/api-client";
import { directoryUrl, readBytes } from "./io.js";
import type { DataSource } from "./types.js";

export interface HaneokaDataSourceOptions<T> {
  /** Absolute /api/v1 directory; defaults to the public Haneoka API. */
  readonly apiBase?: string;
  readonly resource: string;
  readonly id?: string;
  readonly view?: string;
  readonly decode?: (value: unknown) => T;
}

/** Reads the current public catalog without asking consumers for a release. */
export function haneokaDataSource<T = HaneokaJson>(options: HaneokaDataSourceOptions<T>): DataSource<T> {
  const apiBase = directoryUrl(options.apiBase ?? "https://haneoka.org/api/v1/");
  return {
    assetsBase: new URL("/", apiBase).href,
    async load(context) {
      const client = createHaneokaClient({
        baseUrl: apiBase,
        transport: async (request) => {
          const headers = new Headers(request.headers);
          headers.set("Accept-Language", context.locale);
          const response = await context.fetcher(new Request(request, { headers }));
          // Bound both successful and error bodies, retaining typed API errors.
          let bytes: Uint8Array<ArrayBuffer>;
          try {
            bytes = await readBytes(response, context, false);
          } catch (cause) {
            if (!(cause instanceof RangeError)) throw cause;
            throw new ApiClientError({
              cause,
              code: "response_too_large",
              message: cause.message,
              method: request.method,
              status: response.status,
              url: request.url,
            });
          }
          return new Response(bytes, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      });
      const scope = {
        server: context.server ?? "intl",
        signal: context.signal,
        ...(options.view === undefined ? {} : { view: options.view }),
        ...(options.decode === undefined ? {} : { decode: options.decode }),
      };
      return options.id === undefined
        ? client.index<T>(options.resource, scope)
        : client.entity<T>(options.resource, options.id, scope);
    },
  };
}
