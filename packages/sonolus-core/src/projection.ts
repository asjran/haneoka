import type {
  CatalogLocale,
  CatalogProjectionOptions,
  CatalogProjectionResult,
  ChartDescriptor,
  ChartPage,
  ChartRecord,
  JsonObject,
  JsonValue,
  LevelDetailsOptions,
  LevelInfoOptions,
  SonolusLevelItem,
  SonolusPlaylistItem,
} from "./types.js";

const DEFAULT_LOCALES: readonly CatalogLocale[] = ["ja", "en", "zh-TW", "zh-CN", "ko"];
const LOCALE_INDEX: Readonly<Record<CatalogLocale, number>> = Object.freeze({
  ja: 0,
  en: 1,
  "zh-TW": 2,
  "zh-CN": 3,
  ko: 4,
});
const DIFFICULTIES = ["easy", "normal", "hard", "expert", "special", "master"] as const;
const SONOLUS_NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

const randomSearch: JsonObject = Object.freeze({
  type: "random",
  title: "#RANDOM",
  icon: "shuffle",
  requireConfirmation: false,
  options: [],
});

function sonolusNamePart(value: string | number, label: string): string {
  const part = String(value).trim();
  if (!SONOLUS_NAME_PART.test(part)) throw new TypeError(`Invalid Sonolus ${label}: ${part}`);
  return part;
}

export function sonolusSourceRoot(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Sonolus source must be an absolute URL");
  }
  if (!(url.protocol === "http:" || url.protocol === "https:")) {
    throw new TypeError("Sonolus source must use HTTP(S)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Sonolus source must be an HTTP(S) server address without credentials, query or fragment");
  }
  return url.toString().replace(/\/+$/u, "");
}

export function sonolusLevelName(server: string, musicId: string | number, difficulty: string): string {
  const id = String(musicId).trim();
  if (!/^\d{1,16}$/u.test(id)) throw new TypeError(`Invalid Sonolus music ID: ${id}`);
  const level = difficulty.trim().toLocaleLowerCase("en-US");
  const name = `haneoka-${sonolusNamePart(server, "server")}-${id}-${sonolusNamePart(level, "difficulty")}`;
  if (name.length > 255) throw new TypeError("Sonolus level name is too long");
  return name;
}

export function sonolusPlaylistName(server: string, stableId: string | number, difficulty?: string): string {
  const suffix =
    difficulty === undefined ? "" : `-${sonolusNamePart(difficulty.trim().toLocaleLowerCase("en-US"), "difficulty")}`;
  const name = `haneoka-${sonolusNamePart(server, "server")}-${sonolusNamePart(stableId, "playlist ID")}${suffix}`;
  if (name.length > 255) throw new TypeError("Sonolus playlist name is too long");
  return name;
}

export function sonolusServerFromLevelName(name: string): string | null {
  const match = /^haneoka-(.+)-(\d+)-[A-Za-z0-9][A-Za-z0-9._~-]*$/u.exec(name);
  const server = match?.[1];
  return server && SONOLUS_NAME_PART.test(server) ? server : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
}

function jsonObject(value: unknown): JsonObject | null {
  return isObject(value) && Object.values(value).every(isJsonValue) ? (value as JsonObject) : null;
}

function localizedText(
  value: unknown,
  locales: readonly CatalogLocale[],
  encodeText?: CatalogProjectionOptions["encodeText"],
): string {
  if (typeof value === "string") return value.trim();
  if (encodeText && (Array.isArray(value) || isObject(value))) {
    const entries = Array.isArray(value)
      ? DEFAULT_LOCALES.map((locale) => [locale, value[LOCALE_INDEX[locale]]] as const)
      : Object.entries(value);
    const labels = Object.fromEntries(entries.filter(([, text]) => typeof text === "string" && Boolean(text.trim())));
    if (Object.keys(labels).length) return encodeText(labels, locales[0] ?? "en");
  }
  if (Array.isArray(value)) {
    for (const locale of locales) {
      const candidate = value[LOCALE_INDEX[locale]];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    const candidate = value.find((entry) => typeof entry === "string" && entry.trim());
    return typeof candidate === "string" ? candidate.trim() : "";
  }
  if (isObject(value)) {
    for (const locale of locales) {
      const candidate = value[locale];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    const candidate = Object.values(value).find((entry) => typeof entry === "string" && entry.trim());
    return typeof candidate === "string" ? candidate.trim() : "";
  }
  return "";
}

function recordEntries(value: unknown): Array<readonly [string, Record<string, unknown>]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => {
      if (!isObject(entry)) return [];
      const id = entry.musicId;
      return [[typeof id === "string" || typeof id === "number" ? String(id) : String(index), entry] as const];
    });
  }
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([id, entry]) => (isObject(entry) ? [[id, entry] as const] : []));
}

function absoluteUrl(value: unknown, baseUrl: string | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (!baseUrl || /^[a-z][a-z\d+.-]*:/iu.test(value)) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function difficultyName(value: Record<string, unknown>, index: number): string | null {
  if (typeof value.difficultyName === "string" && /^[a-z0-9-]+$/u.test(value.difficultyName)) {
    return value.difficultyName;
  }
  const numeric = typeof value.difficulty === "number" ? value.difficulty : index;
  return DIFFICULTIES[numeric] ?? null;
}

function rating(value: Record<string, unknown>): number | null {
  for (const candidate of [value.playLevel, value.displayLevel, value.rating]) {
    const number =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && candidate.trim()
          ? Number(candidate)
          : Number.NaN;
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function publishedAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const timestamp = publishedAt(entry);
      if (timestamp > 0) return timestamp;
    }
  }
  return 0;
}

function bandNames(value: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, band] of recordEntries(value)) {
    const id = typeof band.bandId === "number" || typeof band.bandId === "string" ? String(band.bandId) : key;
    const name = band.bandName ?? band.name;
    if (name) result.set(id, name);
  }
  return result;
}

function songArtists(
  song: Record<string, unknown>,
  bands: ReadonlyMap<string, unknown>,
  locales: readonly CatalogLocale[],
  encodeText?: CatalogProjectionOptions["encodeText"],
): string {
  if (encodeText) {
    const labels = Object.fromEntries(
      DEFAULT_LOCALES.map((locale) => [locale, songArtists(song, bands, [locale, ...locales])]),
    );
    return encodeText(labels, locales[0] ?? "en");
  }
  const ids = new Set<string>();
  if (typeof song.bandId === "number" || typeof song.bandId === "string") ids.add(String(song.bandId));
  for (const value of [song.bandIds, song.bandIDs]) {
    if (!Array.isArray(value)) continue;
    for (const id of value) if (typeof id === "number" || typeof id === "string") ids.add(String(id));
  }
  const names = [...ids].flatMap((id) => {
    const name = localizedText(bands.get(id), locales);
    return name ? [name] : [];
  });
  if (names.length) return [...new Set(names)].join(" / ");
  for (const value of [song.bandName, song.band, song.artist, song.composer, song.lyricist, song.arranger]) {
    const name = localizedText(value, locales);
    if (name) return name;
  }
  return "Unknown";
}

function projectedTags(base: JsonValue | undefined, difficulty: string): JsonValue[] {
  const tags = Array.isArray(base)
    ? base.filter((tag) => {
        if (!isObject(tag) || typeof tag.title !== "string") return true;
        return !DIFFICULTIES.includes(tag.title.toLocaleLowerCase() as (typeof DIFFICULTIES)[number]);
      })
    : [];
  return [...tags, { title: difficulty } as JsonObject];
}

function projectedSource(value: JsonValue, source: string, previousSource: string | undefined): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => projectedSource(entry, source, previousSource));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "source" && entry === previousSource ? source : projectedSource(entry, source, previousSource),
    ]),
  );
}

export function projectLevelItem(
  base: SonolusLevelItem,
  metadata: ChartDescriptor & { data: JsonObject; sonolusBaseUrl?: string },
): SonolusLevelItem {
  const projectedBase = metadata.sonolusBaseUrl
    ? (projectedSource(
        base,
        sonolusSourceRoot(metadata.sonolusBaseUrl),
        typeof base.source === "string" ? base.source : undefined,
      ) as SonolusLevelItem)
    : base;
  const cover = metadata.coverUrl ? { url: metadata.coverUrl } : projectedBase.cover;
  const bgm = metadata.bgmUrl ? { ...(jsonObject(projectedBase.bgm) ?? {}), url: metadata.bgmUrl } : projectedBase.bgm;
  const result: SonolusLevelItem = {
    ...projectedBase,
    name: metadata.name,
    rating: metadata.rating,
    title: metadata.title,
    artists: metadata.artists,
    author: metadata.author ?? metadata.artists,
    ...(metadata.sonolusBaseUrl ? { source: sonolusSourceRoot(metadata.sonolusBaseUrl) } : {}),
    data: metadata.data,
    tags: projectedTags(metadata.tags ?? projectedBase.tags, metadata.difficulty),
  };
  if (cover !== undefined) result.cover = cover;
  if (bgm !== undefined) result.bgm = bgm;
  return result;
}

export function projectCatalogCharts(
  songs: unknown,
  bands: unknown,
  options: CatalogProjectionOptions = {},
): CatalogProjectionResult {
  const locales = options.localeOrder?.length ? options.localeOrder : DEFAULT_LOCALES;
  const names = bandNames(bands);
  const charts: ChartDescriptor[] = [];
  const invalidChartNames: string[] = [];
  const makeName = options.levelName ?? ((songId: string, difficulty: string) => `chart-${songId}-${difficulty}`);
  const makeDataId =
    options.chartDataId ??
    ((_songId: string, _difficulty: string, rawDifficulty: Readonly<Record<string, unknown>>) =>
      typeof rawDifficulty.file === "string" && rawDifficulty.file.trim() ? rawDifficulty.file : null);
  for (const [catalogId, song] of recordEntries(songs)) {
    const rawSongId = song.musicId;
    const songId = typeof rawSongId === "number" || typeof rawSongId === "string" ? String(rawSongId) : catalogId;
    const title = localizedText(song.musicTitle ?? song.title, locales, options.encodeText) || `Song ${songId}`;
    const author = songArtists(song, names, locales);
    const artists = options.encodeText ? songArtists(song, names, locales, options.encodeText) : author;
    const difficulties = Array.isArray(song.difficulty) ? song.difficulty : [];
    for (const [index, rawDifficulty] of difficulties.entries()) {
      if (!isObject(rawDifficulty)) continue;
      const difficulty = difficultyName(rawDifficulty, index);
      const levelRating = rating(rawDifficulty);
      if (!difficulty || levelRating === null) continue;
      const name = makeName(songId, difficulty);
      const dataId = makeDataId(songId, difficulty, rawDifficulty);
      if (!dataId) {
        invalidChartNames.push(name);
        continue;
      }
      const coverUrl = absoluteUrl(song.jacketUrl ?? song.jacketThumbUrl, options.mediaBaseUrl);
      const bgmUrl = absoluteUrl(song.musicUrl, options.mediaBaseUrl);
      const metadata = {
        artists,
        ...(options.encodeText ? { author } : {}),
        dataId,
        difficulty,
        name,
        publishedAt: publishedAt(rawDifficulty.publishedAt ?? song.publishedAt),
        rating: levelRating,
        songId,
        title,
        ...(Array.isArray(song.tags) ? { tags: song.tags.filter(isJsonValue) } : {}),
        ...(coverUrl ? { coverUrl } : {}),
        ...(bgmUrl ? { bgmUrl } : {}),
      };
      charts.push(metadata);
    }
  }
  return { charts, invalidChartNames };
}

export function projectLevelInfo(charts: readonly ChartRecord[], options: LevelInfoOptions = {}): JsonObject {
  const count = Math.max(1, options.itemCount ?? 5);
  const hasRandomSection = options.randomCharts !== undefined;
  return {
    ...(options.title ? { title: options.title } : {}),
    creates: [],
    searches: hasRandomSection ? [] : [randomSearch],
    ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
    sections: [
      ...(hasRandomSection
        ? [
            {
              title: options.randomSectionTitle ?? "#RANDOM",
              icon: "shuffle",
              itemType: "level",
              items: options.randomCharts?.slice(0, count).map((chart) => chart.item) ?? [],
            },
          ]
        : []),
      {
        title: options.sectionTitle ?? "#NEWEST",
        itemType: "level",
        items: charts.slice(0, count).map((chart) => chart.item),
      },
    ],
  };
}

export function projectLevelList(
  page: ChartPage<ChartRecord>,
  options: Pick<LevelInfoOptions, "quickSearchValues" | "title"> = {},
): JsonObject {
  return {
    ...(options.title ? { title: options.title } : {}),
    pageCount: Math.max(0, page.pageCount),
    items: page.items.map((chart) => chart.item),
    searches: [],
    ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
  };
}

function templateSections(
  template: JsonObject | null | undefined,
  byName: ReadonlyMap<string, ChartRecord>,
): JsonObject[] {
  if (!Array.isArray(template?.sections)) return [];
  return template.sections.flatMap((rawSection) => {
    const section = jsonObject(rawSection);
    if (!section || !Array.isArray(section.items)) return [];
    const items = section.items.flatMap((rawItem) => {
      const item = jsonObject(rawItem);
      const chart = item && typeof item.name === "string" ? byName.get(item.name) : undefined;
      return chart ? [chart.item] : [];
    });
    return items.length ? [{ ...section, items }] : [];
  });
}

function recommendedCharts(chart: ChartRecord, charts: readonly ChartRecord[], count: number): ChartRecord[] {
  if (charts.length < 2 || count < 1) return [];
  const index = Math.max(
    0,
    charts.findIndex((candidate) => candidate.name === chart.name),
  );
  const result: ChartRecord[] = [];
  for (let offset = 1; offset < charts.length && result.length < count; offset += 1) {
    const candidate = charts[(index + offset) % charts.length];
    if (candidate && candidate.name !== chart.name) result.push(candidate);
  }
  return result;
}

export function projectLevelDetails(
  chart: ChartRecord,
  charts: readonly ChartRecord[],
  options: LevelDetailsOptions = {},
): JsonObject {
  const template = options.template ?? null;
  const byName = new Map(charts.map((candidate) => [candidate.name, candidate]));
  const inheritedSections = templateSections(template, byName);
  const recommendations = recommendedCharts(chart, charts, Math.max(0, options.recommendationCount ?? 5));
  const sections = inheritedSections.length
    ? inheritedSections
    : recommendations.length
      ? [
          {
            title: options.sectionTitle ?? "#RECOMMENDED",
            icon: "star",
            itemType: "level",
            items: recommendations.map((candidate) => candidate.item),
          } as JsonObject,
        ]
      : [];
  return {
    ...(template ?? {}),
    item: chart.item,
    actions: Array.isArray(template?.actions) ? template.actions : [],
    hasCommunity: typeof template?.hasCommunity === "boolean" ? template.hasCommunity : false,
    leaderboards: Array.isArray(template?.leaderboards) ? template.leaderboards : [],
    sections,
  };
}

export function projectRandomLevelInfo(chart: ChartRecord): JsonObject {
  return {
    title: "#RANDOM",
    creates: [],
    searches: [randomSearch],
    sections: [{ title: "#RANDOM", icon: "shuffle", itemType: "level", items: [chart.item] }],
  };
}

export function projectRandomLevelList(chart: ChartRecord): JsonObject {
  return { title: "#RANDOM", pageCount: 1, items: [chart.item], searches: [randomSearch] };
}

export function projectPlaylistItem(
  metadata: Pick<ChartDescriptor, "artists" | "songId" | "title"> & { name: string },
  charts: readonly ChartRecord[],
): SonolusPlaylistItem {
  const first = charts[0];
  const item: SonolusPlaylistItem = {
    author: "haneoka",
    levels: charts.map((chart) => chart.item),
    name: metadata.name,
    subtitle: metadata.artists,
    tags: [],
    title: metadata.title,
    version: 1,
  };
  if (typeof first?.item.source === "string" && first.item.source) item.source = first.item.source;
  const thumbnail = jsonObject(first?.item.cover);
  if (thumbnail) item.thumbnail = thumbnail;
  return item;
}

export function projectPlaylistInfo(
  playlists: readonly SonolusPlaylistItem[],
  randomPlaylists: readonly SonolusPlaylistItem[],
  itemCount = 5,
  options: Pick<LevelInfoOptions, "quickSearchValues" | "title"> = {},
): JsonObject {
  const count = Math.max(1, itemCount);
  return {
    ...(options.title ? { title: options.title } : {}),
    creates: [],
    searches: [],
    ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
    sections: [
      {
        title: "#RANDOM",
        icon: "shuffle",
        itemType: "playlist",
        items: randomPlaylists.slice(0, count),
      },
      {
        title: "#NEWEST",
        itemType: "playlist",
        items: playlists.slice(0, count),
      },
    ],
  };
}

export function projectPlaylistList(
  playlists: readonly SonolusPlaylistItem[],
  pageCount: number,
  options: Pick<LevelInfoOptions, "quickSearchValues" | "title"> = {},
): JsonObject {
  return {
    ...(options.title ? { title: options.title } : {}),
    pageCount: Math.max(0, pageCount),
    items: [...playlists],
    searches: [],
    ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
  };
}

export function projectPlaylistDetails(playlist: SonolusPlaylistItem): JsonObject {
  return {
    item: playlist,
    actions: [],
    hasCommunity: false,
    leaderboards: [],
    sections: [],
  };
}

export function projectServerInfo(options: { banner?: JsonObject } = {}): JsonObject {
  return {
    title: "haneoka",
    description: "BanG Dream! Our Notes",
    buttons: [
      { type: "playlist" },
      { type: "level" },
      { type: "playlist", title: "GBP Playlists", infoType: "bestdori" },
      { type: "level", title: "GBP Charts", infoType: "bestdori" },
      { type: "skin" },
      { type: "background" },
      { type: "effect" },
      { type: "particle" },
      { type: "engine" },
      { type: "configuration" },
    ],
    configuration: { options: [] },
    ...(options.banner ? { banner: options.banner } : {}),
  };
}
