"""Read original Unity Live2D ASTC blocks for optional texture packaging.

This module deliberately owns the source side and KTX2 packaging of native
texture delivery. It resolves a selected ``Texture2D`` output back to the
source bundle and extracts the original blocks without invoking a
decoder. ASTC blocks are wrapped unchanged; the optional desktop BC7 variant
is encoded from the canonical PNG with the pinned KTX-Software profile.

The source bundle is loaded once per digest and released before the next digest
is opened.  This matters for the large character bundles: a Live2D build can
have many sheets, but it must never retain a corpus-wide UnityPy environment.
"""

from __future__ import annotations

import gc
import os
import re
import shutil
import subprocess
import zlib
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable

from core.hashes import sha256_bytes, sha256_file
from core.manifests import read_json, stable_json
from core.paths import PROJECT_ROOT, source_layout, validate_release_path
from ingest.bundle_crypto import load_unity_bundle


ASTC_BLOCK_WIDTH = 6
ASTC_BLOCK_HEIGHT = 6
ASTC_BLOCK_BYTES = 16
ASTC_TEXTURE_FORMAT = 50
SHA256 = re.compile(r"^[a-f0-9]{64}$")

# Keep the encoder contract in one immutable value.  It is part of the cache
# identity: changing a KTX setting must never restore an old release object.
KTX_ENCODER_THREADS = 2
BC7_ENCODER_PROFILE = {
    "sourceFormat": "R8G8B8A8_UNORM",
    "encode": "uastc",
    "transferFunction": "linear",
    "texcoordOrigin": "top-left",
    "uastcQuality": 4,
    "zstd": 8,
    "threads": KTX_ENCODER_THREADS,
    "transcodeTarget": "bc7",
    "transcodeZlib": 6,
}
ASTC_CONTAINER_PROFILE = {
    "rawFormat": "ASTC_6x6_UNORM_BLOCK",
    "texcoordOrigin": "bottom-left",
    "level": 0,
}


@dataclass(frozen=True)
class TextureVariantIssue:
    """A recoverable native-texture failure for one canonical PNG."""

    texture_index: int
    texture: str
    code: str
    detail: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "textureIndex": self.texture_index,
            "texture": self.texture,
            "code": self.code,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class ExtractedAstcTexture:
    """Validated original ASTC data and its Unity identity."""

    texture_index: int
    texture: str
    png_path: Path
    width: int
    height: int
    serialized_file: str
    object_id: str
    bundle_sha256: str
    payload: bytes
    mip_count: int = 1

    @property
    def source_texture_sha256(self) -> str:
        return sha256_file(self.png_path)

    @property
    def payload_sha256(self) -> str:
        return sha256_bytes(self.payload)


@dataclass(frozen=True)
class TextureOutputReference:
    """The selected canonical PNG output and its Unity Texture2D identity."""

    texture_index: int
    texture: str
    png_path: Path
    output: dict[str, Any]


class KtxToolUnavailable(RuntimeError):
    """The optional official KTX-Software command is not installed."""


def encoder_profile(format_name: str, tool_version: str, *, mip_count: int = 1) -> dict[str, Any]:
    """Return the semantic encoder identity used by reuse and provenance."""

    profiles = {"astc6x6": ASTC_CONTAINER_PROFILE, "bc7": BC7_ENCODER_PROFILE}
    if format_name not in profiles:
        raise ValueError(f"unsupported native texture format: {format_name}")
    profile = profiles[format_name]
    if format_name == "astc6x6" and mip_count != 1:
        profile = {key: value for key, value in profile.items() if key != "level"}
        profile["preservedMipCount"] = _positive_int(mip_count, "mip count")
    return {
        "tool": "ktx",
        "toolVersion": tool_version,
        "format": format_name,
        "settings": profile,
    }


def texture_variant_cache_key(
    format_name: str,
    source_texture_sha256: str,
    width: int,
    height: int,
    tool_version: str,
    *,
    source_payload_sha256: str | None = None,
    mip_count: int = 1,
) -> str:
    """Identify one deterministic KTX2 variant without hashing encoded bytes.

    ASTC wraps the original Unity blocks, so its cache identity must include
    those blocks even when the canonical PNG is unchanged. BC7 is encoded from
    the PNG and remains PNG-keyed.
    """

    identity = {
        "sourceTextureSha256": source_texture_sha256,
        "width": width,
        "height": height,
        "profile": encoder_profile(format_name, tool_version, mip_count=mip_count),
    }
    if format_name == "astc6x6":
        identity["sourcePayloadSha256"] = source_payload_sha256 or ""

    return sha256_bytes(stable_json(identity))


def ktx_tool_version(executable: str | None = None) -> str:
    """Read the pinned KTX-Software version once for a build cache key."""

    resolved = find_ktx_executable(executable)
    if not resolved:
        return "unavailable"
    try:
        result = subprocess.run(
            [resolved, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"KTX version probe failed: {error}") from error
    output = (result.stdout or result.stderr or "").strip()
    if result.returncode != 0 or not output:
        raise RuntimeError(f"KTX version probe failed ({result.returncode})")
    return output.splitlines()[0][:256]


def find_ktx_executable(executable: str | None = None) -> str | None:
    """Resolve the pinned KTX executable without making it a build requirement."""

    pinned = (
        PROJECT_ROOT
        / "texture-tools"
        / "KTX-Software-4.4.2-Linux-x86_64"
        / "bin"
        / "ktx"
    )
    return (
        executable
        or os.environ.get("KTX_EXECUTABLE")
        or (
            str(pinned)
            if pinned.is_file() and os.access(pinned, os.X_OK)
            else shutil.which("ktx")
        )
    )


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} is not an integer")
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} is not an integer") from error
    if number <= 0:
        raise ValueError(f"{label} must be positive")
    return number


def _raw_field(texture: Any, *names: str) -> Any:
    for name in names:
        if hasattr(texture, name):
            return getattr(texture, name)
    return None


def _required_mip_count(texture: Any) -> int:
    value = _raw_field(texture, "m_MipCount", "mipCount")
    return _positive_int(value, "mip count")


def _required_texture_dimension(texture: Any) -> int:
    value = _raw_field(texture, "m_TextureDimension", "textureDimension")
    return int(value)


def _required_image_count(texture: Any) -> int:
    value = _raw_field(texture, "m_ImageCount", "imageCount")
    return _positive_int(value, "image count")


def astc_payload_size(width: int, height: int) -> int:
    """Return the exact level-0 byte count for a 6x6 ASTC image."""

    width = _positive_int(width, "width")
    height = _positive_int(height, "height")
    blocks_x = (width + ASTC_BLOCK_WIDTH - 1) // ASTC_BLOCK_WIDTH
    blocks_y = (height + ASTC_BLOCK_HEIGHT - 1) // ASTC_BLOCK_HEIGHT
    return blocks_x * blocks_y * ASTC_BLOCK_BYTES


KTX2_MAGIC = b"\xabKTX 20\xbb\r\n\x1a\n"
KTX2_ASTC_6X6_UNORM = 165
KTX2_BC7_UNORM = 145
KTX2_HEADER_BYTES = 104
ZLIB_CHUNK_BYTES = 1024 * 1024


def _ktx2_level0(data: bytes) -> tuple[int, int, int]:
    if len(data) < KTX2_HEADER_BYTES or data[:12] != KTX2_MAGIC:
        raise ValueError("KTX2 output has an invalid identifier")
    level_offset = int.from_bytes(data[80:88], "little")
    level_length = int.from_bytes(data[88:96], "little")
    level_uncompressed_length = int.from_bytes(data[96:104], "little")
    return level_offset, level_length, level_uncompressed_length


def _temporary_sibling(output: Path, suffix: str) -> Path:
    """Place encoder scratch beside the eventual output, never in /tmp."""

    return output.with_name(f".{output.name}.{os.getpid()}{suffix}")


def _run_ktx(command: list[str], label: str) -> None:
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=300,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"KTX2 {label} failed: {error}") from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"KTX2 {label} failed").strip()
        raise RuntimeError(f"KTX2 {label} failed ({result.returncode}): {detail}")


def _validate_ktx2_file(
    file: Path,
    *,
    width: int,
    height: int,
    vk_format: int,
    supercompression: int,
    uncompressed_level_bytes: int,
    compressed_level_bytes: int | None = None,
    orientation: str | None = None,
) -> tuple[int, int, int]:
    """Validate the small KTX2 header/index without loading the level payload."""

    if not file.is_file() or file.stat().st_size < KTX2_HEADER_BYTES:
        raise ValueError("KTX2 output is truncated")
    with file.open("rb") as stream:
        header = stream.read(KTX2_HEADER_BYTES)
    if header[:12] != KTX2_MAGIC:
        raise ValueError("KTX2 output has an invalid identifier")
    if int.from_bytes(header[12:16], "little") != vk_format:
        raise ValueError(
            f"KTX2 output has unexpected vkFormat: {int.from_bytes(header[12:16], 'little')}"
        )
    if int.from_bytes(header[16:20], "little") != 1:
        raise ValueError("KTX2 output has an unexpected typeSize")
    if (
        int.from_bytes(header[20:24], "little") != width
        or int.from_bytes(header[24:28], "little") != height
    ):
        raise ValueError("KTX2 dimensions do not match original Texture2D")
    if (
        int.from_bytes(header[28:32], "little") != 0
        or int.from_bytes(header[32:36], "little") != 0
        or int.from_bytes(header[36:40], "little") != 1
    ):
        raise ValueError(
            "KTX2 output must describe one 2D non-array, non-cubemap texture"
        )
    if int.from_bytes(header[40:44], "little") != 1:
        raise ValueError("KTX2 output must contain exactly one level")
    if int.from_bytes(header[44:48], "little") != supercompression:
        raise ValueError("KTX2 output has an unexpected supercompression scheme")
    level_offset, level_length, level_uncompressed_length = _ktx2_level0(header)
    file_bytes = file.stat().st_size
    if (
        level_offset < KTX2_HEADER_BYTES
        or level_length <= 0
        or level_offset + level_length > file_bytes
    ):
        raise ValueError("KTX2 level-0 range is invalid")
    if level_uncompressed_length != uncompressed_level_bytes:
        raise ValueError("KTX2 uncompressed level size does not match dimensions")
    if compressed_level_bytes is not None and level_length != compressed_level_bytes:
        raise ValueError("KTX2 level-0 size does not match source payload")
    if orientation is not None:
        _validate_ktx2_sampling(file, header, orientation)
    if supercompression == 3:
        _validate_zlib_level(file, level_offset, level_length, uncompressed_level_bytes)
    return level_offset, level_length, level_uncompressed_length


def _validate_ktx2_sampling(file: Path, header: bytes, orientation: str) -> None:
    """Check the sampling contract consumed by the Cubism native uploader."""

    file_bytes = file.stat().st_size
    with file.open("rb") as stream:
        def metadata(offset_field: int, length_field: int) -> bytes:
            offset = int.from_bytes(header[offset_field:offset_field + 4], "little")
            length = int.from_bytes(header[length_field:length_field + 4], "little")
            if offset < KTX2_HEADER_BYTES or length > 65536 or offset + length > file_bytes:
                raise ValueError("KTX2 sampling metadata range is invalid")
            stream.seek(offset)
            return stream.read(length)

        dfd = metadata(48, 52)
        if len(dfd) < 28 or dfd[14] != 1 or dfd[15] & 1:
            raise ValueError("KTX2 native texture requires linear transfer and straight alpha")
        kvd = metadata(56, 60)
    values: dict[bytes, bytes] = {}
    position = 0
    while position < len(kvd):
        if position + 4 > len(kvd):
            raise ValueError("KTX2 sampling metadata is truncated")
        length = int.from_bytes(kvd[position:position + 4], "little")
        position += 4
        padded = (length + 3) & ~3
        if not length or position + padded > len(kvd):
            raise ValueError("KTX2 sampling metadata length is invalid")
        item = kvd[position:position + length]
        key, separator, value = item.partition(b"\0")
        if not separator or key in values:
            raise ValueError("KTX2 sampling metadata key is invalid")
        values[key] = value.rstrip(b"\0")
        position += padded
    if values.get(b"KTXorientation") != orientation.encode("ascii"):
        raise ValueError("KTX2 orientation does not match the encoder profile")
    if values.get(b"KTXswizzle", b"rgba") != b"rgba":
        raise ValueError("KTX2 native texture requires RGBA channel order")


def _compare_level(file: Path, offset: int, expected: bytes) -> None:
    with file.open("rb") as stream:
        stream.seek(offset)
        remaining = len(expected)
        position = 0
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError("KTX2 level-0 payload is truncated")
            end = position + len(chunk)
            if chunk != expected[position:end]:
                raise ValueError("KTX2 level-0 bytes differ from original ASTC payload")
            position = end
            remaining -= len(chunk)


def _validate_zlib_level(
    file: Path,
    offset: int,
    length: int,
    expected_uncompressed: int,
) -> None:
    """Validate a zlib level without allocating an unbounded output buffer."""

    decoder = zlib.decompressobj()
    produced = 0
    remaining = length
    try:
        with file.open("rb") as stream:
            stream.seek(offset)
            while remaining:
                chunk = stream.read(min(ZLIB_CHUNK_BYTES, remaining))
                if not chunk:
                    raise ValueError("KTX2 zlib level is truncated")
                remaining -= len(chunk)
                pending = chunk
                while pending:
                    if decoder.eof:
                        raise ValueError("KTX2 zlib level has trailing bytes")
                    limit = min(
                        ZLIB_CHUNK_BYTES,
                        max(1, expected_uncompressed - produced + 1),
                    )
                    output = decoder.decompress(pending, limit)
                    produced += len(output)
                    if produced > expected_uncompressed:
                        raise ValueError(
                            "KTX2 zlib level exceeds declared uncompressed size"
                        )
                    if decoder.unused_data:
                        raise ValueError("KTX2 zlib level has trailing bytes")
                    pending = decoder.unconsumed_tail
    except zlib.error as error:
        raise ValueError(f"KTX2 zlib level is invalid: {error}") from error
    if not decoder.eof:
        raise ValueError("KTX2 zlib level is incomplete")
    if produced != expected_uncompressed:
        raise ValueError(
            "KTX2 zlib level size does not match dimensions: "
            f"expected {expected_uncompressed}, got {produced}"
        )


def _finalize_ktx2(temporary: Path, output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    os.replace(temporary, output)
    return output


def write_ktx2_astc(
    extracted: ExtractedAstcTexture,
    output: Path,
    *,
    executable: str | None = None,
) -> Path:
    """Wrap original ASTC blocks in a KTX2 container using KTX-Software.

    ``ktx create --raw`` receives the source blocks directly; it does not see
    decoded pixels and therefore cannot re-encode them.  Scratch files remain
    beside the final output so a large build does not fill the system temp
    filesystem.
    """

    if extracted.mip_count != 1:
        return write_ktx2_astc_mips(
            extracted.width, extracted.height, extracted.payload, extracted.mip_count,
            output, executable=executable,
        )
    executable = find_ktx_executable(executable)
    if not executable:
        raise KtxToolUnavailable("official KTX-Software executable is unavailable")
    output.parent.mkdir(parents=True, exist_ok=True)
    raw = _temporary_sibling(output, ".astc6x6.raw")
    temporary = _temporary_sibling(output, ".astc.ktx2")
    try:
        raw.write_bytes(extracted.payload)
        command = [
            executable,
            "create",
            "--raw",
            "--format",
            "ASTC_6x6_UNORM_BLOCK",
            "--width",
            str(extracted.width),
            "--height",
            str(extracted.height),
            "--assign-texcoord-origin",
            "bottom-left",
            str(raw),
            str(temporary),
        ]
        _run_ktx(command, "create")
        if not temporary.is_file():
            raise RuntimeError("KTX2 create did not produce an output")
        _run_ktx([executable, "validate", str(temporary)], "validate")
        level_offset, _, _ = _validate_ktx2_file(
            temporary,
            width=extracted.width,
            height=extracted.height,
            vk_format=KTX2_ASTC_6X6_UNORM,
            supercompression=0,
            uncompressed_level_bytes=len(extracted.payload),
            compressed_level_bytes=len(extracted.payload),
            orientation="ru",
        )
        _compare_level(temporary, level_offset, extracted.payload)
        return _finalize_ktx2(temporary, output)
    finally:
        raw.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)


def write_ktx2_bc7(
    extracted: ExtractedAstcTexture,
    output: Path,
    *,
    executable: str | None = None,
) -> Path:
    """Encode the canonical PNG to a desktop BC7 KTX2 variant."""

    executable = find_ktx_executable(executable)
    if not executable:
        raise KtxToolUnavailable("official KTX-Software executable is unavailable")
    output.parent.mkdir(parents=True, exist_ok=True)
    uastc = _temporary_sibling(output, ".uastc.ktx2")
    temporary = _temporary_sibling(output, ".bc7.ktx2")
    try:
        _run_ktx(
            [
                executable,
                "create",
                "--format",
                "R8G8B8A8_UNORM",
                "--encode",
                "uastc",
                "--assign-tf",
                "linear",
                "--assign-texcoord-origin",
                "top-left",
                "--uastc-quality",
                "4",
                "--zstd",
                "8",
                "--threads",
                str(KTX_ENCODER_THREADS),
                str(extracted.png_path),
                str(uastc),
            ],
            "create BC7 source",
        )
        if not uastc.is_file():
            raise RuntimeError("KTX2 UASTC create did not produce an output")
        _run_ktx(
            [
                executable,
                "transcode",
                "--target",
                "bc7",
                "--zlib",
                "6",
                str(uastc),
                str(temporary),
            ],
            "transcode BC7",
        )
        if not temporary.is_file():
            raise RuntimeError("KTX2 BC7 transcode did not produce an output")
        expected_uncompressed = (
            ((_positive_int(extracted.width, "width") + 3) // 4)
            * ((_positive_int(extracted.height, "height") + 3) // 4)
            * 16
        )
        _run_ktx([executable, "validate", str(temporary)], "validate BC7")
        _validate_ktx2_file(
            temporary,
            width=extracted.width,
            height=extracted.height,
            vk_format=KTX2_BC7_UNORM,
            supercompression=3,
            uncompressed_level_bytes=expected_uncompressed,
            orientation="rd",
        )
        return _finalize_ktx2(temporary, output)
    finally:
        uastc.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)


def write_ktx2_astc_mips(
    width: int, height: int, payload: bytes, mip_count: int, output: Path,
    *, executable: str | None = None,
) -> Path:
    """Preserve an original ASTC 6x6 mip chain for a runtime atlas."""

    width = _positive_int(width, "width")
    height = _positive_int(height, "height")
    mip_count = _positive_int(mip_count, "mip count")
    if mip_count > max(width, height).bit_length():
        raise ValueError("ASTC mip count exceeds texture dimensions")
    sizes = [astc_payload_size(max(1, width >> level), max(1, height >> level))
             for level in range(mip_count)]
    if len(payload) != sum(sizes):
        raise ValueError("ASTC mip payload size does not match dimensions")
    executable = find_ktx_executable(executable)
    if not executable:
        raise KtxToolUnavailable("official KTX-Software executable is unavailable")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary_sibling(output, ".mips.ktx2")
    raw_files = []
    try:
        position = 0
        for level, size in enumerate(sizes):
            raw = _temporary_sibling(output, f".level{level}.raw")
            raw_files.append(raw)
            raw.write_bytes(payload[position:position + size])
            position += size
        _run_ktx([
            executable, "create", "--raw", "--format", "ASTC_6x6_UNORM_BLOCK",
            "--width", str(width), "--height", str(height), "--levels", str(mip_count),
            "--assign-texcoord-origin", "bottom-left",
            *(str(raw) for raw in raw_files), str(temporary),
        ], "create ASTC mip chain")
        _run_ktx([executable, "validate", str(temporary)], "validate ASTC mip chain")
        with temporary.open("rb") as stream:
            header = stream.read(80 + 24 * mip_count)
        if (len(header) != 80 + 24 * mip_count or header[:12] != KTX2_MAGIC
                or int.from_bytes(header[12:16], "little") != KTX2_ASTC_6X6_UNORM
                or int.from_bytes(header[16:20], "little") != 1
                or int.from_bytes(header[20:24], "little") != width
                or int.from_bytes(header[24:28], "little") != height
                or any(header[28:36]) or int.from_bytes(header[36:40], "little") != 1
                or int.from_bytes(header[40:44], "little") != mip_count
                or int.from_bytes(header[44:48], "little") != 0):
            raise ValueError("KTX2 ASTC mip header differs from the source layout")
        _validate_ktx2_sampling(temporary, header, "ru")
        position = 0
        for level, size in enumerate(sizes):
            index = 80 + 24 * level
            offset = int.from_bytes(header[index:index + 8], "little")
            length = int.from_bytes(header[index + 8:index + 16], "little")
            unpacked = int.from_bytes(header[index + 16:index + 24], "little")
            if (length != size or unpacked != size or offset < len(header)
                    or offset + size > temporary.stat().st_size):
                raise ValueError("KTX2 ASTC mip range differs from the source layout")
            _compare_level(temporary, offset, payload[position:position + size])
            position += size
        return _finalize_ktx2(temporary, output)
    finally:
        for raw in raw_files:
            raw.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)


def ktx2_variant_metadata(
    extracted: ExtractedAstcTexture,
    source_url: str,
    output: Path,
    *,
    format_name: str = "astc6x6",
    tool_version: str = "unknown",
    source_texture_sha256: str | None = None,
) -> dict[str, Any]:
    """Return the host runtime entry for a successfully written KTX2 file."""

    source_hash = source_texture_sha256 or extracted.source_texture_sha256
    return {
        "textureIndex": extracted.texture_index,
        "texture": extracted.texture,
        "source": source_url,
        "format": format_name,
        "container": "ktx2",
        "width": extracted.width,
        "height": extracted.height,
        "requiresTranscoding": False,
        "lossyReencoded": format_name == "bc7",
        "orientation": "ru" if format_name == "astc6x6" else "rd",
        "transferFunction": "linear",
        "alphaMode": "straight",
        "mipCount": extracted.mip_count if format_name == "astc6x6" else 1,
        "gpuByteLength": (
            len(extracted.payload)
            if format_name == "astc6x6"
            else ((extracted.width + 3) // 4) * ((extracted.height + 3) // 4) * 16
        ),
        # Unity's original ASTC blocks are authored with the opposite
        # vertical origin from the canonical PNG. KTX-Software records the
        # ASTC container as ``ru`` and the runtime must flip that upload;
        # BC7 is encoded from the top-left PNG and keeps the PNG orientation.
        "flipY": format_name == "astc6x6",
        "byteLength": output.stat().st_size,
        "sha256": sha256_file(output),
        "sourceTextureSha256": source_hash,
        "encoderProfile": encoder_profile(
            format_name, tool_version,
            mip_count=extracted.mip_count if format_name == "astc6x6" else 1,
        ),
        **(
            {"sourcePayloadSha256": extracted.payload_sha256}
            if format_name == "astc6x6"
            else {}
        ),
        "cacheKey": texture_variant_cache_key(
            format_name,
            source_hash,
            extracted.width,
            extracted.height,
            tool_version,
            source_payload_sha256=(
                extracted.payload_sha256 if format_name == "astc6x6" else None
            ),
            mip_count=extracted.mip_count if format_name == "astc6x6" else 1,
        ),
    }


def extract_astc_texture(obj: Any, *, allow_mips: bool = False) -> tuple[int, int, bytes]:
    """Validate a UnityPy Texture2D and return its original ASTC blocks.

    ``Texture2D.get_image_data`` is intentionally used instead of a decoded
    image property.  The latter would lose the original compressed blocks and
    may apply a vertical orientation transform.
    """

    if getattr(obj, "type", None) is not None and obj.type.name != "Texture2D":
        raise ValueError(f"Unity object is {obj.type.name}, not Texture2D")
    texture = obj.read()
    texture_format = int(_raw_field(texture, "m_TextureFormat", "textureFormat"))
    if texture_format != ASTC_TEXTURE_FORMAT:
        raise ValueError(f"unsupported Unity texture format: {texture_format}")
    width = _positive_int(_raw_field(texture, "m_Width", "width"), "width")
    height = _positive_int(_raw_field(texture, "m_Height", "height"), "height")
    mip_count = _required_mip_count(texture)
    if mip_count != 1 and not allow_mips:
        raise ValueError("native ASTC variant requires one mip level")
    if mip_count > max(width, height).bit_length():
        raise ValueError("ASTC mip count exceeds texture dimensions")
    if _required_texture_dimension(texture) != 2:
        raise ValueError("native ASTC variant requires a 2D texture")
    if _required_image_count(texture) != 1:
        raise ValueError("native ASTC variant requires one image")
    payload = texture.get_image_data()
    if not isinstance(payload, (bytes, bytearray, memoryview)):
        raise ValueError("Unity Texture2D returned a non-byte image payload")
    payload = bytes(payload)
    expected = sum(astc_payload_size(max(1, width >> level), max(1, height >> level))
                   for level in range(mip_count))
    if len(payload) != expected:
        raise ValueError(
            f"ASTC payload size mismatch for {width}x{height}: "
            f"expected {expected}, got {len(payload)}"
        )
    return width, height, payload


def _safe_local_path(root: Path, value: str) -> Path:
    relative = validate_release_path(value)
    return root.joinpath(*PurePosixPath(relative).parts)


def _bundle_records(source_manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for raw in source_manifest.get("files", []):
        if not isinstance(raw, dict) or raw.get("role") != "unity-bundle":
            continue
        digest = str(raw.get("sha256") or "")
        if not SHA256.fullmatch(digest):
            continue
        if digest in records and records[digest] != raw:
            raise ValueError(
                f"source manifest has conflicting bundle records: {digest}"
            )
        records[digest] = raw
    return records


def load_live2d_bundle_records(
    server: str,
    source_id: str,
) -> tuple[Path, dict[str, dict[str, Any]]]:
    """Read and index source.json once for the complete Live2D stage."""

    source = source_layout(server, source_id)
    source_manifest = read_json(source.manifest)
    if not isinstance(source_manifest, dict):
        raise ValueError(f"source manifest is not an object: {source.manifest}")
    return source.root, _bundle_records(source_manifest)


def _bundle_paths(
    source_root: Path, artifact: dict[str, Any]
) -> tuple[Path, list[Path]]:
    main = _safe_local_path(source_root, str(artifact.get("path") or ""))
    unity = artifact.get("unity") if isinstance(artifact.get("unity"), dict) else {}
    dependencies = [
        _safe_local_path(source_root, str(value))
        for value in unity.get("dependencies", [])
    ]
    return main, dependencies


def _find_objects(
    environment: Any, references: Iterable[tuple[str, str]]
) -> dict[tuple[str, str], Any]:
    wanted = set(references)
    found: dict[tuple[str, str], Any] = {}
    for obj in environment.objects:
        key = (str(obj.assets_file.name), str(obj.path_id))
        if key in wanted:
            found[key] = obj
            if len(found) == len(wanted):
                break
    return found


def extract_live2d_astc(
    server: str,
    source_id: str,
    references: Iterable[TextureOutputReference],
    *,
    on_texture: Callable[[ExtractedAstcTexture], Any] | None = None,
    bundle_records: dict[str, dict[str, Any]] | None = None,
    source_root: Path | None = None,
    fetch_original: Callable[[str, Path], None] | None = None,
    allow_mips: bool = False,
) -> tuple[list[ExtractedAstcTexture], list[TextureVariantIssue]]:
    """Extract selected Live2D Texture2D blocks, one source bundle at a time.

    Failures are per-texture and leave the canonical PNG usable.  When
    ``on_texture`` is supplied, each successful result is handed to the
    callback immediately and is not retained in the returned list; this keeps
    large ASTC payloads bounded to the callback's current work.  The callback
    runs before the source environment is released and must not retain UnityPy
    objects.  Without a callback, the returned list contains the extracted
    payload-bearing values for callers that explicitly request collection.
    """

    if bundle_records is None or source_root is None:
        source_root, bundle_records = load_live2d_bundle_records(server, source_id)
    grouped: dict[str, list[TextureOutputReference]] = defaultdict(list)
    issues: list[TextureVariantIssue] = []
    for reference in references:
        output = reference.output
        if output.get("type") != "Texture2D":
            issues.append(
                TextureVariantIssue(
                    reference.texture_index,
                    reference.texture,
                    "selected-output-not-texture2d",
                    f"selected output type is {output.get('type')!r}",
                )
            )
            continue
        bundle_sha = str(output.get("bundleSha256") or "")
        if not bundle_sha:
            issues.append(
                TextureVariantIssue(
                    reference.texture_index,
                    reference.texture,
                    "selected-bundle-missing",
                    "selected Texture2D output has no bundleSha256",
                )
            )
            continue
        if bundle_sha not in bundle_records:
            issues.append(
                TextureVariantIssue(
                    reference.texture_index,
                    reference.texture,
                    "selected-bundle-unavailable",
                    f"source.json has no Unity bundle with sha256 {bundle_sha}",
                )
            )
            continue
        if not reference.png_path.is_file():
            issues.append(
                TextureVariantIssue(
                    reference.texture_index,
                    reference.texture,
                    "canonical-png-missing",
                    str(reference.png_path),
                )
            )
            continue
        grouped[bundle_sha].append(reference)

    extracted: list[ExtractedAstcTexture] = []
    for bundle_sha, bundle_references in sorted(grouped.items()):
        artifact = bundle_records[bundle_sha]
        try:
            bundle_file, dependencies = _bundle_paths(source_root, artifact)
            if not bundle_file.is_file():
                if fetch_original is None:
                    raise FileNotFoundError(bundle_file)
                fetch_original(bundle_sha, bundle_file)
            missing_dependencies = [path for path in dependencies if not path.is_file()]
            if missing_dependencies:
                if fetch_original is None:
                    raise FileNotFoundError(
                        ", ".join(str(path) for path in missing_dependencies)
                    )
                for path in missing_dependencies:
                    dependency_sha = next(
                        (
                            str(record.get("sha256"))
                            for record in bundle_records.values()
                            if (source_root / str(record.get("path"))) == path
                        ),
                        None,
                    )
                    if dependency_sha is None:
                        raise FileNotFoundError(
                            f"Unity dependency is absent from the source manifest: {path}"
                        )
                    fetch_original(dependency_sha, path)
            wanted = [
                (
                    str(reference.output.get("serializedFile") or ""),
                    str(reference.output.get("objectId") or ""),
                )
                for reference in bundle_references
            ]
            if any(
                not serialized_file or not object_id
                for serialized_file, object_id in wanted
            ):
                raise ValueError("selected Texture2D output identity is incomplete")
            environment = load_unity_bundle(bundle_file, dependencies)
            objects: dict[tuple[str, str], Any] = {}
            obj: Any = None
            try:
                objects = _find_objects(environment, wanted)
                for reference, identity in zip(bundle_references, wanted, strict=True):
                    obj = objects.get(identity)
                    if obj is None:
                        issues.append(
                            TextureVariantIssue(
                                reference.texture_index,
                                reference.texture,
                                "selected-texture-missing",
                                f"Unity object is absent: {identity[0]}:{identity[1]}",
                            )
                        )
                        continue
                    try:
                        width, height, payload = extract_astc_texture(obj, allow_mips=allow_mips)
                        value = ExtractedAstcTexture(
                            reference.texture_index,
                            reference.texture,
                            reference.png_path,
                            width,
                            height,
                            identity[0],
                            identity[1],
                            bundle_sha,
                            payload,
                            _required_mip_count(obj.read()) if allow_mips else 1,
                        )
                        if on_texture is not None:
                            try:
                                on_texture(value)
                            except Exception as error:
                                issues.append(
                                    TextureVariantIssue(
                                        reference.texture_index,
                                        reference.texture,
                                        "variant-writer-failed",
                                        f"{type(error).__name__}: {error}",
                                    )
                                )
                            finally:
                                # The callback owns any output metadata it
                                # retains; release this payload before the
                                # next Unity object is decoded.
                                del value
                                del payload
                        else:
                            extracted.append(value)
                    except Exception as error:
                        issues.append(
                            TextureVariantIssue(
                                reference.texture_index,
                                reference.texture,
                                "unsupported-original-texture",
                                f"{type(error).__name__}: {error}",
                            )
                        )
            finally:
                # UnityPy objects retain references to their environment. Drop
                # every local reference before the next bundle is opened.
                obj = None
                objects.clear()
                del objects
                del environment
        except Exception as error:
            for reference in bundle_references:
                issues.append(
                    TextureVariantIssue(
                        reference.texture_index,
                        reference.texture,
                        "source-bundle-read-failed",
                        f"{type(error).__name__}: {error}",
                    )
                )
        finally:
            # Drop UnityPy's mmap-backed environment before opening the next
            # bundle.  ``gc.collect`` is intentionally scoped to this optional
            # stage and avoids accumulating mappings on large builds.
            gc.collect()
    extracted.sort(key=lambda item: item.texture_index)
    issues.sort(key=lambda item: (item.texture_index, item.code, item.detail))
    return extracted, issues
