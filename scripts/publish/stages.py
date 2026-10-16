"""Retain resumable pipeline stages as complete run/server groups."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any
from core.delta import PLAN_SCHEMA
from core.paths import safe_id

if TYPE_CHECKING:
    from core.config import ServerConfig
    from publish.r2 import R2Store

STAGE_PREFIX = "private/resource-pipeline-stage/"


def recent_pipeline_stage_references(store: R2Store, server: str) -> tuple[set[str], set[str], list[str]]:
    """Pin the exact source and base needed by each resumable delta plan."""
    latest: dict[str, datetime] = {}
    plans: dict[str, str] = {}
    for item in store.iter_keys(STAGE_PREFIX):
        key = str(item.get("Key") or "")
        parts = key.removeprefix(STAGE_PREFIX).split("/")
        if len(parts) < 3 or parts[1] != server:
            continue
        if not re.fullmatch(r"[0-9]{1,32}", parts[0]):
            raise ValueError(f"invalid pipeline stage run key: {key}")
        modified = item.get("LastModified")
        if not isinstance(modified, datetime) or modified.tzinfo is None:
            raise ValueError(f"invalid pipeline stage modification time: {key}")
        latest[parts[0]] = max(latest.get(parts[0], modified), modified)
        if len(parts) == 3 and parts[2] == "unity-delta-plan.json":
            plans[parts[0]] = key
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    sources: set[str] = set()
    releases: set[str] = set()
    retained: list[str] = []
    for identity, key in sorted(plans.items()):
        if latest[identity] < cutoff:
            continue
        plan = store.get_json(key)
        if not isinstance(plan, dict) or plan.get("schema") != PLAN_SCHEMA or plan.get("server") != server:
            raise ValueError(f"invalid resumable pipeline stage plan: {key}")
        source = plan.get("sourceId")
        if not isinstance(source, str) or safe_id(source, "source id") != source:
            raise ValueError(f"invalid resumable pipeline source: {key}")
        base = plan.get("baseReleaseId")
        if not isinstance(base, str) or (base and not re.fullmatch(r"r-[a-f0-9]{20}", base)):
            raise ValueError(f"invalid resumable pipeline base release: {key}")
        sources.add(source)
        if base:
            releases.add(base)
        retained.append(key)
    return sources, releases, retained


def prune_pipeline_stages(
    store: R2Store,
    config: ServerConfig,
    *,
    dry_run: bool = True,
    minimum_age_hours: int = 168,
    run_id: str | None = None,
) -> dict[str, Any]:
    if minimum_age_hours < 168:
        raise ValueError("pipeline stages must remain resumable for at least seven days")
    if run_id is not None and not re.fullmatch(r"[0-9]{1,32}", run_id):
        raise ValueError("stage run id must contain only decimal digits")
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in store.iter_keys(STAGE_PREFIX):
        key = str(item.get("Key") or "")
        parts = key.removeprefix(STAGE_PREFIX).split("/")
        if len(parts) < 3 or parts[1] != config.id:
            continue
        if not re.fullmatch(r"[0-9]{1,32}", parts[0]):
            raise ValueError(f"invalid pipeline stage run key: {key}")
        if run_id is not None and parts[0] != run_id:
            continue
        modified, size, etag = item.get("LastModified"), item.get("Size"), item.get("ETag")
        if not isinstance(modified, datetime) or modified.tzinfo is None or not isinstance(size, int) or isinstance(size, bool) or size < 0 or not isinstance(etag, str) or not etag:
            raise ValueError(f"invalid pipeline stage object metadata: {key}")
        groups.setdefault(parts[0], []).append(item)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=minimum_age_hours)
    planned, retained, changed = [], [], []
    planned_bytes = 0
    deleted = 0
    for identity, items in sorted(groups.items()):
        latest = max(item["LastModified"] for item in items)
        summary = {"runId": identity, "objects": len(items), "bytes": sum(item["Size"] for item in items), "latestModified": latest.isoformat()}
        if run_id is None and latest > cutoff:
            retained.append(summary)
            continue
        prefix = f"{STAGE_PREFIX}{identity}/{config.id}/"
        fresh = {item["Key"]: item for item in store.iter_keys(prefix)}
        if len(fresh) != len(items) or any(
            item["Key"] not in fresh or any(fresh[item["Key"]].get(field) != item.get(field) for field in ("LastModified", "Size", "ETag"))
            for item in items
        ):
            changed.append(summary)
            continue
        planned.append(summary)
        planned_bytes += summary["bytes"]
        if not dry_run:
            # The maintenance job shares resource-build-server-{server} with
            # the reusable builder. An explicitly selected run is quiescent.
            deleted += store.delete_keys(item["Key"] for item in items)
    return {
        "schema": "haneoka-r2-pipeline-stage-prune-v1",
        "server": config.id,
        "dryRun": dry_run,
        "minimumAgeHours": minimum_age_hours,
        "selectedRunId": run_id,
        "plannedRuns": planned,
        "plannedObjects": sum(item["objects"] for item in planned),
        "plannedBytes": planned_bytes,
        "retainedRecentRuns": retained,
        "retainedChangedRuns": changed,
        "deletedObjects": deleted,
    }
