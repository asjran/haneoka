from __future__ import annotations

import gzip
import json
import os
import re
import tempfile
import threading
import zipfile
from pathlib import Path

from py3rijndael import Pkcs7Padding, RijndaelCbc

from core.config import ServerConfig
from core.contracts import PACKAGE_MAX_BYTES
from core.hashes import sha256_bytes
from core.manifests import atomic_write, write_json
from core.zip_io import open_validated_zip


MASTER_PREFIX = "assets/Master/"
VERSION_FILE = "MasterDataSystemVersion.txt"
ENCRYPTED_DIRECTORY = "encrypted"
STREAM_CHUNK_BYTES = 1024 * 1024
MANIFEST_FILE = "MasterManifest.json"
MAX_MANIFEST_FILES = 4096
MANIFEST_VERSION_PATTERN = re.compile(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*")
MANIFEST_TABLE_PATTERN = re.compile(r"Master[A-Za-z0-9_]+\.bin")
TABLE_JSON_PATTERN = re.compile(r"Master[A-Za-z0-9_]+\.json")
TABLE_BIN_PATTERN = re.compile(r"Master[A-Za-z0-9_]+\.bin")
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")


def validate_master_manifest(
    value: object, expected_version: str | None = None
) -> dict:
    """Validate and normalize a live MasterManifest document.

    The returned document contains only validated ``version`` and file
    metadata values in its ``files`` list; any other top-level fields are
    retained for callers that need them.
    """

    if not isinstance(value, dict):
        raise ValueError("MasterManifest.json must contain an object")
    version = value.get("version")
    if (
        not isinstance(version, str)
        or not version
        or os.path.isabs(version)
        or version.startswith(("/", "\\"))
        or "\\" in version
        or ".." in version
        or any(segment in {".", ".."} for segment in version.split("/"))
        or MANIFEST_VERSION_PATTERN.fullmatch(version) is None
    ):
        raise ValueError("MasterManifest.json has an unsafe version")
    if expected_version is not None and version != expected_version:
        raise ValueError(
            f"MasterManifest.json version mismatch: expected {expected_version}, got {version}"
        )
    files = value.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("MasterManifest.json files must be a non-empty list")
    if len(files) > MAX_MANIFEST_FILES:
        raise ValueError(
            f"MasterManifest.json contains too many files: {len(files)} > {MAX_MANIFEST_FILES}"
        )
    names: set[str] = set()
    validated_files = []
    for index, entry in enumerate(files):
        if not isinstance(entry, dict):
            raise ValueError(f"MasterManifest.json files[{index}] must be an object")
        name = entry.get("name")
        digest = entry.get("hash")
        size = entry.get("size")
        if not isinstance(name, str) or MANIFEST_TABLE_PATTERN.fullmatch(name) is None:
            raise ValueError(f"MasterManifest.json has an unsafe file name: {name!r}")
        if name in names:
            raise ValueError(f"MasterManifest.json contains duplicate file: {name}")
        if not isinstance(digest, str) or SHA256_PATTERN.fullmatch(digest) is None:
            raise ValueError(f"MasterManifest.json has an invalid hash for {name}")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise ValueError(f"MasterManifest.json has an invalid size for {name}")
        names.add(name)
        validated_files.append({"name": name, "hash": digest, "size": size})
    validated = dict(value)
    validated["version"] = version
    validated["files"] = validated_files
    return validated


def _copy_archive_entry(
    archive: zipfile.ZipFile,
    entry: zipfile.ZipInfo,
    output: Path,
    label: str,
    *,
    maximum_bytes: int | None = None,
) -> None:
    if entry.is_dir():
        raise ValueError(f"{label} is a directory: {entry.filename}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(
        f".{output.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    try:
        copied = 0
        with archive.open(entry) as source, temporary.open("wb") as target:
            for chunk in iter(lambda: source.read(STREAM_CHUNK_BYTES), b""):
                copied += len(chunk)
                if maximum_bytes is not None and copied > maximum_bytes:
                    raise ValueError(
                        f"{label} exceeds the {maximum_bytes}-byte package limit"
                    )
                target.write(chunk)
        if copied != entry.file_size:
            raise ValueError(
                f"{label} size mismatch: expected {entry.file_size}, got {copied}"
            )
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _asset_pack(input_file: Path, scratch: Path) -> Path:
    with open_validated_zip(input_file, "Master package") as archive:
        members = archive.infolist()
        if any(member.filename.startswith(MASTER_PREFIX) for member in members):
            return input_file
        candidates = [
            member
            for member in members
            if Path(member.filename).name
            in {"split_UnityDataAssetPack.apk", "UnityDataAssetPack.apk"}
        ]
        if len(candidates) != 1:
            raise ValueError(
                f"input must contain exactly one UnityDataAssetPack split; found {len(candidates)}"
            )
        target = scratch / "UnityDataAssetPack.apk"
        _copy_archive_entry(
            archive,
            candidates[0],
            target,
            "Unity asset-pack APK",
            maximum_bytes=PACKAGE_MAX_BYTES,
        )
        return target


def _decode_master_table(
    raw: bytes, name: str, salt: bytes, iv: bytes, cipher: RijndaelCbc
) -> dict:
    if raw[:64] != salt + iv:
        raise ValueError(f"master crypto constants do not match {name}")
    try:
        decoded = gzip.decompress(cipher.decrypt(raw[64:]))
        value = json.loads(decoded.decode("utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"invalid Master table: {name}") from error
    if not isinstance(value, dict) or not isinstance(value.get("_allData"), list):
        raise ValueError(f"invalid Master table: {name}")
    return value


def _stage_master_tables(
    entries: list[tuple[str, bytes]],
    stage: Path,
    salt: bytes,
    iv: bytes,
    cipher: RijndaelCbc,
) -> tuple[list[dict], int]:
    encrypted_output = stage / ENCRYPTED_DIRECTORY
    encrypted_output.mkdir(parents=True, exist_ok=True)
    tables = []
    total_encrypted_bytes = 0
    names: set[str] = set()
    for name, raw in entries:
        if name in names:
            raise ValueError(f"duplicate encrypted Master table filename: {name}")
        names.add(name)
        value = _decode_master_table(raw, name, salt, iv, cipher)
        atomic_write(encrypted_output / f"{name}.bin", raw)
        write_json(stage / f"{name}.json", value)
        total_encrypted_bytes += len(raw)
        tables.append(
            {
                "name": name,
                "rows": len(value["_allData"]),
                "sourceBytes": len(raw),
                "sourceSha256": sha256_bytes(raw),
            }
        )
    return tables, total_encrypted_bytes


def _snapshot_entries(snapshot_root: Path) -> tuple[str, list[tuple[str, bytes]]]:
    master_directory = snapshot_root / "master"
    manifest_file = master_directory / MANIFEST_FILE
    if not master_directory.is_dir():
        raise ValueError(f"Master snapshot directory is missing: {master_directory}")
    try:
        manifest_value = json.loads(manifest_file.read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid {MANIFEST_FILE}: {manifest_file}") from error
    manifest = validate_master_manifest(manifest_value)
    entries = []
    for item in manifest["files"]:
        name = item["name"]
        file = master_directory / name
        if not file.is_file():
            raise ValueError(f"Master snapshot file is missing: {file}")
        try:
            raw = file.read_bytes()
        except OSError as error:
            raise ValueError(f"cannot read Master snapshot file: {file}") from error
        if len(raw) != item["size"]:
            raise ValueError(
                f"Master snapshot size mismatch for {name}: "
                f"expected {item['size']}, got {len(raw)}"
            )
        digest = sha256_bytes(raw)
        if digest != item["hash"]:
            raise ValueError(
                f"Master snapshot hash mismatch for {name}: "
                f"expected {item['hash']}, got {digest}"
            )
        entries.append((Path(name).stem, raw))
    return manifest["version"], entries


def _archive_entries(
    archive: zipfile.ZipFile,
) -> tuple[list[tuple[str, bytes]], bytes, str]:
    members = sorted(
        (
            member
            for member in archive.infolist()
            if member.filename.startswith(MASTER_PREFIX)
        ),
        key=lambda member: member.filename,
    )
    bins = [
        member
        for member in members
        if Path(member.filename).name.startswith("Master")
        and member.filename.endswith(".bin")
    ]
    if not bins:
        raise ValueError("package contains no encrypted Master tables")
    names = [Path(member.filename).name for member in bins]
    if len(names) != len(set(names)):
        raise ValueError("package contains duplicate encrypted Master table filenames")
    version_entries = [
        member
        for member in members
        if Path(member.filename).name == VERSION_FILE
    ]
    # 1.0.x builds ship no MasterDataSystemVersion.txt alongside the tables.
    if len(version_entries) > 1:
        raise ValueError(f"duplicate {VERSION_FILE} entries")
    version_entry = version_entries[0] if version_entries else None
    entries = [(Path(entry.filename).stem, archive.read(entry)) for entry in bins]
    version_bytes = archive.read(version_entry) if version_entry is not None else b""
    version = ""
    if version_entry is not None:
        try:
            version = version_bytes.decode("utf-8").strip()
        except UnicodeDecodeError as error:
            raise ValueError(f"{VERSION_FILE} is not UTF-8") from error
        if not version:
            raise ValueError(f"{VERSION_FILE} is empty")
    return entries, version_bytes, version


def _remove_stale_snapshot_tables(
    output: Path, encrypted_output: Path, names: set[str]
) -> None:
    for file in output.iterdir():
        if file.is_file() and TABLE_JSON_PATTERN.fullmatch(file.name):
            if file.stem not in names:
                file.unlink()
    if encrypted_output.is_dir():
        for file in encrypted_output.iterdir():
            if file.is_file() and TABLE_BIN_PATTERN.fullmatch(file.name):
                if file.stem not in names:
                    file.unlink()


def _write_master_outputs(
    output: Path,
    entries: list[tuple[str, bytes]],
    version_bytes: bytes,
    version: str,
    salt: bytes,
    iv: bytes,
    cipher: RijndaelCbc,
    *,
    prune_stale: bool,
) -> dict:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".haneoka-master-stage-", dir=str(output.parent)
    ) as directory:
        stage = Path(directory)
        tables, total_encrypted_bytes = _stage_master_tables(
            entries, stage, salt, iv, cipher
        )
        manifest = {
            "schema": "haneoka-master-v2",
            "systemVersion": version,
            "versionBytes": len(version_bytes),
            "versionSha256": sha256_bytes(version_bytes),
            "tableCount": len(tables),
            "rowCount": sum(item["rows"] for item in tables),
            "encryptedBytes": total_encrypted_bytes,
            "tables": tables,
        }
        if version_bytes:
            atomic_write(stage / ENCRYPTED_DIRECTORY / VERSION_FILE, version_bytes)
        write_json(stage / "master.json", manifest, pretty=True)

        output.mkdir(parents=True, exist_ok=True)
        encrypted_output = output / ENCRYPTED_DIRECTORY
        encrypted_output.mkdir(parents=True, exist_ok=True)
        names = {item["name"] for item in tables}
        for item in tables:
            name = item["name"]
            os.replace(stage / f"{name}.json", output / f"{name}.json")
            os.replace(
                stage / ENCRYPTED_DIRECTORY / f"{name}.bin",
                encrypted_output / f"{name}.bin",
            )
        if version_bytes:
            os.replace(
                stage / ENCRYPTED_DIRECTORY / VERSION_FILE,
                encrypted_output / VERSION_FILE,
            )
        os.replace(stage / "master.json", output / "master.json")
        if prune_stale:
            _remove_stale_snapshot_tables(output, encrypted_output, names)
    return manifest


def extract_master(
    input_file: Path,
    output: Path,
    config: ServerConfig,
    *,
    snapshot_root: Path | None = None,
) -> dict:
    if snapshot_root is None:
        package_bytes = input_file.stat().st_size if input_file.is_file() else 0
        if package_bytes < 1:
            raise ValueError(f"Master package is missing or empty: {input_file}")
        if package_bytes > PACKAGE_MAX_BYTES:
            raise ValueError(
                f"Master package exceeds the {PACKAGE_MAX_BYTES}-byte package limit: "
                f"{package_bytes}"
            )
    crypto = config.master_crypto
    if set(crypto) != {"salt", "key", "iv"}:
        raise ValueError(f"master crypto is not configured for {config.id}")
    salt = bytes.fromhex(crypto["salt"])
    key = bytes.fromhex(crypto["key"])
    iv = bytes.fromhex(crypto["iv"])
    cipher = RijndaelCbc(key, iv, Pkcs7Padding(32), block_size=32)

    if snapshot_root is not None:
        version, entries = _snapshot_entries(Path(snapshot_root))
        version_bytes = version.encode("utf-8")
        return _write_master_outputs(
            output,
            entries,
            version_bytes,
            version,
            salt,
            iv,
            cipher,
            prune_stale=True,
        )

    with tempfile.TemporaryDirectory(prefix="haneoka-master-") as directory:
        asset_pack = _asset_pack(input_file, Path(directory))
        with open_validated_zip(asset_pack, "Unity asset-pack APK") as archive:
            entries, version_bytes, version = _archive_entries(archive)
    return _write_master_outputs(
        output,
        entries,
        version_bytes,
        version,
        salt,
        iv,
        cipher,
        prune_stale=False,
    )
