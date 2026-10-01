# Home Spot embed

`@haneoka/embed-home-spot` mounts a Three/Spine scene inside a container on your website. It accepts a scene you author or a current public Home Spot selected by ID. The public scene provider owns the camera, authored animation, layer composition, hit testing, decoded assets and WebGL lifecycle. The embed connects portable data sources and encoded resource bytes to that provider.

## Distribution status

This `0.1.0` embed is prepared in source and local release artifacts. Registry publication and an official hosted ESM URL are pending. Use matching local tarballs for the embed and its rendering peers, or bundle them for your own static host/CDN. See the [embedding guide](https://docs.haneoka.org/embed/) for the build and script-module workflow.

## Install and mount a public scene

Use an ESM bundler such as Vite. Install the embed and its scene runtime peers:

```sh
npm install @haneoka/embed-home-spot @haneoka/embed-core @haneoka/api-client \
  @haneoka/vega-plugin-haneoka three@0.184.0 @esotericsoftware/spine-threejs@4.2.119
```

The public scene provider accepts the encoded resource port and exposes the controller’s `exportPng` method. Build the provider and embed together from the same source revision.

The Spine runtime is supplied by the application and carries its own [runtime license](https://esotericsoftware.com/spine-runtimes-license). Scene data and artwork retain their authors' licenses.

```html
<div id="spot"></div>
```

```js
import { mountHaneokaHomeSpot } from "@haneoka/embed-home-spot/haneoka";

const spot = mountHaneokaHomeSpot(document.querySelector("#spot"), {
  spotId: 40002,
  server: "intl",
  locale: "en",
  ariaLabel: "Garage scene",
  onEvent(event) {
    if (event.type === "error") console.error(event.error);
  },
});

await spot.ready;
spot.update({ selectedCharacterId: 31 });
spot.replay();
const png = await spot.exportPng({ width: 1920, height: 1080 });
// Use the PNG Blob in a preview, upload, or download chosen by your application.
// At the end of the page/component lifetime:
await spot.dispose();
```

The public adapter reads the latest `stories` document and selects `homeSpots[spotId].spine`. It needs a server and Spot ID, with no account or release selection. The API currently supplies this data as one document; the adapter selects the scene after that request. Asset references are used as returned. The public mount sends requests with `referrerPolicy: "no-referrer"`, so image hosting accepts the external page without receiving its URL. Your custom `fetcher` receives that Request with its credentials and signal preserved. When combining `haneokaHomeSpotSource` with the main mount manually, set the same referrer policy in your fetcher for public assets. `locale` controls request language independently of `server` and remains a string for authored content.

An application can use `haneokaHomeSpotSource({ spotId, apiBase })` with the main `mountHomeSpot` entry when it wants to manage its own source selection. The `/haneoka` entry requires the optional API client peer; the main entry supports authored data without it.

## Author one scene

Provide the descriptor consumed by the public Home Spot scene provider. One scene needs its GLB background, background transform, atlas and Spine layer. Each atlas page and skeleton is supplied through the resource resolver. A self-contained GLB embeds its background images and buffers.

```js
import { mountHomeSpot } from "@haneoka/embed-home-spot";
import { fileResourceResolver } from "@haneoka/embed-core";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const scene = {
  supported: true,
  backgroundScene: "room.glb",
  backgroundTransform: identity,
  atlas: "actors/actor.atlas",
  scale: 0.01,
  camera: {
    position: [0, 0, -5],
    startPosition: [0, 0, -5],
    target: [0, 0, 0],
    fieldOfView: 20,
    introDuration: 0,
  },
  layers: [
    {
      key: "actor",
      runtime: { json: "actors/actor.json" },
      animation: "idle",
      sortingOrder: 0,
      transform: identity,
    },
  ],
};
const resources = new Map([
  ["room.glb", roomGlbFile],
  ["actors/actor.atlas", atlasFile],
  ["actors/actor.json", skeletonFile],
  // The name written in actor.atlas is resolved in its own directory.
  ["actors/actor.png", textureFile],
]);
const spot = mountHomeSpot(document.querySelector("#spot"), {
  document: scene,
  resolveResource: fileResourceResolver(resources),
  locale: "fr",
  ariaLabel: "Une scène originale",
});
await spot.ready;
```

The file variables above are `File` or `Blob` objects obtained by your application. Their literal resource keys can contain Unicode. Author the scene in one language; no Haneoka page shell, catalog, release manifest or translation set is needed. JSON skeletons use `runtime.json`; binary skeletons use `runtime.skel`. Use data compatible with the installed Spine 4.2 runtime and an animation that exists in that skeleton.

Camera vectors and layer transforms use the provider's scene conventions: vectors and row-major layer matrices follow Unity coordinates, while `backgroundTransform` is the column-major matrix for the converted GLB. Identity matrices work for a scene authored around the origin. A `characterId` and local `hitPolygon` can be added to a layer for pointer selection. Distinct layers retain their authored sorting order. The provider applies camera entrance, mouse follow and selection alpha when those fields are present.

## Load a scene from another origin

The HTTP source uses the scene document's directory as the asset base. For example, a page at `https://gallery.example/` can read a scene from `https://media.example/projects/cafe/scene.json`:

```js
import { mountHomeSpot } from "@haneoka/embed-home-spot";
import { httpDataSource } from "@haneoka/embed-core";

const spot = mountHomeSpot(document.querySelector("#spot"), {
  source: httpDataSource({
    url: "https://media.example/projects/cafe/scene.json",
  }),
  ariaLabel: "Cafe",
});
await spot.ready;
```

With this document, `room.glb` resolves to `https://media.example/projects/cafe/room.glb`. An atlas at `actors/actor.atlas` resolves its `actor.png` page in `projects/cafe/actors/`. A root-relative `/art/room.glb` uses the media origin, and an absolute URL keeps its own origin. Set `assetsBase` to an absolute HTTP(S) directory when resources live elsewhere. A custom `resolveResource` can map keys to URLs or Blobs; `fetcher(request)` can integrate your application's transport. All requests use CORS mode and omit credentials by default.

The data and asset origins must permit browser requests from the page origin. Public anonymous assets can send `Access-Control-Allow-Origin: *`. Credentialed resources need an explicit page origin and credential permission; set `credentials` only when that service requires it. Custom request headers may need a successful OPTIONS preflight. An HTTP failure, unavailable scene, incompatible skeleton or blocked CORS request rejects `ready` and emits an error. The embed's byte budget defaults to 64 MiB per document or resource and can be set with `maxBytes`.

For local JSON, use `fileDataSource(sceneFile)` together with `fileResourceResolver(resources)`. Relative authored keys then match the local map directly. Resource bytes use the same resolver and transport as the document loader. The original scene provider creates textures and model instances, and releases them with the scene.

## Instance lifetime and events

`mountHomeSpot` returns synchronously. Attach a rejection handler to `ready` and keep the handle available to your component cleanup even while the network is loading:

```js
const spot = mountHomeSpot(host, { source, signal: componentSignal });
spot.ready.catch(showLoadError);
// Component cleanup can run before ready settles.
await spot.dispose();
```

`cancel()` cancels the current loading generation; after cancellation, call `load({ document })` or `load({ source })` to start another scene. A completed scene stays available when `cancel()` is called. `load` disposes the previous scene and source, rejects its pending load, then mounts the new generation. `ready` always refers to the latest load, and the promise returned by `load` refers to that particular generation. Treat a source with a `dispose` method as owned by one load; create a fresh source when loading again. `dispose()` is idempotent, removes the embed's element and listeners, cancels loading and disposes the source. A disposed handle cannot be reused. Cleanup failures reject `dispose()` with an aggregate error; cancelled `ready` promises reject promptly while cleanup finishes.

`update({ selectedCharacterId })` changes the selected character without rebuilding resources. `update({ replay: true })` restarts the authored entrance and animation; `replay()` does the same after `ready`. `resize()` asks the provider to update its viewport; the scene also observes its container. Use `load` when replacing scene geometry, assets or camera data.

Events include `loading`, `ready`, `cancelled`, `error`, `selection`, `contextlost`, `contextrestored` and `disposed`. Network events appear as `{ type: 'resource', event }`, preserving the embed-core operation ID, key and byte progress. Progress is per resource and includes a total only when the response supplies a reliable decoded length. `subscribe(listener)` returns an unsubscribe function. Event observers cannot change the load outcome; `onListenerError` can receive their errors.

`exportPng({ width, height })` returns a PNG Blob for the current scene frame. Capture is rendered by the scene provider at the requested dimensions, with its GPU limits, then the interactive viewport is restored. Keep the requested proportions equal to the displayed scene when preserving composition. A failed capture rejects the promise. Export creates no permanent download URL; your application should revoke URLs it creates after their previews or downloads finish.

## Layout and controls

The embed reserves a 16:9 area from the moment it mounts, so scene loading does not change the page layout. Override `aspectRatio` to reserve another ratio. The canvas fills that area at the renderer's supported pixel ratio. The embed owns one child element and leaves other container children to the host. A corner link displays the original Haneoka icon and opens `https://haneoka.org/`; it stays outside the game canvas and PNG export.

Use your existing Material controls for replay, selection and export. The embed exposes a scene canvas and lifecycle events; labels, progress indicators and toolbars belong to your application. An MD3 host can provide `--md-sys-color-surface`; the scene clear color follows that token unless `clearColor` is supplied. Localize button text and the `ariaLabel` in the author's language. Selection can also be driven through keyboard-accessible host buttons calling `update`, alongside the canvas's pointer hit testing.

The scene uses original PNG resources. Native compressed Spine textures and PMA need explicit support in the scene provider and its asset data. The embed forwards the existing descriptor and creates no model-specific rendering rules.
