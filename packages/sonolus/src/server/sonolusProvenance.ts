import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { SonolusReleaseWorkspace } from "./releaseWorkspace.ts";

export const SONOLUS_INPUT_PROVENANCE_FILE = "sonolus-input-provenance.json";

export const SONOLUS_INPUT_PREFIXES = [
  "runtime/note-se/",
  "runtime/unity-json/Assets/AddressableResources/Effect/Live/NoteEffect/effect001/",
  "runtime/unity-json/Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/",
  "runtime/unity-json/Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/",
  "runtime/unity-json/Assets/AddressableResources/Effect/Live/NoteEffect/common/",
  "runtime/unity/Assets/AddressableResources/Effect/Live/NoteEffect/common/",
  "runtime/unity-json/Assets/AddressableResources/Live/Images/lane_effect_white.png/",
  "runtime/unity/Assets/AddressableResources/Live/Images/lane_effect_white.png/",
] as const;

const PROVENANCE_SCHEMA = "haneoka-sonolus-input-provenance-v1";
const SHA256 = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;

interface ProvenanceFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface ApkIdentity {
  path: string;
  bytes: number;
  sha256: string;
  packageName?: string;
  versionName?: string;
  versionCode?: string;
}

export interface SonolusInputProvenance {
  readonly schema: typeof PROVENANCE_SCHEMA;
  readonly server: string;
  readonly releaseId: string;
  readonly sourceId: string;
  readonly prefixes: readonly string[];
  readonly exactPaths: readonly string[];
  readonly files: readonly ProvenanceFile[];
  readonly apk: ApkIdentity | null;
  readonly sourceProvenanceValidated: true;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(file: string, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireBytes(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assertSafeRelativePath(value: string, label: string): void {
  if (!value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} is not a safe release-relative path: ${value}`);
  }
}

function matchesSelection(path: string, prefixes: readonly string[], exactPaths: readonly string[]): boolean {
  return exactPaths.includes(path) || prefixes.some((prefix) => path.startsWith(prefix));
}

function assertSelectedFile(file: ProvenanceFile, root: string, label: string): void {
  assertSafeRelativePath(file.path, `${label}.path`);
  const absolute = resolve(root, ...file.path.split("/"));
  if (!absolute.startsWith(`${resolve(root)}/`) || !existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`${label} is missing: ${file.path}`);
  }
  const actualBytes = statSync(absolute).size;
  if (actualBytes !== file.bytes) {
    throw new Error(`${label} byte count changed: ${file.path}: ${actualBytes} != ${file.bytes}`);
  }
  const actualSha256 = sha256File(absolute);
  if (actualSha256 !== file.sha256) {
    throw new Error(`${label} bytes changed: ${file.path}`);
  }
}

function validateSelectedFiles(
  files: readonly ProvenanceFile[],
  root: string,
  prefixes: readonly string[],
  exactPaths: readonly string[],
  label: string,
): void {
  const seen = new Set<string>();
  const covered = new Set<string>();
  for (const [index, file] of files.entries()) {
    if (seen.has(file.path)) throw new Error(`${label} contains a duplicate path: ${file.path}`);
    seen.add(file.path);
    if (!matchesSelection(file.path, prefixes, exactPaths)) {
      throw new Error(`${label} contains an unselected path: ${file.path}`);
    }
    for (const prefix of prefixes) if (file.path.startsWith(prefix)) covered.add(prefix);
    assertSelectedFile(file, root, `${label}[${index}]`);
  }
  const missingPrefixes = prefixes.filter((prefix) => !covered.has(prefix));
  if (missingPrefixes.length) throw new Error(`${label} is missing required prefixes: ${missingPrefixes.join(", ")}`);
  for (const exactPath of exactPaths) {
    if (!seen.has(exactPath)) throw new Error(`${label} is missing required path: ${exactPath}`);
  }
}

function parseFiles(value: unknown, label: string): ProvenanceFile[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${label}[${index}] must be an object`);
    return {
      path: requireString(entry.path, `${label}[${index}].path`),
      bytes: requireBytes(entry.bytes, `${label}[${index}].bytes`),
      sha256: requireSha256(entry.sha256, `${label}[${index}].sha256`),
    };
  });
}

function parseApk(value: unknown, label: string): ApkIdentity | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error(`${label} must be an object or null`);
  return {
    path: requireString(value.path, `${label}.path`),
    bytes: requireBytes(value.bytes, `${label}.bytes`),
    sha256: requireSha256(value.sha256, `${label}.sha256`),
    ...(typeof value.packageName === "string" ? { packageName: value.packageName } : {}),
    ...(typeof value.versionName === "string" ? { versionName: value.versionName } : {}),
    ...(typeof value.versionCode === "string" ? { versionCode: value.versionCode } : {}),
  };
}

function validateFetchedProvenance(
  file: string,
  workspace: SonolusReleaseWorkspace,
  prefixes: readonly string[],
  exactPaths: readonly string[],
): SonolusInputProvenance {
  const document = readJson(file, "Sonolus input provenance");
  if (document.schema !== PROVENANCE_SCHEMA)
    throw new Error(`unexpected Sonolus input provenance schema: ${document.schema}`);
  const releaseId = requireString(document.releaseId, "Sonolus input provenance.releaseId");
  if (!/^r-[a-f0-9]{20}$/u.test(releaseId)) {
    throw new Error("Sonolus input provenance.releaseId must be a versioned release id");
  }
  if (document.server !== workspace.id || (!process.env.RESOURCE_BUILD_ROOT && releaseId !== workspace.releaseId)) {
    throw new Error("Sonolus input provenance identity does not match the configured server/release");
  }
  const sourceId = requireString(document.sourceId, "Sonolus input provenance.sourceId");
  const declaredPrefixes = document.prefixes;
  if (
    !Array.isArray(declaredPrefixes) ||
    declaredPrefixes.length !== prefixes.length ||
    declaredPrefixes.some((value, index) => value !== prefixes[index])
  ) {
    throw new Error("Sonolus input provenance prefixes do not match the required closure");
  }
  const declaredExactPaths = document.exactPaths;
  if (
    !Array.isArray(declaredExactPaths) ||
    declaredExactPaths.length !== exactPaths.length ||
    declaredExactPaths.some((value, index) => value !== exactPaths[index])
  ) {
    throw new Error("Sonolus input provenance exact paths do not match the required closure");
  }
  const files = parseFiles(document.files, "Sonolus input provenance.files");
  validateSelectedFiles(files, workspace.releaseRoot, prefixes, exactPaths, "Sonolus input provenance.files");
  const apk = parseApk(document.apk, "Sonolus input provenance.apk");
  return {
    schema: PROVENANCE_SCHEMA,
    server: workspace.id,
    releaseId,
    sourceId,
    prefixes,
    exactPaths,
    files,
    apk,
    sourceProvenanceValidated: true,
  };
}

function validateLocalRelease(
  workspace: SonolusReleaseWorkspace,
  root: string,
  prefixes: readonly string[],
  exactPaths: readonly string[],
): SonolusInputProvenance {
  const releaseManifestFile = resolve(workspace.releaseRoot, "release.json");
  const release = readJson(releaseManifestFile, "local release manifest");
  if (
    release.schema !== "haneoka-resource-release-v1" ||
    release.server !== workspace.id ||
    release.releaseId !== workspace.releaseId
  ) {
    throw new Error("local release manifest identity does not match the configured server/release");
  }
  const sourceId = requireString(release.sourceId, "local release manifest.sourceId");
  if (!Array.isArray(release.entries)) throw new Error("local release manifest.entries must be an array");
  const selected: ProvenanceFile[] = [];
  for (const [index, entry] of release.entries.entries()) {
    if (!isRecord(entry)) throw new Error(`local release manifest.entries[${index}] must be an object`);
    const path = requireString(entry.path, `local release manifest.entries[${index}].path`);
    if (!matchesSelection(path, prefixes, exactPaths)) continue;
    selected.push({
      path,
      bytes: requireBytes(entry.bytes, `local release manifest.entries[${index}].bytes`),
      sha256: requireSha256(entry.sha256, `local release manifest.entries[${index}].sha256`),
    });
  }
  validateSelectedFiles(selected, workspace.releaseRoot, prefixes, exactPaths, "local release inputs");

  const sourceManifestFile = resolve(root, "data", "servers", workspace.id, "sources", sourceId, "source.json");
  const source = readJson(sourceManifestFile, "local source manifest");
  if (
    source.schema !== "haneoka-resource-source-v1" ||
    source.server !== workspace.id ||
    source.sourceId !== sourceId
  ) {
    throw new Error("local source manifest identity does not match the selected release");
  }
  if (!Array.isArray(source.files)) throw new Error("local source manifest.files must be an array");
  const packageInfo = isRecord(source.package) ? source.package : null;
  if (!packageInfo) throw new Error("local source manifest.package must be an object");
  const packagePath = requireString(packageInfo.file, "local source manifest.package.file");
  const packageRecord = source.files.find(
    (entry): entry is JsonRecord => isRecord(entry) && entry.path === packagePath && entry.role === "package",
  );
  if (!packageRecord) throw new Error("local source manifest package record is missing");
  const apk: ApkIdentity = {
    path: packagePath,
    bytes: requireBytes(packageRecord.bytes, "local source package.bytes"),
    sha256: requireSha256(packageRecord.sha256, "local source package.sha256"),
    ...(typeof packageInfo.packageName === "string" ? { packageName: packageInfo.packageName } : {}),
    ...(typeof packageInfo.versionName === "string" ? { versionName: packageInfo.versionName } : {}),
    ...(typeof packageInfo.versionCode === "string" ? { versionCode: packageInfo.versionCode } : {}),
  };
  return {
    schema: PROVENANCE_SCHEMA,
    server: workspace.id,
    releaseId: workspace.releaseId,
    sourceId,
    prefixes,
    exactPaths,
    files: selected,
    apk,
    sourceProvenanceValidated: true,
  };
}

export function validateSonolusInputProvenance(
  workspace: SonolusReleaseWorkspace,
  root = resolve(process.env.OUR_NOTES_ROOT || process.cwd()),
): SonolusInputProvenance {
  const sidecar = resolve(workspace.releaseRoot, SONOLUS_INPUT_PROVENANCE_FILE);
  if (process.env.RESOURCE_BUILD_ROOT && !existsSync(sidecar)) {
    throw new Error(`fetched Sonolus input provenance is missing: ${sidecar}`);
  }
  if (existsSync(sidecar)) {
    return validateFetchedProvenance(sidecar, workspace, SONOLUS_INPUT_PREFIXES, []);
  }
  return validateLocalRelease(workspace, root, SONOLUS_INPUT_PREFIXES, []);
}
