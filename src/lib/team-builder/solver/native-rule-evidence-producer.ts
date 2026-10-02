import type { NativeRuleEvidence } from "../contracts.ts";
import { bindNativeRuleEvidenceToSource } from "./native-rule-profile.ts";

export interface NativePatchLocatorObservation {
  sourceId: string;
  locatorId: string;
  sha256: string;
  /** Every required address has a measured result. [] is a checked absence;
   * a missing key is an incomplete query. Hashes are decoded TextAsset programs.
   */
  queries: Record<string, readonly { programSha256: string }[]>;
}
export interface NativeRuleSourceObservation {
  sourceId: string;
  applicationVersion: string;
  nativeFiles: NativeRuleEvidence["nativeFiles"];
  /** All initial, selected remote and selected locale locators are included. */
  locatorSet: "complete" | "unresolved";
  locators: readonly NativePatchLocatorObservation[];
}
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Producer for the audited app-version/Emb-fallback loader. Measurements come
 * from source assets or reusable CAS receipts, independent of resource release.
 * It never selects a program from a catalog's unrelated downloadable versions.
 */
export function produceNativeRuleEvidence(
  audit: NativeRuleEvidence,
  observed: NativeRuleSourceObservation,
): NativeRuleEvidence | null {
  if (!audit || !Array.isArray(audit.selectedPatches)) return null;
  if (
    !observed ||
    observed.locatorSet !== "complete" ||
    !Array.isArray(observed.locators) ||
    !observed.locators.length ||
    !/^\d+(?:\.\d+)*$/u.test(observed.applicationVersion)
  )
    return null;
  if (
    observed.locators.some(
      (locator) =>
        locator.sourceId !== observed.sourceId || !locator.locatorId || !sha256(locator.sha256) || !locator.queries,
    ) ||
    new Set(observed.locators.map((locator) => locator.locatorId)).size !== observed.locators.length
  )
    return null;
  const assemblies = [
    ...new Set(
      audit.selectedPatches.map((patch) => /^(?:Emb)?Patch\/(.+)\.patch-\d+(?:\.\d+)*$/u.exec(patch.address)?.[1]),
    ),
  ];
  if (!assemblies.length || assemblies.some((assembly) => !assembly)) return null;
  const selectedPatches: NativeRuleEvidence["selectedPatches"] = [];
  const lookup = (address: string): string | null | undefined => {
    const programs: string[] = [];
    for (const locator of observed.locators) {
      const rows = locator.queries[address];
      if (!Array.isArray(rows) || rows.some((row) => !sha256(row?.programSha256))) return undefined;
      programs.push(...rows.map((row) => row.programSha256));
    }
    const unique = [...new Set(programs)];
    // Different programs under one address need actual locator selection evidence.
    return unique.length > 1 ? undefined : (unique[0] ?? null);
  };
  for (const assembly of assemblies) {
    const address = `Patch/${assembly}.patch-${observed.applicationVersion}`;
    const program = lookup(address);
    if (program === undefined) return null;
    selectedPatches.push({ address, sha256: program });
    if (program === null) {
      const fallback = `Emb${address}`,
        fallbackProgram = lookup(fallback);
      if (fallbackProgram === undefined) return null;
      selectedPatches.push({ address: fallback, sha256: fallbackProgram });
    }
  }
  return bindNativeRuleEvidenceToSource(audit, {
    sourceId: observed.sourceId,
    nativeFiles: observed.nativeFiles,
    selectedPatches,
    patchSelection: "complete",
  });
}
