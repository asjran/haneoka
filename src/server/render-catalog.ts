import "@lit-labs/ssr/lib/install-global-dom-shim.js";
import { render } from "@lit-labs/ssr";
import { collectResultSync } from "@lit-labs/ssr/lib/render-result.js";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { CatalogScreen } from "../lit/catalog-screen";
import { createServerI18nContext } from "../i18n/server";
import { initializeI18nClient } from "../i18n/client";
import type { EntityPayload, StoryPayload } from "../lib/entity-graph";
import type { Locale } from "../i18n/locales";

type Node = DefaultTreeAdapterMap["node"];
function lightDom(node: Node): void {
  if ("tagName" in node && node.tagName.startsWith("md-")) return;
  if (!("childNodes" in node)) return;
  const children = [];
  for (const child of node.childNodes) {
    if (
      "tagName" in child &&
      child.tagName === "template" &&
      child.attrs.some((attr) => attr.name === "shadowrootmode")
    ) {
      const content = (child as DefaultTreeAdapterMap["template"]).content;
      lightDom(content);
      for (const entry of content.childNodes) {
        entry.parentNode = node;
        children.push(entry);
      }
      if ("attrs" in node) node.attrs.push({ name: "data-prerendered", value: "" });
    } else {
      lightDom(child);
      children.push(child);
    }
  }
  node.childNodes = children;
}

type Seed = ReturnType<ReturnType<typeof createServerI18nContext>["seed"]>;
const seeds = new Map<string, Seed>();
let activeSeed: Seed | undefined;
function useLocale(locale: Locale, route: string): Seed {
  const key = `${locale}:${route}`;
  let seed = seeds.get(key);
  if (!seed) {
    seed = createServerI18nContext(locale, route).seed();
    seeds.set(key, seed);
  }
  if (activeSeed !== seed) {
    const client = initializeI18nClient({ seed });
    client.adoptSeed(seed);
    activeSeed = seed;
  }
  return seed;
}

export async function renderCatalog(config: string, payload: EntityPayload, locale: Locale): Promise<string> {
  useLocale(locale, "/catalog");
  const screen = new CatalogScreen();
  await screen.prepareEntity(payload, config);
  useLocale(locale, "/catalog");
  const fragment = parseFragment(collectResultSync(render(screen.render(), { deferHydration: true })));
  lightDom(fragment);
  return serialize(fragment);
}

export async function renderStory(payload: StoryPayload, locale: Locale): Promise<string> {
  const { StoryWorkspace } = await import("../lit/story-workspace");
  useLocale(locale, "/catalog/stories");
  const workspace = new StoryWorkspace();
  workspace.prepareEntity(payload, locale);
  const fragment = parseFragment(collectResultSync(render(workspace.render(), { deferHydration: true })));
  lightDom(fragment);
  return serialize(fragment);
}
