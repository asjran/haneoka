import skin001Archive from "./note-skins/skin001.json" with { type: "json" };
import skin002Archive from "./note-skins/skin002.json" with { type: "json" };
import skin003Archive from "./note-skins/skin003.json" with { type: "json" };
import { noteTextureUrl } from "./noteTextures.js";

export type BundledNoteSkin = "skin001" | "skin002" | "skin003";

export type NoteSkinKind =
  "tap" | "flick" | "flick-left" | "flick-right" | "slide-start" | "slide-node" | "slide-end" | "trace";

export type NoteSkinCurve =
  | number
  | ReadonlyArray<{
      readonly time: number;
      readonly a: number;
      readonly b: number;
      readonly c: number;
      readonly d: number;
    }>;

export interface NoteArrowAnimation {
  readonly duration: number;
  readonly x: NoteSkinCurve;
  readonly y: NoteSkinCurve;
  readonly scaleX: NoteSkinCurve;
  readonly scaleY: NoteSkinCurve;
  readonly alpha: NoteSkinCurve;
}

export function sampleNoteSkinCurve(curve: NoteSkinCurve, time: number): number {
  if (typeof curve === "number") return curve;
  let key = curve[0];
  if (!key) return 0;
  for (let index = 1; index < curve.length; index++) {
    if (curve[index]!.time > time) break;
    key = curve[index]!;
  }
  const delta = Math.max(0, time - key.time);
  return ((key.a * delta + key.b) * delta + key.c) * delta + key.d;
}

export interface NoteSkinDefinition {
  readonly mainSprite: string;
  readonly centerMarkSprite: string | null;
  readonly parts: ReadonlyArray<{
    readonly tilt: number;
    readonly leftSprite: string | null;
    readonly rightSprite: string | null;
    readonly leftOverhang: number;
    readonly rightOverhang: number;
  }>;
  readonly arrows: ReadonlyArray<{ readonly maxWidth: number; readonly sprite: string | null }>;
  readonly arrowAnimation?: NoteArrowAnimation;
}

export interface BundledNoteAtlas {
  readonly textureUrl: string;
  readonly atlasMetadata: unknown;
  readonly spriteMetadata: Readonly<Record<string, unknown>>;
  readonly notes: Readonly<Record<NoteSkinKind, NoteSkinDefinition>>;
}

/**
 * Formal Intl atlas and Sprite projections. The renderer can consume these
 * decoded objects directly; the URL fields remain package-relative for the
 * emitted PNGs and external/custom atlas manifests.
 */
function bundleNoteAtlas(
  skin: BundledNoteSkin,
  archive: {
    atlas: unknown;
    sprites: Readonly<Record<string, unknown>>;
    notes: Readonly<Record<NoteSkinKind, NoteSkinDefinition>>;
  },
): BundledNoteAtlas {
  return {
    get textureUrl() {
      return noteTextureUrl(skin);
    },
    atlasMetadata: archive.atlas,
    spriteMetadata: archive.sprites,
    notes: archive.notes,
  };
}

export const OUR_NOTES_BUNDLED_NOTE_ATLASES: Readonly<Record<BundledNoteSkin, BundledNoteAtlas>> = {
  skin001: bundleNoteAtlas("skin001", skin001Archive),
  skin002: bundleNoteAtlas("skin002", skin002Archive),
  skin003: bundleNoteAtlas("skin003", skin003Archive),
};
