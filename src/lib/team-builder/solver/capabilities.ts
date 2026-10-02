import type { Objective, PlayMode, ReleaseIdentity, TeamBuilderCapabilities } from "../contracts.ts";

/** Factory capabilities are declared where native input paths are implemented.
 * UI reads this list instead of maintaining its own supported-target table.
 */
export function getTeamBuilderCapabilities(identity: ReleaseIdentity): TeamBuilderCapabilities {
  const modes: PlayMode[] = ["normal", "gekiso", "multi", "battle"];
  const objectives: Objective[] = ["score", "ss-ratio", "ss-surplus", "event-points", "event-items", "base-score"];
  return {
    ...identity,
    targets: modes.flatMap((mode) =>
      objectives.map((objective) => {
        const normalForecast = mode === "normal" && ["score", "ss-ratio", "ss-surplus"].includes(objective);
        const gekisoSolo = mode === "gekiso" && ["ss-ratio", "ss-surplus"].includes(objective);
        const supported =
          identity.server === "intl" &&
          ((mode === "normal" && (objective === "base-score" || normalForecast)) || gekisoSolo);
        const code =
          identity.server !== "intl"
            ? "native-server-rules-unverified"
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
            supported && (normalForecast || gekisoSolo)
              ? [
                  "native-normal-five-members",
                  "native-normal-same-member-duration-supports",
                  "native-normal-basic-live-skills",
                  "native-normal-non-event",
                  "native-normal-nominal-shuffle-mean",
                  ...(gekisoSolo ? ["native-gekiso-personal-solo-perfect-timing"] : []),
                ]
              : undefined,
        };
      }),
    ),
  };
}
