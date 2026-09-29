import { html, noChange, type TemplateResult } from "lit";
import { Directive, directive } from "lit/directive.js";
import { styleMap } from "lit/directives/style-map.js";
import { parseAdvRichText, advTextLengthCss, type AdvRichTextNode } from "@haneoka/vega-plugin-richtext";

function renderNodes(nodes: readonly AdvRichTextNode[]): Array<string | TemplateResult> {
  return nodes.map((node) => {
    if (node.type === "text") return node.value;
    if (node.type === "break")
      return html`
        <br />
      `;
    if (node.type === "ruby")
      return html`
        <ruby>
          <rb>${node.base}</rb>
          <rt>${node.annotation}</rt>
        </ruby>
      `;
    if (node.type === "style")
      return html`
        <span style=${styleMap(node.style)}>${renderNodes(node.children)}</span>
      `;
    if (node.type === "size")
      return html`
        <span class="vega-rich-text__size" style=${styleMap({ fontSize: `${node.percent}%` })}>
          ${renderNodes(node.children)}
        </span>
      `;
    const length = advTextLengthCss(
      node.unit === "%" ? node.value / 100 : node.value,
      node.unit === "%" ? "em" : node.unit,
    );
    return html`
      <span
        class="vega-rich-text__space"
        aria-hidden="true"
        style=${styleMap({ display: "inline-block", height: "0", width: node.value < 0 ? "0" : length, marginInlineStart: node.value < 0 ? length : undefined })}
      ></span>
    `;
  });
}

class AdvText extends Directive {
  private source?: string;
  render(source: string) {
    if (source === this.source) return noChange;
    this.source = source;
    return renderNodes(parseAdvRichText(source));
  }
}
export const advText = directive(AdvText);
