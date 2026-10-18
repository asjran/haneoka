import profile from "../assets/gekisou-entry-profile.json";
import type {
  RenderOverlaySprite,
  RenderOverlayTexture,
  RenderOverlayText,
} from "../render/types.js";
import type { TmpSdfFontAssetManifest } from "../assets/manifest.js";
import { quantizeParticleColor } from "../authored/unityParticleMath.js";

/** Values sampled by the existing UILiveStartCanvasTrack owner. */
export interface OurNotesGekisouEntryInput {
  enabled: boolean;
  missionTypes: readonly number[];
  locale: "ja" | "en" | "ko" | "zh-CN" | "zh-TW";
  bindings: ReadonlyMap<string, number>;
}

export type OurNotesGekisouEntryText = RenderOverlayText;

export interface OurNotesGekisouEntryProjection {
  sprites: readonly RenderOverlaySprite[];
  texts: readonly OurNotesGekisouEntryText[];
}

type Rect = (typeof profile.nodes)[number]["rect"];
type Layout = {
  width: number;
  height: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  pivotX: number;
  pivotY: number;
};
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Source canvas geometry; no transport, game state, font parsing or GPU objects. */
export class OurNotesGekisouEntryProjector {
  private readonly groups = new Map(
    profile.canvasGroups.map((g) => [g.node, g]),
  );
  private readonly buffers = new Map<number, Float32Array>();
  private readonly colors = profile.visuals.map((v) => {
    const color = { ...v.color };
    quantizeParticleColor(color);
    return color;
  });
  readonly textureManifest = profile.textures;

  textures(
    resolve: (path: string) => string,
  ): Record<string, RenderOverlayTexture> {
    return Object.fromEntries(
      profile.textures.map((t) => [
        t.key,
        { url: resolve(t.path), origin: "top-left" as const },
      ]),
    );
  }

  font(resolve: (path: string) => string): TmpSdfFontAssetManifest {
    return {
      atlasTextureUrl: resolve(profile.font.atlasPath),
      metadataUrl: resolve(profile.font.metadataPath),
    };
  }

  project(
    input: OurNotesGekisouEntryInput,
    viewport: { width: number; height: number },
  ): OurNotesGekisouEntryProjection {
    if (!input.enabled) return { sprites: [], texts: [] };
    const canvasScale = Math.min(viewport.width / 1920, viewport.height / 1080);
    const width = viewport.width / canvasScale,
      height = viewport.height / canvasScale;
    const layouts = new Map<number, Layout>();
    const driven = new Map<number, Rect>();
    const open = new Set<number>();
    for (
      let i: number | null = profile.root;
      i !== null;
      i = profile.nodes[i]!.parent
    )
      open.add(i);
    const visible = (node: number) => {
      for (
        let i: number | null = node;
        i !== null;
        i = profile.nodes[i]!.parent
      )
        if (!open.has(i) && !profile.nodes[i]!.active) return false;
      return true;
    };
    const alpha = (node: number) => {
      let result = 1;
      for (
        let i: number | null = node;
        i !== null;
        i = profile.nodes[i]!.parent
      ) {
        const group = this.groups.get(i);
        if (!group) continue;
        const hash = profile.nodes[i]!.pathHash;
        const value =
          hash === null
            ? undefined
            : input.bindings.get(`${hash}:225:1574349066:0`);
        result *= clamp(value ?? group.alpha);
        if (group.ignoreParents) break;
      }
      return result;
    };
    const layout = (index: number): Layout => {
      const cached = layouts.get(index);
      if (cached) return cached;
      const node = profile.nodes[index]!,
        rect = driven.get(index) ?? node.rect;
      const parent = node.parent === null ? undefined : layout(node.parent);
      let result: Layout;
      if (!parent || (node.scale.x === 0 && node.scale.y === 0)) {
        result = {
          width,
          height,
          x: -width / 2,
          y: -height / 2,
          scaleX: 1,
          scaleY: 1,
          pivotX: 0,
          pivotY: 0,
        };
      } else {
        const w =
          parent.width * (rect.m_AnchorMax.x - rect.m_AnchorMin.x) +
          rect.m_SizeDelta.x;
        const h =
          parent.height * (rect.m_AnchorMax.y - rect.m_AnchorMin.y) +
          rect.m_SizeDelta.y;
        const x =
          parent.width *
            (rect.m_AnchorMin.x +
              (rect.m_AnchorMax.x - rect.m_AnchorMin.x) * rect.m_Pivot.x -
              parent.pivotX) +
          rect.m_AnchoredPosition.x;
        const y =
          parent.height *
            (rect.m_AnchorMin.y +
              (rect.m_AnchorMax.y - rect.m_AnchorMin.y) * rect.m_Pivot.y -
              parent.pivotY) +
          rect.m_AnchoredPosition.y;
        result = {
          width: w,
          height: h,
          x: parent.x + x * parent.scaleX,
          y: parent.y + y * parent.scaleY,
          scaleX: parent.scaleX * node.scale.x,
          scaleY: parent.scaleY * node.scale.y,
          pivotX: rect.m_Pivot.x,
          pivotY: rect.m_Pivot.y,
        };
      }
      layouts.set(index, result);
      return result;
    };
    // This source group leaves five serialized widths intact and drives height.
    for (const group of profile.layouts) {
      const box = layout(group.node);
      if (
        group.controlWidth ||
        !group.controlHeight ||
        !group.expandHeight ||
        group.alignment !== 0
      )
        throw new Error("Unsupported Gekisou entry horizontal layout");
      let cursor = group.padding.m_Left;
      for (const child of group.children) {
        const old = profile.nodes[child]!.rect,
          w = old.m_SizeDelta.x;
        const h = box.height - group.padding.m_Top - group.padding.m_Bottom;
        driven.set(child, {
          ...old,
          m_AnchorMin: { x: 0, y: 1 },
          m_AnchorMax: { x: 0, y: 1 },
          m_AnchoredPosition: {
            x: cursor + w * old.m_Pivot.x,
            y: -group.padding.m_Top - h * (1 - old.m_Pivot.y),
          },
          m_SizeDelta: { x: w, y: h },
        });
        cursor += w + group.spacing;
      }
    }
    const pixelBounds = (box: Layout): [number, number, number, number] => [
      (box.x - box.pivotX * box.width * box.scaleX + width / 2) * canvasScale,
      (height / 2 - box.y - (1 - box.pivotY) * box.height * box.scaleY) *
        canvasScale,
      box.width * box.scaleX * canvasScale,
      box.height * box.scaleY * canvasScale,
    ];
    const sprites: RenderOverlaySprite[] = [],
      texts: OurNotesGekisouEntryText[] = [];
    for (const [visualIndex, visual] of profile.visuals.entries()) {
      if (!visual.enabled || !visible(visual.node)) continue;
      const missionSlot = profile.missionGraphics.indexOf(visualIndex);
      const mission =
        missionSlot < 0 ? undefined : input.missionTypes[missionSlot];
      if (
        missionSlot >= 0 &&
        (mission === undefined || mission < 1 || mission > 3)
      )
        continue;
      const spriteIndex =
        visual.role === "gekisou"
          ? profile.localeTitleSprites[input.locale]
          : missionSlot < 0
            ? visual.sprite
            : profile.missionSprites[String(mission) as "1" | "2" | "3"];
      const sprite = profile.sprites[spriteIndex]!,
        box = layout(visual.node);
      const color = this.colors[visualIndex]!;
      const opacity = color.a * alpha(visual.node);
      if (opacity <= 0) continue;
      let w = box.width,
        h = box.height,
        x0 = -box.pivotX * w,
        y0 = -box.pivotY * h;
      if (visual.preserveAspect) {
        const aspect = sprite.rect.width / sprite.rect.height;
        if (aspect > w / h) {
          const next = w / aspect;
          y0 += (h - next) * box.pivotY;
          h = next;
        } else {
          const next = h * aspect;
          x0 += (w - next) * box.pivotX;
          w = next;
        }
      }
      let xs: number[], ys: number[], us: number[], vs: number[];
      if (visual.drawMode === 1) {
        const b = sprite.border,
          sx = Math.min(1, w / Math.max(1e-30, b.x + b.z)),
          sy = Math.min(1, h / Math.max(1e-30, b.y + b.w));
        xs = [x0, x0 + b.x * sx, x0 + w - b.z * sx, x0 + w];
        ys = [y0, y0 + b.y * sy, y0 + h - b.w * sy, y0 + h];
        us = [0, b.x / sprite.rect.width, 1 - b.z / sprite.rect.width, 1];
        vs = [0, b.y / sprite.rect.height, 1 - b.w / sprite.rect.height, 1];
      } else {
        const offset = sprite.textureRectOffset;
        xs = [
          x0 + (offset.x / sprite.rect.width) * w,
          x0 +
            ((offset.x + sprite.textureLogicalSize[0]!) / sprite.rect.width) *
              w,
        ];
        ys = [
          y0 + (offset.y / sprite.rect.height) * h,
          y0 +
            ((offset.y + sprite.textureLogicalSize[1]!) / sprite.rect.height) *
              h,
        ];
        us = [0, 1];
        vs = [0, 1];
      }
      const count = xs.length * ys.length;
      let vertices = this.buffers.get(visualIndex);
      if (!vertices || vertices.length !== count * 10)
        this.buffers.set(
          visualIndex,
          (vertices = new Float32Array(count * 10)),
        );
      for (let row = 0; row < ys.length; row++)
        for (let column = 0; column < xs.length; column++) {
          const i = (row * xs.length + column) * 10;
          vertices.set(
            [
              ((box.x + xs[column]! * box.scaleX) * 2) / width,
              ((box.y + ys[row]! * box.scaleY) * 2) / height,
              0,
              1,
              us[column]!,
              1 - vs[row]!,
              color.r,
              color.g,
              color.b,
              opacity,
            ],
            i,
          );
        }
      const indices: number[] = [];
      for (let row = 0; row + 1 < ys.length; row++)
        for (let column = 0; column + 1 < xs.length; column++) {
          if (xs[column] === xs[column + 1] || ys[row] === ys[row + 1])
            continue;
          const i = row * xs.length + column;
          indices.push(
            i,
            i + 1,
            i + xs.length,
            i + xs.length,
            i + 1,
            i + xs.length + 1,
          );
        }
      sprites.push({
        id: `gekisou-entry-${visualIndex}`,
        textureKey: sprite.texture,
        vertices,
        indices,
        blend: "alpha",
        pass: "screen",
        sortingOrder: visualIndex,
      });
    }
    for (const [textIndex, item] of profile.text.entries()) {
      if (!visible(item.node)) continue;
      const missionSlot = profile.missionText.indexOf(textIndex),
        mission = input.missionTypes[missionSlot];
      if (
        missionSlot >= 0 &&
        (mission === undefined || mission < 1 || mission > 3)
      )
        continue;
      const box = layout(item.node),
        opacity = item.color.a * alpha(item.node);
      if (opacity <= 0) continue;
      texts.push({
        id: `gekisou-entry-text-${textIndex}`,
        fontKey: "gekisou-entry-vibe",
        text:
          missionSlot < 0
            ? profile.performanceLabel
            : profile.missionLabels[String(mission) as "1" | "2" | "3"],
        bounds: pixelBounds(box),
        fontSize: item.size * box.scaleY * canvasScale,
        align: item.horizontalAlignment === 4 ? "right" : "center",
        verticalAlign: item.verticalAlignment === 1024 ? "bottom" : "top",
        color: [item.color.r, item.color.g, item.color.b, opacity],
      });
    }
    return { sprites, texts };
  }
}
