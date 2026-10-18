# Cassiopeia Three renderer

`@haneoka/cassiopeia-renderer-three` renders normalized Cassiopeia frames with
Three.js. It owns the WebGL stage, note and hold geometry, simultaneous-note
lines, original effect reconstruction, HUD, sprite atlases, background media,
and the live bloom pipeline.

Gameplay remains in Cassiopeia. Source-game normalization and the frame DTO
come from `@haneoka/cassiopeia-plugin-our-notes`; the browser clock and input
come from `@haneoka/cassiopeia-host-web`.

## Build from a clean Git workspace

The renderer peers are unpublished source packages. Link them in one workspace:

```sh
mkdir cassiopeia-three-workspace
cd cassiopeia-three-workspace
git clone https://github.com/haneoka-gakuen/cassiopeia.git packages/cassiopeia
git clone https://github.com/haneoka-gakuen/cassiopeia-plugin-our-notes.git packages/our-notes
git clone https://github.com/haneoka-gakuen/cassiopeia-renderer-three.git packages/renderer
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
linkWorkspacePackages: true
```

Install and build:

```sh
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install
pnpm --filter @haneoka/cassiopeia build
pnpm --filter @haneoka/cassiopeia-plugin-our-notes build
pnpm --filter @haneoka/cassiopeia-renderer-three check
```

Use Node 24 or newer, Three.js `0.184.x`, and a browser/WebView with WebGL2.

## Complete frame-to-WebGL example

The renderer consumes a synchronous `RenderFrame`. The following shows the
actual service and renderer lifecycle; `assets` is an
`OurNotesAssetManifest` created from the licensed release pack as shown below.

```ts
import {
  CassiopeiaRuntime,
  createKernelPlugin
} from "@haneoka/cassiopeia/plugin";
import { CASSIOPEIA_SESSION } from "@haneoka/cassiopeia/plugin";
import {
  createOurNotesAssetManifest,
  createOurNotesPlugin,
  OUR_NOTES_RULES
} from "@haneoka/cassiopeia-plugin-our-notes";
import {
  createThreeRendererPlugin,
  THREE_RENDERER
} from "@haneoka/cassiopeia-renderer-three";

const canvas = document.querySelector<HTMLCanvasElement>("#stage");
if (!canvas) throw new Error("Add <canvas id=\"stage\"></canvas>");

const assets = createOurNotesAssetManifest(
  { hud: await fetch("/release/our-notes/hud.json").then((response) => response.json()) },
  {
    asset: (sourcePath) => `/release/our-notes/assets/${sourcePath}`,
    runtime: (relativePath) => `/release/our-notes/runtime/${relativePath}`
  }
);
const runtime = new CassiopeiaRuntime([
  createKernelPlugin(),
  createOurNotesPlugin(),
  createThreeRendererPlugin()
]);
const renderer = runtime.require(THREE_RENDERER).create({ canvas, assets });
await renderer.load();

const rules = runtime.require(OUR_NOTES_RULES);
const chart = rules.parse(await fetch("/charts/song.ss.json").then((response) => response.json()));
const game = runtime.require(CASSIOPEIA_SESSION).create(chart, { mode: "play" });
const frames = rules.createFrameBuilder(chart, { particleSeed: 7 });
game.on("judgement", (event) => frames.addJudgement(event, event.judgedAtMs));

function renderAt(timeMs: number): void {
  const snapshot = game.update(timeMs);
  renderer.render(frames.buildReusable(timeMs, snapshot));
}

renderAt(0);
game.tap(12, 500, 1);
renderAt(500);

renderer.dispose();
runtime.dispose();
```

The asset manifest is a host input, not a package default. `hud.json` must
contain the `HudAssetManifest` fields; the `asset` and `runtime` resolvers must
return URLs for the exact note, lane, particle, atlas, metadata, font, and
sound files in the selected release. This keeps the renderer independent from
release storage and preserves source-game asset terms.

## Renderer API and host roles

`OurNotesRenderer` has the following consumer-facing flow:

1. `new OurNotesRenderer({ canvas, assets, ...options })` creates Three state.
2. `await renderer.load()` loads atlases, stage textures, particles, and HUD.
3. `renderer.resize(width, height, pixelRatio)` follows host layout changes.
4. `renderer.render(frame)` consumes one synchronous frame.
5. `renderer.clientPointToLane(clientX, clientY)` maps pointer coordinates to
   the continuous `0..23` chart lane space.
6. `renderer.dispose()` releases GPU resources and event listeners.

Set `showEaseNote`, `backgroundColor`, `backgroundAlpha`, `maxParticleEffects`,
`particlesPerEffect`, or `pixelRatio` in `OurNotesRendererOptions`. Use
`setBackgroundTexture(url)`, `setBackgroundVideo(video)`, or
`setBackgroundCanvas(canvas, version)` for host-owned stage media. `renderer.stats`
reports visible note/hold/effect counts, draw calls, context loss, and asset
readiness.

The renderer never chooses a chart, music clock, touch timestamp, or asset URL.
Cassiopeia owns judgement; the host clock owns `timeMs`; the Our Notes plugin
owns source normalization and frame policy; the application owns release media.

## License

The package is available under [MPL-2.0](LICENSE). Three.js remains a peer
dependency under its own license. Preserve the licenses and notices of all
release images, atlas metadata, fonts, music, and game-derived effects.
