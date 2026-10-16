"""Refresh current story presentation, runtime, assets and option read models."""
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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.api import (
    ADV_FRAME_ROOT, ADV_STAGE_ROOT, ADV_STILL_ROOT,
    BuildData, _frame_runtime, _native_still_presentation,
    _native_story_canvas_cameras, _native_story_resolution_limits,
    _options, _stage_runtime, _story_assets,
)
from build.catalog_storage import (
    RESOURCE_SPECS, _compile_resource, _entities,
    _projected_collection, _replace_nested,
)
from core.config import load_server_config
from core.contracts import UNITY_INDEX_SCHEMA
from core.manifests import stable_json, write_json
from core.storage import cas_key
from publish.band_descriptions import document, publish
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files

RESOURCES = ("stories", "story-runtime", "story-assets", "options")
MASTER_TABLES = ("MasterAdvChat", "MasterSound", "MasterSoundCueSheet", "MasterLiveSe")
CHAT_FIELDS = ("chatPresetRef", "chatWindowAssetName", "chatIconAssetName", "chatSound",
               "chatSoundUnavailableId", "chatWindowSoundRef", "chatWindowSoundUnavailableId")


class _ReleasedInputs:
    """Verified bytes from one immutable release, with bounded local reuse."""

    def __init__(self, base: dict, read_entry: Callable, root: Path):
        self.entries = {row["path"]: row for row in base["entries"]}
        self.read_entry = read_entry
        self.root = root
        self.inputs: dict[str, dict] = {}

    def bytes(self, relative: str) -> bytes:
        entry = self.entries[relative]
        if not 0 < entry["bytes"] <= 64 * 1024 * 1024:
            raise ValueError(f"runtime projection input exceeds byte budget: {relative}")
        target = self.root / relative
        if target.is_file():
            body = target.read_bytes()
        else:
            body = self.read_entry(entry)
        if (body is None or len(body) != entry["bytes"]
                or hashlib.sha256(body).hexdigest() != entry["sha256"]):
            raise ValueError(f"runtime projection CAS differs: {relative}")
        if not target.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        self.inputs[relative] = entry
        return body

    def prefetch(self, paths: list[str]) -> None:
        def materialize(path):
            self.bytes(path)
        with ThreadPoolExecutor(max_workers=4) as executor:
            for _ in executor.map(materialize, paths):
                pass

    def prefetch_sources(self, data: BuildData, source_paths: set[str]) -> None:
        paths = set()
        for source_path in source_paths:
            entry = data.source_index.get(source_path)
            if entry is None:
                continue
            paths.add("metadata/" + entry["descriptor"])
            bundle = data.serialized_files[entry["serializedFile"]]["bundleSha256"]
            paths.add(f"objects/unity/{bundle}.jsonl.gz")
        self.prefetch(sorted(paths))

    def json(self, relative: str) -> dict:
        value = json.loads(self.bytes(relative))
        if not isinstance(value, dict):
            raise ValueError(f"runtime projection JSON is not an object: {relative}")
        return value

    def resource(self, name: str, descriptor: dict) -> dict:
        value = self.json(descriptor["index"])
        spec = RESOURCE_SPECS[name]

        def full_collection(collection, ids, partition):
            nonlocal value
            summaries, was_array, source_keys = _entities(value, collection, ids, name)
            full = {}
            for shard in partition.get("shards", []):
                rows = self.json(partition["prefix"] + shard + ".json")
                if full.keys() & rows.keys():
                    raise ValueError(f"runtime projection entity repeats: {name}")
                full.update(rows)
            if set(full) != set(summaries):
                raise ValueError(f"runtime projection entity coverage differs: {name}")
            value = _replace_nested(value, collection, _projected_collection(full, was_array, source_keys))

        if spec.collection is not None:
            full_collection(spec.collection, spec.id_fields, descriptor.get("entities", {}))
        for view in spec.views:
            old = descriptor.get("views", {}).get(view.name)
            if old is not None:
                full_collection(view.collection, view.id_fields, old.get("entities", {}))
        return value

    def data(self, base: dict) -> BuildData:
        manifest = self.json("metadata/source-index/manifest.json")
        if manifest["server"] != base["server"] or manifest["sourceId"] != base["sourceId"]:
            raise ValueError("runtime projection source index belongs to a different source")
        original = {key: value for key, value in manifest.items()
                    if key not in {"sources", "serializedFiles", "tree"}}
        original["schema"] = UNITY_INDEX_SCHEMA
        original["tree"] = self.json(manifest["tree"])
        for name in ("sources", "serializedFiles"):
            records = {}
            section = manifest[name]
            for shard in section["shards"]:
                rows = self.json(section["prefix"] + shard + ".json")
                if records.keys() & rows.keys():
                    raise ValueError(f"runtime projection source partition repeats: {name}")
                records.update(rows)
            if len(records) != section["count"]:
                raise ValueError(f"runtime projection source partition count differs: {name}")
            original[name] = records
        if original["sourceCount"] != len(original["sources"]):
            raise ValueError("runtime projection source count differs")
        write_json(self.root / "metadata/source-index.json", original)
        for table in MASTER_TABLES:
            write_json(self.root / f"master/{table}.json", self.json(f"objects/master/{table}.json"))
        self.bytes("metadata/cri.json")
        owner = self

        class ReleasedBuildData(BuildData):
            def source_descriptor(self, source_path):
                entry = self.source_index[source_path]
                owner.bytes("metadata/" + entry["descriptor"])
                return super().source_descriptor(source_path)

        def restore_archive(digest, target):
            relative = f"objects/unity/{digest}.jsonl.gz"
            body = owner.bytes(relative)
            if target != owner.root / relative:
                raise ValueError("runtime projection archive target differs")
            return body

        def restore_output(relative, target):
            body = owner.bytes(relative)
            if target != owner.root / relative:
                raise ValueError("runtime projection output target differs")
            return body

        return ReleasedBuildData(base["server"], self.root, self.entries, restore_archive, restore_output)


def project(base: dict, read_entry: Callable, staging: Path) -> dict[str, Any]:
    """Reuse canonical projectors while preserving all unrelated catalog values."""
    records = _validate_release_manifest_for_gc(
        base, f"servers/{base['server']}/releases/{base['releaseId']}/release.json",
        base["server"], base["releaseId"],
    )
    with tempfile.TemporaryDirectory(prefix="current-runtime-inputs-") as directory:
        inputs = _ReleasedInputs(base, read_entry, Path(directory))
        inputs.prefetch([row["path"] for row in records if (
            row["path"].startswith("metadata/source-index/")
            or row["path"] == "metadata/cri.json"
            or row["path"] in {f"objects/master/{table}.json" for table in MASTER_TABLES}
            or any(row["path"].startswith(f"api/v1/catalog/{name}/") for name in RESOURCES))])
        catalog = inputs.json("api/v1/catalog/manifest.json")
        if catalog["server"] != base["server"] or catalog["sourceId"] != base["sourceId"]:
            raise ValueError("runtime projection catalog identity differs")
        docs = {name: inputs.resource(name, catalog["resources"][name]) for name in RESOURCES}
        data = inputs.data(base)
        source_paths = {
            f"{ADV_STILL_ROOT}/{row['assetName']}/{PurePosixPath(row['assetName']).name}.prefab"
            for row in docs["story-assets"]["stills"].values()
        } | {row["sourcePath"] for kind in ("stills", "backgrounds")
             for row in docs["story-assets"][kind].values()} | {
            f"{ADV_FRAME_ROOT}/{row['assetName']}.prefab"
            for row in docs["story-assets"]["frames"].values()
        } | {
            f"{ADV_STAGE_ROOT}/{key}/{key}.prefab" for key in docs["story-runtime"]["stages"]
        }
        inputs.prefetch_sources(data, source_paths)
        episodes = docs["stories"]["episodes"]
        chat_episodes = {PurePosixPath(story["scriptAsset"]).parent.name
                         for story in episodes.values() if any(
                             int(command.get("command") or -1) in {36, 37, 38, 65}
                             and int(command.get("targetChatID") or 0)
                             for command in story["commands"])}
        inputs.prefetch(sorted({path for episode in chat_episodes
                                for suffix in ("Sound", "SoundCueSheet", "Video")
                                if (path := f"assets/Assets/AddressableResources/Adv/Episode/{episode}/{episode}-{suffix}.txt")
                                in inputs.entries}))
        stats = {"storyCount": len(episodes), "stillBindings": 0, "chatStories": 0, "frameBindings": 0}

        def still(record, target):
            result = _native_still_presentation(data, target)
            if result is None:
                raise ValueError(f"current still prefab is absent: {target}")
            if isinstance(record.get("presentation"), str):
                record["imageSequencePresentation"] = record["presentation"]
            record["presentation"] = result
            stats["stillBindings"] += 1

        def frame(record):
            record.update(_frame_runtime(data, record["assetName"]))
            stats["frameBindings"] += 1

        for story in episodes.values():
            for record in story["assets"]["stills"]:
                still(record, record["assetName"])
            for record in story["assets"]["frames"]:
                frame(record)
            commands = [copy.deepcopy(command) for command in story["commands"]
                        if int(command.get("command") or -1) in {36, 37, 38, 65}
                        and int(command.get("targetChatID") or 0)]
            if not commands:
                continue
            stats["chatStories"] += 1
            for command in commands:
                for field in CHAT_FIELDS:
                    command.pop(field, None)
            episode = PurePosixPath(story["scriptAsset"]).parent.name
            added = _story_assets(data, episode, commands, {})
            by_index = {command["index"]: command for command in commands}
            for command in story["commands"]:
                if command["index"] in by_index:
                    updated_command = by_index[command["index"]]
                    for field in CHAT_FIELDS:
                        command.pop(field, None)
                        if field in updated_command:
                            command[field] = updated_command[field]
            sounds = story["assets"]["sounds"]
            registered = {row["resourceRef"]: row for row in sounds}
            for sound in added["sounds"]:
                old = registered.get(sound["resourceRef"])
                if old is None:
                    sounds.append(sound)
                    registered[sound["resourceRef"]] = sound
                elif old != sound:
                    raise ValueError(f"current chat cue differs from its existing binding: {sound['resourceRef']}")

        runtime = docs["story-runtime"]
        runtime["screenCamera"] = _native_story_canvas_cameras(data)["video"]
        runtime["resolutionBaseLengthMaxByQuality"] = _native_story_resolution_limits(data)
        if runtime["resolutionBaseLengthMaxByQuality"] is None:
            raise ValueError("current story quality resolution source is absent")
        for key, value in runtime["stages"].items():
            value["particleEffectGroups"] = _stage_runtime(data, key)["particleEffectGroups"]
        for record in docs["story-assets"]["stills"].values():
            target = f"{record['assetName']}/{PurePosixPath(record['assetName']).name}"
            still(record, target)
        for record in docs["story-assets"]["frames"].values():
            frame(record)
        options = _options(data)
        docs["options"]["liveSe"] = options["liveSe"]
        docs["options"]["sourceTables"] = options["sourceTables"]
        stats["liveSeCount"] = len(options["liveSe"])

        api = staging / "api/v1/catalog"
        updated = copy.deepcopy(catalog)
        for name, value in docs.items():
            descriptor, _ = _compile_resource(name, value, api)
            updated["resources"][name] = descriptor
        write_json(api / "manifest.json", updated, pretty=True)
        changed = release_entries(staging)
        def allowed(path):
            return path == "api/v1/catalog/manifest.json" or any(
                path.startswith(f"api/v1/catalog/{name}/") for name in RESOURCES)
        if any(not allowed(row["path"]) for row in changed):
            raise ValueError("runtime projection escaped its four catalog resources")
        reused = [row for row in records if not allowed(row["path"])]
        manifest = write_release_identity_files(
            staging, base["server"], base["sourceId"], sorted(reused + changed, key=lambda row: row["path"]),
        )
        if {row["path"]: row for row in manifest["entries"] if not allowed(row["path"])} != {
                row["path"]: row for row in reused}:
            raise ValueError("runtime projection modified an unrelated release entry")
        _validate_release_manifest_for_gc(
            manifest, f"servers/{base['server']}/releases/{manifest['releaseId']}/release.json",
            base["server"], manifest["releaseId"],
        )
        previous = {row["path"]: row for row in records}
        uploads = [row for row in changed if row != previous.get(row["path"])]
        return {"manifest": manifest, "sourceId": base["sourceId"], "changedEntries": uploads,
                "reusedEntryCount": len(reused), "selectedEntryCount": len(changed), "noOp": manifest["releaseId"] == base["releaseId"],
                "inputs": list(inputs.inputs.values()), "statistics": stats}


def prepare(store, config, projection, staging):
    identity = projection["identity"]
    if config.id != "intl" or identity["server"] != config.id:
        raise ValueError("this reviewed runtime refresh selects the existing Intl source")
    key = f"servers/{config.id}/current.json"
    head = store.head(key)
    pointer = document(store, key, 4096)
    if any(pointer.get(k) != identity.get(k) for k in ("server", "sourceId", "releaseId")):
        raise ValueError("current changed since runtime projection review")
    etag = head.get("ETag") if head else None
    if not isinstance(etag, str) or re.fullmatch(r'"[^"\r\n]+"', etag) is None:
        raise ValueError("runtime projection requires its strong current ETag")
    manifest_key = f"servers/{config.id}/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("runtime current manifest path differs")
    base = document(store, manifest_key)
    if base["sourceId"] != identity["sourceId"]:
        raise ValueError("runtime parent source differs")
    prepared = project(base, lambda row: store.get_bytes(cas_key(row["sha256"])), staging)
    if store.get_json(key) != pointer or store.head(key).get("ETag") != etag:
        raise ValueError("current changed during runtime projection")
    return {**prepared, "pointer": pointer, "pointerETag": etag}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = os.environ.get("PRODUCER_PIN", "")
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("runtime projection producer pin differs")
    raw = os.environ["CATALOG_PROJECTION_JSON"]
    if len(raw.encode()) > 64 * 1024:
        raise ValueError("runtime projection review exceeds its input budget")
    config = load_server_config(os.environ["RESOURCE_SERVER"])
    mode = os.environ.get("PUBLISH", "false")
    if mode not in {"true", "false"}:
        raise ValueError("PUBLISH must be true or false")
    store = R2Store(config, concurrency=4)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="current-runtime-projection-") as directory:
        projection = json.loads(raw)[config.id]
        prepared = prepare(store, config, projection, Path(directory))
        candidate_sha = hashlib.sha256((Path(directory) / "release.json").read_bytes()).hexdigest()
        expected_id = projection.get("candidateReleaseId")
        expected_sha = projection.get("candidateManifestSha256")
        if mode == "true" and expected_id is None and expected_sha is None:
            raise ValueError("runtime publication requires its reviewed candidate identity")
        if expected_id is not None and (re.fullmatch(r"r-[a-f0-9]{20}", expected_id) is None
                or expected_id != prepared["manifest"]["releaseId"]):
            raise ValueError("runtime candidate release differs from review")
        if expected_sha is not None and (re.fullmatch(r"[a-f0-9]{64}", expected_sha) is None
                or expected_sha != candidate_sha):
            raise ValueError("runtime candidate manifest digest differs from review")
        receipt = {"schema": "haneoka-current-runtime-publication-v1", "producerPin": pin,
                   "server": config.id, "sourceId": prepared["sourceId"],
                   "baseReleaseId": prepared["pointer"]["releaseId"],
                   "releaseId": prepared["manifest"]["releaseId"], "candidateManifestSha256": candidate_sha,
                   "changedEntries": prepared["changedEntries"], "reusedEntries": prepared["reusedEntryCount"],
                   "statistics": prepared["statistics"], "inputs": prepared["inputs"],
                   "published": False, "noOp": prepared["noOp"]}
        write_json(args.output / "publication-receipt.json", receipt, pretty=True)
        if mode == "true" and not prepared["noOp"]:
            receipt["pointer"] = publish(store, config, prepared, Path(directory))
            receipt["published"] = True
            if store.get_json(f"servers/{config.id}/current.json") != receipt["pointer"]:
                raise ValueError("runtime publication pointer readback differs")
            write_json(args.output / "publication-receipt.json", receipt, pretty=True)
    print(stable_json({field: receipt[field] for field in (
        "producerPin", "server", "sourceId", "baseReleaseId", "releaseId",
        "candidateManifestSha256", "statistics", "published", "noOp",
    )}))


if __name__ == "__main__":
    main()
