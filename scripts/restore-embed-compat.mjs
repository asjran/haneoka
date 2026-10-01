import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, lstat, readdir, link, copyFile, rm } from "node:fs/promises";
import path from "node:path";

const origin = "https://haneoka.org";
const inventoryUrl = `${origin}/embed/manifest.json`;
const legacyRelease = "r-22bfe102f7deb73f";
const legacyDigest = "22bfe102f7deb73f50104774ce5a3902033876876e10a13b067e9680534e5a43";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function download(url, maximumBytes, deadline) {
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    !url.pathname.startsWith("/embed/") ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`Invalid compatibility URL: ${url.href}`);
  // Workers assets canonicalize reserved filename characters (notably @)
  // to percent encoding. Request that exact URL instead of following redirects.
  const requestUrl = new URL(url);
  requestUrl.pathname = url.pathname
    .split("/")
    .map((part) => encodeURIComponent(decodeURIComponent(part)))
    .join("/");
  const response = await fetch(requestUrl, {
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(20000), deadline]),
  });
  if (!response.ok) {
    const error = new Error(`Compatibility HTTP ${response.status}: ${url.pathname}`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximumBytes) throw new Error(`Compatibility byte budget: ${url.pathname}`);
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function inventory(bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (value.schemaVersion !== 1 || !/^r-[a-f0-9]{16}$/u.test(value.release) || !/^[a-f0-9]{64}$/u.test(value.sha256))
    throw new Error("Invalid published embed inventory");
  const files = Object.entries(value.files ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"));
  if (!files.length || files.length > 2000) throw new Error("Invalid compatibility file count");
  let total = 0;
  for (const [name, info] of files) {
    if (
      !name ||
      typeof info !== "object" ||
      !Number.isSafeInteger(info.bytes) ||
      info.bytes < 0 ||
      info.bytes > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/u.test(info.sha256)
    )
      throw new Error(`Invalid compatibility file metadata: ${name}`);
    total += info.bytes;
  }
  if (total > 96 * 1024 * 1024) throw new Error("Compatibility inventory exceeds budget");
  const sha256 = digest(files.map(([name, info]) => `${name}\0${info.sha256}\n`).join(""));
  if (sha256 !== value.sha256 || `r-${sha256.slice(0, 16)}` !== value.release)
    throw new Error("Published compatibility inventory digest mismatch");
  return { value, files, total };
}

async function destination(output, url) {
  let relative;
  try {
    relative = decodeURIComponent(url.pathname.slice("/embed/".length));
  } catch {
    throw new Error("Invalid compatibility URL escaping");
  }
  if (/[\\\u0000-\u001f\u007f]/u.test(relative)) throw new Error("Unsafe compatibility output path");
  const target = path.resolve(output, relative);
  if (!target.startsWith(output + path.sep)) throw new Error("Compatibility output escapes embed directory");
  const parts = path.relative(output, target).split(path.sep);
  let current = output;
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Compatibility output contains a symlink");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}

export async function restorePublishedEmbedCompatibility(directory) {
  const output = path.resolve(directory);
  const deadline = AbortSignal.timeout(300000);
  await mkdir(output, { recursive: true });
  let liveBytes;
  try {
    liveBytes = await download(new URL(inventoryUrl), 512 * 1024, deadline);
  } catch (error) {
    // Recover the promised r22 only from its exact hash-verified inventory.
    // Missing aliases after a bad deployment must not prevent their repair.
    if (error.status !== 404) throw error;
    liveBytes = await readFile(path.join(output, legacyRelease, "manifest.json"));
    const cached = inventory(liveBytes);
    if (cached.value.release !== legacyRelease || cached.value.sha256 !== legacyDigest)
      throw new Error("Unverified legacy cache fallback");
    console.log("Published inventory is 404; repairing from verified immutable r22 cache");
  }
  const live = inventory(liveBytes);
  if (live.value.release === legacyRelease && live.value.sha256 !== legacyDigest)
    throw new Error("Legacy embed identity mismatch");
  const inventories = [{ ...live, bytes: liveBytes }];
  // r22 remains a promised immutable URL even after the latest inventory moves.
  if (live.value.release !== legacyRelease) {
    const bytes = await download(new URL(`${origin}/embed/${legacyRelease}/manifest.json`), 512 * 1024, deadline);
    const old = inventory(bytes);
    if (old.value.release !== legacyRelease || old.value.sha256 !== legacyDigest)
      throw new Error("Legacy embed identity mismatch");
    inventories.push({ ...old, bytes });
  }
  let downloaded = 0,
    reused = 0,
    downloadedBytes = 0;
  for (const item of inventories) {
    const base = new URL(`${origin}/embed/${item.value.release}/`);
    let cursor = 0;
    const worker = async () => {
      while (cursor < item.files.length) {
        const [name, expected] = item.files[cursor++];
        const url = new URL(name, base);
        if (
          url.origin !== origin ||
          (!url.pathname.startsWith(`/embed/${item.value.release}/`) && !url.pathname.startsWith("/embed/assets/")) ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          throw new Error("Compatibility source escapes namespace");
        const target = await destination(output, url);
        try {
          const current = await readFile(target);
          if (current.length === expected.bytes && digest(current) === expected.sha256) {
            reused++;
            continue;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const bytes = await download(url, expected.bytes, deadline);
        if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256)
          throw new Error(`Compatibility integrity mismatch: ${name}`);
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.compat-${process.pid}`;
        await writeFile(temporary, bytes);
        await rename(temporary, target);
        downloaded++;
        downloadedBytes += bytes.length;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    await writeFile(path.join(output, item.value.release, "manifest.json"), item.bytes);
  }
  const report = { releases: inventories.map((item) => item.value.release), downloaded, reused, downloadedBytes };
  console.log(`Preserved published embed URLs: ${JSON.stringify(report)}`);
  return report;
}

/** Materialize the generated/cache closure into Astro's actual publicDir. */
export async function stageEmbedDistribution(directory, publicDirectory) {
  const source = path.resolve(directory),
    output = path.resolve(publicDirectory);
  await mkdir(output, { recursive: true });
  let staged = 0;
  for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Embed staging rejects symlinks");
    if (!entry.isFile() || /\.(?:compat|tmp)-/u.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const target = path.join(output, path.relative(source, file));
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.stage-${process.pid}`;
    try {
      await link(file, temporary);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      await copyFile(file, temporary);
    }
    try {
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    staged++;
  }
  console.log(`Staged ${staged} generated embed files for Astro publicDir`);
  return staged;
}
