import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import runtimeLock from "../../config/cubism-runtime.lock.json";
import { fetchStaticReleaseEntry, type StaticCatalogRelease } from "../lib/static-catalog-source";
import { openReleaseCatalog, type ReleaseCatalog } from "./release-catalog";
import type { CubismModelMetadata } from "../lib/cubism-model-metadata";

interface NativeMoc {
  _release(): void;
}
interface NativeModel {
  release(): void;
  parameters: {
    count: number;
    ids: string[];
    values: Float32Array;
    minimumValues: Float32Array;
    maximumValues: Float32Array;
    defaultValues: Float32Array;
  };
  parts: { count: number; ids: string[]; opacities: Float32Array };
}
interface NativeCore {
  Version: { csmGetVersion(): number };
  Moc: { fromArrayBuffer(bytes: ArrayBuffer): NativeMoc | null };
  Model: { fromMoc(moc: NativeMoc): NativeModel | null };
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let corePromise: Promise<{ core: NativeCore; sha256: string; version: number }> | undefined;
const models = new Map<string, Promise<CubismModelMetadata>>();
const producerSha256 = digest(fs.readFileSync(path.join(process.cwd(), "src", "server", "cubism-model-metadata.ts")));
const localReleases = new Map<string, ReleaseCatalog>();
let coreBytes: { file: string; bytes: Buffer; sha256: string } | undefined;
function lockedCore() {
  if (coreBytes) return coreBytes;
  const pin = runtimeLock.files.find((file) => file.source === "Core/live2dcubismcore.js");
  if (!pin) throw new Error("Cubism Core runtime lock is missing");
  const file = path.resolve(process.cwd(), pin.target),
    bytes = fs.readFileSync(file);
  if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256)
    throw new Error("Cubism metadata Core bytes do not match the runtime lock");
  return (coreBytes = { file, bytes, sha256: pin.sha256 });
}

function coreRuntime() {
  return (corePromise ??= (async () => {
    const { file, bytes, sha256 } = lockedCore();
    const context = vm.createContext({
      console: { ...console, log() {} },
      Buffer,
      require: createRequire(file),
      __dirname: path.dirname(file),
      __filename: file,
      process: { versions: process.versions, argv: process.argv, on() {} },
      setTimeout,
      clearTimeout,
      TextDecoder,
      TextEncoder,
      module: { exports: {} },
      exports: {},
    });
    new vm.Script(bytes.toString("utf8"), { filename: file }).runInContext(context);
    const core = context.Live2DCubismCore as NativeCore;
    let version = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        version = core.Version.csmGetVersion();
      } catch {
        /* The SDK initializes its embedded Wasm asynchronously. */
      }
      if (version) return { core, sha256, version };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Cubism Core metadata runtime did not initialize");
  })());
}

async function mocSource(source: string, pin: StaticCatalogRelease) {
  const origin = process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org";
  const url = new URL(source, origin),
    prefix = `/runtime/${pin.server}/`;
  if (
    !url.pathname.startsWith(prefix) ||
    !url.pathname.endsWith(".moc3") ||
    url.hash ||
    (url.searchParams.has("release") && url.searchParams.get("release") !== pin.releaseId)
  )
    throw new Error("Cubism metadata source does not match its release");
  const relative = `runtime/${url.pathname.slice(prefix.length)}`;
  const entry = await fetchStaticReleaseEntry(relative, pin.server, pin);
  if (!entry) throw new Error(`Cubism metadata MOC is absent from ${pin.server}/${pin.releaseId}: ${relative}`);
  return { relative, entry, pathname: url.pathname, pin, origin };
}
async function readMoc(source: Awaited<ReturnType<typeof mocSource>>) {
  const { relative, entry, pin, origin } = source;
  const root =
    process.env.RESOURCE_RELEASE_ROOT ||
    path.join(process.cwd(), "data", "servers", pin.server, "releases", pin.releaseId);
  let bytes: Buffer;
  if (fs.existsSync(root)) {
    let local = localReleases.get(root);
    if (!local) {
      local = openReleaseCatalog(pin.server, { releaseRoot: root });
      localReleases.set(root, local);
    }
    if (local.identity.releaseId !== pin.releaseId || local.identity.sourceId !== pin.sourceId)
      throw new Error("Cubism metadata local release identity changed");
    bytes = fs.readFileSync(path.join(local.releaseRoot, relative));
  } else {
    const target = new URL(source.pathname, origin);
    target.searchParams.set("release", pin.releaseId);
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(target, {
          signal: AbortSignal.timeout(60_000),
          headers: {
            accept: "application/octet-stream",
            ...(process.env.STATIC_CATALOG_TOKEN ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN } : {}),
          },
        });
        if (!response.ok) {
          await response.arrayBuffer();
          throw new Error(`Cubism metadata MOC returned HTTP ${response.status}`);
        }
        bytes = Buffer.from(await response.arrayBuffer());
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
    throw new Error(`Cubism metadata MOC hash mismatch: ${relative}`);
  return bytes;
}

function cachedMetadata(file: string, coreSha256: string, mocSha256: string): CubismModelMetadata | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as CubismModelMetadata;
    if (
      value.schema !== "haneoka-cubism-model-metadata-v1" ||
      value.producerSha256 !== producerSha256 ||
      value.coreSha256 !== coreSha256 ||
      value.mocSha256 !== mocSha256 ||
      !Number.isInteger(value.coreVersion) ||
      value.coreVersion <= 0 ||
      !Array.isArray(value.parameters) ||
      !Array.isArray(value.parts) ||
      value.parameters.some(
        (row) =>
          !row?.id ||
          typeof row.id !== "string" ||
          ![row.value, row.minimum, row.maximum, row.defaultValue].every(Number.isFinite),
      ) ||
      value.parts.some((row) => !row?.id || typeof row.id !== "string" || !Number.isFinite(row.opacity))
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** The same locked Core reads authored parameter ranges and parts without a renderer or DOM. */
export async function cubismModelMetadata(
  model: Record<string, unknown>,
  pin: StaticCatalogRelease,
): Promise<CubismModelMetadata | undefined> {
  const runtime =
    model.runtime && typeof model.runtime === "object" ? (model.runtime as Record<string, unknown>) : model;
  if (typeof runtime.moc !== "string" || !runtime.moc) return undefined;
  const source = await mocSource(runtime.moc, pin),
    coreSha = lockedCore().sha256;
  const key = `${producerSha256}:${coreSha}:${source.entry.sha256}`;
  let pending = models.get(key);
  if (!pending) {
    pending = (async () => {
      const cache = path.join(
        process.cwd(),
        "data",
        "static-catalog",
        "cubism-model-metadata",
        "v1",
        producerSha256,
        coreSha,
        `${source.entry.sha256}.json`,
      );
      const existing = cachedMetadata(cache, coreSha, source.entry.sha256);
      if (existing) return existing;
      const bytes = await readMoc(source),
        loaded = await coreRuntime();
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const moc = loaded.core.Moc.fromArrayBuffer(buffer);
      if (!moc) throw new Error(`Cubism Core rejected MOC ${source.entry.sha256}`);
      let value: NativeModel | null = null;
      try {
        value = loaded.core.Model.fromMoc(moc);
        if (!value) throw new Error(`Cubism Core rejected model ${source.entry.sha256}`);
        const p = value.parameters,
          parts = value.parts;
        const parameters = Array.from({ length: p.count }, (_, index) => ({
          id: p.ids[index]!,
          value: p.values[index]!,
          minimum: p.minimumValues[index]!,
          maximum: p.maximumValues[index]!,
          defaultValue: p.defaultValues[index]!,
        }));
        const visibility = Array.from({ length: parts.count }, (_, index) => ({
          id: parts.ids[index]!,
          opacity: parts.opacities[index]!,
        }));
        if (
          parameters.some(
            (row) => !row.id || ![row.value, row.minimum, row.maximum, row.defaultValue].every(Number.isFinite),
          ) ||
          visibility.some((row) => !row.id || !Number.isFinite(row.opacity))
        )
          throw new Error("Cubism Core returned invalid model metadata");
        const metadata: CubismModelMetadata = {
          schema: "haneoka-cubism-model-metadata-v1",
          coreSha256: loaded.sha256,
          producerSha256,
          mocSha256: source.entry.sha256,
          coreVersion: loaded.version,
          parameters,
          parts: visibility,
        };
        const temporary = `${cache}.${crypto.randomUUID()}.tmp`;
        try {
          fs.mkdirSync(path.dirname(cache), { recursive: true });
          fs.writeFileSync(temporary, JSON.stringify(metadata));
          fs.renameSync(temporary, cache);
        } catch {
          try {
            fs.rmSync(temporary, { force: true });
          } catch {
            /* Cache persistence is optional. */
          }
        }
        return metadata;
      } finally {
        value?.release();
        moc._release();
      }
    })();
    models.set(key, pending);
    pending.catch(() => models.delete(key));
  }
  return pending;
}
