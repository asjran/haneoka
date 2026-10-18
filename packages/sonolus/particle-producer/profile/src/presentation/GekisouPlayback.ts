import type { ChartDocument, SessionOptions } from "@haneoka/cassiopeia";
import type { RenderFrameBuilderOptions } from "../adapter/renderFrame.js";
import type { RenderFrame, RenderOverlayTexture } from "../render/types.js";
import { OurNotesGekisouPlan, type OurNotesGekisouConfiguration } from "./Gekisou.js";
import { OurNotesGekisouOverlayProjector } from "./GekisouOverlay.js";
import { OurNotesGekisouStageProjector } from "./GekisouStageProjector.js";
import type { OurNotesGekisouEffectMode, OurNotesGekisouEffectProfile } from "./GekisouStage.js";
import { createOurNotesAutomaticPolicy, createOurNotesSessionOptions } from "./ScoringPolicy.js";
import type { OurNotesAssetResolver } from "../assets/manifest.js";

export function ourNotesPresentationResourceUrl(resolver: OurNotesAssetResolver, path: string): string {
  if (path.startsWith("assets/")) return resolver.asset(path.slice("assets/".length));
  if (path.startsWith("runtime/")) return resolver.runtime(path.slice("runtime/".length));
  throw new Error(`presentation-resource-kind:${path}`);
}

export function ourNotesGekisouTextures(
  source: OurNotesGekisouEffectProfile,
  resolve: (path: string) => string,
): Record<string, RenderOverlayTexture> {
  return {
    ...new OurNotesGekisouOverlayProjector().textures(resolve),
    ...new OurNotesGekisouStageProjector(source, [], () => 1).textures(resolve),
  };
}

export interface OurNotesGekisouPlaybackConfiguration extends OurNotesGekisouConfiguration {
  readonly effectMode?: OurNotesGekisouEffectMode;
  readonly lightweightMode?: boolean;
  readonly displayPositionChanged?: boolean;
  readonly small?: boolean;
  readonly displayScale?: number;
}

/** Source rules and presentation shared by browser shells and renderer backends. */
export class OurNotesGekisouPlayback {
  readonly plan?: OurNotesGekisouPlan;
  readonly context = {
    width: 1,
    height: 1,
    worldToClip: new Float64Array(16),
    displayPositionChanged: false,
    small: undefined as boolean | undefined,
    displayScale: undefined as number | undefined,
  };
  private readonly hud?: OurNotesGekisouOverlayProjector;
  private stage?: OurNotesGekisouStageProjector;

  constructor(
    chart: ChartDocument,
    readonly configuration: OurNotesGekisouPlaybackConfiguration | undefined,
    private readonly nextLifecycleSeed: () => number,
  ) {
    if (!configuration?.enabled) return;
    this.plan = new OurNotesGekisouPlan(chart, configuration);
    this.hud = new OurNotesGekisouOverlayProjector();
    this.context.displayPositionChanged = configuration.displayPositionChanged ?? false;
    this.context.small = configuration.small;
    this.context.displayScale = configuration.displayScale;
  }

  sessionOptions(options: SessionOptions): SessionOptions {
    return this.plan
      ? createOurNotesSessionOptions({ ...options, automaticPolicy: createOurNotesAutomaticPolicy(this.plan) })
      : options;
  }

  frameBuilderOptions(): Pick<RenderFrameBuilderOptions, "gekisou" | "gekisouPresentation"> {
    return this.plan && this.hud
      ? { gekisou: this.plan, gekisouPresentation: { projector: this.hud, context: this.context } }
      : {};
  }

  setSource(source: OurNotesGekisouEffectProfile): void {
    this.stage = this.plan
      ? new OurNotesGekisouStageProjector(source, this.plan.ranges, this.nextLifecycleSeed)
      : undefined;
  }

  textures(resolve: (path: string) => string): Record<string, RenderOverlayTexture> {
    return { ...this.hud?.textures(resolve), ...this.stage?.textures(resolve) };
  }

  appendStage(frame: RenderFrame, sampledTimeMs: number): RenderFrame {
    if (this.stage)
      frame.overlays = [
        ...(frame.overlays ?? []),
        ...this.stage.project(
          {
            timeMs: sampledTimeMs,
            mode: this.configuration?.effectMode,
            lightweightMode: this.configuration?.lightweightMode,
          },
          this.context,
        ),
      ];
    return frame;
  }
}
