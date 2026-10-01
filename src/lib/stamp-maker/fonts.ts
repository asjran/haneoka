/** Fontsource variable faces expose real 900 masters; imported faces retain their outlines. */
export interface StampFont {
  family: string;
  label: string;
  weight: number;
  stylesheet?: string;
  source?: string;
  weightRange?: readonly [number, number];
}
export const STAMP_FONTS: readonly StampFont[] = [
  // The OFL official OTF is byte-identical to OurNotes' runtime UI face (T05); not a baked-stamp font claim.
  {
    family: "Pretendard SemiBold",
    label: "Pretendard SemiBold",
    weight: 600,
    source:
      "https://raw.githubusercontent.com/orioncactus/pretendard/v1.3.9/packages/pretendard/dist/public/static/Pretendard-SemiBold.otf",
  },
  {
    family: "YurukaStd",
    label: "YurukaStd",
    weight: 900,
    source:
      "https://raw.githubusercontent.com/BedrockDigger/sekai-stickers/0dd52ee69f8838dd173ee252810325debe96731a/src/fonts/YurukaStd.woff2",
  },
  {
    family: "SSFangTangTi",
    label: "SSFangTangTi",
    weight: 400,
    source:
      "https://raw.githubusercontent.com/BedrockDigger/sekai-stickers/0dd52ee69f8838dd173ee252810325debe96731a/src/fonts/ShangShouFangTangTi.woff2",
  },
  { family: "Roboto Variable", label: "Roboto", weight: 900, weightRange: [100, 900] },
  ...["SC", "TC", "JP", "KR"].map((region) => ({
    family: `Noto Sans ${region} Variable`,
    label: `Noto Sans ${region}`,
    weight: 900,
    weightRange: [100, 900] as const,
  })),
  ...["SC", "TC", "JP", "KR"].map((region) => ({
    family: `Noto Serif ${region} Variable`,
    label: `Noto Serif ${region}`,
    weight: 900,
    weightRange: [200, 900] as const,
    stylesheet: `https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-serif-${region.toLowerCase()}@5.3.0/wght.css`,
  })),
];
const imported = new Map<string, StampFont>();
const sourceFaces = new Map<string, Promise<void>>();
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
  if (font?.source) {
    if (!sourceFaces.has(font.family)) {
      const face = new FontFace(font.family, `url("${font.source}")`, { weight: String(font.weight), display: "swap" });
      const request = face
        .load()
        .then(() => {
          document.fonts.add(face);
        })
        .catch((error) => {
          sourceFaces.delete(font.family);
          throw error;
        });
      sourceFaces.set(font.family, request);
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      sourceFaces.get(font.family),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Font file timed out")), 15000);
      }),
    ]).finally(() => clearTimeout(deadline));
  }
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
