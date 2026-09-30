type StoryRecord = Record<string, unknown>;

const image = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === "string" && Boolean(value.trim())) || "";

export function spotArtwork(spot: StoryRecord | undefined | null): string {
  const spine = spot?.spine && typeof spot.spine === "object" ? (spot.spine as StoryRecord) : undefined;
  return image(spot?.thumbnail, spine?.backgroundPreview, spot?.backgroundPreview);
}

export function episodeArtwork(episode: StoryRecord, chapter?: StoryRecord): string {
  const cards =
    episode.cardImages && typeof episode.cardImages === "object" ? (episode.cardImages as StoryRecord) : undefined;
  return image(
    episode.episodeImage,
    episode.banner,
    episode.image,
    episode.thumbnail,
    episode.cardImage,
    cards?.normal,
    chapter?.banner,
  );
}
