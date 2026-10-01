"""Produce runtime texture variants from selected model pages.

Original Unity ASTC blocks are the default. PNGs remain canonical for previews,
exports and fallback; Basis re-encoding requires a separate explicit opt-in.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Callable, Iterable

from build.live2d_textures import (
    TextureOutputReference,
    _run_ktx,
    _validate_ktx2_sampling,
    extract_live2d_astc,
    find_ktx_executable,
    ktx_tool_version,
    ktx2_variant_metadata,
    texture_variant_cache_key,
    write_ktx2_astc,
)
from core.hashes import sha256_bytes, sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import BuildLayout, build_layout, validate_release_path

ENCODER_THREADS = 2
BASIS_PROFILE = {
    "encode": "basis-lz",
    "quality": 255,
    "compressionLevel": 1,
    "threads": ENCODER_THREADS,
    "transferFunction": "linear",
    "texcoordOrigin": "top-left",
}


def write_basis_ktx2(
    encoder: str, source: Path, output: Path, *, allow_lossy: bool = False,
) -> Path:
    """Publish an explicitly requested lossy Basis derivative atomically."""

    if not allow_lossy:
        raise ValueError("Basis re-encoding requires allow_lossy=True")
    with source.open("rb") as stream:
        png_header = stream.read(24)
    if len(png_header) != 24 or png_header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Basis source must be a canonical PNG")
    width = int.from_bytes(png_header[16:20], "big")
    height = int.from_bytes(png_header[20:24], "big")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.stem}.{os.getpid()}.ktx2")
    try:
        _run_ktx(
            [encoder, "create", "--format", "R8G8B8A8_UNORM", "--encode", "basis-lz",
             "--assign-tf", "linear", "--assign-texcoord-origin", "top-left",
             "--qlevel", str(BASIS_PROFILE["quality"]), "--clevel", "1",
             "--threads", str(ENCODER_THREADS), str(source), str(temporary)],
            "create Basis",
        )
        _run_ktx([encoder, "validate", str(temporary)], "validate Basis")
        with temporary.open("rb") as stream:
            header = stream.read(104)
        if len(header) < 104 or header[:12] != b"\xabKTX 20\xbb\r\n\x1a\n":
            raise ValueError("Basis encoder produced an invalid KTX2")
        u32 = lambda offset: int.from_bytes(header[offset:offset + 4], "little")
        u64 = lambda offset: int.from_bytes(header[offset:offset + 8], "little")
        if (u32(12) != 0 or u32(16) != 1 or u32(20) != width or u32(24) != height
                or u32(28) or u32(32) or u32(36) != 1 or u32(40) != 1 or u32(44) != 1):
            raise ValueError("Basis encoder produced an unexpected texture layout")
        # BasisLZ is transcoded, not inflated into native ASTC/BC7 blocks.
        size = temporary.stat().st_size
        if (u64(80) < 104 or not u64(88) or u64(80) + u64(88) > size
                or u64(96) != 0 or u64(64) < 104 or u64(72) < 20
                or u64(64) + u64(72) > size):
            raise ValueError("Basis encoder produced invalid level/global data")
        _validate_ktx2_sampling(temporary, header, "rd")
        os.replace(temporary, output)
        return output
    finally:
        temporary.unlink(missing_ok=True)


def runtime_texture_references(layout: BuildLayout, server: str) -> list[TextureOutputReference]:
    """Select the exact Spine atlas pages declared by the completed stage.

    Live2D produces its own native variants. Background providers can pass
    additional TextureOutputReferences to build_ktx2 without copying their PNGs.
    """

    spine = read_json(layout.metadata / "spine.json")
    if spine.get("server") != server:
        raise ValueError("runtime texture catalog belongs to a different server")
    pages = {}
    for model in spine.get("models", {}).values():
        for atlas in model.get("atlases", []):
            for page in atlas.get("pages", []):
                if page.get("type") == "Texture2D":
                    path = validate_release_path(page["path"])
                    pages[path] = page
    references = []
    with sqlite3.connect(f"file:{layout.database}?mode=ro", uri=True) as database:
        for path, page in sorted(pages.items()):
            rows = database.execute(
                "SELECT o.serialized_file, o.object_id, s.selected_bundle_sha256 "
                "FROM source_outputs o JOIN sources s USING(source_path) "
                "WHERE o.path=? AND o.source_path=? AND o.type='Texture2D'",
                (path, page["sourcePath"]),
            ).fetchall()
            if len(rows) != 1:
                raise ValueError(f"runtime atlas page has no unique Unity identity: {path}")
            serialized_file, object_id, bundle_sha = rows[0]
            references.append(TextureOutputReference(
                len(references), page["url"], layout.root / path,
                {"type": "Texture2D", "serializedFile": serialized_file,
                 "objectId": object_id, "bundleSha256": bundle_sha},
            ))
    return references


def build_ktx2(
    server: str, build_id: str, *, source_id: str | None = None,
    references: Iterable[TextureOutputReference] | None = None,
    fetch_original: Callable[[str, Path], None] | None = None,
    allow_basis_reencode: bool = False,
) -> dict:
    """Package selected original runtime blocks; keep every fallback PNG."""

    layout = build_layout(server, build_id)
    selected = list(references) if references is not None else runtime_texture_references(layout, server)
    if source_id is None:
        source_id = read_json(layout.metadata / "source-index.json")["sourceId"]
    encoder = find_ktx_executable()
    if not encoder:
        raise RuntimeError("KTX2 was requested but KTX-Software is not installed")
    version = ktx_tool_version(encoder)
    variants = []

    def package(extracted):
        # Identical base PNGs can have different original blocks or mip chains.
        # Keep both variants addressable by the complete producer identity.
        source_hash = extracted.source_texture_sha256
        cache_key = texture_variant_cache_key(
            "astc6x6", source_hash, extracted.width, extracted.height, version,
            source_payload_sha256=extracted.payload_sha256, mip_count=extracted.mip_count,
        )
        output = layout.runtime / "ktx2" / f"{cache_key}.astc6x6.ktx2"
        write_ktx2_astc(extracted, output, executable=encoder)
        variants.append(ktx2_variant_metadata(
            extracted, f"/runtime/{server}/ktx2/{output.name}", output, tool_version=version,
        ))

    _, issues = extract_live2d_astc(
        server, source_id, selected, on_texture=package, fetch_original=fetch_original,
        allow_mips=True,
    )
    if allow_basis_reencode:
        for reference in selected:
            source = reference.png_path
            source_hash = sha256_file(source)
            profile = {"tool": "ktx", "toolVersion": version, "settings": BASIS_PROFILE}
            cache_key = sha256_bytes(stable_json({"sourceTextureSha256": source_hash, "profile": profile}))
            output = layout.runtime / "ktx2" / f"{cache_key}.basis.ktx2"
            write_basis_ktx2(encoder, source, output, allow_lossy=True)
            with output.open("rb") as stream:
                header = stream.read(104)
            variants.append({
                "textureIndex": reference.texture_index,
                "texture": reference.texture, "source": f"/runtime/{server}/ktx2/{output.name}",
                "container": "ktx2", "format": "basis-etc1s", "requiresTranscoding": True,
                "lossyReencoded": True, "orientation": "rd", "flipY": False,
                "transferFunction": "linear", "alphaMode": "straight", "mipCount": 1,
                "width": int.from_bytes(header[20:24], "little"),
                "height": int.from_bytes(header[24:28], "little"),
                "byteLength": output.stat().st_size, "sha256": sha256_file(output),
                "sourceTextureSha256": source_hash, "encoderProfile": profile, "cacheKey": cache_key,
            })
    result = {
        "schema": "haneoka-runtime-textures-v1", "server": server, "buildId": build_id,
        "sourceId": source_id, "encoder": version, "encoderThreads": ENCODER_THREADS,
        "defaultMode": "original-blocks", "basisReencodeEnabled": allow_basis_reencode,
        "selectedTextureCount": len(selected),
        "variants": sorted(variants, key=lambda entry: (entry["textureIndex"], entry["format"])),
        "issues": [issue.as_dict() for issue in issues], "outputCount": len(variants),
    }
    write_json(layout.metadata / "runtime-textures.json", result, pretty=True)
    write_json(layout.reports / "ktx2.json", result, pretty=True)
    return result
