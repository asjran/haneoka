type Row = Record<string, unknown>;

/** Backfill title logos from the entity shards of releases with older indexes. */
export async function eventArtworkIndex(
  document: Row,
  shardFor: (id: string) => string,
  readShard: (id: string) => Promise<Row | null>,
): Promise<Row> {
  const entries = document.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return document;
  const output = { ...(entries as Row) };
  const groups = new Map<string, Array<[string, Row]>>();
  for (const [id, value] of Object.entries(output)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Row;
    if (typeof row.logo === "string" && row.logo) continue;
    const shard = shardFor(id);
    const group = groups.get(shard) || [];
    group.push([id, row]);
    groups.set(shard, group);
  }
  for (const group of groups.values()) {
    const shard = await readShard(group[0]![0]);
    for (const [id, row] of group) {
      const entity = shard?.[id];
      if (!entity || typeof entity !== "object" || Array.isArray(entity)) continue;
      const logo = (entity as Row).logo;
      if (typeof logo === "string" && logo) output[id] = { ...row, logo };
    }
  }
  return { ...document, entries: output };
}
