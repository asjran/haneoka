import { defineCassiopeiaPlugin, defineCassiopeiaService } from "@haneoka/cassiopeia/plugin";
import { OurNotesRenderer } from "./render/OurNotesRenderer";
export const THREE_RENDERER = defineCassiopeiaService<{
  create(...args: ConstructorParameters<typeof OurNotesRenderer>): OurNotesRenderer;
}>("cassiopeia.renderer-three.v1");
export function createThreeRendererPlugin() {
  return defineCassiopeiaPlugin({
    manifest: {
      id: "cassiopeia.renderer-three",
      version: "0.1.0",
      apiVersion: 1,
      requires: ["cassiopeia.our-notes"],
      provides: [THREE_RENDERER.id],
    },
    setup(context) {
      context.provide(THREE_RENDERER, { create: (...args) => new OurNotesRenderer(...args) });
    },
  });
}
