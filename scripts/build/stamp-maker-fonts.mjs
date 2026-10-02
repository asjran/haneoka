// Build immutable same-origin mirrors of the stamp maker's pinned font sources.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const descriptor = JSON.parse(await readFile(new URL("./stamp-maker-font-sources.json", import.meta.url), "utf8"));
const output = path.resolve(process.argv[2] || path.join(root, ".generated-public/stamp-maker-fonts"));
const sourceDirectory = process.env.STAMP_MAKER_FONT_SOURCE_DIR;
const cache = path.join(root, "node_modules/.cache/stamp-maker-fonts");
const staging = `${output}.staging-${process.pid}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function validate(bytes, entry) {
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
    throw new Error(`Stamp font fingerprint mismatch: ${entry.id}`);
  const magic = bytes.subarray(0, 4).toString("latin1");
  const validSignature = entry.file.endsWith(".txt")
    ? bytes.toString("utf8").includes("SIL OPEN FONT LICENSE")
    : entry.file.endsWith(".tgz")
      ? bytes[0] === 0x1f && bytes[1] === 0x8b
      : entry.file.endsWith(".otf")
        ? magic === "OTTO"
        : magic === "wOF2";
  if (!validSignature) throw new Error(`Stamp font signature invalid: ${entry.id}`);
}

async function download(entry) {
  const url = new URL(entry.source);
  if (url.protocol !== "https:" || !["raw.githubusercontent.com", "registry.npmjs.org"].includes(url.hostname))
    throw new Error(`Stamp font source not allowed: ${entry.id}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok || !response.body) throw new Error(`Font HTTP ${response.status}: ${entry.id}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > entry.bytes) throw new Error(`Stamp font exceeds locked size: ${entry.id}`);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      validate(bytes, entry);
      return bytes;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

function packageFiles(archive) {
  // Read the locked npm tarball in memory; do not extract arbitrary archive paths.
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().split("\0")[0];
    if (!name) break;
    const size = Number.parseInt(header.subarray(124, 136).toString().replaceAll("\0", "").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error("Stamp font archive invalid");
    if (header[156] === 0 || header[156] === 48) files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function stageSerif(entry) {
  const archive = await fontBytes({
    id: entry.id,
    source: entry.archiveSource,
    sourceFile: entry.sourceFile,
    file: entry.sourceFile,
    bytes: entry.archiveBytes,
    sha256: entry.archiveSha256,
  });
  const integrity = "sha512-" + createHash("sha512").update(archive).digest("base64");
  if (integrity !== entry.archiveIntegrity) throw new Error(`Fontsource integrity mismatch: ${entry.id}`);
  const files = packageFiles(archive);
  const css = files.get("package/wght.css");
  if (!css || sha256(css) !== entry.cssSha256) throw new Error(`Fontsource CSS mismatch: ${entry.id}`);
  const text = css.toString("utf8");
  if (
    /https?:|@import/iu.test(text) ||
    !text.includes(`font-family: '${entry.family}'`) ||
    !text.includes("font-weight: 200 900")
  )
    throw new Error(`Fontsource stylesheet contract invalid: ${entry.id}`);
  const urls = [...text.matchAll(/url\(([^)]+)\)/gu)].map((match) => match[1].replace(/^['"]|['"]$/gu, ""));
  if (!urls.length || !urls.every((url) => /^\.\/files\/[a-z0-9.-]+\.woff2$/u.test(url)))
    throw new Error(`Fontsource external font reference: ${entry.id}`);
  const destination = path.join(staging, entry.directory);
  await mkdir(path.join(destination, "files"), { recursive: true });
  let bytes = 0;
  const paths = [...new Set(urls)];
  for (const relative of paths) {
    const file = relative.slice(2);
    const font = files.get("package/" + file);
    if (!font || font.subarray(0, 4).toString() !== "wOF2" || font.length < 48 || font.readUInt32BE(8) !== font.length)
      throw new Error(`Fontsource WOFF2 invalid: ${entry.id}/${file}`);
    bytes += font.length;
    await writeFile(path.join(destination, file), font);
  }
  if (paths.length !== entry.fontFiles || bytes !== entry.fontBytes)
    throw new Error(`Fontsource subset inventory mismatch: ${entry.id}`);
  await writeFile(path.join(destination, "wght.css"), css);
  const license = files.get("package/LICENSE");
  if (license) await writeFile(path.join(destination, "LICENSE"), license);
  return { ...entry, files: paths.length };
}

async function fontBytes(entry) {
  if (sourceDirectory) {
    const bytes = await readFile(path.join(sourceDirectory, entry.sourceFile));
    validate(bytes, entry);
    return bytes;
  }
  const cached = path.join(cache, entry.sha256 + path.extname(entry.file));
  try {
    const bytes = await readFile(cached);
    validate(bytes, entry);
    return bytes;
  } catch {
    // A missing or stale download is replaced only after fingerprint validation.
  }
  const bytes = await download(entry);
  await mkdir(cache, { recursive: true });
  const temporary = `${cached}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, cached);
  return bytes;
}

await mkdir(staging, { recursive: true });
try {
  const fonts = [];
  // Sequential bounded downloads keep the regular frontend preparation small.
  for (const entry of descriptor.custom) {
    const bytes = await fontBytes(entry);
    await mkdir(path.dirname(path.join(staging, entry.file)), { recursive: true });
    await writeFile(path.join(staging, entry.file), bytes);
    fonts.push({ ...entry, url: `/stamp-maker-fonts/${entry.file}` });
  }
  const stylesheets = [];
  for (const entry of descriptor.serif) stylesheets.push(await stageSerif(entry));
  for (const entry of descriptor.licenses) {
    await mkdir(path.dirname(path.join(staging, entry.file)), { recursive: true });
    await writeFile(path.join(staging, entry.file), await fontBytes(entry));
  }
  await writeFile(
    path.join(staging, "manifest.json"),
    JSON.stringify({ version: descriptor.version, fonts, stylesheets, licenses: descriptor.licenses }) + "\n",
  );
  await mkdir(path.dirname(output), { recursive: true });
  const previous = `${output}.previous-${process.pid}`;
  let moved = false;
  try {
    await rename(output, previous);
    moved = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, output);
  } catch (error) {
    if (moved) await rename(previous, output);
    throw error;
  }
  if (moved) await rm(previous, { recursive: true, force: true });
  console.log(
    `Staged ${fonts.length} pinned stamp maker fonts and ${stylesheets.length} complete Fontsource stylesheets`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
