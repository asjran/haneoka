import { defaultStampText, type StampText } from "./render";
export interface StampLayer {
  id: string;
  settings: StampText;
  colorCharacter: string;
  backgroundCharacter: string;
  colorWasChosen: boolean;
}
export function copyStampText(text: StampText): StampText {
  return { ...text, background: text.background ? { ...text.background } : undefined };
}
export function createStampLayer(text = defaultStampText()): StampLayer {
  return {
    id: `stamp-layer-${crypto.randomUUID()}`,
    settings: copyStampText(text),
    colorCharacter: "custom",
    backgroundCharacter: "custom",
    colorWasChosen: false,
  };
}
