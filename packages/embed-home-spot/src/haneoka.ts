import { haneokaDataSource } from "@haneoka/embed-core/haneoka";
import type { DataSource } from "@haneoka/embed-core";
import { mountHomeSpot } from "./mount.js";
import type { HomeSpotDocument, HomeSpotHandle, HomeSpotHostOptions } from "./types.js";

export interface HaneokaHomeSpotOptions extends HomeSpotHostOptions {
  readonly spotId: string | number;
  readonly apiBase?: string;
}

/** Selects one actual public scene from the current stories document. */
export function haneokaHomeSpotSource(options: {
  readonly spotId: string | number;
  readonly apiBase?: string;
}): DataSource<HomeSpotDocument> {
  const id = String(options.spotId);
  if (!id.trim()) throw new TypeError("spotId is required");
  return haneokaDataSource<HomeSpotDocument>({
    resource: "stories",
    ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
    decode(value) {
      const stories = value as { homeSpots?: Record<string, { spine?: HomeSpotDocument }> } | null;
      const spot = stories?.homeSpots && Object.hasOwn(stories.homeSpots, id) ? stories.homeSpots[id] : undefined;
      if (!spot?.spine) throw new Error(`Home Spot ${id} is unavailable`);
      return spot.spine;
    },
  });
}

export function mountHaneokaHomeSpot(host: HTMLElement, options: HaneokaHomeSpotOptions): HomeSpotHandle {
  return mountHomeSpot(host, {
    ...options,
    source: haneokaHomeSpotSource(options),
    server: options.server ?? "intl",
    fetcher(request) {
      const publicRequest = new Request(request, { referrerPolicy: "no-referrer" });
      return options.fetcher ? options.fetcher(publicRequest) : globalThis.fetch(publicRequest);
    },
  });
}
