import { LitElement, html, nothing, type PropertyValues } from "lit";
import { renderBrowse, clearBrowseBar, filterGroup } from "./ui/browse";
import { tile } from "./ui/tile";
import { segmented, iconButton, filterChip, inputChip } from "./ui/controls";
import { detailLayout } from "./ui/detail-layout";
import { errorState, loadingState } from "./ui/state";
import { icon } from "./ui/icon";
import { LazyImages } from "./ui/lazy-images";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { preferredLocale } from "./shared/catalog";
import { clientText } from "../i18n/client";
import { beginLoading } from "../lib/loading-progress";
import { setAppBarSearch } from "../lib/app-bar";
import { updateEntityHeading } from "../lib/detail-navigation";
import { snackbar } from "../lib/snackbar";
import "@material/web/slider/slider.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "../styles/sekai.css";

const MASTER = "https://sekai-world.github.io/sekai-master-db-diff";
const ASSETS = "https://storage.sekai.best/sekai-jp-assets";
const DIFFICULTIES = ["easy", "normal", "hard", "expert", "master", "append"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];
/** Unit tags in the game's own order; names are the units' official names. */
const UNITS: readonly (readonly [string, string])[] = [
  ["vocaloid", "VIRTUAL SINGER"],
  ["light_music_club", "Leo/need"],
  ["idol", "MORE MORE JUMP！"],
  ["street", "Vivid BAD SQUAD"],
  ["theme_park", "ワンダーランズ×ショウタイム"],
  ["school_refusal", "25時、ナイトコードで。"],
  ["other", "Other"],
];

interface SekaiMusic {
  id: number;
  title: string;
  lyricist: string;
  composer: string;
  arranger: string;
  assetbundleName: string;
  publishedAt: number;
  fillerSec: number;
}
interface SekaiSong extends SekaiMusic {
  units: string[];
  levels: Partial<Record<Difficulty, { level: number; notes: number }>>;
  vocals: { id: number; caption: string; asset: string }[];
}

let library: Promise<SekaiSong[]> | undefined;
/** Sekai Viewer's master data: one fetch per file, shared by both pages. */
function loadLibrary(): Promise<SekaiSong[]> {
  library ??= (async () => {
    const get = async <T>(name: string) => {
      const response = await fetch(`${MASTER}/${name}.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    };
    const [musics, difficulties, vocals, tags] = await Promise.all([
      get<SekaiMusic[]>("musics"),
      get<{ musicId: number; musicDifficulty: Difficulty; playLevel: number; totalNoteCount: number }[]>("musicDifficulties"),
      get<{ id: number; musicId: number; caption: string; assetbundleName: string; seq: number }[]>("musicVocals"),
      get<{ musicId: number; musicTag: string }[]>("musicTags"),
    ]);
    const now = Date.now();
    return musics
      .filter((music) => music.publishedAt <= now)
      .map((music) => ({
        ...music,
        units: tags.filter((tag) => tag.musicId === music.id && tag.musicTag !== "all").map((tag) => tag.musicTag),
        levels: Object.fromEntries(
          difficulties
            .filter((row) => row.musicId === music.id)
            .map((row) => [row.musicDifficulty, { level: row.playLevel, notes: row.totalNoteCount }]),
        ),
        vocals: vocals
          .filter((vocal) => vocal.musicId === music.id)
          .sort((a, b) => a.seq - b.seq)
          .map((vocal) => ({ id: vocal.id, caption: vocal.caption, asset: vocal.assetbundleName })),
      }))
      .sort((a, b) => b.publishedAt - a.publishedAt);
  })();
  library.catch(() => (library = undefined));
  return library;
}

const jacket = (song: SekaiMusic) => `${ASSETS}/music/jacket/${song.assetbundleName}/${song.assetbundleName}.webp`;
const scoreUrl = (song: SekaiMusic, difficulty: Difficulty) =>
  `${ASSETS}/music/music_score/${String(song.id).padStart(4, "0")}_01/${difficulty}.txt`;
const audioUrl = (asset: string) => `${ASSETS}/music/long/${asset}/${asset}.mp3`;
const SEARCH_OWNER = "sekai-songs";

/** Project Sekai songs from Sekai Viewer's data, charts shown with Cassiopeia. */
export class SekaiSongs extends LitElement {
  static properties = {
    locale: { type: String },
    mode: { type: String },
    phase: { state: true },
    query: { state: true },
    unit: { state: true },
    difficulty: { state: true },
    vocal: { state: true },
    playing: { state: true },
    time: { state: true },
    duration: { state: true },
    chartState: { state: true },
    filtersOpen: { state: true },
  };
  declare locale: string;
  declare mode: "list" | "detail";
  declare phase: "loading" | "ready" | "error";
  declare query: string;
  declare unit: string;
  declare difficulty: Difficulty;
  declare vocal: number;
  declare playing: boolean;
  declare time: number;
  declare duration: number;
  declare chartState: "idle" | "loading" | "ready" | "error";
  declare filtersOpen: boolean;
  private songs: SekaiSong[] = [];
  private song: SekaiSong | undefined;
  private readonly images = new LazyImages();
  private releaseSearch?: () => void;
  private preview?: import("@haneoka/cassiopeia-plugin-sekai/browser").SekaiPreviewHandle;
  private previewRun = 0;
  constructor() {
    super();
    this.locale = "ja";
    this.mode = "list";
    this.phase = "loading";
    this.query = "";
    this.unit = "";
    this.difficulty = "master";
    this.vocal = 0;
    this.playing = false;
    this.time = 0;
    this.duration = 0;
    this.chartState = "idle";
    this.filtersOpen = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    const params = new URLSearchParams(location.search);
    this.query = params.get("q") ?? "";
    this.unit = params.get("unit") ?? "";
    const difficulty = params.get("difficulty") as Difficulty | null;
    if (difficulty && DIFFICULTIES.includes(difficulty)) this.difficulty = difficulty;
    if (this.mode === "list")
      this.releaseSearch = setAppBarSearch(SEARCH_OWNER, {
        value: this.query,
        label: this.text("search", "Search songs"),
        onInput: (value) => {
          this.query = value;
          this.sync();
        },
      });
    void this.load();
  }
  disconnectedCallback() {
    this.releaseSearch?.();
    clearBrowseBar();
    this.images.disconnect();
    void this.preview?.dispose();
    super.disconnectedCallback();
  }
  protected updated(changed: PropertyValues) {
    this.images.observe(this);
    if (changed.has("difficulty") || changed.has("phase")) {
      const row = this.querySelector<HTMLElement>(".sekai-difficulty");
      const selected = row?.querySelector<HTMLElement>('[aria-checked="true"]');
      if (row && selected) row.scrollLeft = selected.offsetLeft - (row.clientWidth - selected.clientWidth) / 2;
    }
    if (this.mode === "detail" && this.song && (changed.has("difficulty") || changed.has("vocal") || changed.has("phase")))
      void this.mountPreview();
  }
  private text(key: string, fallback: string, values: Record<string, string | number> = {}) {
    return clientText(this.locale, `community.page.sekai.${key}`, fallback, values);
  }
  private async load() {
    const progress = beginLoading(clientText(this.locale, "common.states.loading", "Loading"), { scope: "owner" });
    try {
      this.songs = await loadLibrary();
      if (this.mode === "detail") {
        const id = Number(new URLSearchParams(location.search).get("song"));
        this.song = this.songs.find((song) => song.id === id);
        if (!this.song) throw new Error(this.text("notFound", "Song not found"));
        if (!this.song.levels[this.difficulty]) this.difficulty = "master";
        updateEntityHeading(this, this.song.title, "ja");
        document.title = `${this.song.title} · haneoka`;
      }
      this.phase = "ready";
      progress.finish();
    } catch (error) {
      this.phase = "error";
      progress.fail(error);
    }
  }
  private sync() {
    const params = new URLSearchParams(location.search);
    for (const [key, value] of [["q", this.query.trim()], ["unit", this.unit]] as const) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private visible() {
    const query = this.query.normalize("NFKC").toLowerCase().trim();
    return this.songs.filter(
      (song) =>
        (!this.unit || song.units.includes(this.unit)) &&
        (!query ||
          `${song.title} ${song.lyricist} ${song.composer} ${song.arranger}`.normalize("NFKC").toLowerCase().includes(query)),
    );
  }
  private detailHref(song: SekaiSong) {
    return `/${this.locale}/community/sekai/detail/?song=${song.id}`;
  }
  private setUnit(unit: string) {
    this.unit = unit;
    this.sync();
  }
  private renderList() {
    const rows = this.visible();
    return renderBrowse({
      kind: "sekai",
      count: { value: rows.length, label: this.text("songs", "Songs") },
      filters: {
        label: clientText(this.locale, "common.actions.filter", "Filter"),
        open: this.filtersOpen,
        count: this.unit ? 1 : 0,
        closeLabel: clientText(this.locale, "common.actions.close", "Close"),
        resetLabel: clientText(this.locale, "common.actions.reset", "Reset"),
        onOpen: () => (this.filtersOpen = true),
        onClose: () => (this.filtersOpen = false),
        onReset: () => this.setUnit(""),
        body: filterGroup(
          this.text("unit", "Unit"),
          html`<div class="cluster">${UNITS.map(([value, label]) => {
            const count = this.songs.filter((song) => song.units.includes(value)).length;
            return filterChip({ label, count, selected: this.unit === value, onToggle: () => this.setUnit(this.unit === value ? "" : value) });
          })}</div>`,
        ),
      },
      applied: this.unit
        ? [inputChip(UNITS.find(([value]) => value === this.unit)?.[1] ?? this.unit, clientText(this.locale, "common.actions.remove", "Remove"), () => this.setUnit(""))]
        : undefined,
      results: html`<div class="browse__results"><div class="collection collection--song">
        ${rows.map((song) =>
          tile({
            kind: "song",
            title: song.title,
            titleLanguage: "ja",
            subtitle: song.composer,
            label: song.title,
            image: jacket(song),
            width: 740,
            height: 740,
            href: this.detailHref(song),
            marks: [
              song.levels.master ? { at: "bottom-start", text: `MASTER ${song.levels.master.level}` } : null,
              song.levels.append ? { at: "bottom-end", text: `APPEND ${song.levels.append.level}` } : null,
            ],
          }),
        )}
      </div></div>`,
    });
  }
  private async mountPreview() {
    const song = this.song;
    const stage = this.querySelector<HTMLElement>(".sekai-stage");
    if (!song || !stage) return;
    const run = ++this.previewRun;
    await this.preview?.dispose();
    this.preview = undefined;
    this.playing = false;
    this.time = 0;
    stage.replaceChildren();
    this.chartState = "loading";
    try {
      const [{ mountSekaiPreview }, { sekaiDataSource }] = await Promise.all([
        import("@haneoka/cassiopeia-plugin-sekai/browser"),
        import("@haneoka/cassiopeia-plugin-sekai"),
      ]);
      const vocal = song.vocals[this.vocal] ?? song.vocals[0];
      if (!vocal) throw new Error(this.text("noAudio", "No audio"));
      const handle = await mountSekaiPreview(stage, {
        source: sekaiDataSource({
          sus: new URL(scoreUrl(song, this.difficulty)),
          audio: audioUrl(vocal.asset),
          bgmOffsetMs: song.fillerSec * 1000,
        }),
        label: `${song.title} ${this.difficulty.toUpperCase()}`,
        onTime: (seconds) => {
          this.time = seconds;
          this.duration = this.preview?.duration ?? this.duration;
          this.playing = this.preview?.playing ?? false;
        },
        onError: (error) => snackbar(String(error instanceof Error ? error.message : error), { error: true }),
      });
      if (run !== this.previewRun) {
        await handle.dispose();
        return;
      }
      this.preview = handle;
      this.duration = handle.duration;
      this.chartState = "ready";
    } catch (error) {
      if (run !== this.previewRun) return;
      this.chartState = "error";
      snackbar(this.text("chartError", "The chart could not be loaded"), { error: true });
      console.warn(error);
    }
  }
  private async toggle() {
    if (!this.preview) return;
    if (this.preview.playing) this.preview.pause();
    else await this.preview.play();
    this.playing = this.preview.playing;
    this.duration = this.preview.duration;
  }
  private renderDetail() {
    const song = this.song!;
    const format = (value: number) => {
      const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    };
    const media = html`
      <div class="sekai-player surface">
        <div class="sekai-stage" aria-busy=${this.chartState === "loading" ? "true" : "false"}></div>
        <div class="sekai-controls">
          ${iconButton({
            icon: this.playing ? "pause" : "play_arrow",
            label: this.playing ? this.text("pause", "Pause") : this.text("play", "Play"),
            disabled: this.chartState !== "ready",
            onClick: () => void this.toggle(),
          })}
          <md-slider
            class="md3-slider"
            min="0"
            max=${Math.max(1, Math.round(this.duration))}
            .value=${Math.round(this.time)}
            ?disabled=${this.chartState !== "ready"}
            aria-label=${this.text("position", "Position")}
            @change=${(event: Event) => this.preview?.seek(Number((event.target as HTMLInputElement).value))}
          ></md-slider>
          <span class="sekai-controls__time">${format(this.time)} / ${format(this.duration)}</span>
        </div>
      </div>
    `;
    const levels = DIFFICULTIES.filter((difficulty) => song.levels[difficulty]);
    const facts: [string, string][] = [
      [this.text("lyricist", "Lyrics"), song.lyricist],
      [this.text("composer", "Music"), song.composer],
      [this.text("arranger", "Arrangement"), song.arranger],
      [this.text("published", "Added"), new Date(song.publishedAt).toLocaleDateString(this.locale)],
    ];
    const level = song.levels[this.difficulty];
    return detailLayout(
      media,
      html`
        <section class="detail-section">
          ${renderDetailSectionHeading(this.text("chart", "Chart"), "difficulty")}
          <div class="sekai-difficulty">${segmented<Difficulty>({
            label: this.text("difficulty", "Difficulty"),
            value: this.difficulty,
            options: levels.map((difficulty) => ({
              value: difficulty,
              label: `${difficulty.toUpperCase()} ${song.levels[difficulty]!.level}`,
            })),
            onSelect: (difficulty) => {
              this.difficulty = difficulty;
              const params = new URLSearchParams(location.search);
              params.set("difficulty", difficulty);
              history.replaceState(history.state, "", `${location.pathname}?${params}`);
            },
          })}</div>
          ${level
            ? html`<dl class="spec-list spec-list--split spec-list--numeric">
                <div><dt>${this.text("level", "Level")}</dt><dd>${level.level}</dd></div>
                <div><dt>${this.text("notes", "Notes")}</dt><dd>${level.notes.toLocaleString(this.locale)}</dd></div>
              </dl>`
            : nothing}
          ${song.vocals.length > 1
            ? html`<md-outlined-select
                label=${this.text("vocal", "Vocal version")}
                .value=${String(this.vocal)}
                @change=${(event: Event) => (this.vocal = Number((event.target as HTMLInputElement).value))}
              >
                ${song.vocals.map(
                  (vocal, index) =>
                    html`<md-select-option value=${String(index)}><span slot="headline" lang="ja">${vocal.caption}</span></md-select-option>`,
                )}
              </md-outlined-select>`
            : nothing}
        </section>
        <section class="detail-section">
          ${renderDetailSectionHeading(this.text("details", "Details"), "details")}
          <div class="sekai-identity">
            <img src=${jacket(song)} alt="" width="96" height="96" loading="lazy" decoding="async" />
            <dl class="spec-list">
              ${facts.map(([label, value]) => html`<div><dt>${label}</dt><dd lang="ja">${value || "—"}</dd></div>`)}
            </dl>
          </div>
          <a class="button button--text" href=${`https://sekai.best/music/${song.id}`} target="_blank" rel="noreferrer">
            ${icon("open_in_new", 18)}Sekai Viewer
          </a>
        </section>
      `,
    );
  }
  render() {
    if (this.phase === "loading")
      return html`<section class="page sekai-songs">${loadingState(clientText(this.locale, "common.states.loading", "Loading"))}</section>`;
    if (this.phase === "error")
      return html`<section class="page sekai-songs">${errorState(
        clientText(this.locale, "common.states.unavailable", "Unavailable"),
        clientText(this.locale, "common.actions.retry", "Retry"),
        () => {
          this.phase = "loading";
          void this.load();
        },
      )}</section>`;
    return html`<section class="page sekai-songs">${this.mode === "detail" ? this.renderDetail() : this.renderList()}</section>`;
  }
}

if (!customElements.get("sekai-songs")) customElements.define("sekai-songs", SekaiSongs);
