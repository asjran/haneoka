# Cassiopeia

Cassiopeia is a portable rhythm-game kernel and typed plugin runtime. It owns
integer timing, note input, judgement windows, combo, life, score, skill/fever
timelines, session snapshots, the native C ABI, and WebAssembly bindings.
Rendering, audio devices, browser input, haptics, and Sonolus conversion are
separate host/plugin responsibilities.

## Core workflow

The kernel consumes a normalized `ChartDocument`. Its `ChartSession` reads the
host music clock in integer milliseconds and returns a `SessionSnapshot` after
each update. In `play` mode, call `tap`, `flick`, `trace`, `release`, or
`cancel` with the input lane and the input timestamp. In `watch` mode, the
session resolves playable notes automatically.

## Build from a clean checkout

The package has no runtime Three.js, Vue, or Sonolus dependency. Build the
repository directly:

```sh
git clone https://github.com/haneoka-gakuen/cassiopeia.git
cd cassiopeia
git checkout 754dbc7c5dbf5209005ea02205a6839305e624da
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install --frozen-lockfile
CARGO_BUILD_JOBS=1 NODE_OPTIONS=--max-old-space-size=1536 pnpm check
```

The JavaScript/WASM build requires Node 20 or newer. The native checks require
the Rust toolchain selected by `rust-toolchain.toml`.

## Smallest complete session

This example constructs one tap at 500 ms, feeds a timestamped perfect input,
and prints the score result. The shape is the actual `ChartDocument` consumed by
`ChartSession`:

```ts
import {
  ChartSession,
  NoteDirection,
  NoteJudgementType,
  NoteLineEaseType,
  NoteOperateType,
  JudgementAreaOffsetType
} from "@haneoka/cassiopeia";

const chart = {
  version: 1,
  bpmChanges: [{ tick: 0, beat: 0, timeMs: 0, bpm: 120 }],
  signatureChanges: [{ tick: 0, beat: 0, timeMs: 0, numerator: 4, denominator: 4 }],
  timeScaleChanges: [],
  notes: [
    {
      id: 0,
      tick: 480,
      timeMs: 500,
      beat: 1,
      pos: 10,
      size: 4,
      laneX: 0,
      width: 1 / 3,
      operateType: NoteOperateType.Normal,
      judgementType: NoteJudgementType.Normal,
      judgementAreaOffsetType: JudgementAreaOffsetType.Default,
      direction: NoteDirection.Normal,
      critical: false,
      judged: true,
      visible: true,
      lineIds: [],
      slideAlong: false,
      indexInLine: null,
      easeL: null as NoteLineEaseType | null,
      easeR: null as NoteLineEaseType | null
    }
  ],
  lines: [],
  timeline: { skills: [], fever: [], callChanges: [] },
  durationMs: 1000
};

const session = new ChartSession(chart, { mode: "play" });
session.on("judgement", (event) => console.log(event.judgement, event.scoreDelta));
session.update(0);
session.tap(10, 500, 1);
const snapshot = session.update(500);
console.log({ score: snapshot.score, combo: snapshot.combo, life: snapshot.life });
```

The host owns the clock and calls `session.update(clockMs)` once per render
frame. `snapshot.lastJudgement` and the `judgement` event carry the output for
HUD, effects, sounds, and analytics. `snapshot.noteState` and `snapshot.lineState`
are allocation-free queries for renderers. Call `finish()` after the music
ends; call `reset(timeMs)` when a transport seek resets the gameplay state.

## Plugin composition

`CassiopeiaRuntime` installs only the plugins supplied to its constructor. It
sorts declared dependencies, rejects duplicates/missing services/cycles, and
rolls back cleanup callbacks on setup failure. There is no process-global service
registry:

```ts
import { CassiopeiaRuntime, createKernelPlugin, CASSIOPEIA_SESSION } from "@haneoka/cassiopeia/plugin";
import { createOurNotesPlugin, OUR_NOTES_RULES } from "@haneoka/cassiopeia-plugin-our-notes";

const runtime = new CassiopeiaRuntime([
  createKernelPlugin(),
  createOurNotesPlugin()
]);
const rules = runtime.require(OUR_NOTES_RULES);
const chart = rules.parse(sourceScoreJson);
const session = runtime.require(CASSIOPEIA_SESSION).create(chart, { mode: "watch" });

runtime.dispose();
```

The Our Notes plugin parses source score JSON into the `ChartDocument` shape;
the kernel then remains independent of the source game. Renderer and host
plugins use the same `session` object and never change its judgement policy.

## Native and WASM boundaries

The `@haneoka/cassiopeia/wasm` entry exposes the generated WASM API and
`@haneoka/cassiopeia/wasm/module` exposes the `.wasm` module bytes. The native
crate supplies the same kernel contract through C, Android JNI, and Swift
wrappers. Load one WASM module per application runtime and keep host-owned
audio, GPU, and platform vibration outside the kernel boundary.

## Lifetime and license

`ChartSession` is a synchronous value owner with no global state. Drop it when
the chart ends; dispose `CassiopeiaRuntime` to run plugin cleanup and clear its
services. Renderer, clock, sound, input, and haptic objects each have their own
dispose/destroy method and remain host-owned.

Cassiopeia is available under [MPL-2.0](LICENSE). Preserve
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for Rust, WASM, and other
third-party components. Source charts, audio, images, and game-derived media
retain their own terms.
