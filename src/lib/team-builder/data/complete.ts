import { objectRow, type DataRow } from "../data";

const SONG_GROUP_FIELDS = ["liveScoreRankGroup", "scoreRankRewardGroup", "comboRewardGroup"] as const;
function completeLocalRow(resource: string, value: unknown): DataRow {
  const row = { ...objectRow(value) },
    raw = objectRow(row.raw);
  const tags = row.bestMusicTagIds ?? raw._bestMusicTagIDs;
  if (Array.isArray(tags)) row.bestMusicTagIds = tags;
  if (resource === "songs") {
    for (const field of SONG_GROUP_FIELDS)
      if (row[field] === undefined && Number.isSafeInteger(raw[`_${field}`])) row[field] = raw[`_${field}`];
    if (Array.isArray(row.difficulty))
      row.difficulty = row.difficulty.map((value) => {
        const difficulty = { ...objectRow(value) };
        if (!Number.isSafeInteger(difficulty.scoreId)) {
          const name = difficulty.difficultyName;
          const foreign = typeof name === "string" ? raw[`_${name}ID`] : undefined;
          if (Number.isSafeInteger(foreign) && Number(foreign) > 0) difficulty.scoreId = foreign;
        }
        return difficulty;
      });
  }
  return row;
}

/** Recover omitted native fields from the same pinned entity, never a filename or another release. */
export async function hydrateRuntimeDocuments(
  input: Record<string, unknown>,
  readEntity: (resource: string, id: string) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const documents = { ...input };
  for (const resource of ["cards", "support-cards", "songs"]) {
    const rows = Object.fromEntries(
      Object.entries(objectRow(input[resource])).map(([id, value]) => [id, completeLocalRow(resource, value)]),
    );
    const needs = Object.entries(rows).filter(([, value]) => {
      const row = objectRow(value);
      if (resource === "support-cards") {
        const raw = objectRow(row.raw);
        return ["supportSkillId01", "supportSkillId02", "gekisouSupportSkillId01", "gekisouSupportSkillId02"].some(
          (field) => !Number.isSafeInteger(row[field] ?? raw[`_${field}`]),
        );
      }
      return (
        !Array.isArray(row.bestMusicTagIds) ||
        (resource === "songs" &&
          (SONG_GROUP_FIELDS.some((field) => !Number.isSafeInteger(row[field])) ||
            (Array.isArray(row.difficulty) && row.difficulty.some((d) => !Number.isSafeInteger(objectRow(d).scoreId)))))
      );
    });
    for (let start = 0; start < needs.length; start += 4) {
      signal?.throwIfAborted();
      const values = await Promise.all(
        needs.slice(start, start + 4).map(async ([id, value]) => {
          const detail = objectRow(await readEntity(resource, id));
          if (!Object.keys(detail).length) throw new Error(`Runtime entity missing:${resource}/${id}`);
          const row = completeLocalRow(resource, { ...objectRow(value), ...detail });
          return [id, row] as const;
        }),
      );
      signal?.throwIfAborted();
      for (const [id, value] of values) rows[id] = value;
    }
    documents[resource] = rows;
  }
  return documents;
}
