import { html } from "lit";
import { icon } from "../ui/icon";
import type { TileMark, TileOptions } from "../ui/tile";

type Episode = Record<string, unknown>;
export interface StoryTileOptions extends Omit<TileOptions, "kind" | "label" | "marks" | "placeholder"> {
  title: string;
  bandIcon?: string;
  duration?: string;
}

/** The story catalog's tile construction, shared with linked event episodes. */
export function storyTile(
  episode: Episode,
  options: StoryTileOptions,
  extraMarks: ReadonlyArray<TileMark | null> = [],
): TileOptions {
  const { bandIcon, duration, ...base } = options;
  return {
    ...base,
    kind: "story",
    label: options.title,
    aspectRatio: "16 / 9",
    adornment: bandIcon
      ? html`
          <img src=${bandIcon} alt="" width="16" height="16" loading="lazy" />
        `
      : undefined,
    placeholder: icon("auto_stories", 32),
    marks: [
      episode.episodeNumber ? { at: "start", text: `#${String(episode.episodeNumber).padStart(2, "0")}` } : null,
      duration ? { at: "bottom-end", text: duration } : null,
      ...extraMarks,
    ],
  };
}
