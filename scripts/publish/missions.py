"""Recompile only current missions from their pinned native Master and catalog inputs."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.catalog_storage import _compile_resource
from build.game_systems import _missions
from core.config import load_server_config
from core.manifests import stable_json, write_json
from core.master_values import RESOURCE_TYPES, _localized, _timestamp, _image_variants
from core.storage import cas_key
from publish.band_descriptions import document, publish
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files

MASTER_TABLES = (
    "MasterMission", "MasterLimitedMission", "MasterLimitedMissionGroup",
    "MasterMissionReward", "MasterText", "MasterStoryEpisode", "MasterDegree",
)



class PinnedMissionData:
    def __init__(self, server: str, tables: dict[str, Any], entries: dict[str, Any]):
        self.server = server
        self.tables = {}
        for name, table in tables.items():
            rows = table.get("_allData")
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ValueError(f"invalid current native Master table: {name}")
            self.tables[name] = rows
        self.texts = {str(row["_id"]): row for row in self.rows("MasterText")}
        self.entries = entries

    def rows(self, name: str) -> list[dict[str, Any]]:
        return self.tables.get(name, [])

    def text(self, identifier: Any, fallback: str = "") -> list[str]:
        return _localized(self.texts.get(str(identifier)), fallback)

    def asset(self, source: str) -> str | None:
        if source.startswith(("Assets/", "Packages/")) and f"assets/{source}" in self.entries:
            return f"/assets/{self.server}/{source}"
        return None

    def has_asset(self, source: str) -> bool:
        return f"assets/{source}" in self.entries


CHANGED_FIELDS = frozenset({
    "title", "startAt", "endAt", "category", "groupId", "groupCategory",
    "releaseDay", "priority", "value", "initialValue",
})
CATALOG_INPUTS = ("bands", "characters", "songs", "stories", "exchange", "items", "support-cards")


def project(base: dict[str, Any], read_entry, staging: Path) -> dict[str, Any]:
    server, release_id = base["server"], base["releaseId"]
    records = _validate_release_manifest_for_gc(
        base, f"servers/{server}/releases/{release_id}/release.json", server, release_id,
    )
    entries = {row["path"]: row for row in records}

    def selected(relative: str) -> dict[str, Any]:
        entry = entries[relative]
        if not 0 < entry["bytes"] <= 16 * 1024 * 1024:
            raise ValueError(f"mission projection input exceeds its byte budget: {relative}")
        body = read_entry(entry)
        if body is None or len(body) != entry["bytes"] or hashlib.sha256(body).hexdigest() != entry["sha256"]:
            raise ValueError(f"mission projection CAS identity differs: {relative}")
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError(f"mission projection input must be an object: {relative}")
        return value

    catalog = selected("api/v1/catalog/manifest.json")
    if catalog["server"] != server or catalog["sourceId"] != base["sourceId"]:
        raise ValueError("mission catalog identity differs from its release")
    descriptor = catalog["resources"]["missions"]
    original_index = selected(descriptor["index"])
    tables = {name: selected(f"objects/master/{name}.json") for name in MASTER_TABLES}
    documents = {name: selected(catalog["resources"][name]["index"]) for name in CATALOG_INPUTS}
    reward_types = {int(row.get("_resourceType") or 0) for row in tables["MasterMissionReward"]["_allData"]}
    for resource_type, name in ((2, "cards"), (9, "stamps")):
        documents[name] = selected(catalog["resources"][name]["index"]) if resource_type in reward_types else {}
    data = PinnedMissionData(server, tables, entries)
    updated = _missions(data, documents, RESOURCE_TYPES, _timestamp)
    for row in updated["entries"].values():
        variants = _image_variants(data, row)
        if variants:
            row["imageVariants"] = variants
    if set(updated["entries"]) != set(original_index["entries"]):
        raise ValueError("mission projection changed current mission identity coverage")
    baseline = copy.deepcopy(updated)
    for identity, row in baseline["entries"].items():
        before = original_index["entries"][identity]
        for field in CHANGED_FIELDS:
            if field in before:
                row[field] = copy.deepcopy(before[field])
            else:
                row.pop(field, None)
    with tempfile.TemporaryDirectory(prefix="mission-parent-proof-") as directory:
        proof = Path(directory)
        old_descriptor, count = _compile_resource("missions", baseline, proof / "api/v1/catalog")
        expected_paths = {descriptor["index"]} | {
            descriptor["entities"]["prefix"] + shard + ".json"
            for shard in descriptor["entities"]["shards"]
        }
        prior = release_entries(proof)
        if old_descriptor != descriptor or count != len(original_index["entries"]) or {row["path"] for row in prior} != expected_paths:
            raise ValueError("mission parent reconstruction descriptor differs")
        if any(row != entries[row["path"]] for row in prior):
            raise ValueError("mission parent reconstruction changed a protected field or image variant")
    updated_descriptor, count = _compile_resource("missions", updated, staging / "api/v1/catalog")
    if count != len(original_index["entries"]) or updated_descriptor != descriptor:
        raise ValueError("mission projection changed the catalog descriptor")
    changed = []
    for row in release_entries(staging):
        if row["path"] not in expected_paths:
            raise ValueError("mission projection escaped its exact path scope")
        if row == entries[row["path"]]:
            (staging / row["path"]).unlink()
        else:
            changed.append(row)
    allowed = {row["path"] for row in changed}
    reused = [row for row in records if row["path"] not in allowed]
    manifest = write_release_identity_files(staging, server, base["sourceId"], sorted(reused + changed, key=lambda row: row["path"]))
    if {row["path"]: row for row in manifest["entries"] if row["path"] not in allowed} != {row["path"]: row for row in reused}:
        raise ValueError("mission projection changed an unselected release entry")
    return {
        "manifest": manifest, "changedEntries": changed, "reusedEntryCount": len(reused),
        "sourceId": base["sourceId"], "noOp": not changed, "missions": updated,
        "originalMasterSHA256": {name: entries[f"objects/master/{name}.json"]["sha256"] for name in MASTER_TABLES},
    }


def prepare(store, config, projection: dict[str, Any], staging: Path) -> dict[str, Any]:
    if projection.get("schema") != "haneoka-current-missions-projection-v1":
        raise ValueError("mission projection schema differs")
    identity = projection["identity"]
    if identity.get("server") != config.id:
        raise ValueError("mission projection server differs")
    pointer_key = f"servers/{config.id}/current.json"
    head = store.head(pointer_key)
    pointer = document(store, pointer_key, 4096)
    if any(pointer.get(key) != identity.get(key) for key in ("server", "sourceId", "releaseId")):
        raise ValueError("current changed since mission projection review")
    etag = head.get("ETag") if head else None
    if not isinstance(etag, str) or re.fullmatch(r'"[^"\r\n]+"', etag) is None:
        raise ValueError("mission projection requires its strong current ETag")
    manifest_key = f"servers/{config.id}/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("mission current manifest path differs")
    base = document(store, manifest_key)
    if base["sourceId"] != identity["sourceId"]:
        raise ValueError("mission parent source differs")
    master = {row["path"].removeprefix("objects/master/").removesuffix(".json"): row["sha256"]
              for row in base["entries"] if row["path"] in {f"objects/master/{name}.json" for name in MASTER_TABLES}}
    if projection.get("originalMasterSHA256") != master:
        raise ValueError("mission original Master input differs from review")
    def read_entry(entry):
        key = cas_key(entry["sha256"])
        metadata = store.head(key)
        if metadata is None or metadata.get("ContentLength") != entry["bytes"]:
            raise ValueError("mission projection CAS metadata differs")
        return store.get_bytes(key)

    prepared = project(base, read_entry, staging)
    if store.get_json(pointer_key) != pointer or store.head(pointer_key).get("ETag") != etag:
        raise ValueError("current changed during mission projection")
    return {**prepared, "pointer": pointer, "pointerETag": etag}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = os.environ.get("PRODUCER_PIN", "")
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("mission projection producer pin differs")
    raw = os.environ["CATALOG_PROJECTION_JSON"]
    if len(raw.encode()) > 64 * 1024:
        raise ValueError("mission projection review exceeds its input budget")
    server = os.environ["RESOURCE_SERVER"]
    projection = json.loads(raw)[server]
    config = load_server_config(server)
    mode = os.environ.get("PUBLISH", "false")
    if mode not in {"true", "false"}:
        raise ValueError("PUBLISH must be true or false")
    store = R2Store(config, concurrency=4)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="current-mission-projection-") as directory:
        staging = Path(directory)
        prepared = prepare(store, config, projection, staging)
        receipt = {
            "schema": "haneoka-current-missions-publication-v1", "producerPin": pin,
            "server": server, "sourceId": prepared["sourceId"],
            "baseReleaseId": prepared["pointer"]["releaseId"], "releaseId": prepared["manifest"]["releaseId"],
            "changedEntries": prepared["changedEntries"], "reusedEntries": prepared["reusedEntryCount"],
            "originalMasterSHA256": prepared["originalMasterSHA256"],
            "missionCount": len(prepared["missions"]["entries"]), "noOp": prepared["noOp"], "published": False,
        }
        write_json(args.output / "publication-receipt.json", receipt, pretty=True)
        if mode == "true" and not prepared["noOp"]:
            receipt["pointer"] = publish(store, config, prepared, staging)
            receipt["published"] = True
            if store.get_json(f"servers/{server}/current.json") != receipt["pointer"]:
                raise ValueError("mission publication pointer readback differs")
            write_json(args.output / "publication-receipt.json", receipt, pretty=True)
        write_json(args.output / "missions.json", prepared["missions"])
    print(stable_json(receipt))


if __name__ == "__main__":
    main()
