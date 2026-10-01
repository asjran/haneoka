import { localizedText, type JsonRecord } from "../../lit/shared/catalog";
import { stampAssetUrl } from "./catalog";
export interface StampCharacterColor {
  id: string;
  name: string;
  color: string;
  image?: string;
}
/** Consume actual published colorCode (or the documented entity color fields), never infer a palette. */
export function stampCharacterColors(catalog: JsonRecord, locale: string): StampCharacterColor[] {
  return Object.entries(catalog)
    .flatMap(([id, value]) => {
      if (!value || typeof value !== "object") return [];
      const item = value as JsonRecord;
      const character = item.character && typeof item.character === "object" ? (item.character as JsonRecord) : item;
      const color = character.colorCode || character.color || character.colour;
      if (typeof color !== "string" || !/^#[0-9a-f]{6}$/iu.test(color)) return [];
      const name = localizedText(character.nickname || character.characterName || character.name, locale);
      if (!name) return [];
      return [{ id, name, color, image: stampAssetUrl(character.faceImage || character.thumbnailImage) }];
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
}
