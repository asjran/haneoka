"""Publish an explicit reference after its resource release identity exists."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

from core.config import PROJECT_ROOT, validate_server_id
from core.contracts import RELEASE_IDENTITY_FILENAME, RELEASE_IDENTITY_SCHEMA
from core.manifests import stable_json, write_json
from core.paths import safe_id
from publish.r2 import IMMUTABLE_CACHE, R2Store

MAX_JSON_BYTES = 64 * 1024 * 1024
RECIPE_SCHEMA = "haneoka-team-reference-recipe-v1"
REQUEST_SCHEMA = "haneoka-meta-reference-request-v1"
RESULT_SCHEMA = "haneoka-meta-reference-v1"


def _canonical(value: Any) -> bytes:
    # JSON hashing and publication must reject NaN/Infinity rather than persist them.
    json.dumps(value, allow_nan=False)
    return stable_json(value).encode("utf-8")


def _read(file: Path) -> tuple[dict[str, Any], bytes]:
    if file.stat().st_size > MAX_JSON_BYTES:
        raise ValueError("meta reference JSON exceeds byte limit")
    body = file.read_bytes()
    if len(body) > MAX_JSON_BYTES:
        raise ValueError("meta reference JSON exceeds byte limit")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError("meta reference document must be an object")
    _canonical(value)
    return value, body


def _profile_definition(profile: dict[str, Any]) -> dict[str, Any]:
    definition = copy.deepcopy(profile)
    definition.pop("identity", None)
    inventory = definition.get("inventory")
    if not isinstance(inventory, dict):
        raise ValueError("explicit recipe inventory missing")
    inventory.pop("server", None)
    inventory.pop("releaseId", None)
    return definition


def _recipe_definition(recipe: dict[str, Any]) -> dict[str, Any]:
    # Transport T18's approved recipe into T20's profile without scenario defaults.
    if recipe.get("mode") != "normal" or recipe.get("scenario") != {
        "judgement": "PERFECT", "justRate": 0, "eventPowerEnabled": False,
        "assistModeFactor": 1, "memberOrder": "nominal-uniform-native-shuffle",
        "memberOrderCount": 120,
    }:
        raise ValueError("recipe scenario is outside the shared normal reference contract")
    if recipe.get("constraints") != {
        "lockedMemberIds": [], "excludedMemberIds": [], "lockedSnapshotIds": [],
        "excludedSnapshotIds": [], "excludedSongKeys": [],
        "excludeJustMissions": False, "justRate": 0, "teamSize": 5,
    }:
        raise ValueError("recipe constraints differ from the fixed reference contract")
    return _profile_definition({
        "profileId": recipe["id"], "profileVersion": recipe["metadata"]["version"],
        "mode": recipe["mode"], "eventId": None,
        "judgement": recipe["scenario"]["judgement"],
        "inventory": recipe["inventory"], "assignment": recipe["assignment"],
        "basis": recipe["basis"],
    })


def _chart_key(row: dict[str, Any]) -> tuple[int, int, int]:
    values = tuple(row.get(field) for field in ("songId", "difficulty", "scoreId"))
    if any(type(value) is not int or value < 0 for value in values):
        raise ValueError("invalid reference chart identity")
    return values


def validate_request(
    request: dict[str, Any], recipe: dict[str, Any], identity: dict[str, str],
) -> set[tuple[int, int, int]]:
    if request.get("schema") != REQUEST_SCHEMA or recipe.get("schema") != RECIPE_SCHEMA:
        raise ValueError("meta reference request/recipe schema mismatch")
    profile = request.get("profile", {})
    if _canonical(_profile_definition(profile)) != _canonical(_recipe_definition(recipe)):
        raise ValueError("request differs from explicit recipe")
    if (profile.get("mode"), profile.get("eventId"), profile.get("judgement")) != ("normal", None, "PERFECT"):
        raise ValueError("reference scenario must be explicit normal/non-event/PERFECT")
    if "eventId" not in profile or not isinstance(profile.get("basis"), dict):
        raise ValueError("reference scenario/basis missing")
    data = request.get("data", {})
    if data.get("identity") != identity or profile.get("identity") != identity:
        raise ValueError("reference data/profile pin mismatch")
    inventory = profile["inventory"]
    if inventory.get("server") != identity["server"] or inventory.get("releaseId") != identity["releaseId"]:
        raise ValueError("reference inventory pin mismatch")
    timestamp = request.get("calculatedAt")
    if not isinstance(timestamp, str):
        raise ValueError("deterministic calculatedAt is required")
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("invalid calculatedAt") from error
    if parsed.utcoffset() is None:
        raise ValueError("calculatedAt requires a timezone")
    songs = data.get("songs")
    charts = request.get("charts")
    if not isinstance(songs, dict) or not isinstance(charts, list) or not charts:
        raise ValueError("full catalogue and charts are required")
    expected: set[tuple[int, int, int]] = set()
    for song_id, song in songs.items():
        for row in song.get("difficulty", []):
            key = _chart_key({**row, "songId": int(song_id)})
            if key in expected:
                raise ValueError("duplicate catalogue difficulty")
            expected.add(key)
    actual: set[tuple[int, int, int]] = set()
    for chart in charts:
        if chart.get("identity") != identity:
            raise ValueError("reference chart pin mismatch")
        key = _chart_key(chart["song"])
        if key in actual:
            raise ValueError("duplicate reference chart")
        actual.add(key)
    if actual != expected:
        raise ValueError("reference charts must cover every catalogue difficulty")
    return expected


def validate_result(
    result: dict[str, Any], request: dict[str, Any], expected: set[tuple[int, int, int]],
) -> None:
    if result.get("schema") != RESULT_SCHEMA or result.get("identity") != request["profile"]["identity"]:
        raise ValueError("reference result pin/schema mismatch")
    if result.get("reference") != request["profile"]:
        raise ValueError("reference result changed the fixed profile")
    calculation = result.get("calculation", {})
    profile = request["profile"]
    required = {
        "model": "native-normal-nominal-120-order-v1",
        "entrypoint": "prepareEvaluationForSearch", "mode": "normal",
        "scoreKind": "native-personal-score", "judgement": "PERFECT",
        "profileId": profile["profileId"], "profileVersion": profile["profileVersion"],
        "basis": profile["basis"], "calculatedAt": request["calculatedAt"],
    }
    if any(calculation.get(field) != value for field, value in required.items()):
        raise ValueError("reference calculation contract mismatch")
    rows = result.get("charts", [])
    if len(rows) != len(expected) or {_chart_key(row) for row in rows} != expected:
        raise ValueError("reference result omitted catalogue difficulties")
    objectives = ["score", "ss-ratio", "ss-surplus"] if profile["basis"].get("kind") == "single" else ["score"]
    if calculation.get("objectives") != objectives:
        raise ValueError("reference calculation objectives mismatch")
    inputs = {_chart_key(chart["song"]): chart["song"] for chart in request["charts"]}
    for row in rows:
        candidate = row.get("candidate", {})
        if candidate.get("assignment") != profile["assignment"]:
            raise ValueError("reference result changed the fixed assignment")
        if candidate.get("songKey") != f"{row['songId']}:{row['difficulty']}":
            raise ValueError("reference result chart key mismatch")
        original = inputs[_chart_key(row)]
        gaps = row.get("quality", {}).get("gaps", [])
        if any(gap not in gaps for gap in original.get("gaps", [])):
            raise ValueError("reference result dropped input evidence gaps")
        for objective in objectives:
            metric = candidate.get("metrics", {}).get(objective)
            if not isinstance(metric, dict) or "value" not in metric:
                raise ValueError("reference metric missing")
            value = metric["value"]
            if value is None:
                if not metric.get("gaps"):
                    raise ValueError("null reference metric needs evidence gaps")
            elif type(value) not in (int, float) or not math.isfinite(value) or metric.get("status") == "unavailable":
                raise ValueError("invalid reference metric value/status")
    _canonical(result)


def _evaluate(request_file: Path) -> dict[str, Any]:
    completed = subprocess.run(
        ["node", str(PROJECT_ROOT / "scripts/build/song_reference.ts"), str(request_file.resolve())],
        cwd=PROJECT_ROOT, capture_output=True, timeout=120, check=False,
    )
    if completed.returncode:
        raise RuntimeError("shared reference evaluator failed: " + completed.stderr[-2048:].decode("utf-8", "replace"))
    if len(completed.stdout) > MAX_JSON_BYTES:
        raise ValueError("reference evaluator output exceeds byte limit")
    result = json.loads(completed.stdout)
    if not isinstance(result, dict):
        raise ValueError("reference evaluator output must be an object")
    return result


def _remote_json(store: R2Store, key: str, max_bytes: int) -> dict[str, Any] | None:
    metadata = store.head(key)
    if metadata is None:
        return None
    if metadata.get("ContentLength", max_bytes + 1) > max_bytes:
        raise ValueError("reference remote object exceeds byte limit")
    value = store.get_json(key)
    if not isinstance(value, dict):
        raise ValueError("reference remote object missing or invalid")
    return value


def publish_meta_reference(
    store: R2Store, server: str, release_id: str, source_id: str,
    recipe_file: Path, request_file: Path, *, dry_run: bool = False,
    output: Path | None = None,
) -> dict[str, Any]:
    validate_server_id(server)
    if not re.fullmatch(r"r-[a-f0-9]{20}", release_id):
        raise ValueError("explicit resource release id required")
    safe_id(source_id, "source id")
    identity = {"server": server, "releaseId": release_id, "sourceId": source_id}
    identity_key = f"servers/{server}/releases/{release_id}/{RELEASE_IDENTITY_FILENAME}"
    published_identity = _remote_json(store, identity_key, 4096)
    if published_identity != {"schema": RELEASE_IDENTITY_SCHEMA, **identity}:
        raise ValueError("published release identity does not match reference pin")
    recipe, recipe_bytes = _read(recipe_file)
    request, request_bytes = _read(request_file)
    expected = validate_request(request, recipe, identity)
    recipe_sha = hashlib.sha256(recipe_bytes).hexdigest()
    request_sha = hashlib.sha256(request_bytes).hexdigest()
    key = f"servers/{server}/meta-reference/{release_id}/{recipe_sha}/{request_sha}/reference.json"
    # Evaluate the validated snapshot, even if a materializer rewrites its file.
    with tempfile.TemporaryDirectory(prefix="haneoka-meta-reference-") as temporary:
        validated_request = Path(temporary) / "request.json"
        write_json(validated_request, request)
        result = _evaluate(validated_request)
    validate_result(result, request, expected)
    result["publication"] = {
        "schema": "haneoka-meta-reference-publication-v1",
        "recipeSHA256": recipe_sha, "requestSHA256": request_sha, "recipe": recipe,
    }
    body = _canonical(result)
    if len(body) > MAX_JSON_BYTES:
        raise ValueError("reference publication exceeds byte limit")
    previous = _remote_json(store, key, MAX_JSON_BYTES)
    created = False
    if previous is not None and _canonical(previous) != body:
        raise ValueError("immutable reference content differs; use a new explicit request/recipe")
    if previous is None and not dry_run:
        try:
            store.put_json(key, result, IMMUTABLE_CACHE, if_absent=True)
            created = True
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 412:
                raise
        if _canonical(_remote_json(store, key, MAX_JSON_BYTES)) != body:
            raise ValueError("immutable reference publication readback mismatch")
    if output is not None:
        write_json(output, result)
    return {
        "schema": "haneoka-meta-reference-publish-receipt-v1", **identity,
        "key": key, "recipeSHA256": recipe_sha, "requestSHA256": request_sha,
        "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body),
        "chartCount": len(expected), "published": not dry_run, "created": created,
        "dryRun": dry_run, "resourceReleaseModified": False,
    }
