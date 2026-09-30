const MISSIONS = {
  Combo: { key: "gekisouMissionCombo", fallback: "COMBO", icon: "combo" },
  Luck: { key: "gekisouMissionLuck", fallback: "LUCK", icon: "luck" },
  JustCount: { key: "gekisouMissionJustCount", fallback: "JUST", icon: "just" },
} as const;

export function gekisouMission(value: unknown) {
  const numeric = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  const name = Number.isInteger(numeric) ? ["", "Combo", "Luck", "JustCount"][numeric] : String(value || "");
  return MISSIONS[name as keyof typeof MISSIONS];
}

/** Cropped sprites from the live atlas, addressed by authored logical name. */
export function gekisouMissionIcons(value: unknown, server: string): Record<string, string> {
  const descriptor = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const outputs = Array.isArray(descriptor.outputs) ? descriptor.outputs : [];
  const icons: Record<string, string> = {};
  for (const value of outputs) {
    if (!value || typeof value !== "object") continue;
    const output = value as Record<string, unknown>;
    const path = String(output.path || "");
    const match =
      /^runtime\/unity\/Assets\/AddressableResources\/Live\/Images\/Atlas\/LiveAtlas\.spriteatlasv2\/Icon_gekisou_(combo|luck|just)--Sprite-?-?\d+\.png$/u.exec(
        path,
      );
    if (output.type === "Sprite" && match) icons[match[1]!] = `/runtime/${server}/${path.slice("runtime/".length)}`;
  }
  return icons;
}
