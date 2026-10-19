import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/progress/linear-progress.js";
import type { TeamBuilder } from "../team-builder";
import type { EngineRequest, SongRef } from "../../lib/team-builder/engine/api";
import { validatePtRequest, type PtIssue } from "../../lib/team-builder/engine/pt-eligibility";
import {
  canonical,
  createPtJob,
  digest,
  ptComplete,
  ptAllComplete,
  ptChallengeBest,
  ptFingerprint,
  PtRunner,
  ptSongRanking,
  type PtJob,
  type PtCycleInput,
  type PtMeasure,
  type PtScope,
} from "../../lib/team-builder/pt-recommendation";
import { improvementPercent, pendingSong } from "../../lib/team-builder/engine/execution";
import { PtCheckpoint } from "../../lib/team-builder/pt-checkpoint";
import { compareTable, renderHit } from "./results";
import { renderBuildTab, renderCandidates } from "./build-tab";
import { sectionHeading } from "./catalog";
import { boostControl } from "./boost-control";
import type { SongPickerState } from "./song-picker";
import { segmented } from "../ui/controls";
import { icon } from "../ui/icon";
import { issueField, ptField } from "./pt-fields";

export class PtController {
  private task: symbol | null = null;
  job: PtJob | null = null;
  running = false;
  showAll = false;
  get measure(): PtMeasure {
    return this.host.settings.measure === "items" ? "items" : "points";
  }
  set measure(measure: PtMeasure) {
    this.host.updateSettings({ measure });
  }
  storageError = false;
  error = "";
  dataFingerprint = "";
  showIssues = false;
  issues: PtIssue[] = [];
  correcting = false;
  async focusIssue(issue: PtIssue) {
    const field = issueField(issue);
    if (!field) return;
    this.correcting = true;
    const host = this.host;
    const card = /^(m|s)(\d+)\./u.exec(field);
    if (card) {
      host.tab = "pt";
      host.editing = { kind: card[1] === "m" ? "members" : "snaps", cardId: Number(card[2]) };
    } else host.tab = /^(cr|bi|p)\./u.test(field) ? "account" : field === "inventory" ? "box" : "pt";
    if (field === "constraints" || field === "minBonus") host.expanded.add("candidates");
    host.requestUpdate();
    await host.updateComplete;
    const target = host.querySelector<HTMLElement>(`[data-pt-field="${CSS.escape(field)}"]`);
    if (!target) return;
    const disclosures: HTMLDetailsElement[] = [];
    for (let parent = target.parentElement; parent && parent !== host; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement && !parent.open) {
        parent.open = true;
        disclosures.push(parent);
      }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    target.getBoundingClientRect();
    await Promise.allSettled(
      disclosures.flatMap((node) => node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    target.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    const control = target.querySelector<HTMLElement>(
      "input, md-outlined-text-field, md-outlined-select, md-slider, button:not([disabled]), md-checkbox",
    );
    if (control && "updateComplete" in control) await control.updateComplete;
    (control ?? target).focus({ preventScroll: true });
  }
  markFields() {
    for (const field of this.host.querySelectorAll<HTMLElement>("[data-pt-field]")) {
      const invalid = field.classList.contains("pt-field--invalid");
      for (const control of field.querySelectorAll<HTMLElement>(
        "input, md-outlined-text-field, md-outlined-select, md-checkbox",
      ))
        control.ariaInvalid = invalid ? "true" : null;
    }
  }
  private signature = "";
  private restoreKey = "";
  private generation = 0;
  private runner: PtRunner | null = null;
  private readonly store = new PtCheckpoint();
  constructor(private readonly host: TeamBuilder) {}
  private get owner() {
    return this.host.snapshot?.owner ?? "local";
  }
  request(): EngineRequest | null {
    const { view, settings: s } = this.host;
    if (!view) return null;
    const request = this.host.request({
      kind: "event",
      ranking: "pt-only",
      measure: this.measure,
      route: "live",
      eventId: s.eventId ?? -1,
      songs: [...s.songs].sort((a, b) => a.songId - b.songId || a.difficulty - b.difficulty),
      consumption: s.boosts,
      play: { great: 0, good: 0, bad: 0, miss: 0 },
      ...(s.ptMode === "gekiso"
        ? { gekiso: { just: s.ptJust / 100, luckSamples: s.ptLuckSamples, rank: 1 as const } }
        : {}),
    });
    if (!request) return null;
    return {
      ...request,
      snaps: s.noSnaps ? [] : request.snaps,
      unknownPolicy: "min",
      player: {
        ...structuredClone(view.player),
        characterMemory: Object.fromEntries([...(this.host.master?.characters.keys() ?? [])].map(id => [id, 0])),
        musicMemory: Object.fromEntries([...(this.host.master?.songs.keys() ?? [])].map(id => [id, 0])),
      },
      k: 1,
      timeLimitMs: 3000,
    };
  }
  cycle(): PtCycleInput | null {
    if (!this.host.settings.ptCycle) return null;
    return {
      songs: [...this.host.settings.planChallengeSongs].sort(
        (a, b) => a.songId - b.songId || a.difficulty - b.difficulty,
      ),
      consumption: this.host.settings.challengePoints,
    };
  }
  private inputSignature() {
    return canonical([this.request(), this.cycle(), this.owner, this.host.data?.identity]);
  }
  sync() {
    const request = this.request();
    const signature = this.inputSignature();
    if (signature !== this.signature) {
      if (this.running) this.stop();
      this.signature = signature;
      this.issues = [];
      if (request?.goal.kind === "event" && this.host.master) {
        for (const route of (this.cycle() ? ["live", "challenge"] : ["live"]) as ("live" | "challenge")[])
          for (const measure of [this.measure]) {
            const goal = { ...request.goal, route, measure };
            if (route === "live") goal.cpExchange = { numerator: 0, denominator: 1 };
            else {
              goal.songs = this.cycle()!.songs;
              goal.consumption = this.cycle()!.consumption;
              delete goal.gekiso;
            }
            this.issues.push(...validatePtRequest(this.host.master, { ...request, goal }));
          }
        if (this.cycle() && !this.cycle()!.songs.length) this.issues.push({ code: "chart", target: "challenge-selection" });
        this.issues = [...new Map(this.issues.map((issue) => [`${issue.code}:${issue.target}`, issue])).values()];
      }
    }
  }
  get stale() {
    return (
      !!this.job &&
      (canonical([this.job.request, this.job.cycle, this.job.owner, this.host.data?.identity]) !== this.inputSignature() ||
        this.job.owner !== this.owner ||
        this.job.dataFingerprint !== this.dataFingerprint)
    );
  }
  async restore() {
    const data = this.host.data;
    if (!data || this.host.snapshot?.owner === undefined) return;
    const key = `${data.identity.server}|${this.owner}|${data.identity.releaseId}`;
    if (key === this.restoreKey) return;
    this.restoreKey = key;
    const generation = ++this.generation;
    const owner = this.owner;
    let hash = "";
    try {
      hash = await digest(data);
      const job = await this.store.latest(data.identity.server, owner);
      if (generation !== this.generation) return;
      for (const task of job?.tasks ?? []) if (task.status === "running") task.status = "queued";
      this.dataFingerprint = hash;
      this.job = job;
    } catch {
      if (generation !== this.generation) return;
      this.dataFingerprint = hash;
      this.storageError = true;
      if (!hash) this.error = "pt-data-fingerprint";
    }
    this.host.requestUpdate();
  }
  stop() {
    ++this.generation;
    if (this.task && this.host.ownsTask(this.task)) {
      this.runner?.stop();
    }
    this.host.requestUpdate();
  }
  dispose() {
    this.correcting = false;
    ++this.generation;
    this.stop();
    this.task = null;
    this.running = false;
    this.job = null;
    this.restoreKey = "";
  }
  async start(resume: boolean, scope?: PtScope) {
    // Results stream in as they are found; the search runs until every song is proven or it is stopped.
    const deadline = Infinity;
    this.sync();
    const host = this.host;
    if (this.issues.length) {
      this.showIssues = true;
      host.requestUpdate();
      await host.updateComplete;
      host.querySelector<HTMLElement>("#pt-issues")?.focus();
      return;
    }
    const request = this.request();
    if (
      !request ||
      !host.engine ||
      !host.data ||
      host.running ||
      host.manualBusy ||
      this.issues.length ||
      !this.dataFingerprint
    )
      return;
    const task = host.acquireTask("pt");
    if (!task) return;
    this.task = task;
    const generation = this.generation;
    const cycle = this.cycle();
    const signature = this.inputSignature();
    this.running = host.running = true;
    this.error = "";
    host.requestUpdate();
    try {
      let job = this.job;
      const fingerprint = await ptFingerprint(request, this.dataFingerprint, this.owner, cycle);
      if (!resume || !job || job.fingerprint !== fingerprint) {
        if (resume) throw new Error("pt-input-changed");
        job = await createPtJob(
          request,
          {
            server: host.data.identity.server,
            releaseId: host.data.identity.releaseId,
            sourceId: host.data.identity.sourceId ?? "",
            owner: this.owner,
            dataFingerprint: this.dataFingerprint,
            assumptions: [],
          },
          cycle,
        );
      }
      if (generation !== this.generation || signature !== this.inputSignature()) return;
      this.job = job;
      this.runner = new PtRunner(
        host.engine,
        this.store,
        (next) => {
          if (generation !== this.generation || signature !== this.inputSignature()) return;
          this.job = next;
          host.requestUpdate();
        },
        () => {
          if (generation === this.generation) {
            this.storageError = true;
            host.requestUpdate();
          }
        },
      );
      await this.runner.run(job, scope, deadline);
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.task === task) { this.running = false; this.task = null; }
      host.releaseTask(task);
      host.requestUpdate();
    }
  }
}

function inputLabel(host: TeamBuilder, target: string): string {
  const [key = "", field = ""] = target.split(".");
  const catalog = host.catalog!;
  const titles: Record<string, string> = {
    "p.vip": host.t("vipRank", "T.G.W card rank"),
    "five-characters": host.t("pt.fiveCharacters", "At least five different characters"),
    selection: host.t("chooseSongs", "Choose songs"),
    "challenge-selection": host.t("pt.chooseChallenge", "Challenge songs"),
    tables: host.t("pt.eventTables", "Event consumption tables"),
    consumption: host.t("boosts", "Boosts per live"),
    "challenge-consumption": host.t("pt.challengeCost", "CP per challenge"),
    "gekiso-input": host.t("pt.gekiso", "Gekisou"),
    minBonus: host.t("minBonus", "Minimum event bonus (%)"),
    member: host.t("members", "Members"),
    snap: host.t("snapshots", "Snapshots"),
    "required-members": host.t("pt.requiredMembers", "Required members share a character"),
    "photo-bindings": host.t("pt.photoBindings", "A snapshot is bound twice"),
  };
  if (titles[target]) return titles[target];
  const fields: Record<string, string> = {
    level: host.t("level", "Level"),
    awake: host.t("training", "Training"),
    rank: host.t("awakening", "Awakening"),
    liveSkillLevel: host.t("liveSkill", "Live skill"),
    gekisoSkillLevel: host.t("gekisoSkill", "Gekisou skill"),
    cr: host.t("characterRanks", "Character ranks"),
    bi: host.t("bandItems", "Band items"),
  };
  const card = /^([ms])(\d+)(?:[.:/]|$)/u.exec(target);
  if (card)
    return `${catalog.cardName(card[1] === "m" ? "members" : "snaps", Number(card[2]))}${fields[field] ? ` · ${fields[field]}` : ""}`;
  const song = /^(?:challenge:|gekiso:)?(\d+):(\d+)$/u.exec(target);
  if (song)
    return `${catalog.songTitle(Number(song[1]))} · ${catalog.difficultyLabel(Number(song[1]), Number(song[2]))}`;
  if (key === "cr") return `${catalog.characterName(Number(field))} · ${fields[key]}`;
  if (key === "bi") return `${catalog.text(host.data!.bandItems[field]?.name) || `#${field}`} · ${fields[key]}`;
  return target;
}

function songButton(
  host: TeamBuilder,
  options: { label: string; icon: TemplateResult; count: number; disabled?: boolean; open: () => void },
) {
  return html`
    <button
      class="button button--tonal pt-song-choice"
      type="button"
      ?disabled=${options.disabled}
      @click=${options.open}
    >
      ${options.icon}
      <span>${options.label}</span>
      <span class="tabular">${options.count}</span>
    </button>
  `;
}

function renderSetup(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  const t = (key: string, fallback: string) => host.t(`pt.${key}`, fallback);
  const s = host.settings;
  const catalog = host.catalog!;
  const master = host.master!;
  const picker = (songs: SongRef[], change: (songs: SongRef[]) => void, extra: Partial<SongPickerState> = {}) => {
    host.songPicker = {
      songs: songs.filter((song) => !extra.allowedSongIds || extra.allowedSongIds.includes(song.songId)),
      single: false,
      query: "",
      filtersOpen: false,
      bands: [],
      attributes: [],
      gekisouTypes: [],
      difficulty: 3,
      change,
      ...extra,
    };
    host.requestUpdate();
  };
  return html`
    <section class="surface stack">
      ${sectionHeading({ icon: "emoji_events", label: host.t("eventSetup", "Event") })}
      ${segmented({
        label: t("mode", "Play mode"),
        value: s.ptMode,
        options: [
          { value: "solo", label: t("solo", "Solo"), icon: "person" },
          { value: "gekiso", label: t("gekiso", "Gekisou"), icon: "local_fire_department" },
        ],
        onSelect: (value) => host.updateSettings({ ptMode: value as "solo" | "gekiso" }),
      })}
      ${segmented({ label: host.t("measure", "Reward"), value: pt.measure,
        options: [{ value: "points", label: t("points", "Event points") }, { value: "items", label: t("items", "Items") }],
        onSelect: value => { pt.measure = value as PtMeasure; pt.sync(); host.requestUpdate(); } })}
      <label class="tb-check"><md-checkbox touch-target="wrapper" .checked=${s.ptCycle}
        @change=${(e: Event) => host.updateSettings({ ptCycle: (e.target as HTMLInputElement).checked })}></md-checkbox>
        <span>${host.t("cpCycle", "Long-term CP conversion")}</span></label>
      <div class="pt-form-grid">
        ${ptField(
          host,
          "event",
          html`
            <md-outlined-select
              label=${host.t("event", "Event")}
              .value=${s.eventId === null ? "" : String(s.eventId)}
              @change=${(e: Event) => host.updateSettings({ eventId: Number((e.target as HTMLInputElement).value), planChallengeSongs: [] })}
            >
              ${catalog.events().map(
              (event) => html`
                <md-select-option value=${String(event.id)}><div slot="headline">${event.name}</div></md-select-option>
              `,
            )}
            </md-outlined-select>
          `,
        )}
        ${ptField(
          host,
          "consumption",
          boostControl(host, s.boosts, (boosts) => host.updateSettings({ boosts })),
        )}
        ${
          s.ptMode === "gekiso"
            ? html`
                ${ptField(
                host,
                "gekiso-input",
                html`
                  <md-outlined-text-field
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    label=${t("baselineJust", "Baseline JUST (%)")}
                    .value=${live(String(s.ptJust))}
                    @change=${(e: Event) => host.updateSettings({ ptJust: Number((e.target as HTMLInputElement).value) })}
                  ></md-outlined-text-field>
                `,
              )}
                <md-outlined-text-field
                  type="number"
                  min="1"
                  step="1"
                  label=${t("luckSamples", "Luck samples")}
                  .value=${live(String(s.ptLuckSamples))}
                  @change=${(e: Event) => host.updateSettings({ ptLuckSamples: Number((e.target as HTMLInputElement).value) })}
                ></md-outlined-text-field>
              `
            : nothing
        }
      </div>
    </section>
    <section class="surface stack">
      ${sectionHeading({ icon: "library_music", label: host.t("songs", "Songs") })}
      <div class="pt-form-grid">
        ${ptField(
          host,
          "selection",
          songButton(host, {
            label: host.t("chooseSongs", "Choose songs"),
            icon: icon("library_music", 20),
            count: s.songs.length,
            open: () => picker(s.songs, (songs) => host.updateSettings({ songs }), { allowedSongIds: catalog.normalEventSongIds(s.eventId) }),
          }),
        )}
        ${s.ptCycle ? html` ${ptField(
          host,
          "challenge-selection",
          songButton(host, {
            label: t("chooseChallenge", "Challenge songs"),
            icon: icon("swords", 20),
            count: s.planChallengeSongs.length,
            disabled: s.eventId === null,
            open: () =>
              picker(s.planChallengeSongs, (planChallengeSongs) => host.updateSettings({ planChallengeSongs }), {
                allowedSongIds: master.challengeMusics
                  .filter((row) => row.eventId === s.eventId)
                  .map((row) => row.liveMusicId),
                title: t("chooseChallenge", "Challenge songs"),
              }),
          }),
        )}
        ${ptField(
          host,
          "challenge-consumption",
          html`
            <md-outlined-select
              label=${t("challengeCost", "CP per challenge")}
              .value=${String(s.challengePoints)}
              @change=${(e: Event) => host.updateSettings({ challengePoints: Number((e.target as HTMLInputElement).value) })}
            >
              ${master.challengeBoosts
              .filter((row) => row.consumed > 0 && row.eventPointRate > 0 && row.rewardRate > 0)
              .map(
                (row) => html`
                  <md-select-option value=${String(row.consumed)}>
                    <div slot="headline">${row.consumed} CP</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
          `,
        )} ` : nothing}
      </div>
    </section>
    ${renderCandidates(host)}
  `;
}

function renderIssues(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  const t = (key: string, fallback: string, params?: Record<string, string | number>) =>
    host.t(`pt.${key}`, fallback, params);
  return html`
    <section class="surface stack pt-issues" id="pt-issues" tabindex="-1">
      ${sectionHeading({ icon: "error", label: t("needsInput", "Inputs to complete"), count: pt.issues.length })}
      <ul class="pt-issue-list" role="list">
        ${pt.issues.map((issue) => {
          const label = inputLabel(host, issue.target);
          return html`
            <li>
              <span>${label}</span>
              ${
              issueField(issue)
                ? html`
                    <button
                      class="button button--text"
                      type="button"
                      aria-label=${t("locateInput", "Edit {input}", { input: label })}
                      @click=${() => void pt.focusIssue(issue)}
                    >
                      ${t("fixInput", "Edit")}${icon("arrow_forward", 18)}
                    </button>
                  `
                : nothing
            }
            </li>
          `;
        })}
      </ul>
    </section>
  `;
}

function renderRun(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  const t = (key: string, fallback: string) => host.t(`pt.${key}`, fallback);
  const job = pt.job;
  const blocked = host.running || host.manualBusy || !pt.dataFingerprint;
  return html`
    <div class="tb-run">
      ${
        pt.running
          ? html`
              <button class="button button--tonal button--full" type="button" @click=${() => pt.stop()}>
                ${icon("stop", 18)}${t("stop", "Stop")}
              </button>
            `
          : html`
              <button
                class="button button--full tb-run__button"
                type="button"
                ?disabled=${blocked}
                @click=${() => void pt.start(false)}
              >
                ${icon("search", 20)}${t("start", "Calculate")}
              </button>
            `
      }
      ${
        !pt.running && job && !ptComplete(job) && !pt.stale
          ? html`
              <button
                class="button button--tonal button--full"
                type="button"
                ?disabled=${blocked}
                @click=${() => void pt.start(true)}
              >
                ${icon("play_arrow", 18)}${host.t("continueOptimal", "Continue verifying optimality")}
              </button>
            `
          : nothing
      }
      ${
        pt.storageError
          ? html`
              <p class="field-note">${t("storageError", "Progress can't be saved on this device.")}</p>
            `
          : nothing
      }
      ${
        pt.error
          ? html`
              <p class="field-note" role="alert">${t("runError", "Calculation failed.")}</p>
            `
          : nothing
      }
    </div>
  `;
}

function renderRanking(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  const t = (key: string, fallback: string, params?: Record<string, string | number>) =>
    host.t(`pt.${key}`, fallback, params);
  const job = pt.job;
  if (!job)
    return html`
      <div class="state">
        <span class="state__icon">${icon("emoji_events", 40)}</span>
        <p class="state__title">${host.t("resultsEmpty", "Results appear here")}</p>
      </div>
    `;
  const ranking = ptSongRanking(job, pt.measure);
  const challenge = ptChallengeBest(job, pt.measure);
  const gap = ptComplete(job) ? null : improvementPercent(job.tasks.filter(task => task.measure === pt.measure && task.route === "live").map(task => task.result ?? pendingSong(task.song)));
  const shown = pt.showAll ? ranking : ranking.slice(0, job.scope === "top-one" ? 1 : 5);
  const number = (n: number) => new Intl.NumberFormat(host.locale, { maximumFractionDigits: 1 }).format(n);
  const settled = job.tasks.filter((task) => task.status === "complete" || task.status === "empty" || task.status === "pruned").length;
  return html`
    <section class="stack" aria-live="polite">
      <div class="pt-results-bar">
        <span class="tb-proof">${ptComplete(job) ? host.t("proven", "Proven optimal") : host.t("recommendation", "Recommendation")}${gap === null ? nothing : html` · ${host.t("improvementBound", "Up to {percent}% improvement", { percent: number(gap) })}`}</span>
        <span class="pt-progress tabular">${settled}/${job.tasks.length}</span>
        ${
          pt.stale
            ? html`
                <span class="chip chip--static"><span class="chip__label">${t("stale", "Inputs changed")}</span></span>
              `
            : nothing
        }
      </div>
      <md-linear-progress
        style=${pt.running ? "" : "visibility: hidden"}
        .value=${job.tasks.length ? settled / job.tasks.length : 0}
        aria-label=${t("start", "Calculate")}
      ></md-linear-progress>
      ${
        challenge
          ? html`
              ${renderHit(host, challenge, -1, { rank: icon("swords", 18), subtitle: t("challengeBest", "Challenge team"), stale: pt.stale })}
            `
          : nothing
      }
      ${!ranking.length && !pt.running ? html`<div class="state"><p class="state__title">${host.t("noCandidate", "No recommendation yet")}</p></div>` : nothing}
      ${shown.map((hit, position) => renderHit(host, hit, ranking.indexOf(hit) < 0 ? position : ranking.indexOf(hit), {
        stale: pt.stale,
        content: job.cycle ? html`<p class="pt-breakdown tabular">${t("breakdown", "Live {direct} + CP {converted}", { direct: number(hit.event!.directMean ?? hit.event!.mean), converted: number(hit.event!.convertedMean ?? 0) })}</p>` : undefined,
      }))}
      ${compareTable(host, shown)}
      <button class="button button--tonal" type="button" ?disabled=${host.running || pt.stale}
        @click=${() => void pt.start(true, "top-five")}>${t("topFive", "Top five")}</button>
      ${
        ranking.length > 5
          ? html`
              <button
                class="button button--text"
                type="button"
                @click=${() => {
                  pt.showAll = !pt.showAll;
                  host.requestUpdate();
                }}
              >
                ${pt.showAll ? t("topFive", "Top five") : t("showAll", "All {count} songs", { count: ranking.length })}
              </button>
            `
          : nothing
      }
      ${
        !ptAllComplete(job) && !pt.running
          ? html`
              <button
                class="button button--tonal"
                type="button"
                ?disabled=${host.running || pt.stale || !!pt.issues.length}
                @click=${() => void pt.start(true, "all")}
              >
                ${t("calculateAll", "Calculate every song")}
              </button>
            `
          : nothing
      }
    </section>
  `;
}

export function renderPtTab(host: TeamBuilder): TemplateResult {
  const mode = host.settings.rewardMode;
  if (mode === "recommendation") host.pt.sync();
  const modes = html`<section class="surface stack">
    ${sectionHeading({ icon: "flag", label: host.t("goal", "Goal") })}
    ${segmented({
    label: host.t("goal", "Goal"), value: mode,
    options: [
      { value: "recommendation", label: host.t("recommendation", "Recommendation") },
      { value: "event", label: host.t("rewardSearch", "Reward team search") },
      { value: "plan", label: host.t("goalPlan", "Event resource plan") },
    ],
    onSelect: rewardMode => {
      host.cancel();
      host.compare = [];
      host.pt.showIssues = false;
      host.updateSettings({ rewardMode });
    },
  })}</section>`;
  if (mode !== "recommendation") return renderBuildTab(host, modes);
  return html`
    <div class="tb-build pt-recommendation">
      <div class="tb-config stack">
        ${modes}${renderSetup(host)} ${host.pt.showIssues && host.pt.issues.length ? renderIssues(host) : nothing}
        ${renderRun(host)}
      </div>
      <div class="tb-results-column">${renderRanking(host)}</div>
    </div>
  `;
}
