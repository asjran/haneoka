import type {
  Candidate,
  EvaluationBasisRequest,
  EvidenceGap,
  Objective,
  SongOption,
  TeamAssignment,
} from "../contracts";
import type { TeamBuilderData } from "../data";
import { validateAssignment, validateInventory, type Inventory } from "../inventory";
import { prepareSong } from "../song-metrics";
import { prepareEvaluationForSearch } from "../solver/evaluation";
import { unavailableMetric } from "../score";

export interface MetaReferenceIdentity {
  server: string;
  releaseId: string;
  sourceId: string;
}
export interface MetaReferenceProfile {
  profileId: string;
  profileVersion: number;
  identity: MetaReferenceIdentity;
  mode: "normal";
  eventId: null;
  judgement: "PERFECT";
  inventory: Inventory;
  assignment: TeamAssignment;
  basis: EvaluationBasisRequest;
}
export interface MetaReferenceChart {
  identity: MetaReferenceIdentity;
  song: SongOption;
}
const sameIdentity = (a: MetaReferenceIdentity, b: TeamBuilderData["identity"]) =>
  a.server === b.server && a.releaseId === b.releaseId && a.sourceId === b.sourceId;

/** Fixed public reference transport. All power, skills, node arithmetic and
 * denominators delegate to the same T18 evaluator used by the solver.
 */
export async function evaluateMetaReference(
  data: TeamBuilderData,
  profile: MetaReferenceProfile,
  charts: readonly MetaReferenceChart[],
  options: { signal?: AbortSignal; maxMilliseconds: number; calculatedAt?: string; progress?: () => void },
) {
  if (
    !profile.identity.sourceId ||
    !sameIdentity(profile.identity, data.identity) ||
    charts.some((chart) => !sameIdentity(chart.identity, data.identity))
  )
    throw new Error("Meta reference pin mismatch");
  if (
    !profile.profileId ||
    profile.profileId.length > 128 ||
    !Number.isSafeInteger(profile.profileVersion) ||
    profile.profileVersion < 1
  )
    throw new RangeError("meta-reference-profile-identity");
  if (profile.mode !== "normal" || profile.eventId !== null || profile.judgement !== "PERFECT" || !profile.basis)
    throw new RangeError("meta-reference-scenario");
  if (
    !Number.isFinite(options.maxMilliseconds) ||
    options.maxMilliseconds < 1 ||
    options.maxMilliseconds > 60000 ||
    charts.length > 1000
  )
    throw new RangeError("meta-reference-budget");
  const validation = validateInventory(profile.inventory, data);
  if (!validation.valid) throw new Error(`Invalid reference inventory:${validation.issues[0]?.path}`);
  const assignmentIssues = validateAssignment(profile.assignment, profile.inventory);
  if (assignmentIssues.length) throw new Error(`Invalid reference assignment:${assignmentIssues[0]?.code}`);
  if (profile.assignment.memberInstanceIds.length !== 5 || profile.assignment.snapshotInstanceIds.length !== 5)
    throw new RangeError("meta-reference-five-slots");
  const seen = new Set<string>();
  const songs: SongOption[] = [];
  for (const { song } of charts) {
    if (song.key !== `${song.songId}:${song.difficulty}` || song.events.length > 25000)
      throw new RangeError("meta-reference-chart-identity-or-size");
    if (seen.has(song.key)) throw new Error("Duplicate reference chart");
    seen.add(song.key);
    const rows = data.songs[String(song.songId)]?.difficulty;
    const difficulty = Array.isArray(rows)
      ? (rows.find(
          (row) => row && typeof row === "object" && (row as Record<string, unknown>).difficulty === song.difficulty,
        ) as Record<string, unknown> | undefined)
      : undefined;
    if (!difficulty || difficulty.scoreId !== song.scoreId || difficulty.playLevel !== song.playLevel)
      throw new Error(`Reference chart catalog mismatch:${song.key}`);
    const gaps = [...song.gaps],
      declared = difficulty.noteCount;
    if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 1)
      gaps.push({ code: "canonical-count-reference-missing", source: song.key });
    else if (song.events.length > 0 && declared !== song.events.length && !gaps.some((gap) => gap.code === "canonical-full-combo-mismatch"))
      gaps.push({ code: "canonical-full-combo-mismatch", source: song.key });
    songs.push({ ...song, gaps });
  }
  const objectives: Objective[] = profile.basis.kind === "single" ? ["score", "ss-ratio", "ss-surplus"] : ["score"];
  const assigned = new Set(profile.assignment.memberInstanceIds);
  const equipped = new Set(profile.assignment.snapshotInstanceIds.filter((id): id is string => id !== null));
  const prepared = prepareEvaluationForSearch({
    data,
    inventory: profile.inventory,
    songs,
    mode: profile.mode,
    objectives,
    basis: profile.basis,
    constraints: {
      teamSize: 5,
      lockedMemberIds: [],
      excludedMemberIds: profile.inventory.members
        .filter((member) => !assigned.has(member.instanceId))
        .map((member) => member.instanceId),
      lockedSnapshotIds: [],
      excludedSnapshotIds: profile.inventory.snapshots
        .filter((snapshot) => !equipped.has(snapshot.instanceId))
        .map((snapshot) => snapshot.instanceId),
      excludedSongKeys: [],
      excludeJustMissions: false,
      justRate: 0,
    },
    budget: { maxEvaluations: charts.length, maxMilliseconds: options.maxMilliseconds, maxCandidates: charts.length },
  });
  const started = performance.now();
  const controls = {
    cancelled: () => options.signal?.aborted ?? false,
    expired: () => performance.now() - started >= options.maxMilliseconds,
    progress: () => options.progress?.(),
    yield: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
  const results: {
    songId: number;
    scoreId: number;
    difficulty: number;
    facts: { nodes: number | null; convertedNoteCount: number | null; typeEligibleJust: number | null; skillTimesMs: number[] | null };
    candidate: Omit<Candidate, "vector">;
    quality: { status: "available" | "warning"; gaps: EvidenceGap[] };
  }[] = [];
  for (const chart of songs) {
    options.signal?.throwIfAborted();
    let song;
    try {
      song = prepareSong(chart, prepared.input.evaluation);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const gaps = [...chart.gaps, { code: "canonical-chart-unavailable", source: `${chart.key}/${error.message}` }];
      const metric = () => ({ ...unavailableMetric("canonical-chart-unavailable", chart.key), gaps: [...gaps] });
      results.push({
        songId: chart.songId,
        scoreId: chart.scoreId,
        difficulty: chart.difficulty,
        facts: { nodes: null, convertedNoteCount: null, typeEligibleJust: null, skillTimesMs: null },
        candidate: {
          assignment: structuredClone(profile.assignment),
          songKey: chart.key,
          metrics: {
            score: metric(), "ss-ratio": metric(), "ss-surplus": metric(),
            "base-score": metric(), "event-points": metric(), "event-items": metric(),
          },
        },
        quality: { status: "warning", gaps },
      });
      continue;
    }
    const candidate = await prepared.evaluate(profile.assignment, song, controls);
    const gaps = [...song.gaps, ...objectives.flatMap((objective) => candidate.metrics[objective].gaps)];
    const { vector: _vector, ...referenceCandidate } = candidate;
    results.push({
      songId: chart.songId,
      scoreId: chart.scoreId,
      difficulty: chart.difficulty,
      facts: {
        nodes: song.nodes.length,
        convertedNoteCount: song.convertedNoteCount,
        typeEligibleJust: song.justableCount,
        skillTimesMs: [...chart.skillTimesMs],
      },
      candidate: referenceCandidate,
      quality: { status: gaps.length ? "warning" : "available", gaps },
    });
  }
  return {
    schema: "haneoka-meta-reference-v1",
    identity: { ...profile.identity },
    reference: structuredClone(profile),
    calculation: {
      model: "native-normal-nominal-120-order-v1",
      entrypoint: "prepareEvaluationForSearch",
      mode: profile.mode,
      scoreKind: "native-personal-score",
      judgement: profile.judgement,
      objectives,
      basis: structuredClone(profile.basis),
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      calculatedAt: options.calculatedAt ?? new Date().toISOString(),
    },
    charts: results,
  };
}
