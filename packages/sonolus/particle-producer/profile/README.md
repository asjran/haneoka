# Cassiopeia Our Notes plugin

`@haneoka/cassiopeia-plugin-our-notes` converts the original Our Notes SS score
format into Cassiopeia's normalized chart, creates renderer-neutral
`RenderFrame` objects, provides the native note/effect/skin asset contract, and
selects source-game haptics and title presentation metadata.

It owns source normalization and presentation policy. Cassiopeia still owns
timing and judgement; the Three renderer owns WebGL; the browser host owns the
music clock, pointer events, and sound playback.

## Build from a clean Git workspace

Link the unpublished kernel peer from a local Git workspace:

```sh
mkdir our-notes-rules-workspace
cd our-notes-rules-workspace
git clone https://github.com/haneoka-gakuen/cassiopeia.git packages/cassiopeia
git clone https://github.com/haneoka-gakuen/cassiopeia-plugin-our-notes.git packages/our-notes
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
linkWorkspacePackages: true
```

Then install and build:

```sh
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install
pnpm --filter @haneoka/cassiopeia build
pnpm --filter @haneoka/cassiopeia-plugin-our-notes check
```

Use Node 24 or newer for the current package workspace.

## Smallest complete conversion and session

The plugin accepts SS-shaped source data through `OUR_NOTES_RULES.parse`. The
example creates one tap at tick 480 (500 ms at 120 BPM), simulates a play-mode
tap, and builds a renderer-neutral frame:

```ts
import {
  CASSIOPEIA_SESSION,
  CassiopeiaRuntime,
  createKernelPlugin
} from "@haneoka/cassiopeia/plugin";
import { createOurNotesPlugin, OUR_NOTES_RULES } from "@haneoka/cassiopeia-plugin-our-notes";

const sourceScore = {
  meta: { version: 1 },
  score: {
    events: {
      bpm: [{ t: 0, bpm: 120 }],
      sig: [{ t: 0, sig: [4, 4] }],
      skill: [],
      fever: [],
      call: []
    },
    notes: [
      {
        type: "tap",
        t: 480,
        pos: 10,
        size: 4,
        crit: false,
        dir: "up",
        ease: "linear",
        visible: true
      }
    ]
  }
};

const runtime = new CassiopeiaRuntime([
  createKernelPlugin(),
  createOurNotesPlugin()
]);
const rules = runtime.require(OUR_NOTES_RULES);
const chart = rules.parse(sourceScore);
const session = runtime.require(CASSIOPEIA_SESSION).create(chart, { mode: "play" });
const frames = rules.createFrameBuilder(chart, { particleSeed: 7 });

session.on("judgement", (event) => frames.addJudgement(event, event.judgedAtMs));
session.update(0);
session.tap(10, 500, 1);
const snapshot = session.update(500);
const frame = frames.build(500, snapshot, {
  noteSpeed: 5,
  mirror: false,
  effects: true
});

console.log({
  normalizedNotes: chart.notes.length,
  score: snapshot.score,
  judgement: snapshot.lastJudgement?.judgement,
  visibleNotes: frame.notes?.length ?? 0
});
runtime.dispose();
```

`parseScore()` also accepts SS JSON text or an `ArrayBuffer`; `buildChart()`
accepts the parsed `SsRoot` when the host already owns parsing. The normalized
output contains integer `timeMs`, lane geometry, operation/judgement enums,
line membership, critical flags, and the generated combo ticks required by the
native slide rules.

## Frame builder and asset manifest

`RenderFrameBuilder` is a pure host-side adapter around one `ChartDocument`:

- `new RenderFrameBuilder(chart, { particleSeed })` prepares note visibility,
  hold paths, simultaneous lines, particle lifetimes, and HUD state.
- `addJudgement(event, timeMs)` queues judgement effects.
- `addLaneInput(event)` queues raw lane feedback without changing score.
- `build(timeMs, snapshot, partialSettings)` returns an owned frame.
- `buildReusable(...)` returns an allocation-bounded frame whose arrays are
  overwritten by the next call; render it synchronously.
- `reset()` clears effect queues and timeline cursors.

Create renderer assets from the immutable manifest and your release resolver:

```ts
const assets = rules.createAssets(
  { hud: await fetch("/release/our-notes/hud.json").then((response) => response.json()) },
  {
    asset: (sourcePath) => `/release/our-notes/assets/${sourcePath}`,
    runtime: (relativePath) => `/release/our-notes/runtime/${relativePath}`
  }
);
```

`OurNotesAssetResolver.asset()` maps Unity source paths; `.runtime()` maps
runtime projections such as note sounds and decoded Unity metadata. The host
must serve the exact files and retain their licenses. The package provides the
static manifest structure, but it does not choose a release or a CDN.

## Host roles and resource path

The normal browser pipeline is:

1. Parse the source SS score with `OUR_NOTES_RULES.parse`.
2. Create a `ChartSession` through `CASSIOPEIA_SESSION`.
3. Feed `MediaClock.timeMs` to `session.update()`.
4. Route pointer events to `tap`, `trace`, `flick`, `release`, and `cancel`.
5. Add judgement/input events to `RenderFrameBuilder`.
6. Render the frame with `@haneoka/cassiopeia-renderer-three` and flush sounds.

The package returns chart data, frame data, asset manifests, haptic cues, and
title metadata. It does not create a canvas, play music, open a browser input
listener, or serve a release endpoint.

## Lifetime and license

The Dart `ChartLaneFeedback` profile owns the same 24 source lane slots and
one-second owner lifetime as the browser adapter. Its particle geometry and
colour samples use the authored six lane prefabs; renderers supply projection,
texture loading and the additive draw. Lane feedback is independent of the
HDR note-effect quality setting.

Export the numeric profile and original texture from a selected extracted
release into an existing chart render profile:

```sh
python3 scripts/export-lane-feedback.py --release-root=/path/to/release \
  --output-dir=/path/to/render-profile/assets/profile/effects
```

The exporter checks archive hashes and records the source identities. The
output contains data and the original texture; shader programs and asset
fetching remain the renderer and host's responsibilities.

The rules service is stateless. Dispose the surrounding `CassiopeiaRuntime`
when the host drops the chart; dispose the renderer, clock, sound player, and
input adapter through their own lifetimes. Frame builders and sessions contain
chart-scoped state and should be discarded with the chart.

The package is available under [MPL-2.0](LICENSE). Game-derived note skins,
effect metadata, sounds, fonts, and release media retain their source terms.
