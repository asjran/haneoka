import { vegaDefaultShell } from "@haneoka/vega-shell-default";
import { vegaHaneokaTheme } from "@haneoka/vega-theme-haneoka";
import type { VegaPlugin } from "@haneoka/vega/plugin";

/** Install with theme: "haneoka" to reuse the existing theme and shell. */
export const haneokaStoryPlugins: readonly VegaPlugin[] = Object.freeze([vegaDefaultShell, vegaHaneokaTheme]);
export { HANEOKA_POST_TEXTURE_ASSETS, createHaneokaThemeAssetsPlugin } from "@haneoka/vega-theme-haneoka";
