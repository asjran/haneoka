import type { OurNotesAssetManifest, HudSpriteGeometry } from "@haneoka/cassiopeia-plugin-our-notes";
import { TmpSdfFont } from "./TmpSdfFont";
import type {
  RenderHudState,
  RenderJudgementInstance,
  RenderTitleIntroductionTheme,
  RenderOverlayText,
  TmpSdfFontAssetManifest,
} from "@haneoka/cassiopeia-plugin-our-notes";

const EMPTY_HUD_STATE: Readonly<RenderHudState> = Object.freeze({});
const DEFAULT_RANK_LABELS = ["C", "B", "A", "S", "SS"] as const;
const RANK_LABEL_X = [248, 337, 424, 512, 599] as const;
const RANK_SEPARATOR_X = [248, 335, 424, 512, 600] as const;
const HUD_CHARACTER_SPACING = 1;
const RANK_ICON_SCALE = 0.5;
const RANK_ICON_SOURCE_WIDTH = 230;
const RANK_ICON_SOURCE_HEIGHT = 190;
const RANK_ICON_CENTER_X = 80.5;
const RANK_ICON_CENTER_Y = 89;
const PAUSE_ICON_SLOT_SIZE = 64;
const PAUSE_ICON_SLOT_TOP = 27;
const PAUSE_ICON_SPRITE_RECT = {
  offsetX: 19.076120376586914,
  offsetY: 16.076120376586914,
  width: 25.84775733947754,
  height: 31.84775733947754,
} as const;
const COMBO_ADD_PEAK_TIME = 0.13333334028720856;
const COMBO_ADD_DURATION = 0.15000000596046448;
const JUDGEMENT_POOL_CAPACITY = 8;
const CHART_LANE_COUNT = 24;
const JUDGEMENT_SHOW_DURATION = 0.30000001192092896;
const JUDGEMENT_PUNCH_DURATION = 0.15000000596046448;
const JUDGEMENT_PUNCH_RISE_DURATION = 0.05000000447034836;
const JUDGEMENT_PUNCH_SCALE = 0.2;
const JUDGEMENT_SUB_SCALE = 0.75;
const JUDGEMENT_TIMING_NATIVE_WIDTH = 307;
const JUDGEMENT_TIMING_NATIVE_HEIGHT = 31;
const JUDGEMENT_TIMING_FONT_SIZE = 44;
const JUDGEMENT_FAST_COLOR = [0.36320751905441284, 0.7607458233833313, 1] as const;
const JUDGEMENT_LATE_COLOR = [0.801886796951294, 0.2988162934780121, 0.2988162934780121] as const;
const DEFAULT_TITLE_THEME: RenderTitleIntroductionTheme = {
  panelBackground: "rgba(92, 59, 190, 0.5)",
  panelBorderColor: "rgba(255, 255, 255, 0)",
  panelBorderWidthPx: 0,
  fontFamilies: ["Noto Sans", "Noto Sans JP", "Noto Sans SC", "system-ui", "sans-serif"],
  titleColor: "#ffffff",
  artistColor: "#ffffff",
  creditsColor: "#ffffff",
};

// LiveJudgementView.Show writes the pooled instance to (0,-66). The prefab's
// bottom-aligned VerticalLayoutGroup then puts main_judge at canvas Y=-136
// and timing_offset at Y=-65, including UILiveJudgement and effect_root.
const JUDGEMENT_CENTER_OFFSET_Y = 136;
const JUDGEMENT_TIMING_CENTER_OFFSET_Y = 65;

interface RankSpriteRect {
  readonly offsetX: number;
  /** Unity textureRectOffset uses a bottom-left origin. */
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

// RankIconAtlas sprites are exported as tight PNGs. Unity's Simple Image
// restores this padding inside the common 230x190 Sprite rect even when
// PreserveAspect is disabled; drawing each tight PNG across the whole slot
// would visibly stretch D/C/B. Values come directly from each Sprite.m_RD.
const RANK_SPRITE_RECTS: Readonly<Record<string, RankSpriteRect>> = {
  D: { offsetX: 43.07612228393555, offsetY: 23.076120376586914, width: 143.84774780273438, height: 142.84774780273438 },
  C: { offsetX: 43.07612228393555, offsetY: 23.076120376586914, width: 143.84774780273438, height: 142.84774780273438 },
  B: { offsetX: 43.07612228393555, offsetY: 23.076120376586914, width: 143.84774780273438, height: 142.84774780273438 },
  A: { offsetX: 18.076120376586914, offsetY: 0, width: 193.84774780273438, height: 190 },
  S: { offsetX: 18.076120376586914, offsetY: 0, width: 194.84774780273438, height: 190 },
  SS: { offsetX: 0, offsetY: 0, width: 230, height: 190 },
};

interface SliceBorder {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

interface HudStaticSignature {
  score: number | undefined;
  scoreDelta: number | undefined;
  combo: number | undefined;
  perfectCombo: boolean | undefined;
  fullCombo: boolean | undefined;
  continuationEffects: boolean | undefined;
  life: number | undefined;
  maxLife: number | undefined;
  rank: string | undefined;
  rankProgress: number | undefined;
  rankLabels: ReadonlyArray<string> | undefined;
  showPause: boolean | undefined;
}

export interface TitleIntroductionLayout {
  readonly ribbonCenterX: number;
  readonly ribbonCenterY: number;
  readonly jacketLeft: number;
  readonly jacketTop: number;
  readonly jacketSize: number;
  readonly metadataTop: number;
  readonly metadataRight: number;
  readonly normalJacketLeft: number;
  readonly normalJacketTop: number;
  readonly normalJacketSize: number;
  readonly normalDifficultyLeft: number;
  readonly normalDifficultyTop: number;
  readonly normalDifficultyWidth: number;
  readonly normalDifficultyHeight: number;
  readonly normalLevelCenterX: number;
  readonly normalLevelCenterY: number;
  readonly normalMetadataLeft: number;
  readonly normalMetadataTop: number;
  readonly normalMetadataRight: number;
  readonly normalMetadataHeight: number;
  readonly gekisouPanelRight: number;
  readonly gekisouPanelTop: number;
  readonly gekisouTitleLeft: number;
  readonly gekisouTitleTop: number;
  readonly gekisouTitleWidth: number;
  readonly gekisouTitleHeight: number;
  readonly gekisouMissionRowLeft: number;
  readonly gekisouMissionRowTop: number;
}

/** Active ribbon use is opt-in until a presentation state is explicitly authored for it. */
export function resolveTitleIntroductionRibbonUrl(
  theme: Pick<RenderTitleIntroductionTheme, "assets">,
  variant: "panel" | "active" = "panel",
): string | undefined {
  return variant === "active"
    ? (theme.assets?.activeRibbonUrl ?? theme.assets?.panelRibbonUrl)
    : theme.assets?.panelRibbonUrl;
}

/** Resolves the authored bottom and centre anchors in CanvasScaler logical space. */
export function resolveTitleIntroductionLayout(logicalWidth: number, logicalHeight: number): TitleIntroductionLayout {
  const contentCenterX = logicalWidth / 2;
  const contentCenterY = logicalHeight / 2 - 10;
  const simplePanelLeft = contentCenterX - 220;
  const simplePanelTop = contentCenterY - 297;
  const jacketSize = 512 * 0.8600000143051147;
  // ContentArea is inset 20 px horizontally, 20 px at the top and 40 px at
  // the bottom in the authored 1920x1080 Expand canvas.
  const contentLeft = 20;
  const contentTop = 20;
  const contentRight = logicalWidth - 20;
  const normalPanelLeft = contentLeft + 50;
  const normalPanelTop = contentTop + 50;
  const normalJacketSize = 512 * 0.2460000067949295;
  const normalDifficultyWidth = 151 * 0.8999999761581421;
  const normalDifficultyHeight = 44 * 0.8999999761581421;
  const gekisouPanelRight = contentRight - 29;
  const gekisouPanelTop = contentTop + 6;
  return {
    ribbonCenterX: contentCenterX,
    // ContentArea has a 40 px lower inset. center_bottom is a zero-height
    // transform anchored to that edge, and the ribbon is 199 px above it.
    ribbonCenterY: logicalHeight - 40 - 199,
    jacketLeft: simplePanelLeft + (440 - jacketSize) / 2,
    jacketTop: simplePanelTop + 220 - jacketSize / 2,
    jacketSize,
    metadataTop: simplePanelTop + 454,
    metadataRight: simplePanelLeft + 440,
    normalJacketLeft: normalPanelLeft + 64 - normalJacketSize / 2,
    normalJacketTop: normalPanelTop + 63 - normalJacketSize / 2,
    normalJacketSize,
    normalDifficultyLeft: normalPanelLeft + 219 - normalDifficultyWidth / 2,
    normalDifficultyTop: normalPanelTop + 36 - normalDifficultyHeight / 2,
    normalDifficultyWidth,
    normalDifficultyHeight,
    normalLevelCenterX: normalPanelLeft + 317,
    normalLevelCenterY: normalPanelTop + 38,
    normalMetadataLeft: normalPanelLeft + 151,
    normalMetadataTop: normalPanelTop + 72,
    normalMetadataRight: normalPanelLeft + 440,
    normalMetadataHeight: 38,
    gekisouPanelRight,
    gekisouPanelTop,
    gekisouTitleLeft: gekisouPanelRight - 313 - (117 * 0.800000011920929) / 2,
    gekisouTitleTop: gekisouPanelTop + 32 - (79 * 0.800000011920929) / 2,
    gekisouTitleWidth: 117 * 0.800000011920929,
    gekisouTitleHeight: 79 * 0.800000011920929,
    gekisouMissionRowLeft: gekisouPanelRight - 377,
    gekisouMissionRowTop: gekisouPanelTop + 64,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep01(value: number): number {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function outQuad(progress: number): number {
  const remaining = 1 - clamp(progress, 0, 1);
  return 1 - remaining * remaining;
}

/** DOTween Punch with one vibration: OutQuad rise, then OutQuad recovery. */
export function sampleJudgementPunchScale(age: number): number {
  if (age <= 0 || age >= JUDGEMENT_PUNCH_DURATION) return 1;
  if (age <= JUDGEMENT_PUNCH_RISE_DURATION) {
    return 1 + JUDGEMENT_PUNCH_SCALE * outQuad(age / JUDGEMENT_PUNCH_RISE_DURATION);
  }
  const recoveryDuration = JUDGEMENT_PUNCH_DURATION - JUDGEMENT_PUNCH_RISE_DURATION;
  return 1 + JUDGEMENT_PUNCH_SCALE * (1 - outQuad((age - JUDGEMENT_PUNCH_RISE_DURATION) / recoveryDuration));
}

export interface JudgementTimingPresentation {
  readonly mode: "sprite" | "milliseconds";
  readonly timing: "fast" | "late" | "none";
  readonly nativeWidth: number;
  readonly nativeHeight: number;
  readonly fontSize: number;
  readonly text?: string;
  readonly color?: string;
  readonly scale: number;
  readonly alpha: number;
  readonly localX: number;
  readonly localY: number;
}

/** Resolves the separately restarted native FAST/LATE sub tween. */
export function resolveJudgementTimingPresentation(
  state: Pick<RenderHudState, "alwaysShowFastSlow" | "showFastSlow" | "showPerfectFastSlow" | "showJudgeOffsetMs">,
  judgement: RenderJudgementInstance["judgement"],
  fastSlow: RenderJudgementInstance["fastSlow"],
  differenceMs: number,
  age: number,
): JudgementTimingPresentation | null {
  if (age < 0 || age >= JUDGEMENT_SHOW_DURATION) return null;
  if (!fastSlow) {
    if (state.showJudgeOffsetMs !== true || !Number.isFinite(differenceMs)) return null;
    return {
      mode: "milliseconds",
      timing: "none",
      nativeWidth: JUDGEMENT_TIMING_NATIVE_WIDTH,
      nativeHeight: JUDGEMENT_TIMING_NATIVE_HEIGHT,
      fontSize: JUDGEMENT_TIMING_FONT_SIZE,
      text: String(Math.abs(Math.round(differenceMs))),
      color: "rgba(255, 255, 255, 1)",
      scale: JUDGEMENT_SUB_SCALE * sampleJudgementPunchScale(age),
      alpha: 1,
      localX: 0,
      localY: 0,
    };
  }
  const perfect = judgement === "perfect" || judgement === "just";
  const good = judgement === "good";
  const ordinaryFastSlow = judgement === "bad" || good || judgement === "great";
  const perfectFastSlow = good || perfect;
  const visible =
    state.alwaysShowFastSlow === true ||
    (state.showFastSlow !== false && ordinaryFastSlow) ||
    (state.showPerfectFastSlow !== false && perfectFastSlow);
  if (!visible) return null;

  const timing = fastSlow === "FAST" ? "fast" : "late";
  const scale = JUDGEMENT_SUB_SCALE * sampleJudgementPunchScale(age);
  if (state.showJudgeOffsetMs === true) {
    if (!Number.isFinite(differenceMs)) return null;
    const color = timing === "fast" ? JUDGEMENT_FAST_COLOR : JUDGEMENT_LATE_COLOR;
    return {
      mode: "milliseconds",
      timing,
      nativeWidth: JUDGEMENT_TIMING_NATIVE_WIDTH,
      nativeHeight: JUDGEMENT_TIMING_NATIVE_HEIGHT,
      fontSize: JUDGEMENT_TIMING_FONT_SIZE,
      text: String(Math.abs(Math.round(differenceMs))),
      color: rgba(color[0], color[1], color[2], 1),
      scale,
      alpha: 1,
      localX: 0,
      localY: 0,
    };
  }
  return {
    mode: "sprite",
    timing,
    nativeWidth: JUDGEMENT_TIMING_NATIVE_WIDTH,
    nativeHeight: JUDGEMENT_TIMING_NATIVE_HEIGHT,
    fontSize: JUDGEMENT_TIMING_FONT_SIZE,
    scale,
    alpha: 1,
    localX: 0,
    localY: 0,
  };
}

function rgba(red: number, green: number, blue: number, alpha: number): string {
  return `rgba(${red * 255}, ${green * 255}, ${blue * 255}, ${alpha})`;
}

function interpolate(from: readonly [number, number, number], to: readonly [number, number, number], t: number) {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t] as const;
}

/** Draws Unity Image.Type.Sliced geometry using the source Sprite borders. */
function drawNineSlice(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource & { width: number; height: number },
  x: number,
  y: number,
  width: number,
  height: number,
  border: SliceBorder,
  pixelsPerUnitMultiplier = 1,
): void {
  if (width <= 0 || height <= 0 || image.width <= 0 || image.height <= 0) return;
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  const left = clamp(border.left ?? 0, 0, sourceWidth);
  const right = clamp(border.right ?? 0, 0, sourceWidth - left);
  const top = clamp(border.top ?? 0, 0, sourceHeight);
  const bottom = clamp(border.bottom ?? 0, 0, sourceHeight - top);
  const ppu = Math.max(0.0001, pixelsPerUnitMultiplier);
  let destinationLeft = left / ppu;
  let destinationRight = right / ppu;
  let destinationTop = top / ppu;
  let destinationBottom = bottom / ppu;
  if (destinationLeft + destinationRight > width) {
    const scale = width / (destinationLeft + destinationRight);
    destinationLeft *= scale;
    destinationRight *= scale;
  }
  if (destinationTop + destinationBottom > height) {
    const scale = height / (destinationTop + destinationBottom);
    destinationTop *= scale;
    destinationBottom *= scale;
  }

  const sourceX = [0, left, sourceWidth - right];
  const sourceY = [0, top, sourceHeight - bottom];
  const sourceWidths = [left, sourceWidth - left - right, right];
  const sourceHeights = [top, sourceHeight - top - bottom, bottom];
  const destinationX = [x, x + destinationLeft, x + width - destinationRight];
  const destinationY = [y, y + destinationTop, y + height - destinationBottom];
  const destinationWidths = [destinationLeft, width - destinationLeft - destinationRight, destinationRight];
  const destinationHeights = [destinationTop, height - destinationTop - destinationBottom, destinationBottom];

  for (let row = 0; row < 3; row += 1) {
    if (destinationHeights[row]! <= 0) continue;
    for (let column = 0; column < 3; column += 1) {
      if (destinationWidths[column]! <= 0) continue;
      // Unity permits a zero-width centre (circle_ingame_half is authored this
      // way). Its sliced mesh stretches the inner-edge texel across the centre.
      const sourceCellWidth = sourceWidths[column] || 1;
      const sourceCellHeight = sourceHeights[row] || 1;
      const sourceCellX = clamp(sourceX[column]!, 0, Math.max(0, sourceWidth - sourceCellWidth));
      const sourceCellY = clamp(sourceY[row]!, 0, Math.max(0, sourceHeight - sourceCellHeight));
      context.drawImage(
        image,
        sourceCellX,
        sourceCellY,
        sourceCellWidth,
        sourceCellHeight,
        destinationX[column]!,
        destinationY[row]!,
        destinationWidths[column]!,
        destinationHeights[row]!,
      );
    }
  }
}

/** Canvas HUD matching the reference Live presentation hierarchy. */
export class HudLayer {
  readonly canvas: HTMLCanvasElement;

  private readonly context: CanvasRenderingContext2D;
  private readonly scratchCanvas: HTMLCanvasElement;
  private readonly scratchContext: CanvasRenderingContext2D;
  private readonly assets: OurNotesAssetManifest;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private logicalWidth = 1920;
  private logicalHeight = 1080;
  private laneProjectionLeftNdcX = -1;
  private laneProjectionRightNdcX = 1;
  private readonly judgementImages: Partial<
    Record<"just" | "perfect" | "great" | "good" | "bad" | "miss" | "fast" | "late", HTMLImageElement>
  > = {};
  private readonly hudImages = new Map<string, HTMLImageElement>();
  private readonly titleImages = new Map<string, HTMLImageElement>();
  private readonly pendingTitleImages = new Set<string>();
  private readonly failedTitleImages = new Set<string>();
  private tmpSdfFont?: TmpSdfFont;
  private titleSdfFont?: TmpSdfFont;
  private numericSdfFont?: TmpSdfFont;
  private titleSdfFontKey?: string;
  private numericSdfFontKey?: string;
  private readonly desiredIntroductionFontKeys: Record<"title" | "numeric", string | undefined> = {
    title: undefined,
    numeric: undefined,
  };
  private readonly pendingIntroductionFontKeys = new Set<string>();
  private readonly failedIntroductionFontKeys = new Set<string>();
  private readonly staticSignature: HudStaticSignature = {
    score: undefined,
    scoreDelta: undefined,
    combo: undefined,
    perfectCombo: undefined,
    fullCombo: undefined,
    continuationEffects: undefined,
    life: undefined,
    maxLife: undefined,
    rank: undefined,
    rankProgress: undefined,
    rankLabels: undefined,
    showPause: undefined,
  };
  private forceRedraw = true;
  private renderedVisible = false;
  private judgementWasAnimating = false;
  private comboWasAnimating = false;
  private titleIntroductionWasAnimating = false;
  private overlayTextWasVisible = false;
  private readonly overlayFonts = new Map<string, TmpSdfFont>();
  private introOnly = false;

  drawIntroduction(state: RenderHudState, overlayTexts?: readonly RenderOverlayText[]): void {
    this.introOnly = true;
    this.forceRedraw = true;
    try {
      this.draw(state, overlayTexts);
    } finally {
      this.introOnly = false;
      this.forceRedraw = true;
    }
  }
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, assets: OurNotesAssetManifest) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("OurNotes HUD requires a 2D canvas context");
    const scratchCanvas = document.createElement("canvas");
    const scratchContext = scratchCanvas.getContext("2d");
    if (!scratchContext) throw new Error("OurNotes HUD requires a mask canvas context");
    this.canvas = canvas;
    this.context = context;
    this.scratchCanvas = scratchCanvas;
    this.scratchContext = scratchContext;
    scratchCanvas.width = 1;
    scratchCanvas.height = 1;
    this.assets = assets;
  }

  resize(width: number, height: number, pixelRatio = 1): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = clamp(pixelRatio, 0.5, 3);
    this.canvas.width = Math.max(1, Math.round(this.width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(this.height * this.pixelRatio));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.forceRedraw = true;
  }

  setLaneProjection(leftNdcX: number, rightNdcX: number): void {
    if (!Number.isFinite(leftNdcX) || !Number.isFinite(rightNdcX)) return;
    this.laneProjectionLeftNdcX = Math.min(leftNdcX, rightNdcX);
    this.laneProjectionRightNdcX = Math.max(leftNdcX, rightNdcX);
    this.forceRedraw = true;
  }

  async loadAssets(): Promise<void> {
    if (this.disposed) return;
    if (typeof Image === "undefined") throw new Error("HUD sprites require a browser Image implementation");
    const judgementEntries = Object.entries(this.assets.hud.judgementImages).map(
      ([name, url]) => [`judgement:${name}`, url] as const,
    );
    const entries: ReadonlyArray<readonly [string, string]> = [
      ...judgementEntries,
      ["combo:label", this.assets.hud.comboLabelUrl],
      ...this.assets.hud.comboDigitUrls.map((url, digit) => [`combo:${digit}`, url] as const),
      ["combo:perfect:label", this.assets.hud.perfectComboLabelUrl],
      ...this.assets.hud.perfectComboDigitUrls.map((url, digit) => [`combo:perfect:${digit}`, url] as const),
      ...Object.entries(this.assets.hud.comboTiers ?? {}).flatMap(([tier, assets]) => [
        [`combo:tier:${tier}:label`, assets.labelUrl] as const,
        ...assets.baseDigitUrls.map((url, digit) => [`combo:tier:${tier}:base:${digit}`, url] as const),
        ...assets.fillDigitUrls.map((url, digit) => [`combo:tier:${tier}:fill:${digit}`, url] as const),
        ...(assets.glowUrl ? [[`combo:tier:${tier}:glow`, assets.glowUrl] as const] : []),
      ]),
      ["pause:icon", this.assets.hud.pauseIconUrl],
      ["pause:frame", this.assets.hud.pauseFrameUrl],
      ["pause:shadow", this.assets.hud.pauseShadowUrl],
      ...Object.entries(this.assets.hud.lifeIconUrls).map(([name, url]) => [`life:${name}`, url] as const),
      ...Object.entries(this.assets.hud.rankIconUrls).map(([name, url]) => [`rank:${name}`, url] as const),
      ["rank:base", this.assets.hud.rankBaseUrl],
      ["shape:round14", this.assets.hud.roundMask14Url],
      ["status:base", this.assets.hud.statusBaseUrl],
      ["score:star", this.assets.hud.scoreStarUrl],
      ["white", this.assets.hud.whiteSpriteUrl],
    ];
    const fontRequest = this.assets.tmpSdfFont
      ? Promise.allSettled([TmpSdfFont.load(this.assets.tmpSdfFont)]).then((fontResults) => fontResults[0]!)
      : Promise.resolve(undefined);
    const [results, fontResult] = await Promise.all([
      Promise.allSettled(
        entries.map(
          ([key, url]) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              image.decoding = "async";
              image.onload = () => {
                if (this.disposed) {
                  resolve();
                  return;
                }
                if (key.startsWith("judgement:")) {
                  const name = key.slice("judgement:".length) as keyof typeof this.judgementImages;
                  this.judgementImages[name] = image;
                } else {
                  this.hudImages.set(key, image);
                }
                resolve();
              };
              image.onerror = () =>
                this.disposed ? resolve() : reject(new Error(`Unable to load HUD sprite: ${url}`));
              image.src = url;
            }),
        ),
      ),
      fontRequest,
    ]);
    if (this.disposed) {
      if (fontResult?.status === "fulfilled") fontResult.value.dispose();
      return;
    }
    if (fontResult?.status === "fulfilled") this.tmpSdfFont = fontResult.value;
    if (results.every((result) => result.status === "rejected")) throw new Error("Unable to load original HUD sprites");
    this.forceRedraw = true;
    if (fontResult?.status === "rejected") throw fontResult.reason;
  }

  async loadOverlayFonts(manifest: Readonly<Record<string, TmpSdfFontAssetManifest>>): Promise<void> {
    await Promise.all(
      Object.entries(manifest).map(async ([key, value]) => {
        const font = await TmpSdfFont.load(value);
        if (this.disposed) {
          font.dispose();
          return;
        }
        this.overlayFonts.get(key)?.dispose();
        this.overlayFonts.set(key, font);
      }),
    );
  }

  draw(state: RenderHudState | undefined, overlayTexts?: readonly RenderOverlayText[]): void {
    const context = this.context;
    const next = state ?? EMPTY_HUD_STATE;
    const hudVisible = next.visible !== false;
    const visible = hudVisible || Boolean(overlayTexts?.length);
    if (!visible) {
      if (this.renderedVisible || this.forceRedraw) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      this.renderedVisible = false;
      this.judgementWasAnimating = false;
      this.comboWasAnimating = false;
      this.titleIntroductionWasAnimating = false;
      this.overlayTextWasVisible = false;
      this.forceRedraw = false;
      return;
    }

    const judgementAnimating = Boolean(
      next.judgements?.some((judgement) => judgement.age < JUDGEMENT_SHOW_DURATION) ||
      (next.judgement && (next.judgementAge ?? 0) < JUDGEMENT_SHOW_DURATION),
    );
    const comboAnimating = Boolean(next.combo && next.combo >= 1 && (next.comboAge ?? Infinity) < COMBO_ADD_DURATION);
    const titleIntroductionAnimating = Boolean(next.titleIntroduction && next.titleIntroduction.alpha > 0);
    if (
      !this.forceRedraw &&
      this.renderedVisible &&
      !this.staticStateChanged(next) &&
      !judgementAnimating &&
      !this.judgementWasAnimating &&
      !comboAnimating &&
      !this.comboWasAnimating &&
      !titleIntroductionAnimating &&
      !this.titleIntroductionWasAnimating &&
      !overlayTexts?.length &&
      !this.overlayTextWasVisible
    ) {
      return;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    // CanvasScaler: reference 1920x1080, ScaleWithScreenSize / Expand.
    const scale = Math.min(this.width / 1920, this.height / 1080);
    this.logicalWidth = this.width / scale;
    this.logicalHeight = this.height / scale;
    context.scale(scale, scale);
    context.imageSmoothingEnabled = true;
    context.lineJoin = "round";
    if (hudVisible && !this.introOnly) {
      this.drawScore(next);
      this.drawLife(next);
      this.drawCombo(next);
      this.drawJudgement(next);
    }
    if (hudVisible) this.drawTitleIntroduction(next);
    if (overlayTexts?.length) {
      context.save();
      try {
        context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
        for (const item of overlayTexts) {
          const font = this.overlayFonts.get(item.fontKey);
          if (!font) throw new Error(`Overlay font was not loaded: ${item.fontKey}`);
          const [r, g, b, a] = item.color;
          context.globalAlpha = clamp(a, 0, 1);
          font.drawTextInRect(context, item.text, item.bounds, {
            fontSize: item.fontSize,
            align: item.align,
            verticalAlign: item.verticalAlign,
            color: `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`,
          });
        }
      } finally {
        context.restore();
      }
    }
    // Live skill cells use a separate prefab/atlas. They intentionally remain
    // absent until those source assets can be rendered; generic panels would
    // be visibly unrelated to the original UI.
    this.captureStaticState(next);
    this.renderedVisible = true;
    this.judgementWasAnimating = judgementAnimating;
    this.comboWasAnimating = comboAnimating;
    this.titleIntroductionWasAnimating = titleIntroductionAnimating;
    this.overlayTextWasVisible = Boolean(overlayTexts?.length);
    this.forceRedraw = false;
  }

  private staticStateChanged(state: Readonly<RenderHudState>): boolean {
    const previous = this.staticSignature;
    return (
      previous.score !== state.score ||
      previous.scoreDelta !== state.scoreDelta ||
      previous.combo !== state.combo ||
      previous.perfectCombo !== state.perfectCombo ||
      previous.fullCombo !== state.fullCombo ||
      previous.continuationEffects !== state.continuationEffects ||
      previous.life !== state.life ||
      previous.maxLife !== state.maxLife ||
      previous.rank !== state.rank ||
      previous.rankProgress !== state.rankProgress ||
      previous.rankLabels !== state.rankLabels ||
      previous.showPause !== state.showPause
    );
  }

  private captureStaticState(state: Readonly<RenderHudState>): void {
    const target = this.staticSignature;
    target.score = state.score;
    target.scoreDelta = state.scoreDelta;
    target.combo = state.combo;
    target.perfectCombo = state.perfectCombo;
    target.fullCombo = state.fullCombo;
    target.continuationEffects = state.continuationEffects;
    target.life = state.life;
    target.maxLife = state.maxLife;
    target.rank = state.rank;
    target.rankProgress = state.rankProgress;
    target.rankLabels = state.rankLabels;
    target.showPause = state.showPause;
  }

  private drawMaskedSlice(
    image: HTMLImageElement,
    x: number,
    y: number,
    width: number,
    height: number,
    border: SliceBorder,
    pixelsPerUnitMultiplier: number,
    paint: (context: CanvasRenderingContext2D, width: number, height: number) => string | CanvasGradient,
  ): void {
    const scratchWidth = Math.max(1, Math.ceil(width));
    const scratchHeight = Math.max(1, Math.ceil(height));
    if (this.scratchCanvas.width < scratchWidth || this.scratchCanvas.height < scratchHeight) {
      this.scratchCanvas.width = Math.max(this.scratchCanvas.width, scratchWidth);
      this.scratchCanvas.height = Math.max(this.scratchCanvas.height, scratchHeight);
    }
    const scratch = this.scratchContext;
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.globalCompositeOperation = "source-over";
    scratch.clearRect(0, 0, scratchWidth, scratchHeight);
    scratch.setTransform(scratchWidth / width, 0, 0, scratchHeight / height, 0, 0);
    drawNineSlice(scratch, image, 0, 0, width, height, border, pixelsPerUnitMultiplier);
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.globalCompositeOperation = "source-in";
    scratch.fillStyle = paint(scratch, scratchWidth, scratchHeight);
    scratch.fillRect(0, 0, scratchWidth, scratchHeight);
    scratch.globalCompositeOperation = "source-over";
    this.context.drawImage(this.scratchCanvas, 0, 0, scratchWidth, scratchHeight, x, y, width, height);
  }

  private drawHeaderBackground(): void {
    const context = this.context;
    const from = [0, 0.0588235, 0.2] as const;
    const to = [0.1921569, 0.2235294, 0.4039216] as const;
    const gradient = context.createLinearGradient(20, 0, 680, 0);
    for (const [position, alpha] of [
      [0, 1],
      [0.6, 0.698039],
      [0.9, 0.4],
      [1, 0],
    ] as const) {
      const color = interpolate(from, to, position);
      gradient.addColorStop(position, rgba(color[0], color[1], color[2], alpha));
    }
    context.fillStyle = gradient;
    context.fillRect(20, 0, 660, 146);
  }

  private drawScore(state: RenderHudState): void {
    const context = this.context;
    context.save();
    this.drawHeaderBackground();

    const rankBase = this.hudImages.get("rank:base");
    if (rankBase)
      drawNineSlice(context, rankBase, 6, 0, 149, 160, {
        left: 26,
        top: 4,
        right: 26,
        bottom: 25,
      });
    this.tmpSdfFont?.drawText(context, "RANK", 80.5, 31, {
      align: "center",
      characterSpacing: HUD_CHARACTER_SPACING,
      color: "#ffffff",
      fontSize: 24,
    });
    const rank = state.rank ?? "D";
    const rankImage = this.hudImages.get(`rank:${rank}`);
    if (rankImage) {
      const spriteRect = RANK_SPRITE_RECTS[rank] ?? RANK_SPRITE_RECTS.D!;
      const slotLeft = RANK_ICON_CENTER_X - (RANK_ICON_SOURCE_WIDTH * RANK_ICON_SCALE) / 2;
      const slotTop = RANK_ICON_CENTER_Y - (RANK_ICON_SOURCE_HEIGHT * RANK_ICON_SCALE) / 2;
      context.drawImage(
        rankImage,
        slotLeft + spriteRect.offsetX * RANK_ICON_SCALE,
        slotTop + (RANK_ICON_SOURCE_HEIGHT - spriteRect.offsetY - spriteRect.height) * RANK_ICON_SCALE,
        spriteRect.width * RANK_ICON_SCALE,
        spriteRect.height * RANK_ICON_SCALE,
      );
    }

    const roundMask = this.hudImages.get("shape:round14");
    if (roundMask) {
      this.drawMaskedSlice(
        roundMask,
        158,
        66,
        506,
        28,
        { left: 14, top: 14, right: 14, bottom: 14 },
        1,
        () => "#ffffff",
      );
      this.drawMaskedSlice(
        roundMask,
        160,
        68,
        502,
        24,
        { left: 14, top: 14, right: 14, bottom: 14 },
        7 / 6,
        () => "rgba(24, 18, 41, 0.698039)",
      );
      const gaugeProgress = clamp(state.rankProgress ?? 0, 0, 1);
      if (gaugeProgress > 0) {
        context.save();
        context.beginPath();
        context.rect(160, 68, 502 * gaugeProgress, 24);
        context.clip();
        this.drawMaskedSlice(
          roundMask,
          160,
          68,
          502,
          24,
          { left: 14, top: 14, right: 14, bottom: 14 },
          7 / 6,
          (maskContext, width) => {
            const gradient = maskContext.createLinearGradient(0, 0, width, 0);
            gradient.addColorStop(0, "rgb(163, 224, 255)");
            gradient.addColorStop(9175 / 65535, "rgb(162, 255, 183)");
            gradient.addColorStop(19661 / 65535, "rgb(247, 255, 154)");
            gradient.addColorStop(30801 / 65535, "rgb(255, 204, 162)");
            gradient.addColorStop(41942 / 65535, "rgb(255, 136, 155)");
            gradient.addColorStop(53083 / 65535, "rgb(255, 166, 227)");
            gradient.addColorStop(1, "rgb(154, 125, 250)");
            return gradient;
          },
        );
        context.restore();
      }
    }

    const white = this.hudImages.get("white");
    if (white) {
      for (const separatorX of RANK_SEPARATOR_X) context.drawImage(white, separatorX - 1.5, 68, 3, 24);
    }
    const labels = state.rankLabels ?? DEFAULT_RANK_LABELS;
    const labelCount = Math.min(labels.length, RANK_LABEL_X.length);
    for (let index = 0; index < labelCount; index += 1) {
      this.tmpSdfFont?.drawText(context, labels[index]!, RANK_LABEL_X[index]!, 43, {
        align: "center",
        characterSpacing: HUD_CHARACTER_SPACING,
        color: "#ffffff",
        fontSize: 30,
      });
    }

    const scoreValue = Math.max(0, Math.round(state.score ?? 0));
    const scoreRaw = String(scoreValue);
    const scoreText = scoreRaw.padStart(8, "0");
    const leadingZeroCount = Math.max(0, scoreText.length - scoreRaw.length);
    const font = this.tmpSdfFont;
    font?.drawText(context, scoreText, 42, 190, {
      align: "left",
      characterSpacing: HUD_CHARACTER_SPACING,
      color: (_character, index) => (index < leadingZeroCount ? "#b1afc1" : "#ffffff"),
      fontSize: 44,
    });
    const scoreStar = this.hudImages.get("score:star");
    if (scoreStar) context.drawImage(scoreStar, 20, 202.8, 16.65, 16.2);
    if (white) context.drawImage(white, 28.325, 209, 260, 2);
    font?.drawText(context, "LIVE SCORE", 127, 230, {
      align: "center",
      characterSpacing: HUD_CHARACTER_SPACING,
      color: "#ffffff",
      fontSize: 24,
    });
    if (state.scoreDelta !== undefined && state.scoreDelta !== 0) {
      const delta = Math.round(state.scoreDelta);
      const deltaText = `${delta > 0 ? "+" : ""}${delta}`;
      font?.drawText(context, deltaText, 271.28845, 196.9, {
        align: "left",
        characterSpacing: HUD_CHARACTER_SPACING,
        color: delta >= 0 ? "#ffffff" : "#ff0000",
        fontSize: 24,
      });
    }
    context.restore();
  }

  private drawStatusBackground(): void {
    const statusBase = this.hudImages.get("status:base");
    if (!statusBase) return;
    const from = [0.1921569, 0.2235294, 0.4039216] as const;
    const to = [0, 0.0588235, 0.2] as const;
    this.drawMaskedSlice(statusBase, this.logicalWidth - 420, 19, 400, 80, { right: 60 }, 1.5, (context, width) => {
      const gradient = context.createLinearGradient(0, 0, width, 0);
      for (const [position, alpha] of [
        [0, 0],
        [0.1, 0.4],
        [0.4, 0.698039],
        [1, 1],
      ] as const) {
        const color = interpolate(from, to, position);
        gradient.addColorStop(position, rgba(color[0], color[1], color[2], alpha));
      }
      return gradient;
    });
  }

  private drawLife(state: RenderHudState): void {
    const context = this.context;
    const life = Math.max(0, state.life ?? 1000);
    const maxLife = Math.max(1, state.maxLife ?? 1000);
    const isDanger = life / maxLife <= 0.3;
    const isOver = life > maxLife;
    const lifeType = isDanger ? "danger" : isOver ? "over" : "normal";
    context.save();
    this.drawStatusBackground();

    const roundMask = this.hudImages.get("shape:round14");
    if (roundMask) {
      this.drawMaskedSlice(
        roundMask,
        this.logicalWidth - 400,
        62,
        284,
        16,
        { left: 14, top: 14, right: 14, bottom: 14 },
        1.75,
        () => "rgb(5, 18, 51)",
      );
      const baseProgress = clamp(life / maxLife, 0, 1);
      if (baseProgress > 0) {
        context.save();
        context.beginPath();
        context.rect(this.logicalWidth - 400, 64, 280 * baseProgress, 12);
        context.clip();
        this.drawMaskedSlice(
          roundMask,
          this.logicalWidth - 400,
          64,
          280,
          12,
          { left: 14, top: 14, right: 14, bottom: 14 },
          7 / 3,
          () => (isDanger ? "rgb(255, 77, 77)" : "rgb(102, 255, 140)"),
        );
        context.restore();
      }
      const overProgress = clamp((life - maxLife) / maxLife, 0, 1);
      if (overProgress > 0) {
        context.save();
        context.beginPath();
        context.rect(this.logicalWidth - 400, 64, 280 * overProgress, 12);
        context.clip();
        this.drawMaskedSlice(
          roundMask,
          this.logicalWidth - 400,
          64,
          280,
          12,
          { left: 14, top: 14, right: 14, bottom: 14 },
          7 / 3,
          () => "rgb(198, 255, 234)",
        );
        context.restore();
      }
    }

    const lifeImage = this.hudImages.get(`life:${lifeType}`);
    if (lifeImage) context.drawImage(lifeImage, this.logicalWidth - 220, 34.5, 30, 27);
    this.tmpSdfFont?.drawText(context, String(Math.round(life)), this.logicalWidth - 117.5, 48, {
      align: "right",
      characterSpacing: HUD_CHARACTER_SPACING,
      color: isDanger ? "rgb(255, 77, 77)" : isOver ? "rgb(198, 255, 234)" : "#ffffff",
      fontSize: 30,
    });

    if (state.showPause !== false) {
      const pauseShadow = this.hudImages.get("pause:shadow");
      const pauseFrame = this.hudImages.get("pause:frame");
      const pauseIcon = this.hudImages.get("pause:icon");
      if (pauseShadow) {
        drawNineSlice(context, pauseShadow, this.logicalWidth - 100, 22.36, 80, 90.54, { left: 49, right: 49 });
      }
      if (pauseFrame) {
        drawNineSlice(context, pauseFrame, this.logicalWidth - 100, 19, 80, 80, {
          left: 40,
          top: 40,
          right: 40,
          bottom: 40,
        });
      }
      if (pauseIcon) {
        // IconPause_ingame is a tight 26x32 export of a 64x64 Sprite. Unity's
        // Simple Image restores m_RD.textureRectOffset inside that 64x64 slot.
        // Stretching the exported PNG across the slot makes the pause bars
        // roughly twice their authored size.
        context.drawImage(
          pauseIcon,
          this.logicalWidth - 92 + PAUSE_ICON_SPRITE_RECT.offsetX,
          PAUSE_ICON_SLOT_TOP + (PAUSE_ICON_SLOT_SIZE - PAUSE_ICON_SPRITE_RECT.offsetY - PAUSE_ICON_SPRITE_RECT.height),
          PAUSE_ICON_SPRITE_RECT.width,
          PAUSE_ICON_SPRITE_RECT.height,
        );
      }
    }
    context.restore();
  }

  private drawCombo(state: RenderHudState): void {
    if (!state.combo || state.combo < 1) return;
    if (this.assets.hud.comboTiers) {
      this.drawNativeCombo(state);
      return;
    }
    const comboText = String(Math.min(9999, Math.max(0, Math.round(state.combo))));
    const prefix = state.continuationEffects !== false && state.perfectCombo ? "combo:perfect" : "combo";
    const label = this.hudImages.get(`${prefix}:label`);
    const digits = [...comboText].map((digit) => this.hudImages.get(`${prefix}:${digit}`));
    if (!label || digits.some((digit) => !digit)) return;

    const context = this.context;
    const centerX = this.logicalWidth / 2 + 768;
    const layoutWidth = comboText.length * 112 + Math.max(0, comboText.length - 1) * -34;
    const firstCenter = centerX - layoutWidth / 2 + 56;
    const age = Math.max(0, state.comboAge ?? COMBO_ADD_DURATION);
    const firstProgress = smoothstep01(age / COMBO_ADD_PEAK_TIME);
    const secondProgress = smoothstep01((age - COMBO_ADD_PEAK_TIME) / (COMBO_ADD_DURATION - COMBO_ADD_PEAK_TIME));
    const addScale =
      age < COMBO_ADD_PEAK_TIME
        ? 0.8999999761581421 + (1.25 - 0.8999999761581421) * firstProgress
        : 1.25 - 0.25 * secondProgress;
    const addAlpha = age < COMBO_ADD_PEAK_TIME ? 0.800000011920929 + (1 - 0.800000011920929) * firstProgress : 1;
    context.save();
    // LiveComboAdd.anim: the root CanvasGroup fades 0.8 -> 1 over 8/60 s.
    // Only CountRoot receives the 0.9 -> 1.25 -> 1 scale pulse; Title keeps
    // its authored 183x63 size. Both streamed curves use zero-tangent cubic
    // Hermite interpolation, which is exactly smoothstep.
    context.globalAlpha = addAlpha;
    context.drawImage(label, centerX - 91.5, 466, 183, 63);
    context.translate(centerX, 578);
    context.scale(addScale, addScale);
    for (let index = 0; index < digits.length; index += 1) {
      const digit = digits[index]!;
      if (!digit) continue;
      // SetDigit calls Image.SetNativeSize() after every sprite change. The
      // child Image keeps its natural dimensions (not the frame's serialized
      // placeholder size), while the four fixed 112px parent frames remain in
      // the HorizontalLayoutGroup at 78px centre-to-centre. Only FourDigiFrame
      // (the thousands place) has the authored 0.95 parent scale.
      const frameScale = comboText.length === 4 && index === 0 ? 0.95 : 1;
      const width = digit.naturalWidth * frameScale;
      const height = digit.naturalHeight * frameScale;
      const x = firstCenter + index * 78 - centerX;
      context.drawImage(digit, x - width / 2, -height / 2, width, height);
    }
    context.restore();
  }

  private drawNativeCombo(state: RenderHudState): void {
    const tier =
      state.continuationEffects === false
        ? "normal"
        : state.perfectCombo
          ? "allPerfect"
          : state.fullCombo
            ? "fullCombo"
            : "normal";
    const prefix = `combo:tier:${tier}`;
    const geometry = this.assets.hud.comboTiers?.[tier].geometry;
    const label = this.hudImages.get(`${prefix}:label`);
    const text = String(Math.min(9999, Math.max(1, Math.trunc(state.combo ?? 1))));
    const base = [...text].map((digit) => this.hudImages.get(`${prefix}:base:${digit}`));
    const fill = [...text].map((digit) => this.hudImages.get(`${prefix}:fill:${digit}`));
    if (!label || base.some((image) => !image) || fill.some((image) => !image)) return;
    const context = this.context;
    // Formal Live.unity UIComboCounterView: ContentArea top anchor, 120px
    // digit frames, -34 spacing. New tiers use base+fill images, not old 112px digits.
    const x = this.logicalWidth / 2 + 720;
    const y = 510;
    const age = Math.max(0, state.comboAge ?? COMBO_ADD_DURATION);
    const rising = smoothstep01(age / COMBO_ADD_PEAK_TIME);
    const falling = smoothstep01((age - COMBO_ADD_PEAK_TIME) / (COMBO_ADD_DURATION - COMBO_ADD_PEAK_TIME));
    // LiveComboAdd's three streamed CountRoot scale curves: .9 -> 1.1 -> 1.
    // Root and Title CanvasGroup alpha are constant 1 in the same clip.
    const scale =
      age < COMBO_ADD_PEAK_TIME
        ? 0.8999999761581421 + 0.20000004768371582 * rising
        : 1.100000023841858 - 0.10000002384185791 * falling;
    const alpha = 1;
    context.save();
    context.globalAlpha = alpha;
    const glow = this.hudImages.get(`${prefix}:glow`);
    if (glow) {
      const width = text.length * 120 + (text.length - 1) * -34 + 280;
      context.globalAlpha = alpha * 0.8627451062202454;
      this.drawComboSprite(glow, geometry?.glow, x - 4 - width / 2, y + 14 - 199, width, 398);
      context.globalAlpha = alpha;
    }
    this.drawComboSprite(
      label,
      geometry?.label,
      x - (168 * 1.149999976158142) / 2,
      y - 98 + 1,
      168 * 1.149999976158142,
      38 * 1.149999976158142,
    );
    context.translate(x, y + 18);
    context.scale(scale, scale);
    const width = text.length * 120 + (text.length - 1) * -34;
    for (let index = 0; index < text.length; index += 1) {
      const center = -width / 2 + 60 + index * 86;
      const baseImage = base[index];
      const fillImage = fill[index];
      for (const [image, sprite] of [
        [baseImage, geometry?.baseDigits[Number(text[index])]],
        [fillImage, geometry?.fillDigits[Number(text[index])]],
      ] as const) {
        if (!image) continue;
        const width = sprite?.rectWidth ?? image.naturalWidth;
        const height = sprite?.rectHeight ?? image.naturalHeight;
        this.drawComboSprite(image, sprite, center - width / 2, -height / 2, width, height);
      }
    }
    context.restore();
  }

  /** Simple UGUI Image padding keeps cropped base/fill sprites in their authored full rect. */
  private drawComboSprite(
    image: HTMLImageElement,
    sprite: HudSpriteGeometry | undefined,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    if (!sprite) {
      this.context.drawImage(image, left, top, width, height);
      return;
    }
    const scaleX = width / sprite.rectWidth;
    const scaleY = height / sprite.rectHeight;
    this.context.drawImage(
      image,
      left + sprite.offsetX * scaleX,
      top + (sprite.rectHeight - sprite.textureHeight - sprite.offsetY) * scaleY,
      sprite.textureWidth * scaleX,
      sprite.textureHeight * scaleY,
    );
  }

  private drawJudgement(state: RenderHudState): void {
    if (state.judgementPosition === "none") return;
    const active = this.resolveJudgementViews(state);
    if (active.length) {
      for (const result of active) {
        const x = state.judgementPosition === "lane" ? this.laneHudX(result.laneCenter) : this.logicalWidth / 2;
        this.drawJudgementInstance(state, result, x);
      }
      return;
    }
    if (!state.judgement || (state.judgementAge ?? 0) >= JUDGEMENT_SHOW_DURATION) return;
    this.drawJudgementSprite(
      state.judgement,
      state.fastSlow ?? null,
      state.differenceMs ?? 0,
      this.logicalWidth / 2,
      state,
      state.judgementAge ?? 0,
    );
  }

  private resolveJudgementViews(state: RenderHudState): RenderJudgementInstance[] {
    const source = state.judgements;
    if (!source?.length) return [];
    if (state.judgementPosition !== "lane") return [source[source.length - 1]!];
    const slots: RenderJudgementInstance[] = [];
    const overlap = Math.max(0, Math.floor(state.noteOverlapLaneBuffer ?? 0));
    for (const result of source) {
      const existing = slots.findIndex((slot) => Math.abs(slot.laneCenter - result.laneCenter) <= overlap);
      if (existing >= 0) slots[existing] = result;
      else if (slots.length < JUDGEMENT_POOL_CAPACITY) slots.push(result);
      else slots[0] = result;
    }
    return slots;
  }

  private laneHudX(laneCenter: number): number {
    const progress = clamp(laneCenter / CHART_LANE_COUNT, 0, 1);
    const ndcX = this.laneProjectionLeftNdcX + (this.laneProjectionRightNdcX - this.laneProjectionLeftNdcX) * progress;
    return (ndcX * 0.5 + 0.5) * this.logicalWidth;
  }

  private drawJudgementInstance(state: RenderHudState, result: RenderJudgementInstance, x: number): void {
    this.drawJudgementSprite(result.judgement, result.fastSlow, result.differenceMs, x, state, result.age);
  }

  private drawJudgementSprite(
    judgement: RenderJudgementInstance["judgement"],
    fastSlow: RenderJudgementInstance["fastSlow"],
    differenceMs: number,
    x: number,
    state: RenderHudState,
    age: number,
  ): void {
    if (age >= JUDGEMENT_SHOW_DURATION) return;
    const image = this.judgementImages[judgement];
    const context = this.context;
    const y = this.logicalHeight / 2 + JUDGEMENT_CENTER_OFFSET_Y;
    if (image && age < JUDGEMENT_SHOW_DURATION) {
      // Manifest judgement PNGs retain their full Sprite rect; SetNativeSize
      // uses those source dimensions (including formal Perfect's 323x89).
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      context.save();
      context.translate(x, y);
      const scale = sampleJudgementPunchScale(Math.max(0, age));
      context.scale(scale, scale);
      context.drawImage(image, -width / 2, -height / 2, width, height);
      context.restore();
    }

    const timing = resolveJudgementTimingPresentation(state, judgement, fastSlow, differenceMs, Math.max(0, age));
    if (!timing) return;
    context.save();
    context.translate(x, this.logicalHeight / 2 + JUDGEMENT_TIMING_CENTER_OFFSET_Y);
    context.globalAlpha *= timing.alpha;
    context.scale(timing.scale, timing.scale);
    if (timing.mode === "sprite" && timing.timing !== "none") {
      const timingImage = this.judgementImages[timing.timing];
      if (timingImage) {
        context.drawImage(
          timingImage,
          timing.localX - timing.nativeWidth / 2,
          timing.localY - timing.nativeHeight / 2,
          timing.nativeWidth,
          timing.nativeHeight,
        );
      }
    } else {
      this.tmpSdfFont?.drawText(context, timing.text ?? "", timing.localX, timing.localY, {
        align: "center",
        fontSize: timing.fontSize,
        color: timing.color ?? "rgba(255, 255, 255, 1)",
      });
    }
    context.restore();
  }

  private drawTitleIntroduction(state: RenderHudState): void {
    const introduction = state.titleIntroduction;
    if (!introduction || introduction.alpha <= 0 || !introduction.title) return;
    const theme = { ...DEFAULT_TITLE_THEME, ...introduction.theme };
    const context = this.context;
    const layout = resolveTitleIntroductionLayout(this.logicalWidth, this.logicalHeight);
    const centerX = layout.ribbonCenterX;
    const centerY = layout.ribbonCenterY;
    const panelWidth = 1366;
    const panelHeight = 192;
    const left = centerX - panelWidth / 2;
    const top = centerY - panelHeight / 2;
    const genericFamilies = new Set(["serif", "sans-serif", "monospace", "system-ui"]);
    const fontFamily = theme.fontFamilies
      .map((family) => (genericFamilies.has(family) ? family : JSON.stringify(family)))
      .join(", ");
    const titleFontContract = theme.assets?.titleFont;
    const numericFontContract = theme.assets?.numericFont;
    const titleFont = this.introductionFont("title", titleFontContract);
    const numericFont = this.introductionFont("numeric", numericFontContract);
    const waitForTitleFont = this.shouldWaitForIntroductionFont("title", titleFontContract);
    const waitForNumericFont = this.shouldWaitForIntroductionFont("numeric", numericFontContract);
    const drawCanvasText = (
      text: string,
      y: number,
      size: number,
      weight: number,
      color: string,
      x = centerX,
      maxWidth = 1000,
      sdfFont = titleFont,
      waitForSdf = waitForTitleFont,
    ): void => {
      if (!text) return;
      if (sdfFont?.canRender(text)) {
        const measured = sdfFont.measureText(text, size);
        const fittedSize = measured && measured > maxWidth ? Math.max(12, size * (maxWidth / measured)) : size;
        if (
          sdfFont.drawText(context, text, x, y, {
            align: "center",
            fontSize: fittedSize,
            color,
          })
        )
          return;
      } else if (waitForSdf && !sdfFont) {
        return;
      }
      context.fillStyle = color;
      context.font = `${weight} ${size}px ${fontFamily}`;
      const measured = context.measureText(text).width;
      const fittedSize = measured > maxWidth ? Math.max(12, size * (maxWidth / measured)) : size;
      context.font = `${weight} ${fittedSize}px ${fontFamily}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(text, x, y);
    };

    context.save();
    const rootAlpha = clamp(introduction.rootAlpha ?? introduction.alpha, 0, 1);
    const centerAlpha = clamp(introduction.centerAlpha ?? introduction.contentAlpha ?? rootAlpha, 0, 1);
    const simpleAlpha = clamp(introduction.simpleAlpha ?? introduction.contentAlpha ?? centerAlpha, 0, 1);
    const leftAlpha = clamp(introduction.leftAlpha ?? introduction.contentAlpha ?? centerAlpha, 0, 1);
    const rightAlpha = clamp(introduction.rightAlpha ?? introduction.contentAlpha ?? centerAlpha, 0, 1);
    const layoutMode = introduction.layoutMode ?? "lightweight";
    const jacket = this.titleImage(introduction.jacketUrl);
    if (layoutMode === "normal") {
      context.globalAlpha = leftAlpha;
      if (jacket)
        context.drawImage(
          jacket,
          layout.normalJacketLeft,
          layout.normalJacketTop,
          layout.normalJacketSize,
          layout.normalJacketSize,
        );
      this.drawNormalTitleMetadata(introduction, layout, fontFamily, numericFont, waitForNumericFont, theme);
    } else {
      context.globalAlpha = simpleAlpha;
      if (jacket) context.drawImage(jacket, layout.jacketLeft, layout.jacketTop, layout.jacketSize, layout.jacketSize);
      this.drawSimpleTitleMetadata(introduction, layout, fontFamily, numericFont, waitForNumericFont);
    }
    context.globalAlpha = rightAlpha;
    this.drawGekisouIntroduction(introduction, layout, fontFamily, numericFont, waitForNumericFont, theme);

    context.globalAlpha = rootAlpha;
    const ribbonVariant = introduction.ribbonVariant ?? "panel";
    const ribbonUrl = resolveTitleIntroductionRibbonUrl(theme, ribbonVariant);
    const ribbon = this.titleImage(ribbonUrl);
    if (ribbon) {
      const ribbonHeight = ribbonVariant === "active" && theme.assets?.activeRibbonUrl ? 222 : panelHeight;
      context.drawImage(ribbon, left, centerY - ribbonHeight / 2, panelWidth, ribbonHeight);
    } else if (!ribbonUrl) {
      context.fillStyle = theme.panelBackground;
      context.fillRect(left, top, panelWidth, panelHeight);
    }
    if (theme.panelBorderWidthPx > 0) {
      context.strokeStyle = theme.panelBorderColor;
      context.lineWidth = theme.panelBorderWidthPx;
      context.strokeRect(left, top, panelWidth, panelHeight);
    }
    context.globalAlpha = centerAlpha;
    drawCanvasText(introduction.title, centerY - 48, 48, 700, theme.titleColor);
    drawCanvasText(introduction.artist ?? "", centerY + 8, 24, 700, theme.artistColor);
    const lyricist = introduction.lyricist ? `作詞: ${introduction.lyricist}` : "";
    const composer = introduction.composer ? `作曲: ${introduction.composer}` : "";
    context.font = `700 22px ${fontFamily}`;
    const lyricistWidth = lyricist
      ? titleFont?.canRender(lyricist)
        ? (titleFont.measureText(lyricist, 22) ?? 0)
        : context.measureText(lyricist).width
      : 0;
    const composerWidth = composer
      ? titleFont?.canRender(composer)
        ? (titleFont.measureText(composer, 22) ?? 0)
        : context.measureText(composer).width
      : 0;
    const composerOverflows = Boolean(lyricist && composer && lyricistWidth + composerWidth > 960);
    if (!composerOverflows && lyricist && composer) {
      drawCanvasText(lyricist, centerY + 44, 22, 700, theme.creditsColor, centerX - composerWidth / 2, 960);
      drawCanvasText(composer, centerY + 44, 22, 700, theme.creditsColor, centerX + lyricistWidth / 2, 960);
    } else {
      drawCanvasText(lyricist || composer, centerY + 44, 22, 700, theme.creditsColor, centerX, 960);
    }
    if (composerOverflows) drawCanvasText(composer, centerY + 68, 22, 700, theme.creditsColor);
    drawCanvasText(
      introduction.arranger ? `編曲: ${introduction.arranger}` : "",
      centerY + (composerOverflows ? 92 : 68),
      22,
      700,
      theme.creditsColor,
    );
    context.restore();
  }

  private titleImage(url: string | undefined): HTMLImageElement | undefined {
    if (!url || typeof Image === "undefined") return undefined;
    const loaded = this.titleImages.get(url);
    if (loaded || this.pendingTitleImages.has(url) || this.failedTitleImages.has(url)) return loaded;
    this.pendingTitleImages.add(url);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      this.pendingTitleImages.delete(url);
      if (this.disposed) return;
      this.titleImages.set(url, image);
      this.forceRedraw = true;
    };
    image.onerror = () => {
      this.pendingTitleImages.delete(url);
      this.failedTitleImages.add(url);
    };
    image.src = url;
    return undefined;
  }

  private introductionFont(
    channel: "title" | "numeric",
    manifest: NonNullable<RenderTitleIntroductionTheme["assets"]>["titleFont"],
  ): TmpSdfFont | undefined {
    if (!manifest) return undefined;
    const key = `${channel}\u0000${manifest.atlasTextureUrl}\u0000${manifest.metadataUrl}`;
    this.desiredIntroductionFontKeys[channel] = key;
    const loadedKey = channel === "title" ? this.titleSdfFontKey : this.numericSdfFontKey;
    const loaded = channel === "title" ? this.titleSdfFont : this.numericSdfFont;
    if (loadedKey === key) return loaded;
    if (this.pendingIntroductionFontKeys.has(key) || this.failedIntroductionFontKeys.has(key)) return undefined;
    this.pendingIntroductionFontKeys.add(key);
    void TmpSdfFont.load(manifest).then(
      (font) => {
        this.pendingIntroductionFontKeys.delete(key);
        if (this.disposed || this.desiredIntroductionFontKeys[channel] !== key) {
          font.dispose();
          return;
        }
        if (channel === "title") {
          this.titleSdfFont?.dispose();
          this.titleSdfFont = font;
          this.titleSdfFontKey = key;
        } else {
          this.numericSdfFont?.dispose();
          this.numericSdfFont = font;
          this.numericSdfFontKey = key;
        }
        this.forceRedraw = true;
      },
      () => {
        this.pendingIntroductionFontKeys.delete(key);
        this.failedIntroductionFontKeys.add(key);
        this.forceRedraw = true;
      },
    );
    return undefined;
  }

  private shouldWaitForIntroductionFont(
    channel: "title" | "numeric",
    manifest: NonNullable<RenderTitleIntroductionTheme["assets"]>["titleFont"],
  ): boolean {
    if (!manifest) return false;
    const key = `${channel}\u0000${manifest.atlasTextureUrl}\u0000${manifest.metadataUrl}`;
    return !this.failedIntroductionFontKeys.has(key);
  }

  private drawIntroductionText(
    font: TmpSdfFont | undefined,
    waitForFont: boolean,
    text: string,
    x: number,
    y: number,
    fontSize: number,
    color: string,
    align: "left" | "center" | "right",
    fontFamily: string,
  ): void {
    if (!text) return;
    if (font?.canRender(text)) {
      if (font.drawText(this.context, text, x, y, { align, fontSize, color })) return;
    } else if (waitForFont && !font) {
      return;
    }
    const context = this.context;
    context.fillStyle = color;
    context.font = `400 ${fontSize}px ${fontFamily}`;
    context.textAlign = align;
    context.textBaseline = "middle";
    context.fillText(text, x, y);
  }

  private drawDifficultyFallback(
    introduction: NonNullable<RenderHudState["titleIntroduction"]>,
    fontFamily: string,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    if (!introduction.difficulty) return;
    const context = this.context;
    // Explicit resource fallback: this preserves readable metadata but is not
    // presented as the authored difficulty sprite.
    context.fillStyle = "rgba(236, 67, 92, 0.94)";
    context.fillRect(left, top, width, height);
    context.fillStyle = "#ffffff";
    context.font = `700 18px ${fontFamily}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(introduction.difficulty.toLocaleUpperCase(), left + width / 2, top + height / 2);
  }

  private drawSimpleTitleMetadata(
    introduction: NonNullable<RenderHudState["titleIntroduction"]>,
    layout: TitleIntroductionLayout,
    fontFamily: string,
    numericFont: TmpSdfFont | undefined,
    waitForNumericFont: boolean,
  ): void {
    const context = this.context;
    const difficultyIcon = this.titleImage(introduction.difficultyIconUrl);
    if (difficultyIcon) {
      context.drawImage(difficultyIcon, layout.metadataRight - 440 - 1, layout.metadataTop + 3, 120.8, 35.2);
    } else
      this.drawDifficultyFallback(
        introduction,
        fontFamily,
        layout.metadataRight - 441,
        layout.metadataTop + 3,
        120.8,
        35.2,
      );
    if (introduction.level !== undefined) {
      this.drawIntroductionText(
        numericFont,
        waitForNumericFont,
        String(introduction.level),
        layout.metadataRight - 298,
        layout.metadataTop + 21.9,
        30,
        "#ffffff",
        "center",
        fontFamily,
      );
    }
    if (introduction.highScore !== undefined && Number.isFinite(introduction.highScore)) {
      const score = String(Math.max(0, Math.trunc(introduction.highScore)));
      this.drawIntroductionText(
        numericFont,
        waitForNumericFont,
        "HIGH SCORE",
        layout.metadataRight - 257,
        layout.metadataTop + 19,
        18,
        "#ffffff",
        "left",
        fontFamily,
      );
      this.drawIntroductionText(
        numericFont,
        waitForNumericFont,
        ":",
        layout.metadataRight - 143,
        layout.metadataTop + 19,
        22,
        "#ffffff",
        "left",
        fontFamily,
      );
      this.drawIntroductionText(
        numericFont,
        waitForNumericFont,
        score,
        layout.metadataRight - 7,
        layout.metadataTop + 19,
        30,
        "#ffffff",
        "right",
        fontFamily,
      );
    }
  }

  private drawNormalTitleMetadata(
    introduction: NonNullable<RenderHudState["titleIntroduction"]>,
    layout: TitleIntroductionLayout,
    fontFamily: string,
    numericFont: TmpSdfFont | undefined,
    waitForNumericFont: boolean,
    theme: RenderTitleIntroductionTheme,
  ): void {
    const context = this.context;
    const difficultyIcon = this.titleImage(introduction.difficultyIconUrl);
    if (difficultyIcon) {
      context.drawImage(
        difficultyIcon,
        layout.normalDifficultyLeft,
        layout.normalDifficultyTop,
        layout.normalDifficultyWidth,
        layout.normalDifficultyHeight,
      );
    } else {
      this.drawDifficultyFallback(
        introduction,
        fontFamily,
        layout.normalDifficultyLeft,
        layout.normalDifficultyTop,
        layout.normalDifficultyWidth,
        layout.normalDifficultyHeight,
      );
    }
    if (introduction.level !== undefined) {
      this.drawIntroductionText(
        numericFont,
        waitForNumericFont,
        String(introduction.level),
        layout.normalLevelCenterX,
        layout.normalLevelCenterY,
        44,
        "#ffffff",
        "center",
        fontFamily,
      );
    }
    if (introduction.highScore !== undefined && Number.isFinite(introduction.highScore)) {
      const score = String(Math.max(0, Math.trunc(introduction.highScore)));
      const baseLeft = layout.normalMetadataLeft;
      const baseRight = layout.normalMetadataRight;
      const centerY = layout.normalMetadataTop + 19;
      const base = this.titleImage(theme.assets?.normalHighScoreBaseUrl);
      if (base) {
        context.save();
        context.globalAlpha *= clamp(theme.assets?.normalHighScoreBaseAlpha ?? 0.1921568661928177, 0, 1);
        context.drawImage(base, baseLeft, layout.normalMetadataTop, baseRight - baseLeft, layout.normalMetadataHeight);
        context.restore();
      }
      this.drawIntroductionText(
        numericFont,
        waitForNumericFont,
        "HIGH SCORE",
        baseLeft + 8,
        centerY,
        22,
        "#ffffff",
        "left",
        fontFamily,
      );
      this.drawIntroductionText(
        numericFont,
        waitForNumericFont,
        ":",
        baseLeft + 147,
        centerY,
        22,
        "#ffffff",
        "left",
        fontFamily,
      );
      this.drawIntroductionText(
        numericFont,
        waitForNumericFont,
        score,
        baseRight - 7,
        centerY,
        30,
        "#ffffff",
        "right",
        fontFamily,
      );
    }
  }

  private drawGekisouIntroduction(
    introduction: NonNullable<RenderHudState["titleIntroduction"]>,
    layout: TitleIntroductionLayout,
    fontFamily: string,
    numericFont: TmpSdfFont | undefined,
    waitForNumericFont: boolean,
    theme: RenderTitleIntroductionTheme,
  ): void {
    const gekisou = introduction.gekisou;
    if (!gekisou?.enabled) return;
    const context = this.context;
    const title = this.titleImage(theme.assets?.gekisouTitleUrl);
    if (title) {
      context.drawImage(
        title,
        layout.gekisouTitleLeft,
        layout.gekisouTitleTop,
        layout.gekisouTitleWidth,
        layout.gekisouTitleHeight,
      );
    }
    this.drawIntroductionText(
      numericFont,
      waitForNumericFont,
      gekisou.performanceLabel || "PERFORMANCE",
      layout.gekisouPanelRight,
      layout.gekisouPanelTop + 41,
      34,
      "#ffffff",
      "right",
      fontFamily,
    );
    const missions = gekisou.missions?.slice(0, 3) ?? [];
    for (let index = 0; index < missions.length; index += 1) {
      const mission = missions[index]!;
      const slotCenterX = layout.gekisouMissionRowLeft + (index * 2 + 0.5) * 75.4000015258789;
      const icon = this.titleImage(
        mission.iconUrl ?? (mission.kind ? theme.assets?.gekisouMissionUrls?.[mission.kind] : undefined),
      );
      if (icon) context.drawImage(icon, slotCenterX - 46.5, layout.gekisouMissionRowTop + 3.5, 93, 91);
      // Missing icon/arrow sprites intentionally fall back to the authored text
      // slot only; no generic shape is claimed to match the source artwork.
      this.drawIntroductionText(
        numericFont,
        waitForNumericFont,
        mission.label,
        slotCenterX,
        layout.gekisouMissionRowTop + 85,
        24,
        "#ffffff",
        "center",
        fontFamily,
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hudImages.clear();
    this.titleImages.clear();
    this.pendingTitleImages.clear();
    this.failedTitleImages.clear();
    this.tmpSdfFont?.dispose();
    this.tmpSdfFont = undefined;
    this.titleSdfFont?.dispose();
    this.titleSdfFont = undefined;
    this.numericSdfFont?.dispose();
    for (const font of this.overlayFonts.values()) font.dispose();
    this.overlayFonts.clear();
    this.numericSdfFont = undefined;
    this.pendingIntroductionFontKeys.clear();
    this.failedIntroductionFontKeys.clear();
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.scratchCanvas.width = 1;
    this.scratchCanvas.height = 1;
  }
}
