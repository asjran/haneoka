// Stage Fontsource fonts for the server-side chart image renderer.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.resolve(process.argv[2] || path.join(root, ".generated-public/chart-image-fonts"));
await mkdir(output, { recursive: true });
const fonts = [];
for (const family of ["roboto", "noto-sans", "noto-sans-jp", "noto-sans-tc", "noto-sans-sc", "noto-sans-kr"]) {
  const source = path.join(root, "node_modules/@fontsource-variable", family);
  const css = await readFile(path.join(source, "wght.css"), "utf8");
  for (const match of css.matchAll(/@font-face\s*\{([^}]+)\}/gu)) {
    const block = match[1];
    const file = /url\(\.\/files\/([^)]*)\)/u.exec(block)?.[1];
    const unicode = /unicode-range:\s*([^;]+);/u.exec(block)?.[1];
    if (!file || !unicode || !file.endsWith("-normal.woff2")) continue;
    const bytes = await readFile(path.join(source, "files", file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(output, `${sha256}.woff2`), bytes);
    const ranges = unicode.split(",").map((value) => {
      const [start, end = start] = value.trim().replace(/^U\+/iu, "").split("-");
      return [Number.parseInt(start, 16), Number.parseInt(end, 16)];
    });
    fonts.push({ family, path: `${sha256}.woff2`, bytes: bytes.length, ranges });
  }
}
await writeFile(path.join(output, "manifest.json"), JSON.stringify({ version: 1, fonts }));
console.log(`Staged ${fonts.length} Fontsource chart image font subsets`);
