import "@lit-labs/ssr/lib/install-global-dom-shim.js";
import { LitElementRenderer, type RenderInfo } from "@lit-labs/ssr";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const STYLE_PREFIX = "/_astro/material-ssr/";
type StyledConstructor = { elementStyles?: readonly { cssText: string }[] };

export function createMaterialStyleRenderer(development: boolean): typeof LitElementRenderer {
  const assets = new WeakMap<object, { href: string; file: string; css: string }>();
  function stylesheet(constructor: object, styles: readonly { cssText: string }[]): string {
    let asset = assets.get(constructor);
    if (!asset) {
      const css = styles.map((style) => style.cssText).join("");
      const digest = createHash("sha256").update(css).digest("hex");
      const href = `${STYLE_PREFIX}${digest}.css`;
      asset = {
        href,
        css,
        file: path.join(process.cwd(), development ? ".generated-public" : ".output/public", href.slice(1)),
      };
      assets.set(constructor, asset);
    }
    if (!fs.existsSync(asset.file)) {
      fs.mkdirSync(path.dirname(asset.file), { recursive: true });
      const temporary = `${asset.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, asset.css);
      fs.renameSync(temporary, asset.file);
    }
    return asset.href;
  }
  return class MaterialStyleRenderer extends LitElementRenderer {
    static override matchesClass(constructor: typeof HTMLElement, tagName = ""): boolean {
      return tagName.startsWith("md-") && super.matchesClass(constructor);
    }
    override renderShadow(renderInfo: RenderInfo) {
      const rendered = super.renderShadow(renderInfo);
      const constructor = this.element.constructor as StyledConstructor;
      const styles = constructor.elementStyles;
      if (
        !rendered ||
        !styles?.length ||
        rendered[0] !== "<style>" ||
        rendered[styles.length + 1] !== "</style>" ||
        styles.some((style, index) => rendered[index + 1] !== style.cssText)
      )
        return rendered;
      const href = stylesheet(constructor, styles);
      return [`<link rel="stylesheet" href="${href}" data-material-ssr>`, ...rendered.slice(styles.length + 2)];
    }
  };
}

export function withMaterialStylePreloads(html: string): string {
  const hrefs = new Set<string>();
  for (const match of html.matchAll(
    /<link\b(?=[^>]*\bdata-material-ssr(?:[=>\s]))[^>]*\bhref="(\/_astro\/material-ssr\/[a-f0-9]{64}\.css)"[^>]*>/gu,
  ))
    hrefs.add(match[1]!);
  const preloads = [...hrefs]
    .filter((href) => !html.includes(`data-material-ssr-preload="${href}"`))
    .map(
      (href) =>
        `<link rel="preload" as="style" href="${href}" fetchpriority="high" data-material-ssr-preload="${href}">`,
    )
    .join("");
  return preloads ? html.replace(/<\/head\s*>/iu, (head) => preloads + head) : html;
}
