# @haneoka/bestdori

Browser-neutral Bestdori data contracts and converters.

`@haneoka/bestdori/cache-policy` exports the small, shared freshness windows
used by browser and Worker hosts. It is only a set of pure policy values: hosts
still own their transport, edge cache, and in-memory cache implementations.

```ts
import { convertBestdoriScenario } from "@haneoka/bestdori/scenario";

const result = convertBestdoriScenario(source, {
  server: "jp",
  voiceBundle: "sound/voice/scenario/bandstory1_rip/",
  proxify: (path) => `/api/v1/garupa/bestdori/jp/raw${path}`,
});
```

Chart conversion is exposed separately so an application can keep the generic
chart runtime independent from Bestdori's wire format:

```ts
import { bestdoriChartToSs } from "@haneoka/bestdori/chart";

const score = bestdoriChartToSs(await transport.getChart(songId, difficulty));
```

The converter maps Bestdori's lanes `0..6` onto a 24-unit SS stage with
6-unit notes starting at `0, 3, 6, 9, 12, 15, 18`. Fractional slide lanes
scale linearly by 3; directional flicks cover the mapped span
from their leftmost to rightmost source lane. `BESTDORI_SS_LANE_BASIS`
exports the stage width for importers.

Applications provide their own transport by implementing `BestdoriTransport`.

Altair authoring support is provided by the independent
`@haneoka/altair-plugin-bestdori` package. This package exposes only neutral
scenario and transport contracts and has no editor dependency.

Cubism 2 conversion keeps standard `.moc` and texture references in `runtime`.
Model placement and scene camera data are preserved separately.
