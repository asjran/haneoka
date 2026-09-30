type Row = Record<string, unknown>;

/** Backfill the event illustration and title logo from complete entity records. */
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
    if (typeof row.logo === "string" && row.logo && typeof row.backgroundImage === "string" && row.backgroundImage)
      continue;
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
      const source = entity as Row;
      const logo = source.logo;
      const backgroundImage = source.backgroundImage || source.image;
      output[id] = {
        ...row,
        ...(typeof logo === "string" && logo ? { logo } : {}),
        ...(typeof backgroundImage === "string" && backgroundImage ? { backgroundImage } : {}),
      };
    }
  }
  return { ...document, entries: output };
}
