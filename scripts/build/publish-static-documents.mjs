#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { STATIC_DOCUMENT_SCHEMA, STATIC_DOCUMENT_CONTENT_ROOT } from "../../src/lib/static-documents.ts";

const root = path.resolve(".output/static-documents");
const dryRun = process.argv.slice(2).includes("--dry-run");
if (process.argv.slice(2).some((argument) => argument !== "--dry-run")) throw new Error("Unknown static publication argument");
const publication = JSON.parse(fs.readFileSync(path.join(root, "publication.json"), "utf8"));
if (publication.schema !== STATIC_DOCUMENT_SCHEMA || publication.completeCoverage !== true || publication.documents < 1)
  throw new Error("Complete static documents must be finalized before publication");
const reference = publication.references;
const digest = (body) => createHash("sha256").update(body).digest("hex");
if (reference?.path !== "references.json" || !/^[a-f0-9]{64}$/u.test(reference.sha256))
  throw new Error("Static publication has no verified reference manifest");
const manifestFile = path.join(root, reference.path), manifestBody = fs.readFileSync(manifestFile);
if (manifestBody.length !== reference.bytes || digest(manifestBody) !== reference.sha256)
  throw new Error("Static publication reference manifest identity differs");
const manifest = JSON.parse(manifestBody.toString("utf8"));
if (manifest.schema !== "haneoka-static-publication-root-v1" || manifest.documentSchema !== STATIC_DOCUMENT_SCHEMA ||
  manifest.contentPrefix !== STATIC_DOCUMENT_CONTENT_ROOT || manifest.documents !== publication.documents ||
  manifest.data !== publication.data || !Array.isArray(manifest.objects) || !Array.isArray(manifest.indexes) ||
  manifest.indexes.length !== 256 || manifest.objects.length !== publication.referencedContentObjects)
  throw new Error("Static publication reference manifest structure differs");
const indexPaths = new Set();
for (const index of manifest.indexes) {
  if (!/^\/provider-static\/index\/[a-f0-9]{2}\.json$/u.test(index.path) || indexPaths.has(index.path))
    throw new Error("Invalid static publication index path");
  indexPaths.add(index.path);
  const body = fs.readFileSync(path.join(path.resolve(".output/public"), index.path));
  if (body.length !== index.bytes || digest(body) !== index.sha256) throw new Error(`Static publication index differs: ${index.path}`);
}
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "haneoka-static-upload-"));
let resultStatus = 0;
try {
  let previous = "", gzipBytes = 0;
  for (const object of manifest.objects) {
    if (!/^[a-f0-9]{64}$/u.test(object.sha256) || object.sha256 <= previous ||
      !Number.isSafeInteger(object.bytes) || object.bytes < 0 || !Number.isSafeInteger(object.gzipBytes) || object.gzipBytes < 1)
      throw new Error("Invalid static publication object reference");
    previous = object.sha256;
    const relative = `${object.sha256.slice(0, 2)}/${object.sha256}.gz`;
    const file = path.join(root, "content", relative), zipped = fs.readFileSync(file), body = gunzipSync(zipped);
    if (zipped.length !== object.gzipBytes || body.length !== object.bytes || digest(body) !== object.sha256)
      throw new Error(`Static publication object differs: ${relative}`);
    const destination = path.join(staging, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try { fs.linkSync(file, destination); }
    catch (error) {
      if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
      fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
    }
    gzipBytes += zipped.length;
  }
  if (gzipBytes !== publication.referencedGzipBytes) throw new Error("Static publication reference byte total differs");
  const publicationRoot = `${STATIC_DOCUMENT_CONTENT_ROOT.replace(/\/content$/u, "/publications")}/${reference.sha256}.json`;
  if (dryRun) console.log(JSON.stringify({ dryRun: true, documents: manifest.documents, data: manifest.data, objects: manifest.objects.length, gzipBytes, publicationRoot, referenceSha256: reference.sha256, remoteRequests: 0 }));
  else {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const bucket = process.env.STATIC_DOCUMENT_BUCKET || "hotdori-assets";
    if (!account || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
      throw new Error("Static document publication requires the configured R2 credentials");
    if (!/^[a-z0-9][a-z0-9.-]*$/u.test(bucket) || !/^[a-f0-9]{32}$/u.test(account))
      throw new Error("Invalid static document R2 destination");
    const options = ["--endpoint-url", `https://${account}.r2.cloudflarestorage.com`, "--region", "auto", "--no-progress", "--only-show-errors"];
    const run = (args) => {
      const result = spawnSync("aws", args, { stdio: "inherit", env: { ...process.env, AWS_RETRY_MODE: "standard", AWS_MAX_ATTEMPTS: "5", AWS_EC2_METADATA_DISABLED: "true" } });
      if (result.error) throw result.error;
      return result.status || (result.signal ? 1 : 0);
    };
    resultStatus = run(["s3", "sync", staging, `s3://${bucket}/${STATIC_DOCUMENT_CONTENT_ROOT}/`, ...options, "--size-only", "--content-type", "application/octet-stream"]);
    if (!resultStatus) resultStatus = run(["s3", "cp", manifestFile, `s3://${bucket}/${publicationRoot}`, ...options, "--content-type", "application/json", "--cache-control", "public,max-age=31536000,immutable"]);
    if (!resultStatus) console.log(`published ${publication.documents} complete static documents and their referenced objects`);
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
if (resultStatus) process.exitCode = resultStatus;
