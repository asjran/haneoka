"""Plan and collect unreachable static-document objects from complete publications."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

PREFIX = "static-documents/v1/"
CONTENT = PREFIX + "content/"
PUBLICATIONS = PREFIX + "publications/"
DEPLOYMENTS = PREFIX + "deployments/"
SCHEMA = "haneoka-static-publication-root-v1"
RECEIPT_SCHEMA = "haneoka-static-deployment-receipt-v1"
PLAN_SCHEMA = "haneoka-static-document-gc-plan-v1"
HEX = r"[a-f0-9]{64}"
CONTENT_KEY = re.compile(rf"^{CONTENT}([a-f0-9]{{2}})/({HEX})\.gz$")
ROOT_KEY = re.compile(rf"^{PUBLICATIONS}({HEX})\.json$")
RECEIPT_KEY = re.compile(rf"^{DEPLOYMENTS}({HEX})\.json$")
MAX_ROOT_BYTES = 64 * 1024 * 1024
MAX_RECEIPT_BYTES = 64 * 1024


def stamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value: Any) -> datetime:
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("Object timestamp must include its timezone")
    return value.astimezone(timezone.utc)


def positive(value: Any, *, zero: bool = False) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and (0 if zero else 1) <= value <= 2 ** 53 - 1


def sha(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def json_body(body: bytes) -> Any:
    def pairs(rows: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in rows:
            if key in value:
                raise ValueError(f"Duplicate JSON key: {key}")
            value[key] = item
        return value

    def invalid(value: str) -> None:
        raise ValueError(f"Invalid JSON number: {value}")

    return json.loads(body, object_pairs_hook=pairs, parse_constant=invalid)


def publication(body: bytes, expected: str | None = None) -> dict[str, Any]:
    digest = sha(body)
    if len(body) > MAX_ROOT_BYTES or (expected is not None and digest != expected):
        raise ValueError("Static publication root SHA/size differs")
    value = json_body(body)
    if (not isinstance(value, dict) or value.get("schema") != SCHEMA
            or value.get("documentSchema") != "haneoka-static-documents-v2"
            or value.get("contentPrefix") != CONTENT.rstrip("/")
            or not positive(value.get("documents")) or not positive(value.get("data"), zero=True)
            or not isinstance(value.get("objects"), list)
            or not isinstance(value.get("indexes"), list) or len(value["indexes"]) != 256):
        raise ValueError("Static publication root structure differs")
    storage = value.get("contentStorage", "r2")
    if storage not in {"r2", "worker-assets"} or (
            storage == "worker-assets" and value.get("assetRoot") != "/provider-static/content"):
        raise ValueError("Unknown static publication content storage")
    indexes = set()
    for index in value["indexes"]:
        if (not isinstance(index, dict)
                or not re.fullmatch(r"/provider-static/index/[a-f0-9]{2}\.json", str(index.get("path", "")))
                or index["path"] in indexes or not re.fullmatch(HEX, str(index.get("sha256", "")))
                or not positive(index.get("bytes"))):
            raise ValueError("Invalid static publication index reference")
        indexes.add(index["path"])
    objects = set()
    for item in value["objects"]:
        if (not isinstance(item, dict) or not re.fullmatch(HEX, str(item.get("sha256", "")))
                or item["sha256"] in objects or not positive(item.get("bytes"))
                or not positive(item.get("gzipBytes"))):
            raise ValueError("Invalid static publication content reference")
        objects.add(item["sha256"])
    if not objects:
        raise ValueError("Static publication root has no content")
    return {"sha256": digest, "storage": storage, "objects": objects,
            "documents": value["documents"], "data": value["data"]}


def receipt(body: bytes, expected: str) -> dict[str, Any]:
    if len(body) > MAX_RECEIPT_BYTES or sha(body) != expected:
        raise ValueError("Static deployment receipt SHA/size differs")
    value = json_body(body)
    if (not isinstance(value, dict) or value.get("schema") != RECEIPT_SCHEMA
            or not re.fullmatch(HEX, str(value.get("publicationSha256", "")))
            or not re.fullmatch(r"[a-f0-9]{40}", str(value.get("sourceSha", "")))
            or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", str(value.get("workerVersionId", "")))
            or value.get("contentStorage") not in {"r2", "worker-assets"}):
        raise ValueError("Invalid successful static deployment receipt")
    timestamp(value.get("observedAt"))
    return value


def active_publication(origin: str) -> dict[str, Any]:
    if not re.fullmatch(r"https://[a-z0-9.-]+(?::[0-9]+)?", origin):
        raise ValueError("Static publication origin must be an HTTPS origin")
    request = urllib.request.Request(
        f"{origin}/provider-static/publication.json.gz?gc={time.time_ns()}",
        headers={"Cache-Control": "no-cache", "Accept-Encoding": "identity", "User-Agent": "Haneoka-Static-Documents/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read(MAX_ROOT_BYTES + 1)
    if body[:2] == b"\x1f\x8b":
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as stream:
            body = stream.read(MAX_ROOT_BYTES + 1)
    return publication(body)


def metadata(row: dict[str, Any]) -> dict[str, Any]:
    key, size = row.get("Key", row.get("key")), row.get("Size", row.get("size"))
    modified = row.get("LastModified", row.get("last_modified", row.get("uploaded")))
    etag = row.get("ETag", row.get("etag"))
    if (not isinstance(key, str) or not key.startswith(PREFIX) or not positive(size, zero=True)
            or not isinstance(etag, str) or not etag):
        raise ValueError("Invalid static namespace listing metadata")
    return {"key": key, "bytes": size, "modified": stamp(timestamp(modified)), "etag": etag.strip('"')}


def content_digest(key: str) -> str | None:
    match = CONTENT_KEY.fullmatch(key)
    return match[2] if match and match[1] == match[2][:2] else None


class Remote:
    def __init__(self, bucket: str):
        import boto3
        from botocore.config import Config

        account = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or os.environ.get("R2_ACCOUNT_ID", "")
        if not re.fullmatch(r"[a-f0-9]{32}", account) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", bucket):
            raise ValueError("Invalid static R2 account/bucket")
        self.bucket = bucket
        self.client = boto3.client(
            "s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com", region_name="auto",
            config=Config(retries={"max_attempts": 5, "mode": "standard"}, connect_timeout=10, read_timeout=120),
        )

    def list(self, prefix: str) -> list[dict[str, Any]]:
        rows = []
        for number, page in enumerate(self.client.get_paginator("list_objects_v2").paginate(
                Bucket=self.bucket, Prefix=prefix, PaginationConfig={"PageSize": 1000}), 1):
            rows.extend(metadata(item) for item in page.get("Contents", []))
            if number % 25 == 0:
                print(f"Listed {number} static namespace pages", file=sys.stderr)
            time.sleep(0.15)
        return rows

    def read(self, key: str, limit: int) -> bytes:
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        try:
            body = response["Body"].read(limit + 1)
        finally:
            response["Body"].close()
        if len(body) > limit:
            raise ValueError(f"Static metadata object exceeds size limit: {key}")
        return body

    def delete(self, keys: list[str]) -> int:
        pending = keys
        for attempt in range(5):
            response = self.client.delete_objects(
                Bucket=self.bucket, Delete={"Objects": [{"Key": key} for key in pending], "Quiet": True},
            )
            errors = response.get("Errors", [])
            if not isinstance(errors, list):
                raise OSError("Static content deletion returned an invalid error list")
            if not errors:
                return len(keys)
            if any(not isinstance(item, dict) or item.get("Key") not in pending
                    or item.get("Code") not in {"InternalError", "ServiceUnavailable", "SlowDown", "RequestTimeout", "Throttling"}
                    for item in errors):
                raise OSError("Static content deletion returned a permanent/unknown object error")
            pending = [item["Key"] for item in errors]
            time.sleep(min(2 ** attempt, 8))
        raise OSError(f"Static content deletion failed for {len(pending)} objects")


def snapshot(rows: list[dict[str, Any]]) -> str:
    return sha(canonical(sorted(rows, key=lambda row: row["key"])))


def make_plan(rows: list[dict[str, Any]], active: dict[str, Any], read: Any,
              now: datetime, grace_days: int, retain: int, complete: bool, bucket: str, origin: str) -> dict[str, Any]:
    unique = {}
    for row in rows:
        previous = unique.get(row["key"])
        if previous is not None and previous != row:
            raise ValueError(f"Conflicting static listing object: {row['key']}")
        unique[row["key"]] = row
    rows = list(unique.values())
    roots = [row for row in rows if row["key"].startswith(PUBLICATIONS)]
    receipts = [row for row in rows if row["key"].startswith(DEPLOYMENTS)]
    cutoff = now - timedelta(days=grace_days)
    registered = []
    for row in receipts:
        match = RECEIPT_KEY.fullmatch(row["key"])
        if match:
            value = receipt(read(row["key"], MAX_RECEIPT_BYTES), match[1])
            if timestamp(value["observedAt"]) > now + timedelta(minutes=5):
                raise ValueError("Static deployment receipt is dated in the future")
            registered.append(value)
    recognized_roots = [row for row in roots if ROOT_KEY.fullmatch(row["key"])]
    selected = {active["sha256"]}
    ordered_roots = sorted(recognized_roots, key=lambda row: (timestamp(row["modified"]), row["key"]), reverse=True)
    registry_covers_retention = len({value["publicationSha256"] for value in registered}) >= retain
    if not registry_covers_retention:
        selected.update(ROOT_KEY.fullmatch(row["key"])[1] for row in ordered_roots[:retain])
    selected.update(ROOT_KEY.fullmatch(row["key"])[1] for row in ordered_roots if timestamp(row["modified"]) >= cutoff)
    recent_success = set()
    for value in sorted(registered, key=lambda value: timestamp(value["observedAt"]), reverse=True):
        digest = value["publicationSha256"]
        if len(recent_success) < retain or timestamp(value["observedAt"]) >= cutoff:
            selected.add(digest)
            recent_success.add(digest)
    retained_content = set(active["objects"] if active["storage"] == "r2" else ())
    root_storage = {active["sha256"]: active["storage"]}
    valid_roots = set()
    for row in recognized_roots:
        digest = ROOT_KEY.fullmatch(row["key"])[1]
        value = publication(read(row["key"], MAX_ROOT_BYTES), digest)
        valid_roots.add(digest)
        root_storage[digest] = value["storage"]
        if digest in selected and value["storage"] == "r2":
            retained_content.update(value["objects"])
    for value in registered:
        digest = value["publicationSha256"]
        if digest not in selected:
            continue
        storage = root_storage.get(digest)
        if storage is not None and storage != value["contentStorage"]:
            raise ValueError("Successful static receipt and publication storage differ")
        if value["contentStorage"] == "r2" and digest not in valid_roots and digest != active["sha256"]:
            raise ValueError("A retained successful R2 publication root is missing")
    candidates, unknown = [], []
    for row in rows:
        key = row["key"]
        digest = content_digest(key)
        match = ROOT_KEY.fullmatch(key)
        if digest is not None:
            keep = digest in retained_content
        elif match:
            keep = match[1] in selected
        else:
            if not RECEIPT_KEY.fullmatch(key):
                unknown.append(row)
            continue
        if not keep and timestamp(row["modified"]) < cutoff:
            candidates.append(row)
    active_registered = any(value["publicationSha256"] == active["sha256"]
                            and value["contentStorage"] == active["storage"] for value in registered)
    plan = {
        "schema": PLAN_SCHEMA, "createdAt": stamp(now), "bucket": bucket, "origin": origin,
        "inventoryComplete": complete, "graceDays": grace_days, "retainRoots": retain,
        "cutoff": stamp(cutoff), "activePublicationSha256": active["sha256"],
        "activeStorage": active["storage"], "activeDeploymentRegistered": active_registered,
        "rootsSnapshotSha256": snapshot(roots), "receiptsSnapshotSha256": snapshot(receipts),
        "retainedRoots": sorted(selected), "retainedContent": sorted(retained_content),
        "scannedObjects": len(rows), "scannedBytes": sum(row["bytes"] for row in rows),
        "publicationRoots": len(valid_roots), "successfulDeploymentReceipts": len(registered),
        "registryCoversRetention": registry_covers_retention,
        "unknownObjects": len(unknown), "unknownBytes": sum(row["bytes"] for row in unknown),
        "candidates": sorted(candidates, key=lambda row: row["key"]),
    }
    return {"plan": plan, "sha256": sha(canonical(plan))}


def summary(envelope: dict[str, Any]) -> dict[str, Any]:
    value = envelope["plan"]
    return {key: item for key, item in value.items() if key not in {"candidates", "retainedContent"}} | {
        "planSha256": envelope["sha256"], "candidateObjects": len(value["candidates"]),
        "candidateBytes": sum(row["bytes"] for row in value["candidates"]),
        "retainedContentObjects": len(value["retainedContent"]), "perObjectHeadRequests": 0,
    }


def write_json(file: Path, value: Any) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def apply_plan(envelope: dict[str, Any], remote: Remote) -> dict[str, Any]:
    if (os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("HANEOKA_PUBLICATION_LOCK") != "cloudflare-production-publish"):
        raise ValueError("Apply from the shared cloudflare-production-publish workflow lock")
    value = envelope.get("plan")
    if not isinstance(value, dict) or envelope.get("sha256") != sha(canonical(value)) or value.get("schema") != PLAN_SCHEMA:
        raise ValueError("Static GC plan SHA/schema differs")
    now = datetime.now(timezone.utc)
    created = timestamp(value["createdAt"])
    if (not value.get("inventoryComplete") or value["bucket"] != remote.bucket
            or not positive(value.get("graceDays")) or value["graceDays"] < 7
            or not positive(value.get("retainRoots")) or value["retainRoots"] < 3
            or created > now or now - created > timedelta(hours=24)
            or timestamp(value["cutoff"]) != created - timedelta(days=value["graceDays"])):
        raise ValueError("Static GC requires a complete, recent plan with at least 3 roots and 7 days of grace")
    if value["activeStorage"] != "worker-assets" or not value["activeDeploymentRegistered"]:
        raise ValueError("Record the successful Worker-assets migration before collecting legacy static content")
    active = active_publication(value["origin"])
    if active["sha256"] != value["activePublicationSha256"] or active["storage"] != value["activeStorage"]:
        raise ValueError("Active static publication changed after planning")
    current_roots = remote.list(PUBLICATIONS)
    if (snapshot(current_roots) != value["rootsSnapshotSha256"]
            or snapshot(remote.list(DEPLOYMENTS)) != value["receiptsSnapshotSha256"]):
        raise ValueError("Static publication roots/receipts changed after planning")
    retained = set(value["retainedContent"])
    retained_roots = set(value["retainedRoots"])
    keys = set()
    planned = {}
    for row in value["candidates"]:
        key = row["key"]
        digest = content_digest(key)
        root = ROOT_KEY.fullmatch(key)
        if (key in keys or timestamp(row["modified"]) >= timestamp(value["cutoff"])
                or not positive(row["bytes"], zero=True)
                or (digest is None and root is None) or digest in retained
                or (root is not None and root[1] in retained_roots)):
            raise ValueError("Static GC candidate falls outside the verified unreachable set")
        keys.add(key)
        planned[key] = row
    checked = {row["key"]: row for row in current_roots}
    shards = sorted({CONTENT_KEY.fullmatch(key)[1] for key in keys if content_digest(key) is not None})
    for shard in shards:
        checked.update((row["key"], row) for row in remote.list(f"{CONTENT}{shard}/") if row["key"] in keys)
    unchanged = sorted(key for key in keys if checked.get(key) == planned[key])
    skipped = sorted(keys - set(unchanged))
    active = active_publication(value["origin"])
    if active["sha256"] != value["activePublicationSha256"] or active["storage"] != value["activeStorage"]:
        raise ValueError("Active static publication changed during candidate verification")
    deleted = 0
    for offset in range(0, len(unchanged), 1000):
        deleted += remote.delete(unchanged[offset:offset + 1000])
    return summary(envelope) | {"applied": True, "deletedObjects": deleted,
                                "skippedChangedOrMissingObjects": len(skipped), "skippedKeys": skipped,
                                "candidateShardsRelisted": len(shards)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("collect", "offline-plan", "apply"))
    parser.add_argument("--bucket", default="hotdori-assets")
    parser.add_argument("--origin", default="https://haneoka.org")
    parser.add_argument("--grace-days", type=int, default=7)
    parser.add_argument("--retain-roots", type=int, default=3)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--inventory-directory", type=Path)
    parser.add_argument("--active-manifest", type=Path)
    parser.add_argument("--roots-directory", type=Path)
    args = parser.parse_args()
    if args.grace_days < 7 or args.retain_roots < 3:
        parser.error("Keep at least 3 publication roots and 7 days of grace")
    if args.mode == "apply":
        result = apply_plan(json_body(args.plan.read_bytes()), Remote(args.bucket))
    else:
        if args.mode == "offline-plan":
            if args.inventory_directory is None or args.active_manifest is None:
                parser.error("Offline planning requires --inventory-directory and --active-manifest")
            rows = []
            for file in sorted(args.inventory_directory.glob("*.json")):
                page = json_body(file.read_bytes())
                items = page.get("result", page.get("Contents"))
                if not isinstance(items, list):
                    raise ValueError(f"Invalid recorded listing page: {file}")
                rows.extend(metadata(row) for row in items)
            active = publication(args.active_manifest.read_bytes())

            def read(key: str, limit: int) -> bytes:
                if args.roots_directory is None:
                    raise ValueError("Recorded root/receipt bodies are required for offline marking")
                body = (args.roots_directory / Path(key).name).read_bytes()
                if len(body) > limit:
                    raise ValueError("Recorded static metadata object exceeds size limit")
                return body

            complete = False
        else:
            remote = Remote(args.bucket)
            active = active_publication(args.origin)
            rows = remote.list(PREFIX)
            read, complete = remote.read, True
        envelope = make_plan(rows, active, read, datetime.now(timezone.utc), args.grace_days,
                             args.retain_roots, complete, args.bucket, args.origin)
        write_json(args.plan, envelope)
        result = summary(envelope) | {"applied": False}
    if args.report:
        write_json(args.report, result)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
