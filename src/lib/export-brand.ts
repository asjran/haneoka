export const HANEOKA_EXPORT_BRAND = { name: "haneoka", url: "haneoka.org", logo: "/android-chrome-192x192.png" };

export function drawExportBrand(
  ctx: CanvasRenderingContext2D,
  theme: { font: string; onSurface: string; variant: string },
  brand: { name: string; url: string },
  logo: HTMLImageElement | null,
  width: number,
  padding: number,
) {
  const right = width - padding;
  ctx.textBaseline = "top";
  ctx.textAlign = "end";
  ctx.font = `600 22px ${theme.font}`;
  const nameWidth = ctx.measureText(brand.name).width;
  ctx.fillStyle = theme.onSurface;
  ctx.fillText(brand.name, right, padding + 2);
  ctx.font = `400 15px ${theme.font}`;
  const urlWidth = ctx.measureText(brand.url).width;
  ctx.fillStyle = theme.variant;
  ctx.fillText(brand.url, right, padding + 32);
  ctx.textAlign = "start";
  const text = Math.max(nameWidth, urlWidth);
  if (logo) {
    const scale = Math.min(52 / logo.naturalWidth, 52 / logo.naturalHeight);
    const w = logo.naturalWidth * scale,
      h = logo.naturalHeight * scale;
    ctx.drawImage(logo, right - text - 12 - 52 + (52 - w) / 2, padding + (52 - h) / 2, w, h);
  }
  return text + 12 + 52 + 24;
}
