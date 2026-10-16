import { renderWorkspacePage, useStaticLocale, type StaticWorkspacePage } from "./render-workspace";
import type { Locale } from "../i18n/locales";

export async function renderModelWorkspace(
  kind: "live2d" | "spine",
  payload: { id: string; model: Record<string, unknown> },
  locale: Locale,
  previewSrc = "",
): Promise<StaticWorkspacePage> {
  await Promise.all([
    import("@material/web/select/outlined-select.js"),
    import("@material/web/select/select-option.js"),
    import("@material/web/textfield/outlined-text-field.js"),
    import("@material/web/slider/slider.js"),
    import("@material/web/switch/switch.js"),
  ]);
  const Constructor =
    kind === "live2d"
      ? (await import("../lit/live2d-workspace")).Live2DWorkspace
      : (await import("../lit/spine-workspace")).SpineWorkspace;
  const route = `/catalog/${kind}`;
  useStaticLocale(locale, route);
  const workspace = new Constructor();
  workspace.prepareEntity(payload.model, locale, payload.id, previewSrc);
  return renderWorkspacePage(workspace, locale, route);
}
