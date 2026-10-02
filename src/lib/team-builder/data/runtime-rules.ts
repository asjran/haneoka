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
export type RuntimeRulesIdentity = TeamBuilderData["identity"] & { sourceId: string };
export type RuntimeMasterReader = (identity: RuntimeRulesIdentity, sourceTable: string) => Promise<unknown | null>;

/** The transport owner reads only these tables from the already observed pin. */
export async function readRuntimeRulesDocument(identity: RuntimeRulesIdentity, read: RuntimeMasterReader) {
  const pin = Object.freeze({ ...identity });
  const tables: Record<string, RuntimeRuleTable> = {};
  const entries = Object.entries(RUNTIME_MASTER_TABLES);
  for (let start = 0; start < entries.length; start += 4) {
    const batch = await Promise.all(
      entries.slice(start, start + 4).map(async ([key, sourceTable]): Promise<readonly [string, RuntimeRuleTable]> => {
        const document = await read(pin, sourceTable);
        if (document === null) return [key, { sourceTable, status: "missing", rows: [] }];
        const raw = objectRow(document)._allData;
        if (!Array.isArray(raw) || raw.some((row) => !row || typeof row !== "object" || Array.isArray(row)))
          throw new Error(`Runtime Master table malformed:${sourceTable}`);
        const rows = raw.map((row) => nativeRow({ raw: row }));
        return [key, { sourceTable, status: rows.length ? "ready" : "empty", rows }];
      }),
    );
    for (const [key, table] of batch) tables[key] = table;
  }
  return { schema: "haneoka-team-runtime-rules-v1", ...pin, tables };
}
export function adaptRuntimeRules(identity: TeamBuilderData["identity"], value: unknown): RuntimeRules {
  const document = objectRow(value);
  if (
    Object.keys(document).length &&
    (document.schema !== "haneoka-team-runtime-rules-v1" ||
      document.server !== identity.server ||
      (document.releaseId !== undefined && document.releaseId !== identity.releaseId) ||
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
    status: !Object.keys(document).length
      ? "unavailable"
      : !identity.sourceId || !document.releaseId
        ? "source-unverified"
        : "ready",
    tables,
  };
}
