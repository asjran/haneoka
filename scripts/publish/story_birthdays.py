"""Add native birthday metadata to selected current story read models."""
from __future__ import annotations

import base64
import copy
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.story_birthdays import enrich_story_birthdays
from core.config import load_server_config
from core.manifests import stable_json, write_json
from core.storage import fnv1a32_shard
from publish.band_descriptions import document, entry_json, publish
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files

TABLES = {"MasterStoryLoginLanding", "MasterStoryChapter", "MasterStoryEpisode", "MasterAdv", "MasterCharacter"}
EPISODE_FIELDS = {"birthday", "storyCategory", "publishedAt"}
CHAPTER_FIELDS = {"isSpecialStory", "storyCategory"}


def timestamp(value):
    # Same native civil-time interpretation as build.api._timestamp.
    text = str(value or "").strip().replace("/", "-")
    try:
        text = re.sub(r" (\d):", r" 0\1:", text)
        milliseconds = int(datetime.fromisoformat(text).replace(tzinfo=timezone(timedelta(hours=9))).timestamp() * 1000)
    except ValueError:
        milliseconds = 0
    return [milliseconds, None, None, None, None]


def derive(index, projection):
    updated = copy.deepcopy(index)
    chapters, episodes = updated["chapters"], updated["episodes"]
    for row in projection["tables"]["MasterStoryChapter"]:
        key = str(row["_id"])
        if key in chapters:
            chapters[key]["isSpecialStory"] = row.get("_isSpecialStory") is True
    data = SimpleNamespace(server=projection["identity"]["server"], rows=lambda table: projection["tables"][table])
    updated["birthdayStories"] = enrich_story_birthdays(data, chapters, episodes, timestamp)
    if set(episodes) != set(index["episodes"]) or set(chapters) != set(index["chapters"]):
        raise ValueError("birthday projection changed story membership")
    for collection, fields in (("episodes", EPISODE_FIELDS), ("chapters", CHAPTER_FIELDS)):
        for key, row in updated[collection].items():
            if {k: v for k, v in row.items() if k not in fields} != {k: v for k, v in index[collection][key].items() if k not in fields}:
                raise ValueError("birthday projection changed an unrelated field")
    return updated


def patch_episode(original, summary):
    updated = copy.deepcopy(original)
    for field in EPISODE_FIELDS:
        if field in summary:
            updated[field] = summary[field]
    if {k: v for k, v in updated.items() if k not in EPISODE_FIELDS} != {k: v for k, v in original.items() if k not in EPISODE_FIELDS}:
        raise ValueError("story text, commands or assets changed")
    return updated


def partition_path(descriptor, identifier):
    if descriptor.get("algorithm") != "fnv1a32-mod-256" or descriptor.get("valueMode", "records") != "records":
        raise ValueError("unsupported story partition contract")
    shard = fnv1a32_shard(identifier)
    if shard not in descriptor["shards"]:
        raise ValueError("required existing story shard absent")
    path = descriptor["prefix"] + shard + ".json"
    if not re.fullmatch(r"api/v1/catalog/stories/(entities|relations/character)/[a-f0-9]{2}\.json", path):
        raise ValueError("story partition escaped selected path scope")
    return path


def prepare(store, config, projection, staging):
    if (projection.get("schema") != "haneoka-current-birthday-story-input-v1"
            or set(projection.get("originalMasterSHA256", {})) != TABLES
            or set(projection.get("tables", {})) != TABLES):
        raise ValueError("birthday input requires exactly five native tables and digests")
    identity = projection["identity"]
    if identity["server"] != config.id or config.id not in {"intl", "jp"}:
        raise ValueError("birthday projection server mismatch")
    pointer_key = f"servers/{config.id}/current.json"
    head = store.head(pointer_key)
    pointer = document(store, pointer_key, 4096)
    if any(pointer.get(field) != identity[field] for field in ("releaseId", "sourceId")):
        raise ValueError("current changed since selected birthday input; refresh exact input")
    manifest_key = f"servers/{config.id}/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("invalid parent manifest key")
    base = document(store, manifest_key)
    records = _validate_release_manifest_for_gc(base, manifest_key, config.id, identity["releaseId"])
    if base["sourceId"] != identity["sourceId"]:
        raise ValueError("parent source mismatch")
    entries = {row["path"]: row for row in records}
    for table, digest in projection["originalMasterSHA256"].items():
        if entries[f"game-client/master/{table}.bin"]["sha256"] != digest:
            raise ValueError("birthday input differs from selected original Master identity")
    catalog = entry_json(store, entries["api/v1/catalog/manifest.json"])
    descriptor = catalog["resources"]["stories"]
    if descriptor["index"] != "api/v1/catalog/stories/index.json":
        raise ValueError("unexpected stories index path")
    index = entry_json(store, entries[descriptor["index"]], 4 * 1024 * 1024)
    updated = derive(index, projection)
    # Every changed JSON starts from verified CAS bytes; other shard members stay intact.
    selected = {}
    def select(path, maximum=8 * 1024 * 1024):
        if path not in selected:
            original = entry_json(store, entries[path], maximum)
            selected[path] = (original, copy.deepcopy(original))
        return selected[path][1]
    selected[descriptor["index"]] = (index, updated)
    affected = {key for key in index["episodes"] if updated["episodes"][key] != index["episodes"][key]}
    preservation = []
    relation = descriptor["relations"]["character"]
    birthday_keys = {row["storyKey"] for rows in updated["birthdayStories"].values() for row in rows}
    for key in sorted(affected | birthday_keys):
        path = partition_path(descriptor["entities"], key)
        shard = select(path)
        original = shard[key]
        # Index summaries must agree with the full entity on the fields being added.
        if {k: v for k, v in original.items() if k not in {"commands", "assets"}} != index["episodes"][key]:
            raise ValueError("parent story summary differs from full entity")
        if updated["episodes"][key].get("birthday", {}).get("characterId") not in original.get("characterIds", []):
            raise ValueError("birthday character lacks an existing story relation")
        shard[key] = patch_episode(original, updated["episodes"][key])
        preservation.append({"storyKey": key, "commandsAssetsSHA256": hashlib.sha256(stable_json({field: original.get(field) for field in ("commands", "assets")}).encode()).hexdigest(), "unchanged": True})
        for character in sorted({str(i) for i in original.get("characterIds", [])}):
            relation_shard = select(partition_path(relation, character))
            if relation_shard[character][key] != index["episodes"][key]:
                raise ValueError("parent character relation summary differs")
            relation_shard[character][key] = copy.deepcopy(updated["episodes"][key])
    # Existing archive readers retain the same full entities; never compile a compact index.
    archive_path = "api/stories.json"
    if archive_path in entries:
        archive = select(archive_path, 64 * 1024 * 1024)
        archive["birthdayStories"] = copy.deepcopy(updated["birthdayStories"])
        for key in affected:
            archive["episodes"][key] = patch_episode(archive["episodes"][key], updated["episodes"][key])
        for key, chapter in updated["chapters"].items():
            for field in CHAPTER_FIELDS:
                if field in chapter:
                    archive["chapters"][key][field] = copy.deepcopy(chapter[field])
    for path, (original, value) in selected.items():
        if value != original:
            write_json(staging / path, value)
    changed = release_entries(staging)
    allowed = {path for path, (original, value) in selected.items() if value != original}
    if {row["path"] for row in changed} != allowed:
        raise ValueError("birthday projection escaped selected entries")
    reused = [row for row in records if row["path"] not in allowed]
    result = {"pointer": pointer, "pointerETag": head["ETag"], "sourceId": identity["sourceId"],
              "noOp": not changed, "birthdayStories": updated["birthdayStories"], "preservation": preservation,
              "changedEntries": changed, "reusedEntryCount": len(reused)}
    if changed:
        manifest = write_release_identity_files(staging, config.id, identity["sourceId"], sorted(reused + changed, key=lambda row: row["path"]))
        checked = _validate_release_manifest_for_gc(manifest, f"servers/{config.id}/releases/{manifest['releaseId']}/release.json", config.id, manifest["releaseId"])
        if {row["path"]: row for row in checked if row["path"] not in allowed} != {row["path"]: row for row in reused}:
            raise ValueError("unrelated CAS identity changed")
        result["manifest"] = manifest
    return result


def verify_public(receipt, expected, output):
    proofs = []
    keys = ["stories"] + [f"stories/{row['storyKey']}" for rows in expected.values() for row in rows]
    keys += [f"stories/relations/character/{character}" for character in expected]
    for key in keys:
        url = f"https://haneoka.org/api/v1/servers/{receipt['server']}/{key}?release={receipt['releaseId']}"
        with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}), timeout=30) as response:
            if response.headers.get("X-Haneoka-Release-Id") != receipt["releaseId"] or response.headers.get("X-Haneoka-Source-Id") != receipt["sourceId"]:
                raise ValueError("birthday public readback pin differs")
            body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise ValueError("birthday public readback exceeds budget")
            value = json.loads(body)
            if key == "stories":
                if value.get("birthdayStories") != expected:
                    raise ValueError("public birthday index differs")
            else:
                relation = "/relations/" in key
                candidates = value if relation else {key.split("/")[1]: value}
                rows = expected.get(key.split("/")[-1], []) if relation else [row for rows in expected.values() for row in rows if row["storyKey"] == key.split("/")[1]]
                for row in rows:
                    episode = candidates[row["storyKey"]]
                    if episode.get("birthday") != row["birthday"] or episode.get("storyCategory") != "birthday":
                        raise ValueError("public birthday entity or relation differs")
                    if not relation:
                        digest = hashlib.sha256(stable_json({field: episode.get(field) for field in ("commands", "assets")}).encode()).hexdigest()
                        proof = next(item for item in receipt["commandsAssetsPreserved"] if item["storyKey"] == row["storyKey"])
                        if digest != proof["commandsAssetsSHA256"]:
                            raise ValueError("public story commands or assets differ from preserved parent")
            proofs.append({"path": key, "HTTP": response.status, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
    write_json(output / "public-readback.json", proofs)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    pin = os.environ["PRODUCER_PIN"]
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("birthday producer pin mismatch")
    packed = os.environ["BIRTHDAY_INPUT_GZIP_BASE64"]
    if len(packed) > 60 * 1024:
        raise ValueError("birthday dispatch input size cap")
    with gzip.GzipFile(fileobj=io.BytesIO(base64.b64decode(packed, validate=True))) as stream:
        body = stream.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise ValueError("birthday decompressed input size cap")
    projection = json.loads(body)[os.environ["RESOURCE_SERVER"]]
    config = load_server_config(projection["identity"]["server"])
    store = R2Store(config, concurrency=4)
    with tempfile.TemporaryDirectory(prefix="current-story-birthday-") as directory:
        staging = Path(directory)
        prepared = prepare(store, config, projection, staging)
        receipt = {"schema": "haneoka-current-story-birthday-receipt-v1", "producerPin": pin,
                   "server": config.id, "sourceId": prepared["sourceId"], "baseReleaseId": prepared["pointer"]["releaseId"],
                   "releaseId": prepared.get("manifest", prepared["pointer"])["releaseId"],
                   "inputSHA256": hashlib.sha256(body).hexdigest(), "originalMasterSHA256": projection["originalMasterSHA256"],
                   "noOp": prepared["noOp"], "published": False, "rawBuildRun": False,
                   "changedPaths": [row["path"] for row in prepared["changedEntries"]],
                   "changedBytes": sum(row["bytes"] for row in prepared["changedEntries"]),
                   "reusedEntries": prepared["reusedEntryCount"], "commandsAssetsPreserved": prepared["preservation"],
                   "birthdayStories": prepared["birthdayStories"], "catalogDescriptorUnchanged": True,
                   "recipe": "native-story-birthday-current-v1", "pipelineFingerprintPreserved": True}
        write_json(args.output / "publication-receipt.json", receipt)
        if not prepared["noOp"] and os.environ.get("PUBLISH") == "true":
            receipt["pointer"] = publish(store, config, prepared, staging)
            receipt["published"] = True
            write_json(args.output / "publication-receipt.json", receipt)
        if receipt["published"] or receipt["noOp"]:
            verify_public(receipt, prepared["birthdayStories"], args.output)
        print(stable_json(receipt))


if __name__ == "__main__":
    main()
