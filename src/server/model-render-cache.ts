import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import type { StaticWorkspacePage } from "./render-workspace";

const SCHEMA = "haneoka-model-render-v1";
const root = path.join(process.cwd(), "data/static-render/model-v1");
const output = path.join(process.cwd(), ".output/public/_astro/material-ssr");
const cssPattern = /\/_astro\/material-ssr\/([a-f0-9]{64})\.css/gu;
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
let epoch: string | null | undefined;

function rendererEpoch(): string | null {
  if (epoch !== undefined) return epoch;
  try {
    const digest = createHash("sha256");
    const add = (relative: string) => {
      digest
        .update(relative)
        .update("\0")
        .update(fs.readFileSync(path.join(process.cwd(), relative)))
        .update("\0");
    };
    const walk = (relative: string) => {
      for (const entry of fs
        .readdirSync(path.join(process.cwd(), relative), {
          withFileTypes: true,
        })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const file = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) add(file);
      }
    };
    for (const file of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "astro.config.mjs",
      ".gitmodules",
      "config/cubism-runtime.lock.json",
    ])
      add(file);
    walk("src");
    walk("public/i18n");
    for (const entry of fs
      .readdirSync(path.join(process.cwd(), "packages"), {
        withFileTypes: true,
      })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const directory = `packages/${entry.name}`;
      if (fs.existsSync(path.join(process.cwd(), directory, "package.json")))
        add(`${directory}/package.json`);
      if (fs.existsSync(path.join(process.cwd(), directory, "src")))
        walk(`${directory}/src`);
    }
    const modules = execFileSync(
      "git",
      [
        "config",
        "-f",
        path.join(process.cwd(), ".gitmodules"),
        "--get-regexp",
        "^submodule\\..*\\.path$",
      ],
      { encoding: "utf8" },
    );
    for (const line of modules.trim().split("\n").sort()) {
      const directory = line.slice(line.indexOf(" ") + 1).trim();
      const revision = execFileSync(
        "git",
        ["-C", path.join(process.cwd(), directory), "rev-parse", "HEAD"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      digest.update(directory).update("\0").update(revision).update("\0");
    }
    digest.update(
      JSON.stringify([
        SCHEMA,
        process.versions.node,
        process.versions.icu,
        process.platform,
      ]),
    );
    epoch = digest.digest("hex");
  } catch {
    epoch = null;
  }
  return epoch;
}

function atomicWrite(file: string, value: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, value);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function stylesheet(digest: string, from: string, to: string): void {
  if (fs.existsSync(to) && sha256(fs.readFileSync(to)) === digest) return;
  const bytes = fs.readFileSync(from);
  if (sha256(bytes) !== digest)
    throw new Error(`Invalid cached model stylesheet: ${digest}`);
  atomicWrite(to, bytes);
}

function isPage(value: unknown): value is StaticWorkspacePage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<StaticWorkspacePage>;
  return (
    typeof page.body === "string" &&
    !!page.appBar &&
    [page.appBar.actions, page.appBar.identity, page.appBar.search].every(
      (value) => typeof value === "string",
    )
  );
}

export function cachedModelRender(
  identity: readonly string[],
  input: unknown,
  render: () => Promise<StaticWorkspacePage>,
): Promise<StaticWorkspacePage> {
  if (
    import.meta.env?.PROD !== true ||
    process.env.HANEOKA_STATIC_MODEL_RENDER_CACHE === "off"
  )
    return render();
  const renderer = rendererEpoch();
  if (!renderer) return render();
  const key = sha256(JSON.stringify([renderer, input]));
  const name = sha256(JSON.stringify(identity));
  const file = path.join(root, name.slice(0, 2), `${name}.json.gz`);
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024)
      throw new Error("Oversized model render cache");
    const record = JSON.parse(
      gunzipSync(fs.readFileSync(file), {
        maxOutputLength: 64 * 1024 * 1024,
      }).toString("utf8"),
    );
    if (
      record.schema !== SCHEMA ||
      record.key !== key ||
      !isPage(record.page) ||
      record.sha256 !== sha256(JSON.stringify(record.page))
    )
      throw new Error("Stale model render cache");
    const styles = [
      ...new Set(
        [...JSON.stringify(record.page).matchAll(cssPattern)].map(
          (match) => match[1]!,
        ),
      ),
    ];
    for (const digest of styles)
      stylesheet(
        digest,
        path.join(root, "styles", `${digest}.css`),
        path.join(output, `${digest}.css`),
      );
    return Promise.resolve(record.page);
  } catch {
    return render().then((page) => {
      try {
        const content = JSON.stringify(page);
        const styles = [
          ...new Set(
            [...content.matchAll(cssPattern)].map((match) => match[1]!),
          ),
        ];
        for (const digest of styles)
          stylesheet(
            digest,
            path.join(output, `${digest}.css`),
            path.join(root, "styles", `${digest}.css`),
          );
        atomicWrite(
          file,
          gzipSync(
            JSON.stringify({
              schema: SCHEMA,
              key,
              sha256: sha256(content),
              page,
            }),
            { level: 6 },
          ),
        );
      } catch {
        // A read-only or incomplete cache leaves the freshly rendered page intact.
      }
      return page;
    });
  }
}
