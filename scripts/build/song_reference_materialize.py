"""Read only the inputs for a reference from an existing immutable R2 release."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from botocore.exceptions import ClientError

from build.team_builder_data import RUNTIME_TABLES
from core.config import PROJECT_ROOT, load_server_config, validate_server_id
from core.contracts import RELEASE_IDENTITY_SCHEMA
from core.manifests import write_json
from core.paths import safe_id, validate_release_path
from core.storage import cas_key
from publish.r2 import R2Store, _validate_release_manifest_for_gc

RESOURCES = (
    "cards", "support-cards", "characters", "bands", "band-items", "songs", "events",
    "progression", "leader-skills", "skills", "gekisou-skills", "support-skills",
    "gekisou-support-skills", "skill-reference", "live-tools", "gekisou",
)
MAX_JSON_BYTES = 64 * 1024 * 1024


def stage_reference_inputs(
    store: R2Store, identity: dict[str, str], root: Path,
) -> dict[str, Any]:
    """Use the existing R2 client and manifest validator; never read current."""
    prefix = f"servers/{identity['server']}/releases/{identity['releaseId']}/"

    def descriptor(name: str, maximum: int) -> dict[str, Any]:
        key = prefix + name
        head = store.head(key)
        if head is None or head.get("ContentLength", maximum + 1) > maximum:
            raise ValueError(f"reference release descriptor unavailable or too large: {name}")
        value = store.get_json(key)
        if not isinstance(value, dict):
            raise ValueError(f"reference release descriptor must be an object: {name}")
        return value

    actual_identity = descriptor("release-identity.json", 4096)
    if actual_identity != {"schema": RELEASE_IDENTITY_SCHEMA, **identity}:
        raise ValueError("reference remote release identity mismatch")
    manifest = descriptor("release.json", MAX_JSON_BYTES)
    records = _validate_release_manifest_for_gc(manifest, prefix + "release.json", identity["server"], identity["releaseId"])
    if manifest["sourceId"] != identity["sourceId"]:
        raise ValueError("reference remote manifest source mismatch")
    entries = {entry["path"]: entry for entry in records}
    root.mkdir(parents=True, exist_ok=True)
    write_json(root / "release-identity.json", actual_identity)
    write_json(root / "release.json", manifest)
    downloaded: set[str] = set()
    missing_charts: list[str] = []

    def download(relative: str, missing_allowed: bool = False) -> bool:
        relative = validate_release_path(relative)
        entry = entries.get(relative)
        if entry is None:
            if missing_allowed:
                return False
            raise ValueError(f"reference release input is not declared: {relative}")
        maximum = 2 * 1024 * 1024 if relative.startswith("assets/") else MAX_JSON_BYTES
        if entry["bytes"] > maximum:
            raise ValueError(f"reference release input exceeds byte limit: {relative}")
        try:
            store.download_file(cas_key(entry["sha256"]), root / relative,
                                expected_bytes=entry["bytes"], expected_sha256=entry["sha256"])
        except ClientError as error:
            if missing_allowed and error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                return False
            raise
        return True

    def batch(paths: set[str], missing_allowed: bool = False) -> None:
        pending = sorted(paths - downloaded)
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = executor.map(lambda relative: download(relative, missing_allowed), pending)
            for relative, present in zip(pending, results):
                if present:
                    downloaded.add(relative)
                elif missing_allowed:
                    missing_charts.append(relative)

    batch({"api/v1/catalog/manifest.json"})
    catalog = json.loads((root / "api/v1/catalog/manifest.json").read_text("utf8"))
    if (catalog.get("schema"), catalog.get("server"), catalog.get("sourceId")) != (
        "haneoka-catalog-storage-v2", identity["server"], identity["sourceId"],
    ):
        raise ValueError("reference remote catalogue identity mismatch")
    paths: set[str] = set()
    for name in RESOURCES:
        resource = catalog["resources"][name]
        paths.add(resource["index"])
        if name in {"cards", "support-cards", "songs", "events"}:
            entities = resource.get("entities")
            if entities:
                if entities.get("algorithm") != "fnv1a32-mod-256":
                    raise ValueError("reference catalogue entity partition mismatch")
                for shard in entities["shards"]:
                    if not re.fullmatch(r"[a-f0-9]{2}", shard):
                        raise ValueError("reference catalogue entity shard invalid")
                    paths.add(f"{entities['prefix']}{shard}.json")
    paths.update(f"objects/master/{table}.json" for table in RUNTIME_TABLES.values())
    batch(paths)
    songs = json.loads((root / catalog["resources"]["songs"]["index"]).read_text("utf8"))
    chart_paths: set[str] = set()
    asset_prefix = f"/assets/{identity['server']}/"
    for song in songs.values():
        for row in song.get("difficulty", []):
            file = row.get("file")
            if isinstance(file, str) and file.startswith(asset_prefix):
                chart_paths.add("assets/" + file[len(asset_prefix):])
    batch(chart_paths, missing_allowed=True)
    return {
        "identity": identity, "downloadedFiles": len(downloaded),
        "downloadedBytes": sum(entries[relative]["bytes"] for relative in downloaded),
        "missingChartPaths": missing_charts,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("server", "release", "source", "recipe", "calculated-at", "output"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--max-ms", type=int, default=60000)
    parser.add_argument("--release-root", type=Path, help="Use an existing local pin instead of reading R2")
    args = parser.parse_args()
    server = validate_server_id(args.server)
    if not re.fullmatch(r"r-[a-f0-9]{20}", args.release):
        raise ValueError("invalid reference release id")
    source = safe_id(args.source, "reference source id")
    identity = {"server": server, "releaseId": args.release, "sourceId": source}
    recipe = Path(args.recipe).resolve()
    output = Path(args.output).resolve()

    def materialize(root: Path) -> None:
        command = [
            "node", str(PROJECT_ROOT / "scripts/build/song_reference_request.ts"),
            "--server", server, "--release", args.release, "--source", source,
            "--release-root", str(root.resolve()), "--recipe", str(recipe),
            "--calculated-at", args.calculated_at, "--max-ms", str(args.max_ms), "--output", str(output),
        ]
        subprocess.run(command, cwd=PROJECT_ROOT, check=True, timeout=180)

    if args.release_root:
        materialize(args.release_root)
    else:
        store = R2Store(load_server_config(server), concurrency=4)
        with tempfile.TemporaryDirectory(prefix="haneoka-reference-inputs-") as temporary:
            root = Path(temporary) / args.release
            report = stage_reference_inputs(store, identity, root)
            materialize(root)
            print(json.dumps({"staging": report}, ensure_ascii=False))


if __name__ == "__main__":
    main()
