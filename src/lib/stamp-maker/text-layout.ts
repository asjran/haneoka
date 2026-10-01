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
  bounds: { left: number; top: number; right: number; bottom: number };
}

// Rotate the original punctuation outlines; source faces need no extra presentation-form glyphs.
const VERTICAL_ROTATED = new Set([..."（）｛｝〔〕【】《》〈〉「」『』…—ー：；"]);
const VERTICAL_CORNER = new Set([..."、。，．"]);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
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
function verticalTokens(context: CanvasRenderingContext2D, line: string, size: number, limit: number): VerticalToken[] {
  const characters = [...graphemes.segment(line)].map((item) => item.segment);
  const tokens: VerticalToken[] = [];
  for (let index = 0; index < characters.length;) {
    if (letters.test(characters[index])) {
      let run = characters[index++];
      while (index < characters.length && (letters.test(characters[index]) || runPunctuation.test(characters[index]))) {
        const next = run + characters[index];
        if (context.measureText(next).width > limit && run) break;
        run = next;
        index++;
      }
      // One or two digits stay upright as tate-chu-yoko within one em.
      const upright = /^\d{1,2}$/u.test(run);
      const width = context.measureText(run).width;
      const scale = upright ? Math.min(1, (size * 0.9) / Math.max(1, width)) : Math.min(1, limit / Math.max(1, width));
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
        ...(VERTICAL_CORNER.has(character) ? { offsetX: size * 0.25, offsetY: -size * 0.25 } : {}),
        advance: size * 1.15,
        scale: 1,
      });
    }
  }
  return tokens;
}

/** Real Canvas cells shared by preview, PNG drawing and hit testing. Newlines start columns. */
export function stampTextLayout(
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
    const extent = Math.max(...lines.map((line) => context.measureText(line).width));
    const height = (lines.length - 1) * gap + size * 1.3;
    return {
      cells: lines.map((line, index) => ({
        text: line,
        x: 0,
        y: (index - (lines.length - 1) / 2) * gap,
        rotation: 0,
        scale: 1,
      })),
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
  const height = Math.max(size, ...columns.map((column) => column.reduce((total, token) => total + token.advance, 0)));
  const cells: TextCell[] = [];
  columns.forEach((column, index) => {
    const x = (index - (columns.length - 1) / 2) * gap * (mode === "vertical-rl" ? -1 : 1);
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
    bounds: {
      left: -halfWidth - padding,
      right: halfWidth + padding,
      top: -height / 2 - padding,
      bottom: height / 2 + padding,
    },
  };
}
