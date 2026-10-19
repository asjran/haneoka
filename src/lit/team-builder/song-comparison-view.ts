// L3 — GEB
// Input: 激奏对比控制器、当前目录与活动资料。
// Output: 条件表单、歌曲代表谱面、可展开明细与固定队伍活动加成。
// Pos: [Map](../L2-2.md)；独立激奏选曲页签的结果视图。
// Effects/Dependencies: Lit light DOM；事件回调交由控制器处理。
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import type { TeamBuilder } from "../team-builder";
import { accordion } from "../ui/accordion";
import { sectionHeading } from "./catalog";
import { availableOnServer, songMetrics, type ComparisonRow } from "../../lib/team-builder/song-comparison";
import { memberEventPercent, snapEventPercent } from "../../lib/team-builder/engine/power";
import { playerState } from "../../lib/team-builder/engine/api";

export const COMPARISON_TEXT = {
  title: "Gekiso song comparison",
  tab: "Gekiso songs",
  chooseTeam: "Use a saved team",
  useTeam: "Compare songs with this team",
  choose: "Playable charts",
  minLevel: "Minimum level",
  maxLevel: "Maximum level",
  target: "Room target",
  players: "Room size",
  mode: "Performance",
  ap: "AP reference",
  custom: "Custom",
  just: "JUST (%)",
  great: "GREAT (%)",
  miss: "MISS interval (0 = none)",
  rank: "Placement in every section",
  select: "Choose",
  start: "Compare songs",
  stop: "Stop",
  retry: "Retry",
  remove: "Remove chart",
  busy: "Another calculation is running",
  score: "Personal expected score",
  contribution: "Per-player requirement met",
  remaining: "Other players need on average",
  total: "Room target score",
  average: "Per-player requirement",
  sort: "Sort",
  conditions: "Conditions",
  play: "Normal play · Assist off",
  orders: "120 skill orders · Average score",
  luck: "LUCK · Nominal expectation",
  placement: "Every section: #{rank}",
  coverage: "{done}/{total} charts complete",
  empty: "Choose playable charts to compare",
  pending: "Pending",
  running: "Calculating",
  complete: "Complete",
  failed: "Failed",
  cancelled: "Stopped",
  threshold: "Target threshold unavailable",
  source: "Unavailable on this server",
  chart: "Chart unavailable",
  missions: "Gekiso sections unavailable",
  rewards: "Placement rewards unavailable",
  scoreFailed: "Scoring failed",
  memberMissing: "Choose an owned member",
  snapMissing: "Choose an owned Snapshot",
  duplicateCharacter: "Character already in the team",
  duplicateSnap: "Snapshot already in the team",
  formation: "Complete the five slots",
  songs: "Choose playable charts",
  percent: "Enter 0–100",
  issues: "Review these fields",
  slot: "Slot {slot}",
  unknown: "Unfilled growth · Minimum values",
  recorded: "Recorded",
  defaultValue: "Base value",
  unset: "Unfilled",
  adopted: "Value used",
  greatRule: "GREAT: share of judged nodes",
  justRule: "JUST: share of eligible non-GREAT nodes",
  missRule: "MISS: every N judged nodes; overrides earlier judgements",
  event: "Current event bonuses",
  pt: "Event PT bonus",
  items: "Item bonus",
  unavailable: "Unavailable",
  account: "Account values",
  rankTotal: "Total character rank",
  vip: "T.G.W card rank",
  facilities: "Facilities",
  characterRank: "Character rank",
  characterMemory: "Character memories",
  songMemory: "Song memories",
  sourceValue: "Source",
  difficulty: "Difficulty",
  song: "Song",
  details: "Details",
  noAssist: "Assist off",
  card: "Card",
} as const;
export const scText = (
  host: TeamBuilder,
  key: keyof typeof COMPARISON_TEXT,
  params?: Record<string, string | number>,
) => host.t(`sc.${key}`, COMPARISON_TEXT[key], params);

function conditions(host: TeamBuilder) {
  const c = host.songComparison,
    team = c.team(),
    s = c.settings,
    master = host.master!,
    t = (key: keyof typeof COMPARISON_TEXT) => scText(host, key);
  const resolved = playerState(master, team.player);
  const growthFields: Record<string, string> = {
    level: host.t("level", "Level"),
    awake: host.t("training", "Training"),
    rank: host.t("awakening", "Awakening"),
    liveSkillLevel: host.t("liveSkill", "Live skill"),
    gekisoSkillLevel: host.t("gekisoSkill", "Gekiso skill"),
  };
  const missing = [...team.members, ...team.snaps].flatMap((input) => {
    const growth = (input.key.startsWith("m") ? team.box.members : team.box.snaps).find(
      (row) => row.key === input.key,
    )?.growth;
    return Object.entries(input)
      .filter(([, value]) => value === null)
      .map(([field]) => ({
        name: host.catalog!.cardName(input.key.startsWith("m") ? "members" : "snaps", input.cardId),
        field:
          field === "rank" && input.key.startsWith("s")
            ? host.t("limitBreak", "Limit break")
            : (growthFields[field] ?? field),
        value: growth ? (growth as unknown as Record<string, number>)[field] : undefined,
      }));
  });
  const account = [
    { label: t("rankTotal"), value: resolved.totalRank, recorded: team.player.characterTotalRank !== null },
    { label: t("vip"), value: resolved.vipRank, recorded: team.player.vipRank !== null },
    ...[...master.characters.keys()].map((id) => ({
      label: `${host.catalog!.characterName(id)} · ${t("characterRank")}`,
      value: resolved.characterRanks.get(id) ?? 1,
      recorded: team.player.characterRanks[String(id)] != null,
    })),
    ...[...master.characters.keys()].map((id) => ({
      label: `${host.catalog!.characterName(id)} · ${t("characterMemory")}`,
      value: resolved.characterMemory.get(id) ?? 0,
      recorded: team.player.characterMemory[String(id)] != null,
    })),
    ...s.songs
      .filter((song, index, all) => all.findIndex((row) => row.songId === song.songId) === index)
      .map((song) => ({
        label: `${host.catalog!.songTitle(song.songId)} · ${t("songMemory")}`,
        value: resolved.musicMemory.get(song.songId) ?? 0,
        recorded: team.player.musicMemory[String(song.songId)] != null,
      })),
    ...[...master.bandItems.keys()].map((id) => ({
      label: `${host.catalog!.text(host.data!.bandItems[String(id)]?.name) || "#" + id} · ${t("facilities")}`,
      value: resolved.bandItems.get(id) ?? 0,
      recorded: team.player.bandItems[String(id)] != null,
    })),
  ];
  return html`
    <div class="stack">
      <dl class="spec-list">
        <dt>${t("play")}</dt>
        <dd>${t("orders")}</dd>
        <dt>LUCK</dt>
        <dd>${t("luck")}</dd>
        <dt>GREAT</dt>
        <dd>${s.mode === "ap" ? 0 : (s.great ?? "—")}%</dd>
        <dt>JUST</dt>
        <dd>${s.just ?? "—"}%</dd>
        <dt>MISS</dt>
        <dd>${s.mode === "ap" ? 0 : (s.missEvery ?? "—")}</dd>
      </dl>
      <ul>
        <li>${t("greatRule")}</li>
        <li>${t("justRule")}</li>
        <li>${t("missRule")}</li>
      </ul>
      ${
        missing.length
          ? html`
              <strong>${t("unknown")}</strong>
              <div class="table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>${t("card")}</th>
                      <th>${t("unset")}</th>
                      <th>${t("adopted")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${missing.map(
                    (row) => html`
                      <tr>
                        <th>${row.name}</th>
                        <td>${row.field}</td>
                        <td>${row.value ?? "—"}</td>
                      </tr>
                    `,
                  )}
                  </tbody>
                </table>
              </div>
            `
          : nothing
      }
      <strong>${t("account")}</strong>
      <div class="table-scroll sc-account">
        <table class="data-table">
          <thead>
            <tr>
              <th>${t("account")}</th>
              <th>${t("adopted")}</th>
              <th>${t("sourceValue")}</th>
            </tr>
          </thead>
          <tbody>
            ${account.map(
              (row) => html`
                <tr>
                  <th>${row.label}</th>
                  <td>${row.value}</td>
                  <td>${row.recorded ? t("recorded") : t("defaultValue")}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function eventBonus(host: TeamBuilder) {
  const c = host.songComparison,
    team = c.team(),
    now = Date.now();
  const current = host
    .catalog!.events()
    .filter(
      ({ id, event }) =>
        availableOnServer(host.data!, "events", id) &&
        event.startAt !== null &&
        event.endAt !== null &&
        event.startAt <= now &&
        now < event.endAt &&
        event.livePoints.size,
    );
  if (!current.length) return nothing;
  const t = (key: keyof typeof COMPARISON_TEXT) => scText(host, key);
  return html`
    <section class="surface stack">
      ${sectionHeading({ icon: "emoji_events", label: t("event") })}
      ${current.map(({ event, name }) => {
        const bonus = (type: number) =>
          (team.box.members.reduce((sum, member) => sum + memberEventPercent(event.effects, member, type), 0) +
            team.box.snaps.reduce((sum, snap) => sum + snapEventPercent(event.effects, snap, type), 0)) /
          100;
        return html`
          <strong>${name}</strong>
          <dl class="spec-list">
            <dt>${t("pt")}</dt>
            <dd>${team.issues.length || !event.effects.length ? t("unavailable") : "+" + bonus(0) + "%"}</dd>
            <dt>${t("items")}</dt>
            <dd>${team.issues.length || !event.effects.length ? t("unavailable") : "+" + bonus(1) + "%"}</dd>
          </dl>
        `;
      })}
    </section>
  `;
}

export function renderSongComparison(host: TeamBuilder) {
  const c = host.songComparison,
    s = c.settings,
    catalog = host.catalog!,
    t = (key: keyof typeof COMPARISON_TEXT, params?: Record<string, string | number>) => scText(host, key, params);
  const format = (value: number, digits = 0) =>
    new Intl.NumberFormat(host.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const select = (
    id: string,
    label: string,
    value: string,
    options: { value: string; label: string }[],
    change: (value: string) => void,
  ) => html`
    <md-outlined-select
      id=${id}
      data-sc-field
      label=${label}
      .value=${value}
      @change=${(e: Event) => change((e.target as HTMLSelectElement).value)}
    >
      ${options.map(
        (option) => html`
          <md-select-option .value=${option.value} ?selected=${value === option.value}>
            <div slot="headline">${option.label}</div>
          </md-select-option>
        `,
      )}
    </md-outlined-select>
  `;
  const number = (
    id: string,
    label: string,
    value: number | null,
    change: (value: number | null) => void,
    max?: number,
  ) => html`
    <md-outlined-text-field
      id=${id}
      data-sc-field
      type="number"
      min="0"
      max=${max ?? nothing}
      label=${label}
      .value=${live(value === null ? "" : String(value))}
      @input=${(e: Event) => {
        const value = (e.target as HTMLInputElement).value;
        change(value === "" ? null : Number(value));
      }}
    ></md-outlined-text-field>
  `;
  const metricsCells = (row?: ComparisonRow) => {
    const score = row?.status === "complete" ? row.hit?.score?.mean : undefined;
    const metrics = score === undefined ? null : songMetrics(host.master!, row!.song, s, score);
    return html`
      <td class="tabular">${score === undefined ? "—" : format(score)}</td>
      <td class="tabular">${metrics ? format(metrics.contribution, 1) + "%" : "—"}</td>
      <td class="tabular">${metrics ? format(Math.ceil(metrics.remaining)) : "—"}</td>
    `;
  };
  const headers = html`
    <th>${t("score")}</th>
    <th>${t("contribution")}</th>
    <th>${t("remaining")}</th>
  `;
  const done = c.rows.filter((row) => row.status === "complete").length;
  return html`
    <div class="sc tb-build">
      <div class="stack">
        <section class="surface stack">
          ${sectionHeading({ icon: "tune", label: t("conditions") })}
          <button
            id="sc-songs"
            data-sc-field
            class="button button--tonal button--full"
            type="button"
            @click=${() => c.choose()}
          >
            ${t("choose")} · ${s.songs.length}
          </button>
          ${select(
            "sc-target",
            t("target"),
            s.target,
            [
              { value: "SS", label: "SS" },
              { value: "S", label: "S" },
            ],
            (value) => c.update({ target: value as "S" | "SS" }),
          )}
          ${select(
            "sc-players",
            t("players"),
            String(s.players),
            [2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) })),
            (value) => c.update({ players: Number(value) }),
          )}
          ${select(
            "sc-mode",
            t("mode"),
            s.mode ?? "",
            [
              { value: "", label: t("select") },
              { value: "ap", label: t("ap") },
              { value: "custom", label: t("custom") },
            ],
            (value) => c.update({ mode: value === "ap" || value === "custom" ? value : null }),
          )}
          ${number("sc-just", t("just"), s.just, (value) => c.update({ just: value }), 100)}
          ${
            s.mode === "custom"
              ? html`
                  ${number("sc-great", t("great"), s.great, (value) => c.update({ great: value }), 100)}${number("sc-miss", t("miss"), s.missEvery, (value) => c.update({ missEvery: value }))}
                `
              : nothing
          }
          ${select("sc-rank", t("rank"), s.rank === null ? "" : String(s.rank), [{ value: "", label: t("select") }, ...Array.from({ length: s.players }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))], (value) => c.update({ rank: value ? Number(value) : null }))}
          ${accordion({
            id: "sc-conditions",
            label: t("details"),
            supportingText: [...c.team().members, ...c.team().snaps].some((card) => Object.values(card).includes(null))
              ? t("unknown")
              : t("play"),
            expanded: c.expanded.has(-1),
            onExpandedChange: (open) => {
              open ? c.expanded.add(-1) : c.expanded.delete(-1);
              host.requestUpdate();
            },
            content: conditions(host),
          })}
          ${
            c.submitted && c.issues.length
              ? html`
                  <div id="sc-issues" tabindex="-1">
                    <strong>${t("issues")}</strong>
                    <ul>
                      ${c.issues.map(
                      (issue) => html`
                        <li>
                          <a
                            href=${"#" + issue.field}
                            @click=${(e: Event) => {
                              e.preventDefault();
                              host.querySelector<HTMLElement>("#" + issue.field)?.focus();
                            }}
                          >
                            ${issue.slot === undefined ? "" : t("slot", { slot: issue.slot + 1 }) + " · "}${t(issue.reason as keyof typeof COMPARISON_TEXT)}
                          </a>
                        </li>
                      `,
                    )}
                    </ul>
                  </div>
                `
              : nothing
          }
          <button
            class="button button--full"
            type="button"
            ?disabled=${host.running && !c.running}
            @click=${() => (c.running ? c.stop() : void c.start())}
          >
            ${c.running ? t("stop") : host.running ? t("busy") : t("start")}
          </button>
        </section>
        ${eventBonus(host)}
      </div>
      <section class="surface stack">
        ${sectionHeading({ icon: "music_note", label: t("title") })}
        <div class="cluster">
          <span class="chip chip--static">${s.mode ? t(s.mode) : t("select")} · JUST ${s.just ?? "—"}%</span>
          <span class="chip chip--static">${t("placement", { rank: s.rank ?? "—" })}</span>
          <span class="chip chip--static">${s.players} · ${s.target}</span>
        </div>
        <div class="cluster">
          <span class="chip chip--static">
            GREAT ${s.mode === "ap" ? 0 : (s.great ?? "—")}% · MISS ${s.mode === "ap" ? 0 : (s.missEvery ?? "—")}
          </span>
          <span class="chip chip--static">${t("noAssist")}</span>
        </div>
        <div class="row row--wrap">
          <span role="status" class="tabular">${t("coverage", { done, total: c.rows.length })}</span>
        </div>
        <md-linear-progress
          .value=${c.rows.length ? done / c.rows.length : 0}
          aria-label=${t("coverage", { done, total: c.rows.length })}
        ></md-linear-progress>
        ${select(
          "sc-sort",
          t("sort"),
          s.sort,
          [
            { value: "contribution", label: t("contribution") },
            { value: "score", label: t("score") },
            { value: "remaining", label: t("remaining") },
          ],
          (value) => c.update({ sort: value as typeof s.sort }),
        )}
        ${
          c.rows.length
            ? html`
                <div class="table-scroll" role="region" tabindex="0" aria-label=${t("title")}>
                  <table class="data-table sc-results">
                    <thead>
                      <tr>
                        <th>${t("song")}</th>
                        <th>${t("difficulty")}</th>
                        ${headers}
                      </tr>
                    </thead>
                    <tbody>
                      ${repeat(
                      c.groups(),
                      (group) => group.id,
                      (group) => {
                        const row = group.representative,
                          open = c.expanded.has(group.id),
                          completed = group.charts.filter((chart) => chart.status === "complete").length;
                        const href = catalog.songOptions(group.id).href;
                        return html`
                          <tr data-sc-song=${group.id}>
                            <th scope="row">
                              <a href=${href ?? `/${host.server}/${host.locale}/songs/${group.id}/`}>
                                ${catalog.songTitle(group.id)}
                              </a>
                              <button
                                class="button button--text"
                                type="button"
                                aria-expanded=${String(open)}
                                aria-controls=${`sc-chart-${group.id}`}
                                @click=${() => {
                      open ? c.expanded.delete(group.id) : c.expanded.add(group.id);
                      host.requestUpdate();
                    }}
                              >
                                ${t("coverage", { done: completed, total: group.charts.length })}
                              </button>
                            </th>
                            <td>${row ? catalog.difficultyLabel(group.id, row.song.difficulty) : "—"}</td>
                            ${metricsCells(row)}
                          </tr>
                          <tr id=${`sc-chart-${group.id}`} ?hidden=${!open}>
                            <td colspan="5">
                              <table class="data-table">
                                <thead>
                                  <tr>
                                    <th>${t("difficulty")}</th>
                                    ${headers}
                                    <th>${t("details")}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  ${group.charts.map((chart) => {
                        const metrics = chart.hit?.score
                          ? songMetrics(host.master!, chart.song, s, chart.hit.score.mean)
                          : null;
                        const missions = host
                          .master!.songs.get(group.id)
                          ?.gekisoMissions.map((id) => ({ 1: "COMBO", 2: "LUCK", 3: "JUST" })[id as 1 | 2 | 3] ?? "—")
                          .join(" / ");
                        return html`
                          <tr>
                            <th>${catalog.difficultyLabel(group.id, chart.song.difficulty)}</th>
                            ${metricsCells(chart)}
                            <td>
                              <span>
                                ${chart.reason ? t(chart.reason as keyof typeof COMPARISON_TEXT) : chart.status === "complete" && !metrics ? t("threshold") : t(chart.status)}
                              </span>
                              <dl class="spec-list">
                                <dt>${t("total")}</dt>
                                <dd>${metrics ? format(metrics.total) : "—"}</dd>
                                <dt>${t("average")}</dt>
                                <dd>${metrics ? format(Math.ceil(metrics.average)) : "—"}</dd>
                                <dt>${t("score")}</dt>
                                <dd>${chart.hit?.score?.mean ?? "—"}</dd>
                                <dt>${t("rank")}</dt>
                                <dd>${missions} · ${s.rank ?? "—"}</dd>
                              </dl>
                              ${
                        chart.status === "failed" || chart.status === "cancelled"
                          ? html`
                              <button
                                class="button button--text"
                                type="button"
                                ?disabled=${host.running}
                                @click=${() => void c.start(chart.song)}
                              >
                                ${t("retry")}
                              </button>
                            `
                          : nothing
                      }
                              <button
                                class="button button--text"
                                type="button"
                                @click=${() => c.update({ songs: s.songs.filter((song) => song.songId !== chart.song.songId || song.difficulty !== chart.song.difficulty) })}
                              >
                                ${t("remove")}
                              </button>
                            </td>
                          </tr>
                        `;
                      })}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        `;
                      },
                    )}
                    </tbody>
                  </table>
                </div>
              `
            : html`
                <div class="state"><p class="state__title">${t("empty")}</p></div>
              `
        }
      </section>
    </div>
  `;
}
