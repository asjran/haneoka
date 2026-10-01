import { createHaneokaBranding } from "@haneoka/embed-core/branding";

export function createChartHost(container: HTMLElement, locale: string) {
  const document = container.ownerDocument;
  const element = document.createElement("div");
  element.className = "haneoka-chart-embed";
  element.lang = locale;
  const viewport = document.createElement("div");
  viewport.className = "haneoka-chart-embed__viewport";
  const brand = createHaneokaBranding(document);
  const restoreBrand = () => element.append(brand);
  const fullscreenChanged = () => {
    const fullscreen = document.fullscreenElement;
    if (fullscreen && viewport.contains(fullscreen)) fullscreen.append(brand);
    else restoreBrand();
  };
  restoreBrand();
  element.prepend(viewport);
  container.append(element);
  document.addEventListener("fullscreenchange", fullscreenChanged);
  return {
    element,
    viewport,
    restoreBrand,
    dispose() {
      document.removeEventListener("fullscreenchange", fullscreenChanged);
      brand.remove();
      element.remove();
    },
  };
}
