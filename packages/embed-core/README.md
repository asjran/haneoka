# @haneoka/embed-core

Load data and resource URLs for an embedded story, chart, or scene. The package provides a shared data layer for standalone hosts, browser applications, workers, and Node.js. It exports native ESM and TypeScript declarations. Importing it does not create elements, access `window` or `document`, start requests, or initialize a renderer.

## Distribution status

This `0.1.0` embed is prepared in source and local release artifacts. Registry publication and an official hosted ESM URL are pending. Use matching local tarballs for the embed and its rendering peers, or bundle them for your own static host/CDN. See the [embedding guide](https://docs.haneoka.org/embed/) for the build and script-module workflow.

## Installation

```sh
npm install @haneoka/embed-core
```

For the Haneoka public catalog adapter, also install its optional peer:

```sh
npm install @haneoka/api-client
```

The main entry has no runtime dependencies. `@haneoka/embed-core/haneoka` uses the public `@haneoka/api-client/haneoka` entry. Both packages use the browser Fetch API or the Fetch API provided by Node.js 20 and later. Serve browser modules through your bundler or an import map that resolves these package names to their ESM files.

## Read Haneoka's current data

```js
import { createEmbedLoader } from "@haneoka/embed-core";
import { haneokaDataSource } from "@haneoka/embed-core/haneoka";

const loader = createEmbedLoader({
  source: haneokaDataSource({ resource: "songs", id: "100070" }),
  server: "intl",
  locale: "en",
});

try {
  const song = await loader.load();
  console.log(song.musicTitle);
  // Use the resource URL supplied by the returned entity.
  const jacket = await loader.resourceUrl(song.jacketUrl);
  console.log(jacket);
} finally {
  await loader.dispose();
}
```

The adapter reads `/api/v1/{resource}/{id}?server={server}`. Omit `id` to read a collection index, or provide `view` to read an API collection view. The server chooses its current release for each data request; a release identifier and an account are unnecessary. Entity asset paths already identify their published resources. Use those paths as returned. Repeated `load()` calls request current data again.

`server` selects the data registry and defaults to `intl` for this adapter. `locale` defaults to `en` and is sent as `Accept-Language`; the API selects a supported response language. Catalog values retain their localized fields. The loader itself preserves your locale string and leaves text selection to the consuming host. Changing `locale` does not change the resource server.

For another Haneoka deployment, pass an absolute `apiBase`, such as `https://archive.example/api/v1/`. Relative asset paths resolve against that deployment's origin. `assetsBase` on the loader overrides this default when your resources live on another origin. The API adapter returns the entity or index payload, preserving the public client's validation and `ApiClientError` details.

## Load your own data and resources

Pass any authored data structure to `memoryDataSource`. A story host can accept its own story format, a chart host its chart format, and a scene host its scene format. The loader returns your data unchanged and by reference. Language fields and resource keys remain yours.

```js
import { createEmbedLoader, memoryDataSource } from "@haneoka/embed-core";

const authored = {
  language: "fr",
  title: "Une promenade",
  background: "背景/夕暮れ.png",
  lines: [{ speaker: "Alice", text: "Bonsoir !" }],
};

const loader = createEmbedLoader({
  source: memoryDataSource(authored),
  locale: authored.language,
  assetsBase: "https://cdn.example/projects/promenade/",
  resolveResource: (key) => key,
});

try {
  const data = await loader.load();
  const backgroundUrl = await loader.resourceUrl(data.background);
  // Pass data and the resource methods to your chosen story host.
  console.log(data.title, backgroundUrl);
} finally {
  await loader.dispose();
}
```

An HTTP JSON document uses the same consumer methods:

```js
import { createEmbedLoader, httpDataSource } from "@haneoka/embed-core";

const loader = createEmbedLoader({
  source: httpDataSource({
    url: "https://author.example/projects/promenade/story.json",
    decode(value) {
      if (!value || typeof value !== "object" || !Array.isArray(value.lines)) {
        throw new TypeError("Expected a story with lines");
      }
      return value;
    },
  }),
  locale: "fr",
});

try {
  const story = await loader.load();
  console.log(story.lines);
} finally {
  await loader.dispose();
}
```

The HTTP source resolves relative resources against the configured document URL's directory. A redirect does not change that directory. Provide `assetsBase` when your document describes another resource directory. `decode` validates or converts JSON for the actual consuming host; without it, HTTP and file sources return `unknown` in TypeScript. A generic type parameter describes your expected value, while a decoder performs runtime validation.

## Local files

`fileDataSource` accepts a browser `File`, a `Blob`, or a Blob constructed by a desktop host from bytes. A local JSON file has no implied network asset directory. Supply a resource map with the project's literal paths:

```js
import { createEmbedLoader, fileDataSource, fileResourceResolver } from "@haneoka/embed-core";

// Files obtained from your file picker or desktop host:
const createProjectLoader = (projectFile, backgroundFile) =>
  createEmbedLoader({
    source: fileDataSource(projectFile),
    locale: "fr",
    resolveResource: fileResourceResolver(new Map([["背景/夕暮れ.png", backgroundFile]])),
  });
```

Map lookup uses the exact Unicode key. `resourceBytes(key)` reads the Blob directly. `resourceUrl(key)` creates one URL per Blob and reuses it until disposal. Destroy the consuming media elements or renderer before disposing the loader; disposal revokes these URLs. URLs created by your own code remain your responsibility.

## Resource and transport options

`resourceUrl(key)` resolves a key and returns a usable URL. `resourceBytes(key)` resolves it and reads bytes with the loader's transport, cancellation, progress, and byte limit. An asynchronous `resolveResource(key, context)` can return a string, `URL`, or `Blob`. It receives the locale, optional server, signal, and configured fetcher. A resolver replaces the key mapping completely; missing local-map keys reject instead of falling through to the network.

Absolute URLs keep their origin. Relative strings use `assetsBase`; a leading `/` resolves from its origin root. `assetsBase` is an absolute HTTP(S) directory URL; the loader adds a trailing slash. Queries and fragments belong on resource URLs, rather than on the base. Supported resolved protocols are HTTP, HTTPS, Blob, and data URLs. Relative paths need an asset base even during SSR; the loader never guesses the current page's address.

```js
const loader = createEmbedLoader({
  source: memoryDataSource({ title: "Example" }),
  assetsBase: "https://cdn.example/project/",
  credentials: "omit",
  fetcher: (request) => fetch(request),
  maxBytes: 64 * 1024 * 1024,
});
```

`fetcher` receives a `Request` carrying `mode: 'cors'`, the cancellation signal, configured headers, and credentials. The default is native `fetch` with `credentials: 'omit'`. Choose `same-origin` or `include` for a service that requires cookies. Explicit headers are sent as configured; pass authentication headers only to the origins that should receive them. The fetcher also lets a desktop host implement its own transport.

Cross-origin API and resource servers must permit your application's origin through CORS. Cookie-based cross-origin requests require explicit origin and credentials permission from the server. Custom headers may require a preflight. A resolved URL later passed to an image, audio, or video element uses that element's own loading and CORS settings; it does not invoke this fetcher. See [MDN's credentials reference](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials) and [CORS guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

## Progress, errors, cancellation, and disposal

```js
const unsubscribe = loader.subscribe((event) => {
  if (event.type === "progress") {
    console.log(event.key, event.loaded, event.total);
  }
});
const controller = new AbortController();

try {
  const data = await loader.load({ signal: controller.signal });
  console.log(data);
} finally {
  unsubscribe();
  await loader.dispose();
}
```

Each load or resource call emits `start`, followed by byte `progress` events when bytes are read, then `ready`, `error`, or `cancelled`. `operation` identifies concurrent calls, and `key` is `$data` for the document or the resource key for resources. Progress measures decoded bytes for that operation. `total` is absent for unknown or encoded response lengths; memory loads and URL resolution do not emit byte progress. Connect these events to your host's loading indicator. `maxBytes` limits each JSON document or byte load and defaults to 64 MiB. A resolved URL alone does not download the resource.

HTTP sources reject non-success status with `EmbedHttpError`, exposing `status` and `url`. JSON parse failures, decoder failures, missing local files, byte-limit failures, and transport failures reject their operation. Haneoka API failures preserve `ApiClientError`. Listener failures go to optional `onListenerError` and do not change data operation results.

Abort a supplied controller to cancel that call, or call `loader.cancel()` to cancel all current calls. Cancellation rejects promptly even if a custom source ignores its signal; custom sources should use `context.signal` to stop their own work. Later calls remain available after `cancel()`. Concurrent calls are independent, with no automatic retries or shared data cache.

`dispose()` immediately prevents new calls, aborts current operations, revokes its Blob URLs, emits `disposed`, removes listeners, and invokes the source's optional cleanup once. Its shared promise resolves after cleanup; cleanup failures reject that promise. Call it after the consuming host has released its resource references. An owned custom source should be used by one loader when its cleanup releases resources.

## Custom data sources

Implement `DataSource<T>` when the data comes from another format or an existing application service:

```ts
import { createEmbedLoader, type DataSource } from "@haneoka/embed-core";

type Document = { title: string };
const source: DataSource<Document> = {
  async load(context) {
    context.signal.throwIfAborted();
    return { title: `A document in ${context.locale}` };
  },
};
const loader = createEmbedLoader({ source, locale: "pt-BR" });
```

Use the resulting data with the specific host's supported format. Resource methods supply URLs and bytes; playback controls, rendering, and GPU resource ownership belong to that host.
