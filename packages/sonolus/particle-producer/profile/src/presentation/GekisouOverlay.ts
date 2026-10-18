import { multiply, trs, eulerZxy, identity, type Vec3, type Quaternion } from "../authored/sourceTransform.js";
import source from "../assets/gekisou-lane-hud-profile.json";
import type { RenderOverlaySprite, RenderOverlayTexture } from "../render/types.js";
import type {
  OurNotesGekisouPresentationFrame,
  OurNotesGekisouProjectionContext,
  OurNotesGekisouPresentationProjector,
} from "./GekisouPresentation.js";

type Profile = typeof source;

type Node = Profile["nodes"][number];
type Curve = Profile["clips"][number]["curves"][number];
type Pose = {
  position: Vec3;
  rotation: Quaternion;
  scale: Vec3;
  active: boolean;
  alpha: number;
  rect: Node["rect"];
};

export type OurNotesGekisouOverlayViewport = OurNotesGekisouProjectionContext;

export const OUR_NOTES_GEKISOU_VIEW_SETTINGS = Object.freeze(source.viewSettings);

const sampleCurve = (curve: Curve, time: number): number => {
  if (typeof curve.constant === "number") return curve.constant;
  const rows = curve.segments;
  if (!rows?.length) return 0;
  let low = 0,
    high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle]!.time <= time) low = middle + 1;
    else high = middle;
  }
  const row = rows[Math.max(0, low - 1)]!;
  const [a, b, c, d] = row.coefficients;
  const dt = time - row.time;
  return ((a! * dt + b!) * dt + c!) * dt + d!;
};

const sliced = (
  width: number,
  height: number,
  pivotX: number,
  pivotY: number,
  border: { x: number; y: number; z: number; w: number },
  pixelsPerUnit: number,
  rectWidth: number,
  rectHeight: number,
): { vertices: number[]; indices: number[] } => {
  const scaleX = Math.min(1, (width * pixelsPerUnit) / Math.max(Number.EPSILON, border.x + border.z));
  const scaleY = Math.min(1, (height * pixelsPerUnit) / Math.max(Number.EPSILON, border.y + border.w));
  const x = [
    -width * pivotX,
    -width * pivotX + (border.x / pixelsPerUnit) * scaleX,
    width * (1 - pivotX) - (border.z / pixelsPerUnit) * scaleX,
    width * (1 - pivotX),
  ];
  const y = [
    -height * pivotY,
    -height * pivotY + (border.y / pixelsPerUnit) * scaleY,
    height * (1 - pivotY) - (border.w / pixelsPerUnit) * scaleY,
    height * (1 - pivotY),
  ];
  const u = [0, border.x / rectWidth, 1 - border.z / rectWidth, 1];
  const v = [0, border.y / rectHeight, 1 - border.w / rectHeight, 1];
  const vertices: number[] = [],
    indices: number[] = [];
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++) vertices.push(x[column]!, y[row]!, 0, u[column]!, v[row]!);
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++) {
      if (x[column] === x[column + 1] || y[row] === y[row + 1]) continue;
      const a = row * 4 + column;
      indices.push(a, a + 1, a + 5, a, a + 5, a + 4);
    }
  return { vertices, indices };
};

/** Source geometry/animation policy. The renderer receives only final clip-space buffers. */
export class OurNotesGekisouOverlayProjector implements OurNotesGekisouPresentationProjector {
  private readonly descendants = new Map<number, readonly number[]>();
  private readonly visualClosures = new Map<number, readonly number[]>();
  private readonly buffers = new Map<string, Float32Array>();
  private readonly visualByNode = new Map(source.visuals.map((v, i) => [v.node, i]));
  private readonly unitByNode = new Map(source.numberUnits.map((v) => [v.node, v]));
  private readonly clipByKey = new Map(source.clips.map((v) => [v.key, v]));
  private readonly controllerByKey = new Map(source.controllers.map((v) => [v.sourceDescriptor, v]));
  private readonly groups = new Map(source.canvasGroups.map((v) => [v.node, v]));

  readonly textureManifest = source.textures;

  textures(resolve: (path: string) => string): Record<string, RenderOverlayTexture> {
    return Object.fromEntries(
      source.textures.map((v) => [v.key, { url: resolve(v.path), origin: "top-left" as const }]),
    );
  }

  private under(node: number, ancestor: number): boolean {
    let current: number | null = node;
    while (current !== null) {
      if (current === ancestor) return true;
      current = source.nodes[current]!.parent;
    }
    return false;
  }

  private closure(root: number): readonly number[] {
    let result = this.descendants.get(root);
    if (!result) {
      result = source.nodes.flatMap((_, index) => (this.under(index, root) ? [index] : []));
      this.descendants.set(root, result);
    }
    return result;
  }

  project(
    frame: OurNotesGekisouPresentationFrame,
    viewport: OurNotesGekisouOverlayViewport,
  ): readonly RenderOverlaySprite[] {
    if (!frame.enabled) return [];
    const prefix = viewport.displayPositionChanged ? "canvas" : "world";
    const output: RenderOverlaySprite[] = [];
    const countdown = frame.countdown;
    if (countdown.visible && countdown.clip !== null)
      output.push(
        ...this.drawRole(`${prefix}Countdown`, viewport, {
          ...(countdown.mission !== null ? { mission: countdown.mission } : {}),
          state: `gekisou_countdown_${countdown.clip === "out" ? "out" : countdown.count}`,
          seconds: countdown.clipTimeSeconds,
        }),
      );
    if (frame.just.visible) output.push(...this.drawRole(`${prefix}Just`, viewport, { count: frame.just.count }));
    return output;
  }

  private drawRole(
    name: string,
    viewport: OurNotesGekisouOverlayViewport,
    input: { mission?: number; state?: string; seconds?: number; count?: number },
  ): RenderOverlaySprite[] {
    const role = source.roles[name as keyof typeof source.roles];
    if (role === undefined) return [];
    const screen = name.startsWith("canvas");
    const selected = this.closure(role);
    const poses = new Map<number, Pose>();
    const spriteOverrides = new Map<number, number>();
    const colorAlpha = new Map<number, number>();
    const localPositionAxes = new Map<number, number>();
    const pose = (index: number): Pose => {
      let value = poses.get(index);
      if (!value) {
        const node = source.nodes[index]!;
        value = {
          position: { ...node.position },
          rotation: { ...node.rotation },
          scale: { ...node.scale },
          active: node.active,
          alpha: this.groups.get(index)?.alpha ?? 1,
          rect: node.rect
            ? {
                ...node.rect,
                m_AnchoredPosition: { ...node.rect.m_AnchoredPosition },
                m_SizeDelta: { ...node.rect.m_SizeDelta },
              }
            : undefined,
        };
        poses.set(index, value);
      }
      return value;
    };
    for (const index of selected) pose(index);
    for (let index: number | null = role; index !== null; index = source.nodes[index]!.parent)
      pose(index).active = true;
    const displayScale = viewport.displayScale ?? 1;
    pose(role).scale = { x: displayScale, y: displayScale, z: displayScale };
    if (input.state) {
      const animator = source.animators.find((v) => this.under(v.node, role));
      const controller = animator ? this.controllerByKey.get(animator.controllerKey!) : undefined;
      const state = controller?.states.find((v) => v.name === input.state);
      const clip = state?.clips[0] ? this.clipByKey.get(state.clips[0]) : undefined;
      if (!animator || !state || !clip) throw new Error(`gekisou-overlay-state:${name}:${input.state}`);
      const targets = new Map(animator.pathNodes.map(([hash, node]) => [hash!, node!] as const));
      const seconds = Math.max(0, (input.seconds ?? 0) * state.speed + state.cycleOffset * clip.settings.m_StopTime);
      const time =
        state.loop && clip.settings.m_StopTime > 0
          ? seconds % clip.settings.m_StopTime
          : Math.min(seconds, clip.settings.m_StopTime);
      for (const binding of clip.bindings) {
        const target = targets.get(binding.pathHash);
        if (target === undefined) continue;
        const targetPose = pose(target);
        const values = Array.from({ length: binding.components }, (_, component) =>
          sampleCurve(clip.curves[binding.curveStart + component]!, time),
        );
        if (binding.type === 4) {
          const vector = { x: values[0]!, y: values[1]!, z: values[2]! };
          if (binding.attribute === 1) {
            targetPose.position = vector;
            localPositionAxes.set(target, 7);
          } else if (binding.attribute === 3) targetPose.scale = vector;
          else if (binding.attribute === 4) targetPose.rotation = eulerZxy(vector);
          else if (binding.attribute === 2) targetPose.rotation = { ...vector, w: values[3]! };
        } else if (binding.type === 1 && binding.attribute === 2086281974) targetPose.active = values[0]! >= 0.5;
        else if (binding.type === 225 && binding.attribute === 1574349066)
          targetPose.alpha = Math.max(0, Math.min(1, values[0]!));
        else if ((binding.type === 212 || binding.type === 114) && binding.attribute === 304273561)
          colorAlpha.set(target, values[0]!);
        else if (binding.type === 224) {
          const axis =
            binding.attribute === 2537237887
              ? "x"
              : binding.attribute === 3762036201
                ? "y"
                : binding.attribute === 2033536083
                  ? "z"
                  : undefined;
          if (axis) {
            targetPose.position[axis] = values[0]!;
            localPositionAxes.set(
              target,
              (localPositionAxes.get(target) ?? 0) | (axis === "x" ? 1 : axis === "y" ? 2 : 4),
            );
          }
        }
      }
    }
    const countdownBinding = source.bindings[name as "canvasCountdown" | "worldCountdown"];
    if (input.mission !== undefined && countdownBinding && "missionVisual" in countdownBinding) {
      const sprite = countdownBinding.missionSprites[String(input.mission) as "1" | "2" | "3"];
      if (sprite !== undefined) spriteOverrides.set(countdownBinding.missionVisual, sprite);
    }
    if (input.count !== undefined) {
      const binding = source.bindings[name as "canvasJust" | "worldJust"];
      const numeric = source.numeric[binding.count]!;
      const digits = Math.max(0, Math.trunc(input.count)).toString().slice(-numeric.units.length);
      for (let i = 0; i < numeric.units.length; i++) {
        const node = numeric.units[i]!;
        pose(node).active = i >= numeric.units.length - digits.length;
        if (!pose(node).active) continue;
        const digit = Number(digits[i - (numeric.units.length - digits.length)]);
        const sprite = source.numberGlyphs.digits[digit]!;
        const unit = this.unitByNode.get(node)!;
        const visual = this.visualByNode.get(unit.imageNode)!;
        spriteOverrides.set(visual, sprite);
        const size = source.sprites[sprite]!.rect;
        const unitPose = pose(node),
          imagePose = pose(unit.imageNode);
        if (unitPose.rect) unitPose.rect.m_SizeDelta = { x: size.width, y: size.height };
        if (imagePose.rect) imagePose.rect.m_SizeDelta = { x: size.width, y: size.height };
      }
      // Bonus/team contribution fields have their own source state and are not inferred from count.
      pose(source.numeric[binding.factor]!.node).active = false;
      for (const index of selected)
        if (source.nodes[index]!.name.includes("GekisouSkillAddedValueView")) pose(index).active = false;
      for (const layout of source.layouts) {
        if (layout.node !== source.nodes[numeric.units[0]!]!.parent) continue;
        const active = numeric.units.filter((i) => pose(i).active);
        const widths = active.map((i) => {
          const visual = this.visualByNode.get(this.unitByNode.get(i)!.imageNode)!;
          return source.sprites[spriteOverrides.get(visual)!]!.rect.width;
        });
        const total = widths.reduce((sum, width) => sum + width, 0) + layout.spacing * (active.length - 1);
        let cursor = screen ? -total / 2 : -total / 2 / layout.pixelsPerUnit;
        for (let i = 0; i < active.length; i++) {
          const row = pose(active[i]!);
          if (screen && row.rect) {
            row.rect.m_AnchorMin = { x: 0.5, y: 0.5 };
            row.rect.m_AnchorMax = { x: 0.5, y: 0.5 };
            row.rect.m_AnchoredPosition = { x: cursor + widths[i]! / 2, y: 0 };
            cursor += widths[i]! + layout.spacing;
          } else {
            row.position.x = cursor + widths[i]! / 2 / layout.pixelsPerUnit;
            cursor += (widths[i]! + layout.spacing) / layout.pixelsPerUnit;
          }
        }
      }
    }
    const matrices = new Map<number, Float64Array>();
    const sizes = new Map<number, { x: number; y: number; pivotX: number; pivotY: number }>();
    const canvasScale = Math.min(
      viewport.width / source.canvas.referenceSize[0]!,
      viewport.height / source.canvas.referenceSize[1]!,
    );
    const cw = viewport.width / canvasScale,
      ch = viewport.height / canvasScale;
    const matrix = (index: number): Float64Array => {
      let result = matrices.get(index);
      if (result) return result;
      const node = source.nodes[index]!,
        value = pose(index);
      const parent = node.parent === null ? identity : matrix(node.parent);
      let position = value.position,
        scale = value.scale;
      if (screen && value.rect) {
        const rect = value.rect;
        const drivenCanvas = node.scale.x === 0 && node.scale.y === 0;
        const parentSize = node.parent === null ? undefined : sizes.get(node.parent);
        if (drivenCanvas || !parentSize) {
          sizes.set(index, { x: cw, y: ch, pivotX: 0, pivotY: 0 });
          position = { x: -cw / 2, y: -ch / 2, z: 0 };
          scale = { x: 1, y: 1, z: 1 };
        } else {
          const width = parentSize.x * (rect.m_AnchorMax.x - rect.m_AnchorMin.x) + rect.m_SizeDelta.x;
          const height = parentSize.y * (rect.m_AnchorMax.y - rect.m_AnchorMin.y) + rect.m_SizeDelta.y;
          position = {
            x:
              parentSize.x *
                (rect.m_AnchorMin.x + (rect.m_AnchorMax.x - rect.m_AnchorMin.x) * rect.m_Pivot.x - parentSize.pivotX) +
              rect.m_AnchoredPosition.x,
            y:
              parentSize.y *
                (rect.m_AnchorMin.y + (rect.m_AnchorMax.y - rect.m_AnchorMin.y) * rect.m_Pivot.y - parentSize.pivotY) +
              rect.m_AnchoredPosition.y,
            z: value.position.z,
          };
          sizes.set(index, { x: width, y: height, pivotX: rect.m_Pivot.x, pivotY: rect.m_Pivot.y });
        }
        const flags = localPositionAxes.get(index) ?? 0;
        position = {
          x: flags & 1 ? value.position.x : position.x,
          y: flags & 2 ? value.position.y : position.y,
          z: flags & 4 ? value.position.z : position.z,
        };
      }
      result = multiply(parent, trs(position, value.rotation, scale));
      matrices.set(index, result);
      return result;
    };
    const output: RenderOverlaySprite[] = [];
    let visibleIndices = this.visualClosures.get(role);
    if (!visibleIndices) {
      const included = new Set(selected);
      visibleIndices = source.visuals.flatMap((v, i) => (included.has(v.node) ? [i] : []));
      this.visualClosures.set(role, visibleIndices);
    }
    for (const visualIndex of visibleIndices) {
      const visual = source.visuals[visualIndex]!;
      if (!visual.enabled) continue;
      let visible = true,
        opacity = colorAlpha.get(visual.node) ?? visual.color.a;
      for (let current: number | null = visual.node; current !== null; current = source.nodes[current]!.parent) {
        const value = pose(current);
        visible &&= value.active;
        opacity *= value.alpha;
      }
      if (!visible || opacity <= 0) continue;
      const spriteIndex = spriteOverrides.get(visualIndex) ?? visual.sprite;
      if (spriteIndex === null) continue;
      const sprite = source.sprites[spriteIndex]!,
        world = matrix(visual.node);
      const transform = screen ? world : multiply(viewport.worldToClip, world);
      const rect = sizes.get(visual.node);
      let imageWidth = rect?.x ?? 0,
        imageHeight = rect?.y ?? 0;
      if (rect && visual.preserveAspect) {
        const scale = Math.min(rect.x / sprite.rect.width, rect.y / sprite.rect.height);
        imageWidth = sprite.rect.width * scale;
        imageHeight = sprite.rect.height * scale;
      }
      const left = rect ? -rect.pivotX * imageWidth + (imageWidth * sprite.textureRectOffset.x) / sprite.rect.width : 0;
      const bottom = rect
        ? -rect.pivotY * imageHeight + (imageHeight * sprite.textureRectOffset.y) / sprite.rect.height
        : 0;
      const right = left + (imageWidth * sprite.textureLogicalSize[0]!) / sprite.rect.width;
      const top = bottom + (imageHeight * sprite.textureLogicalSize[1]!) / sprite.rect.height;
      let mesh =
        visual.kind === "canvasImage" && rect
          ? {
              vertices: [left, bottom, 0, 0, 0, right, bottom, 0, 1, 0, right, top, 0, 1, 1, left, top, 0, 0, 1],
              indices: [0, 1, 2, 0, 2, 3],
            }
          : sprite.mesh;
      if (visual.drawMode === 1) {
        const width = screen && rect ? rect.x : visual.size?.x;
        const height = screen && rect ? rect.y : visual.size?.y;
        if (width === undefined || height === undefined) throw new Error(`gekisou-overlay-slice-size:${visualIndex}`);
        mesh = sliced(
          width,
          height,
          screen && rect ? rect.pivotX : sprite.pivot.x,
          screen && rect ? rect.pivotY : sprite.pivot.y,
          sprite.border,
          screen ? 1 : sprite.pixelsToUnits,
          sprite.rect.width,
          sprite.rect.height,
        );
      }
      const id = `gekisou-${name}-${visualIndex}`;
      let buffer = this.buffers.get(id);
      if (!buffer || buffer.length !== mesh.vertices.length * 2) {
        buffer = new Float32Array(mesh.vertices.length * 2);
        this.buffers.set(id, buffer);
      }
      for (let i = 0; i < mesh.vertices.length / 5; i++) {
        const x = mesh.vertices[i * 5]! * (visual.flipX ? -1 : 1),
          y = mesh.vertices[i * 5 + 1]! * (visual.flipY ? -1 : 1),
          z = mesh.vertices[i * 5 + 2]!;
        const cx = transform[0]! * x + transform[4]! * y + transform[8]! * z + transform[12]!;
        const cy = transform[1]! * x + transform[5]! * y + transform[9]! * z + transform[13]!;
        const cz = transform[2]! * x + transform[6]! * y + transform[10]! * z + transform[14]!;
        const w = screen ? 1 : transform[3]! * x + transform[7]! * y + transform[11]! * z + transform[15]!;
        buffer.set(
          [
            screen ? (cx * 2) / cw : cx,
            screen ? (cy * 2) / ch : cy,
            screen ? 0 : cz,
            w,
            mesh.vertices[i * 5 + 3]!,
            1 - mesh.vertices[i * 5 + 4]!,
            visual.color.r,
            visual.color.g,
            visual.color.b,
            opacity,
          ],
          i * 10,
        );
      }
      output.push({
        id,
        textureKey: sprite.texture,
        vertices: buffer,
        indices: mesh.indices,
        blend: "alpha",
        pass: screen ? "screen" : "game",
        sortingOrder: visual.sortingOrder,
      });
    }
    return output;
  }
}
