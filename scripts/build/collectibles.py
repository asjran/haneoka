"""Catalog projections for collectible objects with Master-authored names."""

from __future__ import annotations

import sys
import re
from typing import Any, Callable


def _catalog_image(data: Any, source: str, table: str, identity: int) -> str | None:
    image = data.asset(source)
    if image is None:
        if source in data.source_path_set:
            raise ValueError(f"{table} image was not built: {identity}: {source}")
        # Master snapshots can announce collectibles before their assets are
        # shipped. Preserve the record without inventing a broken image URL.
        print(f"warning: {table} image is not in this resource catalog: {identity}: {source}", file=sys.stderr)
    return image


def build_stickers(data: Any, stamp: Callable[[Any], list[int | None]]) -> dict[str, Any]:
    unlocks: dict[int, list[dict[str, Any]]] = {}
    for table, kind, owner_key, owner_field in (
        ("MasterCharacterRankReward", "characterRank", "_characterId", "characterId"),
        ("MasterCharacterFriendshipRankReward", "friendshipRank", "_characterFriendshipId", "friendshipId"),
    ):
        for reward in data.rows(table):
            if int(reward.get("_resourceType") or 0) != 17:
                continue
            identity = int(reward.get("_resourceId") or 0)
            unlocks.setdefault(identity, []).append({
                "kind": kind,
                owner_field: int(reward.get(owner_key) or 0),
                "rank": int(reward.get("_rank") or 0),
                "count": int(reward.get("_resourceCount") or 0),
                "sourceTable": table,
            })
    entries = {}
    for row in data.rows("MasterDegree"):
        identity = int(row.get("_id") or 0)
        image_path = str(row.get("_imagePath") or "").strip("/")
        if not identity or not image_path:
            continue
        image = _catalog_image(data, f"Assets/AddressableResources/{image_path}.png", "MasterDegree", identity)
        artwork_card = re.fullmatch(r"MemberCard/(\d+)/member_character", image_path)
        entries[str(identity)] = {
            "stickerId": identity,
            "name": data.text(row.get("_nameTextId")),
            "description": data.text(row.get("_descriptionTextId")),
            "image": image,
            "characterIds": [int(value) for value in row.get("_characterIds", []) if int(value)],
            "releasedAt": stamp(row.get("_startAt")),
            "closedAt": stamp(row.get("_endAt")),
            "degreeType": int(row.get("_degreeType") or 0),
            "sourceTable": "MasterDegree",
            "unlocks": unlocks.get(identity, []),
            **({"sourceCardId": int(artwork_card[1])} if artwork_card else {}),
        }
    return {"entries": entries}


def build_backgrounds(data: Any) -> dict[str, Any]:
    entries = {}
    for row in data.rows("MasterBackground"):
        identity = int(row.get("_id") or 0)
        source = str(row.get("_assetPath") or "").strip("/")
        thumbnail_source = str(row.get("_thumbnailAssetPath") or "").strip("/")
        if not identity or not source:
            continue
        image = _catalog_image(data, f"Assets/AddressableResources/{source}.png", "MasterBackground", identity)
        thumbnail = data.asset(f"Assets/AddressableResources/{thumbnail_source}.png") if thumbnail_source else None
        entries[str(identity)] = {
            "backgroundId": identity,
            "name": data.text(row.get("_nameTextId")),
            "description": data.text(row.get("_descriptionTextId")),
            "image": image,
            "thumbnail": thumbnail or image,
            "sourceTable": "MasterBackground",
            "itemType": int(row.get("_itemType") or 0),
        }
    return {"entries": entries}
