import type { FrameBounds, StampTextFrame } from "./frame";
export type StampWritingMode = "horizontal" | "vertical-rl" | "vertical-lr";
export interface TextCell {
  text: string;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  offsetX?: number;
  offsetY?: number;
}
export interface StampTextLayout {
  cells: TextCell[];
  frameBounds?: FrameBounds;
  overflow: boolean;
  inkBounds: { left: number; top: number; right: number; bottom: number };
  bounds: { left: number; top: number; right: number; bottom: number };
}

// Rotate the original punctuation outlines; source faces need no extra presentation-form glyphs.
const VERTICAL_ROTATED = new Set([
  ..."（）｛｝〔〕【】《》〈〉「」『』…—ー：；",
]);
const VERTICAL_CORNER = new Set([..."、。，．"]);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const letters = /^(?:\p{Script=Latin}\p{Mark}*|[0-9])$/u;
const runPunctuation = /^[.,:;!?'"\-]$/u;

interface VerticalToken {
  text: string;
  rotated: boolean;
  advance: number;
  scale: number;
  offsetX?: number;
  offsetY?: number;
}
function verticalTokens(
  context: CanvasRenderingContext2D,
  line: string,
  size: number,
  limit: number,
  preserveSize = false,
): VerticalToken[] {
  const characters = [...graphemes.segment(line)].map((item) => item.segment);
  const tokens: VerticalToken[] = [];
  for (let index = 0; index < characters.length;) {
    if (letters.test(characters[index])) {
      let run = characters[index++];
      while (
        index < characters.length &&
        (letters.test(characters[index]) ||
          runPunctuation.test(characters[index]))
      ) {
        const next = run + characters[index];
        if (context.measureText(next).width > limit && run) break;
        run = next;
        index++;
      }
      // One or two digits stay upright as tate-chu-yoko within one em.
      const upright = /^\d{1,2}$/u.test(run);
      const width = context.measureText(run).width;
      const scale = upright
        ? Math.min(1, (size * 0.9) / Math.max(1, width))
        : preserveSize
          ? 1
          : Math.min(1, limit / Math.max(1, width));
      tokens.push({
        text: run,
        rotated: !upright,
        advance: upright ? size * 1.15 : width * scale + size * 0.12,
        scale,
      });
    } else {
      const character = characters[index++];
      tokens.push({
        text: character,
        rotated: VERTICAL_ROTATED.has(character),
        ...(VERTICAL_CORNER.has(character)
          ? { offsetX: size * 0.25, offsetY: -size * 0.25 }
          : {}),
        advance: size * 1.15,
        scale: 1,
      });
    }
  }
  return tokens;
}

function inkBounds(
  context: CanvasRenderingContext2D,
  cells: readonly TextCell[],
  stroke: number,
) {
  let left = Infinity,
    right = -Infinity,
    top = Infinity,
    bottom = -Infinity;
  for (const cell of cells) {
    if (!cell.text.trim()) continue;
    const metric = context.measureText(cell.text);
    const x0 = -metric.actualBoundingBoxLeft - stroke,
      x1 = metric.actualBoundingBoxRight + stroke;
    const y0 = -metric.actualBoundingBoxAscent - stroke,
      y1 = metric.actualBoundingBoxDescent + stroke;
    const cos = Math.cos(cell.rotation),
      sin = Math.sin(cell.rotation);
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]) {
      const px = cell.x + (x * cos - y * sin) * cell.scale,
        py = cell.y + (x * sin + y * cos) * cell.scale;
      left = Math.min(left, px);
      right = Math.max(right, px);
      top = Math.min(top, py);
      bottom = Math.max(bottom, py);
    }
  }
  return Number.isFinite(left)
    ? { left, right, top, bottom }
    : { left: 0, right: 0, top: 0, bottom: 0 };
}

/** Real Canvas cells shared by preview, PNG drawing and hit testing. Newlines start columns. */
function legacyStampTextLayout(
  context: CanvasRenderingContext2D,
  text: string,
  size: number,
  width: number,
  stroke: number,
  mode: StampWritingMode = "horizontal",
): StampTextLayout {
  const padding = stroke + width * 0.012;
  const gap = size * 1.15;
  if (mode === "horizontal") {
    const lines = text.split("\n");
    const extent = Math.max(
      ...lines.map((line) => context.measureText(line).width),
    );
    const height = (lines.length - 1) * gap + size * 1.3;
    const cells = lines.map((line, index) => ({
      text: line,
      x: 0,
      y: (index - (lines.length - 1) / 2) * gap,
      rotation: 0,
      scale: 1,
    }));
    return {
      cells,
      overflow: false,
      inkBounds: inkBounds(context, cells, stroke),
      bounds: {
        left: -extent / 2 - padding,
        right: extent / 2 + padding,
        top: -height / 2 - padding,
        bottom: height / 2 + padding,
      },
    };
  }
  const limit = width * 0.8;
  const columns: VerticalToken[][] = [];
  for (const line of text.split("\n")) {
    let column: VerticalToken[] = [];
    let used = 0;
    for (const token of verticalTokens(context, line, size, limit)) {
      if (column.length && used + token.advance > limit) {
        columns.push(column);
        column = [];
        used = 0;
      }
      column.push(token);
      used += token.advance;
    }
    columns.push(column);
  }
  const height = Math.max(
    size,
    ...columns.map((column) =>
      column.reduce((total, token) => total + token.advance, 0),
    ),
  );
  const cells: TextCell[] = [];
  columns.forEach((column, index) => {
    const x =
      (index - (columns.length - 1) / 2) *
      gap *
      (mode === "vertical-rl" ? -1 : 1);
    let y = -height / 2;
    column.forEach((token) => {
      cells.push({
        text: token.text,
        x: x + (token.offsetX || 0),
        y: y + token.advance / 2 + (token.offsetY || 0),
        rotation: token.rotated ? Math.PI / 2 : 0,
        scale: token.scale,
      });
      y += token.advance;
    });
  });
  const halfWidth = ((columns.length - 1) * gap + size * 1.3) / 2;
  return {
    cells,
    overflow: false,
    inkBounds: inkBounds(context, cells, stroke),
    bounds: {
      left: -halfWidth - padding,
      right: halfWidth + padding,
      top: -height / 2 - padding,
      bottom: height / 2 + padding,
    },
  };
}

function wrapHorizontal(
  context: CanvasRenderingContext2D,
  text: string,
  limit: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const item of words.segment(paragraph)) {
      let token = item.segment;
      if (context.measureText(line + token).width <= limit) {
        line += token;
        continue;
      }
      if (line.trim()) {
        lines.push(line.trimEnd());
        line = "";
        token = token.trimStart();
      }
      for (const item of graphemes.segment(token)) {
        const next = item.segment;
        if (line && context.measureText(line + next).width > limit) {
          lines.push(line.trimEnd());
          line = "";
        }
        line += next;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Explicit frames wrap without changing font size; excess content is clipped by the renderer. */
export function stampTextLayout(
  context: CanvasRenderingContext2D,
  text: string,
  size: number,
  width: number,
  stroke: number,
  mode: StampWritingMode = "horizontal",
  frame?: StampTextFrame,
): StampTextLayout {
  if (!frame)
    return legacyStampTextLayout(context, text, size, width, stroke, mode);
  const frameWidth = (width * frame.width) / 100,
    frameHeight = (width * frame.height) / 100;
  const bounds = {
    left: -frameWidth / 2,
    right: frameWidth / 2,
    top: -frameHeight / 2,
    bottom: frameHeight / 2,
  };
  const innerWidth = Math.max(1, frameWidth - 2 * stroke),
    innerHeight = Math.max(1, frameHeight - 2 * stroke),
    gap = size * 1.15;
  const cells: TextCell[] = [];
  let overflow = false;
  if (mode === "horizontal") {
    const lines = wrapHorizontal(context, text, innerWidth);
    const count = Math.max(1, Math.floor((innerHeight - size * 1.3) / gap) + 1);
    const visible = lines.slice(0, count);
    overflow = visible.length < lines.length;
    visible.forEach((line, index) =>
      cells.push({
        text: line,
        x: 0,
        y: (index - (visible.length - 1) / 2) * gap,
        rotation: 0,
        scale: 1,
      }),
    );
  } else {
    const columns: VerticalToken[][] = [];
    for (const line of text.split("\n")) {
      let column: VerticalToken[] = [],
        used = 0;
      for (const token of verticalTokens(
        context,
        line,
        size,
        innerHeight,
        true,
      )) {
        if (column.length && used + token.advance > innerHeight) {
          columns.push(column);
          column = [];
          used = 0;
        }
        column.push(token);
        used += token.advance;
      }
      columns.push(column);
    }
    const count = Math.max(1, Math.floor((innerWidth - size * 1.3) / gap) + 1);
    const visible = columns.slice(0, count);
    overflow = visible.length < columns.length;
    const height = Math.max(
      size,
      ...visible.map((column) =>
        column.reduce((sum, token) => sum + token.advance, 0),
      ),
    );
    visible.forEach((column, index) => {
      const x =
        (index - (visible.length - 1) / 2) *
        gap *
        (mode === "vertical-rl" ? -1 : 1);
      let y = -height / 2;
      for (const token of column) {
        cells.push({
          text: token.text,
          x: x + (token.offsetX || 0),
          y: y + token.advance / 2 + (token.offsetY || 0),
          rotation: token.rotated ? Math.PI / 2 : 0,
          scale: token.scale,
        });
        y += token.advance;
      }
    });
  }
  const ink = inkBounds(context, cells, stroke);
  overflow ||=
    ink.left < bounds.left ||
    ink.right > bounds.right ||
    ink.top < bounds.top ||
    ink.bottom > bounds.bottom;
  const clipped = {
    left: Math.max(ink.left, bounds.left),
    right: Math.min(ink.right, bounds.right),
    top: Math.max(ink.top, bounds.top),
    bottom: Math.min(ink.bottom, bounds.bottom),
  };
  return {
    cells,
    bounds,
    frameBounds: bounds,
    overflow,
    inkBounds:
      clipped.left <= clipped.right && clipped.top <= clipped.bottom
        ? clipped
        : { left: 0, right: 0, top: 0, bottom: 0 },
  };
}
