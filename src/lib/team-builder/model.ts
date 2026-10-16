/** Serializable inputs shared by the inventory adapter, solver worker and UI. */
export interface ReleaseIdentity {
  server: string;
  releaseId: string;
  /** Source producer's related-method/ABI/selected-patch audit, independent of resource release. */
  nativeRuleEvidence?: NativeRuleEvidence;
}

export type NativeRuleDomain =
  "normal-score" | "personal-solo" | "ordinary-event-points" | "snapshot-equip" | "challenge-context";

export interface NativeRuleEvidence {
  schema: "haneoka-native-rule-evidence-v1";
  sourceId: string;
  /** Hashes identify the audited rule inputs; package version is provenance, not the rule selector. */
  nativeFiles: { il2cpp: string; metadata: string; loader: string };
  selectedPatches: { address: string; sha256: string | null }[];
  patchSelection: "complete" | "unresolved";
  domains: Partial<
    Record<
      NativeRuleDomain,
      {
        profile: string;
        methodFingerprint: string;
        abiFingerprint: string;
        callGraph: "reviewed" | "unresolved";
        patchCoverage: "disjoint" | "equivalent" | "unresolved";
      }
    >
  >;
}

export interface EvidenceGap {
  code: string;
  source: string;
}

export interface PowerStats {
  performance: number;
  technique: number;
  visual: number;
}

export interface TeamAssignment {
  memberInstanceIds: string[];
  /** Each index equips the corresponding member; null is an empty slot. */
  snapshotInstanceIds: (string | null)[];
  leaderInstanceId: string;
}
