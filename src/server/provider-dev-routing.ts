import type { AstroIntegration } from "astro";
import fs from "node:fs";
import path from "node:path";
import { providerEntityFromUrl, providerEntityPhysicalPath } from "../lib/provider-entity-routing";
import { providerEntityHtmlPath } from "../lib/provider-entity-data";
import { providerEntityManifestEntry, providerEntityRoot } from "./provider-entity-manifest";
import { staticViewFromUrl } from "../lib/static-view-routing";
import { assetStaticDocumentFromUrl } from "../lib/asset-static-routing";
import { playlistStaticDocumentFromUrl } from "../lib/playlists/static-routing";

type Setup = NonNullable<AstroIntegration["hooks"]["astro:server:setup"]>;
type DevServer = Parameters<Setup>[0]["server"];

/** Capture query selection before Astro strips it from prerendered requests. */
export function installProviderDevRouting(server: DevServer): void {
  server.middlewares.use((request, _response, next) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const selected = providerEntityFromUrl(url);
      if (selected) {
        const entry = fs.existsSync(path.join(providerEntityRoot(), "manifest.json")) ? providerEntityManifestEntry(providerEntityHtmlPath(selected), true) : undefined;
        if (entry) request.url = `${providerEntityPhysicalPath(entry)}${url.search}`;
      } else {
        const view = assetStaticDocumentFromUrl(url) || playlistStaticDocumentFromUrl(url) || staticViewFromUrl(url);
        if (view) request.url = `${view}${url.search}`;
      }
      next();
    } catch (error) { next(error); }
  });
}
