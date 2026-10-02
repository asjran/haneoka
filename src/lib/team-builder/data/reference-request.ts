import type { ChartEvent, EvaluationBasisRequest, SearchConstraints, TeamAssignment } from "../contracts";
import { dataRows, objectRow, type MemberCatalog, type TeamBuilderData } from "../data";
import { validateAssignment, validateInventory, type Inventory } from "../inventory";
import type { MetaReferenceChart, MetaReferenceIdentity, MetaReferenceProfile } from "./meta-reference";

export interface TeamReferenceRecipe {
  schema: "haneoka-team-reference-recipe-v1";
  id: string;
  metadata: { kind: "fixed-reference"; playerAccount: false; server: string; version: number };
  validatedIdentity: MetaReferenceIdentity;
  mode: "normal";
  basis: EvaluationBasisRequest;
  inventory: Inventory;
  assignment: TeamAssignment;
  constraints: SearchConstraints;
  scenario: {
    judgement: "PERFECT"; justRate: 0; eventPowerEnabled: false; assistModeFactor: 1;
    memberOrder: "nominal-uniform-native-shuffle"; memberOrderCount: 120;
  };
  catalogBindings: (Pick<MemberCatalog, "id" | "characterId" | "bandId" | "attribute" | "liveSkillId" |
    "gekisoSkillId" | "leaderSkillId" | "levelGroup" | "trainingGroup" | "awakeningGroup"> & { instanceId: string })[];
}
export interface CanonicalReferenceChart {
  identity: MetaReferenceIdentity;
  events: ChartEvent[];
  canonicalNoteCount: number;
  durationMs: number;
  skillTimesMs: number[];
  feverRanges: { startTick: number; endTick: number }[];
}
const samePin = (a: MetaReferenceIdentity, b: TeamBuilderData["identity"]) =>
  a.server === b.server && a.releaseId === b.releaseId && a.sourceId === b.sourceId;
const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((child, index) => equal(child, b[index]));
  if (a && b && typeof a === "object" && typeof b === "object")
    return Object.keys(a).length === Object.keys(b).length &&
      Object.entries(b).every(([key, value]) => Object.hasOwn(a, key) && equal((a as Record<string, unknown>)[key], value));
  return a === b;
};

/** Bind explicit player values to the target catalogue after revalidation.
 * Canonical conversion and every calculation remain in their existing owners.
 */
export function materializeReferenceRequest(
  data: TeamBuilderData,
  recipe: TeamReferenceRecipe,
  canonical: ReadonlyMap<string, CanonicalReferenceChart | null>,
  options: { calculatedAt: string; maxMilliseconds: number },
) {
  const identity = data.identity as MetaReferenceIdentity;
  if (!identity.sourceId || !/^r-[a-f0-9]{20}$/u.test(identity.releaseId))
    throw new Error("reference-target-identity");
  if (recipe.schema !== "haneoka-team-reference-recipe-v1" || recipe.metadata.kind !== "fixed-reference" ||
      recipe.metadata.playerAccount !== false || recipe.metadata.server !== identity.server ||
      recipe.validatedIdentity.server !== identity.server || recipe.inventory.server !== identity.server ||
      recipe.inventory.releaseId !== recipe.validatedIdentity.releaseId)
    throw new Error("reference-recipe-server-or-schema");
  if (identity.server !== "intl" || !/^v\d+-c0b6a1541e45-/u.test(identity.sourceId) ||
      !/^v\d+-c0b6a1541e45-/u.test(recipe.validatedIdentity.sourceId))
    throw new Error("reference-native-source-unverified");
  if (recipe.mode !== "normal" || recipe.basis.kind !== "single" ||
      !equal(recipe.scenario, {
        judgement: "PERFECT", justRate: 0, eventPowerEnabled: false, assistModeFactor: 1,
        memberOrder: "nominal-uniform-native-shuffle", memberOrderCount: 120,
      }) || !equal(recipe.constraints, {
        lockedMemberIds: [], excludedMemberIds: [], lockedSnapshotIds: [], excludedSnapshotIds: [],
        excludedSongKeys: [], excludeJustMissions: false, justRate: 0, teamSize: 5,
      }))
    throw new Error("reference-explicit-scenario");
  if (!recipe.id || !Number.isSafeInteger(recipe.metadata.version) || recipe.metadata.version < 1)
    throw new Error("reference-recipe-identity");
  if (!Number.isFinite(Date.parse(options.calculatedAt)) || !/(?:Z|[+-]\d\d:\d\d)$/u.test(options.calculatedAt))
    throw new Error("reference-calculated-at");
  if (!Number.isFinite(options.maxMilliseconds) || options.maxMilliseconds < 1 || options.maxMilliseconds > 60000)
    throw new Error("reference-budget");
  if (data.runtimeRules?.status !== "ready" ||
      Object.values(data.runtimeRules.tables).some((table) => table.status === "missing"))
    throw new Error("reference-runtime-tables-unavailable");
  const inventory = structuredClone(recipe.inventory);
  inventory.releaseId = identity.releaseId;
  const checked = validateInventory(inventory, data, { requirePractice: true, requireModifiers: true });
  if (!checked.valid) throw new Error(`reference-recipe-incompatible:${checked.issues[0]?.path}/${checked.issues[0]?.code}`);
  const issues = validateAssignment(recipe.assignment, inventory);
  if (issues.length || recipe.assignment.memberInstanceIds.length !== 5 || recipe.assignment.snapshotInstanceIds.length !== 5)
    throw new Error("reference-recipe-assignment");
  if (recipe.catalogBindings.length !== inventory.members.length ||
      new Set(recipe.catalogBindings.map((binding) => binding.instanceId)).size !== inventory.members.length)
    throw new Error("reference-recipe-bindings");
  for (const state of inventory.members) {
    const binding = recipe.catalogBindings.find((binding) => binding.instanceId === state.instanceId);
    const card = data.members[String(state.cardId)]!;
    if (!binding || binding.id !== state.cardId) throw new Error(`reference-recipe-binding-missing:${state.instanceId}`);
    for (const [field, value] of Object.entries(binding))
      if (field !== "instanceId" && card[field as keyof MemberCatalog] !== value)
        throw new Error(`reference-recipe-binding-changed:${state.instanceId}/${field}`);
    if (!data.characters[String(card.characterId)] || !data.bands[String(card.bandId)] || card.bestMusicTagIds === null)
      throw new Error(`reference-recipe-card-relations:${state.instanceId}`);
    for (const [group, id] of [["live", card.liveSkillId], ["gekiso", card.gekisoSkillId], ["leader", card.leaderSkillId]] as const)
      if (id > 0 && !data.skills[group]?.[String(id)]) throw new Error(`reference-recipe-skill-missing:${state.instanceId}/${group}`);
  }
  const charts: MetaReferenceChart[] = [];
  const seen = new Set<string>();
  for (const [id, row] of Object.entries(data.songs)) {
    const songId = Number(id);
    if (!Number.isSafeInteger(songId) || songId < 1 || !Array.isArray(row.difficulty))
      throw new Error(`reference-song-catalogue:${id}`);
    const missions = objectRow(row.gekisou).missionTypes;
    for (const difficulty of dataRows(row.difficulty)) {
      const scoreId = difficulty.scoreId as number, level = difficulty.playLevel as number, index = difficulty.difficulty as number;
      const key = `${songId}:${index}`;
      if (!Number.isSafeInteger(scoreId) || scoreId < 1 || !Number.isSafeInteger(index) || index < 0 ||
          !Number.isSafeInteger(level) || level < 1 || seen.has(key)) throw new Error(`reference-difficulty-catalogue:${key}`);
      seen.add(key);
      if (!canonical.has(key)) throw new Error(`reference-chart-read-not-attempted:${key}`);
      const converted = canonical.get(key);
      if (converted && !samePin(converted.identity, identity)) throw new Error(`reference-canonical-pin:${key}`);
      const gaps = converted ? [] : [{ code: "canonical-chart-missing", source: key }];
      if (converted && (converted.events.length > 25000 || converted.canonicalNoteCount !== converted.events.length))
        throw new Error(`reference-canonical-count-or-size:${key}`);
      const declared = difficulty.noteCount;
      if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 1)
        gaps.push({ code: "canonical-count-reference-missing", source: key });
      else if (converted && declared !== converted.events.length)
        gaps.push({ code: "canonical-full-combo-mismatch", source: key });
      charts.push({
        identity: { ...identity },
        song: {
          key, songId, scoreId, difficulty: index, playLevel: level,
          durationMs: converted?.durationMs ?? 0,
          events: converted?.events ?? [], skillTimesMs: converted?.skillTimesMs ?? [],
          segments: converted?.feverRanges.map((range, index) => ({
            ...range, mission: Array.isArray(missions) && typeof missions[index] === "number" ? missions[index] : 0,
          })) ?? [], gaps,
        },
      });
    }
  }
  if (!charts.length || charts.length > 1000 || canonical.size !== charts.length)
    throw new Error("reference-catalogue-coverage");
  const profile: MetaReferenceProfile = {
    profileId: recipe.id, profileVersion: recipe.metadata.version, identity: { ...identity },
    mode: recipe.mode, eventId: null, judgement: recipe.scenario.judgement,
    inventory, assignment: structuredClone(recipe.assignment), basis: structuredClone(recipe.basis),
  };
  return {
    schema: "haneoka-meta-reference-request-v1", data, profile, charts,
    calculatedAt: options.calculatedAt, maxMilliseconds: options.maxMilliseconds,
    materialization: {
      schema: "haneoka-meta-reference-materialization-v1", identity: { ...identity },
      recipeValidatedIdentity: { ...recipe.validatedIdentity }, revalidatedAgainstTarget: true,
      chartConverter: "scripts/build/song_metrics.ts", durationKind: "last-judged-node",
      catalogueDifficulties: charts.length, missingCanonicalCharts: charts.filter((chart) => !chart.song.events.length).length,
    },
  };
}
