"""Refresh the operational in-game announcement snapshot independently of releases."""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

# Allow direct execution from the repository root as well as the workflow's
# PYTHONPATH=scripts invocation.
_SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from build.announcements import (
    PUBLIC_BASE_URL,
    AnnouncementCollection,
    collect_announcements,
    package_client_version,
    public_announcement_document,
)
from core.config import ServerConfig, load_server_config
from core.manifests import stable_json
from core.paths import safe_id
from publish.r2 import IMMUTABLE_CACHE, R2Store


OPERATION_PREFIX = "operation"
SNAPSHOT_CACHE = "public, max-age=60, must-revalidate"


def _media_key(server: str, filename: str) -> str:
    return f"servers/{server}/{OPERATION_PREFIX}/announcements/media/{filename}"


def _media_matches(metadata: dict[str, Any] | None, asset: Any) -> bool:
    if not metadata:
        return False
    object_metadata = metadata.get("Metadata")
    digest = (
        object_metadata.get("sha256") if isinstance(object_metadata, dict) else None
    )
    return (
        metadata.get("ContentLength") == asset.file.stat().st_size
        and digest == asset.digest
    )


def _upload_media(
    store: R2Store, server: str, collection: AnnouncementCollection
) -> tuple[int, int]:
    uploaded = 0
    reused = 0
    for asset in sorted(collection.media, key=lambda value: value.filename):
        key = _media_key(server, asset.filename)
        if _media_matches(store.head(key), asset):
            reused += 1
            continue
        store.upload_path(
            asset.file,
            key,
            asset.content_type,
            cache_control=IMMUTABLE_CACHE,
            metadata={"sha256": asset.digest},
        )
        uploaded += 1
    return uploaded, reused


def _source_client_version(
    store: R2Store, config: ServerConfig, source_id: str | None
) -> str:
    if source_id is None:
        pointer = store.get_json(f"servers/{config.id}/current.json")
        source_id = str((pointer or {}).get("sourceId") or "")
    if not source_id:
        raise ValueError(f"no current package source is selected for {config.id}")
    source_id = safe_id(source_id, "source id")
    manifest = store.get_json(
        f"servers/{config.id}/sources/{source_id}/source.json"
    )
    return package_client_version(manifest, config.package_name)


def publish_announcements(
    store: R2Store,
    config: ServerConfig,
    *,
    source_id: str | None = None,
    base_url: str = PUBLIC_BASE_URL,
    work_dir: Path | None = None,
) -> dict[str, Any]:
    """Fetch, upload media, then replace the list document as one publication."""

    snapshot_key = f"servers/{config.id}/{OPERATION_PREFIX}/announcements.json"
    previous = store.get_json(snapshot_key)
    if work_dir is not None:
        work_dir.mkdir(parents=True, exist_ok=True)
    temporary_root = Path(
        tempfile.mkdtemp(prefix=f"haneoka-announcements-{config.id}-", dir=work_dir)
    )
    try:
        client_version = (
            _source_client_version(store, config, source_id)
            if config.announcements_regions
            else None
        )
        collection = collect_announcements(
            config,
            temporary_root / "media",
            client_version=client_version,
        )
        document = public_announcement_document(collection, config.id, base_url)
        uploaded, reused = _upload_media(store, config.id, collection)
        # The list document is the commit point. Every referenced media object is
        # already available before this overwrite starts.
        store.put_json(snapshot_key, document, SNAPSHOT_CACHE)
        return {
            "schema": "haneoka-announcements-publication-v1",
            "server": config.id,
            "available": True,
            "announcements": len(document["announcements"]),
            "mediaUploaded": uploaded,
            "mediaReused": reused,
            "snapshotKey": snapshot_key,
        }
    except Exception as exc:  # noqa: BLE001 - the operational feed preserves its previous commit
        return {
            "schema": "haneoka-announcements-publication-v1",
            "server": config.id,
            "available": isinstance(previous, dict)
            and previous.get("available") is True,
            "announcements": len(previous.get("announcements", []))
            if isinstance(previous, dict)
            else 0,
            "preserved": isinstance(previous, dict),
            "snapshotKey": snapshot_key,
            "error": type(exc).__name__,
            "reason": str(exc),
        }
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Refresh the operational announcement snapshot without rebuilding a resource release."
    )
    parser.add_argument("--server", default="intl")
    parser.add_argument("--source")
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--base-url", default=PUBLIC_BASE_URL)
    args = parser.parse_args()
    config = load_server_config(args.server)
    result = publish_announcements(
        R2Store(config, args.concurrency),
        config,
        source_id=args.source,
        base_url=args.base_url,
        work_dir=args.work_dir,
    )
    print(stable_json(result, pretty=True), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
