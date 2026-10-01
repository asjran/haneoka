import type { EmbedLoader } from "@haneoka/embed-core";
import type { PlayerDriver, PlayerEvent } from "./driver.js";
import type { ChartEmbedDocument, ChartRenderer, MountChartOptions } from "./types.js";

export async function createAuthoredPlayer(
  element: HTMLElement,
  document: ChartEmbedDocument,
  loader: EmbedLoader<ChartEmbedDocument>,
  options: MountChartOptions,
  signal: AbortSignal,
  event: PlayerEvent,
): Promise<PlayerDriver> {
  const [{ ChartSession, MusicTimeAnchor, normalizeEventRealtimeMs }, { MediaClock, OurNotesInput }] =
    await Promise.all([import("@haneoka/cassiopeia"), import("@haneoka/cassiopeia-host-web")]);
  signal.throwIfAborted();
  let renderer: ChartRenderer | undefined;
  let input: InstanceType<typeof OurNotesInput> | undefined;
  let clock: InstanceType<typeof MediaClock> | undefined;
  let observer: ResizeObserver | undefined;
  let frame = 0;
  let disposed = false;
  let revision = 0;
  let playingIntent = false;
  let finished = false;
  let settings = { ...options };
  const cleanup: Array<() => void> = [];
  const anchor = new MusicTimeAnchor();
  const session =
    options.createSession?.(document.chart, options) ??
    new ChartSession(document.chart, {
      mode: options.mode ?? "watch",
      judgementOffsetMs: options.settings?.judgementOffsetMs ?? 0,
    });
  const time = () => (clock?.timeMs ?? 0) - (document.bgmOffsetMs ?? 0);
  const cancelInput = () => {
    for (const point of input?.activePoints ?? []) session.cancel(point.pointerId);
  };
  const pause = () => {
    revision++;
    playingIntent = false;
    clock?.pause();
    cancelInput();
    cancelAnimationFrame(frame);
    frame = 0;
    event("playing", false);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revision++;
    playingIntent = false;
    signal.removeEventListener("abort", dispose);
    cancelAnimationFrame(frame);
    observer?.disconnect();
    input?.destroy();
    clock?.destroy();
    for (const release of cleanup.splice(0)) release();
    renderer?.dispose();
    anchor.reset();
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    // Register disposal before calling an asynchronous, caller-owned factory.
    renderer = await options.rendererAdapter!.create({ element, chart: document.chart, loader, signal });
    if (disposed || signal.aborted) {
      renderer.dispose();
      signal.throwIfAborted();
      throw new Error("Chart disposed");
    }
    clock = new MediaClock(document.audio, {
      volume: options.volume ?? 0.8,
      playbackRate: options.rate ?? 1,
      loop: options.loop ?? false,
    });
    const audio = clock.audio;
    const listen = (name: string, listener: () => void) => {
      audio.addEventListener(name, listener);
      cleanup.push(() => audio.removeEventListener(name, listener));
    };
    const render = () => {
      frame = 0;
      if (disposed) return;
      const current = time();
      anchor.sample(current, performance.now(), clock!.rate);
      const snapshot = finished ? session.snapshot() : session.updateReusable(current);
      if (disposed) return;
      try {
        renderer!.render(snapshot, settings);
      } catch (error) {
        pause();
        event("error", error);
        return;
      }
      if (disposed) return;
      event("timeupdate", clock!.timeMs / 1000);
      if (clock!.advancing) frame = requestAnimationFrame(render);
    };
    const request = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(render);
    };
    cleanup.push(session.on("judgement", (value) => event("judgement", value)));
    listen("playing", () => {
      if (!playingIntent) {
        clock!.pause();
        return;
      }
      event("playing", true);
      request();
    });
    listen("pause", () => {
      cancelInput();
      event("playing", false);
      request();
    });
    for (const name of ["waiting", "stalled"])
      listen(name, () => {
        cancelInput();
        event("playing", false);
        request();
      });
    listen("ended", () => {
      cancelInput();
      playingIntent = false;
      session.finish(Math.max(time(), document.chart.durationMs));
      finished = true;
      event("playing", false);
      request();
    });
    listen("seeking", () => {
      cancelInput();
      finished = false;
      session.reset(time());
      anchor.reset();
      request();
    });
    listen("seeked", () => {
      session.reset(time());
      request();
    });
    listen("durationchange", () => event("duration", clock!.durationMs / 1000));
    listen("error", () => {
      pause();
      event("error", new Error(audio.error?.message ?? "Audio could not be loaded"));
    });
    const visibility = () => {
      if (element.ownerDocument.visibilityState === "hidden") pause();
    };
    element.ownerDocument.addEventListener("visibilitychange", visibility);
    cleanup.push(() => element.ownerDocument.removeEventListener("visibilitychange", visibility));
    if (renderer.laneAtClientPoint) {
      const active = () => !disposed && settings.mode === "play" && clock!.advancing;
      input = new OurNotesInput(
        element,
        {
          tap: (point) => {
            if (active()) session.tap(point.lane, point.timeMs, point.pointerId);
          },
          move: (point) => {
            if (active()) session.trace(point.lane, point.timeMs, point.pointerId);
          },
          flick: (point) => {
            if (active())
              session.flick(point.previousLane, { dx: point.dx, dy: point.dy }, point.timeMs, point.pointerId);
          },
          release: (point) => {
            if (active()) session.release(point.lane, point.timeMs, point.pointerId);
            else session.cancel(point.pointerId);
          },
          cancel: (id) => session.cancel(id),
        },
        {
          laneAtClientPoint: (x, y) => renderer!.laneAtClientPoint!(x, y),
          eventTime: (value) => anchor.timeAt(normalizeEventRealtimeMs(value.timeStamp, performance.now()), time()),
        },
      );
    }
    const resize = () => {
      renderer!.resize(element.clientWidth, element.clientHeight, element.ownerDocument.defaultView!.devicePixelRatio);
      request();
    };
    observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    event("duration", Math.max(document.chart.durationMs + (document.bgmOffsetMs ?? 0), 0) / 1000);
    return {
      async play() {
        if (finished) {
          clock!.seek(0);
          session.reset(time());
          finished = false;
        }
        const intent = ++revision;
        playingIntent = true;
        try {
          await clock!.play();
        } catch (error) {
          if (revision === intent) playingIntent = false;
          throw error;
        }
        if (disposed || revision !== intent) {
          if (!playingIntent) clock!.pause();
          return;
        }
        request();
      },
      pause,
      seek(seconds) {
        cancelInput();
        finished = false;
        clock!.seek(seconds * 1000);
        session.reset(time());
        anchor.reset();
        request();
      },
      async setOptions(value) {
        const previousMode = settings.mode ?? "watch";
        settings = { ...settings, ...value };
        if (value.volume !== undefined) clock!.volume = value.volume;
        if (value.rate !== undefined) clock!.rate = value.rate;
        if (value.loop !== undefined) clock!.loop = value.loop;
        if (value.mode !== undefined && value.mode !== previousMode) {
          pause();
          session.setMode(value.mode);
        }
        if (value.settings?.judgementOffsetMs !== undefined) session.setOffset(value.settings.judgementOffsetMs);
        request();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
