/** Fontsource variable faces expose real 900 masters; imported faces retain their outlines. */
export interface StampFont {
  family: string;
  label: string;
  weight: number;
  stylesheet?: string;
  source?: string;
  provenance?: string;
  weightRange?: readonly [number, number];
}
export const STAMP_FONTS: readonly StampFont[] = [
  // The OFL official OTF is byte-identical to OurNotes' runtime UI face (T05); not a baked-stamp font claim.
  {
    family: "Pretendard SemiBold",
    label: "Pretendard SemiBold",
    weight: 600,
    source: "/stamp-maker-fonts/c89bc43027dc7cde5726e96223376f8eec09302b2fc1f8147fd5b57cfc376118.otf",
    provenance:
      "https://raw.githubusercontent.com/orioncactus/pretendard/v1.3.9/packages/pretendard/dist/public/static/Pretendard-SemiBold.otf",
  },
  {
    family: "YurukaStd",
    label: "YurukaStd",
    weight: 900,
    source: "/stamp-maker-fonts/604b78800e5bac3ef9dbb0fdb87bef7ecaafcd553330fda5c3d725e32569f4de.woff2",
    provenance:
      "https://raw.githubusercontent.com/BedrockDigger/sekai-stickers/0dd52ee69f8838dd173ee252810325debe96731a/src/fonts/YurukaStd.woff2",
  },
  {
    family: "SSFangTangTi",
    label: "SSFangTangTi",
    weight: 400,
    source: "/stamp-maker-fonts/077c89525d0a48b5775f8fadbf09a40344ff4845779202f1f9c39b7857ad4e2e.woff2",
    provenance:
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
    stylesheet: `/stamp-maker-fonts/noto-serif-${region.toLowerCase()}-v5.3.0/wght.css`,
    provenance: `https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-serif-${region.toLowerCase()}@5.3.0/wght.css`,
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

export class StampFontLoadError extends Error {
  constructor(
    public readonly code: "timeout" | "http" | "size" | "decode" | "network",
    message: string,
  ) {
    super(message);
    this.name = "StampFontLoadError";
  }
}
const FONT_DEADLINE_MS = 15000;
const MAX_FONT_BYTES = 4 * 1024 * 1024;
async function readFontBytes(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > MAX_FONT_BYTES) throw new StampFontLoadError("size", "Font file exceeds the size limit");
  if (!response.body) throw new StampFontLoadError("http", "Font response has no body");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_FONT_BYTES) throw new StampFontLoadError("size", "Font file exceeds the size limit");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
async function prepareSourceFace(font: StampFont): Promise<void> {
  const key = `${font.family}|${font.weight}|${font.source}`;
  const existing = sourceFaces.get(key);
  if (existing) return existing;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new StampFontLoadError("timeout", "Font loading timed out");
      controller.abort(error);
      reject(error);
    }, FONT_DEADLINE_MS);
  });
  const operation = (async () => {
    const response = await fetch(font.source!, { signal: controller.signal, credentials: "omit" });
    if (!response.ok) throw new StampFontLoadError("http", `Font HTTP ${response.status}`);
    const bytes = await readFontBytes(response, controller.signal);
    const face = new FontFace(font.family, bytes, { weight: String(font.weight), display: "swap" });
    try {
      await face.load();
    } catch {
      throw new StampFontLoadError("decode", "Font data could not be decoded");
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    document.fonts.add(face);
  })();
  const ready = Promise.race([operation, timeout])
    .catch((error) => {
      if (sourceFaces.get(key) === ready) sourceFaces.delete(key);
      const failure =
        error instanceof StampFontLoadError
          ? error
          : controller.signal.aborted
            ? controller.signal.reason
            : new StampFontLoadError("network", "Font request failed");
      controller.abort(failure);
      throw failure;
    })
    .finally(() => clearTimeout(timer));
  sourceFaces.set(key, ready);
  return ready;
}
export async function loadFontStylesheet(font: StampFont | undefined): Promise<void> {
  if (font?.source) await prepareSourceFace(font);
  if (!font?.stylesheet) return;
  const url = font.stylesheet;
  if (stylesheets.has(url) && !stylesheets.get(url)!.link.isConnected) stylesheets.delete(url);
  if (!stylesheets.has(url)) {
    const link = document.createElement("link");
    const request = new Promise<void>((resolve, reject) => {
      link.rel = "stylesheet";
      link.href = url;
      const timeout = window.setTimeout(() => fail(), FONT_DEADLINE_MS);
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
