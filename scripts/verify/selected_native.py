"""Read selected native ZIP entries from an existing immutable R2 APK."""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sys
import zipfile
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.config import load_server_config
from core.manifests import write_json
from core.storage import cas_key
from publish.r2 import R2Store

APK_SHA = "e5786b7ddada9134f1bba7c0eac2f0c5a57f1defeba40f8f8b3e1db27065bc07"
SOURCE_ID = "v50-e5786b7ddada-79f2f470b3cf-m73807cbb0192-n7ba0928c"
SELECTED = {
    "lib/arm64-v8a/libil2cpp.so": "native/libil2cpp.so",
    "assets/bin/Data/Managed/Metadata/global-metadata.dat": "native/global-metadata.dat",
    "lib/arm64-v8a/libanort.so": "native/libanort.so",
    "AndroidManifest.xml": "AndroidManifest.xml",
}
MAX_SELECTED_BYTES = 250 * 1024 * 1024
MAX_REMOTE_BYTES = 300 * 1024 * 1024
MAX_RANGE_BYTES = 8 * 1024 * 1024


class R2RangeFile(io.RawIOBase):
    """Seekable, bounded GET ranges; never download or cache the whole object."""

    def __init__(self, store, key: str, metadata: dict):
        self.store, self.key = store, key
        self.size = metadata["ContentLength"]
        self.etag = metadata["ETag"]
        self.position = self.bytes_read = self.requests = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        target = offset + (self.position if whence == io.SEEK_CUR else self.size if whence == io.SEEK_END else 0)
        if whence not in (io.SEEK_SET, io.SEEK_CUR, io.SEEK_END) or target < 0:
            raise ValueError("invalid APK range seek")
        self.position = target
        return target

    def read(self, size=-1):
        size = self.size - self.position if size is None or size < 0 else size
        size = min(size, max(0, self.size - self.position))
        if not size:
            return b""
        if size > MAX_RANGE_BYTES or self.bytes_read + size > MAX_REMOTE_BYTES or self.requests >= 1024:
            raise ValueError("selected APK range budget exceeded")
        start, end = self.position, self.position + size - 1
        response = self.store.client.get_object(
            Bucket=self.store.bucket, Key=self.key, Range=f"bytes={start}-{end}", IfMatch=self.etag,
        )
        body = response["Body"]
        try:
            if (response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 206 or
                response.get("ContentRange") != f"bytes {start}-{end}/{self.size}" or
                response.get("ContentLength") != size):
                raise ValueError("R2 did not honor the exact bounded APK range")
            value = body.read(size + 1)
            if len(value) != size:
                raise ValueError("APK range bytes differ from its metadata")
        finally:
            body.close()
        self.position += size
        self.bytes_read += size
        self.requests += 1
        return value


def extract_selected(store, key: str, metadata: dict, output: Path) -> dict:
    remote = R2RangeFile(store, key, metadata)
    rows = []
    with zipfile.ZipFile(remote) as archive:
        by_name = {name: [info for info in archive.infolist() if info.filename == name] for name in SELECTED}
        write_json(output / "zip-selected-inventory.json", {
            "entries": [{"entry": name, "occurrences": len(values),
                         "bytes": values[0].file_size if len(values) == 1 else None,
                         "compressedBytes": values[0].compress_size if len(values) == 1 else None}
                        for name, values in by_name.items()],
            "nativeSHA256Measured": False,
        })
        if any(len(values) != 1 for values in by_name.values()):
            raise ValueError("selected native ZIP entry missing or duplicated")
        total = sum(values[0].file_size for values in by_name.values())
        if total > MAX_SELECTED_BYTES:
            raise ValueError("selected native entries exceed 250 MiB budget")
        if by_name["AndroidManifest.xml"][0].file_size > 2 * 1024 * 1024:
            raise ValueError("Android manifest exceeds the selected metadata budget")
        for name, relative in SELECTED.items():
            info = by_name[name][0]
            if info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError("unsupported selected ZIP entry encoding")
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".partial")
            digest, count = hashlib.sha256(), 0
            try:
                with archive.open(info) as stream, temporary.open("wb") as destination:
                    while block := stream.read(1024 * 1024):
                        count += len(block)
                        if count > info.file_size or count > MAX_SELECTED_BYTES:
                            raise ValueError("selected ZIP expansion exceeded the declared size")
                        digest.update(block)
                        destination.write(block)
                if count != info.file_size:
                    raise ValueError("selected ZIP size mismatch")
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
            rows.append({"entry": name, "path": str(target), "bytes": count,
                         "sha256": digest.hexdigest(), "zipCompressedBytes": info.compress_size,
                         "zipCRCValidated": True, "SHA256MeasuredFromBytes": True})
            write_json(output / "entries-receipt.json", {"entries": rows, "sourceId": SOURCE_ID})
    return {"entries": rows, "selectedBytes": total, "remoteRangeBytes": remote.bytes_read,
            "remoteRangeRequests": remote.requests, "wholeAPKDownloaded": False}


def project_source(store, output: Path) -> dict:
    key = f"servers/intl/sources/{SOURCE_ID}/source.json"
    metadata = store.head(key)
    if metadata is None:
        return {"key": key, "available": False}
    if not 0 < metadata.get("ContentLength", 0) <= 32 * 1024 * 1024:
        raise ValueError("source manifest exceeds the projection metadata budget")
    value = store.get_json(key)
    if not isinstance(value, dict) or value.get("server") != "intl" or value.get("sourceId") != SOURCE_ID:
        raise ValueError("source manifest identity mismatch")
    package = value.get("package", {})
    if package.get("sha256") is not None and package["sha256"] != APK_SHA:
        raise ValueError("source package projection differs from the selected APK")
    fields = ("file", "sha256", "bytes", "packageName", "versionCode", "versionName", "unityVersion", "kind")
    patches = []
    for row in value.get("files", []):
        name = row.get("originalFilename") or Path(row.get("path", "")).name
        if re.search(r"(?:^|[/_.-])(?:patch|ifix|hotfix)(?:$|[/_.-])", name, re.I):
            patches.append({field: row[field] for field in ("path", "role", "originalFilename", "bytes", "sha256") if field in row})
    return {"key": key, "available": True, "schema": value.get("schema"),
            "sourceId": SOURCE_ID, "server": "intl",
            "package": {field: package[field] for field in fields if field in package},
            "patches": patches, "fullManifestSavedOrPrinted": False}


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    result = {"schema": "haneoka-selected-native-read-receipt-v1", "sourceId": SOURCE_ID,
              "expectedPackageSHA256": APK_SHA, "packageHashRecomputed": False,
              "nativeCompatibilityProven": False, "R2Writes": 0}
    try:
        import subprocess
        pin = os.environ["READER_PIN"]
        actual = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        if not re.fullmatch(r"[a-f0-9]{40}", pin) or actual != pin:
            raise ValueError("selected native reader requires its exact committed pin")
        store = R2Store(load_server_config("intl"), concurrency=2)
        key = cas_key(APK_SHA)
        metadata = store.head(key)
        result.update({"readerPin": actual, "storageURI": f"r2://{store.bucket}/{key}",
                       "apkHEADExists": metadata is not None, "readAt": datetime.now(timezone.utc).isoformat()})
        if metadata is None:
            raise ValueError("the exact existing e578 APK CAS object is absent")
        claimed = metadata.get("Metadata", {}).get("sha256")
        if claimed is not None and claimed != APK_SHA:
            raise ValueError("existing APK object metadata SHA differs from the expected CAS key")
        result.update({"apkBytes": metadata["ContentLength"], "metadataPackageSHA256": claimed,
                       "metadataPackageSHA256MatchesCAS": claimed == APK_SHA})
        # Record HEAD identity before any long entry transfer.
        write_json(args.output / "native-read-receipt.json", result)
        result.update(extract_selected(store, key, metadata, args.output))
        projection = project_source(store, args.output)
        write_json(args.output / "source-package-projection.json", projection)
        result["complete"] = True
    except Exception as error:
        result.update({"complete": False, "errorType": type(error).__name__})
        raise
    finally:
        write_json(args.output / "native-read-receipt.json", result)
    print(json.dumps({"complete": True, "sourceId": SOURCE_ID,
                      "selectedBytes": result["selectedBytes"], "entryCount": len(result["entries"]), "R2Writes": 0}))


if __name__ == "__main__":
    main()
