import { nativeRow, objectRow, dataRows, type DataRow, type TeamBuilderData } from "../data";

export const RUNTIME_MASTER_TABLES = {
  vipRanks: "MasterVip",
  vipRankBonuses: "MasterVipRankBonus",
  memoryMemberLevels: "MasterMemoryMemberLevel",
  memorySupportLevels: "MasterMemorySupportLevel",
  memoryMusic: "MasterMemoryMusic",
  memoryMusicBonuses: "MasterMemoryMusicBonus",
  memoryMusicGroups: "MasterMemoryMusicGroup",
} as const;
export interface RuntimeRuleTable {
  sourceTable: string;
  status: "ready" | "empty" | "missing";
  rows: DataRow[];
}
export interface RuntimeRules {
  schema: "haneoka-team-runtime-rules-v1";
  status: "ready" | "unavailable" | "source-unverified";
  tables: Record<keyof typeof RUNTIME_MASTER_TABLES, RuntimeRuleTable>;
}
export function adaptRuntimeRules(identity: TeamBuilderData["identity"], value: unknown): RuntimeRules {
  const document = objectRow(value);
  if (
    Object.keys(document).length &&
    (document.schema !== "haneoka-team-runtime-rules-v1" ||
      document.server !== identity.server ||
      (identity.sourceId && document.sourceId !== identity.sourceId))
  )
    throw new Error("Runtime rules identity mismatch");
  const input = objectRow(document.tables),
    tables = {} as RuntimeRules["tables"];
  for (const [key, sourceTable] of Object.entries(RUNTIME_MASTER_TABLES)) {
    const table = objectRow(input[key]),
      rows = dataRows(table.rows).map(nativeRow);
    if (
      Object.keys(table).length &&
      (table.sourceTable !== sourceTable || !["ready", "empty", "missing"].includes(String(table.status)))
    )
      throw new Error("Runtime rules table identity mismatch");
    const status = table.status === "ready" ? "ready" : table.status === "empty" ? "empty" : "missing";
    if ((status === "ready" && !rows.length) || (status !== "ready" && rows.length))
      throw new Error("Runtime rules table status mismatch");
    tables[key as keyof typeof RUNTIME_MASTER_TABLES] = { sourceTable, status, rows };
  }
  return {
    schema: "haneoka-team-runtime-rules-v1",
    status: !Object.keys(document).length ? "unavailable" : !identity.sourceId ? "source-unverified" : "ready",
    tables,
  };
}
