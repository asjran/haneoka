/** Fontsource variable faces expose real 900 masters; imported faces retain their outlines. */
export interface StampFont {
  family: string;
  label: string;
  weight: number;
  stylesheet?: string;
}
export const STAMP_FONTS: readonly StampFont[] = [
  { family: "Roboto Variable", label: "Roboto", weight: 900 },
  ...["SC", "TC", "JP", "KR"].map((region) => ({
    family: `Noto Sans ${region} Variable`,
    label: `Noto Sans ${region}`,
    weight: 900,
  })),
  ...["SC", "TC", "JP", "KR"].map((region) => ({
    family: `Noto Serif ${region} Variable`,
    label: `Noto Serif ${region}`,
    weight: 900,
    stylesheet: `https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-serif-${region.toLowerCase()}@5.3.0/wght.css`,
  })),
];
const imported = new Map<string, StampFont>();
const stylesheets = new Map<string, { link: HTMLLinkElement; ready: Promise<void> }>();
export const stampFont = (family: string): StampFont | undefined =>
  STAMP_FONTS.find((font) => font.family === family) || imported.get(family);

export function registerImportedFont(face: FontFace, label: string): StampFont {
  const font = { family: face.family, label, weight: 400 };
  imported.set(face.family, font);
  document.fonts.add(face);
  return font;
}
export function removeImportedFont(face: FontFace): void {
  document.fonts.delete(face);
  imported.delete(face.family);
}

export async function loadFontStylesheet(font: StampFont | undefined): Promise<void> {
  if (!font?.stylesheet) return;
  const url = font.stylesheet;
  if (stylesheets.has(url) && !stylesheets.get(url)!.link.isConnected) stylesheets.delete(url);
  if (!stylesheets.has(url)) {
    const link = document.createElement("link");
    const request = new Promise<void>((resolve, reject) => {
      link.rel = "stylesheet";
      link.href = url;
      const timeout = window.setTimeout(() => fail(), 15000);
      const fail = () => {
        clearTimeout(timeout);
        link.remove();
        if (stylesheets.get(url)?.link === link) stylesheets.delete(url);
        reject(new Error("Fontsource stylesheet unavailable"));
      };
      link.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      link.onerror = fail;
      document.head.append(link);
    });
    stylesheets.set(url, { link, ready: request });
  }
  await stylesheets.get(url)!.ready;
}
