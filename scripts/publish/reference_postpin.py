"""Run one explicit reference materialization with the existing Actions R2 credentials."""
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
from pathlib import Path
from urllib.request import Request, urlopen

RECIPE_SHA = "b95d3ecc80675a4824c24c72b8e139c5159c45468ff8f37e195c2087820e03b3"
PYTHON_PACKAGES = {
    "boto3", "botocore", "brotli", "jmespath", "py3rijndael",
    "python-dateutil", "s3transfer", "six", "urllib3",
}
ROOT = Path(__file__).resolve().parents[2]


def bootstrap(output: Path) -> None:
    """Project the existing exact dependencies; installing the frontend is unnecessary."""
    output.mkdir(parents=True, exist_ok=True)
    text = (ROOT / "scripts/requirements.txt").read_text()
    blocks = re.split(r"(?m)(?=^[A-Za-z0-9][A-Za-z0-9_.-]*==)", text)[1:]
    selected = {block.split("==", 1)[0].lower(): block for block in blocks}
    if not PYTHON_PACKAGES <= selected.keys():
        raise ValueError("reference Python dependency missing from the locked requirements")
    (output / "requirements.txt").write_text("\n".join(selected[name] for name in sorted(PYTHON_PACKAGES)))
    catalog = (ROOT / "pnpm-workspace.yaml").read_text()
    dependencies = {}
    for package in ("esbuild", "@sonolus/core"):
        match = re.search(rf"(?m)^  [\"']?{re.escape(package)}[\"']?: ([0-9]+\.[0-9]+\.[0-9]+)\s*$", catalog)
        if not match:
            raise ValueError("reference Node dependency needs an exact catalog version")
        dependencies[package] = match[1]
    node = output / "node"
    node.mkdir(exist_ok=True)
    package_manager = json.loads((ROOT / "package.json").read_text())["packageManager"]
    if not re.fullmatch(r"pnpm@[0-9]+\.[0-9]+\.[0-9]+", package_manager):
        raise ValueError("reference install requires the repository's exact pnpm version")
    (node / "package.json").write_text(json.dumps({"private": True, "packageManager": package_manager,
                                                  "dependencies": dependencies}) + "\n")


def identity(server: str, release: str, source: str) -> dict[str, str]:
    if server != "intl" or not re.fullmatch(r"r-[a-f0-9]{20}", release):
        raise ValueError("this fixed baseline requires an exact Intl release")
    if not re.fullmatch(r"v[0-9]+-c0b6a1541e45-[A-Za-z0-9._-]+", source) or len(source) > 128:
        raise ValueError("this workflow retains the c0b6 native source guard")
    return {"server": server, "releaseId": release, "sourceId": source}


def select_identity(store, primary: dict[str, str], fallback: dict[str, str] | None) -> dict[str, str]:
    from core.contracts import RELEASE_IDENTITY_SCHEMA
    for target in [primary] + ([fallback] if fallback else []):
        key = f"servers/{target['server']}/releases/{target['releaseId']}/release-identity.json"
        metadata = store.head(key)
        if metadata is None:
            continue
        if not 0 < metadata.get("ContentLength", 4097) <= 4096:
            raise ValueError("retained release identity size invalid")
        if store.get_json(key) != {"schema": RELEASE_IDENTITY_SCHEMA, **target}:
            raise ValueError("retained release identity differs from the exact input")
        return target
    raise ValueError("no explicitly selected retained release identity exists")


def verify_public(receipt: dict, output: Path) -> None:
    url = "https://haneoka.org/api/v1/meta-reference/" + "/".join(
        receipt[field] for field in ("server", "releaseId", "recipeSHA256", "requestSHA256")
    )
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 HaneokaReferenceVerification", "Accept": "application/json"})
    with urlopen(request, timeout=30) as response:
        expected_headers = {
            "X-Haneoka-Release-Id": receipt["releaseId"], "X-Haneoka-Source-Id": receipt["sourceId"],
            "X-Haneoka-Recipe-Sha256": receipt["recipeSHA256"], "X-Haneoka-Request-Sha256": receipt["requestSHA256"],
            "X-Haneoka-Content-Sha256": receipt["sha256"],
        }
        if response.status != 200 or any(response.headers.get(key) != value for key, value in expected_headers.items()):
            raise ValueError("published reference HTTP/identity/hash headers differ from receipt")
        body = response.read(receipt["bytes"] + 1)
        if len(body) != receipt["bytes"] or hashlib.sha256(body).hexdigest() != receipt["sha256"]:
            raise ValueError("published reference body digest differs from receipt")
    value = json.loads(body)
    if (value.get("schema") != "haneoka-meta-reference-v1" or
        value.get("identity") != {field: receipt[field] for field in ("server", "releaseId", "sourceId")} or
        len(value.get("charts", [])) != receipt["chartCount"] or
        value.get("publication", {}).get("recipeSHA256") != receipt["recipeSHA256"] or
        value.get("publication", {}).get("requestSHA256") != receipt["requestSHA256"]):
        raise ValueError("published reference JSON contract differs from receipt")
    output.write_text(json.dumps({"url": url, "httpStatus": 200, "headers": expected_headers,
                                  "bytes": len(body), "sha256": receipt["sha256"], "chartCount": receipt["chartCount"]}, indent=2) + "\n")


def execute(output: Path) -> None:
    sys.path.insert(0, str(ROOT / "scripts"))
    from build.song_reference_materialize import stage_reference_inputs
    from core.config import load_server_config
    from core.manifests import write_json
    from publish.r2 import R2Store
    from publish import song_reference
    pin = os.environ["MATERIALIZER_PIN"]
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or actual != pin:
        raise ValueError("materializer checkout is not the exact producer pin")
    for name in ("CLOUDFLARE_ACCOUNT_ID", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        if not os.environ.get(name):
            raise ValueError("required Actions R2 environment input missing: " + name)
    primary = identity(os.environ["REFERENCE_SERVER"], os.environ["REFERENCE_RELEASE"], os.environ["REFERENCE_SOURCE"])
    fallback = None
    if os.environ.get("FALLBACK_RELEASE") or os.environ.get("FALLBACK_SOURCE"):
        fallback = identity(primary["server"], os.environ["FALLBACK_RELEASE"], os.environ["FALLBACK_SOURCE"])
    raw_recipe = os.environ["REFERENCE_RECIPE_JSON"].encode("utf-8")
    if hashlib.sha256(raw_recipe).hexdigest() != RECIPE_SHA:
        raise ValueError("recipe input differs from the approved frozen JSON bytes")
    output.mkdir(parents=True, exist_ok=True)
    recipe = output / "recipe.json"
    recipe.write_bytes(raw_recipe)
    request_file = output / "request.json"
    store = R2Store(load_server_config(primary["server"]), concurrency=4)
    target = select_identity(store, primary, fallback)
    write_json(output / "selected-identity.json", {"requested": primary, "selected": target, "fallbackUsed": target != primary})
    with tempfile.TemporaryDirectory(prefix="reference-postpin-inputs-") as temporary:
        stage = Path(temporary) / target["releaseId"]
        staging = stage_reference_inputs(store, target, stage)
        write_json(output / "staging-summary.json", staging)
        completed = subprocess.run([
            "node", str(ROOT / "scripts/build/song_reference_request.ts"),
            "--server", target["server"], "--release", target["releaseId"], "--source", target["sourceId"],
            "--release-root", str(stage), "--recipe", str(recipe),
            "--calculated-at", os.environ["REFERENCE_CALCULATED_AT"], "--output", str(request_file),
        ], cwd=ROOT, capture_output=True, timeout=180, check=False)
        if completed.returncode:
            raise RuntimeError("reference materialization failed: " + completed.stderr[-2048:].decode("utf-8", "replace"))
    request_sha = hashlib.sha256(request_file.read_bytes()).hexdigest()
    expected = os.environ.get("EXPECTED_REQUEST_SHA256", "")
    if expected and (not re.fullmatch(r"[a-f0-9]{64}", expected) or request_sha != expected):
        raise ValueError("materialized request SHA differs from the explicit expected SHA")
    reference_file = output / "reference.json"
    args = (store, target["server"], target["releaseId"], target["sourceId"], recipe, request_file)
    dry = song_reference.publish_meta_reference(*args, dry_run=True, output=reference_file)
    write_json(output / "dry-run-receipt.json", dry)
    submodules = {
        name: subprocess.check_output(["git", "rev-parse", f"HEAD:.dependencies/{name}"], cwd=ROOT, text=True).strip()
        for name in ("cassiopeia", "cassiopeia-plugin-our-notes", "cassiopeia-plugin-sonolus")
    }
    write_json(output / "producer.json", {"commit": actual, "converterSubmodules": submodules,
                                         "converterSource": "locked gitlinks of the materializer pin",
                                         "equivalenceToLocalT20WorkingConverterClaimed": False,
                                         "knownOldLockedDifferencePaths": [
                                             "cassiopeia-plugin-our-notes/src/core/chart.ts",
                                             "cassiopeia-plugin-our-notes/src/assets/manifest.ts",
                                         ],
                                         "recipeSHA256": RECIPE_SHA, "requestSHA256": request_sha,
                                         "resourceRebuilt": False, "currentPointerModified": False})
    if os.environ.get("REFERENCE_PUBLISH") == "true":
        # Reuse this job's validated dry-run calculation, avoiding a second full score pass.
        cached = json.loads(reference_file.read_bytes())
        if hashlib.sha256(reference_file.read_bytes()).hexdigest() != dry["sha256"] or request_sha != dry["requestSHA256"]:
            raise ValueError("validated dry-run files changed before publication")
        original_evaluate = song_reference._evaluate
        try:
            song_reference._evaluate = lambda _snapshot: copy.deepcopy(cached)
            receipt = song_reference.publish_meta_reference(*args)
        finally:
            song_reference._evaluate = original_evaluate
        if receipt["sha256"] != dry["sha256"]:
            raise ValueError("publication differs from the validated dry-run")
        write_json(output / "publication-receipt.json", receipt)
        verify_public(receipt, output / "public-readback.json")
    print(json.dumps({"producerPin": actual, **target, "requestSHA256": request_sha,
                      "chartCount": dry["chartCount"], "published": os.environ.get("REFERENCE_PUBLISH") == "true"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bootstrap", type=Path)
    parser.add_argument("--output", type=Path)
    options = parser.parse_args()
    if options.bootstrap:
        bootstrap(options.bootstrap)
    elif options.output:
        execute(options.output)
    else:
        parser.error("--bootstrap or --output required")
