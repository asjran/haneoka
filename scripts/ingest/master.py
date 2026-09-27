"""Read the current Master version from the configured game service."""

from __future__ import annotations

import os
import struct
import subprocess
import tempfile
from pathlib import Path

from ingest.version_api import EMPTY_GRPC_FRAME, GRPC_USER_AGENT, _public_https


def _varint(data: bytes, position: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if position >= len(data):
            raise ValueError("truncated Master version response")
        byte = data[position]
        position += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
    raise ValueError("invalid Master version varint")


def decode_master_version(frame: bytes) -> tuple[str, str]:
    if len(frame) < 5 or frame[0] != 0 or struct.unpack_from(">I", frame, 1)[0] != len(frame) - 5:
        raise ValueError("invalid Master version gRPC frame")
    data = frame[5:]
    fields: dict[int, str] = {}
    position = 0
    while position < len(data):
        tag, position = _varint(data, position)
        field, wire = tag >> 3, tag & 7
        if field == 0:
            raise ValueError("invalid Master version field")
        if wire == 2:
            size, position = _varint(data, position)
            end = position + size
            if end > len(data):
                raise ValueError("truncated Master version field")
            if field in (1, 2):
                if field in fields:
                    raise ValueError("duplicate Master version field")
                fields[field] = data[position:end].decode("utf-8")
            position = end
        elif wire == 0:
            _, position = _varint(data, position)
        elif wire in (1, 5):
            position += 8 if wire == 1 else 4
            if position > len(data):
                raise ValueError("truncated Master version field")
        else:
            raise ValueError("unsupported Master version wire type")
    if not fields.get(1) or not fields.get(2):
        raise ValueError("Master version response is incomplete")
    return fields[1], fields[2]


def discover_master_version(*, skip_resolution_check: bool = False) -> tuple[str, str]:
    endpoint = os.environ.get("HANEOKA_MASTER_ENDPOINT", "").strip()
    if not endpoint:
        raise ValueError("HANEOKA_MASTER_ENDPOINT is required for live Master ingestion")
    _public_https(endpoint, skip_resolution_check)
    with tempfile.TemporaryDirectory(prefix="haneoka-master-version-") as directory:
        body = Path(directory) / "response.bin"
        response = subprocess.run(
            [
                "curl", "--silent", "--show-error", "--http2", "--max-time", "30",
                "--max-filesize", "65536", "-D", "-", "-o", str(body),
                "-H", "content-type: application/grpc", "-H", "te: trailers",
                "-H", "grpc-accept-encoding: identity", "-A", GRPC_USER_AGENT,
                "--data-binary", "@-", endpoint,
            ],
            input=EMPTY_GRPC_FRAME,
            capture_output=True,
            timeout=40,
            check=False,
        )
        if response.returncode:
            raise RuntimeError("Master version request failed")
        headers = {}
        for line in response.stdout.decode("utf-8", "replace").splitlines():
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()
        if headers.get("grpc-status") != "0" or not headers.get("content-type", "").startswith("application/grpc"):
            raise RuntimeError(f"Master version service failed (gRPC {headers.get('grpc-status', 'missing')})")
        return decode_master_version(body.read_bytes())
