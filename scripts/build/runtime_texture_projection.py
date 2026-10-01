"""Project verified native texture alternatives by exact canonical PNG identity."""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path, PurePosixPath
from typing import Any

from core.hashes import sha256_file
from core.manifests import read_json


class RuntimeTextureProjection:
    def __init__(
        self, data: Any, source_id: str, *, metadata_path: Path | None = None,
        variant_root: Path | None = None,
    ):
        self.data = data
        self.source_id = source_id
        self.by_texture: dict[str, list[dict[str, Any]]] = {}
        file = metadata_path or data.root / "metadata" / "runtime-textures.json"
        if not file.is_file():
            return
        document = read_json(file)
        if (not isinstance(document, dict) or document.get("schema") != "haneoka-runtime-textures-v1"
                or document.get("server") != data.server or document.get("sourceId") != source_id):
            raise ValueError("runtime texture metadata source identity mismatch")
        if not isinstance(document.get("variants"), list):
            raise ValueError("runtime texture metadata variants must be an array")
        if document.get("buildId") not in (None, data.root.name):
            raise ValueError("runtime texture metadata build identity mismatch")
        seen: set[tuple[str, str]] = set()
        wanted = {self._path(v.get("texture")) for v in document["variants"]
                  if isinstance(v, dict) and v.get("format") == "astc6x6"
                  and v.get("lossyReencoded") is False and v.get("requiresTranscoding") is False}
        identities: dict[str, list[dict[str, Any]]] = {}
        for source_path, entry in data.source_index.items():
            for output in entry.get("outputs", []):
                if output.get("type") == "Texture2D" and output.get("path") in wanted:
                    identities.setdefault(output["path"], []).append({"sourcePath": source_path, **output})
        for variant in document["variants"]:
            if not isinstance(variant, dict):
                raise ValueError("runtime texture variant must be an object")
            # This projection registers original blocks. Lossy/transcoded
            # opt-ins keep their own producer and consumer selection policy.
            if (variant.get("format") != "astc6x6" or variant.get("lossyReencoded") is not False
                    or variant.get("requiresTranscoding") is not False):
                continue
            if (type(variant.get("textureIndex")) is not int or variant["textureIndex"] < 0
                    or type(variant.get("byteLength")) is not int or variant["byteLength"] <= 0):
                raise ValueError("runtime texture candidate index/byte length is invalid")
            texture, source = variant.get("texture"), variant.get("source")
            png_path = self._path(texture)
            ktx_path = self._path(source)
            if not png_path.endswith(".png") or not ktx_path.endswith(".ktx2"):
                raise ValueError("runtime texture canonical/output container mismatch")
            key = (texture, source)
            if key in seen:
                raise ValueError("duplicate runtime texture candidate")
            seen.add(key)
            png = data.root / png_path
            self._integrity(png_path, png, variant.get("sourceTextureSha256"))
            identity = identities.get(png_path, [])
            if len(identity) != 1 or identity[0].get("sha256") != variant.get("sourceTextureSha256"):
                raise ValueError("runtime texture lacks one matching canonical Texture2D source identity")
            output = (variant_root or data.root) / ktx_path
            self._integrity(ktx_path, output, variant.get("sha256"), variant.get("byteLength"), physical=True)
            from core.ktx_metadata import native_variant_metadata
            actual = native_variant_metadata(variant, output)
            for field in ("format", "container", "width", "height", "mipCount", "gpuByteLength",
                          "orientation", "flipY", "transferFunction", "alphaMode", "cacheKey"):
                if actual[field] != variant.get(field):
                    raise ValueError(f"runtime texture metadata differs from physical KTX: {field}")
            if png.is_file():
                with png.open("rb") as stream:
                    header = stream.read(24)
                if (header[:8] != b"\x89PNG\r\n\x1a\n" or len(header) != 24
                        or int.from_bytes(header[16:20], "big") != actual["width"]
                        or int.from_bytes(header[20:24], "big") != actual["height"]):
                    raise ValueError("runtime texture canonical PNG dimensions differ")
            candidate = {
                **deepcopy(variant), "sourceId": source_id, "server": data.server,
                "sourceIdentity": {key: identity[0][key] for key in
                    ("sourcePath", "serializedFile", "objectId", "bundleSha256", "type", "path", "sha256", "bytes")},
            }
            self.by_texture.setdefault(texture, []).append(candidate)

    def _path(self, url: Any) -> str:
        if not isinstance(url, str) or any(char in url for char in ("?", "#", "\\", "%")):
            raise ValueError("runtime texture URL is not canonical")
        for role in ("assets", "runtime"):
            prefix = f"/{role}/{self.data.server}/"
            if url.startswith(prefix):
                tail = url[len(prefix):]
                path = PurePosixPath(tail)
                if tail and not path.is_absolute() and ".." not in path.parts and path.as_posix() == tail:
                    return f"{role}/{tail}"
        raise ValueError("runtime texture URL belongs to a different server or root")

    def _integrity(
        self, relative: str, file: Path, digest: Any, byte_length: Any = None, *, physical: bool = False,
    ) -> None:
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("runtime texture provenance digest is invalid")
        entry = self.data.base_release_entries.get(relative)
        if not file.is_file() and physical and entry and callable(self.data.restore_output):
            if entry.get("sha256") != digest or entry.get("bytes") != byte_length:
                raise ValueError("runtime texture pinned output identity mismatch")
            self.data.restore_output(relative, file)
        if file.is_file():
            if sha256_file(file) != digest or (byte_length is not None and file.stat().st_size != byte_length):
                raise ValueError("runtime texture file integrity mismatch")
        elif physical or not entry or entry.get("sha256") != digest:
            raise ValueError("runtime texture canonical/output file is missing or mismatched")

    def variants(self, texture: str, slot: int) -> list[dict[str, Any]]:
        return [
            {**deepcopy(candidate), "producerTextureIndex": candidate.get("textureIndex"), "textureIndex": slot}
            for candidate in self.by_texture.get(texture, [])
        ]

    def apply(self, documents: dict[str, Any]) -> None:
        """Attach alternatives at existing runtime provider records, never previews."""
        if not self.by_texture:
            return

        def visit(value: Any) -> None:
            if isinstance(value, list):
                for child in value:
                    visit(child)
                return
            if not isinstance(value, dict):
                return
            textures = value.get("textures")
            if isinstance(textures, list):
                added = [candidate for slot, texture in enumerate(textures) if isinstance(texture, str)
                         for candidate in self.variants(texture, slot)]
                if added:
                    existing = value.get("textureVariants", [])
                    existing = existing if isinstance(existing, list) else []
                    replaced = {(candidate["texture"], candidate["source"]) for candidate in added}
                    value["textureVariants"] = [candidate for candidate in existing
                        if isinstance(candidate, dict)
                        and (candidate.get("texture"), candidate.get("source")) not in replaced] + added
            # Atlas pages/background records already name their canonical URL.
            canonical = value.get("url") or value.get("texture")
            if isinstance(canonical, str) and canonical in self.by_texture:
                value["textureVariants"] = self.variants(canonical, 0)
            for key, child in list(value.items()):
                if key not in {"preview", "imageVariants", "textureVariants", "raw"}:
                    visit(child)

        for resource in ("live2d", "spine", "stories", "story-assets", "story-runtime", "anon-tokyo"):
            visit(documents.get(resource))
