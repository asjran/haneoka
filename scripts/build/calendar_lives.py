"""Build a local calendar snapshot from bandori.fans' public month calendar.

Only this build stage performs network I/O. Dates come from the published month
grid; MusicEvent JSON-LD supplies times, venues, performers and cover metadata.
Artwork is mirrored at build time; runtime image addresses remain same-origin.
"""

from __future__ import annotations

import argparse
import calendar
import copy
import hashlib
import json
import math
import re
import shutil
import struct
import subprocess
import tempfile
import time
import unicodedata
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable

from core.config import PROJECT_ROOT, validate_server_id
from core.manifests import atomic_write, read_json, stable_json, write_json
from core.paths import build_layout, safe_id, source_layout

SCHEMA = "haneoka-calendar-lives-v1"
SOURCE = "https://bandori.fans"
MAX_BYTES = 2 * 1024 * 1024
MAX_EVENTS = 1000
MAX_MONTHS = 6
MAX_DETAILS = 12
INPUT_SCHEMA = "haneoka-bandori-calendar-input-v1"
INPUT_TTL_SECONDS = 600
MATCH_MIN_SCORE = 90
MATCH_MARGIN = 15
JST = timezone(timedelta(hours=9))
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


def _image_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or parsed.netloc != "api.bandori.fans" or parsed.query or parsed.fragment
            or not re.fullmatch(r"/v1/images/events/[a-f0-9-]{36}\.png", parsed.path)):
        return None
    return value


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _month(value: str) -> date:
    if not re.fullmatch(r"\d{4}-\d{2}", value):
        raise ValueError("invalid calendar month")
    return date.fromisoformat(value + "-01")


def _next_month(value: date) -> date:
    return date(value.year + (value.month == 12), value.month % 12 + 1, 1)


def _detail_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or parsed.netloc != "bandori.fans" or parsed.query or parsed.fragment
            or not re.fullmatch(r"/en/events/[a-z0-9-]{1,200}", parsed.path)):
        raise ValueError("invalid public Live source URL")
    return value


def _clean(value: Any, limit: int = 500) -> str | None:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        return None
    return value.strip()


class _CalendarPage(HTMLParser):
    """Consume visible, semantic month-grid attributes, not Next.js internals."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict[str, Any]] = []
        self.days: set[str] = set()
        self.months: set[str] = set()
        self.events: list[dict[str, Any]] = []
        self.units: list[dict[str, str]] = []
        self.source_version: str | None = None

    def handle_starttag(self, tag: str, values: list[tuple[str, str | None]]) -> None:
        attrs = dict(values)
        classes = (attrs.get("class") or "").split()
        parent = self.stack[-1] if self.stack else {}
        frame: dict[str, Any] = {"tag": tag, "date": parent.get("date"), "grid": parent.get("grid", False)}
        if "bf-cal-month" in classes and attrs.get("data-testid") == "month-grid":
            frame["grid"] = True
            match = re.search(r"\b(\d{4}-\d{2})\b", attrs.get("aria-label") or "")
            if match:
                self.months.add(match[1])
        if frame["grid"] and "bf-cal-cell" in classes:
            value = attrs.get("data-date") or ""
            date.fromisoformat(value)
            self.days.add(value)
            frame["date"] = value
        if tag == "button" and attrs.get("name") == "band" and attrs.get("value"):
            color = re.search(r"(?:^|;)--band-color:(#[0-9a-fA-F]{6})(?:;|$)", attrs.get("style") or "")
            if color:
                frame["unit"] = {"id": attrs["value"], "color": color[1].lower()}
                frame["text"] = []
        if attrs.get("data-mask") == "utility-time":
            frame["version"] = True
            frame["text"] = []
        if tag == "a" and frame["grid"] and frame["date"] and attrs.get("data-kind") == "live":
            identity = re.fullmatch(r"cal-event-live-([0-9]{1,12})", attrs.get("data-testid") or "")
            title = _clean(attrs.get("title"))
            color = re.search(r"(?:^|;)--band-color:(#[0-9a-fA-F]{6})(?:;|$)", attrs.get("style") or "")
            if not identity or not title:
                raise ValueError("calendar Live schema changed")
            self.events.append({
                "sourceId": identity[1], "date": frame["date"], "title": title,
                "sourceUrl": _detail_url(urllib.parse.urljoin(SOURCE, attrs.get("href") or "")),
                "color": color[1].lower() if color else None,
                "cancelled": attrs.get("data-status") == "cancelled",
            })
            if len(self.events) > MAX_EVENTS:
                raise ValueError("too many calendar Lives")
        if tag not in VOID:
            if len(self.stack) >= 64:
                raise ValueError("calendar HTML nesting exceeded bounds")
            self.stack.append(frame)

    def handle_data(self, data: str) -> None:
        for frame in self.stack:
            if "text" in frame:
                frame["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                frames = self.stack[index:]
                del self.stack[index:]
                for frame in frames:
                    text = " ".join("".join(frame.get("text", [])).split())
                    if frame.get("unit") and text:
                        self.units.append({**frame["unit"], "name": text})
                    if frame.get("version"):
                        self.source_version = text[:200]
                return


class _JsonLd(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.active = False
        self.parts: list[str] = []
        self.documents: list[Any] = []
        self.og_image: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "meta" and values.get("property") == "og:image":
            self.og_image = _image_url(values.get("content"))
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self.active = True
            self.parts = []

    def handle_data(self, data: str) -> None:
        if self.active:
            self.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self.active:
            self.active = False
            self.documents.append(json.loads("".join(self.parts)))


def parse_calendar_page(text: str, month: str) -> tuple[list[dict[str, Any]], str | None]:
    first = _month(month)
    page = _CalendarPage()
    page.feed(text)
    page.close()
    days = {date(first.year, first.month, n).isoformat() for n in range(1, calendar.monthrange(first.year, first.month)[1] + 1)}
    if month not in page.months or not days.issubset(page.days):
        raise ValueError("incomplete or unexpected source month grid")
    unique: dict[str, dict[str, Any]] = {}
    for item in page.events:
        if item["date"] not in days:
            continue
        colors = [unit for unit in page.units if unit["color"] == item["color"]]
        units = [{"id": colors[0]["id"], "name": colors[0]["name"], "role": "calendar-band"}] if len(colors) == 1 else []
        identity = f"bandori-fans:live:{item['sourceId']}:{item['date']}"
        event = {
            "id": identity, "sourceId": item["sourceId"], "kind": "real-live", "title": item["title"],
            "startDate": item["date"], "endDateExclusive": (date.fromisoformat(item["date"]) + timedelta(days=1)).isoformat(),
            "allDay": True, "timeZone": None, "datePrecision": "day", "dateBasis": "source-calendar",
            "startAtMs": None, "endAtMs": None, "startLocal": None, "venue": None, "units": units,
            "sourceUrl": item["sourceUrl"], "officialUrl": None, "sourceUpdatedAt": None,
            "cancelled": item["cancelled"],
            "provider": "bandori.fans", "sources": ["bandori.fans"], "performers": [],
            "image": None, "sourceImageUrl": None,
        }
        if identity in unique and unique[identity] != event:
            raise ValueError("conflicting source Live identity")
        unique[identity] = event
    return sorted(unique.values(), key=lambda row: (row["startDate"], row["id"])), page.source_version


def enrich_detail(events: list[dict[str, Any]], source_url: str, text: str) -> None:
    parser = _JsonLd()
    parser.feed(text)
    documents = [row for row in parser.documents if isinstance(row, dict) and row.get("@type") == "MusicEvent" and row.get("url") == source_url]
    if len(documents) != 1:
        raise ValueError("Live detail MusicEvent schema changed")
    source = documents[0]
    poster = _image_url(source.get("image")) or parser.og_image
    performers = source.get("performer")
    performers = performers if isinstance(performers, list) else [performers]
    parsed_performers = []
    for row in performers:
        if not isinstance(row, dict) or not (name := _clean(row.get("name"))):
            continue
        identifier = row.get("@id") or row.get("identifier")
        aliases = row.get("alternateName")
        aliases = aliases if isinstance(aliases, list) else [aliases]
        parsed_performers.append({"name": name, "id": identifier if isinstance(identifier, str) else None,
                                  "aliases": [alias for value in aliases[:20] if (alias := _clean(value, 200))]})
    performers = parsed_performers
    value = _clean(source.get("startDate"), 64)
    if not value:
        raise ValueError("Live detail has no date")
    local_day = date.fromisoformat(value[:10]).isoformat()
    instant = None
    if "T" in value:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is not None:
            instant = stamp
    for event in events:
        if event["sourceUrl"] != source_url:
            continue
        event["sourceImageUrl"] = poster
        event["performers"] = performers
        event["detailTitle"] = _clean(source.get("name"))
        event["sourceDetailUrl"] = source_url
        # The root MusicEvent describes its first performance. It cannot supply
        # a timestamp or venue to another day of a tour just because URLs match.
        if event["sourceUrl"] != source_url or event["startDate"] != local_day:
            continue
        location = source.get("location")
        if isinstance(location, dict) and _clean(location.get("name")):
            event["venue"] = {"name": location["name"].strip()}
            address = location.get("address")
            if isinstance(address, dict):
                for field, key in [("country", "addressCountry"), ("city", "addressLocality")]:
                    if name := _clean(address.get(key)):
                        event["venue"][field] = name
        official = source.get("sameAs")
        if isinstance(official, list):
            event["officialUrl"] = next((url for url in official if isinstance(url, str) and url.startswith("https://") and not urllib.parse.urlsplit(url).username), None)
        if instant:
            event["allDay"] = False
            event["datePrecision"] = "minute"
            event["startAtMs"] = round(instant.timestamp() * 1000)
            event["startLocal"] = value
            event["utcOffset"] = instant.strftime("%z")[:3] + ":" + instant.strftime("%z")[3:]
            # Offset is certain; an IANA zone is not established by offset alone.


def _norm(value: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFKC", value).casefold() if char.isalnum())


def _names(value: Any) -> set[str]:
    values = value if isinstance(value, list) else [value]
    return {_norm(text) for text in values if isinstance(text, str) and text.strip()}


def _stamp(value: Any) -> int | None:
    value = value[0] if isinstance(value, list) and value else value
    return round(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0 else None


def _day_number(value: str) -> int | None:
    match = re.search(r"(?<![A-Za-z0-9])day[\s._-]*([0-9]+)(?![0-9])|第\s*([0-9]+)\s*日", unicodedata.normalize("NFKC", value), re.I)
    return int(next(part for part in match.groups() if part)) if match else None


def _rank_live(event: dict[str, Any], row: dict[str, Any]) -> tuple[int, list[str]]:
    start, end = _stamp(row.get("startAt")), _stamp(row.get("endAt"))
    if start is None or (end is not None and end < start):
        return 0, []
    end = end if end is not None else start
    live_start = _stamp(event.get("startAtMs"))
    day = datetime.fromtimestamp(live_start / 1000, JST).date() if live_start else date.fromisoformat(event["startDate"])
    start_day, end_day = [datetime.fromtimestamp(value / 1000, JST).date() for value in [start, end]]
    if not start_day <= day <= end_day:
        return 0, []
    bands = [band for band in row.get("bands", []) if isinstance(band, dict)]
    native_names = {name for band in bands for name in (_names(band.get("name") or band.get("bandName")) | _names(band.get("aliases")))}
    artist_names = {name for unit in [*event.get("units", []), *event.get("performers", [])] for name in (_names(unit.get("name")) | _names(unit.get("aliases")))}
    source_names = _norm(event["title"] + " " + str(event.get("detailTitle") or ""))
    unit_names = bool(native_names & artist_names) or any(len(name) >= 3 and name in source_names for name in native_names)
    native_slugs = {band.get("slug") for band in bands if isinstance(band.get("slug"), str)}
    for band in bands:
        external = band.get("externalIds")
        if isinstance(external, dict) and isinstance(external.get("bandori.fans"), str):
            native_slugs.add(external["bandori.fans"])
    source_slugs = {unit.get("id") for unit in [*event.get("units", []), *event.get("performers", [])] if isinstance(unit.get("id"), str)}
    same_entity = bool(native_slugs & source_slugs)
    if not unit_names and not same_entity:
        return 0, []
    score = 70 if same_entity else 60
    evidence = ["same-artist-entity" if same_entity else "native-localized-artist-alias", "game-window-contains-live-date"]
    score += 30
    if day == end_day:
        score += 10
        evidence.append("game-window-closing-date")
    elif day == start_day:
        evidence.append("game-window-opening-date")
    title_names = _names(row.get("title"))
    source_title = _norm(event["title"])
    native_day = next((_day_number(str(title)) for title in row.get("title", []) if _day_number(str(title)) is not None), None) if isinstance(row.get("title"), list) else _day_number(str(row.get("title", "")))
    live_day = _day_number(event["title"])
    if native_day is not None and live_day is not None:
        if native_day != live_day:
            return 0, []
        score += 20
        evidence.append("same-day-performance")
    if source_title in title_names and source_title not in native_names:
        score += 40
        evidence.append("same-full-title")
    else:
        # Shared concert-series fragments exclude the band name itself.
        for title in title_names:
            series = title
            for artist in native_names:
                series = series.replace(artist, "")
            if len(series) >= 5 and series in source_title:
                score += 20
                evidence.append("same-concert-series")
                break
    venue = row.get("venue")
    if isinstance(venue, dict) and event.get("venue") and _norm(str(venue.get("name", ""))) == _norm(event["venue"]["name"]):
        score += 20
        evidence.append("same-venue")
    if live_start is not None:
        distance = min(abs(live_start - start), abs(live_start - end))
        if distance <= 60000:
            score += 30
            evidence.append("same-window-boundary-and-show-time")
        elif distance <= 3600000:
            score += 10
            evidence.append("near-window-boundary-and-show-time")
    return score, evidence


def match_real_lives(events: list[dict[str, Any]], catalog: dict[str, Any]) -> None:
    entries = catalog.get("entries")
    if not isinstance(entries, dict):
        raise ValueError("same-build real-lives catalog is unavailable")
    rankings: dict[str, list[tuple[int, str, list[str]]]] = {}
    reverse: dict[str, list[tuple[int, str]]] = {}
    for event in events:
        ranked: list[tuple[int, str, list[str]]] = []
        for identity, row in entries.items():
            if not isinstance(row, dict) or row.get("id") != identity:
                continue
            score, evidence = _rank_live(event, row)
            if score:
                ranked.append((score, identity, evidence))
                reverse.setdefault(identity, []).append((score, event["id"]))
        rankings[event["id"]] = sorted(ranked, key=lambda value: (-value[0], value[1]))
    for event in events:
        ranked = rankings[event["id"]]
        selected = ranked[0] if ranked else None
        strong = selected is not None and selected[0] >= MATCH_MIN_SCORE
        gap = selected[0] - ranked[1][0] if selected and len(ranked) > 1 else 999
        competitors = sorted(reverse.get(selected[1], []) if selected else [], key=lambda value: (-value[0], value[1]))
        mutual = bool(competitors) and competitors[0][1] == event["id"] and (len(competitors) == 1 or competitors[0][0] - competitors[1][0] >= MATCH_MARGIN)
        matched = strong and gap >= MATCH_MARGIN and mutual
        event["match"] = {
            "status": "matched" if matched else "ambiguous" if strong else "unmatched",
            "realLiveId": selected[1] if matched else None,
            "evidence": selected[2] if matched else [],
            "candidateIds": [value[1] for value in ranked],
            "rankedCandidates": [{"id": value[1], "score": value[0], "features": value[2]} for value in ranked],
        }
        if matched:
            native = entries[selected[1]]
            event["gameWindow"] = {"startAtMs": _stamp(native.get("startAt")), "endAtMs": _stamp(native.get("endAt")), "readyAtMs": _stamp(native.get("readyAt"))}
            event["sources"] = ["our-notes", "bandori.fans"]
        else:
            event.pop("gameWindow", None)
            event["sources"] = ["bandori.fans"]


class PublicCalendarFetcher:
    """curl >= 8.4 bounds unknown-length bodies and the entire transfer time."""

    def __init__(self, timeout: float = 10, budget: float = 45) -> None:
        self.timeout = timeout
        self.deadline = time.monotonic() + budget
        self.calls = 0
        self.curl_checked = False

    def __call__(self, url: str) -> str:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "bandori.fans" or parsed.fragment:
            raise ValueError("unexpected calendar source")
        if parsed.path == "/en/calendar":
            params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
            if set(params) != {"ym"} or len(params["ym"]) != 1:
                raise ValueError("unexpected month query")
            _month(params["ym"][0])
        else:
            _detail_url(url)
        return self._payload(url, "text/html").decode("utf-8", "strict")

    def image(self, url: str) -> bytes:
        if _image_url(url) != url:
            raise ValueError("unexpected calendar poster source")
        return self._payload(url, "image/png")

    def _payload(self, url: str, content_type: str) -> bytes:
        self.calls += 1
        if self.calls > MAX_MONTHS + 2 * MAX_DETAILS:
            raise ValueError("calendar request limit exceeded")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("calendar fetch budget exhausted")
        try:
            if not self.curl_checked:
                result = subprocess.run(
                    ["curl", "--disable", "--version"], capture_output=True,
                    timeout=min(2, remaining), check=True,
                )
                version = re.match(rb"curl (\d+)\.(\d+)\.(\d+)", result.stdout)
                if not version or tuple(int(part) for part in version.groups()) < (8, 4, 0):
                    raise ValueError("calendar fetch requires curl >= 8.4")
                self.curl_checked = True
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("calendar fetch budget exhausted")
            seconds = min(self.timeout, remaining)
            with tempfile.TemporaryDirectory(prefix="haneoka-calendar-") as directory:
                output = Path(directory) / "body"
                result = subprocess.run(
                    ["curl", "--disable", "--silent", "--show-error", "--proto", "=https",
                     "--max-time", str(seconds), "--connect-timeout", str(min(5, seconds)),
                     "--max-filesize", str(MAX_BYTES), "--user-agent", "Mozilla/5.0",
                     "--header", f"Accept: {content_type}", "--header", "Accept-Encoding: identity",
                     "--output", str(output), "--write-out", "%{http_code}\n%{content_type}",
                     "--url", url],
                    capture_output=True, timeout=seconds + 1, check=False,
                )
                if result.returncode == 28:
                    raise TimeoutError("calendar transfer timed out")
                if result.returncode:
                    raise OSError(f"calendar transport failed ({result.returncode})")
                status = result.stdout.decode("ascii", "replace").splitlines()
                if (len(status) != 2 or status[0] != "200"
                        or status[1].split(";", 1)[0].strip().lower() != content_type):
                    raise ValueError("unexpected calendar response")
                if output.stat().st_size > MAX_BYTES:
                    raise ValueError("calendar response exceeded bounds")
                return output.read_bytes()
        except subprocess.TimeoutExpired as error:
            raise TimeoutError("calendar process timed out") from error
        except subprocess.CalledProcessError as error:
            raise OSError("could not inspect calendar curl runtime") from error


def create_snapshot(
    pin: dict[str, str], catalog: dict[str, Any], month: str, months: int,
    fetch: Callable[[str], str], *, detail_url: str | None = None, fetched_at: str | None = None,
) -> dict[str, Any]:
    if not 1 <= months <= MAX_MONTHS:
        raise ValueError("calendar month count outside bounds")
    first = current = _month(month)
    events: list[dict[str, Any]] = []
    versions: list[str] = []
    urls: list[str] = []
    for _ in range(months):
        url = f"{SOURCE}/en/calendar?ym={current:%Y-%m}"
        rows, version = parse_calendar_page(fetch(url), f"{current:%Y-%m}")
        events.extend(rows)
        urls.append(url)
        if version and version not in versions:
            versions.append(version)
        current = _next_month(current)
    if len(events) > MAX_EVENTS:
        raise ValueError("calendar event limit exceeded")
    if detail_url:
        _detail_url(detail_url)
        if not any(event["sourceUrl"] == detail_url for event in events):
            raise ValueError("detail URL is outside the selected calendar")
        enrich_detail(events, detail_url, fetch(detail_url))
        urls.append(detail_url)
    document = {
        "schema": SCHEMA, "available": True, "status": "fresh", "fetchedAt": fetched_at or _utc_now(),
        "pin": pin, "coverage": {"from": first.isoformat(), "untilExclusive": current.isoformat()},
        "source": {"provider": "bandori.fans", "url": f"{SOURCE}/en/calendar", "method": "public-month-html-and-MusicEvent-jsonld",
                   "apiUrl": None, "license": "CC-BY-NC-SA-4.0", "licenseUrl": "https://github.com/bangdream-NA/bandori-fans/blob/main/LICENSE",
                   "sourceVersions": versions, "requests": urls},
        "events": events,
    }
    match_real_lives(events, catalog)
    return document


def _coverage(month: str, months: int) -> dict[str, str]:
    if not 1 <= months <= MAX_MONTHS:
        raise ValueError("calendar month count outside bounds")
    first = last = _month(month)
    for _ in range(months):
        last = _next_month(last)
    return {"from": first.isoformat(), "untilExclusive": last.isoformat()}


def _provider_capture(
    catalog: dict[str, Any], month: str, months: int, fetch: Callable[[str], str], detail_limit: int,
    fetched_at: str | None = None,
) -> dict[str, Any]:
    if not 0 <= detail_limit <= MAX_DETAILS:
        raise ValueError("calendar detail count outside bounds")
    # Selection prioritizes relevant game windows; there are no concert/date tables.
    document = create_snapshot({}, catalog, month, months, fetch, fetched_at=fetched_at)
    selected = sorted(document["events"], key=lambda row: (
        -max((item["score"] for item in row["match"]["rankedCandidates"]), default=0), row["startDate"], row["id"],
    ))
    urls = list(dict.fromkeys(row["sourceUrl"] for row in selected))[:detail_limit]
    errors = []
    for url in urls:
        try:
            enrich_detail(document["events"], url, fetch(url))
        except (OSError, ValueError, KeyError) as error:
            errors.append({"url": url, "kind": type(error).__name__})
    for event in document["events"]:
        for key in ["match", "gameWindow"]:
            event.pop(key, None)
        event["sources"] = ["bandori.fans"]
    document.pop("pin", None)
    document["schema"] = INPUT_SCHEMA
    document["source"]["requests"].extend(urls)
    document["source"]["detailErrors"] = errors
    document["source"]["detailLimit"] = detail_limit
    return document


def _read_capture(file: Path, coverage: dict[str, str], detail_limit: int) -> dict[str, Any] | None:
    if not file.exists() or file.stat().st_size > MAX_BYTES:
        return None
    try:
        value = read_json(file)
        if (not isinstance(value, dict) or value.get("schema") != INPUT_SCHEMA
                or value.get("coverage") != coverage or value.get("available") is not True
                or not isinstance(value.get("source"), dict)
                or value["source"].get("provider") != "bandori.fans"
                or value["source"].get("detailLimit") != detail_limit
                or not isinstance(value.get("events"), list) or len(value["events"]) > MAX_EVENTS):
            return None
        datetime.fromisoformat(value["fetchedAt"].replace("Z", "+00:00"))
        for row in value["events"]:
            if (not isinstance(row, dict) or not isinstance(row.get("id"), str)
                    or not row["id"].startswith("bandori-fans:") or not isinstance(row.get("title"), str)
                    or not isinstance(row.get("units"), list) or not isinstance(row.get("performers"), list)):
                return None
            if any(not isinstance(unit, dict) or not isinstance(unit.get("name"), str)
                   for unit in [*row["units"], *row["performers"]]):
                return None
            day = date.fromisoformat(row["startDate"])
            if row["endDateExclusive"] != (day + timedelta(days=1)).isoformat():
                return None
            if not coverage["from"] <= row["startDate"] < coverage["untilExclusive"]:
                return None
            _detail_url(row["sourceUrl"])
        return value
    except (OSError, ValueError, TypeError, KeyError):
        return None


def _load_provider_capture(
    catalog: dict[str, Any], month: str, months: int, detail_limit: int, cache_root: Path,
    fetch: Callable[[str], str], fetched_at: str | None = None,
) -> dict[str, Any]:
    coverage = _coverage(month, months)
    file = cache_root / f"{month}-{months}-d{detail_limit}.json"
    previous = _read_capture(file, coverage, detail_limit)
    if previous:
        age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(previous["fetchedAt"].replace("Z", "+00:00")).timestamp()
        if 0 <= age <= INPUT_TTL_SECONDS:
            return previous
    try:
        document = _provider_capture(catalog, month, months, fetch, detail_limit, fetched_at)
        write_json(file, document)
        return document
    except (OSError, ValueError, KeyError) as error:
        if previous:
            return {**previous, "status": "stale", "attemptedAt": _utc_now(), "lastError": type(error).__name__}
        return {"schema": INPUT_SCHEMA, "available": False, "status": "unavailable", "fetchedAt": None,
                "coverage": coverage, "events": [], "source": {"provider": "bandori.fans", "url": f"{SOURCE}/en/calendar"},
                "attemptedAt": _utc_now(), "lastError": type(error).__name__}


def _png_info(data: bytes) -> tuple[int, int]:
    if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("calendar poster is not PNG")
    width, height = struct.unpack(">II", data[16:24])
    if not 0 < width <= 8192 or not 0 < height <= 8192:
        raise ValueError("calendar poster dimensions exceeded bounds")
    return width, height


def mirror_calendar_images(
    document: dict[str, Any], cache_root: Path, asset_root: Path | None,
    fetch_image: Callable[[str], bytes],
) -> None:
    assets = []
    errors = []
    urls = list(dict.fromkeys(row.get("sourceImageUrl") for row in document["events"] if row.get("sourceImageUrl")))[:MAX_DETAILS]
    for url in urls:
        if _image_url(url) != url:
            continue
        index = cache_root / "posters" / (hashlib.sha256(url.encode()).hexdigest() + ".json")
        data = None
        try:
            if index.exists():
                metadata = read_json(index)
                filename = metadata.get("filename", "") if isinstance(metadata, dict) and metadata.get("sourceUrl") == url else ""
                if re.fullmatch(r"[a-f0-9]{64}\.png", filename):
                    file = index.parent / filename
                    if file.exists() and file.stat().st_size <= MAX_BYTES:
                        candidate = file.read_bytes()
                        if hashlib.sha256(candidate).hexdigest() == filename[:-4]:
                            data = candidate
            if data is None:
                data = fetch_image(url)
                if len(data) > MAX_BYTES:
                    raise ValueError("calendar poster exceeded bounds")
            width, height = _png_info(data)
            digest = hashlib.sha256(data).hexdigest()
            filename = f"{digest}.png"
            file = index.parent / filename
            atomic_write(file, data)
            write_json(index, {"sourceUrl": url, "filename": filename, "sha256": digest})
            if asset_root:
                asset_root.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, asset_root / filename)
            relative = f"images/calendar-lives/{filename}"
            asset = {"path": relative, "sha256": digest, "bytes": len(data), "width": width, "height": height, "sourceUrl": url}
            assets.append(asset)
            for row in document["events"]:
                if row.get("sourceImageUrl") == url:
                    row["image"] = "/" + relative
                    row["imageWidth"], row["imageHeight"] = width, height
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append({"sourceUrl": url, "kind": type(error).__name__})
    document["assets"] = assets
    document["source"]["imageErrors"] = errors


def build_selected_calendar_lives(
    server: str, release_id: str, source_id: str, real_lives: dict[str, Any], *,
    month: str | None = None, months: int = 3, detail_limit: int = MAX_DETAILS,
    output: Path | None = None, cache_root: Path | None = None, asset_root: Path | None = None,
    fetch: Callable[[str], str] | None = None, fetch_image: Callable[[str], bytes] | None = None,
    fetched_at: str | None = None,
) -> dict[str, Any]:
    validate_server_id(server)
    safe_id(source_id, "source id")
    if not re.fullmatch(r"r-[a-f0-9]{20}", release_id):
        raise ValueError("invalid selected release")
    if not isinstance(real_lives.get("entries"), dict):
        raise ValueError("selected real-lives catalog is invalid")
    serialized = stable_json(real_lives).encode()
    if len(serialized) > MAX_BYTES:
        raise ValueError("selected real-lives catalog exceeded bounds")
    pin = {"server": server, "releaseId": release_id, "sourceId": source_id, "realLivesSha256": hashlib.sha256(serialized).hexdigest()}
    month = month or datetime.now(JST).strftime("%Y-%m")
    cache_root = cache_root or PROJECT_ROOT / "data/calendar/bandori-fans"
    network = PublicCalendarFetcher()
    captured = _load_provider_capture(real_lives, month, months, detail_limit, cache_root, fetch or network, fetched_at)
    document = copy.deepcopy(captured)
    document["schema"] = SCHEMA
    document["pin"] = pin
    document["sourceInputSha256"] = hashlib.sha256(stable_json(captured).encode()).hexdigest()
    document["matcherVersion"] = "window-artists-series-v1"
    # Recompute every association against the caller's current immutable catalog.
    for event in document["events"]:
        event.pop("match", None)
        event.pop("gameWindow", None)
    match_real_lives(document["events"], real_lives)
    mirror_calendar_images(document, cache_root, asset_root, fetch_image or network.image)
    target = output or PROJECT_ROOT / "data/calendar" / server / release_id / "calendar-lives.json"
    write_json(target, document)
    return document


def build_calendar_lives(
    server: str, build_id: str, source_id: str, *, month: str | None = None, months: int = 3,
    output: Path | None = None, detail_url: str | None = None, fetch: Callable[[str], str] | None = None,
    fetched_at: str | None = None,
) -> dict[str, Any]:
    layout = build_layout(server, build_id)
    safe_id(source_id, "source id")
    source_manifest = read_json(source_layout(server, source_id).manifest)
    if (not isinstance(source_manifest, dict) or source_manifest.get("server") != server
            or source_manifest.get("sourceId") != source_id or not build_id.startswith(f"b-{source_id}-")):
        raise ValueError("calendar source/build pin mismatch")
    catalog_path = layout.api / "real-lives.json"
    catalog_bytes = catalog_path.read_bytes()
    if len(catalog_bytes) > MAX_BYTES:
        raise ValueError("real-lives catalog exceeded bounds")
    catalog = json.loads(catalog_bytes)
    pin = {"server": server, "sourceId": source_id, "buildId": build_id, "realLivesSha256": hashlib.sha256(catalog_bytes).hexdigest()}
    month = month or datetime.now(JST).strftime("%Y-%m")
    first = last = _month(month)
    if not 1 <= months <= MAX_MONTHS:
        raise ValueError("calendar month count outside bounds")
    for _ in range(months):
        last = _next_month(last)
    coverage = {"from": first.isoformat(), "untilExclusive": last.isoformat()}
    target = output or layout.api / "calendar-lives.json"
    try:
        document = create_snapshot(pin, catalog, month, months, fetch or PublicCalendarFetcher(), detail_url=detail_url, fetched_at=fetched_at)
    except (OSError, ValueError) as error:
        previous = None
        if target.exists() and target.stat().st_size <= MAX_BYTES:
            try:
                previous = read_json(target)
            except (OSError, ValueError):
                pass
        if (isinstance(previous, dict) and previous.get("schema") == SCHEMA and previous.get("pin") == pin
                and previous.get("coverage") == coverage and previous.get("available") is True and isinstance(previous.get("events"), list)):
            document = {**previous, "status": "stale", "attemptedAt": _utc_now(), "lastError": type(error).__name__}
        else:
            document = {"schema": SCHEMA, "pin": pin, "coverage": coverage, "available": False,
                        "status": "unavailable", "fetchedAt": None, "attemptedAt": _utc_now(), "events": [],
                        "source": {"provider": "bandori.fans", "url": f"{SOURCE}/en/calendar", "apiUrl": None}, "lastError": type(error).__name__}
    write_json(target, document)
    return document


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--build", help="raw resource pipeline build ID")
    selection.add_argument("--release", help="frontend's already selected immutable release ID")
    parser.add_argument("--source", required=True)
    parser.add_argument("--month", help="first month YYYY-MM (default current JST month)")
    parser.add_argument("--months", type=int, default=3, choices=range(1, MAX_MONTHS + 1))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--detail-url", help="one selected Live detail URL already present in the window")
    parser.add_argument("--catalog-input", type=Path, help="same-release real-lives wrapper from the frontend's pinned loader")
    parser.add_argument("--detail-limit", type=int, default=MAX_DETAILS, choices=range(MAX_DETAILS + 1))
    parser.add_argument("--cache-root", type=Path)
    parser.add_argument("--asset-root", type=Path, help="generated /images/calendar-lives output directory")
    parser.add_argument("--fixture", type=Path, help="offline fixture manifest mapping exact URLs to local HTML files")
    args = parser.parse_args()
    fetch = None
    fetch_image = None
    captured_at = None
    if args.fixture:
        fixture = read_json(args.fixture)
        captured_at = fixture["fetchedAt"]
        files = fixture["files"]

        def fixture_fetch(url: str) -> str:
            file = (args.fixture.parent / files[url]).resolve()
            if not file.is_relative_to(args.fixture.parent.resolve()) or file.stat().st_size > MAX_BYTES:
                raise ValueError("invalid calendar fixture file")
            return file.read_text("utf-8")

        fetch = fixture_fetch
        if fixture.get("images"):
            def fixture_image(url: str) -> bytes:
                file = (args.fixture.parent / fixture["images"][url]).resolve()
                if not file.is_relative_to(args.fixture.parent.resolve()) or file.stat().st_size > MAX_BYTES:
                    raise ValueError("invalid calendar image fixture")
                return file.read_bytes()
            fetch_image = fixture_image
    if args.release:
        if not args.catalog_input or args.catalog_input.stat().st_size > MAX_BYTES:
            parser.error("--release requires a bounded --catalog-input wrapper")
        wrapper = read_json(args.catalog_input)
        expected = {"server": args.server, "releaseId": args.release, "sourceId": args.source}
        observed = wrapper.get("pin") if isinstance(wrapper, dict) else None
        if (not isinstance(wrapper, dict) or wrapper.get("schema") != "haneoka-calendar-catalog-input-v1"
                or not isinstance(observed, dict) or any(observed.get(key) != value for key, value in expected.items())):
            parser.error("catalog input differs from the frontend's selected server/release/source")
        result = build_selected_calendar_lives(
            args.server, args.release, args.source, wrapper["realLives"], month=args.month, months=args.months,
            detail_limit=args.detail_limit, output=args.output, cache_root=args.cache_root, asset_root=args.asset_root,
            fetch=fetch, fetch_image=fetch_image, fetched_at=captured_at,
        )
    else:
        result = build_calendar_lives(args.server, args.build, args.source, month=args.month, months=args.months,
                                     output=args.output, detail_url=args.detail_url, fetch=fetch, fetched_at=captured_at)
    print(json.dumps({"status": result["status"], "available": result["available"], "events": len(result["events"]),
                      "matched": sum(row["match"]["status"] == "matched" for row in result["events"]),
                      "assets": len(result.get("assets", [])), "coverage": result["coverage"], "pin": result["pin"]}))


if __name__ == "__main__":
    main()
