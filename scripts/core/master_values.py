"""Native Master text slots and calendar timestamps shared by resource projections."""
from __future__ import annotations

import re
from datetime import datetime, timezone, timedelta
from typing import Any
from pathlib import PurePosixPath

LOCALE_FIELDS = (
    "_japanese",
    "_english",
    "_traditionalChinese",
    "_simplifiedChinese",
    "_korean",
)
JST = timezone(timedelta(hours=9))


def _localized(row: dict[str, Any] | None, fallback: str = "") -> list[str]:
    row = row or {}
    identifier = str(row.get("_id") or "")
    values = [str(row.get(field) or "") for field in LOCALE_FIELDS]
    for index, value in enumerate(values):
        if index == 0:
            continue
        is_music_placeholder = identifier.startswith(("Music_Tilte_", "Music_Ruby_Tilte_", "Music_Phonetic_Tilte_")) and re.fullmatch(r"Music_Tilte_\d+", value)
        if value and (value == identifier or is_music_placeholder):
            values[index] = ""
    return values if any(values) else [str(fallback), "", "", "", ""]


def _timestamp(value: Any) -> list[int | None]:
    text = str(value or "").strip().replace("/", "-")
    if not text:
        return [0, None, None, None, None]
    try:
        text = re.sub(r" (\d):", r" 0\1:", text)
        parsed = datetime.fromisoformat(text).replace(tzinfo=JST)
        milliseconds = int(parsed.timestamp() * 1000)
    except ValueError:
        milliseconds = 0
    return [milliseconds, None, None, None, None]



def _image_variants(data: Any, record: dict[str, Any]) -> dict[str, dict[str, str]]:
    prefix = f"/assets/{data.server}/"
    urls: set[str] = set()

    def collect(value: Any) -> None:
        if isinstance(value, str) and value.startswith(prefix):
            urls.add(value)
        elif isinstance(value, dict):
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(record)
    variants: dict[str, dict[str, str]] = {}
    for url in sorted(urls):
        source = PurePosixPath(url[len(prefix):])
        if source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            continue
        choices = {"ja": url}
        for locale in ("en", "zh-Hant", "zh-Hans", "ko"):
            candidate = source.with_name(f"{source.stem}({locale}){source.suffix}")
            if data.has_asset(candidate.as_posix()):
                choices[locale] = f"{prefix}{candidate.as_posix()}"
        if len(choices) > 1:
            variants[url] = choices
    return variants



RESOURCE_TYPES = {
    1: "Item", 2: "MemberCard", 3: "SupportCard",
    4: "Voice", 5: "LoginBonus", 6: "Subscription", 7: "GachaPoint",
    8: "Music", 9: "Stamp", 10: "PremiumPass", 11: "EventMedal",
    12: "LiveLaneSkin", 13: "LiveNoteSkin", 14: "LiveNoteEffectSkin",
    15: "LiveNoteSEGroup", 16: "VipPoint", 17: "Degree",
}
