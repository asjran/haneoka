"""Collect live in-game announcements for the operational announcement feed."""

from __future__ import annotations

import hashlib
from html import escape
from html.parser import HTMLParser
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from PIL import Image

from core.config import ServerConfig, load_server_config
from core.manifests import write_json
from core.paths import build_layout
from ingest.version_api import cdn_authorization, discover_asset_version, proxy_from_env


LIST_PATH = "/app.announcement.AnnouncementService/GetList"
GET_PATH = "/app.announcement.AnnouncementService/Get"
GRPC_USER_AGENT = "grpc-dotnet/2.66.0"
ANNOUNCEMENT_SCHEMA = "haneoka-announcements-v1"
MAX_ANNOUNCEMENTS = 100
ANNOUNCEMENT_CONCURRENCY = 12
MAX_GRPC_MESSAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
RETRY_DELAYS = (0.0, 1.0, 3.0)
PUBLIC_BASE_URL = "https://haneoka.org"

_IMAGE_TYPES = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}
_TRADITIONAL_MARKERS = set("臺灣國體發佈預告轉蛋護維獎勵與為進行這裡說明謝謝")
_SIMPLIFIED_MARKERS = set("台湾国体发布预告转蛋护维护奖励与为进行这里说明谢谢")


@dataclass(frozen=True)
class MediaAsset:
    content_type: str
    digest: str
    file: Path
    filename: str
    width: int = 0
    height: int = 0


@dataclass(frozen=True)
class AnnouncementCollection:
    document: dict[str, Any]
    media: tuple[MediaAsset, ...]


class _AnnouncementImages(HTMLParser):
    def __init__(
        self,
        endpoint: str,
        hosted: dict[str, str] | None = None,
        media: dict[str, MediaAsset | None] | None = None,
    ):
        super().__init__(convert_charrefs=False)
        self.endpoint = endpoint
        self.hosted = hosted or {}
        self.media = media or {}
        self.urls: set[str] = set()
        self.output: list[str] = []

    def handle_starttag(self, tag, attrs):
        original = self.get_starttag_text()
        if tag == "img":
            source = next((value for key, value in attrs if key == "src" and value), "")
            if source:
                url = urllib.parse.urljoin(self.endpoint, source)
                self.urls.add(url)
                hosted = self.hosted.get(url)
                if hosted:
                    asset = self.media.get(url)
                    if asset and asset.width and asset.height:
                        attrs = [
                            (key, value)
                            for key, value in attrs
                            if key not in {"width", "height"}
                        ]
                        attrs.extend(
                            [("width", str(asset.width)), ("height", str(asset.height))]
                        )
                    original = (
                        "<img "
                        + " ".join(
                            f'{key}="{escape(hosted if key == "src" else value or "", quote=True)}"'
                            for key, value in attrs
                        )
                        + ">"
                    )
        self.output.append(original)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        self.output.append(f"</{tag}>")

    def handle_data(self, data):
        self.output.append(data)

    def handle_entityref(self, name):
        self.output.append(f"&{name};")

    def handle_charref(self, name):
        self.output.append(f"&#{name};")

    def handle_comment(self, data):
        self.output.append(f"<!--{data}-->")

    def handle_decl(self, decl):
        self.output.append(f"<!{decl}>")


def _read_varint(data: bytes, position: int) -> tuple[int, int]:
    value = 0
    for index in range(10):
        if position >= len(data):
            raise ValueError("truncated protobuf varint")
        byte = data[position]
        position += 1
        if index == 9 and byte > 1:
            raise ValueError("protobuf varint exceeds uint64")
        value |= (byte & 0x7F) << (index * 7)
        if byte < 0x80:
            return value, position
    raise ValueError("protobuf varint exceeds ten bytes")


def _write_varint(value: int) -> bytes:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > 0xFFFFFFFFFFFFFFFF
    ):
        raise ValueError(f"invalid protobuf varint value: {value}")
    output = bytearray()
    while value >= 0x80:
        output.append((value & 0x7F) | 0x80)
        value >>= 7
    output.append(value)
    return bytes(output)


def _request_id_payload(announcement_id: int) -> bytes:
    if (
        not isinstance(announcement_id, int)
        or isinstance(announcement_id, bool)
        or announcement_id < 1
    ):
        raise ValueError(f"invalid announcement id: {announcement_id}")
    return b"\x08" + _write_varint(announcement_id)


def _decode_fields(data: bytes) -> dict[int, list[int | bytes]]:
    """Decode the supported protobuf wire types with strict truncation checks."""

    fields: dict[int, list[int | bytes]] = {}
    position = 0
    while position < len(data):
        tag, position = _read_varint(data, position)
        field, wire = tag >> 3, tag & 7
        if field < 1 or field > 0x1FFFFFFF:
            raise ValueError("invalid protobuf field number")
        if wire == 2:
            size, position = _read_varint(data, position)
            if size > len(data) - position:
                raise ValueError("truncated protobuf length-delimited field")
            fields.setdefault(field, []).append(data[position : position + size])
            position += size
        elif wire == 0:
            value, position = _read_varint(data, position)
            fields.setdefault(field, []).append(value)
        elif wire == 5:
            if len(data) - position < 4:
                raise ValueError("truncated protobuf fixed32 field")
            position += 4
        elif wire == 1:
            if len(data) - position < 8:
                raise ValueError("truncated protobuf fixed64 field")
            position += 8
        else:
            raise ValueError(f"unsupported protobuf wire type: {wire}")
    if position != len(data):
        raise ValueError("trailing protobuf bytes")
    return fields


def _first(fields: dict[int, list[int | bytes]], field: int) -> int | bytes | None:
    values = fields.get(field)
    return values[0] if values else None


def _parse_header_blocks(data: bytes) -> dict[str, str]:
    text = data.decode("iso-8859-1", "replace")
    blocks = [block for block in re.split(r"\r?\n\r?\n", text) if block.strip()]
    if not blocks:
        raise RuntimeError("announcement response has no HTTP headers")
    status_line = next(
        (
            line
            for block in reversed(blocks)
            for line in block.splitlines()
            if line.startswith("HTTP/")
        ),
        "",
    )
    status_match = re.match(r"HTTP/\S+\s+(\d{3})(?:\s|$)", status_line)
    if not status_match or status_match.group(1) != "200":
        status = status_match.group(1) if status_match else "unknown"
        raise RuntimeError(f"announcement HTTP status {status}")
    headers: dict[str, str] = {}
    for block in blocks:
        for line in block.splitlines():
            if ":" not in line or line.startswith("HTTP/"):
                continue
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    if headers.get("grpc-status") != "0":
        raise RuntimeError(
            f"announcement gRPC status {headers.get('grpc-status', 'missing')}"
        )
    return headers


def _decode_grpc_frames(data: bytes) -> bytes:
    messages: list[bytes] = []
    position = 0
    while position < len(data):
        if len(data) - position < 5:
            raise ValueError("truncated gRPC frame header")
        compressed = data[position]
        size = int.from_bytes(data[position + 1 : position + 5], "big")
        position += 5
        if size > MAX_GRPC_MESSAGE_BYTES or size > len(data) - position:
            raise ValueError("invalid or truncated gRPC frame")
        payload = data[position : position + size]
        position += size
        if compressed not in {0, 1}:
            raise ValueError("invalid gRPC compression flag")
        if compressed == 1:
            raise ValueError("compressed gRPC responses are unsupported")
        if payload:
            messages.append(payload)
    return b"".join(messages)


def _grpc_body(
    url: str,
    payload: bytes,
    platform_header: dict[str, str],
    attempts: int = len(RETRY_DELAYS),
    *,
    proxy: str | None = None,
) -> bytes:
    header_arguments = [
        argument
        for name, value in platform_header.items()
        for argument in ("-H", f"{name}: {value}")
    ]
    command_prefix = [
        "curl",
        "--silent",
        "--show-error",
        "--http2-prior-knowledge",
        "--connect-timeout",
        "10",
        "--max-time",
        "25",
        "-H",
        "content-type: application/grpc",
        "-H",
        "te: trailers",
        "-A",
        GRPC_USER_AGENT,
        *header_arguments,
    ]
    if proxy:
        command_prefix.extend(["--proxy", proxy])
    frame = b"\x00" + len(payload).to_bytes(4, "big") + payload
    last_error: RuntimeError | None = None
    for delay in RETRY_DELAYS[: max(1, attempts)]:
        if delay:
            time.sleep(delay)
        with tempfile.TemporaryDirectory(
            prefix="haneoka-announcement-grpc-"
        ) as directory:
            header_file = Path(directory) / "headers"
            body_file = Path(directory) / "body"
            result = subprocess.run(
                [
                    *command_prefix,
                    "--dump-header",
                    str(header_file),
                    "--output",
                    str(body_file),
                    "--data-binary",
                    "@-",
                    url,
                ],
                input=frame,
                capture_output=True,
                timeout=35,
                check=False,
            )
            if result.returncode:
                last_error = RuntimeError(
                    f"announcement curl transport failed ({result.returncode})"
                )
                continue
            try:
                _parse_header_blocks(header_file.read_bytes())
                return _decode_grpc_frames(body_file.read_bytes())
            except (OSError, RuntimeError, ValueError) as error:
                last_error = RuntimeError(str(error))
    raise last_error or RuntimeError("announcement request failed")


def _text(value: int | bytes | None) -> str:
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else ""


def _entry(fields: dict[int, list[int | bytes]]) -> dict[str, Any]:
    def number(field: int) -> int:
        value = _first(fields, field)
        return value if isinstance(value, int) and not isinstance(value, bool) else 0

    entry: dict[str, Any] = {
        "id": number(1),
        "category": number(2),
        "title": _text(_first(fields, 3)),
        "startAt": number(7),
        "endAt": number(8),
        "updatedAt": number(14),
    }
    for source, target in ((5, "bodyImage"), (11, "banner")):
        url = _text(_first(fields, source)).strip()
        if url:
            entry[target] = url
    if number(15) != 0:
        entry["pinned"] = True
    return entry


def _visible_text(html: str) -> str:
    value = re.sub(
        r"<!--.*?-->|<style\b[^>]*>.*?</style>|<script\b[^>]*>.*?</script>",
        " ",
        html,
        flags=re.I | re.S,
    )
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _source_language(server: str, title: str, html: str) -> str | None:
    text = f"{title} {_visible_text(html)}"
    han_count = len(re.findall(r"[\u4e00-\u9fff]", text))
    kana_count = len(re.findall(r"[\u3041-\u3096\u30a1-\u30fa]", text))
    if kana_count and (
        server in {"jp", "jp-cbt"} or kana_count >= max(2, han_count * 0.12)
    ):
        return "ja"
    if re.search(r"[\uac00-\ud7af]", text):
        return "ko"
    if re.search(r"[\u4e00-\u9fff]", text):
        traditional = sum(character in _TRADITIONAL_MARKERS for character in text)
        simplified = sum(character in _SIMPLIFIED_MARKERS for character in text)
        if traditional > simplified and traditional:
            return "zh-Hant"
        if simplified > traditional and simplified:
            return "zh-Hans"
    if re.search(r"[A-Za-z]", text) and not re.search(
        r"[\u3041-\u3096\u30a1-\u30fa\uac00-\ud7af\u4e00-\u9fff]", text
    ):
        return "en"
    if server in {"jp", "jp-cbt"} and text:
        return "ja"
    return None


def _fetch_announcement_html(
    endpoint: str,
    announcement_id: int,
    platform_header: dict[str, str],
    proxy: str | None = None,
) -> str:
    body = _grpc_body(
        endpoint + GET_PATH,
        _request_id_payload(announcement_id),
        platform_header,
        proxy=proxy,
    )
    outer = _decode_fields(body)
    entry_bytes = _first(outer, 1)
    if not isinstance(entry_bytes, bytes):
        return ""
    return _text(_first(_decode_fields(entry_bytes), 6))


def _media_extension(media_type: str) -> str | None:
    return _IMAGE_TYPES.get(media_type.split(";", 1)[0].strip().lower())


def _download_image(
    url: str,
    authorization: str,
    target_root: Path,
    allowed_hosts: frozenset[str],
    attempts: int = len(RETRY_DELAYS),
) -> MediaAsset | None:
    parsed_url = urllib.parse.urlsplit(url)
    if (
        parsed_url.scheme.lower() != "https"
        or not parsed_url.hostname
        or parsed_url.hostname.lower() not in allowed_hosts
    ):
        return None
    for delay in RETRY_DELAYS[: max(1, attempts)]:
        if delay:
            time.sleep(delay)
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "image/*",
                "Accept-Encoding": "identity",
                "User-Agent": GRPC_USER_AGENT,
            },
        )
        if authorization:
            request.add_header("Authorization", authorization)
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                media_type = response.headers.get("Content-Type", "")
                extension = _media_extension(media_type)
                declared_size = response.headers.get("Content-Length")
                if declared_size and int(declared_size) > MAX_IMAGE_BYTES:
                    raise ValueError("announcement image exceeds the size limit")
                payload = response.read(MAX_IMAGE_BYTES + 1)
                if len(payload) > MAX_IMAGE_BYTES:
                    raise ValueError("announcement image exceeds the size limit")
        except (OSError, ValueError, urllib.error.URLError):
            continue
        if not payload or not extension:
            return None
        digest = hashlib.sha256(payload).hexdigest()
        filename = f"{digest}.{extension}"
        target = target_root / filename
        if not target.exists():
            target_root.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                prefix=f".{target.name}.", suffix=".tmp", dir=target_root, delete=False
            ) as output:
                temporary = Path(output.name)
            try:
                temporary.write_bytes(payload)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        with Image.open(target) as image:
            width, height = image.size
        return MediaAsset(
            media_type.split(";", 1)[0].strip().lower(),
            digest,
            target,
            filename,
            width,
            height,
        )
    return None


def _fresh_credential(config: ServerConfig) -> str:
    """Resolve a credential only from the selected server's version service."""

    if config.version_endpoint:
        try:
            info = discover_asset_version(
                config.version_endpoint,
                config.platform,
                skip_resolution_check=config.skip_public_resolution_check,
                proxy=proxy_from_env(config.version_proxy_env),
            )
        except (RuntimeError, ValueError):
            pass
        else:
            if info.cdn_password:
                return cdn_authorization(config.version_basic_user, info.cdn_password)
    for name in (
        f"RESOURCE_CDN_AUTHORIZATION_{config.id.upper().replace('-', '_')}",
        "RESOURCE_CDN_AUTHORIZATION",
    ):
        value = os.environ.get(name, "").strip()
        if value:
            return value if " " in value else f"Basic {value}"
    return ""


def public_announcement_document(
    collection: AnnouncementCollection,
    server: str,
    base_url: str = PUBLIC_BASE_URL,
) -> dict[str, Any]:
    base = base_url.rstrip("/")
    announcements: list[dict[str, Any]] = []
    for item in collection.document.get("announcements", []):
        record = dict(item)
        for field in ("bodyImage", "banner"):
            value = record.get(field)
            if isinstance(value, str) and value.startswith("media/"):
                record[field] = (
                    f"{base}/api/v1/announcements/media/{server}/{value.removeprefix('media/')}"
                )
            elif not isinstance(value, str):
                record.pop(field, None)
        announcements.append(record)
    return {
        "schema": ANNOUNCEMENT_SCHEMA,
        "server": server,
        "available": bool(collection.document.get("available")),
        "fetchedAt": collection.document.get("fetchedAt"),
        "announcements": announcements,
    }


def collect_announcements(
    config: ServerConfig, media_root: Path
) -> AnnouncementCollection:
    """Fetch one server's list, details, and media with bounded concurrency."""

    endpoint = config.announcements_endpoint.rstrip("/")
    if not endpoint:
        raise ValueError(f"no announcements endpoint for {config.id}")
    platform_header = {"x-platform": config.platform} if config.platform else {}
    proxy = proxy_from_env(config.version_proxy_env)
    authorization = _fresh_credential(config)
    allowed_hosts = frozenset(
        host
        for value in (
            config.announcements_endpoint,
            config.remote_root,
            config.master_remote_root,
        )
        if (host := urllib.parse.urlsplit(value).hostname)
    )
    entries = _decode_fields(
        _grpc_body(endpoint + LIST_PATH, b"", platform_header, proxy=proxy)
    )
    raw_entries = [
        _decode_fields(item) for item in entries.get(1, []) if isinstance(item, bytes)
    ][:MAX_ANNOUNCEMENTS]

    announcements: list[dict[str, Any]] = []
    image_requests: list[tuple[int, str, str]] = []
    for fields in raw_entries:
        entry = _entry(fields)
        if entry["id"] < 1:
            continue
        for key in ("bodyImage", "banner"):
            url = entry.pop(key, None)
            if isinstance(url, str):
                image_requests.append((entry["id"], key, url))
        announcements.append(entry)

    html_by_id: dict[int, str] = {}
    media_by_url: dict[str, MediaAsset | None] = {}
    unique_urls = sorted({url for _, _, url in image_requests})
    with ThreadPoolExecutor(max_workers=ANNOUNCEMENT_CONCURRENCY) as pool:
        detail_futures = {
            pool.submit(
                _fetch_announcement_html,
                endpoint,
                int(entry["id"]),
                platform_header,
                proxy,
            ): int(entry["id"])
            for entry in announcements
        }
        image_futures = {
            pool.submit(
                _download_image, url, authorization, media_root, allowed_hosts
            ): url
            for url in unique_urls
        }
        for future in as_completed([*detail_futures, *image_futures]):
            try:
                result = future.result()
            except (OSError, RuntimeError, ValueError, urllib.error.URLError):
                continue
            if future in detail_futures:
                announcement_id = detail_futures[future]
                if isinstance(result, str) and result:
                    html_by_id[announcement_id] = result
            else:
                media_by_url[image_futures[future]] = result

        inline_urls: set[str] = set()
        for body in html_by_id.values():
            images = _AnnouncementImages(endpoint)
            images.feed(body)
            inline_urls.update(images.urls)
        inline_futures = {
            pool.submit(
                _download_image, url, authorization, media_root, allowed_hosts
            ): url
            for url in inline_urls - set(media_by_url)
        }
        for future in as_completed(inline_futures):
            try:
                media_by_url[inline_futures[future]] = future.result()
            except (OSError, RuntimeError, ValueError, urllib.error.URLError):
                continue

    media_by_filename: dict[str, MediaAsset] = {}
    for announcement in announcements:
        announcement_id = int(announcement["id"])
        html = html_by_id.get(announcement_id, "")
        if html:
            hosted = {
                url: f"{PUBLIC_BASE_URL}/api/v1/announcements/media/{config.id}/{asset.filename}"
                for url, asset in media_by_url.items()
                if asset is not None
            }
            images = _AnnouncementImages(endpoint, hosted, media_by_url)
            images.feed(html)
            images.close()
            announcement["html"] = "".join(images.output)
            for url in images.urls:
                asset = media_by_url.get(url)
                if asset is not None:
                    media_by_filename[asset.filename] = asset
        language = _source_language(
            config.id, str(announcement.get("title") or ""), html
        )
        if language:
            announcement["sourceLanguage"] = language
        for item_id, field, url in image_requests:
            if item_id != announcement_id:
                continue
            asset = media_by_url.get(url)
            if asset is None:
                continue
            announcement[field] = f"media/{asset.filename}"
            announcement[field + "Width"] = asset.width
            announcement[field + "Height"] = asset.height
            media_by_filename[asset.filename] = asset

    document = {
        "schema": ANNOUNCEMENT_SCHEMA,
        "server": config.id,
        "available": True,
        "fetchedAt": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "announcements": announcements,
    }
    return AnnouncementCollection(document, tuple(media_by_filename.values()))


def _unavailable_document(server: str) -> dict[str, Any]:
    return {
        "schema": ANNOUNCEMENT_SCHEMA,
        "server": server,
        "available": False,
        "fetchedAt": None,
        "announcements": [],
    }


def build_announcements(server: str, build_id: str) -> dict[str, Any]:
    """Build a local operational snapshot for focused pipeline runs."""

    config = load_server_config(server)
    layout = build_layout(server, build_id)
    snapshot_path = layout.assets / "operation" / "announcements.json"
    media_root = layout.assets / "operation" / "announcements" / "media"
    error: str | None = None
    document: dict[str, Any] | None = None
    if config.announcements_endpoint:
        try:
            collection = collect_announcements(config, media_root)
            document = public_announcement_document(collection, config.id)
        except Exception as exc:  # noqa: BLE001 - auxiliary stage never blocks a release
            error = f"{type(exc).__name__}: {exc}"
    else:
        error = "no announcements endpoint in the selected server configuration"

    if document is not None:
        write_json(snapshot_path, document)
    elif not snapshot_path.exists():
        write_json(snapshot_path, _unavailable_document(config.id))

    result: dict[str, Any] = {
        "schema": "haneoka-announcements-build-v1",
        "server": config.id,
        "buildId": build_id,
        "available": bool(document and document.get("available")),
        "announcements": len(document.get("announcements", [])) if document else 0,
        "images": sum(
            isinstance(item, dict) and ("bodyImage" in item or "banner" in item)
            for item in (document or {}).get("announcements", [])
        ),
        "snapshotPreserved": document is None and snapshot_path.exists(),
    }
    if error is not None:
        result["error"] = error
    write_json(layout.reports / "announcements.json", result, pretty=True)
    return result
