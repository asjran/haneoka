"""Publish a reviewed four-file Home Spot repair over one exact current release."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.config import load_server_config
from core.hashes import sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import validate_release_path
from publish.band_descriptions import document, entry_json, publish
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files

ROOT = Path(__file__).resolve().parents[2]
MAX_BUNDLE = 64 * 1024 * 1024
STORIES = "api/v1/catalog/stories/index.json"
BACKGROUNDS = "metadata/home-spots.json"
PRODUCERS = {"scripts/build/home_spots.py", "scripts/build/api.py"}


def unpack_bundle(file: Path, digest: str, target: Path) -> dict:
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or not 0 < file.stat().st_size <= MAX_BUNDLE or sha256_file(file) != digest:
        raise ValueError("reviewed Home Spot archive SHA/size differs")
    target.mkdir(parents=True, exist_ok=False)
    seen, size, plan, expected = set(), 0, None, set()
    with tarfile.open(file, "r:gz") as archive:
        for member in archive:
            name = validate_release_path(member.name)
            if not member.isfile() or name in seen or not 0 < member.size <= MAX_BUNDLE:
                raise ValueError("Home Spot archive requires unique regular files")
            size += member.size
            if size > MAX_BUNDLE:
                raise ValueError("Home Spot archive expansion exceeds its byte limit")
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError("Home Spot archive member is unreadable")
            with stream:
                if plan is None:
                    if name != "plan.json" or member.size > 64 * 1024:
                        raise ValueError("Home Spot archive must begin with its bounded review plan")
                    plan = json.loads(stream.read())
                    changes = plan.get("changedEntries")
                    if plan.get("schema") != "haneoka-current-home-spot-repair-plan-v1" or not isinstance(changes, list) or len(changes) != 4:
                        raise ValueError("Home Spot review requires exactly four changed entries")
                    expected = {validate_release_path(entry["path"]) for entry in changes}
                    if len(expected) != 4 or not {STORIES, BACKGROUNDS} <= expected:
                        raise ValueError("Home Spot review has repeated or missing paths")
                else:
                    if name not in expected:
                        raise ValueError(f"unreviewed Home Spot archive member: {name}")
                    destination = target / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with destination.open("xb") as output:
                        shutil.copyfileobj(stream, output, 1024 * 1024)
            seen.add(name)
    if plan is None or seen != {"plan.json", *expected}:
        raise ValueError("Home Spot archive does not contain its complete four-file review")
    if release_entries(target) != plan["changedEntries"]:
        raise ValueError("Home Spot file SHA/size/type differs from the reviewed four entries")
    return plan


def prepare(base: dict, read_entry, plan: dict, staging: Path) -> dict:
    """Validate real immutable inputs and compose the original release entries."""
    identity = plan.get("identity", {})
    if identity.get("server") != "intl" or plan.get("server") != "intl" or any(base.get(key) != identity.get(key) for key in ("server", "sourceId", "releaseId")):
        raise ValueError("Home Spot repair base/current/source identity differs")
    records = _validate_release_manifest_for_gc(base, f"servers/intl/releases/{base['releaseId']}/release.json", "intl", base["releaseId"])
    entries = {entry["path"]: entry for entry in records}
    master_path = "objects/master/MasterHomeSpot.json"
    if entries[master_path]["sha256"] != plan.get("masterSHA256"):
        raise ValueError("Home Spot repair differs from the exact current Master")
    spot_id = plan.get("spotId")
    if type(spot_id) is not int or spot_id <= 0:
        raise ValueError("Home Spot repair requires one valid source id")
    rows = read_entry(entries[master_path], 1024 * 1024).get("_allData", [])
    selected = [row for row in rows if row.get("_id") == spot_id]
    if len(selected) != 1:
        raise ValueError("Home Spot repair id is absent or repeated in current Master")
    row = selected[0]
    before = read_entry(entries[BACKGROUNDS], 2 * 1024 * 1024)
    backgrounds = read_json(staging / BACKGROUNDS)
    scenes = [scene for scene in backgrounds.get("scenes", []) if scene.get("spotId") == spot_id]
    if len(scenes) != 1 or any(scene.get("spotId") == spot_id for scene in before.get("scenes", [])):
        raise ValueError("Home Spot repair must add the one previously missing scene")
    scene = scenes[0]
    background_source = f"Assets/AddressableResources/{row['_backgroundAssetPath']}.prefab"
    situation_source = f"Assets/AddressableResources/{row['_situationAssetPath']}.prefab"
    if scene.get("sourcePath") != background_source or scene.get("situationSourcePath") != situation_source:
        raise ValueError("Home Spot repair source mapping differs from current Master")
    expected = copy.deepcopy(before)
    expected["scenes"] = sorted([*before["scenes"], scene], key=lambda value: value["spotId"])
    expected["sceneCount"] = len(expected["scenes"])
    expected["skippedSpots"] = [value for value in before.get("skippedSpots", []) if str(value.get("spotId")) != str(spot_id)]
    expected["skippedSceneCount"] = len(expected["skippedSpots"])
    if backgrounds != expected or backgrounds.get("sourceId") != base["sourceId"]:
        raise ValueError("Home Spot repair changed another background or source identity")
    allowed = {STORIES, BACKGROUNDS}
    for key, suffix, kind in (("output", ".glb", "SpotBackgroundSceneGLB"), ("preview", ".png", "SpotBackgroundPreviewPNG")):
        output = scene[key]
        relative = validate_release_path(output["path"])
        prefix = f"runtime/unity/{background_source}/"
        if not relative.startswith(prefix) or not relative.endswith(suffix) or output.get("type") != kind or output.get("runtime") != "/runtime/intl/" + relative.removeprefix("runtime/"):
            raise ValueError("Home Spot derivative leaves its declared background source")
        file = staging / relative
        if file.stat().st_size != output.get("bytes") or sha256_file(file) != output.get("sha256"):
            raise ValueError("Home Spot derivative differs from its scene metadata")
        allowed.add(relative)
    glb = staging / scene["output"]["path"]
    with glb.open("rb") as stream:
        if struct.unpack("<III", stream.read(12)) != (0x46546C67, 2, glb.stat().st_size):
            raise ValueError("Home Spot derivative is not a complete GLB2 document")
    with (staging / scene["preview"]["path"]).open("rb") as stream:
        png = stream.read(24)
    if png[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack(">II", png[16:24]) != (scene["preview"]["width"], scene["preview"]["height"]):
        raise ValueError("Home Spot preview dimensions differ from scene metadata")
    old_stories = read_entry(entries[STORIES], 8 * 1024 * 1024)
    stories = read_json(staging / STORIES)
    spine = stories["homeSpots"][str(spot_id)].get("spine")
    if not isinstance(spine, dict) or spine.get("supported") is not True or not spine.get("layers") or old_stories["homeSpots"][str(spot_id)].get("spine"):
        raise ValueError("Home Spot repair requires its complete newly supported runtime")
    expected_stories = copy.deepcopy(old_stories)
    expected_stories["homeSpots"][str(spot_id)]["spine"] = spine
    if stories != expected_stories:
        raise ValueError("Home Spot repair changed another catalog field")
    if (spine.get("sourcePath") != situation_source or spine.get("backgroundSourcePath") != background_source or spine.get("backgroundScene") != scene["output"]["runtime"] or spine.get("backgroundPreview") != scene["preview"]["runtime"] or spine.get("backgroundTransform") != scene["backgroundTransform"]["matrix"]):
        raise ValueError("Home Spot runtime and background mapping differ")
    if any(spine.get("camera", {}).get(key) != scene["camera"].get(key) for key in ("position", "target", "orbitRatio", "fieldOfView", "aspect")):
        raise ValueError("Home Spot runtime camera differs from its source-derived scene")
    changed = release_entries(staging)
    if changed != plan["changedEntries"] or {entry["path"] for entry in changed} != allowed:
        raise ValueError("Home Spot repair escaped its four reviewed paths")
    preserved = [entry for entry in records if entry["path"] not in allowed]
    if len(preserved) != plan.get("preservedEntryCount"):
        raise ValueError("Home Spot repair preserved-entry count differs")
    manifest = write_release_identity_files(staging, "intl", base["sourceId"], sorted([*preserved, *changed], key=lambda entry: entry["path"]))
    if manifest["releaseId"] != plan.get("releaseId") or len(manifest["entries"]) != plan.get("newEntryCount"):
        raise ValueError("Home Spot repair release identity differs from its review")
    _validate_release_manifest_for_gc(manifest, f"servers/intl/releases/{manifest['releaseId']}/release.json", "intl", manifest["releaseId"])
    if {entry["path"]: entry for entry in manifest["entries"] if entry["path"] not in allowed} != {entry["path"]: entry for entry in preserved}:
        raise ValueError("Home Spot repair changed a protected release entry")
    available = {entry["path"] for entry in manifest["entries"]}
    def references(value):
        if isinstance(value, str) and value.startswith(("/assets/intl/", "/runtime/intl/")):
            relative = re.sub(r"^/(assets|runtime)/intl/", r"\1/", value)
            if relative not in available:
                raise ValueError(f"Home Spot runtime reference is absent: {relative}")
        elif isinstance(value, dict):
            for child in value.values():
                references(child)
        elif isinstance(value, list):
            for child in value:
                references(child)
    references(spine)
    return {"manifest": manifest, "changedEntries": changed, "preservedEntryCount": len(preserved)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = os.environ.get("PRODUCER_PIN", "")
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() != pin:
        raise ValueError("Home Spot repair producer pin differs from the checked-out commit")
    key, digest = os.environ.get("HOME_SPOT_BUNDLE_KEY", ""), os.environ.get("HOME_SPOT_BUNDLE_SHA256", "")
    if not re.fullmatch(r"private/resource-pipeline-stage/[1-9][0-9]*/intl/[A-Za-z0-9._-]+\.tar\.gz", key) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Home Spot repair needs its reviewed private pipeline-stage bundle key and SHA")
    mode = os.environ.get("PUBLISH", "false")
    if mode not in {"true", "false"}:
        raise ValueError("PUBLISH must be true or false")
    config = load_server_config("intl")
    store = R2Store(config, 4)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="home-spot-repair-") as directory:
        root = Path(directory)
        bundle = root / "reviewed.tar.gz"
        head = store.head(key)
        if head is None or not 0 < head.get("ContentLength", 0) <= MAX_BUNDLE:
            raise ValueError("reviewed Home Spot bundle is absent or too large")
        store.download_file(key, bundle, expected_bytes=head["ContentLength"], expected_sha256=digest)
        staging = root / "staging"
        plan = unpack_bundle(bundle, digest, staging)
        if set(plan.get("producerSources", {})) != PRODUCERS or any(sha256_file(ROOT / file) != value for file, value in plan["producerSources"].items()):
            raise ValueError("Home Spot archive producer sources differ from the reviewed build")
        pointer_key = "servers/intl/current.json"
        current_head = store.head(pointer_key)
        pointer = document(store, pointer_key, 4096)
        etag = current_head.get("ETag") if current_head else None
        if not isinstance(etag, str) or not re.fullmatch(r'"[^"\r\n]+"', etag):
            raise ValueError("Home Spot current pointer requires its actual strong S3 ETag")
        identity = plan["identity"]
        if any(pointer.get(name) != identity.get(name) for name in ("server", "sourceId", "releaseId")) or pointer.get("releaseManifest") != f"servers/intl/releases/{identity['releaseId']}/release.json":
            raise ValueError("current changed since the reviewed Home Spot build")
        base = document(store, pointer["releaseManifest"])
        prepared = prepare(base, lambda entry, maximum: entry_json(store, entry, maximum), plan, staging)
        prepared.update(pointer=pointer, pointerETag=etag)
        receipt = {"schema": "haneoka-home-spot-repair-publication-v1", "producerPin": pin, "bundleKey": key, "bundleSHA256": digest, "baseReleaseId": identity["releaseId"], "sourceId": identity["sourceId"], "releaseId": prepared["manifest"]["releaseId"], "spotId": plan["spotId"], "changedEntries": prepared["changedEntries"], "preservedEntryCount": prepared["preservedEntryCount"], "published": False}
        write_json(args.output / "publication-receipt.json", receipt, pretty=True)
        if mode == "true":
            receipt["pointer"] = publish(store, config, prepared, staging)
            receipt["published"] = True
            if store.get_json(pointer_key) != receipt["pointer"]:
                raise ValueError("Home Spot publication pointer readback differs")
            write_json(args.output / "publication-receipt.json", receipt, pretty=True)
    print(stable_json(receipt))


if __name__ == "__main__":
    main()
