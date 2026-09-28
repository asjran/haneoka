"""Shared delta-build context: one validated plan plus one pinned base release.

A delta build never re-derives outputs whose inputs are byte-identical to the
base release.  Every stage receives a :class:`DeltaContext` that answers two
questions — *is this bundle reusable?* and *where do its already-published
outputs live?* — and can fetch any single base artifact (report, archive,
media, stage document) from the content-addressed store with full hash
verification.  The plan pins the base release id once, so every stage in one
run composes against exactly the same base.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any

from core.paths import validate_release_path

PLAN_SCHEMA = "haneoka-unity-delta-plan-v1"
PLAN_FILENAME = "unity-delta-plan.json"


def load_plan(path: Path) -> dict[str, Any]:
    """Load and structurally validate a delta plan produced by prepare-unity-reuse."""

    document = json.loads(path.read_text("utf-8"))
    if not isinstance(document, dict) or document.get("schema") != PLAN_SCHEMA:
        raise ValueError(f"invalid delta plan schema: {path}")
    for field in ("server", "sourceId", "baseReleaseId", "extractor"):
        if not isinstance(document.get(field), str) or not document[field]:
            raise ValueError(f"delta plan is missing {field}: {path}")
    if not isinstance(document.get("shardCount"), int) or document["shardCount"] < 1:
        raise ValueError(f"delta plan has an invalid shardCount: {path}")
    bundles = document.get("bundles")
    pending = document.get("pending")
    if not isinstance(bundles, dict) or not isinstance(pending, dict):
        raise ValueError(f"delta plan must declare bundles and pending maps: {path}")
    for digest, entry in bundles.items():
        _validate_digest(digest)
        _validate_artifact(entry.get("report"), f"plan report {digest}")
        _validate_artifact(entry.get("archive"), f"plan archive {digest}")
        if not isinstance(entry.get("media"), list):
            raise ValueError(f"delta plan bundle entry has no media list: {digest}")
        for media in entry["media"]:
            if not isinstance(media, dict) or not isinstance(media.get("rel"), str):
                raise ValueError(f"delta plan media entry is invalid: {digest}")
            if (
                not isinstance(media.get("sha256"), str)
                or len(str(media.get("sha256"))) != 64
                or not isinstance(media.get("bytes"), int)
                or isinstance(media.get("bytes"), bool)
                or media["bytes"] < 0
            ):
                raise ValueError(f"delta plan media artifact is invalid: {digest}")
            validate_release_path(media["rel"])
        shard = entry.get("shardIndex")
        if not isinstance(shard, int) or isinstance(shard, bool) or not 0 <= shard < document["shardCount"]:
            raise ValueError(f"delta plan bundle has an invalid shard index: {digest}")
    for digest, shard in pending.items():
        _validate_digest(digest)
        if not isinstance(shard, int) or isinstance(shard, bool) or not 0 <= shard < document["shardCount"]:
            raise ValueError(f"delta plan pending entry has an invalid shard index: {digest}")
    overlap = bundles.keys() & pending.keys()
    if overlap:
        raise ValueError(f"delta plan digest is both reusable and pending: {sorted(overlap)[:5]}")
    return document


def _validate_digest(value: object) -> str:
    import re

    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError(f"delta plan contains an invalid digest: {value!r}")
    return value


def _validate_artifact(value: object, label: str) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("path"), str)
        or not isinstance(value.get("sha256"), str)
        or len(str(value.get("sha256"))) != 64
        or not isinstance(value.get("bytes"), int)
        or isinstance(value.get("bytes"), bool)
        or value["bytes"] < 0
    ):
        raise ValueError(f"delta plan artifact is invalid: {label}")
    return value  # type: ignore[return-value]


class DeltaContext:
    """Read-only view of the pinned base release plus the current run's plan."""

    def __init__(self, store: Any, server: str, plan: dict[str, Any]):
        if plan.get("server") != server:
            raise ValueError("delta plan server does not match the build server")
        self.store = store
        self.server = server
        self.plan = plan
        self.base_release_id = str(plan["baseReleaseId"])
        self._manifest: dict[str, Any] | None = None
        self._entries: dict[str, dict[str, Any]] | None = None

    # -- plan accessors ----------------------------------------------------

    @property
    def source_id(self) -> str:
        return str(self.plan["sourceId"])

    def reusable(self, digest: str) -> bool:
        return digest in self.plan["bundles"]

    def shard_reusable(self, shard_index: int) -> dict[str, dict[str, Any]]:
        return {
            digest: entry
            for digest, entry in self.plan["bundles"].items()
            if entry["shardIndex"] == shard_index
        }

    def shard_pending(self, shard_index: int) -> list[str]:
        return sorted(
            digest for digest, shard in self.plan["pending"].items() if shard == shard_index
        )

    def plan_entry(self, digest: str) -> dict[str, Any] | None:
        return self.plan["bundles"].get(digest)

    # -- base release accessors -------------------------------------------

    def base_manifest(self) -> dict[str, Any]:
        if self._manifest is None:
            manifest = self.store.get_json(
                f"servers/{self.server}/releases/{self.base_release_id}/release.json"
            )
            if (
                not isinstance(manifest, dict)
                or manifest.get("server") != self.server
                or manifest.get("releaseId") != self.base_release_id
            ):
                raise ValueError(
                    f"base release manifest is missing or invalid: {self.base_release_id}"
                )
            self._manifest = manifest
        return self._manifest

    def entries(self) -> dict[str, dict[str, Any]]:
        if self._entries is None:
            entries: dict[str, dict[str, Any]] = {}
            for value in self.base_manifest().get("entries", []):
                if not isinstance(value, dict) or not isinstance(value.get("path"), str):
                    raise ValueError("base release manifest contains an invalid entry")
                relative = validate_release_path(value["path"])
                if relative in entries:
                    raise ValueError(f"base release manifest repeats a path: {relative}")
                entries[relative] = value
            self._entries = entries
        return self._entries

    def entry(self, path: str) -> dict[str, Any] | None:
        return self.entries().get(path)

    def require_entry(self, path: str) -> dict[str, Any]:
        entry = self.entry(path)
        if entry is None:
            raise ValueError(f"base release does not declare the reusable path: {path}")
        return entry

    def base_document(self, path: str) -> Any:
        """Fetch and verify one JSON document from the base release."""

        entry = self.require_entry(path)
        digest = str(entry["sha256"])
        body = self.store.get_bytes(_cas_key(digest))
        if body is None:
            raise FileNotFoundError(f"base release CAS object is missing: {path}")
        if len(body) != int(entry["bytes"]) or hashlib.sha256(body).hexdigest() != digest:
            raise ValueError(f"base release CAS object is invalid: {path}")
        return json.loads(body)

    # -- fetch helpers ------------------------------------------------------

    def fetch_release_path(self, path: str, target: Path) -> dict[str, Any]:
        """Restore one byte-exact base release object to ``target``."""

        entry = self.require_entry(path)
        digest = str(entry["sha256"])
        self.store.download_file(
            _cas_key(digest),
            target,
            expected_bytes=int(entry["bytes"]),
            expected_sha256=digest,
        )
        return entry

    def fetch_report(self, digest: str, target: Path) -> dict[str, Any]:
        entry = self.plan["bundles"].get(digest)
        if entry is None:
            raise ValueError(f"digest is not reusable in the delta plan: {digest}")
        return self.fetch_release_path(str(entry["report"]["path"]), target)

    def fetch_archive(self, digest: str, target: Path) -> dict[str, Any]:
        entry = self.plan["bundles"].get(digest)
        if entry is None:
            raise ValueError(f"digest is not reusable in the delta plan: {digest}")
        return self.fetch_release_path(str(entry["archive"]["path"]), target)

    def fetch_original_bundle(self, digest: str, target: Path) -> None:
        """Restore one original unity-bundle from the source CAS by content address."""

        self.store.download_file(
            _cas_key(digest),
            target,
            expected_sha256=digest,
        )

    def fetch_media(self, digest: str, target_root: Path) -> int:
        """Restore every media output declared for one reusable bundle."""

        entry = self.plan["bundles"].get(digest)
        if entry is None:
            raise ValueError(f"digest is not reusable in the delta plan: {digest}")
        for media in entry["media"]:
            self.fetch_release_path(
                str(media["rel"]),
                target_root / Path(*PurePosixPath(str(media["rel"])).parts),
            )
        return len(entry["media"])


def _cas_key(digest: str) -> str:
    from core.storage import cas_key

    return cas_key(digest)


__all__ = ["PLAN_SCHEMA", "PLAN_FILENAME", "DeltaContext", "load_plan"]
