# @haneoka/embed-cassiopeia

Mount a Cassiopeia chart player inside an ordinary website. The default player uses the existing Vue player, Three renderer, Our Notes plugin and Web audio/input host. A custom renderer can use authored artwork with the kernel and Web host. Each mount owns its DOM, media, input, renderer and resource loader. A shared Haneoka icon links to https://haneoka.org/ in the host’s reserved bottom corner. It remains visible when the inner player enters fullscreen; skin changes retain one link, and disposal removes it.

## Distribution status

This `0.1.0` embed is prepared in source and local release artifacts. Registry publication and an official hosted ESM URL are pending. Use matching local tarballs for the embed and its rendering peers, or bundle them for your own static host/CDN. See the [embedding guide](https://docs.haneoka.org/embed/) for the build and script-module workflow.

## Install and mount the default player

Install the package and the peers used by the default composition. These packages are prepared together; use the corresponding local release tarballs while preparing a release.

```sh
npm install @haneoka/embed-cassiopeia @haneoka/embed-core @haneoka/api-client \
  @haneoka/cassiopeia @haneoka/cassiopeia-host-web \
  @haneoka/cassiopeia-plugin-our-notes @haneoka/cassiopeia-renderer-three \
  @haneoka/cassiopeia-ui-vue vue three
```

A bundler such as Vite resolves these ESM imports. Give the player a stable, nonzero size and load the layout stylesheet. The player inherits the page's font and Material tokens; the example uses Fontsource and `@haneoka/design-tokens`.

```html
<div id="chart" style="height: min(70vh, 640px); width: 100%"></div>
<button id="play" disabled>Play</button>
```

```js
import { mountChart } from "@haneoka/embed-cassiopeia";
import { haneokaChartSource, haneokaChartTheme } from "@haneoka/embed-cassiopeia/haneoka";
import "@haneoka/embed-cassiopeia/style.css";

const chart = mountChart(document.querySelector("#chart"), {
  source: haneokaChartSource({ songId: "100070", difficulty: "expert" }),
  theme: haneokaChartTheme(),
  server: "intl",
  locale: "en",
  mode: "watch",
  skin: { noteSkin: "skin001", noteEffectSkin: "effect001", currentQuality: 2, noteSeGroup: 1 },
  noteSoundEnabled: true,
});
await chart.ready;
const play = document.querySelector("#play");
play.disabled = false;
play.onclick = () => chart.play().catch(console.error);
// chart.pause(); chart.seek(30); await chart.dispose();
```

The source reads the current public song entity, selects its returned difficulty file, parses that score through the Our Notes plugin and uses its returned music URL. The theme discovers current source descriptors and exact runtime outputs. No release identifier or login is required. `server` selects the resource server; `locale` is an independent author/UI language string. The default theme selects lightweight quality 2. Original visual and note-audio assets are fetched from the public resource origin.

## Bring a chart and audio

A standard `ChartDocument` contains `version`, `bpmChanges`, `signatureChanges`, `timeScaleChanges`, `notes`, `lines`, `timeline` and `durationMs`, as exported by `@haneoka/cassiopeia`. Supply exactly one `document` or `source`. An author document can use one language and arbitrary Unicode resource names.

```js
const handle = mountChart(element, {
  document: { chart: myChartDocument, audio: "musique/été.wav", bgmOffsetMs: 250 },
  assetsBase: "https://my.example/project/",
  theme: haneokaChartTheme(), // optional original presentation
  locale: "fr-CA",
  labels: { player: "Partition", pause: "Pause", loading: "Chargement" },
});
await handle.ready;
```

The audio element is the timing source. `seek(seconds)` uses media/presentation seconds; chart time is media time minus `bgmOffsetMs`. Positive offset creates pre-roll. No audio source means a paused visual preview: provide playable audio to advance the internal transport.

Use an existing `OurNotesAssetManifest` as `document.assets` to supply your own compatible theme resources, or a `theme({loader, signal, skin})` factory. `createOurNotesAssetManifest` from the original plugin builds this manifest from its public media/resolver contract. URL fields, HUD image maps, sound strings/layers and animation clip maps are resolved by the mount; names and inline atlas metadata are preserved.

For HTTP JSON and local files use the existing sources from `@haneoka/embed-core`:

```js
import { httpDataSource, fileDataSource, fileResourceResolver } from "@haneoka/embed-core";
const source = httpDataSource({
  url: "https://my.example/project/chart.json",
  decode: (value) => value, // validate/convert your envelope here
});
const fromHttp = mountChart(element, { source, theme: haneokaChartTheme() });
// source.assetsBase defaults to the JSON URL's directory.

const local = mountChart(otherElement, {
  source: fileDataSource(jsonFile),
  resolveResource: fileResourceResolver(new Map([["musique/été.wav", audioFile]])),
  theme: myLocalTheme,
});
```

`fileResourceResolver` resolves literal keys; a default original theme also requests its public API/assets and needs a resolver that passes those absolute URLs through. Blob URLs created by the loader are revoked after the player is disposed. Consumers own URLs they create themselves.

## Use an authored renderer

Pass `rendererAdapter` to load the kernel and Web host without loading the default Vue/Three/Our Notes visual composition. The adapter returns `render`, `resize`, `dispose` and optionally `laneAtClientPoint`. Resolve artwork through `loader.resourceUrl` or `resourceBytes` using the provided `signal`. Release owned graphics in `dispose`.

```js
const handle = mountChart(element, {
  document: { chart: myChartDocument, audio: "audio.ogg" },
  assetsBase: "https://my.example/project/",
  rendererAdapter: {
    async create({ element, chart, loader, signal }) {
      const canvas = document.createElement("canvas");
      element.append(canvas);
      const context = canvas.getContext("2d");
      const artwork = await loader.resourceUrl("notes.svg", { signal });
      // Load your artwork with the same signal and render your own chart geometry.
      return {
        render(snapshot, options) {
          drawMyChart(context, chart, snapshot, options, artwork);
        },
        resize(width, height, ratio) {
          canvas.width = width * ratio;
          canvas.height = height * ratio;
        },
        dispose() {
          canvas.remove();
        },
      };
    },
  },
});
```

The embed uses the existing `MediaClock`, `MusicTimeAnchor` and session update/reset methods. A renderer with `laneAtClientPoint(x,y)` can receive play-mode input through the existing host; return continuous native lanes 0..23, or -1 outside. Held judgement is advanced by the session, with real pointer movement forwarded once. `createSession(chart, options)` lets an authored renderer supply different kernel rules; choose that port for a source game whose rules differ. Without it the current Cassiopeia session rules apply. Custom renderers own their presentation and sound effects; `noteSoundEnabled`, `noteSoundVolume` and original skin selections belong to the default player.

## Transport, changes and teardown

`mountChart()` returns immediately. Await `handle.ready` for initial visual readiness. The initial audio cue preparation reports failures through events; the existing player retries failed cues when playback unlocks. Readiness does not imply a completed media download. Call `play()` from a user gesture after readiness to authorize audio. `pause()` and `seek()` are synchronous; `play()`, `setOptions()`, `setSkin()` and `dispose()` return promises.

```js
await handle.setOptions({ rate: 0.8, volume: 0.6, noteSoundVolume: 0.4, settings: { noteSpeed: 9 } });
await handle.setSkin({ noteSkin: "skin003", noteEffectSkin: "effect001Simple", noteSeGroup: 4 });
// Changing the default theme rebuilds the player paused at its current media time.
handle.seek(12);
await handle.play();
await handle.dispose();
```

`setSkin` requires a default-player theme factory. Original skin IDs are `skin001` (Our Notes), `skin002` (Garupa), `skin003` (Honeycomb); effect IDs are `effect001` and `effect001Simple`. Note audio group IDs are 1–4 (Our Notes, Solid, Wood, Typing). The actual plugin's localized naming and audio loop metadata remain authoritative.

`setOptions` passes mode, partial render settings, music volume/rate/loop and note audio enable/volume to the existing player. Mode changes use its existing reset behavior. Call `cancel()` to abort the mount and stop playback; this handle is terminal. Call `dispose()` to remove its DOM and release the loader. Disposal is idempotent and works during loading, including a factory that returns late. An external `signal` cancels the mount. `loadTimeoutMs` defaults to 30000 and applies to construction, not to the playable lifetime. Dispose before mounting again in the same container.

`handle.snapshot` exposes phase, playing, time and duration. Subscribe at construction to observe load progress/errors and current state:

```js
const handle = mountChart(element, {
  document: myDocument,
  rendererAdapter: myRenderer,
  onEvent(event) {
    if (event.type === "load") showResourceProgress(event.event);
    if (event.type === "state") updateTransport(event.snapshot);
    if (event.type === "error") showError(event.error);
    if (event.type === "player" && event.name === "judgement") showJudgement(event.args[0]);
  },
});
// const unsubscribe = handle.subscribe(listener);
```

## Origins, credentials and browser ESM

`assetsBase` is an absolute directory URL. Relative keys resolve under it; root-relative paths resolve on its origin; absolute URLs keep their origin. `resolveResource(key, context)` can asynchronously return a URL, string or Blob. The theme's `apiBase` selects its API root and `publicBase` selects the public asset origin; these are separate from authored document resources. Returned paths use latest public resources and may change as the server updates.

`fetcher(request)`, `headers`, `credentials` (default `omit`) and `maxBytes` come from embed-core. They apply to document/resource reads made through the loader. The default player still uses its existing media, texture and SE decoders. Haneoka public resources under `/assets/`, `/runtime/` and `/embed/` use `referrerPolicy: "no-referrer"` through the existing loader/fetcher. Default-player theme textures, metadata, SE and public background images are materialized as owned Blob URLs so native loaders receive the same bytes without a hotlink Referer. These URLs are revoked when that player is replaced, fails or is disposed. Other resource origins retain the caller’s request policy; their native URL downloads and the music element use their existing anonymous CORS loaders. Supply public CORS URLs or Blob resources for private media. An `include` credential policy only affects loader requests, whose server must explicitly allow credentials and the embedding origin. CSP must permit the script/module, asset and media origins plus owned `blob:` URLs where used.

Bundlers emit lazy chunks for the default player and its dependencies. For a plain `<script type="module">`, host the emitted ESM files and chunks together, or provide an import map for every bare dependency and exported subpath. Pin a compatible version of Vue/Three and all Cassiopeia packages in that map. Keep `style.css` linked separately. Importing the package itself does not create DOM, fetch data or initialize Three.

A small-screen page should reserve height, use touch-sized transport controls outside the stage, and reflect loading/error state with the page's existing Material components. Renderer performance and media formats depend on the browser/device; validate the final consumer on the devices it targets.
