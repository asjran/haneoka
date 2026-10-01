import type { OurNotesAssetManifest } from "@haneoka/cassiopeia-plugin-our-notes";
import type { ChartPlayerExpose } from "@haneoka/cassiopeia-ui-vue/player";
import type { PlayerDriver, PlayerEvent } from "./driver.js";
import type { ChartEmbedDocument, ChartPlaybackOptions, MountChartOptions } from "./types.js";

export async function createVuePlayer(
  element: HTMLElement,
  document: ChartEmbedDocument,
  assets: OurNotesAssetManifest,
  options: ChartPlaybackOptions,
  labels: MountChartOptions["labels"],
  signal: AbortSignal,
  event: PlayerEvent,
): Promise<PlayerDriver> {
  const [{ createApp, h, shallowReactive }, { ChartPlayer }] = await Promise.all([
    import("vue"),
    import("@haneoka/cassiopeia-ui-vue/player"),
  ]);
  signal.throwIfAborted();
  let player: ChartPlayerExpose | null = null;
  let disposed = false;
  let playError: unknown;
  const props = shallowReactive({ ...options });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const on =
    (name: string) =>
    (...args: unknown[]) => {
      if (disposed || signal.aborted) return;
      event(name, ...args);
    };
  const app = createApp({
    render: () =>
      h(ChartPlayer, {
        ...props,
        chart: document.chart,
        assets,
        audioUrl: document.audio ?? "",
        backgroundUrl: document.background ?? "",
        bgmOffsetMs: document.bgmOffsetMs ?? 0,
        titleIntroductionEnabled: false,
        ariaLabel: labels?.player ?? "Chart player",
        pauseLabel: labels?.pause ?? "Pause",
        loadingLabel: labels?.loading ?? "Loading",
        ref: (value: unknown) => {
          player = value as ChartPlayerExpose | null;
        },
        onReady: () => {
          if (!disposed && !signal.aborted) resolveReady();
        },
        onError: (error: unknown) => {
          playError = error;
          rejectReady(error);
          on("error")(error);
        },
        onPlaying: on("playing"),
        "onMedia-playing": on("media-playing"),
        onTimeupdate: on("timeupdate"),
        onDuration: on("duration"),
        onJudgement: on("judgement"),
        onSkill: on("skill"),
        onFever: on("fever"),
        onCallchange: on("callchange"),
      }),
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", abort);
    app.unmount();
    player = null;
  };
  const abort = () => {
    rejectReady(signal.reason);
    dispose();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    app.mount(element);
    await ready;
    signal.throwIfAborted();
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    async play() {
      playError = undefined;
      await player!.play();
      if (playError !== undefined) throw playError;
    },
    pause: () => player?.pause(),
    seek: (seconds) => player!.seek(seconds),
    async setOptions(value) {
      const { nextTick } = await import("vue");
      if (disposed) throw new Error("Chart player has been disposed");
      Object.assign(props, value);
      await nextTick();
    },
    dispose,
  };
}
