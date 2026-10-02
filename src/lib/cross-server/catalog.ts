/** Browse-only associations. Inventory, progression and scoring keep their own server identity. */
export const OFFICIAL_CATALOG_SERVERS = ["jp", "intl"] as const;
export type OfficialCatalogServer = (typeof OFFICIAL_CATALOG_SERVERS)[number];
export type CrossCatalogResource = "cards" | "support-cards" | "songs" | "characters" | "bands" | "events";
export type CrossCatalogRow = Record<string, unknown>;
export interface CrossCatalogIdentity {
  server: OfficialCatalogServer;
  releaseId: string;
  sourceId: string;
}
export interface CrossCatalogSnapshot {
  identity: CrossCatalogIdentity;
  /** An absent collection is unknown, while an observed empty object is complete. */
  collections: Partial<Record<CrossCatalogResource, Record<string, CrossCatalogRow>>>;
}
export interface CrossCatalogVariant {
  identity: CrossCatalogIdentity;
  id: string;
  row: CrossCatalogRow;
  /** Present in this current catalogue; gameplay entitlement is not inferred. */
  available: true;
  releasedAt: unknown;
  href: string | null;
  assets: CrossCatalogRow;
}
export interface CrossCatalogEntry {
  key: string;
  resource: CrossCatalogResource;
  selectedServer: OfficialCatalogServer;
  displayServer: OfficialCatalogServer;
  inSelectedServer: boolean;
  perServer: Partial<Record<OfficialCatalogServer, CrossCatalogVariant>>;
  serverAvailability: Record<OfficialCatalogServer, boolean>;
  exclusive: OfficialCatalogServer | null;
  association: { status: "verified" | "independent" | "ambiguous"; evidence: string[]; reason?: string };
  /** Only entity-name slots may cross an established association. */
  nameOverrides: CrossCatalogRow;
  nameFallbacks: { field: string; slot: number; fromServer: OfficialCatalogServer }[];
  content: CrossServerContent;
}
export interface CrossServerContent {
  overrides: CrossCatalogRow;
  supplements: {
    field: string; value: unknown; fromServer: OfficialCatalogServer;
    identity: CrossCatalogIdentity; href: string | null;
    classification: "same-text-edition" | "recording-credit" | "source-asset" | "foreign-variant-content";
  }[];
  fields: { field: string; classification: "same-text-edition" | "recording-credit" | "source-asset" | "different-edition" | "server-variant" }[];
}
export interface CrossCatalogDTO {
  schema: "haneoka-cross-server-catalog-v1";
  resource: CrossCatalogResource;
  selectedServer: OfficialCatalogServer;
  locale: string;
  identities: Partial<Record<OfficialCatalogServer, CrossCatalogIdentity>>;
  sourceAvailability: Record<OfficialCatalogServer, "loaded" | "unavailable">;
  entries: CrossCatalogEntry[];
}
const object = (value: unknown): CrossCatalogRow =>
  value && typeof value === "object" && !Array.isArray(value) ? value as CrossCatalogRow : {};
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
};
const japanese = (value: unknown) => Array.isArray(value) ? text(value[0]) : null;
/** Server-qualified URLs are compared only as authored logical resource paths. */
function asset(value: unknown, server: OfficialCatalogServer): string | null {
  if (typeof value !== "string" || !value) return null;
  let pathname: string;
  try { pathname = new URL(value, "https://haneoka.org").pathname; } catch { return null; }
  for (const tree of ["assets", "runtime", "objects"]) {
    const prefix = `/${tree}/${server}/`;
    if (pathname.startsWith(prefix)) return `${tree}/${pathname.slice(prefix.length)}`;
  }
  return null;
}
type Signature = { key: string; evidence: string[] };
const signature = (parts: unknown[], evidence: string[]): Signature => ({ key: JSON.stringify(parts), evidence });
const rowId = (resource: CrossCatalogResource, row: CrossCatalogRow) =>
  row[{ cards: "cardId", "support-cards": "supportCardId", songs: "musicId", characters: "characterId", bands: "bandId", events: "id" }[resource]];
function bandSignature(row: CrossCatalogRow, server: OfficialCatalogServer): Signature | null {
  const name = japanese(row.bandName), logo = asset(row.logo, server), icon = asset(row.icon, server), color = text(row.color);
  return name && logo && icon && color
    ? signature(["band", name, logo, icon, color.toUpperCase()], ["authored-band-name", "native-band-logo-and-icon", "band-color"])
    : null;
}
function characterSignature(row: CrossCatalogRow, source: CrossCatalogSnapshot): Signature | null {
  const band = source.collections.bands?.[String(row.bandId)];
  const bandKey = band && bandSignature(band, source.identity.server);
  const name = japanese(row.characterName), slug = text(row.slug), face = asset(row.faceImage, source.identity.server);
  const birthday = object(row.birthday), part = text(row.bandPart), color = text(row.colorCode);
  if (!name || !slug || !face || !bandKey || !positive(birthday.month) || !positive(birthday.day) || !part || !color) return null;
  return signature(["character", name, slug, face, bandKey.key, birthday.month, birthday.day, part, color.toUpperCase()],
    ["authored-character-name-and-slug", "native-character-face", "corroborated-band", "birthday-and-instrument", "character-color"]);
}
function entitySignature(resource: CrossCatalogResource, row: CrossCatalogRow, source: CrossCatalogSnapshot): Signature | null {
  const server = source.identity.server;
  if (resource === "bands") return bandSignature(row, server);
  if (resource === "characters") return characterSignature(row, source);
  if (resource === "events") return null; // Event edition/window semantics require their own reviewed matcher.
  if (resource === "cards" || resource === "support-cards") {
    const assetId = row.assetId, rarity = row.rarity, attribute = row.cardType, image = asset(object(row.images).full, server);
    const prefix = japanese(row.prefix), raw = object(row.raw);
    const nativeTextKey = text(raw[resource === "cards" ? "_subtitleTextID" : "_descriptionTextID"]);
    const characters = resource === "cards" ? [row.characterId] : row.characterIds;
    if (!positive(assetId) || !positive(rarity) || !positive(attribute) || !image || !prefix || !Array.isArray(characters) || !characters.length) return null;
    const keys: string[] = [];
    for (const id of characters) {
      const character = source.collections.characters?.[String(id)];
      const key = character && characterSignature(character, source);
      if (!positive(id) || !key) return null;
      keys.push(key.key);
    }
    return signature([resource, assetId, image, [...new Set(keys)].sort(), rarity, attribute, prefix],
      ["native-card-asset-id", "native-full-art-path", "corroborated-character-set", "rarity-and-attribute", "authored-card-subtitle",
        ...(nativeTextKey ? [`native-text-key:${nativeTextKey}`] : [])]);
  }
  const sound = object(row.musicSound);
  const recordedPath = typeof sound.outputPath === "string" && sound.outputPath.startsWith("runtime/cri/sound/musicscore/") &&
    sound.binding === "exact-master-sound-cue-sheet-to-music-score-runtime-path" ? sound.outputPath : null;
  const recording = asset(row.musicUrl, server) ?? recordedPath;
  const jacket = asset(row.jacketUrl ?? row.jacketThumbUrl, server), title = japanese(row.musicTitle);
  const bands = Array.isArray(row.bandIds) ? row.bandIds : positive(row.bandId) ? [row.bandId] : [];
  if (!recording || !jacket || !title || !positive(row.musicType)) return null;
  const bandKeys: string[] = [];
  for (const id of bands) {
    const band = source.collections.bands?.[String(id)], key = band && bandSignature(band, server);
    if (!positive(id) || !key) return null;
    bandKeys.push(key.key);
  }
  if (!bandKeys.length) {
    // External artists use an authored Master text identifier, not an invented band-id 0.
    const artistKey = text(row.artistId), artistName = japanese(row.artistName ?? row.bandName);
    if (!artistKey || !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(artistKey) || !artistName) return null;
    bandKeys.push(JSON.stringify(["native-artist-text-key", artistKey, artistName]));
  }
  const vocals: string[] = [];
  if (Array.isArray(row.vocalCharacterIds)) for (const id of row.vocalCharacterIds) {
    const character = source.collections.characters?.[String(id)], key = character && characterSignature(character, source);
    if (!positive(id) || !key) return null;
    vocals.push(key.key);
  }
  const composer = japanese(row.composer), lyricist = japanese(row.lyricist);
  if (!composer || !lyricist) return null;
  return signature(["song", recording, jacket, title, [...new Set(bandKeys)].sort(), [...new Set(vocals)].sort(), row.musicType, composer, lyricist],
    ["native-recording-path", "native-jacket-path", "corroborated-band-or-native-artist", "corroborated-vocal-characters", "authored-title-and-credits", "native-music-type"]);
}
const NAME_FIELDS = ["prefix", "cardName", "musicTitle", "characterName", "bandName", "title", "name"];
function nameFallbacks(primary: CrossCatalogVariant, peer?: CrossCatalogVariant) {
  const overrides: CrossCatalogRow = {}, provenance: CrossCatalogEntry["nameFallbacks"] = [];
  if (peer) for (const field of NAME_FIELDS) {
    const value = primary.row[field], other = peer.row[field];
    if (!Array.isArray(value) || !Array.isArray(other)) continue;
    const slots = [...value];
    for (let slot = 0; slot < Math.min(5, other.length); slot++) {
      if (text(slots[slot]) || !text(other[slot])) continue;
      slots[slot] = other[slot];
      provenance.push({ field, slot, fromServer: peer.identity.server });
    }
    if (provenance.some((entry) => entry.field === field)) overrides[field] = slots;
  }
  return { overrides, provenance };
}
const EDITORIAL_TEXT_FIELDS = ["englishName", "nickname", "voiceActor", "description", "catchCopy", "height", "constellation",
  "school", "schoolClass", "favoriteFood", "hatedFood", "hobby", "diary", "composer", "lyricist", "arranger", "artistName"];
const MEDIA_FIELDS = ["image", "backgroundImage", "logo", "icon", "profileImage", "faceImage", "spriteImage", "thumbnailImage", "jacketUrl", "jacketThumbUrl"];
function sharedContent(resource: CrossCatalogResource, primary: CrossCatalogVariant, peer?: CrossCatalogVariant): CrossServerContent {
  const result: CrossServerContent = { overrides: {}, supplements: [], fields: [] };
  if (!peer) return result;
  const supplement = (field: string, value: unknown, classification: CrossServerContent["supplements"][number]["classification"]) =>
    result.supplements.push({ field, value: structuredClone(value), fromServer: peer.identity.server,
      identity: { ...peer.identity }, href: peer.href, classification });
  for (const field of EDITORIAL_TEXT_FIELDS) {
    const own = primary.row[field], other = peer.row[field];
    if (!Array.isArray(other)) continue;
    const ownJP = japanese(own), otherJP = japanese(other);
    const recordingCredit = resource === "songs" && ["composer", "lyricist", "arranger", "artistName"].includes(field);
    const sameEdition = !!ownJP && ownJP === otherJP;
    const classification = sameEdition ? "same-text-edition" : recordingCredit && !ownJP ? "recording-credit" : "different-edition";
    result.fields.push({ field, classification });
    if (classification === "different-edition") {
      if (other.some((slot) => text(slot))) supplement(field, other, "foreign-variant-content");
      continue;
    }
    const slots = Array.isArray(own) ? [...own] : [];
    let changed = false;
    for (let slot = 0; slot < Math.min(5, other.length); slot++) {
      if (text(slots[slot]) || !text(other[slot])) continue;
      slots[slot] = other[slot]; changed = true;
    }
    if (changed) {
      result.overrides[field] = slots;
      supplement(field, slots, classification);
    }
  }
  for (const field of MEDIA_FIELDS) {
    if (typeof peer.row[field] !== "string" || !peer.row[field]) continue;
    result.fields.push({ field, classification: "source-asset" });
    if (!primary.row[field]) {
      result.overrides[field] = peer.row[field];
      supplement(field, peer.row[field], "source-asset");
    }
  }
  const images = object(primary.row.images), foreignImages = object(peer.row.images), overlaid = { ...images };
  let imageChanged = false;
  for (const [key, value] of Object.entries(foreignImages)) if (!images[key] && typeof value === "string" && value) {
    overlaid[key] = value; imageChanged = true; supplement(`images.${key}`, value, "source-asset");
  }
  if (imageChanged) result.overrides.images = overlaid;
  // These fields can be inspected through the variant switch, never supplemented into another server.
  for (const field of ["stat", "difficulty", "resolvedSkills", "skillId", "liveSkillId", "leaderSkillId", "gekisouSkillId",
    "releasedAt", "publishedAt", "startAt", "endAt", "rewardGroups", "effects", "support", "characterId", "characterIds", "bandId", "bandIds",
    "musicUrl", "mvUrl", "musicVideos", "diarySound", "movies"])
    if (primary.row[field] !== undefined || peer.row[field] !== undefined) result.fields.push({ field, classification: "server-variant" });
  for (const field of ["musicUrl", "mvUrl", "musicVideos", "diarySound", "movies"])
    if (!primary.row[field] && peer.row[field]) supplement(field, peer.row[field], "foreign-variant-content");
  return result;
}
function href(resource: CrossCatalogResource, server: OfficialCatalogServer, locale: string, id: string): string | null {
  const kind = resource === "cards" ? "member-cards" : resource;
  if (kind === "bands") return null; // A band is dependency data; no fictitious band detail route.
  return `/${server}/${locale}/${kind}/${encodeURIComponent(id)}/`;
}
function assets(row: CrossCatalogRow): CrossCatalogRow {
  const result: CrossCatalogRow = {};
  for (const field of ["images", "image", "backgroundImage", "logo", "icon", "profileImage", "faceImage", "spriteImage",
    "thumbnailImage", "jacketUrl", "jacketThumbUrl", "musicUrl", "mvUrl"])
    if (row[field] !== undefined) result[field] = structuredClone(row[field]);
  return result;
}

/** Full signature buckets, never numeric-id or title joins. Ambiguous buckets remain separate. */
export function mergeCrossServerCatalog(
  snapshots: readonly CrossCatalogSnapshot[], resource: CrossCatalogResource,
  options: { selectedServer: OfficialCatalogServer; locale: string },
): CrossCatalogDTO {
  if (!OFFICIAL_CATALOG_SERVERS.includes(options.selectedServer) || !/^[A-Za-z0-9-]+$/u.test(options.locale))
    throw new Error("Invalid cross-server view");
  const identities: CrossCatalogDTO["identities"] = {}, availability: CrossCatalogDTO["sourceAvailability"] = { jp: "unavailable", intl: "unavailable" };
  const buckets = new Map<string, { jp: CrossCatalogVariant[]; intl: CrossCatalogVariant[]; signature: Signature | null }>();
  for (const source of snapshots) {
    const identity = source.identity, server = identity.server;
    if (!OFFICIAL_CATALOG_SERVERS.includes(server) || identities[server] || !/^r-[a-f0-9]{20}$/u.test(identity.releaseId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(identity.sourceId)) throw new Error("Invalid or repeated cross-server source pin");
    identities[server] = { ...identity };
    const collection = source.collections[resource];
    if (!collection) continue;
    availability[server] = "loaded";
    for (const [id, original] of Object.entries(collection)) {
      const row = structuredClone(original), ownId = rowId(resource, row);
      if (ownId !== undefined && String(ownId) !== id) throw new Error(`Cross-server row identity mismatch:${server}/${resource}/${id}`);
      const sig = entitySignature(resource, row, source), key = sig?.key ?? `independent:${server}:${id}`;
      const bucket = buckets.get(key) ?? { jp: [], intl: [], signature: sig };
      bucket[server].push({ identity: { ...identity }, id, row, available: true,
        releasedAt: structuredClone(row.releasedAt ?? row.publishedAt ?? null), href: href(resource, server, options.locale, id), assets: assets(row) });
      buckets.set(key, bucket);
    }
  }
  const entries: CrossCatalogEntry[] = [];
  const complete = availability.jp === "loaded" && availability.intl === "loaded";
  function add(variants: CrossCatalogVariant[], sig: Signature | null, ambiguous: boolean) {
    const perServer: CrossCatalogEntry["perServer"] = {};
    for (const variant of variants) perServer[variant.identity.server] = variant;
    const selected = perServer[options.selectedServer], display = selected ?? variants[0]!;
    const peer = variants.find((variant) => variant.identity.server !== display.identity.server);
    const names = nameFallbacks(display, peer);
    const both = variants.length === 2;
    // The full signature is the key, so hash collisions cannot collapse entities.
    const key = both ? `${resource}:shared:${sig!.key}` : `${resource}:${display.identity.server}:${display.id}`;
    entries.push({ key, resource, selectedServer: options.selectedServer, displayServer: display.identity.server,
      inSelectedServer: !!selected, perServer, serverAvailability: { jp: !!perServer.jp, intl: !!perServer.intl },
      exclusive: !both && complete && sig && !ambiguous ? display.identity.server : null,
      association: { status: both ? "verified" : ambiguous ? "ambiguous" : "independent", evidence: sig?.evidence ?? [],
        ...(!both ? { reason: ambiguous ? "multiple-candidates-with-the-same-signature" : sig ? "no-peer-with-corroborated-signature" : "insufficient-identity-evidence" } : {}) },
      nameOverrides: names.overrides, nameFallbacks: names.provenance, content: sharedContent(resource, display, peer) });
  }
  for (const bucket of buckets.values()) {
    if (bucket.signature && bucket.jp.length === 1 && bucket.intl.length === 1) add([bucket.jp[0]!, bucket.intl[0]!], bucket.signature, false);
    else {
      const ambiguous = bucket.jp.length > 1 || bucket.intl.length > 1;
      for (const variant of [...bucket.jp, ...bucket.intl]) add([variant], bucket.signature, ambiguous);
    }
  }
  return { schema: "haneoka-cross-server-catalog-v1", resource, selectedServer: options.selectedServer, locale: options.locale,
    identities, sourceAvailability: availability, entries };
}
/** UI-only text fallback; skills, dates, assets and every other field come from the display variant. */
export function crossServerDisplayRow(entry: CrossCatalogEntry): CrossCatalogRow {
  const variant = entry.perServer[entry.displayServer];
  if (!variant) throw new Error("Cross-server display variant missing");
  return { ...structuredClone(variant.row), ...structuredClone(entry.nameOverrides), ...structuredClone(entry.content.overrides) };
}
/** Calculation/ownership callers must use this accessor, never the display fallback. */
export function crossServerSelectedVariant(entry: CrossCatalogEntry): CrossCatalogVariant | null {
  return entry.perServer[entry.selectedServer] ?? null;
}
/** A unified detail can switch variants without changing the global inventory/scoring server. */
export function crossServerDetail(entry: CrossCatalogEntry, activeServer = entry.displayServer) {
  const variant = entry.perServer[activeServer];
  if (!variant) throw new Error("Requested cross-server variant is unavailable");
  const peer = entry.perServer[activeServer === "jp" ? "intl" : "jp"];
  const names = nameFallbacks(variant, peer), content = sharedContent(entry.resource, variant, peer);
  return {
    schema: "haneoka-cross-server-detail-v1", key: entry.key, resource: entry.resource,
    selectedServer: entry.selectedServer, activeServer, identity: { ...variant.identity },
    row: { ...structuredClone(variant.row), ...names.overrides, ...content.overrides },
    perServer: entry.perServer, serverAvailability: entry.serverAvailability,
    href: variant.href, nameFallbacks: names.provenance, content,
    ownershipVariant: activeServer === entry.selectedServer ? variant : null,
  };
}
