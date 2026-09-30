#!/usr/bin/env node

// Build one Sonolus effect pack per note-SE group.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  OUR_NOTES_NOTE_SE_CUES,
  OUR_NOTES_NOTE_SE_GROUP_IDS,
  OUR_NOTES_NOTE_SE_TYPE_IDS,
  OUR_NOTES_NOTE_SE_TYPE_NAMES,
  ourNotesNoteSoundsForRelease,
  type OurNotesNoteSeGroup,
  type OurNotesNoteSeType,
} from "@haneoka/cassiopeia-plugin-our-notes";
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";
import { validateSonolusInputProvenance } from "../src/server/sonolusProvenance.ts";

const root = resolve(process.env.OUR_NOTES_ROOT || process.cwd());
const releaseServer = process.env.RELEASE_SERVER || "intl";
const workspace = resolveSonolusReleaseWorkspace(releaseServer, root);
const inputProvenance = validateSonolusInputProvenance(workspace, root);
const source = resolve(workspace.runtimeRoot, "note-se");
const output = resolve(process.env.SONOLUS_ORIGINAL_ASSETS_DIR || resolve(root, "packages/sonolus/assets/original"));
const ffmpeg = process.env.FFMPEG || "ffmpeg";
const cri = JSON.parse(readFileSync(resolve(workspace.metadataRoot, "cri.json"), "utf8")) as {
  entries: Array<{ runtimePath?: string; semanticDecodeProfile?: string }>;
};
const noteEntries = cri.entries.filter((entry) => entry.runtimePath === "note-se");
if (
  !noteEntries.length ||
  noteEntries.some((entry) => entry.semanticDecodeProfile !== "note-se-original-stream-once-v1")
) {
  throw new Error("Rebuild the native note-SE resource stage before publishing the sound packs");
}

const STANDARD_CLIPS: readonly (readonly [name: string, type: OurNotesNoteSeType])[] = [
  ["#PERFECT", 4],
  ["#GREAT", 3],
  ["#GOOD", 2],
  ["#HOLD", 7],
  ["#PERFECT_ALTERNATIVE", 5],
  ["#GREAT_ALTERNATIVE", 3],
  ["#GOOD_ALTERNATIVE", 2],
  ["#HOLD_ALTERNATIVE", 7],
  ["#STAGE", 1],
  ["Our Notes Just", 8],
  ["Our Notes Tick", 9],
  ["Our Notes Trace", 9],
  ["Our Notes Critical Tap", 4],
  ["Our Notes Critical Trace", 9],
  ["Our Notes Critical Hold", 7],
  ["Our Notes Critical Flick", 5],
  ["Our Notes Critical Tick", 9],
  ["Our Notes Flick Side", 6],
];

const DATA_ONLY_CLIPS: readonly (readonly [name: string, type: OurNotesNoteSeType])[] = OUR_NOTES_NOTE_SE_TYPE_IDS.map(
  (type) => [`Our Notes Native Type ${String(type).padStart(2, "0")} ${OUR_NOTES_NOTE_SE_TYPE_NAMES[type]}`, type],
);

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
}

function materializeType(
  group: OurNotesNoteSeGroup,
  type: OurNotesNoteSeType,
  staging: string,
  encoded: Map<OurNotesNoteSeType, string>,
): string {
  const existing = encoded.get(type);
  if (existing) return existing;

  const destination = resolve(staging, `type-${type}.mp3`);
  const cue = OUR_NOTES_NOTE_SE_CUES[group][type];
  if (type === 7) {
    const layers = ourNotesNoteSoundsForRelease(releaseServer, group).slide;
    if (typeof layers === "string" || !layers.length) throw new Error(`group ${group} has no held sound layer`);
    // Each waveform owns its own wrap boundary and the shared native gain.
    run(ffmpeg, [
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-i",
      resolve(source, `${typeof cue === "string" ? cue : cue[0]}.mp3`),
      "-af",
      `volume=${layers[0]!.gain}`,
      "-map_metadata",
      "-1",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "320k",
      "-write_xing",
      "1",
      destination,
    ]);
  } else {
    if (Array.isArray(cue)) throw new Error(`group ${group} has an unsupported layered cue for type ${type}`);
    // Reuse encoded single-track cues.
    copyFileSync(resolve(source, `${cue}.mp3`), destination);
  }
  encoded.set(type, destination);
  return destination;
}

function buildGroupPack(group: OurNotesNoteSeGroup, stagingRoot: string): { bytes: number; clips: number } {
  const clips = [...STANDARD_CLIPS, ...DATA_ONLY_CLIPS];
  const staging = resolve(stagingRoot, `group-${group}`);
  mkdirSync(staging, { recursive: true });
  const encoded = new Map<OurNotesNoteSeType, string>();
  const epoch = new Date("2000-01-01T00:00:00Z");

  for (const [index, [, type]] of clips.entries()) {
    const encodedFile = materializeType(group, type, staging, encoded);
    const archiveEntry = resolve(staging, String(index));
    copyFileSync(encodedFile, archiveEntry);
    utimesSync(archiveEntry, epoch, epoch);
  }

  if (group === 1) {
    const filename = String(clips.length);
    const layers = ourNotesNoteSoundsForRelease(releaseServer, group).slide;
    if (typeof layers === "string" || layers.length !== 2) throw new Error("default held cue requires two layers");
    run(ffmpeg, [
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-i",
      resolve(source, "default_long_2.mp3"),
      "-af",
      `volume=${layers[1]!.gain}`,
      "-map_metadata",
      "-1",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "320k",
      "-write_xing",
      "1",
      "-f",
      "mp3",
      resolve(staging, filename),
    ]);
    utimesSync(resolve(staging, filename), epoch, epoch);
    clips.push(["Our Notes Hold Layer 2", 7]);
  }

  const archive = resolve(staging, "effect.audio");
  run("zip", ["-X", "-j", "-0", archive, ...clips.map((_, index) => resolve(staging, String(index)))]);
  const groupOutput = resolve(output, "effects", String(group));
  mkdirSync(groupOutput, { recursive: true });
  copyFileSync(archive, resolve(groupOutput, "effect.audio"));
  writeFileSync(
    resolve(groupOutput, "effect.data"),
    gzipSync(JSON.stringify({ clips: clips.map(([name], index) => ({ name, filename: String(index) })) }), {
      level: 9,
    }),
  );

  // The default resource path carries group 1.
  if (group === 1) {
    copyFileSync(archive, resolve(output, "effect.audio"));
    copyFileSync(resolve(groupOutput, "effect.data"), resolve(output, "effect.data"));
  }

  const bytes = [...encoded.values()].reduce((sum, file) => sum + readFileSync(file).length, 0);
  return { bytes, clips: clips.length };
}

const stagingRoot = mkdtempSync(resolve(tmpdir(), "our-notes-sonolus-effects-"));
try {
  const reports = OUR_NOTES_NOTE_SE_GROUP_IDS.map((group) => {
    const report = buildGroupPack(group, stagingRoot);
    return `group ${group}: ${report.clips} clips, ${report.bytes} encoded bytes`;
  });
  console.log(
    `built native Our Notes Sonolus effect packs: ${reports.join("; ")} ` +
      `(source ${inputProvenance.sourceId}, ${inputProvenance.releaseId})`,
  );
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
