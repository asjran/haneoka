import type { NativeRuleDomain, NativeRuleEvidence } from "../contracts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const domains: NativeRuleDomain[] = ["normal-score", "personal-solo", "ordinary-event-points", "snapshot-equip", "challenge-context"];

/** Transport validation preserves pending facts. Eligibility is decided only by T18's resolver. */
export function parseNativeRuleEvidence(value: unknown, sourceId: string | undefined): NativeRuleEvidence | undefined {
  if (value === null || value === undefined) return undefined;
  if (!object(value) || value.schema !== "haneoka-native-rule-evidence-v1" || !sourceId || value.sourceId !== sourceId)
    throw new Error("Native rule evidence source identity mismatch");
  if (!object(value.nativeFiles) || Object.keys(value.nativeFiles).length !== 3 ||
      !["il2cpp", "metadata", "loader"].every((key) => sha256(value.nativeFiles && (value.nativeFiles as Record<string, unknown>)[key])))
    throw new Error("Native rule file evidence malformed");
  if (!["complete", "unresolved"].includes(String(value.patchSelection)) || !Array.isArray(value.selectedPatches) ||
      value.selectedPatches.length > 64 || value.selectedPatches.some((patch) => !object(patch) ||
        typeof patch.address !== "string" || !patch.address || patch.address.length > 256 ||
        (patch.sha256 !== null && !sha256(patch.sha256))))
    throw new Error("Native rule patch evidence malformed");
  if (!object(value.domains) || Object.entries(value.domains).some(([domain, rule]) =>
    !domains.includes(domain as NativeRuleDomain) || !object(rule) || typeof rule.profile !== "string" || !rule.profile ||
    !sha256(rule.methodFingerprint) || !sha256(rule.abiFingerprint) ||
    !["reviewed", "unresolved"].includes(String(rule.callGraph)) ||
    !["disjoint", "equivalent", "unresolved"].includes(String(rule.patchCoverage))))
    throw new Error("Native rule domain evidence malformed");
  return structuredClone(value) as unknown as NativeRuleEvidence;
}

export function withNativeRuleEvidence<T extends { sourceId?: string; nativeRuleEvidence?: NativeRuleEvidence }>(
  identity: T, observed: unknown = identity.nativeRuleEvidence,
): T {
  const evidence = parseNativeRuleEvidence(observed, identity.sourceId);
  const next = { ...identity };
  delete next.nativeRuleEvidence;
  if (evidence) next.nativeRuleEvidence = evidence;
  return next;
}
