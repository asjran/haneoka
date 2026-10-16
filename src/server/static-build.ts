/** Build complete page families independently without blocking other releases. */
export function staticPageGroupEnabled(group: "provider" | "assets"): boolean {
  const groups = (process.env.STATIC_PAGE_GROUPS || "all").split(",").map((value) => value.trim());
  if (groups.some((value) => !["all", "core", "provider", "assets"].includes(value)))
    throw new Error("STATIC_PAGE_GROUPS must contain core, provider, assets, or all");
  return groups.includes("all") || groups.includes(group);
}
