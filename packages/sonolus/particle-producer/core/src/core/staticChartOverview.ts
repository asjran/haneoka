import { interpolateNoteLine } from "./geometry.js";
import { isPairNoteOperateType, NoteDirection, NoteOperateType } from "./enums.js";
import type { ChartDocument, ChartNote } from "./types.js";

/** Bump when SVG layout, geometry, or font assumptions change. */
export const STATIC_CHART_OVERVIEW_RENDERER_VERSION = "chart-overview-svg-v2";
export const STATIC_CHART_OVERVIEW_FONT_STACK =
  '"Roboto Variable", "Noto Sans Variable", "Noto Sans JP Variable", "Noto Sans TC Variable", "Noto Sans SC Variable", "Noto Sans KR Variable", sans-serif';

const DIFFICULTY_COLORS: Readonly<Record<string, string>> = {
  easy: "#48cadc",
  normal: "#56ce79",
  hard: "#f4bb3c",
  expert: "#e84e43",
  master: "#c950d7",
  special: "#f17c3a",
};
const ATTRIBUTE_COLORS: Readonly<Record<string, string>> = {
  red: "#e84e43",
  blue: "#4d8df7",
  green: "#56ce79",
  yellow: "#f4bb3c",
  purple: "#c950d7",
};

export interface StaticChartOverviewMeta {
  readonly title: string;
  readonly bandName: string;
  readonly songId: string;
  readonly difficultyName: string;
  readonly displayLevel: string | number;
  readonly attribute?: string;
  readonly jacketHref?: string;
  readonly locale?: string;
  readonly server?: string;
}

export interface StaticChartOverviewOptions {
  readonly height: number;
  readonly maxPanels?: number;
  readonly maxPixels?: number;
  readonly maxSvgBytes?: number;
}

export interface StaticChartOverviewResult {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly panelCount: number;
  readonly noteCount: number;
}

export class StaticChartOverviewError extends Error {
  constructor(
    readonly code: "invalid_height" | "render_budget" | "svg_too_large",
    message: string,
  ) {
    super(message);
    this.name = "StaticChartOverviewError";
  }
}

type OverviewNoteKind = "tap" | "flick" | "slide" | "trace" | "guide";

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function number(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isFinite(rounded) ? String(rounded) : "0";
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function text(value: string | number): string {
  return escapeXml(String(value));
}

// Conservative glyph advances keep mixed CJK/Latin text inside its allocated row.
function fitText(value: string, maxWidth: number, fontSize: number): string {
  const glyphs = Array.from(value.trim());
  let used = 0;
  const result: string[] = [];
  for (const glyph of glyphs) {
    const advance = (glyph.codePointAt(0)! > 0x2ff ? 1 : /[MW@%]/u.test(glyph) ? 0.95 : 0.65) * fontSize;
    if (used + advance > maxWidth - fontSize) return `${result.join("")}…`;
    used += advance;
    result.push(glyph);
  }
  return result.join("");
}

function difficultyColor(value: string): string {
  return DIFFICULTY_COLORS[value.toLowerCase()] || "#e84e43";
}

function attributeColor(value: string): string {
  return ATTRIBUTE_COLORS[value.toLowerCase()] || "#9aa7b5";
}

function kindOf(note: ChartNote): OverviewNoteKind {
  switch (note.operateType) {
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      return "flick";
    case NoteOperateType.Trace:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.SlideConnectionTrace:
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.GuideEndTrace:
      return "trace";
    case NoteOperateType.GuideBegin:
    case NoteOperateType.GuideEnd:
      return "guide";
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideEnd:
    case NoteOperateType.SlideConnection:
    case NoteOperateType.HiddenSlideBegin:
    case NoteOperateType.HiddenSlideEnd:
    case NoteOperateType.Combo:
      return "slide";
    default:
      return "tap";
  }
}

export function countStaticChartNoteKinds(chart: ChartDocument): {
  readonly tap: number;
  readonly flick: number;
  readonly slide: number;
} {
  const result = { tap: 0, flick: 0, slide: 0 };
  for (const note of chart.notes) {
    if (!note.judged) continue;
    const kind = kindOf(note);
    if (kind === "tap") result.tap += 1;
    else if (kind === "flick") result.flick += 1;
    else result.slide += 1;
  }
  return result;
}

function directionOf(note: ChartNote): "left" | "right" | "up" {
  if (note.direction === NoteDirection.Left) return "left";
  if (note.direction === NoteDirection.Right) return "right";
  return "up";
}

function statValue(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function durationValue(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function bpmValue(chart: ChartDocument): string {
  const values = chart.bpmChanges.map((change) => change.bpm).filter((value) => value > 0);
  if (!values.length) return "—";
  const first = Math.round(Math.min(...values));
  const maximum = Math.round(Math.max(...values));
  return maximum === first ? String(first) : `${first}–${maximum}`;
}

function points(points: readonly [number, number][]): string {
  return points.map(([x, y]) => `${number(x)},${number(y)}`).join(" ");
}

function localX(scorePosition: number, panelWidth: number, laneWidth: number): number {
  return panelWidth / 2 + ((scorePosition / 24) * 6 - 3) * laneWidth;
}

function noteBounds(note: Pick<ChartNote, "pos" | "size">, panelWidth: number, laneWidth: number) {
  const left = localX(note.pos, panelWidth, laneWidth);
  const right = localX(note.pos + note.size, panelWidth, laneWidth);
  return { left: Math.min(left, right), right: Math.max(left, right), center: (left + right) / 2 };
}

function yAt(timeMs: number, panel: number, panelDuration: number, height: number, heightPerSecond: number): number {
  return height - ((timeMs - panel * panelDuration) / 1000) * heightPerSecond;
}

function renderNote(
  note: ChartNote,
  panel: number,
  panelStart: number,
  panelEnd: number,
  panelWidth: number,
  laneWidth: number,
  height: number,
  panelDuration: number,
  heightPerSecond: number,
): string {
  if (!note.visible || !note.judged || note.timeMs < panelStart || note.timeMs >= panelEnd) return "";
  const bounds = noteBounds(note, panelWidth, laneWidth);
  const x = bounds.left;
  const width = Math.max(2, bounds.right - bounds.left);
  const y = yAt(note.timeMs, panel, panelDuration, height, heightPerSecond);
  const kind = kindOf(note);
  const direction = directionOf(note);
  const fill = kind === "flick" ? "#ffe27b" : kind === "trace" ? "#a8efff" : kind === "guide" ? "#c1a8ff" : "#ffffff";
  const stroke = kind === "slide" ? "#927eff" : kind === "guide" ? "#d7c6ff" : "#78dfff";
  const body = `<rect x="${number(x)}" y="${number(y - 3.5)}" width="${number(width)}" height="7" rx="3.5" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
  if (kind !== "flick") return body;
  const arrowDirection = direction === "left" ? -1 : direction === "right" ? 1 : 0;
  const arrowX = bounds.center + arrowDirection * Math.max(4, width * 0.22);
  const arrow =
    direction === "left" || direction === "right"
      ? `<path d="M ${number(arrowX + arrowDirection * 5)} ${number(y - 5)} L ${number(arrowX - arrowDirection * 5)} ${number(y)} L ${number(arrowX + arrowDirection * 5)} ${number(y + 5)}" fill="none" stroke="#ff7c8b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M ${number(bounds.center - 4)} ${number(y + 3)} L ${number(bounds.center)} ${number(y - 4)} L ${number(bounds.center + 4)} ${number(y + 3)}" fill="none" stroke="#ff7c8b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `${body}${arrow}`;
}

function renderLane(
  panelWidth: number,
  laneWidth: number,
  stageWidth: number,
  height: number,
  xOffset: number,
): string {
  const left = panelWidth / 2 - stageWidth / 2;
  const right = panelWidth / 2 + stageWidth / 2;
  const lines = Array.from({ length: 5 }, (_, index) => {
    const x = left + (index + 1) * laneWidth;
    return `<line x1="${number(x)}" y1="0" x2="${number(x)}" y2="${number(height)}" stroke="rgba(128,255,255,.2)" stroke-width="1"/>`;
  }).join("");
  return `<rect x="${number(left)}" y="0" width="${number(stageWidth)}" height="${number(height)}" fill="rgba(0,0,25,.4)"/>${lines}<line x1="${number(left)}" y1="0" x2="${number(left)}" y2="${number(height)}" stroke="rgba(0,255,255,.5)"/><line x1="${number(right)}" y1="0" x2="${number(right)}" y2="${number(height)}" stroke="rgba(0,255,255,.5)"/><g transform="translate(${number(xOffset)},0)"/>`;
}

function renderBpmGrid(
  chart: ChartDocument,
  panel: number,
  panelStart: number,
  panelEnd: number,
  panelWidth: number,
  laneWidth: number,
  height: number,
  panelDuration: number,
  heightPerSecond: number,
): string {
  const left = panelWidth / 2 - 3 * laneWidth;
  const right = panelWidth / 2 + 3 * laneWidth;
  const parts: string[] = [];
  for (let index = 0; index < chart.bpmChanges.length; index += 1) {
    const change = chart.bpmChanges[index]!;
    const next = chart.bpmChanges[index + 1];
    const start = Math.max(panelStart, change.timeMs);
    const end = Math.min(panelEnd, next?.timeMs ?? Number.POSITIVE_INFINITY);
    if (change.bpm <= 0 || end <= start) continue;
    const beatMs = 60_000 / change.bpm;
    let beat = Math.ceil((change.beat + (start - change.timeMs) / beatMs) * 2) / 2;
    for (let count = 0; count < 2048; count += 1, beat += 0.5) {
      const time = change.timeMs + (beat - change.beat) * beatMs;
      if (time >= end) break;
      const y = yAt(time, panel, panelDuration, height, heightPerSecond);
      const stroke = Number.isInteger(beat) ? "rgba(128,255,255,.2)" : "rgba(255,128,255,.16)";
      parts.push(
        `<line x1="${number(left)}" y1="${number(y)}" x2="${number(right)}" y2="${number(y)}" stroke="${stroke}"${Number.isInteger(beat) ? "" : ' stroke-dasharray="2.5"'}/>`,
      );
    }
  }
  return parts.join("");
}

function renderRibbons(
  chart: ChartDocument,
  panel: number,
  panelStart: number,
  panelEnd: number,
  panelWidth: number,
  laneWidth: number,
  height: number,
  panelDuration: number,
  heightPerSecond: number,
): string {
  const byId = new Map(chart.notes.map((note) => [note.id, note]));
  const parts: string[] = [];
  for (const line of chart.lines) {
    const nodes = line.noteIds
      .map((id) => byId.get(id))
      .filter((note): note is ChartNote => Boolean(note) && note!.indexInLine !== null)
      .sort((left, right) => left.timeMs - right.timeMs || left.id - right.id);
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const head = nodes[index]!;
      const tail = nodes[index + 1]!;
      if (tail.timeMs <= panelStart || head.timeMs >= panelEnd) continue;
      const start = Math.max(head.timeMs, panelStart);
      const end = Math.min(tail.timeMs, panelEnd);
      const steps = Math.max(2, Math.ceil((end - start) / 50));
      const samples: Array<{ left: number; right: number; y: number }> = [];
      for (let step = 0; step <= steps; step += 1) {
        const time = start + ((end - start) * step) / steps;
        const shape = interpolateNoteLine(head, tail, time);
        samples.push({
          left: localX(shape.pos, panelWidth, laneWidth),
          right: localX(shape.pos + shape.size, panelWidth, laneWidth),
          y: yAt(time, panel, panelDuration, height, heightPerSecond),
        });
      }
      const leftPath = samples.map((sample) => `${number(sample.left)},${number(sample.y)}`).join(" L ");
      const rightPath = [...samples]
        .reverse()
        .map((sample) => `${number(sample.right)},${number(sample.y)}`)
        .join(" L ");
      const guide = line.kind === "guide";
      parts.push(
        `<path d="M ${leftPath} L ${rightPath} Z" fill="url(#${guide ? "guide" : "slide"}-gradient)" stroke="${guide ? "rgba(171,142,255,.72)" : "rgba(151,122,255,.82)"}" stroke-width="${number(laneWidth / 5)}" stroke-linejoin="round" opacity="${guide ? ".7" : "1"}"/>`,
      );
    }
  }
  return parts.join("");
}

function renderChartStrip(
  chart: ChartDocument,
  height: number,
  panelCount: number,
  panelWidth: number,
  laneWidth: number,
): string {
  const stageWidth = laneWidth * 6;
  const heightPerSecond = 150 * (laneWidth / 10);
  const panelDuration = (height / heightPerSecond) * 1000;
  const byTick = new Map<number, ChartNote[]>();
  const visibleNotes = chart.notes
    .filter((note) => note.visible && note.judged)
    .sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
  for (const note of visibleNotes) {
    if (!isPairNoteOperateType(note.operateType)) continue;
    const group = byTick.get(note.tick) || [];
    group.push(note);
    byTick.set(note.tick, group);
  }
  const simultaneous = [...byTick.values()].flatMap((group) =>
    group.slice(1).map((note, index) => ({ left: group[index]!, right: note })),
  );
  const judged = chart.notes.filter((note) => note.judged).sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
  const panels: string[] = [];
  for (let panel = 0; panel < panelCount; panel += 1) {
    const panelStart = panel * panelDuration;
    const panelEnd = (panel + 1) * panelDuration;
    const left = panelWidth / 2 - 3 * laneWidth;
    const right = panelWidth / 2 + 3 * laneWidth;
    const labels: string[] = [];
    for (let time = Math.ceil(panelStart / 5000) * 5000; time < panelEnd; time += 5000) {
      const timeLabel = `${Math.floor(time / 60000)}:${String(Math.floor((time / 1000) % 60)).padStart(2, "0")}`;
      labels.push(
        `<text x="${number(left - 6)}" y="${number(yAt(time, panel, panelDuration, height, heightPerSecond))}" text-anchor="end" dominant-baseline="middle" class="minor">${text(timeLabel)}</text>`,
      );
    }
    for (let combo = 50; combo <= judged.length; combo += 50) {
      const note = judged[combo - 1];
      if (note && note.timeMs >= panelStart && note.timeMs < panelEnd)
        labels.push(
          `<text x="${number(right + 6)}" y="${number(yAt(note.timeMs, panel, panelDuration, height, heightPerSecond))}" dominant-baseline="middle" class="minor">${combo}</text>`,
        );
    }
    for (const change of chart.bpmChanges) {
      if (change.timeMs < panelStart || change.timeMs >= panelEnd || change.bpm <= 0) continue;
      const y = yAt(change.timeMs, panel, panelDuration, height, heightPerSecond);
      labels.push(
        `<text x="${number(right + 6)}" y="${number(y)}" dominant-baseline="middle" class="bpm">${Math.round(change.bpm)}</text><line x1="${number(left)}" y1="${number(y)}" x2="${number(right)}" y2="${number(y)}" class="bpm-line"/>`,
      );
    }
    for (const event of chart.timeline.skills) {
      if (event.timeMs < panelStart || event.timeMs >= panelEnd) continue;
      labels.push(
        `<text x="${number(right + 6)}" y="${number(yAt(event.timeMs, panel, panelDuration, height, heightPerSecond))}" dominant-baseline="middle" class="skill">#${event.index + 1}</text>`,
      );
    }
    const simultaneousLines = simultaneous
      .filter(({ left: first }) => first.timeMs >= panelStart && first.timeMs < panelEnd)
      .map(({ left: first, right: second }) => {
        const a = noteBounds(first, panelWidth, laneWidth).center;
        const b = noteBounds(second, panelWidth, laneWidth).center;
        const y = yAt(first.timeMs, panel, panelDuration, height, heightPerSecond);
        return `<line x1="${number(Math.min(a, b))}" y1="${number(y)}" x2="${number(Math.max(a, b))}" y2="${number(y)}" stroke="#fff" stroke-width="${number(Math.max(1, laneWidth / 5))}"/>`;
      })
      .join("");
    const notes = visibleNotes
      .map((note) =>
        renderNote(note, panel, panelStart, panelEnd, panelWidth, laneWidth, height, panelDuration, heightPerSecond),
      )
      .join("");
    panels.push(
      `<g transform="translate(${number(panel * panelWidth)},0)"><rect width="${number(panelWidth)}" height="${number(height)}" fill="#000"/>${renderLane(panelWidth, laneWidth, stageWidth, height, 0)}${renderBpmGrid(chart, panel, panelStart, panelEnd, panelWidth, laneWidth, height, panelDuration, heightPerSecond)}${renderRibbons(chart, panel, panelStart, panelEnd, panelWidth, laneWidth, height, panelDuration, heightPerSecond)}${simultaneousLines}${labels.join("")}${notes}</g>`,
    );
  }
  return panels.join("");
}

function renderLogo(x: number, y: number, scale = 1): string {
  return `<g transform="translate(${number(x)},${number(y)}) scale(${number(scale)})"><circle cx="12" cy="12" r="11" fill="#fff" opacity=".94"/><path d="M7 6h3v5h4V6h3v12h-3v-4h-4v4H7z" fill="#111"/></g>`;
}

function renderStats(chart: ChartDocument, x: number, y: number, width: number): string {
  const counts = countStaticChartNoteKinds(chart);
  const nps =
    chart.durationMs > 0
      ? (chart.notes.filter((note) => note.judged).length / (chart.durationMs / 1000)).toFixed(2)
      : "—";
  const stats = [
    ["NOTES", statValue(counts.tap + counts.flick + counts.slide)],
    ["TAP", statValue(counts.tap)],
    ["FLICK", statValue(counts.flick)],
    ["SLIDE", statValue(counts.slide)],
    ["TIME", durationValue(chart.durationMs)],
    ["BPM", bpmValue(chart)],
    ["NPS", nps],
  ];
  const cellWidth = width / stats.length;
  return stats
    .map(([label, value], index) => {
      const cellX = x + cellWidth * index;
      return `<text x="${number(cellX)}" y="${number(y)}" class="stat-label">${label}</text><text x="${number(cellX)}" y="${number(y + 26)}" class="stat-value">${text(value)}</text>`;
    })
    .join("");
}

export function renderStaticChartOverview(
  chart: ChartDocument,
  meta: StaticChartOverviewMeta,
  options: StaticChartOverviewOptions,
): StaticChartOverviewResult {
  const height = options.height;
  if (!Number.isSafeInteger(height) || height < 360 || height > 1_440) {
    throw new StaticChartOverviewError(
      "invalid_height",
      "Chart image height must be an integer from 360 to 1440 pixels",
    );
  }
  const panelDurationAtBaseScale = (height / 150) * 1000;
  const panelCount = Math.max(1, Math.floor(Math.max(0, finite(chart.durationMs)) / panelDurationAtBaseScale) + 1);
  const maxPanels = options.maxPanels ?? 256;
  if (panelCount > maxPanels) {
    throw new StaticChartOverviewError(
      "render_budget",
      `Chart overview requires ${panelCount} panels; the budget is ${maxPanels}`,
    );
  }
  const basePanelWidth = 130;
  const panelWidth = basePanelWidth;
  const laneWidth = 10;
  const chartWidth = panelCount * panelWidth;
  const padding = 32;
  const width = Math.max(840, Math.ceil(chartWidth + padding * 2));
  const headerHeight = 172;
  const statsHeight = 68;
  const gap = 18;
  const chartY = padding + headerHeight + gap + statsHeight + gap;
  const outputHeight = Math.ceil(chartY + height + padding);
  const maxPixels = options.maxPixels ?? 12_000_000;
  if (width * outputHeight > maxPixels) {
    throw new StaticChartOverviewError(
      "render_budget",
      `Chart overview exceeds the ${maxPixels.toLocaleString("en-US")} pixel budget`,
    );
  }
  const accent = difficultyColor(meta.difficultyName);
  const chartX = Math.max(padding, (width - chartWidth) / 2);
  const title = fitText(meta.title || meta.songId, width - padding * 2 - 120, 32);
  const band = fitText(meta.bandName || "Band", width - padding * 2 - 120, 20);
  const level = `${meta.difficultyName.toUpperCase()} ${meta.displayLevel}`.trim();
  const textLeft = padding + 120;
  const svgTitle = `${meta.title} · ${meta.difficultyName} ${meta.displayLevel}`;
  const svgDescription = `Chart overview for ${meta.title}, ${meta.bandName}, ${meta.difficultyName} level ${meta.displayLevel}`;
  const identity = [meta.server?.toUpperCase(), `ID ${meta.songId}`].filter(Boolean).join(" · ");
  const attributeMark = meta.attribute
    ? `<circle cx="${textLeft + Math.max(104, level.length * 8 + 28) + 18}" cy="${padding + 134}" r="5" fill="${attributeColor(meta.attribute)}"/>`
    : "";
  const jacket = meta.jacketHref
    ? `<image href="${escapeXml(meta.jacketHref)}" x="${padding}" y="${padding + 56}" width="96" height="96" preserveAspectRatio="xMidYMid slice" clip-path="url(#jacket-clip)"/>`
    : `<rect x="${padding}" y="${padding + 56}" width="96" height="96" rx="16" fill="#1f2730"/><text x="${padding + 48}" y="${padding + 110}" text-anchor="middle" class="jacket-id">${text(meta.songId)}</text>`;
  const brandRight = width - padding;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" lang="${text(meta.locale || "en")}" width="${width}" height="${outputHeight}" viewBox="0 0 ${width} ${outputHeight}" role="img" aria-labelledby="title desc">
<title id="title">${text(svgTitle)}</title>
<desc id="desc">${text(svgDescription)}</desc>
<defs><clipPath id="jacket-clip"><rect x="${padding}" y="${padding + 56}" width="96" height="96" rx="16"/></clipPath><linearGradient id="slide-gradient" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#7a49ff" stop-opacity=".86"/><stop offset=".55" stop-color="#4453d9" stop-opacity=".86"/><stop offset="1" stop-color="#5d84fa" stop-opacity=".71"/></linearGradient><linearGradient id="guide-gradient" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#7862ff" stop-opacity=".34"/><stop offset="1" stop-color="#b289ff" stop-opacity=".42"/></linearGradient><style>
text{font-family:${STATIC_CHART_OVERVIEW_FONT_STACK};fill:#fff} .title{font-size:32px;font-weight:400;fill:rgba(255,255,255,.94)} .band{font-size:20px;font-weight:500;fill:rgba(255,255,255,.82)} .pill{font-size:14px;font-weight:500;fill:${accent}} .minor{font-size:10px;fill:rgba(255,255,255,.5)} .bpm{font-size:10px;fill:rgba(255,0,255,.65)} .bpm-line{stroke:rgba(255,0,255,.5);stroke-width:1} .skill{font-size:10px;fill:rgba(255,255,0,.7)} .stat-label{font-size:11px;font-weight:500;fill:rgba(255,255,255,.5)} .stat-value{font-size:19px;font-weight:500;fill:rgba(255,255,255,.92)} .jacket-id{font-size:13px;fill:rgba(255,255,255,.55)}
</style></defs>
<rect width="${width}" height="${outputHeight}" fill="#000"/>
${renderLogo(padding, padding, 1)}<text x="${padding + 36}" y="${padding + 18}" font-size="20" font-weight="500">Haneoka</text><text x="${padding + 132}" y="${padding + 18}" font-size="16" fill="rgba(255,255,255,.7)">haneoka.org</text><text x="${brandRight}" y="${padding + 18}" text-anchor="end" font-size="12" fill="rgba(255,255,255,.52)">Powered by Cassiopeia · ${text(identity)}</text>
${jacket}<text x="${textLeft}" y="${padding + 88}" class="title">${text(title)}</text><text x="${textLeft}" y="${padding + 116}" class="band">${text(band)}</text><rect x="${textLeft}" y="${padding + 120}" width="${Math.max(104, level.length * 8 + 28)}" height="28" rx="14" fill="${accent}" fill-opacity=".2" stroke="${accent}"/><text x="${textLeft + 14}" y="${padding + 139}" class="pill">${text(level)}</text>${attributeMark}
${renderStats(chart, padding, padding + headerHeight + gap + 14, width - padding * 2)}
<g transform="translate(${number(chartX)},${number(chartY)})"><defs><style>.chart-label{font-family:${STATIC_CHART_OVERVIEW_FONT_STACK}}</style></defs>${renderChartStrip(chart, height, panelCount, panelWidth, laneWidth)}</g>
</svg>`;
  const bytes = new TextEncoder().encode(svg).byteLength;
  if (bytes > (options.maxSvgBytes ?? 8 * 1024 * 1024)) {
    throw new StaticChartOverviewError("svg_too_large", `Chart SVG is ${bytes.toLocaleString("en-US")} bytes`);
  }
  return {
    svg,
    width,
    height: outputHeight,
    panelCount,
    noteCount: chart.notes.filter((note) => note.judged).length,
  };
}
