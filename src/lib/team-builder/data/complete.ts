import { objectRow } from "../data";

/** Recover omitted native fields from the same pinned entity, never a filename or another release. */
export async function hydrateRuntimeDocuments(
  input: Record<string, unknown>,
  readEntity: (resource: string, id: string) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const documents = { ...input };
  for (const resource of ["cards", "songs"]) {
    const rows = { ...objectRow(input[resource]) };
    const needs = Object.entries(rows).filter(([, value]) => {
      const row = objectRow(value),
        raw = objectRow(row.raw);
      return (
        !Array.isArray(row.bestMusicTagIds ?? raw._bestMusicTagIDs) ||
        (resource === "songs" &&
          Array.isArray(row.difficulty) &&
          row.difficulty.some((d) => !Number.isSafeInteger(objectRow(d).scoreId)))
      );
    });
    for (let start = 0; start < needs.length; start += 4) {
      signal?.throwIfAborted();
      const values = await Promise.all(
        needs.slice(start, start + 4).map(async ([id, value]) => {
          const detail = objectRow(await readEntity(resource, id));
          if (!Object.keys(detail).length) throw new Error(`Runtime entity missing:${resource}/${id}`);
          const row = { ...objectRow(value), ...detail },
            raw = objectRow(row.raw);
          const tags = row.bestMusicTagIds ?? raw._bestMusicTagIDs;
          if (Array.isArray(tags)) row.bestMusicTagIds = tags;
          if (resource === "songs" && Array.isArray(row.difficulty))
            row.difficulty = row.difficulty.map((value) => {
              const difficulty = { ...objectRow(value) };
              if (!Number.isSafeInteger(difficulty.scoreId)) {
                const name = difficulty.difficultyName;
                const foreign = typeof name === "string" ? raw[`_${name}ID`] : undefined;
                if (Number.isSafeInteger(foreign) && Number(foreign) > 0) difficulty.scoreId = foreign;
              }
              return difficulty;
            });
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
