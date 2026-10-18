import type { BundledNoteSkin } from "./noteAtlas.js";

export function noteTextureUrl(skin: BundledNoteSkin): string {
  switch (skin) {
    case "skin001":
      return new URL("./note-skins/skin001.png", import.meta.url).href;
    case "skin002":
      return new URL("./note-skins/skin002.png", import.meta.url).href;
    case "skin003":
      return new URL("./note-skins/skin003.png", import.meta.url).href;
  }
}
