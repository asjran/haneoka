export interface GachaHistoryReportCard {
  name: string;
  kindLabel: string;
  quantity: number;
  imageUrl?: string;
}
export interface GachaHistoryReport {
  title: string;
  scope: readonly string[];
  metrics: readonly { label: string; value: string }[];
  groups: readonly { label: string; cards: readonly GachaHistoryReportCard[] }[];
}

const WIDTH = 960;
const PAD = 32;
const ROW = 182;
const COLUMNS = 6;
const PAGE_CARDS = 36;

function lines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const result: string[] = [];
  let line = "";
  for (const character of text) {
    if (line && ctx.measureText(line + character).width > width) {
      result.push(line);
      line = "";
    }
    line += character;
  }
  if (line) result.push(line);
  return result;
}

async function loadImage(source: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const timeout = setTimeout(() => {
      image.src = "";
      resolve(null);
    }, 15000);
    image.onload = () => {
      clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };
    image.src = source;
  });
}

export async function renderGachaHistoryImages(report: GachaHistoryReport): Promise<Blob[]> {
  await document.fonts.ready;
  const style = getComputedStyle(document.documentElement);
  const color = (token: string) => style.getPropertyValue(`--md-sys-color-${token}`).trim();
  const font = getComputedStyle(document.body).fontFamily;
  const pages: Array<Array<{ label: string; cards: readonly GachaHistoryReportCard[] }>> = [[]];
  let remaining = PAGE_CARDS;
  for (const group of report.groups) {
    if (!group.cards.length) continue;
    for (let start = 0; start < group.cards.length;) {
      if (!remaining) {
        pages.push([]);
        remaining = PAGE_CARDS;
      }
      const cards = group.cards.slice(start, start + remaining);
      pages[pages.length - 1].push({ label: group.label, cards });
      start += cards.length;
      remaining -= cards.length;
    }
  }
  const images = new Map<string, HTMLImageElement | null>();
  const sources = [
    ...new Set(
      report.groups.flatMap((group) =>
        group.cards.map((card) => card.imageUrl).filter((source): source is string => Boolean(source)),
      ),
    ),
  ];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, sources.length) }, async () => {
      while (cursor < sources.length) {
        const source = sources[cursor++]!;
        images.set(source, (await loadImage(source)) ?? (await loadImage(source)));
      }
    }),
  );
  const output: Blob[] = [];
  for (const [pageIndex, groups] of pages.entries()) {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    const ctx = canvas.getContext("2d")!;
    ctx.font = `500 20px ${font}`;
    const scope = report.scope.flatMap((text) => lines(ctx, text, WIDTH - PAD * 2));
    const headerHeight = 104 + scope.length * 28;
    const metricRows = Math.ceil(report.metrics.length / 3);
    canvas.height =
      headerHeight +
      metricRows * 104 +
      36 +
      groups.reduce((height, group) => height + 52 + Math.ceil(group.cards.length / COLUMNS) * ROW, 0) +
      52;
    ctx.fillStyle = color("surface");
    ctx.fillRect(0, 0, WIDTH, canvas.height);
    ctx.textBaseline = "top";
    ctx.fillStyle = color("on-surface");
    ctx.font = `700 36px ${font}`;
    ctx.fillText(report.title, PAD, PAD, WIDTH - PAD * 2);
    ctx.font = `500 20px ${font}`;
    ctx.fillStyle = color("on-surface-variant");
    scope.forEach((text, index) => ctx.fillText(text, PAD, 88 + index * 28));
    const metricWidth = (WIDTH - PAD * 2 - 24) / 3;
    for (const [index, metric] of report.metrics.entries()) {
      const x = PAD + (index % 3) * (metricWidth + 12),
        y = headerHeight + Math.floor(index / 3) * 104;
      ctx.fillStyle = color("surface-container");
      ctx.beginPath();
      ctx.roundRect(x, y, metricWidth, 92, 20);
      ctx.fill();
      ctx.fillStyle = color("on-surface-variant");
      ctx.font = `500 16px ${font}`;
      ctx.fillText(metric.label, x + 16, y + 14, metricWidth - 32);
      ctx.fillStyle = color("on-surface");
      ctx.font = `600 27px ${font}`;
      ctx.fillText(metric.value, x + 16, y + 44, metricWidth - 32);
    }
    let y = headerHeight + metricRows * 104 + 24;
    const cardWidth = (WIDTH - PAD * 2 - 12 * (COLUMNS - 1)) / COLUMNS;
    for (const group of groups) {
      ctx.fillStyle = color("primary");
      ctx.font = `600 26px ${font}`;
      ctx.fillText(group.label, PAD, y);
      y += 48;
      for (const [index, card] of group.cards.entries()) {
        const x = PAD + (index % COLUMNS) * (cardWidth + 12),
          top = y + Math.floor(index / COLUMNS) * ROW;
        ctx.fillStyle = color("surface-container");
        ctx.beginPath();
        ctx.roundRect(x, top, cardWidth, cardWidth, 16);
        ctx.fill();
        const image = card.imageUrl ? images.get(card.imageUrl) : null;
        if (image) {
          const scale = Math.min(cardWidth / image.naturalWidth, cardWidth / image.naturalHeight);
          const w = image.naturalWidth * scale,
            h = image.naturalHeight * scale;
          ctx.drawImage(image, x + (cardWidth - w) / 2, top + (cardWidth - h) / 2, w, h);
        }
        ctx.fillStyle = color("primary-container");
        ctx.beginPath();
        ctx.roundRect(x + cardWidth - 52, top + cardWidth - 28, 48, 24, 12);
        ctx.fill();
        ctx.fillStyle = color("on-primary-container");
        ctx.font = `600 16px ${font}`;
        ctx.fillText(`×${card.quantity}`, x + cardWidth - 46, top + cardWidth - 25, 38);
        ctx.fillStyle = color("on-surface");
        ctx.font = `500 14px ${font}`;
        ctx.fillText(card.name, x, top + cardWidth + 8, cardWidth);
        ctx.fillStyle = color("on-surface-variant");
        ctx.font = `400 13px ${font}`;
        ctx.fillText(card.kindLabel, x, top + cardWidth + 28, cardWidth);
      }
      y += Math.ceil(group.cards.length / COLUMNS) * ROW;
    }
    ctx.fillStyle = color("on-surface-variant");
    ctx.font = `500 16px ${font}`;
    ctx.fillText(`Haneoka · ${pageIndex + 1}/${pages.length}`, PAD, canvas.height - 36);
    output.push(
      await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("image_export_failed"))), "image/png"),
      ),
    );
  }
  return output;
}
