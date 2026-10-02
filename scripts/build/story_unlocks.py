"""Resolve MasterStoryEpisode requirements within the current build's story group."""

from __future__ import annotations

from collections import defaultdict
from typing import Any


def _group(row: dict[str, Any]) -> str:
    if row.get("_isAnotherEpisode"):
        return "another"
    return "extra" if row.get("_isExtraEpisode") else "main"


def enrich_story_unlocks(
    data: Any,
    chapters: dict[str, dict[str, Any]],
    episodes: dict[str, dict[str, Any]],
) -> None:
    """Attach requirements to emitted episodes, without scripts or whole Master rows.

    In the formal Intl Master, Another stories name a main episode in their
    own chapter via _unlockEpisodeNumber. Their own numbering starts at 1.
    Other groups retain their group when resolving a numbered prerequisite.
    Ambiguous or absent targets remain explicit, never an arbitrary link.
    """
    story_ids = {
        int(row.get("_id") or 0): str(row.get("_advEpisodeAsset") or "").removeprefix("adv_script_")
        for row in data.rows("MasterAdv")
        if row.get("_advEpisodeAsset")
    }
    native_rows = data.rows("MasterStoryEpisode")
    numbered: dict[tuple[int, str, int], list[dict[str, Any]]] = defaultdict(list)
    for row in native_rows:
        numbered[(int(row.get("_chapterId") or 0), _group(row), int(row.get("_episodeNumber") or 0))].append(row)
    characters = {int(row.get("_id") or 0): row for row in data.rows("MasterCharacter")}
    bands = {int(row.get("_id") or 0): row for row in data.rows("MasterBand")}

    for row in native_rows:
        story_id = story_ids.get(int(row.get("_advId") or 0))
        story = episodes.get(story_id or "")
        if story is None:
            continue
        chapter_id = int(row.get("_chapterId") or 0)
        player_rank = int(row.get("_playerRank") or 0)
        band_rank = int(row.get("_bandRank") or 0)
        character_rank = int(row.get("_characterRank") or 0)
        character_id = int(row.get("_characterId") or 0)
        prerequisite_number = int(row.get("_unlockEpisodeNumber") or 0)
        story.update(
            storyEpisodeId=int(row.get("_id") or 0),
            playerRank=player_rank,
            bandRank=band_rank,
            characterRank=character_rank,
            unlockEpisodeNumber=prerequisite_number,
        )
        story.pop("unlockEpisodeStoryId", None)
        conditions: list[dict[str, Any]] = []
        if player_rank > 0:
            conditions.append({"kind": "playerRank", "rank": player_rank})
        if band_rank > 0:
            band_id = int(chapters.get(str(chapter_id), {}).get("bandId") or 0)
            band = bands.get(band_id)
            condition: dict[str, Any] = {"kind": "bandRank", "rank": band_rank, "bandId": band_id}
            if band:
                condition["band"] = {
                    "bandId": band_id,
                    "name": data.text(band.get("_nameTextID")),
                    "image": data.asset(f"Assets/AddressableResources/Band/{band_id}/band_small_Icon.png"),
                }
            conditions.append(condition)
        if character_rank > 0:
            character = characters.get(character_id)
            condition = {"kind": "characterRank", "rank": character_rank, "characterId": character_id}
            if character:
                condition["reference"] = {
                    "resource": "characters", "id": str(character_id),
                    "name": data.text(character.get("_nameTextID")),
                    "image": data.asset(f"Assets/AddressableResources/Character/Image/{character_id}/character_thumbnail.png"),
                }
            conditions.append(condition)
        if prerequisite_number > 0:
            target_group = "main" if _group(row) == "another" else _group(row)
            matches = numbered.get((chapter_id, target_group, prerequisite_number), [])
            condition = {
                "kind": "episode", "episodeNumber": prerequisite_number,
                "chapterId": chapter_id, "group": target_group,
                "status": "ambiguous" if len(matches) > 1 else "missing",
            }
            if len(matches) == 1:
                target_id = story_ids.get(int(matches[0].get("_advId") or 0))
                target = episodes.get(target_id or "")
                if target and target_id != story_id:
                    condition.update(status="resolved", reference={
                        "resource": "stories", "id": target_id,
                        "name": target.get("title"),
                        "image": target.get("banner") or target.get("image"),
                        "chapterId": chapter_id, "episodeNumber": prerequisite_number,
                    })
                    story["unlockEpisodeStoryId"] = target_id
            story["unlockEpisodeStatus"] = condition["status"]
            conditions.append(condition)
        else:
            story["unlockEpisodeStatus"] = "none"
        story["unlockConditions"] = conditions
