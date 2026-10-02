"""Publish only band introductions on top of an observed current resource pin."""
from __future__ import annotations
import copy
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.catalog_storage import _compile_resource
from core.config import load_server_config
from core.manifests import stable_json, write_json
from core.storage import cas_key, release_index_key, release_index_prefix, release_index_shard
from publish.r2 import R2Store, IMMUTABLE_CACHE, POINTER_CACHE, _publish_release_identity, _validate_release_manifest_for_gc
from core.contracts import release_identity_descriptor
from verify.release import release_entries, write_release_identity_files


def document(store, key, maximum=64 * 1024 * 1024):
    head = store.head(key)
    if head is None or not 0 < head.get("ContentLength", 0) <= maximum:
        raise ValueError("bounded current projection input is absent or too large")
    value = store.get_json(key)
    if not isinstance(value, dict):
        raise ValueError("projection input must be a JSON object")
    return value


def entry_json(store, entry, maximum=2 * 1024 * 1024):
    if entry["bytes"] > maximum:
        raise ValueError("selected catalog JSON exceeds byte budget")
    body = store.get_bytes(cas_key(entry["sha256"]))
    if body is None or len(body) != entry["bytes"] or hashlib.sha256(body).hexdigest() != entry["sha256"]:
        raise ValueError("selected catalog CAS bytes differ from manifest")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError("selected band catalog must be an object")
    return value


def prepare(store, config, projection, staging):
    if projection.get("schema") != "haneoka-current-band-description-projection-v1" or set(projection.get("originalMasterSHA256", {})) != {"MasterBand", "MasterText"}:
        raise ValueError("band projection needs its two original Master byte identities")
    identity = projection["identity"]
    if identity["server"] != config.id:
        raise ValueError("band projection server mismatch")
    key = f"servers/{config.id}/current.json"
    head = store.head(key)
    pointer = document(store, key, 4096)
    if pointer.get("releaseId") != identity["releaseId"] or pointer.get("sourceId") != identity["sourceId"]:
        raise ValueError("current changed since the native five-band projection; refresh that exact input")
    manifest_key = f"servers/{config.id}/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("current manifest key invalid")
    base = document(store, manifest_key)
    records = _validate_release_manifest_for_gc(base, manifest_key, config.id, identity["releaseId"])
    if base["sourceId"] != identity["sourceId"]:
        raise ValueError("base source mismatch")
    entries = {row["path"]: row for row in records}
    for table, digest in projection["originalMasterSHA256"].items():
        if entries[f"game-client/master/{table}.bin"]["sha256"] != digest:
            raise ValueError("description evidence differs from the current original Master bytes")
    catalog = entry_json(store, entries["api/v1/catalog/manifest.json"])
    band_descriptor = catalog["resources"]["bands"]
    bands = entry_json(store, entries[band_descriptor["index"]])
    original = copy.deepcopy(bands)
    rows = projection["rows"]
    if len(rows) != 5 or len(bands) != 5 or {str(row["bandId"]) for row in rows} != set(bands):
        raise ValueError("band projection must cover the five actual current IDs")
    for row in rows:
        values = row["description"]
        if not isinstance(values, list) or len(values) != 5 or any(not isinstance(v, str) for v in values):
            raise ValueError("native band descriptions require their five original locale slots")
        bands[str(row["bandId"])]["description"] = values
    for key in bands:
        if {k: v for k, v in bands[key].items() if k != "description"} != {k: v for k, v in original[key].items() if k != "description"}:
            raise ValueError("band projection modified a non-description field")
    if bands == original:
        return {"noOp": True, "pointer": pointer, "sourceId": identity["sourceId"]}
    api = staging / "api/v1/catalog"
    api.mkdir(parents=True)
    descriptor, count = _compile_resource("bands", bands, api)
    if count != 5:
        raise ValueError("compiled band count changed")
    updated = copy.deepcopy(catalog)
    updated["resources"]["bands"] = descriptor
    write_json(api / "manifest.json", updated, pretty=True)
    # Only bands paths and its containing read-model manifest may differ.
    changed = release_entries(staging)
    allowed = lambda path: path.startswith("api/v1/catalog/bands/") or path == "api/v1/catalog/manifest.json"
    if any(not allowed(row["path"]) for row in changed):
        raise ValueError("data-only band projection escaped its declared path scope")
    reused = [row for row in records if not allowed(row["path"])]
    composed = sorted(reused + changed, key=lambda row: row["path"])
    manifest = write_release_identity_files(staging, config.id, identity["sourceId"], composed)
    new_records = _validate_release_manifest_for_gc(manifest,
        f"servers/{config.id}/releases/{manifest['releaseId']}/release.json", config.id, manifest["releaseId"])
    assert {row["path"]: row for row in new_records if not allowed(row["path"])} == {row["path"]: row for row in reused}
    compiled_bands = json.loads((api / "bands/index.json").read_text())
    if compiled_bands != bands:
        raise ValueError("compiled band index differs from the exact native introduction projection")
    shards = descriptor.get("entities", {}).get("shards", [])
    emitted = {}
    for shard in shards:
        emitted.update(json.loads((staging / (descriptor["entities"]["prefix"] + shard + ".json")).read_text()))
    if emitted != bands:
        raise ValueError("band entity partitions differ from the exact index records")
    return {"pointer": pointer, "pointerETag": head["ETag"], "manifest": manifest,
            "changedEntries": changed, "reusedEntryCount": len(reused), "bands": bands,
            "sourceId": identity["sourceId"], "noOp": False}


def publish(store, config, prepared, staging):
    pointer_key = f"servers/{config.id}/current.json"
    if store.get_json(pointer_key) != prepared["pointer"]:
        raise ValueError("current changed during band projection; no promotion")
    manifest = prepared["manifest"]
    release_id = manifest["releaseId"]
    for row in prepared["changedEntries"]:
        store.upload_cas(staging / row["path"], row["sha256"], row["mediaType"])
    partitions = defaultdict(dict)
    for row in manifest["entries"]:
        partitions[release_index_shard(row["path"])][row["path"]] = [row["sha256"], row["bytes"], row["mediaType"]]
    def index(i):
        shard = f"{i:02x}"
        store.put_json(release_index_key(config.id, release_id, shard), {
            "schema": "haneoka-resource-index-v1", "server": config.id, "releaseId": release_id,
            "algorithm": "fnv1a32-mod-256", "shard": shard, "entries": partitions.get(shard, {})}, IMMUTABLE_CACHE)
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(index, range(256)))
    manifest_key = f"servers/{config.id}/releases/{release_id}/release.json"
    store.put_json(manifest_key, manifest, IMMUTABLE_CACHE)
    _publish_release_identity(store, f"servers/{config.id}/releases/{release_id}/release-identity.json",
                              release_identity_descriptor(config.id, release_id, manifest))
    pointer = {**prepared["pointer"], "releaseId": release_id, "releaseManifest": manifest_key,
               "releaseIndex": {"algorithm": "fnv1a32-mod-256", "shards": 256,
                                "prefix": release_index_prefix(config.id, release_id)}}
    if store.get_json(pointer_key) != prepared["pointer"]:
        raise ValueError("current changed before conditional band promotion")
    store.put_json(pointer_key, pointer, POINTER_CACHE, expected_etag=prepared["pointerETag"])
    return pointer


def main():
    import argparse, subprocess
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    pin = os.environ["PRODUCER_PIN"]
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("band projection producer pin mismatch")
    if len(os.environ["BAND_DESCRIPTION_PROJECTION_JSON"].encode()) > 64 * 1024:
        raise ValueError("band description input size cap")
    projection = json.loads(os.environ["BAND_DESCRIPTION_PROJECTION_JSON"])[os.environ["RESOURCE_SERVER"]]
    config = load_server_config(projection["identity"]["server"])
    store = R2Store(config, concurrency=4)
    with tempfile.TemporaryDirectory(prefix="current-band-projection-") as directory:
        staging = Path(directory)
        prepared = prepare(store, config, projection, staging)
        receipt = {"schema": "haneoka-current-band-projection-receipt-v1", "producerPin": pin,
                   "server": config.id, "sourceId": prepared["sourceId"], "baseReleaseId": prepared["pointer"]["releaseId"],
                   "noOp": prepared["noOp"], "published": False, "rawBuildRun": False, "pipelineFingerprintPreserved": True}
        if not prepared["noOp"]:
            receipt.update({"releaseId": prepared["manifest"]["releaseId"],
                            "changedPaths": [row["path"] for row in prepared["changedEntries"]],
                            "changedBytes": sum(row["bytes"] for row in prepared["changedEntries"]),
                            "reusedEntries": prepared["reusedEntryCount"]})
            if os.environ.get("PUBLISH") == "true":
                receipt["pointer"] = publish(store, config, prepared, staging)
                receipt["published"] = True
        else:
            receipt["releaseId"] = prepared["pointer"]["releaseId"]
        write_json(args.output / "publication-receipt.json", receipt)
        if receipt["published"] or receipt["noOp"]:
            proofs = []
            for key in ["bands"] + [f"bands/{i}" for i in range(1, 6)]:
                url = f"https://haneoka.org/api/v1/servers/{config.id}/{key}?release={receipt['releaseId']}"
                with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}), timeout=20) as response:
                    if response.headers.get("X-Haneoka-Release-Id") != receipt["releaseId"] or response.headers.get("X-Haneoka-Source-Id") != receipt["sourceId"]:
                        raise ValueError("band public readback pin differs")
                    body = response.read(128 * 1024 + 1)
                    if len(body) > 128 * 1024:
                        raise ValueError("band readback size cap")
                    value = json.loads(body)
                    ids = [str(i) for i in range(1, 6)] if key == "bands" else [key.split("/")[1]]
                    expected = {str(row["bandId"]): row["description"] for row in projection["rows"]}
                    for i in ids:
                        if (value[i] if key == "bands" else value)["description"] != expected[i]:
                            raise ValueError("native band introduction missing from live readback")
                    proofs.append({"path": key, "HTTP": response.status, "bytes": len(body)})
            write_json(args.output / "public-readback.json", proofs)
    print(stable_json(receipt))


if __name__ == "__main__":
    main()
