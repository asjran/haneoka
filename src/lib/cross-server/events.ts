import type { CrossCatalogRow, CrossCatalogSnapshot, CrossCatalogVariant, CrossServerContent, OfficialCatalogServer } from "./catalog";

type Signature = { key: string; evidence: string[] };
export interface EventIdentityHelpers {
  asset(value: unknown, server: OfficialCatalogServer): string | null;
  japanese(value: unknown): string | null;
  band(row: CrossCatalogRow, server: OfficialCatalogServer): Signature | null;
  character(row: CrossCatalogRow, source: CrossCatalogSnapshot): Signature | null;
}
const object = (value: unknown): CrossCatalogRow => value && typeof value === "object" && !Array.isArray(value) ? value as CrossCatalogRow : {};
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Event edition identity uses authored art, a typed chapter relation and native story topology.
 * Regional times, payouts and numeric event ids are not identity evidence.
 * This verifies metadata-text edition; opaque scenario/audio payloads retain their source variant.
 */
export function eventEditionSignature(row: CrossCatalogRow, source: CrossCatalogSnapshot, helpers: EventIdentityHelpers): Signature | null {
  if (row.kind !== "game-event" || !positive(row.eventType) || !positive(row.storyChapterId)) return null;
  const server = source.identity.server, story = object(row.story);
  if (story.chapterId !== row.storyChapterId || !Array.isArray(story.episodes) || !story.episodes.length) return null;
  const title = helpers.japanese(row.title), chapterName = helpers.japanese(story.chapterName);
  const logo = helpers.asset(row.logo, server), background = helpers.asset(row.backgroundImage, server), banner = helpers.asset(story.banner ?? story.image, server);
  const band = source.collections.bands?.[String(story.bandId)], bandKey = band && helpers.band(band, server);
  if (!title || !chapterName || !logo || !background || !banner || !bandKey || !Array.isArray(story.description)) return null;
  const episodes: unknown[][] = [], keys = new Set<string>();
  let participantsObserved = false;
  for (const value of story.episodes) {
    const episode = object(value), key = episode.storyKey ?? episode.storyId;
    if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]+$/u.test(key) || keys.has(key) ||
        episode.chapterId !== story.chapterId || !positive(episode.episodeNumber) || !Array.isArray(episode.description) ||
        typeof episode.isAnotherEpisode !== "boolean" || typeof episode.isExtraEpisode !== "boolean") return null;
    keys.add(key);
    const name = helpers.japanese(episode.title);
    if (!name) return null;
    const participants: string[] = [];
    const ids = episode.characterIds ?? episode.mainCharacterIds;
    if (ids !== undefined) {
      if (!Array.isArray(ids)) return null;
      for (const id of ids) {
        const character = source.collections.characters?.[String(id)], sig = character && helpers.character(character, source);
        if (!positive(id) || !sig) return null;
        participants.push(sig.key);
      }
      participantsObserved ||= ids.length > 0;
    }
    episodes.push([key, episode.episodeNumber, episode.isAnotherEpisode === true, episode.isExtraEpisode === true,
      name, helpers.japanese(episode.description) ?? "", [...new Set(participants)].sort()]);
  }
  episodes.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return {
    key: JSON.stringify(["native-event-edition", row.eventType, title, logo, background, banner, chapterName,
      helpers.japanese(story.description) ?? "", bandKey.key, episodes]),
    evidence: ["native-event-type", "native-event-logo-background-and-story-banner", "typed-MasterEvent-story-chapter",
      "native-story-episode-key-set", "Japanese-original-metadata-text-edition", "corroborated-story-band",
      ...(participantsObserved ? ["corroborated-participant-characters"] : [])],
  };
}

/** Only text slots are supplemented. Episode unlocks, resource rewards and windows stay primary. */
export function sharedEventStoryContent(primary: CrossCatalogVariant, peer: CrossCatalogVariant, japanese: EventIdentityHelpers["japanese"]): CrossServerContent {
  const output: CrossServerContent = { overrides: {}, fields: [], supplements: [] };
  const own = object(primary.row.story), other = object(peer.row.story);
  if (!Object.keys(own).length || !Object.keys(other).length) return output;
  const story = structuredClone(own);
  let changed = false;
  const fill = (target: CrossCatalogRow, foreign: CrossCatalogRow, field: string, path: string) => {
    const value = target[field], source = foreign[field];
    if (!Array.isArray(value) || !Array.isArray(source) || !japanese(value) || japanese(value) !== japanese(source)) {
      if (Array.isArray(source) && source.some((slot) => typeof slot === "string" && slot.trim())) {
        output.fields.push({ field: path, classification: "different-edition" });
        output.supplements.push({ field: path, value: structuredClone(source), classification: "foreign-variant-content",
          fromServer: peer.identity.server, identity: { ...peer.identity }, href: peer.href });
      }
      return;
    }
    output.fields.push({ field: path, classification: "same-text-edition" });
    const slots = [...value];
    let filled = false;
    for (let index = 0; index < Math.min(5, source.length); index++)
      if (!(typeof slots[index] === "string" && slots[index].trim()) && typeof source[index] === "string" && source[index].trim()) {
        slots[index] = source[index]; filled = true;
      }
    if (filled) {
      target[field] = slots; changed = true;
      output.supplements.push({ field: path, value: slots, classification: "same-text-edition", fromServer: peer.identity.server,
        identity: { ...peer.identity }, href: peer.href });
    }
  };
  fill(story, other, "chapterName", "story.chapterName");
  fill(story, other, "description", "story.description");
  if (object(story.bandDetails).bandId === story.bandId && object(other.bandDetails).bandId === other.bandId)
    fill(object(story.bandDetails), object(other.bandDetails), "bandName", "story.bandDetails.bandName");
  if (Array.isArray(story.episodes) && Array.isArray(other.episodes)) {
    const peers = new Map(other.episodes.map((value) => { const row = object(value); return [row.storyKey ?? row.storyId, row] as const; }));
    for (const value of story.episodes) {
      const episode = object(value), key = episode.storyKey ?? episode.storyId, foreign = peers.get(key);
      if (!foreign) continue;
      fill(episode, foreign, "title", `story.episodes.${key}.title`);
      fill(episode, foreign, "description", `story.episodes.${key}.description`);
      fill(episode, foreign, "chapterName", `story.episodes.${key}.chapterName`);
    }
  }
  if (changed) output.overrides.story = story;
  for (const field of ["story.episodes.unlockEpisodeNumber", "story.episodes.eventPoint", "story.episodes.rewardTracks", "story.episodes.playTime",
    "story.episodes.script", "story.episodes.scenario", "story.episodes.assets", "story.episodes.audio"])
    output.fields.push({ field, classification: "server-variant" });
  return output;
}
