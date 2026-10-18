"""Restore declared event-chapter icons without rebuilding the resource release."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.config import load_server_config
from core.manifests import stable_json, write_json
from publish.band_descriptions import document, entry_json, publish
from publish.gacha_rates import raw_table
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files

TABLES = {"MasterStoryChapter", "MasterEvent"}
INDEX = "api/v1/catalog/stories/index.json"
RECIPE = "native-current-event-chapter-icon-v1"


def derive(original, chapters, events, selected, server, asset_paths):
    if (not isinstance(selected, list) or not 1 <= len(selected) <= 8
            or any(type(i) is not int or i <= 0 for i in selected)
            or len(set(selected)) != len(selected)):
        raise ValueError("select one to eight unique native chapter IDs")
    native = {row["_id"]: row for row in chapters}
    if len(native) != len(chapters):
        raise ValueError("native chapter IDs are repeated")
    updated, restored, proof = copy.deepcopy(original), [], []
    for chapter_id in selected:
        key = str(chapter_id)
        chapter = updated.get("chapters", {}).get(key)
        if chapter_id not in native or not isinstance(chapter, dict) or chapter.get("chapterId") != chapter_id:
            raise ValueError("selected chapter differs from original Master")
        related = [row for row in events if row.get("_storyChapterId") == chapter_id]
        if len(related) != 1 or type(related[0].get("_id")) is not int or related[0]["_id"] <= 0:
            raise ValueError("selected chapter needs one exact MasterEvent relationship")
        event_id = related[0]["_id"]
        event_rows = [row for row in updated.get("storyEvents", []) if row.get("chapterId") == chapter_id]
        if len(event_rows) != 1 or event_rows[0].get("eventId") != event_id or chapter.get("eventId") != event_id:
            raise ValueError("current story event relationship differs from MasterEvent")
        if chapter.get("icon"):
            continue
        name = native[chapter_id].get("_icon")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise ValueError("native chapter icon locator is invalid")
        authored = f"Assets/AddressableResources/Story/Icon/{name}.png"
        fallback = f"Assets/AddressableResources/Story/Icon/ui_icon_chapter_event_{event_id:05d}.png"
        source = next((path for path in (authored, fallback) if path in asset_paths), None)
        if source is None:
            raise ValueError("neither authored nor related event icon is declared")
        icon = f"/assets/{server}/{source}"
        if event_rows[0].get("icon") not in (None, "", icon):
            raise ValueError("current event icon conflicts with its selected chapter")
        chapter["icon"] = event_rows[0]["icon"] = icon
        restored.append({"chapterId": chapter_id, "eventId": event_id, "authoredSource": authored,
                         "sourcePath": source, "icon": icon})
        proof.append((key, event_id))
    # Remove exactly the restored fields; every other value must remain identical.
    before, after = copy.deepcopy(original), copy.deepcopy(updated)
    for key, event_id in proof:
        before["chapters"][key].pop("icon", None)
        after["chapters"][key].pop("icon", None)
        for value in (before, after):
            next(row for row in value["storyEvents"] if row.get("eventId") == event_id).pop("icon", None)
    if stable_json(before) != stable_json(after):
        raise ValueError("story projection changed a non-selected icon field")
    return updated, restored, hashlib.sha256(stable_json(before).encode()).hexdigest()


def validate_source(descriptor, source, asset):
    if descriptor.get("schema") != "haneoka-unity-source-v1" or descriptor.get("sourcePath") != source:
        raise ValueError("event icon source descriptor identity differs")
    outputs = [row for row in descriptor.get("outputs", []) if row.get("path") == asset["path"]]
    if len(outputs) != 1 or any(outputs[0].get(key) != asset[key] for key in ("bytes", "sha256")):
        raise ValueError("event icon output differs from the declared release asset")


def prepare(store, config, projection, staging):
    if projection.get("recipe") != RECIPE:
        raise ValueError("chapter artwork recipe differs from the reviewed projection")
    identity = projection["identity"]
    if config.id not in {"intl", "jp"} or identity.get("server") != config.id:
        raise ValueError("current chapter artwork server mismatch")
    pointer_key = f"servers/{config.id}/current.json"
    head, pointer = store.head(pointer_key), document(store, pointer_key, 4096)
    if not head or any(pointer.get(k) != identity[k] for k in ("releaseId", "sourceId")):
        raise ValueError("current changed before chapter artwork preparation")
    manifest_key = f"servers/{config.id}/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("current release manifest path differs")
    base = document(store, manifest_key)
    records = _validate_release_manifest_for_gc(base, manifest_key, config.id, identity["releaseId"])
    if base["sourceId"] != identity["sourceId"]:
        raise ValueError("current source identity differs")
    entries = {row["path"]: row for row in records}
    expected = projection.get("originalMasterSHA256", {})
    if set(expected) != TABLES:
        raise ValueError("chapter artwork requires two reviewed original Master identities")
    tables, master_entries = {}, {}
    for name in sorted(TABLES):
        entry = entries[f"game-client/master/{name}.bin"]
        if entry["sha256"] != expected[name]:
            raise ValueError("current original Master differs from reviewed bytes")
        tables[name] = raw_table(store, entry, name, config.master_crypto)
        master_entries[name] = entry
    catalog = entry_json(store, entries["api/v1/catalog/manifest.json"], 256 * 1024)
    if catalog.get("server") != config.id or catalog.get("sourceId") != identity["sourceId"]:
        raise ValueError("catalog source identity differs")
    if catalog["resources"]["stories"]["index"] != INDEX:
        raise ValueError("current stories index path differs")
    original = entry_json(store, entries[INDEX], 8 * 1024 * 1024)
    assets = {path.removeprefix("assets/") for path in entries if path.startswith("assets/")}
    updated, restored, preserved = derive(original, tables["MasterStoryChapter"], tables["MasterEvent"],
                                         projection["chapterIds"], config.id, assets)
    for row in restored:
        source = row["sourcePath"]
        descriptor = entry_json(store, entries[f"metadata/sources/{source}.json"], 64 * 1024)
        validate_source(descriptor, source, entries[f"assets/{source}"])
    result = {"pointer": pointer, "pointerETag": head["ETag"], "sourceId": identity["sourceId"],
              "noOp": updated == original, "restored": restored, "MasterEntries": master_entries,
              "preservedFieldsSHA256": preserved}
    if updated == original:
        result.update(changedEntries=[], reusedEntryCount=len(records))
        return result
    write_json(staging / INDEX, updated)
    # Older releases may retain the full API archive in addition to the read model.
    selected = {INDEX}
    if "api/stories.json" in entries:
        archive = entry_json(store, entries["api/stories.json"], 256 * 1024 * 1024)
        value, archive_restored, _ = derive(archive, tables["MasterStoryChapter"], tables["MasterEvent"],
                                           projection["chapterIds"], config.id, assets)
        if archive_restored != restored:
            raise ValueError("legacy story archive icon projection differs")
        write_json(staging / "api/stories.json", value)
        selected.add("api/stories.json")
    changed = release_entries(staging)
    if {row["path"] for row in changed} != selected:
        raise ValueError("chapter artwork escaped selected story document paths")
    reused = [row for row in records if row["path"] not in selected]
    manifest = write_release_identity_files(staging, config.id, identity["sourceId"],
                                            sorted(reused + changed, key=lambda row: row["path"]))
    checked = _validate_release_manifest_for_gc(manifest,
        f"servers/{config.id}/releases/{manifest['releaseId']}/release.json", config.id, manifest["releaseId"])
    if {row["path"]: row for row in checked if row["path"] not in selected} != {row["path"]: row for row in reused}:
        raise ValueError("unrelated catalog, runtime or asset identities changed")
    result.update(manifest=manifest, changedEntries=changed, reusedEntryCount=len(reused))
    return result


def verify_public(receipt, restored, output):
    url = f"https://haneoka.org/api/v1/servers/{receipt['server']}/stories?release={receipt['releaseId']}"
    with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0 HaneokaChapterArtwork"}), timeout=30) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
        if (response.status != 200 or len(raw) > 8 * 1024 * 1024
                or response.headers.get("X-Haneoka-Release-Id") != receipt["releaseId"]
                or response.headers.get("X-Haneoka-Source-Id") != receipt["sourceId"]):
            raise ValueError("public story artwork release identity differs")
    if hashlib.sha256(raw).hexdigest() != next(row['sha256'] for row in receipt['changedEntries'] if row['path'] == INDEX):
        raise ValueError('public story index differs from the complete prepared document')
    identity_url = f"https://haneoka.org/api/v1/servers/{receipt['server']}/release?projection=identity"
    with urlopen(Request(identity_url, headers={'User-Agent': 'Mozilla/5.0 HaneokaChapterArtwork'}), timeout=30) as response:
        identity = json.loads(response.read(4097))
    if any(identity.get(key) != receipt[key] for key in ('releaseId', 'sourceId')):
        raise ValueError('public current differs after chapter artwork promotion')
    value = json.loads(raw)
    for row in restored:
        chapter = value["chapters"][str(row["chapterId"])]
        event = next(item for item in value["storyEvents"] if item["eventId"] == row["eventId"])
        if chapter.get("icon") != row["icon"] or event.get("icon") != row["icon"]:
            raise ValueError("public chapter or event icon differs from prepared bytes")
    write_json(output / "public-readback.json", {"url": url, "HTTP": 200, "bytes": len(raw),
               "sha256": hashlib.sha256(raw).hexdigest(), "restored": restored})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = os.environ["PRODUCER_PIN"]
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("chapter artwork producer commit pin differs")
    packed = os.environ["STORY_ARTWORK_CURRENT_PROJECTION_JSON"]
    if len(packed.encode()) > 8192:
        raise ValueError("chapter artwork projection exceeds input cap")
    projection = json.loads(packed)
    if projection["identity"]["server"] != os.environ["RESOURCE_SERVER"]:
        raise ValueError("chapter artwork input server differs")
    config = load_server_config(os.environ["RESOURCE_SERVER"])
    store = R2Store(config, concurrency=4)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="current-story-chapter-artwork-") as directory:
        staging = Path(directory)
        prepared = prepare(store, config, projection, staging)
        receipt = {"schema": "haneoka-current-story-chapter-artwork-receipt-v1", "recipe": RECIPE,
                   "producerPin": pin, "server": config.id, "sourceId": prepared["sourceId"],
                   "baseReleaseId": prepared["pointer"]["releaseId"],
                   "releaseId": prepared.get("manifest", prepared["pointer"])["releaseId"],
                   "noOp": prepared["noOp"], "restored": prepared["restored"],
                   "changedEntries": prepared["changedEntries"], "reusedEntries": prepared["reusedEntryCount"],
                   "preservedFieldsSHA256": prepared["preservedFieldsSHA256"], "MasterEntries": prepared["MasterEntries"],
                   "published": False, "promoted": False, "rawBuildRun": False}
        write_json(args.output / "publication-receipt.json", receipt)
        if not prepared["noOp"] and os.environ.get("PUBLISH") == "true":
            receipt["pointer"] = publish(store, config, prepared, staging)
            receipt.update(published=True, promoted=True)
            write_json(args.output / "publication-receipt.json", receipt)
            verify_public(receipt, prepared["restored"], args.output)
        if receipt["promoted"] and os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write("release_promoted=true\n")
        print(json.dumps({key: receipt[key] for key in ("server", "baseReleaseId", "releaseId", "noOp", "published")}))


if __name__ == "__main__":
    main()
