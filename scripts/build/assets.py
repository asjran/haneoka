"""Merge Unity processing shards into one collision-checked build index."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Iterable

from core.contracts import UNITY_INDEX_SCHEMA
from core.hashes import sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import build_layout, validate_unity_path
from core.process import hardlink_or_copy, walk_files
from core.unity_objects import iter_unity_object_archive

if TYPE_CHECKING:
    from core.delta import DeltaContext


MERGE_TREES = ("objects", "metadata/bundles")
RUNTIME_PROJECTION_PREFIXES = (
    "Assets/AddressableResources/Live/",
    "Assets/AddressableResources/Effect/Live/",
)
RUNTIME_PROJECTION_TYPES = {"AnimationClip", "ParticleSystem", "Sprite", "SpriteAtlas", "SpriteRenderer"}
HUD_FONT_RUNTIME_SOURCES = {
    "Assets/AddressableResources/Font/VibeMOPro-Medium/VibeMOPro-Medium SDF.asset",
    "Packages/com.fromtokyo.sirius-asset/AddressableResources/Font/"
    "VibeMOPro-Medium/VibeMOPro-Medium SDF.asset",
}


def _merge_tree(source: Path, target: Path) -> None:
    for file in walk_files(source):
        relative = file.relative_to(source)
        output = target / relative
        if output.exists():
            if output.stat().st_size != file.stat().st_size or sha256_file(output) != sha256_file(file):
                raise ValueError(f"shard output collision: {output}")
            continue
        hardlink_or_copy(file, output)


def _tree(entries: Iterable[str]) -> dict[str, Any]:
    root: dict[str, Any] = {}
    for value in sorted(entries):
        cursor = root
        parts = PurePosixPath(value).parts
        for part in parts[:-1]:
            cursor = cursor.setdefault(part, {})
        cursor[parts[-1]] = 1
    return root


def _descriptor_path(source_path: str) -> str:
    source = PurePosixPath(source_path)
    return PurePosixPath("metadata", "sources", *source.parts[:-1], f"{source.name}.json").as_posix()


def _canonical_source(candidates: list[dict[str, Any]], reports: dict[str, dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(
        candidates,
        key=lambda item: (
            0 if item["bundleOrigin"] == "remote-catalog" else 1,
            item["bundleSha256"],
            item["bundleFilename"],
        ),
    )
    selected_origin = "remote-catalog" if any(
        item["bundleOrigin"] == "remote-catalog" for item in ordered
    ) else "embedded-package"
    eligible = [item for item in ordered if item["bundleOrigin"] == selected_origin]
    fingerprints = {item["source"]["contentSha256"] for item in eligible}
    if len(fingerprints) != 1:
        # Locale variants now carry distinct namespaced source paths, so a single
        # source path resolving to several fingerprints is a genuine conflict (e.g.
        # two bundles both claim the same `(locale)` variant with different content)
        # rather than the expected multi-locale case. Keep the first deterministically
        # and warn rather than abort the whole merge.
        sys.stderr.write(
            f"warning: Unity source path resolves to {len(eligible)} conflicting "
            f"variants; keeping first: {eligible[0]['source']['sourcePath']} "
            f"({', '.join(item['bundleFilename'] for item in eligible)})\n"
        )
        eligible = eligible[:1]
    output_by_path: dict[str, dict[str, Any]] = {}
    for candidate in eligible:
        for output in candidate["source"].get("outputs", []):
            existing = output_by_path.get(output["path"])
            if existing and existing["sha256"] != output["sha256"]:
                # Locale variants in the same shard can produce the same output path
                # with different content. Keep the first rather than aborting.
                sys.stderr.write(
                    f"warning: Unity output path collision (locale variant), keeping first: {output['path']}\n"
                )
                continue
            output_by_path.setdefault(
                output["path"],
                {**output, "bundleSha256": candidate["bundleSha256"]},
            )
    selected = eligible[0]
    report = reports[selected["bundleSha256"]]
    source_path = selected["source"]["sourcePath"]
    return {
        "schema": "haneoka-unity-source-v1",
        "sourcePath": source_path,
        "basePath": selected["source"].get("basePath") or source_path,
        "serializedFile": selected["source"]["serializedFile"],
        "contentSha256": selected["source"]["contentSha256"],
        "selectedOrigin": selected_origin,
        "rootObjects": selected["source"]["rootObjects"],
        "preloadObjects": selected["source"].get("preloadObjects", []),
        "rootObjectReferences": selected["source"].get(
            "rootObjectReferences", []
        ),
        "preloadObjectReferences": selected["source"].get(
            "preloadObjectReferences", []
        ),
        "rootTypes": selected["source"]["rootTypes"],
        "preloadObjectCount": selected["source"]["preloadObjectCount"],
        "outputs": sorted(output_by_path.values(), key=lambda item: (item["path"], item["objectId"])),
        "selectedBundle": selected["bundleSha256"],
        "candidateBundles": [
            {
                "sha256": item["bundleSha256"],
                "originalFilename": item["bundleFilename"],
                "origin": item["bundleOrigin"],
            }
            for item in ordered
        ],
        "objectArchive": report["objectArchive"],
        "descriptor": _descriptor_path(source_path),
    }


def _materialize_outputs(
    layout,
    sources: list[dict[str, Any]],
    shard_count: int,
    delta: "DeltaContext | None" = None,
) -> tuple[int, dict[str, dict[str, Any]]]:
    """Materialize Unity media into the build tree.

    In delta mode, outputs of reusable bundles are not materialized: their
    bytes stay in the base release and the release composer references them.
    Each skipped output is validated against the base release manifest entry
    (path, sha256, bytes) before it may be composed, and it still participates
    in collision detection through the ``materialized`` map.
    """

    materialized: dict[str, str] = {}
    declared: dict[str, dict[str, Any]] = {}
    for source in sources:
        for output in source["outputs"]:
            relative = str(output["path"])
            if not relative.startswith(("assets/", "runtime/")):
                raise ValueError(f"invalid Unity media output path: {relative}")
            digest = str(output["bundleSha256"])
            reusable = delta is not None and delta.reusable(digest)
            if reusable:
                existing = materialized.get(relative)
                if existing and existing != output["sha256"]:
                    raise ValueError(f"canonical Unity media output collision: {relative}")
                entry = delta.require_entry(relative)
                if (
                    str(entry.get("sha256")) != str(output["sha256"])
                    or int(entry.get("bytes", -1)) != int(output["bytes"])
                ):
                    raise ValueError(
                        f"reusable Unity media output does not match the base release: {relative}"
                    )
                declared[relative] = {
                    "path": relative,
                    "sha256": str(output["sha256"]),
                    "bytes": int(output["bytes"]),
                }
            else:
                shard_index = int(digest[:16], 16) % shard_count
                candidate = layout.shards / f"{shard_index:03d}" / "candidates" / digest / relative
                if (
                    not candidate.is_file()
                    or candidate.stat().st_size != output["bytes"]
                    or sha256_file(candidate) != output["sha256"]
                ):
                    raise ValueError(f"Unity media candidate does not match its report: {candidate}")
                existing = materialized.get(relative)
                if existing and existing != output["sha256"]:
                    raise ValueError(f"canonical Unity media output collision: {relative}")
                if existing:
                    continue
                hardlink_or_copy(candidate, layout.root / Path(*PurePosixPath(relative).parts))
            materialized[relative] = output["sha256"]
    return len(materialized), declared


def _archive_records(file: Path) -> dict[str, dict[str, dict[str, Any]]]:
    records: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for _, value in iter_unity_object_archive(file):
        if value.get("record") == "object":
            serialized_file = str(value.get("serializedFile") or "")
            object_id = str(value["pathId"])
            if not serialized_file or object_id in records[serialized_file]:
                raise ValueError(
                    f"Unity archive repeats object identity "
                    f"{serialized_file}:{object_id}: {file}"
                )
            records[serialized_file][object_id] = value
    return dict(records)


def _runtime_projections(
    layout,
    sources: list[dict[str, Any]],
    delta: "DeltaContext | None" = None,
) -> tuple[int, int]:
    """Materialize the small Unity JSON surface consumed by the web runtime.

    Full object fidelity remains in the bundle JSONL archives.  These files are
    deterministic projections, named by real Unity source path and type ordinal;
    they do not recreate a processor-specific directory tree.

    In delta mode, projections of reusable bundles are adopted from the base
    release's descriptor documents instead of re-reading local archives; the
    base descriptor is cross-checked against the locally recomputed source
    identity before any of its fields are trusted.
    """

    by_bundle: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for source in sources:
        source_path = source["sourcePath"]
        if (
            source_path.startswith(RUNTIME_PROJECTION_PREFIXES)
            or source_path in HUD_FONT_RUNTIME_SOURCES
        ):
            by_bundle[source["selectedBundle"]].append(source)
    output_count = 0
    adopted_count = 0
    base_descriptors: dict[str, dict[str, Any] | None] = {}

    def base_descriptor(descriptor_path: str, label: str) -> dict[str, Any] | None:
        if descriptor_path not in base_descriptors:
            try:
                document = delta.base_document(descriptor_path)
            except Exception as error:
                sys.stderr.write(
                    f"warning: base descriptor unavailable for {label}: {error}\n"
                )
                document = None
            base_descriptors[descriptor_path] = document if isinstance(document, dict) else None
        return base_descriptors[descriptor_path]

    def adopt(source: dict[str, Any]) -> list[dict[str, Any]] | None:
        descriptor_path = str(source["descriptor"])
        document = base_descriptor(descriptor_path, source["sourcePath"])
        if document is None:
            return None
        for field in ("sourcePath", "contentSha256", "serializedFile", "selectedBundle"):
            if document.get(field) != source.get(field):
                raise ValueError(
                    f"base descriptor does not match the recomputed source identity: "
                    f"{source['sourcePath']} ({field})"
                )
        projections = document.get("runtimeObjects")
        if not isinstance(projections, list):
            return None
        return deepcopy(projections)

    for digest, bundle_sources in sorted(by_bundle.items()):
        if delta is not None and delta.reusable(digest):
            for source in bundle_sources:
                projections = adopt(source)
                if projections is None:
                    raise ValueError(
                        f"base descriptor could not provide runtime projections: "
                        f"{source['sourcePath']}"
                    )
                source["runtimeObjects"] = projections
                adopted_count += len(projections)
            continue
        records_by_file = _archive_records(
            layout.objects / "unity" / f"{digest}.jsonl.gz"
        )
        for source in bundle_sources:
            records = records_by_file.get(source["serializedFile"], {})
            object_ids = sorted(
                set(source["rootObjects"]) | set(source.get("preloadObjects", [])),
                key=int,
            )
            counters: dict[str, int] = defaultdict(int)
            projected = []
            for object_id in object_ids:
                record = records.get(object_id)
                if not record:
                    continue
                object_type = str(record.get("type") or "")
                allowed = object_type in RUNTIME_PROJECTION_TYPES
                # The live HUD consumes this one TMP_FontAsset descriptor.
                # Do not make MonoBehaviour a global projection type: Live
                # bundles contain many unrelated script objects.
                if source["sourcePath"] in HUD_FONT_RUNTIME_SOURCES:
                    allowed = object_type == "MonoBehaviour"
                if not allowed:
                    continue
                ordinal = counters[object_type]
                counters[object_type] += 1
                filename = f"{object_type}{f'_{ordinal}' if ordinal else ''}.json"
                relative = PurePosixPath("unity-json", source["sourcePath"], filename)
                output = layout.runtime / Path(*relative.parts)
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(stable_json(record), "utf-8")
                projected.append(
                    {
                        "pathId": object_id,
                        "type": object_type,
                        "ordinal": ordinal,
                        "path": f"runtime/{relative.as_posix()}",
                    }
                )
                output_count += 1
            source["runtimeObjects"] = projected
    return output_count, adopted_count


def _write_database(file: Path, bundle_reports: list[dict[str, Any]], sources: list[dict[str, Any]]) -> None:
    temporary = file.with_name(f".{file.name}.{os.getpid()}.tmp")
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    try:
        connection.executescript(
            """
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            CREATE TABLE bundles (
              sha256 TEXT PRIMARY KEY,
              original_filename TEXT NOT NULL,
              bytes INTEGER NOT NULL,
              archive_path TEXT NOT NULL,
              archive_sha256 TEXT NOT NULL,
              object_count INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE sources (
              source_path TEXT PRIMARY KEY,
              content_sha256 TEXT NOT NULL,
              descriptor_path TEXT NOT NULL,
              selected_bundle_sha256 TEXT NOT NULL REFERENCES bundles(sha256),
              serialized_file TEXT NOT NULL
            ) STRICT;
            CREATE TABLE source_bundles (
              source_path TEXT NOT NULL REFERENCES sources(source_path),
              bundle_sha256 TEXT NOT NULL REFERENCES bundles(sha256),
              original_filename TEXT NOT NULL,
              PRIMARY KEY (source_path, bundle_sha256)
            ) STRICT;
            CREATE TABLE source_outputs (
              source_path TEXT NOT NULL REFERENCES sources(source_path),
              path TEXT NOT NULL,
              role TEXT NOT NULL,
              type TEXT NOT NULL,
              serialized_file TEXT NOT NULL,
              object_id TEXT NOT NULL,
              bytes INTEGER NOT NULL,
              sha256 TEXT NOT NULL,
              PRIMARY KEY (source_path, path, object_id)
            ) STRICT;
            """
        )
        for report in sorted(bundle_reports, key=lambda item: item["bundle"]["sha256"]):
            bundle = report["bundle"]
            archive = report["objectArchive"]
            connection.execute(
                "INSERT INTO bundles VALUES (?, ?, ?, ?, ?, ?)",
                (
                    bundle["sha256"],
                    bundle["originalFilename"],
                    bundle["bytes"],
                    archive["path"],
                    archive["sha256"],
                    archive["objectCount"],
                ),
            )
        for source in sources:
            connection.execute(
                "INSERT INTO sources VALUES (?, ?, ?, ?, ?)",
                (
                    source["sourcePath"],
                    source["contentSha256"],
                    source["descriptor"],
                    source["selectedBundle"],
                    source["serializedFile"],
                ),
            )
            connection.executemany(
                "INSERT INTO source_bundles VALUES (?, ?, ?)",
                (
                    (source["sourcePath"], bundle["sha256"], bundle["originalFilename"])
                    for bundle in source["candidateBundles"]
                ),
            )
            connection.executemany(
                "INSERT INTO source_outputs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    (
                        source["sourcePath"],
                        output["path"],
                        output["role"],
                        output["type"],
                        output["serializedFile"],
                        output["objectId"],
                        output["bytes"],
                        output["sha256"],
                    )
                    for output in source["outputs"]
                ),
            )
        connection.commit()
        connection.execute("VACUUM")
    finally:
        connection.close()
    os.replace(temporary, file)


def merge_unity_shards(
    server: str,
    source_id: str,
    build_id: str,
    shard_count: int,
    delta: "DeltaContext | None" = None,
) -> dict[str, Any]:
    layout = build_layout(server, build_id)
    reports_by_sha: dict[str, dict[str, Any]] = {}
    candidates: dict[str, list[dict[str, Any]]] = defaultdict(list)
    shard_manifests = []
    for index in range(shard_count):
        shard = layout.shards / f"{index:03d}"
        descriptor_file = shard / "shard.json"
        if not descriptor_file.is_file():
            # Delta runs only materialize shards that had pending bundles; a
            # missing shard means every one of its bundles is reusable.
            if delta is not None:
                continue
            raise FileNotFoundError(f"missing Unity shard: {descriptor_file}")
        descriptor = read_json(descriptor_file)
        if (
            descriptor.get("sourceId") != source_id
            or descriptor.get("buildId") != build_id
            or descriptor.get("shardIndex") != index
            or descriptor.get("shardCount") != shard_count
        ):
            raise ValueError(f"Unity shard identity mismatch: {descriptor_file}")
        shard_manifests.append(descriptor)
        for tree in MERGE_TREES:
            _merge_tree(shard / tree, layout.root / tree)
        for file in sorted((shard / "metadata" / "bundles").glob("*.json")):
            report = json.loads(file.read_text("utf-8"))
            digest = report["bundle"]["sha256"]
            existing = reports_by_sha.get(digest)
            if existing and existing != report:
                raise ValueError(f"different reports for bundle {digest}")
            reports_by_sha[digest] = report
            for source in report.get("sources", []):
                validate_unity_path(source["sourcePath"])
                candidates[source["sourcePath"]].append(
                    {
                        "bundleSha256": digest,
                        "bundleFilename": report["bundle"]["originalFilename"],
                        "bundleOrigin": report["bundle"]["origin"],
                        "source": source,
                    }
                )
    if delta is not None:
        missing = [
            digest for digest in delta.plan["bundles"] if digest not in reports_by_sha
        ]

        def fetch_report(digest: str) -> tuple[str, dict[str, Any]]:
            target = layout.metadata / "bundles" / f"{digest}.json"
            delta.fetch_report(digest, target)
            report = read_json(target)
            if str((report.get("bundle") or {}).get("sha256")) != digest:
                raise ValueError(f"fetched delta report does not match its bundle: {digest}")
            return digest, report

        with ThreadPoolExecutor(max_workers=max(1, min(32, len(missing) or 1))) as executor:
            for digest, report in executor.map(fetch_report, missing):
                reports_by_sha[digest] = report
        absent = sorted(
            digest for digest in delta.plan["pending"] if digest not in reports_by_sha
        )
        if absent:
            raise ValueError(f"delta shards did not produce pending bundle reports: {absent[:5]}")
        total = len(delta.plan["bundles"]) + len(delta.plan["pending"])
        if len(reports_by_sha) != total:
            raise ValueError(
                f"delta merge covered {len(reports_by_sha)} bundles, expected {total}"
            )
        # Reusable bundles never ran a shard locally, so their report sources
        # must feed the same candidate pool the shard loop fills; otherwise
        # source-index.json, the descriptors, and the api derivation would only
        # cover the pending shards' corpus.
        for digest in sorted(delta.plan["bundles"]):
            report = reports_by_sha[digest]
            for source in report.get("sources", []):
                validate_unity_path(source["sourcePath"])
                candidates[source["sourcePath"]].append(
                    {
                        "bundleSha256": digest,
                        "bundleFilename": report["bundle"]["originalFilename"],
                        "bundleOrigin": report["bundle"]["origin"],
                        "source": source,
                    }
                )

    sources = [_canonical_source(candidates[path], reports_by_sha) for path in sorted(candidates)]
    # Locale variants (`sourcePath != basePath`) are materialized as files so the
    # runtime can fetch e.g. stamp_illust_x(zh-Hans).png, but they stay out of
    # source-index.json and the database: api.py resolves each Unity media pointer
    # to a *unique* source, and indexing the locale siblings of a shared bundle
    # would make its pointers resolve to several sources and abort the build. The
    # canonical (locale-less ja base) source is the single indexed entry; variant
    # files ride along to the release via the assets tree walk.
    canonical_sources = [source for source in sources if source["sourcePath"] == source["basePath"]]
    media_output_count, declared_media = _materialize_outputs(layout, sources, shard_count, delta)
    runtime_object_count, adopted_projection_count = _runtime_projections(layout, canonical_sources, delta)
    declared_projections = {
        projection["path"]
        for source in canonical_sources
        for projection in source.get("runtimeObjects", [])
        if delta is not None and delta.reusable(str(source["selectedBundle"]))
    }
    for source in canonical_sources:
        write_json(layout.root / source["descriptor"], source)
    serialized_files: dict[str, dict[str, Any]] = {}
    for digest, report in sorted(reports_by_sha.items()):
        archive = report["objectArchive"]
        for serialized_file in report["bundle"].get("serializedFiles", []):
            object_count = int(
                archive.get("serializedFileObjectCounts", {}).get(
                    serialized_file, -1
                )
            )
            if object_count < 0:
                raise ValueError(
                    f"Unity archive has no object count for {serialized_file}"
                )
            value = {
                "bundleSha256": digest,
                "objectArchive": archive["path"],
                "objectCount": object_count,
                "archiveObjectCount": archive["objectCount"],
            }
            previous = serialized_files.get(serialized_file)
            if previous is not None and previous != value:
                # Locale-variant bundles share internal CAB/serialized-file identities.
                # Keep the first owner rather than aborting the multi-locale merge.
                sys.stderr.write(
                    f"warning: Unity serialized file {serialized_file} resolves to "
                    f"multiple archives; keeping first\n"
                )
                continue
            serialized_files[serialized_file] = value
    source_index = {
        "schema": UNITY_INDEX_SCHEMA,
        "server": server,
        "sourceId": source_id,
        "bundleCount": len(reports_by_sha),
        "sourceCount": len(canonical_sources),
        "objectCount": sum(report["objectArchive"]["objectCount"] for report in reports_by_sha.values()),
        # Counts include delta-adopted entries so a delta build's index is
        # byte-identical to a full rebuild of the same source.
        "runtimeObjectCount": runtime_object_count + adopted_projection_count,
        "mediaOutputCount": media_output_count + len(declared_media),
        "serializedFiles": serialized_files,
        "tree": _tree(source["sourcePath"] for source in canonical_sources),
        "sources": {
            source["sourcePath"]: {
                "descriptor": source["descriptor"].removeprefix("metadata/"),
                "contentSha256": source["contentSha256"],
                "serializedFile": source["serializedFile"],
                "rootTypes": source["rootTypes"],
                "outputs": source["outputs"],
            }
            for source in canonical_sources
        },
    }
    write_json(layout.metadata / "source-index.json", source_index)
    _write_database(layout.database, list(reports_by_sha.values()), canonical_sources)
    if delta is not None:
        # Persist what the release composer must take from the base release:
        # validated media outputs and adopted runtime projections.
        write_json(
            layout.reports / "delta-declared.json",
            {
                "schema": "haneoka-delta-declared-v1",
                "server": server,
                "sourceId": source_id,
                "buildId": build_id,
                "baseReleaseId": delta.base_release_id,
                "media": [declared_media[key] for key in sorted(declared_media)],
                "projectionPaths": sorted(declared_projections),
                "declaredMediaCount": len(declared_media),
                "declaredProjectionCount": len(declared_projections),
                "adoptedProjectionCount": adopted_projection_count,
            },
            pretty=True,
        )
    summary = {
        "schema": "haneoka-unity-merge-v1",
        "server": server,
        "sourceId": source_id,
        "buildId": build_id,
        "shardCount": shard_count,
        "bundleCount": len(reports_by_sha),
        "sourceCount": len(canonical_sources),
        "objectCount": source_index["objectCount"],
        "runtimeObjectCount": runtime_object_count + adopted_projection_count,
        "mediaOutputCount": media_output_count + len(declared_media),
        **(
            {
                "deltaBaseReleaseId": delta.base_release_id,
                "deltaReusableBundleCount": len(delta.plan["bundles"]),
                "deltaPendingBundleCount": len(delta.plan["pending"]),
            }
            if delta is not None
            else {}
        ),
    }
    write_json(layout.reports / "unity.json", summary, pretty=True)
    return summary
