import { defaultStampText, type StampText } from "./render";
export interface StampImageTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface StampLayer {
  id: string;
  image?: StampImageTransform;
  settings: StampText;
  colorCharacter: string;
  backgroundCharacter: string;
  colorWasChosen: boolean;
}
export function copyStampText(text: StampText): StampText {
  return {
    ...text,
    background: text.background ? { ...text.background } : undefined,
  };
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

export function createStampImageLayer(): StampLayer {
  return {
    ...createStampLayer({ ...defaultStampText(), text: "", font: "auto" }),
    image: { x: 50, y: 50, scale: 100, rotation: 0 },
  };
}
