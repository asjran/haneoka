import type { Objective, PlayMode, ReleaseIdentity, TeamBuilderCapabilities } from "../contracts.ts";

/** Factory capabilities are declared where native input paths are implemented.
 * UI reads this list instead of maintaining its own supported-target table.
 */
export function getTeamBuilderCapabilities(identity: ReleaseIdentity & { sourceId?: string }): TeamBuilderCapabilities {
  const modes: PlayMode[] = ["normal", "gekiso", "multi", "battle"];
  const objectives: Objective[] = ["score", "ss-ratio", "ss-surplus", "event-points", "event-items", "base-score"];
  const nativeSourceKnown = identity.server === "intl" && /^v\d+-c0b6a1541e45-/u.test(identity.sourceId ?? "");
  return {
    ...identity,
    targets: modes.flatMap((mode) =>
      objectives.map((objective) => {
        const normalForecast = mode === "normal" && ["score", "ss-ratio", "ss-surplus"].includes(objective);
        const gekisoSolo = mode === "gekiso" && ["ss-ratio", "ss-surplus"].includes(objective);
        const eventPoints =
          (mode === "normal" || mode === "gekiso") && objective === "event-points" && nativeSourceKnown;
        const supported =
          identity.server === "intl" &&
          ((mode === "normal" && objective === "base-score") ||
            (nativeSourceKnown && (normalForecast || gekisoSolo || eventPoints)));
        const code =
          identity.server !== "intl"
            ? "native-server-rules-unverified"
            : !nativeSourceKnown && objective !== "base-score"
              ? "native-source-unverified"
              : objective.startsWith("event-")
                ? "event-reward-runtime-factory-unresolved"
                : objective === "ss-surplus" || objective === "ss-ratio"
                  ? "personal-ss-runtime-context-unresolved"
                  : "full-power-and-skill-runtime-factory-unresolved";
        return {
          mode,
          objective,
          supported,
          bases:
            objective === "ss-surplus" || objective === "ss-ratio"
              ? ["single" as const]
              : ["single" as const, "time" as const, "consumption" as const],
          gaps: supported ? [] : [{ code, source: "same-release native runtime factory" }],
          conditions:
            supported && (normalForecast || gekisoSolo || eventPoints)
              ? [
                  "native-normal-five-members",
                  "native-normal-same-member-duration-supports",
                  "native-normal-basic-live-skills",
                  ...(eventPoints
                    ? [
                        "native-explicit-single-held-event",
                        "native-personal-solo-event-rank",
                        "native-observed-or-identified-live-start",
                        "native-configured-event-consumption",
                        "native-ordinary-live-event-scene",
                      ]
                    : ["native-normal-non-event-or-explicit-event-scene"]),
                  "native-normal-nominal-shuffle-mean",
                  ...(gekisoSolo || (eventPoints && mode === "gekiso")
                    ? ["native-gekiso-personal-solo-perfect-timing"]
                    : []),
                ]
              : undefined,
        };
      }),
    ),
  };
}
