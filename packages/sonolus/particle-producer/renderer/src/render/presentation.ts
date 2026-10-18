import { OUR_NOTES_LIVE_GEOMETRY, type RenderNote } from "@haneoka/cassiopeia-plugin-our-notes";
import { StageProjector } from "./stageGeometry";

export interface NativeChartViewport {
  /** Unrotated canvas content size in CSS pixels. */
  width: number;
  height: number;
  pixelRatio: number;
  laneCount: number;
}

export interface NativeCanvasPoint {
  x: number;
  y: number;
}

export interface NativeNoteViewPoint {
  /** Rendered native lane edge units; author-lane conversion and snapping belong to the host. */
  lane: number;
  /** Native scroll approach: 0 at judgement, 1 at spawn. */
  approach: number;
}

export interface NativeNoteViewProjection {
  center: NativeCanvasPoint;
  /** Authored lane span, before the skin's cap overhang or note-size option. */
  left: NativeCanvasPoint;
  right: NativeCanvasPoint;
}

export interface NativeNoteHit {
  id: RenderNote["id"];
  part: "body" | "mark" | "arrow";
}

/** Read-only presentation queries on the same native player instance. */
export interface NativeChartPresentation {
  getViewport(): NativeChartViewport | undefined;
  projectNoteView(note: Pick<RenderNote, "lane" | "width" | "approach">): NativeNoteViewProjection | undefined;
  canvasPointToNoteView(x: number, y: number): NativeNoteViewPoint | undefined;
  clientPointToNoteView(clientX: number, clientY: number): NativeNoteViewPoint | undefined;
  pickNoteAtCanvasPoint(x: number, y: number): NativeNoteHit | undefined;
  pickNoteAtClientPoint(clientX: number, clientY: number): NativeNoteHit | undefined;
}

/** Project the real camera-child screen_root note plane into CSS pixels. */
export function projectNativeNoteView(
  note: Pick<RenderNote, "lane" | "width" | "approach">,
  projector: StageProjector,
  viewport: NativeChartViewport,
  projection: ArrayLike<number>,
): NativeNoteViewProjection | undefined {
  if (
    ![note.lane, note.width, note.approach, viewport.width, viewport.height, projection[0], projection[5]].every(
      Number.isFinite,
    )
  )
    return;
  if (note.width <= 0 || viewport.width <= 0 || viewport.height <= 0) return;
  if (!projection[0] || !projection[5]) return;
  const progress = projector.viewProgress(note.approach);
  const y = projector.yAtViewProgress(progress);
  const point = (lane: number): NativeCanvasPoint => ({
    x:
      (0.5 +
        (projector.laneEdgeToXAtViewProgress(lane, progress) * projection[0]!) /
          (2 * OUR_NOTES_LIVE_GEOMETRY.screenRootZ)) *
      viewport.width,
    y: (0.5 - (y * projection[5]!) / (2 * OUR_NOTES_LIVE_GEOMETRY.screenRootZ)) * viewport.height,
  });
  return { center: point(note.lane + note.width / 2), left: point(note.lane), right: point(note.lane + note.width) };
}

/** Invert the native float32 view curve; this does not apply a second world-Z perspective. */
export function nativeNoteViewAtCanvasPoint(
  x: number,
  y: number,
  projector: StageProjector,
  viewport: NativeChartViewport,
  projection: ArrayLike<number>,
): NativeNoteViewPoint | undefined {
  if (![x, y, viewport.width, viewport.height, projection[0], projection[5]].every(Number.isFinite)) return;
  if (viewport.width <= 0 || viewport.height <= 0 || !projection[0] || !projection[5]) return;
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return;
  const localX = (((2 * x) / viewport.width - 1) * OUR_NOTES_LIVE_GEOMETRY.screenRootZ) / projection[0]!;
  const localY = ((1 - (2 * y) / viewport.height) * OUR_NOTES_LIVE_GEOMETRY.screenRootZ) / projection[5]!;
  const progress = (localY - projector.spawnY) / (OUR_NOTES_LIVE_GEOMETRY.screenJudgementY - projector.spawnY);
  const minimum = projector.viewProgress(1);
  const maximum = projector.viewProgress(-0.16);
  if (progress < minimum - 1e-6 || progress > maximum + 1e-6 || progress <= 0) return;
  let low = -0.16;
  let high = 1;
  for (let i = 0; i < 28; i++) {
    const middle = (low + high) / 2;
    if (projector.viewProgress(middle) > progress) low = middle;
    else high = middle;
  }
  return { lane: projector.xToLaneEdge(localX / progress), approach: (low + high) / 2 };
}
