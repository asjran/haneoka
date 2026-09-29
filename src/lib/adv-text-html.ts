import { parseAdvRichText, type AdvRichTextNode } from "@haneoka/vega-plugin-richtext";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);

const nodesHtml = (nodes: readonly AdvRichTextNode[]): string =>
  nodes
    .map((node) => {
      if (node.type === "text") return escapeHtml(node.value);
      if (node.type === "break") return "<br>";
      if (node.type === "ruby")
        return `<ruby>${escapeHtml(node.base)}<rp>(</rp><rt>${escapeHtml(node.annotation)}</rt><rp>)</rp></ruby>`;
      // Layout-only nodes (size, spacing, colour, alignment) carry no meaning
      // in a static transcript; keep their text and drop the presentation.
      if (node.type === "space") return "";
      return nodesHtml(node.children);
    })
    .join("");

/**
 * Game ADV text (TextMeshPro/RubyTextMeshPro markup) as safe static HTML.
 * The interactive transcript renders the same grammar through
 * `renderVegaAdvText`; this is its server-side, presentation-free twin.
 */
export function advTextHtml(value: string): string {
  return nodesHtml(parseAdvRichText(value));
}

export { escapeHtml };
