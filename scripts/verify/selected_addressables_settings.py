"""Read the current APK's one initial Addressables settings entry through bounded ranges."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from verify import selected_native as captured


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = os.environ["READER_PIN"]
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("settings reader requires its exact reviewed commit")
    args.output.mkdir(parents=True, exist_ok=True)
    captured.MAX_REMOTE_BYTES = 8 * 1024 * 1024
    captured.MAX_RANGE_BYTES = 2 * 1024 * 1024
    store = captured.R2Store(SimpleNamespace(r2_bucket="hotdori-assets"), concurrency=1)
    if store.bucket != "hotdori-assets":
        raise ValueError("settings reader bucket differs from the current source bucket")
    metadata = store.head(captured.cas_key(captured.APK_SHA))
    if metadata is None or metadata["ContentLength"] != 452888806:
        raise ValueError("selected current APK HEAD differs")
    if metadata.get("Metadata", {}).get("sha256", captured.APK_SHA) != captured.APK_SHA:
        raise ValueError("selected current APK metadata SHA differs")
    remote = captured.R2RangeFile(store, captured.cas_key(captured.APK_SHA), metadata)
    receipt = {"sourceId": captured.SOURCE_ID, "readerPin": pin, "packageCAS_SHA256": captured.APK_SHA,
               "packageBytes": metadata["ContentLength"], "apkHEADMatches": True, "R2Writes": 0,
               "wholeAPKDownloadedOrHashed": False, "oldNativeReread": False, "complete": False}
    try:
        with zipfile.ZipFile(remote) as archive:
            selected = [row for row in archive.infolist() if row.filename.endswith("assets/aa/settings.json")
                        or row.filename.endswith("assets/aa/Android/catalog_main.bin")]
            settings = [row for row in selected if row.filename.endswith("assets/aa/settings.json")]
            if len(settings) != 1 or max(settings[0].file_size, settings[0].compress_size) > 256 * 1024:
                raise ValueError("initial settings entry missing, ambiguous or outside the byte budget")
            entry = settings[0]
            if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or entry.flag_bits & 1:
                raise ValueError("unsupported initial settings ZIP encoding")
            body = archive.read(entry)
            if len(body) != entry.file_size:
                raise ValueError("initial settings expansion differs from ZIP metadata")
            value = json.loads(body)
            fields = {key: child for key, child in value.items() if key in {
                "m_CatalogLocations", "m_InitializationObjects", "CatalogLocations", "InitializationObjects",
                "m_ProviderData", "m_buildTarget", "m_AddressablesVersion",
            }}
            if not any("CatalogLocations" in key for key in fields):
                raise ValueError("initial settings has no catalog locations field")
            if any(term in body.decode().lower() for term in ("sig=", "x-amz-signature", "access_token")):
                raise ValueError("initial settings includes signed credentials; omit raw persistence")
            receipt.update(settingsEntry=entry.filename, settingsBytes=len(body),
                           settingsSHA256=hashlib.sha256(body).hexdigest(), settingsProjection=fields,
                           initialSelectedZipEntries=[{"entry": row.filename, "bytes": row.file_size,
                               "compressedBytes": row.compress_size, "CRC32": f"{row.CRC:08x}"} for row in selected], complete=True)
            (args.output / "initial-settings.json").write_bytes(body)
    except Exception as error:
        receipt["errorType"] = type(error).__name__
        raise
    finally:
        receipt.update(rangeRequests=remote.requests, rangeBytes=remote.bytes_read)
        (args.output / "initial-settings-receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"complete": True, "settingsBytes": receipt["settingsBytes"],
                      "settingsSHA256": receipt["settingsSHA256"], "rangeBytes": remote.bytes_read, "R2Writes": 0}))


if __name__ == "__main__":
    main()
