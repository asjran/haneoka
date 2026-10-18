export interface RectangleSize {
  readonly width: number;
  readonly height: number;
}

export interface RectanglePlacement {
  readonly x: number;
  readonly y: number;
}

interface FreeRectangle extends RectanglePlacement, RectangleSize {}

const contains = (outer: FreeRectangle, inner: FreeRectangle): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Pack caller-padded rectangles without rotation, preserving their input order. */
export function packRectangles(
  rectangles: readonly RectangleSize[],
  size: number,
  denseSearch = false,
  height = size,
): RectanglePlacement[] | undefined {
  if (!Number.isSafeInteger(size) || size <= 0) throw new RangeError("Invalid atlas size");
  if (!Number.isSafeInteger(height) || height <= 0) throw new RangeError("Invalid atlas height");
  for (const { width, height } of rectangles) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
      throw new RangeError("Invalid rectangle size");
  }
  if (rectangles.some((rectangle) => rectangle.width > size || rectangle.height > height)) return undefined;
  if (rectangles.reduce((area, { width, height }) => area + width * height, 0) > size * height) return undefined;

  const entries = rectangles.map((rectangle, index) => ({ ...rectangle, index }));
  const strategies = denseSearch
    ? ["area", "long", "height", "width", "perimeter", "short"].flatMap((ordering) =>
        ["short", "area", "bottom"].map((placement) => ({ ordering, placement })),
      )
    : [
        { ordering: "area", placement: "short" },
        { ordering: "long", placement: "short" },
      ];
  for (const { ordering, placement } of strategies) {
    const score = ({ width, height }: RectangleSize): number[] =>
      ordering === "long"
        ? [Math.max(width, height), width * height, width]
        : ordering === "height"
          ? [height, width, width * height]
          : ordering === "width"
            ? [width, height, width * height]
            : ordering === "perimeter"
              ? [width + height, width * height, width]
              : ordering === "short"
                ? [Math.min(width, height), width * height, width]
                : [width * height, Math.max(width, height), width];
    const ordered = [...entries].sort((left, right) => {
      const a = score(left),
        b = score(right);
      return b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]! || left.index - right.index;
    });
    let free: FreeRectangle[] = [{ x: 0, y: 0, width: size, height }];
    const placements: RectanglePlacement[] = [];
    let complete = true;
    for (const rectangle of ordered) {
      let selected: FreeRectangle | undefined;
      let bestShort = Infinity,
        bestLong = Infinity;
      for (const candidate of free) {
        const dx = candidate.width - rectangle.width;
        const dy = candidate.height - rectangle.height;
        if (dx < 0 || dy < 0) continue;
        const short =
            placement === "area"
              ? candidate.width * candidate.height - rectangle.width * rectangle.height
              : placement === "bottom"
                ? candidate.y + rectangle.height
                : Math.min(dx, dy),
          long = placement === "area" ? Math.min(dx, dy) : placement === "bottom" ? candidate.x : Math.max(dx, dy);
        if (
          short < bestShort ||
          (short === bestShort &&
            (long < bestLong ||
              (long === bestLong &&
                (!selected || candidate.y < selected.y || (candidate.y === selected.y && candidate.x < selected.x)))))
        ) {
          selected = candidate;
          bestShort = short;
          bestLong = long;
        }
      }
      if (!selected) {
        complete = false;
        break;
      }
      const used = { x: selected.x, y: selected.y, width: rectangle.width, height: rectangle.height };
      placements[rectangle.index] = { x: used.x, y: used.y };
      const split: FreeRectangle[] = [];
      for (const region of free) {
        const right = region.x + region.width,
          bottom = region.y + region.height;
        if (
          used.x >= right ||
          used.x + used.width <= region.x ||
          used.y >= bottom ||
          used.y + used.height <= region.y
        ) {
          split.push(region);
          continue;
        }
        if (used.x > region.x) split.push({ ...region, width: used.x - region.x });
        if (used.x + used.width < right)
          split.push({ ...region, x: used.x + used.width, width: right - used.x - used.width });
        if (used.y > region.y) split.push({ ...region, height: used.y - region.y });
        if (used.y + used.height < bottom)
          split.push({ ...region, y: used.y + used.height, height: bottom - used.y - used.height });
      }
      const unique = [
        ...new Map(
          split.map((region) => [`${region.x},${region.y},${region.width},${region.height}`, region] as const),
        ).values(),
      ];
      free = unique.filter(
        (region, index) => !unique.some((other, otherIndex) => index !== otherIndex && contains(other, region)),
      );
    }
    if (complete) return placements;
  }
  return undefined;
}
