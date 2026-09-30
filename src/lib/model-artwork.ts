type Model = Record<string, unknown>;

export function modelPreviewSources(model: Model): string[] {
  const preview = model.preview && typeof model.preview === "object" ? (model.preview as Model) : undefined;
  return [preview?.image, preview?.runtime, model.thumbnailImage, model.faceImage]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .filter((value, index, all) => all.indexOf(value) === index);
}
