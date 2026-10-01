# `@haneoka/api-client`

Small, host-neutral HTTP infrastructure for Haneoka packages and applications.
It owns URL/query normalization, caller-driven cancellation, JSON content validation and
structured errors. A custom `transport(Request)` can be injected for Workers,
Node gateways, tests, or non-Fetch hosts.

The root entry is host-neutral and has no Vue, Nuxt, Worker or database dependency. The optional `./haneoka` entry adds the public resource API routes.

```ts
import { createApiClient } from "@haneoka/api-client";

const api = createApiClient({ baseUrl: "https://example.test/api/v1" });
const songs = await api.get<Record<string, Song>>("servers/jp/songs");
```

## Current Haneoka catalog client

The `@haneoka/api-client/haneoka` entry is prepared with the current API update. Use its matching local package artifact until that entry is published. It builds resource URLs and validates pagination/batch envelopes; the general root client remains available for your own HTTP services.

```ts
import { createHaneokaClient } from "@haneoka/api-client/haneoka";

const api = createHaneokaClient({ baseUrl: "https://haneoka.org/api/v1/" });
const song = await api.entity("songs", "100070", { server: "intl", locale: "en" });
const page = await api.page("songs", { server: "intl", limit: 20 });
const next = page.nextCursor
  ? await api.page("songs", { server: "intl", limit: 20, cursor: page.nextCursor })
  : null;
const batch = await api.batch("songs", ["100001", "100070"], { server: "intl" });
const imageUrl = api.chartImageUrl("100070", "expert", {
  server: "intl", locale: "en", format: "svg", height: 720, download: false,
});
console.log(song, page.items, next, batch.missing, imageUrl);
```

`servers()` returns active resource-server slugs. `index`, `entity`, `batch`, `page` and `relation` accept an optional `signal` and `decode(value: unknown)` callback. `view` selects a manifest-declared projection for index/entity/batch/page. Default results are JSON values; `decode` performs business DTO validation. `locale` selects a supported UI language while retaining the catalog's localized values, independently of `server`.

Ordinary reads use the current-data aliases and default `server` to `intl`. Advanced `release` selection automatically uses `/servers/{server}/...`. Pass a returned release identifier. Pagination uses limit 1–100 (default 50), and continuation cursors retain the first snapshot. A short or empty page can continue; end only on `nextCursor === null`. Batch accepts 1–100 submitted IDs. Chart image URLs select current data, use SVG/PNG and panel height 360–1440, and return no bytes until your host fetches them.

`ApiClientError` preserves status, method, URL, code, optional request ID, details and retryability. Aborted calls use `request_aborted` and are not retryable. The client does not retry automatically. HTTP failures keep their status even when a gateway returns HTML or malformed JSON. JSON and decoder failures remain distinct from transport errors.

Full examples and current deployment requirements are in the [typed client guide](https://docs.haneoka.org/servers/client/), [catalog guide](https://docs.haneoka.org/servers/catalog/) and [chart image guide](https://docs.haneoka.org/servers/chart-images/).
