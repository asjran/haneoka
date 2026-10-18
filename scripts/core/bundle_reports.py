"""Byte-exact bundle report transport shared by delta planning and merging."""

from __future__ import annotations

import gzip
import hashlib
import io
import re
import tarfile
from pathlib import Path
from typing import Iterable

from core.hashes import sha256_file
from core.manifests import atomic_write


REPORT_PACK_PATH = "metadata/bundle-reports-v1.tar.gz"
REPORT_PACK_FILE = "unity-bundle-reports.tar.gz"
_REPORT_PATH = re.compile(r"^metadata/bundles/([a-f0-9]{64})\.json$")
_MEMBER = re.compile(r"^([a-f0-9]{64})\.json$")


def report_entries(entries: Iterable[dict]) -> dict[str, dict]:
    return {
        match[1]: entry
        for entry in entries
        if (match := _REPORT_PATH.fullmatch(str(entry.get("path", ""))))
    }


def write_report_pack(reports: Iterable[tuple[str, bytes]], output: Path) -> dict:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    count = 0
    try:
        with temporary.open("wb") as file:
            with gzip.GzipFile(filename="", fileobj=file, mode="wb", compresslevel=6, mtime=0) as zipped:
                with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                    for digest, body in reports:
                        name = f"{digest}.json"
                        if not _MEMBER.fullmatch(name):
                            raise ValueError("Invalid bundle report digest")
                        member = tarfile.TarInfo(name)
                        member.size = len(body)
                        member.mode = 0o644
                        archive.addfile(member, io.BytesIO(body))
                        count += 1
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return {"sha256": sha256_file(output), "bytes": output.stat().st_size, "reports": count}


def read_report_pack(body: bytes, identity: dict, expected: dict[str, dict]) -> dict[str, bytes]:
    if len(body) != identity["bytes"] or hashlib.sha256(body).hexdigest() != identity["sha256"]:
        raise ValueError("Bundle report pack identity differs")
    reports: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as archive:
        for member in archive:
            match = _MEMBER.fullmatch(member.name)
            if not member.isfile() or not match or match[1] in reports:
                raise ValueError("Invalid or duplicate bundle report member")
            digest = match[1]
            entry = expected.get(digest)
            if entry is None or member.size != entry["bytes"]:
                raise ValueError(f"Undeclared bundle report member: {digest}")
            file = archive.extractfile(member)
            if file is None:
                raise ValueError(f"Missing bundle report bytes: {digest}")
            raw = file.read()
            if len(raw) != entry["bytes"] or hashlib.sha256(raw).hexdigest() != entry["sha256"]:
                raise ValueError(f"Bundle report bytes differ: {digest}")
            reports[digest] = raw
    if reports.keys() != expected.keys():
        raise ValueError("Bundle report pack coverage differs")
    return reports


def restore_report_pack(file: Path, identity: dict, expected: dict[str, dict], directory: Path) -> int:
    reports = read_report_pack(file.read_bytes(), identity, expected)
    for digest, body in reports.items():
        atomic_write(directory / f"{digest}.json", body)
    return len(reports)
