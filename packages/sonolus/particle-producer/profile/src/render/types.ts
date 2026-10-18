import type { OurNotesAssetManifest, TmpSdfFontAssetManifest } from "../assets/manifest.js";

/** Visual-only native option units (1..14). Replace together with its compiled chart epoch. */
export interface NativeChartVisualProfiles {
  notes: readonly { nativeNoteId: number; noteSpeed: number }[];
  lines: readonly { nativeLineId: number; noteSpeed: number }[];
}

export interface NativeChartVisualProfileDiagnostic {
  code:
    | "invalid-profiles"
    | "invalid-speed"
    | "duplicate-id"
    | "unknown-id"
    | "generated-note"
    | "line-speed-conflict"
    | "shared-note-speed-conflict";
  target: "notes" | "lines";
  nativeId?: number;
  message: string;
}

export class NativeChartVisualProfilesError extends Error {
  readonly diagnostics: readonly NativeChartVisualProfileDiagnostic[];
  constructor(diagnostics: readonly NativeChartVisualProfileDiagnostic[]) {
    super("Invalid native chart visual profiles");
    this.name = "NativeChartVisualProfilesError";
    this.diagnostics = diagnostics;
  }
}

export type RenderNoteKind =
  | "tap"
  | "flick"
  | "flick-left"
  | "flick-right"
  | "slide-start"
  | "slide-node"
  | "slide-end"
  | "trace"
  | "guide";

export type RenderDirection = "none" | "left" | "right" | "up";

/**
 * Positions are expressed in original chart lane units. Lane 0 is the left
 * edge and the embedded charts use 24 lanes. `approach = 0` is the judgement
 * line and `approach = 1` is the spawn/horizon point.
 */
export interface RenderNote {
  id: string | number;
  kind: RenderNoteKind;
  lane: number;
  width: number;
  approach: number;
  direction?: RenderDirection;
  alpha?: number;
  scale?: number;
  critical?: boolean;
  visible?: boolean;
}

/**
 * Native pair-note line joining the centres of judged notes sharing one
 * timestamp. Coordinates are lane-edge coordinates (0..24), not note lanes.
 */
export interface RenderSimultaneousLine {
  id: string | number;
  leftCenter: number;
  rightCenter: number;
  approach: number;
  /** Independent native view approaches when a same-beat line connects mixed visual profiles. */
  leftApproach?: number;
  rightApproach?: number;
  visible?: boolean;
}

export type RenderHoldKind = "long" | "slide" | "trace" | "guide";

export type RenderEasing = "linear" | "in" | "out" | "in-out" | number;

export interface RenderPathPoint {
  /** Authored row time normalized against the complete line, independent of viewport clipping. */
  lineProgress?: number;
  lane: number;
  width: number;
  approach: number;
  /** Each ribbon edge is interpolated independently, matching the native path builder. */
  leftEasing?: RenderEasing;
  rightEasing?: RenderEasing;
  /** Expansion outside the chart lane edge, expressed in 24-lane half-lane units. */
  leftLineOffset?: number;
  rightLineOffset?: number;
}

export interface RenderHold {
  /** Smallest authored width over the entire line, before visible clipping. */
  minimumWidth?: number;
  missed?: boolean;
  id: string | number;
  kind: RenderHoldKind;
  points: ReadonlyArray<RenderPathPoint>;
  alpha?: number;
  active?: boolean;
  critical?: boolean;
  color?: string | number;
  visible?: boolean;
}

export type RenderParticleKind =
  | "tap"
  | "flick"
  | "slide"
  | "trace"
  | "spark"
  | "excellent"
  | "slide-loop"
  | "connect"
  /** Native lane_tap_blank_miss_view, distinct from note judgement effects. */
  | "lane-input-blank-miss"
  | "lane-effect-normal"
  | "lane-effect-slide"
  | "lane-effect-flick"
  | "lane-effect-flick-left"
  | "lane-effect-flick-right"
  | "lane-effect-gekisou";

export type RenderLaneEffectKind = Extract<RenderParticleKind, `lane-${string}`>;

export function isRenderLaneEffectKind(kind: RenderParticleKind): kind is RenderLaneEffectKind {
  return (
    kind === "lane-input-blank-miss" ||
    kind === "lane-effect-normal" ||
    kind === "lane-effect-slide" ||
    kind === "lane-effect-flick" ||
    kind === "lane-effect-flick-left" ||
    kind === "lane-effect-flick-right" ||
    kind === "lane-effect-gekisou"
  );
}

export interface RenderParticleEffect {
  id: string | number;
  kind: RenderParticleKind;
  lane: number;
  width?: number;
  approach?: number;
  /** Seconds since the effect was spawned. */
  age: number;
  /** Native Animator state; Just reuses Perfect and Miss emits no effect. */
  judgement?: RenderJudgement;
  lifetime?: number;
  intensity?: number;
  direction?: RenderDirection;
  color?: string | number;
  seed?: number;
}

export type RenderJudgement = "just" | "perfect" | "great" | "good" | "bad" | "miss";

export interface RenderJudgementInstance {
  id: number;
  judgement: RenderJudgement;
  /** Seconds since this result replaced or acquired a HUD slot. */
  age: number;
  /** Chart-lane centre in the 0..24 edge coordinate system. */
  laneCenter: number;
  width: number;
  fastSlow: "FAST" | "SLOW" | null;
  differenceMs: number;
}

export interface RenderTitleIntroductionTheme {
  panelBackground: string;
  panelBorderColor: string;
  panelBorderWidthPx: number;
  fontFamilies: ReadonlyArray<string>;
  titleColor: string;
  artistColor: string;
  creditsColor: string;
  assets?: {
    /** Exact 1366x192 panel composite. Used unless an authored active-state mapping is supplied. */
    panelRibbonUrl?: string;
    /** Optional 1366x222 six-row composite retained for explicitly authored active states. */
    activeRibbonUrl?: string;
    normalHighScoreBaseUrl?: string;
    normalHighScoreBaseAlpha?: number;
    gekisouTitleUrl?: string;
    gekisouMissionUrls?: Readonly<Partial<Record<"combo" | "luck" | "just", string>>>;
    titleFont?: TmpSdfFontAssetManifest;
    numericFont?: TmpSdfFontAssetManifest;
  };
}

export interface RenderTitleIntroduction {
  title: string;
  artist?: string;
  lyricist?: string;
  composer?: string;
  arranger?: string;
  jacketUrl?: string;
  difficulty?: string;
  difficultyIconUrl?: string;
  level?: string | number;
  highScore?: number;
  ribbonVariant?: "panel" | "active";
  layoutMode?: "lightweight" | "normal";
  gekisou?: {
    enabled: boolean;
    performanceLabel?: string;
    missions?: ReadonlyArray<{
      label: string;
      kind?: "combo" | "luck" | "just";
      iconUrl?: string;
    }>;
  };
  /** Root CanvasGroup opacity sampled from the presentation timeline. */
  alpha: number;
  rootAlpha?: number;
  centerAlpha?: number;
  simpleAlpha?: number;
  leftAlpha?: number;
  rightAlpha?: number;
  /** Root-composited opacity of the centered song detail group. */
  contentAlpha?: number;
  theme?: Partial<RenderTitleIntroductionTheme>;
}

export interface RenderSkillBanner {
  id: string | number;
  text: string;
  color?: string;
  /** Renderer-owned image handle. */
  icon?: unknown;
  age?: number;
  lifetime?: number;
}

export interface RenderHudState {
  visible?: boolean;
  score?: number;
  scoreDelta?: number;
  combo?: number;
  /** Seconds since the current combo value was awarded. */
  comboAge?: number;
  perfectCombo?: boolean;
  /** Native whole-run FC state from the session snapshot. */
  fullCombo?: boolean;
  /** Native continuation tier display; false retains the Normal combo. */
  continuationEffects?: boolean;
  life?: number;
  maxLife?: number;
  rank?: string;
  rankProgress?: number;
  rankLabels?: ReadonlyArray<string>;
  judgement?: RenderJudgement;
  judgementAge?: number;
  fastSlow?: "FAST" | "SLOW" | null;
  differenceMs?: number;
  /** Active result views. Lane mode can display several simultaneous notes. */
  judgements?: ReadonlyArray<RenderJudgementInstance>;
  judgementPosition?: "center" | "lane" | "none";
  noteOverlapLaneBuffer?: number;
  showFastSlow?: boolean;
  showPerfectFastSlow?: boolean;
  showJudgeOffsetMs?: boolean;
  alwaysShowFastSlow?: boolean;
  /** Opening song-title presentation, composited above the gameplay HUD. */
  titleIntroduction?: RenderTitleIntroduction;
  skills?: ReadonlyArray<RenderSkillBanner>;
  showPause?: boolean;
}

export interface RenderStageState {
  laneOpacity?: number;
  guidelineOpacity?: number;
  judgementLineOpacity?: number;
  /** Resolved line count; the game's option profile owns its enum-to-count mapping. */
  guidelineCount?: number;
  backgroundBrightness?: number;
}

/** Texture transfer convention shared with the portable GeometryBuffer contract. */
export interface RenderOverlayTexture {
  url: string;
  origin: "top-left" | "bottom-left";
}

export interface RenderOverlayText {
  id: string;
  text: string;
  fontKey: string;
  /** Viewport pixels, top-left x/y and width/height. */
  bounds: readonly [number, number, number, number];
  fontSize: number;
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  color: readonly [number, number, number, number];
}

/** Final geometry; the presentation producer owns transforms, animation and colour policy. */
export interface RenderOverlaySprite {
  id: string;
  textureKey: string;
  /** Ten floats per vertex: clip xyzw, UV, Gamma RGBA. Preserve W for perspective interpolation. */
  vertices: ArrayLike<number>;
  indices: ArrayLike<number>;
  blend: "alpha" | "source-alpha-additive" | "additive";
  pass: "game" | "effects" | "underlay" | "screen";
  sortingOrder: number;
  material?: {
    shader: "mobile-add-hdr" | "texture-tint";
    tint: readonly [number, number, number, number];
    textureTransform: readonly [number, number, number, number];
  };
}

/** Render-only snapshot. It intentionally contains no gameplay state machine. */
export interface RenderFrame {
  time: number;
  deltaTime?: number;
  notes?: ReadonlyArray<RenderNote>;
  simultaneousLines?: ReadonlyArray<RenderSimultaneousLine>;
  holds?: ReadonlyArray<RenderHold>;
  particles?: ReadonlyArray<RenderParticleEffect>;
  hud?: RenderHudState;
  stage?: RenderStageState;
  overlays?: ReadonlyArray<RenderOverlaySprite>;
  overlayTexts?: ReadonlyArray<RenderOverlayText>;
}

export interface OurNotesRendererOptions<Canvas = unknown> {
  canvas: Canvas;
  /** Optional transparent 2D overlay; keeps high-density HUD out of WebGL. */
  hudCanvas?: Canvas;
  assets: OurNotesAssetManifest;
  overlayTextures?: Readonly<Record<string, RenderOverlayTexture>>;
  overlayFonts?: Readonly<Record<string, TmpSdfFontAssetManifest>>;
  laneCount?: number;
  stageWidth?: number;
  /** Native Unity +Z coordinate; StageProjector reflects it into Three -Z. */
  judgementZ?: number;
  /** Native Unity +Z coordinate; StageProjector reflects it into Three -Z. */
  horizonZ?: number;
  spawnY?: number;
  antialias?: boolean;
  alpha?: boolean;
  pixelRatio?: number;
  backgroundColor?: string | number;
  backgroundAlpha?: number;
  maxParticleEffects?: number;
  particlesPerEffect?: number;
}

export interface OurNotesRendererStats {
  notes: number;
  holds: number;
  particleEffects: number;
  drawCalls: number;
  triangles: number;
  activeNoteVisuals: number;
  activeHoldVisuals: number;
  renderedParticles: number;
  effectRefreshed: boolean;
  cachedSpriteTextureViews: number;
  assetsReady: boolean;
  contextLost: boolean;
}
