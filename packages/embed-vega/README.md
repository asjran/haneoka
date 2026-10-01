# Vega on your website

`@haneoka/embed-vega` mounts a Vega story inside an element you own. It uses the Three renderer, Vega's existing resource resolver, and the portable dialogue UI. Your page controls loading and playback through a small handle. You can supply an in-memory document, HTTP JSON, local files, or a current Haneoka story.

## Distribution status

This `0.1.0` embed is prepared in source and local release artifacts. Registry publication and an official hosted ESM URL are pending. Use matching local tarballs for the embed and its rendering peers, or bundle them for your own static host/CDN. See the [embedding guide](https://docs.haneoka.org/embed/) for the build and script-module workflow.

## Install and mount

Install the embed and its rendering peers in your application:

```sh
npm install @haneoka/embed-vega @haneoka/embed-core @haneoka/vega @haneoka/vega-renderer-three @haneoka/vega-ui-portable @haneoka/vega-plugin-richtext three howler
```

Use a browser bundler that supports ESM, such as Vite. Give the container an explicit height; it can be placed in an article, dialog, or full-screen view. The player starts paused at the first command.

```html
<div id="story" style="width:100%;height:60vh;min-height:240px"></div>
<button id="play">Play</button>
<button id="pause">Pause</button>
<button id="next">Next</button>
```

```js
import { mountStory } from "@haneoka/embed-vega";
import { ADV_COMMAND } from "@haneoka/vega/renderer-kit";

const document = {
  localization: { locales: ["en"], defaultLocale: "en" },
  commands: [
    { command: ADV_COMMAND.Stage, background: { url: "garden.png" } },
    { command: ADV_COMMAND.Talk, targetName: "Mira", text: "Welcome to the garden." },
    { command: ADV_COMMAND.Talk, targetName: "Mira", text: "Take your time." },
  ],
};
const story = mountStory(window.document.querySelector("#story"), {
  document,
  locale: "en",
  assetsBase: "https://your.example/stories/garden/",
  onEvent(event) {
    if (event.type === "error") console.error(event.error);
    if (event.type === "load") console.log(event.event);
  },
});
await story.ready;
window.document.querySelector("#play").onclick = () => story.play();
window.document.querySelector("#pause").onclick = () => story.pause();
window.document.querySelector("#next").onclick = () => story.next();
```

The document is Vega's public `AdvStory`, with authored opcodes and resolved resource entries. A story can use one language or any author-defined locale set. Text and IDs retain their authored values. `locale` selects the player's text language independently of the asset server. `runtime.fonts` retains Vega's font declarations and prepares them before `ready`.

For a script-based page, bundle this entry once and load the resulting ESM asset:

```html
<script type="module">
  import { mountStory } from "/scripts/vega-embed.js";
  const story = mountStory(document.querySelector("#story"), {
    document: window.myStory,
    assetsBase: "https://your.example/story-assets/",
    locale: "en",
  });
  await story.ready;
  document.querySelector("#play").onclick = () => story.play();
</script>
```

`vega-embed.js` is the output of your bundler with `export { mountStory } from '@haneoka/embed-vega'` as its entry. Serve it with JavaScript MIME type. Bundle the required peer packages; browser-native bare package imports need an import map and browser-compatible distribution files.

## HTTP documents and local resources

```js
import { httpDataSource, fileDataSource, fileResourceResolver } from "@haneoka/embed-core";

const remote = mountStory(element, {
  source: httpDataSource({ url: "https://your.example/stories/episode.json" }),
  locale: "en",
});
await remote.ready;
```

Relative resource paths resolve against the HTTP document's directory. A root-relative path resolves against that origin, and an absolute URL keeps its origin. An explicit `assetsBase` overrides the document's directory. It must be an absolute HTTP(S) directory URL. The host resolves declared media, model, texture, animation and font fields before creating the renderer; source labels and dialogue strings remain intact. Provider manifests continue to resolve their own relative sidecar paths through the existing provider.

To load local files, provide a JSON `File` and a map of literal project paths to `Blob` or `File` values:

```js
const local = mountStory(element, {
  source: fileDataSource(jsonFile),
  resolveResource: fileResourceResolver(
    new Map([
      ["背景/庭園.png", backgroundFile],
      ["fonts/author.woff2", fontFile],
    ]),
  ),
  locale: "en",
});
await local.ready;
```

Paths are matched literally, including Unicode. The data loader owns these Blob URLs. The Vega resolver owns encoded resource caching, renderable URLs and leases; model providers and Three own decoded and GPU resources. When using model manifests with local sidecars, resolve the manifest's resulting absolute sidecar URLs in your resolver too, or supply a provider's complete resource descriptor.

## Transport, events and cancellation

The same embed-core transport reads the document and Vega resource bytes. Requests use CORS mode and omit credentials by default. Configure `fetcher`, `headers`, `credentials`, `resolveResource`, or `maxBytes` when your host needs them. `maxBytes` defaults to 64 MiB per document/resource response. Resource adapter calls have a 30-second total deadline, adjustable through `resourceTimeoutMs`. Vega retains its existing cache and lease behavior.

The asset and JSON origins must permit your site's origin with CORS response headers. Credentialed cross-origin requests need an explicit allowed origin and credential permission. Font files, model files, textures and audio all need accessible URLs. Dynamic Cubism modules and Core scripts use their native module/script loading paths; transport headers do not configure those script requests.

`onEvent` is active from the first load. `subscribe` adds a listener and returns an unsubscribe function:

```js
const unsubscribe = story.subscribe((event) => {
  if (event.type === "load") {
    // start / progress / ready / error / cancelled / disposed
    // Each data/resource operation has its own operation number and key.
    console.log(event.event);
  }
  if (event.type === "state") updateControls(event.snapshot);
  if (event.type === "seek") console.log("Restored command", event.commandIndex);
});
```

Load events describe data and resource transport. The handle's `ready` additionally waits for Vega's renderer, resources, fonts and seek index. State events carry loading/ready/error/cancelled/disposed phase, play/pause/finish/seek flags, command position and reachable-path progress. They are coalesced at 100 ms, with immediate publication for controls. A failing listener is isolated; `onListenerError` can record it.

```js
const controller = new AbortController();
const story = mountStory(element, { source, signal: controller.signal });
// A Cancel loading button can call either:
story.cancel();
// controller.abort();
try {
  await story.ready;
} catch (error) {
  showLoadingError(error);
}
await story.dispose();
```

`cancel()` retires a loading player. Dispose it before retrying with a new handle. Aborting the supplied signal after `ready` disposes the mounted player. `dispose()` is idempotent and releases the player before the data source's URLs and cleanup. Await it before recreating the player in the same element; other children of your container remain in place.

## Playback and seeking

Call `play()` from a click or tap after `ready`; this gives browser audio a user gesture. `pause()` pauses the interpreter and current video, and `next()` advances readable dialogue. The portable dialogue surface also accepts its existing pointer and keyboard interaction. A completed story can be rewound with `seek(0)` and played again.

```js
story.play();
story.pause();
await story.seek(0.75); // forward on the current reachable story path
await story.seek(0.25); // backward, preserving the paused state
await story.seek(0);
story.play();
await story.dispose();
const replacement = mountStory(element, { document: nextDocument, assetsBase, locale: "en" });
await replacement.ready;
```

The ratio maps to Vega's prepared command boundaries, including its active choice path. It represents story progress rather than elapsed video seconds. The returned number is the restored command boundary. Use `story.snapshot` for the current transport state and `story.player` for advanced Vega APIs while the handle is ready.

## Existing theme, shell and model providers

The default portable player includes dialogue and choices. Your page provides transport buttons and a progress control. The existing Haneoka theme and shell can be selected when you want the full theme UI:

```sh
npm install @haneoka/vega-theme-haneoka @haneoka/vega-shell-default
```

```js
import { haneokaStoryPlugins } from "@haneoka/embed-vega/theme";

const story = mountStory(element, {
  document,
  assetsBase,
  locale: "en",
  theme: "haneoka",
  plugins: haneokaStoryPlugins,
  shell: { initialScreen: "game", projectId: "my-story", settingsId: "my-story-settings" },
});
```

For custom models, append their provider plugins to `haneokaStoryPlugins`. Serve the theme's `assets/` files beside its built module as expected by that package's relative asset URLs. Retain its font and sprite files, or configure your bundler to preserve/copy the selected package assets. `renderer` accepts the existing Three plugin options, including an authorized post-texture provider. `plugins` installs existing Vega character and command providers. These keep their public lifecycle contracts.

## Current Haneoka stories

The optional adapter resolves one story, its runtime and its declared Live2D metadata. It uses the public API's current data and returned resource paths. Install the adapter peers and supply a separately provisioned Cubism runtime:

```sh
npm install @haneoka/api-client @haneoka/vega-plugin-haneoka @haneoka/vega-plugin-cubism
```

```js
import { haneokaStorySource, cubismStoryPlugin } from "@haneoka/embed-vega/haneoka";

const story = mountStory(element, {
  source: haneokaStorySource({ id: "afterlive_10109" }),
  server: "intl",
  locale: "en",
  plugins: [
    cubismStoryPlugin({
      moduleUrl: "https://your.example/cubism-runtime/vega-cubism-web-runtime.mjs",
      runtime: {
        cubismCoreUrl: "https://your.example/Core/live2dcubismcore.js",
        cubism2CoreUrl: "https://your.example/Core/live2d.min.js",
        motionSyncCoreUrl: "https://your.example/Core/CRI/live2dcubismmotionsynccore.min.js",
      },
    }),
  ],
});
await story.ready;
```

The runtime module and Core files are provisioned under their respective licenses. Keep versioned module/Core URLs together so browser caching retains a compatible adapter. An API returning mutable asset paths follows that API's current snapshot behavior. You can also pass `apiBase` to `haneokaStorySource` to use your own compatible API origin.

## Haneoka attribution

Every mounted player displays the Haneoka icon linking to https://haneoka.org/ in a new tab. This identifies the playback engine, including for your own documents; your story and assets retain their own authorship and licenses. The icon uses a reserved 48-pixel corner row plus the top safe area, keeping menus, subtitles and progress controls clear. Set `brandingCorner: "top-right"` to move it to the other top corner. The attribution is always enabled.

Other embed hosts can reuse `createHaneokaBranding(document, { corner })` from `@haneoka/embed-core/branding`. It returns an anchor for the host to append and remove. Its import leaves the DOM untouched; the icon is inline and makes no asset request.

## Layout and distribution

Use a container that preserves its space while loading. Place accessible, clearly labelled controls outside its interactive stage, with touch targets of at least 48 pixels and a layout that wraps at narrow widths. Your host controls the loading indicator, error presentation and UI language. Reuse your component library and design tokens for these controls; the embed adds no page navigation.

The package ships ESM and TypeScript declarations. Its main entry uses the portable renderer peers; the Haneoka adapter and theme are optional. Import the main entry on the server if needed, and call `mountStory` in the browser after the container exists. Run `npm run build` before packing a local checkout. Source documents and your assets stay under their own licenses; this host module is MPL-2.0.
