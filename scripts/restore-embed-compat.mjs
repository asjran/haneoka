import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
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
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(20000), deadline]),
  });
  if (!response.ok) throw new Error(`Compatibility HTTP ${response.status}: ${url.pathname}`);
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
  const liveBytes = await download(new URL(inventoryUrl), 512 * 1024, deadline);
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
