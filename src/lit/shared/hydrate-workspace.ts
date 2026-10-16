import { hydrate } from "@lit-labs/ssr-client";
import type { RenderOptions } from "lit";

/** Each light DOM workspace owns its own SSR parts, like a shadow root owns its parts. */
export function hydrateWorkspace(value: unknown, container: Element, options: RenderOptions): void {
  const markers = new Map<Comment, string>();
  for (const child of container.querySelectorAll("[data-prerendered]")) {
    if (child.parentElement?.closest("[data-prerendered]") !== container) continue;
    const walker = container.ownerDocument.createTreeWalker(child, NodeFilter.SHOW_COMMENT);
    let marker: Comment | null;
    while ((marker = walker.nextNode() as Comment | null)) {
      if (markers.has(marker) || !/^(?:lit-part|\/lit-part|lit-node)(?: |$)/u.test(marker.data)) continue;
      markers.set(marker, marker.data);
      marker.data = `workspace-owned:${marker.data}`;
    }
  }
  try {
    hydrate(value, container, options);
  } finally {
    for (const [marker, data] of markers) marker.data = data;
  }
}
