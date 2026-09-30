"""Build browser-ready Cubism files from canonical Unity object archives.

Every input is resolved through ``AssetBundle.m_Container`` metadata.  The
builder never infers a Unity source path from a downloaded bundle filename.
"""

from __future__ import annotations

import copy
import math
import re
import shutil
from pathlib import Path, PurePosixPath
from typing import Any

from core.config import ServerConfig
from core.hashes import sha256_bytes, sha256_file
from core.manifests import atomic_write, read_json, stable_json, write_json
from core.paths import PROJECT_ROOT, build_layout
from core.process import walk_files
from core.unity_objects import UnityObjectStore
from build.live2d_preview import PREVIEW_SCHEMA, build_live2d_previews
from build.live2d_textures import (
    TextureOutputReference,
    TextureVariantIssue,
    encoder_profile,
    extract_live2d_astc,
    find_ktx_executable,
    ktx_tool_version,
    load_live2d_bundle_records,
    ktx2_variant_metadata,
    texture_variant_cache_key,
    write_ktx2_astc,
    write_ktx2_bc7,
)


LIVE2D_ROOT = re.compile(
    r"^(Assets/AddressableResources/Character/Live2D/"
    r"(?:([0-9]{3})_(adv|live)|sub_([^/]+))/([^/]+))/",
    re.IGNORECASE,
)
DEFAULT_TANGENT_WEIGHT = 1 / 3


def _number(value: Any, fallback: float = 0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _slope(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return 0 if math.isnan(number) else number


def _weight(value: Any) -> float:
    return max(0, min(1, _number(value, DEFAULT_TANGENT_WEIGHT)))


def motion3_from_fade_asset(data: dict[str, Any]) -> dict[str, Any]:
    """Convert serialized Unity AnimationCurves to Cubism motion3 curves."""

    ids = data.get("ParameterIds") if isinstance(data.get("ParameterIds"), list) else []
    source_curves = (
        data.get("ParameterCurves")
        if isinstance(data.get("ParameterCurves"), list)
        else []
    )
    fade_in = (
        data.get("ParameterFadeInTimes")
        if isinstance(data.get("ParameterFadeInTimes"), list)
        else []
    )
    fade_out = (
        data.get("ParameterFadeOutTimes")
        if isinstance(data.get("ParameterFadeOutTimes"), list)
        else []
    )
    curves: list[dict[str, Any]] = []
    key_duration = 0.0
    total_segments = 0
    total_points = 0
    restricted = True

    for index, raw_id in enumerate(ids):
        parameter_id = str(raw_id or "")
        raw_points = (
            source_curves[index].get("m_Curve", [])
            if index < len(source_curves)
            else []
        )
        points = sorted(
            (
                {
                    "time": _number(point.get("time")),
                    "value": _number(point.get("value")),
                    "inSlope": _slope(point.get("inSlope")),
                    "outSlope": _slope(point.get("outSlope")),
                    "weightedMode": int(_number(point.get("weightedMode"))),
                    "inWeight": _weight(point.get("inWeight")),
                    "outWeight": _weight(point.get("outWeight")),
                }
                for point in raw_points
                if isinstance(point, dict)
            ),
            key=lambda point: point["time"],
        )
        if not parameter_id or not points:
            continue

        segments: list[float | int] = [points[0]["time"], points[0]["value"]]
        curve_points = 1
        for left, right in zip(points, points[1:]):
            duration = right["time"] - left["time"]
            if not math.isfinite(left["outSlope"]) or not math.isfinite(
                right["inSlope"]
            ):
                segments.extend((2, right["time"], right["value"]))
                curve_points += 1
                continue
            linear_slope = (
                (right["value"] - left["value"]) / duration if duration > 0 else 0
            )
            if left["outSlope"] == linear_slope and right["inSlope"] == linear_slope:
                segments.extend((0, right["time"], right["value"]))
                curve_points += 1
                continue
            out_weight = (
                left["outWeight"]
                if left["weightedMode"] & 2
                else DEFAULT_TANGENT_WEIGHT
            )
            in_weight = (
                right["inWeight"]
                if right["weightedMode"] & 1
                else DEFAULT_TANGENT_WEIGHT
            )
            segments.extend(
                (
                    1,
                    left["time"] + duration * out_weight,
                    left["value"] + left["outSlope"] * duration * out_weight,
                    right["time"] - duration * in_weight,
                    right["value"] - right["inSlope"] * duration * in_weight,
                    right["time"],
                    right["value"],
                )
            )
            curve_points += 3
            if (
                out_weight != DEFAULT_TANGENT_WEIGHT
                or in_weight != DEFAULT_TANGENT_WEIGHT
            ):
                restricted = False

        key_duration = max(key_duration, points[-1]["time"])
        total_segments += max(0, len(points) - 1)
        total_points += curve_points
        curve: dict[str, Any] = {
            "Target": "Parameter",
            "Id": parameter_id,
            "Segments": segments,
        }
        parameter_fade_in = _number(fade_in[index], -1) if index < len(fade_in) else -1
        parameter_fade_out = (
            _number(fade_out[index], -1) if index < len(fade_out) else -1
        )
        if parameter_fade_in >= 0:
            curve["FadeInTime"] = parameter_fade_in
        if parameter_fade_out >= 0:
            curve["FadeOutTime"] = parameter_fade_out
        curves.append(curve)

    raw_duration = data.get("MotionLength")
    duration = _number(raw_duration, key_duration)
    if duration < 0:
        duration = key_duration
    return {
        "Version": 3,
        "Meta": {
            "Duration": duration,
            "Fps": 30,
            "Loop": False,
            "AreBeziersRestricted": restricted,
            "CurveCount": len(curves),
            "TotalSegmentCount": total_segments,
            "TotalPointCount": total_points,
            "UserDataCount": 0,
            "TotalUserDataSize": 0,
        },
        "Curves": curves,
    }


def exp3_from_expression_asset(data: dict[str, Any]) -> dict[str, Any]:
    blends = ("Overwrite", "Add", "Multiply")
    parameters = []
    for value in data.get("Parameters", []):
        if not isinstance(value, dict) or not value.get("Id"):
            continue
        raw_blend = value.get("Blend", 1)
        try:
            blend_index = int(raw_blend)
        except (TypeError, ValueError):
            blend_index = -1
        blend = (
            blends[blend_index]
            if 0 <= blend_index < len(blends)
            else str(raw_blend or "Add")
        )
        parameters.append(
            {
                "Id": str(value["Id"]),
                "Value": _number(value.get("Value")),
                "Blend": blend,
            }
        )
    return {
        "Type": "Live2D Expression",
        "FadeInTime": _number(data.get("FadeInTime"), 1),
        "FadeOutTime": _number(data.get("FadeOutTime"), 1),
        "Parameters": parameters,
    }


def _vector2(value: Any, fallback: dict[str, float] | None = None) -> dict[str, float]:
    value = value if isinstance(value, dict) else (fallback or {})
    return {"X": _number(value.get("x")), "Y": _number(value.get("y"))}


def _normalization(value: Any) -> dict[str, float]:
    value = value if isinstance(value, dict) else {}
    return {
        "Minimum": _number(value.get("Minimum")),
        "Default": _number(value.get("Default")),
        "Maximum": _number(value.get("Maximum")),
    }


def physics3_from_rig(rig: dict[str, Any]) -> dict[str, Any] | None:
    sub_rigs = rig.get("SubRigs") if isinstance(rig.get("SubRigs"), list) else []
    if not sub_rigs:
        return None
    component_names = ("X", "Y", "Angle")
    settings = []
    input_count = output_count = vertex_count = 0
    for index, sub_rig in enumerate(sub_rigs):
        setting_id = f"PhysicsSetting{index + 1}"
        inputs = []
        for value in sub_rig.get("Input", []):
            source_id = str(value.get("SourceId") or "")
            if not source_id:
                continue
            component = int(_number(value.get("SourceComponent"), 2))
            inputs.append(
                {
                    "Source": {"Target": "Parameter", "Id": source_id},
                    "Weight": _number(value.get("Weight")),
                    "Type": component_names[component]
                    if 0 <= component < 3
                    else "Angle",
                    "Reflect": bool(value.get("IsInverted")),
                }
            )
        outputs = []
        for value in sub_rig.get("Output", []):
            destination = str(value.get("DestinationId") or "")
            if not destination:
                continue
            component = int(_number(value.get("SourceComponent"), 2))
            component_name = (
                component_names[component] if 0 <= component < 3 else "Angle"
            )
            translation = (
                value.get("TranslationScale")
                if isinstance(value.get("TranslationScale"), dict)
                else {}
            )
            scale = (
                value.get("AngleScale")
                if component_name == "Angle"
                else translation.get(component_name.lower())
            )
            outputs.append(
                {
                    "Destination": {"Target": "Parameter", "Id": destination},
                    "VertexIndex": max(0, int(_number(value.get("ParticleIndex")))),
                    "Scale": _number(scale),
                    "Weight": _number(value.get("Weight")),
                    "Type": component_name,
                    "Reflect": bool(value.get("IsInverted")),
                }
            )
        vertices = [
            {
                "Position": _vector2(value.get("InitialPosition")),
                "Mobility": _number(value.get("Mobility")),
                "Delay": _number(value.get("Delay")),
                "Acceleration": _number(value.get("Acceleration")),
                "Radius": _number(value.get("Radius")),
            }
            for value in sub_rig.get("Particles", [])
            if isinstance(value, dict)
        ]
        input_count += len(inputs)
        output_count += len(outputs)
        vertex_count += len(vertices)
        normalization = (
            sub_rig.get("Normalization")
            if isinstance(sub_rig.get("Normalization"), dict)
            else {}
        )
        settings.append(
            {
                "Id": setting_id,
                "Input": inputs,
                "Output": outputs,
                "Vertices": vertices,
                "Normalization": {
                    "Position": _normalization(normalization.get("Position")),
                    "Angle": _normalization(normalization.get("Angle")),
                },
            }
        )
    return {
        "Version": 3,
        "Meta": {
            "PhysicsSettingCount": len(settings),
            "TotalInputCount": input_count,
            "TotalOutputCount": output_count,
            "TotalVertexCount": vertex_count,
            "VertexCount": vertex_count,
            "EffectiveForces": {
                "Gravity": _vector2(rig.get("Gravity"), {"x": 0, "y": -1}),
                "Wind": _vector2(rig.get("Wind"), {"x": 0, "y": 0}),
            },
            "Fps": _number(rig.get("Fps"), 60),
            "PhysicsDictionary": [
                {
                    "Id": setting["Id"],
                    "Name": str(sub_rigs[index].get("Name") or setting["Id"]),
                }
                for index, setting in enumerate(settings)
            ],
        },
        "PhysicsSettings": settings,
    }


def _reference_id(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    try:
        file_id = int(value.get("m_FileID") or value.get("file_id") or 0)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Live2D pointer has an invalid file ID: {value!r}") from error
    if file_id:
        raise ValueError(
            "Live2D local object graph contains an unsupported external pointer: "
            f"{file_id}:{value.get('m_PathID') or value.get('path_id') or 0}"
        )
    raw = value.get("m_PathID") or value.get("path_id") or ""
    return str(raw) if raw else ""


def _model_identity(
    match: re.Match[str],
) -> tuple[str, str, str, str, int | None, bool]:
    _, character, raw_mode, sub_character, directory = match.groups()
    model_name = directory
    if character:
        costume = re.sub(
            r"^(?:adv_)?live2d_[a-z0-9]+_[0-9]{3}_", "", model_name, flags=re.IGNORECASE
        )
        # Production catalogs carry both ADV and LIVE prefabs for the same
        # character/costume. Keep historical ADV keys and namespace LIVE keys.
        key = (
            f"{character}_{costume}"
            if raw_mode != "live"
            else f"{character}_live-mode_{costume}"
        )
        return key, costume, raw_mode or "adv", character, int(character), False
    costume = re.sub(
        rf"^adv_live2d_sub_{re.escape(sub_character or '')}_",
        "",
        model_name,
        flags=re.IGNORECASE,
    )
    character_key = f"sub_{sub_character}"
    return (
        f"{character_key}_{costume}",
        costume or directory,
        "adv",
        character_key,
        None,
        True,
    )


def _profile(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    for record in records.values():
        data = record.get("data")
        if not isinstance(data, dict) or (
            "BasePosition" not in data and "BaseScale" not in data
        ):
            continue
        position = (
            data.get("BasePosition")
            if isinstance(data.get("BasePosition"), dict)
            else {}
        )
        return {
            "basePosition": {
                axis: _number(position.get(axis)) for axis in ("x", "y", "z")
            },
            "baseScale": _number(data.get("BaseScale"), 1),
            "defaultMotionName": str(data.get("DefaultMotionName") or ""),
            "defaultExpressionName": str(data.get("DefaultExpressionName") or ""),
            "anchors": _anchors(records),
        }
    return {"basePosition": {"x": 0, "y": 0, "z": 0}, "baseScale": 1, "anchors": {}}


def _anchors(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    transforms = {
        object_id: value
        for object_id, value in records.items()
        if value.get("type") == "Transform"
    }
    result = {}
    for key, game_object_name in (("head", "Head"), ("stomach", "Stomach")):
        game_object = next(
            (
                value.get("data", {})
                for value in records.values()
                if value.get("type") == "GameObject"
                and value.get("data", {}).get("m_Name") == game_object_name
            ),
            None,
        )
        if not game_object:
            continue
        components = game_object.get("m_Component") or []
        transform_id = (
            _reference_id(components[0].get("component")) if components else ""
        )
        chain: list[dict[str, Any]] = []
        seen = set()
        while transform_id and transform_id not in seen and transform_id in transforms:
            seen.add(transform_id)
            data = transforms[transform_id].get("data", {})
            chain.append(data)
            transform_id = _reference_id(data.get("m_Father"))
        position = {"x": 0.0, "y": 0.0, "z": 0.0}
        scale = {"x": 1.0, "y": 1.0, "z": 1.0}
        for data in reversed(chain):
            local_position = (
                data.get("m_LocalPosition")
                if isinstance(data.get("m_LocalPosition"), dict)
                else {}
            )
            local_scale = (
                data.get("m_LocalScale")
                if isinstance(data.get("m_LocalScale"), dict)
                else {}
            )
            for axis in position:
                position[axis] += scale[axis] * _number(local_position.get(axis))
                scale[axis] *= _number(local_scale.get(axis), 1) or 1
        if chain:
            result[key] = {"position": position, "scale": scale}
    return result


def _harmonic_motion(records: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    controller = None
    parameters = []
    for record in records.values():
        if record.get("type") != "MonoBehaviour":
            continue
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        if isinstance(data.get("ChannelTimescales"), list):
            controller = {
                "blendMode": int(_number(data.get("BlendMode"))),
                "channelTimescales": [
                    _number(value, 1) for value in data["ChannelTimescales"]
                ]
                or [1],
            }
            continue
        if not all(
            key in data for key in ("NormalizedOrigin", "NormalizedRange", "Duration")
        ):
            continue
        game_object = records.get(_reference_id(data.get("m_GameObject")), {}).get(
            "data", {}
        )
        parameter_id = str(game_object.get("m_Name") or "")
        duration = _number(data.get("Duration"))
        if parameter_id and duration > 0:
            parameters.append(
                {
                    "id": parameter_id,
                    "channel": int(_number(data.get("Channel"))),
                    "direction": int(_number(data.get("Direction"), 2)),
                    "normalizedOrigin": _number(data.get("NormalizedOrigin"), 0.5),
                    "normalizedRange": _number(data.get("NormalizedRange"), 0.5),
                    "duration": duration,
                }
            )
    if not controller and not parameters:
        return None
    return {
        "blendMode": controller["blendMode"] if controller else 0,
        "channelTimescales": controller["channelTimescales"] if controller else [1],
        "parameters": sorted(
            parameters, key=lambda value: (value["channel"], value["id"])
        ),
    }


def _motion_sync(records: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    parameter_ids: dict[str, str] = {}
    for object_id, record in records.items():
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        name = str(data.get("m_Name") or "")
        if record.get("type") != "GameObject" or not name.startswith("Param"):
            continue
        parameter_ids[object_id] = name
        for component in data.get("m_Component", []):
            reference = _reference_id(component.get("component"))
            if reference:
                parameter_ids[reference] = name
    for record in records.values():
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        source = data.get("_motionSyncData")
        if not isinstance(source, dict) or not isinstance(source.get("Settings"), list):
            continue
        settings = []
        for setting in source["Settings"]:
            parameters = [
                {
                    "id": parameter_ids.get(_reference_id(value.get("Parameter")), ""),
                    "min": _number(value.get("Min")),
                    "max": _number(value.get("Max")),
                    "damper": _number(value.get("Damper")),
                    "smooth": int(_number(value.get("Smooth"))),
                }
                for value in setting.get("CubismParameters", [])
            ]
            parameters = [value for value in parameters if value["id"]]
            audio_parameters = [
                {
                    "id": str(value.get("Id") or ""),
                    "name": str(value.get("Name") or value.get("Id") or ""),
                    "min": _number(value.get("Min")),
                    "max": _number(value.get("Max"), 1),
                    "scale": _number(value.get("Scale"), 1),
                    "enabled": bool(value.get("Enabled")),
                }
                for value in setting.get("AudioParameters", [])
                if value.get("Id")
            ]
            mappings = []
            for mapping in setting.get("Mappings", []):
                targets = [
                    {
                        "id": parameter_ids.get(
                            _reference_id(target.get("Parameter")), ""
                        ),
                        "value": _number(target.get("Value")),
                    }
                    for target in mapping.get("Targets", [])
                ]
                targets = [target for target in targets if target["id"]]
                audio_id = str(mapping.get("AudioParameterId") or "")
                if audio_id and targets:
                    mappings.append(
                        {
                            "type": int(_number(mapping.get("Type"))),
                            "audioParameterId": audio_id,
                            "targets": targets,
                        }
                    )
            if parameters and audio_parameters and mappings:
                post = (
                    setting.get("PostProcessing")
                    if isinstance(setting.get("PostProcessing"), dict)
                    else {}
                )
                settings.append(
                    {
                        "id": str(setting.get("Id") or ""),
                        "parameters": parameters,
                        "audioParameters": audio_parameters,
                        "mappings": mappings,
                        "postProcessing": {
                            "blendRatio": _number(post.get("BlendRatio"), 1),
                            "smoothing": int(_number(post.get("Smoothing"), 100)),
                            "sampleRate": _number(post.get("SampleRate"), 30),
                        },
                        "emphasisLevel": _number(setting.get("EmphasisLevel")),
                    }
                )
        return {"settings": settings} if settings else None
    return None


def _moc_payload(
    store: UnityObjectStore, paths: list[str], model_root: str
) -> tuple[bytes, str]:
    prefix = f"{model_root}/model/generated/"
    for source_path in paths:
        if (
            not source_path.startswith(prefix)
            or not source_path.endswith(".asset")
            or "masktexture" in source_path.casefold()
        ):
            continue
        data = store.source_data(source_path) or {}
        raw = data.get("_bytes")
        if isinstance(raw, list):
            payload = bytes(int(value) & 255 for value in raw)
            if payload.startswith(b"MOC3"):
                return payload, source_path
    raise ValueError(f"Live2D MOC3 source is missing: {model_root}")


def _runtime_url(server: str, key: str, relative: str) -> str:
    return f"/runtime/{server}/live2d/{key}/{relative}"


def _local_resource_path(layout: Any, server: str, url: str) -> Path | None:
    """Map one canonical build URL to its local file without URL-key lookups."""

    asset_prefix = f"/assets/{server}/"
    runtime_prefix = f"/runtime/{server}/"
    if url.startswith(asset_prefix):
        relative = url.removeprefix(asset_prefix)
        return layout.root / "assets" / Path(*PurePosixPath(relative).parts)
    if url.startswith(runtime_prefix):
        relative = url.removeprefix(runtime_prefix)
        return layout.root / "runtime" / Path(*PurePosixPath(relative).parts)
    return None


def _texture_output(
    store: UnityObjectStore, source_path: str, expected_path: str
) -> dict[str, Any] | None:
    """Select the canonical Texture2D output for a model texture source."""

    descriptor = store.descriptor(source_path)
    if not isinstance(descriptor, dict):
        return None
    raw_outputs = descriptor.get("outputs")
    if not isinstance(raw_outputs, list):
        return None
    outputs = [
        output
        for output in raw_outputs
        if isinstance(output, dict) and output.get("type") == "Texture2D"
    ]
    exact = [output for output in outputs if output.get("path") == expected_path]
    return exact[0] if exact else None


def _previous_texture_variants(
    reuse_manifest: dict[str, Any] | None,
    key: str,
) -> dict[tuple[int, str], dict[str, Any]]:
    """Index reusable variants from the existing Live2D stage document."""

    if not isinstance(reuse_manifest, dict):
        return {}
    models = reuse_manifest.get("models")
    previous = models.get(key) if isinstance(models, dict) else None
    runtime = previous.get("runtime") if isinstance(previous, dict) else None
    variants = runtime.get("textureVariants") if isinstance(runtime, dict) else None
    if not isinstance(variants, list):
        return {}
    result: dict[tuple[int, str], dict[str, Any]] = {}
    for variant in variants:
        if not isinstance(variant, dict):
            continue
        index = variant.get("textureIndex")
        format_name = variant.get("format")
        if (
            isinstance(index, int)
            and not isinstance(index, bool)
            and isinstance(format_name, str)
        ):
            result.setdefault((index, format_name), variant)
    return result


def _variant_matches_encoder_profile(
    variant: dict[str, Any],
    format_name: str,
    tool_version: str,
) -> bool:
    """Check the producer identity and cache key of one reusable variant."""

    if variant.get("format") != format_name:
        return False
    if variant.get("encoderProfile") != encoder_profile(format_name, tool_version):
        return False
    source_hash = variant.get("sourceTextureSha256")
    width = variant.get("width")
    height = variant.get("height")
    if (
        not isinstance(source_hash, str)
        or not isinstance(width, int)
        or isinstance(width, bool)
    ):
        return False
    if (
        not isinstance(height, int)
        or isinstance(height, bool)
        or width <= 0
        or height <= 0
    ):
        return False
    payload_hash = variant.get("sourcePayloadSha256")
    if format_name == "astc6x6" and not isinstance(payload_hash, str):
        return False
    expected_cache_key = texture_variant_cache_key(
        format_name,
        source_hash,
        width,
        height,
        tool_version,
        source_payload_sha256=payload_hash if format_name == "astc6x6" else None,
    )
    return variant.get("cacheKey") == expected_cache_key


def _restore_variant_path(value: Any, server: str) -> str:
    prefix = f"/runtime/{server}/"
    if not isinstance(value, str) or not value.startswith(prefix):
        return ""
    return "runtime/" + value.removeprefix(prefix)


def _texture_identity_paths(server: str, model: dict[str, Any]) -> list[str]:
    """Recover the on-disk identity of every texture the preview page loads."""

    runtime = model.get("runtime") if isinstance(model.get("runtime"), dict) else {}
    paths: list[str] = []
    for value in runtime.get("textures") or []:
        url = str(value or "")
        if url.startswith(f"/assets/{server}/"):
            # Unity source paths index into the bundle identities directly.
            paths.append(url[len(f"/assets/{server}/") :])
        elif url.startswith(f"/runtime/{server}/"):
            # Packed-model texture outputs live under the release runtime tree;
            # the URL strips the leading "runtime/" segment.
            paths.append("runtime/" + url[len(f"/runtime/{server}/") :])
    return paths


def _preview_input_identity(
    sources_index: dict[str, Any],
    layout: Any,
    server: str,
    model: dict[str, Any],
    provision_sha256: str,
) -> str:
    """Fingerprint every input a preview render of this model depends on.

    Indexed source paths are identified by their owning bundle's content hash
    (and the extraction descriptor's hash), so an unchanged model in a new
    source is recognized without reading any media bytes. Non-indexed files
    (packed-model texture outputs) are hashed directly; they are few and small.
    """

    paths: set[str] = set()

    def add(value: Any) -> None:
        if isinstance(value, str) and value:
            paths.add(value)

    add(model.get("sourcePath"))
    add(model.get("mocSourcePath"))
    for motion in model.get("motions") or []:
        add(motion.get("sourcePath") if isinstance(motion, dict) else None)
    for expression in model.get("expressions") or []:
        add(expression.get("sourcePath") if isinstance(expression, dict) else None)
    paths.update(_texture_identity_paths(server, model))

    inputs: list[list[str]] = []
    for path in sorted(paths):
        entry = sources_index.get(path)
        if isinstance(entry, dict):
            descriptor = str(entry.get("descriptor") or "")
            descriptor_file = layout.metadata / descriptor if descriptor else None
            descriptor_sha = (
                sha256_file(descriptor_file)
                if descriptor_file is not None and descriptor_file.is_file()
                else ""
            )
            inputs.append(
                [path, str(entry.get("selectedBundle") or ""), descriptor_sha]
            )
            continue
        file = layout.root.joinpath(*PurePosixPath(path).parts)
        inputs.append([path, "file", sha256_file(file) if file.is_file() else ""])
    return sha256_bytes(
        stable_json(
            {
                "schema": PREVIEW_SCHEMA,
                "provisionSha256": provision_sha256,
                "inputs": inputs,
            }
        )
    )


def _packed_moc_payload(records: dict[str, dict[str, Any]]) -> bytes:
    candidates = []
    for record in records.values():
        data = record.get("data")
        raw = data.get("_bytes") if isinstance(data, dict) else None
        if not isinstance(raw, list) or len(raw) < 4 or raw[:4] != [77, 79, 67, 51]:
            continue
        candidates.append(bytes(int(value) & 255 for value in raw))
    if len(candidates) != 1:
        raise ValueError(f"packed Live2D bundle has {len(candidates)} MOC3 payloads")
    return candidates[0]


def build_live2d(
    config: ServerConfig,
    source_id: str,
    build_id: str,
    *,
    include_bc7: bool = False,
    reuse_manifest: dict[str, Any] | None = None,
    restore_output: Any = None,
    reuse_concurrency: int = 32,
    delta: Any = None,
    base_document: dict[str, Any] | None = None,
) -> dict[str, Any]:
    layout = build_layout(config.id, build_id)
    index = read_json(layout.metadata / "source-index.json")
    paths = sorted(index.get("sources", {}))
    store = UnityObjectStore(
        layout,
        index,
        ensure_archive=(
            (lambda digest, archive: delta.fetch_archive(digest, archive))
            if delta is not None
            else None
        ),
    )
    models: dict[str, dict[str, Any]] = {}
    skipped_models: list[dict[str, Any]] = []
    native_texture_variant_issues: list[dict[str, Any]] = []
    native_texture_variant_count = 0
    native_texture_variant_bytes = 0
    native_texture_variant_reused = 0
    seen_keys: set[str] = set()
    shutil.rmtree(layout.runtime / "live2d", ignore_errors=True)

    # source.json is a large manifest.  Resolve its Unity-bundle digest index
    # once for the complete stage instead of reparsing and rebuilding it for
    # every model's optional texture extraction.
    texture_source_load_error: str | None = None
    try:
        texture_source_root, texture_bundle_records = load_live2d_bundle_records(
            config.id, source_id
        )
    except Exception as error:
        texture_source_root, texture_bundle_records = None, {}
        texture_source_load_error = type(error).__name__
    ktx_executable = find_ktx_executable()
    if ktx_executable:
        try:
            ktx_version = ktx_tool_version(ktx_executable)
        except Exception:
            ktx_version = "unknown"
    else:
        ktx_version = "unavailable"
    # Native ASTC packaging is the default producer path.  It remains
    # optional at runtime because a clean build may not have the official KTX
    # executable or a readable source manifest; canonical PNGs then remain
    # the complete fallback.  BC7 is opt-in because it is a lossy desktop
    # derivative of those PNGs.
    native_texture_packaging = bool(ktx_executable and texture_source_root is not None)
    if include_bc7 and not ktx_executable:
        raise RuntimeError(
            "Live2D BC7 packaging was requested, but the official KTX executable is unavailable; "
            "omit --live2d-bc7 to use the canonical PNG/ASTC fallback"
        )
    if include_bc7 and texture_source_root is None:
        raise RuntimeError(
            "Live2D BC7 packaging was requested, but the source manifest is unavailable; "
            "omit --live2d-bc7 to use the canonical PNG/ASTC fallback"
        )
    if include_bc7 and ktx_version == "unknown":
        raise RuntimeError(
            "Live2D BC7 packaging was requested, but the KTX encoder version could not be established"
        )

    roots: dict[str, re.Match[str]] = {}
    for path in paths:
        if match := LIVE2D_ROOT.match(path):
            roots.setdefault(match.group(1), match)

    base_models: dict[str, dict[str, Any]] = {}
    if delta is not None and isinstance(base_document, dict):
        candidates = base_document.get("models")
        if isinstance(candidates, dict):
            base_models = candidates
    adopted_model_keys: set[str] = set()
    local_asset_relatives: set[str] | None = None
    if delta is not None:
        local_asset_relatives = (
            {
                file.relative_to(layout.assets).as_posix()
                for file in walk_files(layout.assets)
            }
            if layout.assets.is_dir()
            else set()
        )

    def adoptable(model_root: str, key: str) -> dict[str, Any] | None:
        """Adopt one model wholesale from the base release document.

        A model document is a deterministic function of its sources' content.
        Adoption is safe when the base release carries the same model and
        nothing under the model root changed: every indexed source's selected
        bundle is reusable and no local media file exists under the root (a
        local file can only come from a changed or new bundle).
        """

        base = base_models.get(key)
        if not isinstance(base, dict):
            return None
        runtime = base.get("runtime") if isinstance(base.get("runtime"), dict) else {}
        raw_variants = runtime.get("textureVariants")
        variants = (
            [value for value in raw_variants if isinstance(value, dict)]
            if isinstance(raw_variants, list)
            else []
        )
        if include_bc7:
            if not native_texture_packaging:
                return None
            for format_name in ("astc6x6", "bc7"):
                matching = [
                    value for value in variants if value.get("format") == format_name
                ]
                if not matching or any(
                    not _variant_matches_encoder_profile(
                        value, format_name, ktx_version
                    )
                    for value in matching
                ):
                    return None
        elif native_texture_packaging:
            astc_variants = [
                value for value in variants if value.get("format") == "astc6x6"
            ]
            if not astc_variants or any(
                not _variant_matches_encoder_profile(value, "astc6x6", ktx_version)
                for value in astc_variants
            ):
                return None
        covered = False
        for value in paths:
            if not value.startswith(f"{model_root}/"):
                continue
            entry = (index.get("sources") or {}).get(value)
            if not isinstance(entry, dict):
                continue
            covered = True
            try:
                descriptor = read_json(layout.metadata / str(entry["descriptor"]))
            except (OSError, ValueError):
                return None
            digest = str(descriptor.get("selectedBundle") or "")
            if not digest or not delta.reusable(digest):
                return None
        if (
            covered
            and local_asset_relatives is not None
            and not any(
                relative.startswith(f"{model_root}/")
                for relative in local_asset_relatives
            )
        ):
            adopted = copy.deepcopy(base)
            if not include_bc7:
                adopted_runtime = (
                    adopted.get("runtime")
                    if isinstance(adopted.get("runtime"), dict)
                    else None
                )
                if adopted_runtime is not None:
                    adopted_variants = adopted_runtime.get("textureVariants")
                    if isinstance(adopted_variants, list):
                        adopted_runtime["textureVariants"] = [
                            value
                            for value in adopted_variants
                            if not isinstance(value, dict)
                            or value.get("format") != "bc7"
                        ]
            return adopted
        return None

    for model_root, match in sorted(roots.items()):
        key, live2d_name, raw_mode, character_key, character_id, sub_character = (
            _model_identity(match)
        )
        if key in seen_keys:
            raise ValueError(f"duplicate Live2D key: {key}")
        seen_keys.add(key)
        if delta is not None:
            adopted_model = adoptable(model_root, key)
            if adopted_model is not None:
                adopted_model_keys.add(key)
                models[key] = adopted_model
                continue
        model_name = PurePosixPath(model_root).name
        source_path = f"{model_root}/model/{model_name}.prefab"
        descriptor = (
            store.descriptor(source_path)
            if source_path in index.get("sources", {})
            else None
        )
        records = None

        missing = []
        if descriptor is None:
            missing.append("prefab")
        try:
            moc, moc_source = _moc_payload(store, paths, model_root)
        except ValueError:
            if descriptor is None:
                moc = b""
                moc_source = ""
                missing.append("moc3")
            else:
                records = store.records(
                    descriptor["selectedBundle"], descriptor["serializedFile"]
                )
                try:
                    moc = _packed_moc_payload(records)
                    moc_source = source_path
                except ValueError:
                    moc = b""
                    moc_source = ""
                    missing.append("moc3")
        texture_prefix = f"{model_root}/model/"
        selected_packed_outputs = sorted(
            (
                output
                for output in (descriptor or {}).get("outputs", [])
                if isinstance(output, dict)
                and output.get("type") == "Texture2D"
                and str(output.get("path") or "").endswith(".png")
                and str(output.get("path") or "").startswith("runtime/unity/")
            ),
            key=lambda output: str(output["path"]),
        )
        if delta is not None:
            # Textures of reusable bundles are not materialized locally in a
            # delta build; restore the canonical PNGs this model references.
            for value in paths:
                if not (
                    value.startswith(texture_prefix)
                    and f"/{model_name}.2048/" in value
                    and value.casefold().endswith(".png")
                ):
                    continue
                asset_file = layout.assets / Path(*PurePosixPath(value).parts)
                if asset_file.is_file():
                    continue
                source_entry = (index.get("sources") or {}).get(value)
                if not isinstance(source_entry, dict):
                    continue
                try:
                    source_descriptor = read_json(
                        layout.metadata / str(source_entry["descriptor"])
                    )
                except (OSError, ValueError):
                    continue
                digest = str(source_descriptor.get("selectedBundle") or "")
                if not digest or not delta.reusable(digest):
                    continue
                if delta.entry(f"assets/{value}") is not None:
                    delta.fetch_release_path(f"assets/{value}", asset_file)
            # Packed Texture2D outputs are selected by the prefab descriptor,
            # so restore those exact PNGs before the packed presence check or
            # the optional native-source extraction below.
            for output in selected_packed_outputs:
                output_path = str(output["path"])
                output_file = layout.root.joinpath(*PurePosixPath(output_path).parts)
                if output_file.is_file():
                    continue
                if delta.entry(output_path) is not None:
                    delta.fetch_release_path(output_path, output_file)
        texture_paths = [
            value
            for value in paths
            if value.startswith(texture_prefix)
            and f"/{model_name}.2048/" in value
            and value.casefold().endswith(".png")
            and (layout.assets / Path(*PurePosixPath(value).parts)).is_file()
        ]
        textures = [f"/assets/{config.id}/{value}" for value in texture_paths]
        texture_outputs: list[dict[str, Any] | None] = [
            _texture_output(store, value, f"assets/{value}") for value in texture_paths
        ]
        if not textures and descriptor is not None:
            if all(
                (layout.root / str(output["path"])).is_file()
                for output in selected_packed_outputs
            ):
                textures = [
                    f"/runtime/{config.id}/{str(output['path']).removeprefix('runtime/')}"
                    for output in selected_packed_outputs
                ]
                texture_outputs = list(selected_packed_outputs)
        if not textures:
            missing.append("textures")
        if missing:
            skipped_models.append(
                {
                    "live2dKey": key,
                    "modelRoot": model_root,
                    "expectedPrefabPath": source_path,
                    "reason": "incomplete-source",
                    "missing": missing,
                    **({"sourcePath": source_path} if "prefab" not in missing else {}),
                }
            )
            continue

        if records is None:
            records = store.records(
                descriptor["selectedBundle"], descriptor["serializedFile"]
            )
        runtime_dir = layout.runtime / "live2d" / key

        texture_references = [
            TextureOutputReference(
                index,
                texture,
                _local_resource_path(layout, config.id, texture) or Path(""),
                output or {},
            )
            for index, (texture, output) in enumerate(
                zip(textures, texture_outputs, strict=False)
            )
        ]
        texture_variants: list[dict[str, Any]] = []
        texture_variant_issues: list[TextureVariantIssue] = []
        if len(texture_outputs) != len(textures):
            for index in range(len(texture_outputs), len(textures)):
                texture_variant_issues.append(
                    TextureVariantIssue(
                        index,
                        textures[index],
                        "selected-output-missing",
                        "canonical texture has no selected Texture2D output descriptor",
                    )
                )
        if texture_references and ktx_executable and texture_source_root is not None:
            previous_variants = _previous_texture_variants(reuse_manifest, key)

            def package_texture(extracted: Any) -> None:
                nonlocal native_texture_variant_reused
                source_texture_sha256 = extracted.source_texture_sha256
                writers = [("astc6x6", write_ktx2_astc)]
                if include_bc7:
                    writers.append(("bc7", write_ktx2_bc7))
                for format_name, writer in writers:
                    try:
                        relative = f"textures/texture_{extracted.texture_index:02d}.{format_name}.ktx2"
                        output = runtime_dir / relative
                        cache_key = texture_variant_cache_key(
                            format_name,
                            source_texture_sha256,
                            extracted.width,
                            extracted.height,
                            ktx_version,
                            source_payload_sha256=(
                                extracted.payload_sha256
                                if format_name == "astc6x6"
                                else None
                            ),
                        )
                        previous = previous_variants.get(
                            (extracted.texture_index, format_name)
                        )
                        restored = False
                        if restore_output is not None and isinstance(previous, dict):
                            previous_source = _restore_variant_path(
                                previous.get("source"), config.id
                            )
                            if (
                                previous.get("cacheKey") == cache_key
                                and previous.get("sourceTextureSha256")
                                == source_texture_sha256
                                and previous_source
                                and isinstance(previous.get("sha256"), str)
                                and isinstance(previous.get("byteLength"), int)
                                and previous.get("byteLength") > 0
                            ):
                                try:
                                    restore_output(
                                        previous_source, previous["sha256"], output
                                    )
                                    restored = (
                                        output.is_file()
                                        and output.stat().st_size
                                        == previous["byteLength"]
                                        and sha256_file(output) == previous["sha256"]
                                    )
                                except Exception:
                                    restored = False
                                if not restored:
                                    output.unlink(missing_ok=True)
                        if restored:
                            metadata = dict(previous)
                            metadata.update(
                                {
                                    "textureIndex": extracted.texture_index,
                                    "texture": extracted.texture,
                                    "source": _runtime_url(config.id, key, relative),
                                    "container": "ktx2",
                                    "format": format_name,
                                    "width": extracted.width,
                                    "height": extracted.height,
                                    "flipY": format_name == "astc6x6",
                                    "cacheKey": cache_key,
                                    "sourceTextureSha256": source_texture_sha256,
                                    "encoderProfile": encoder_profile(
                                        format_name, ktx_version
                                    ),
                                    **(
                                        {
                                            "sourcePayloadSha256": extracted.payload_sha256
                                        }
                                        if format_name == "astc6x6"
                                        else {}
                                    ),
                                }
                            )
                            texture_variants.append(metadata)
                            native_texture_variant_reused += 1
                            continue
                        writer(extracted, output, executable=ktx_executable)
                        texture_variants.append(
                            ktx2_variant_metadata(
                                extracted,
                                _runtime_url(config.id, key, relative),
                                output,
                                format_name=format_name,
                                tool_version=ktx_version,
                                source_texture_sha256=source_texture_sha256,
                            )
                        )
                    except Exception as error:
                        texture_variant_issues.append(
                            TextureVariantIssue(
                                extracted.texture_index,
                                extracted.texture,
                                "variant-writer-failed",
                                f"{format_name}: {type(error).__name__}: {error}",
                            )
                        )

            _, extraction_issues = extract_live2d_astc(
                config.id,
                source_id,
                texture_references,
                on_texture=package_texture,
                bundle_records=texture_bundle_records,
                source_root=texture_source_root,
                fetch_original=(
                    (lambda digest, target: delta.fetch_original_bundle(digest, target))
                    if delta is not None
                    else None
                ),
            )
            texture_variant_issues.extend(extraction_issues)
        elif texture_references and ktx_executable and texture_source_root is None:
            texture_variant_issues.extend(
                TextureVariantIssue(
                    reference.texture_index,
                    reference.texture,
                    "source-manifest-unavailable",
                    "optional native texture source manifest is unavailable; canonical PNG retained"
                    + (
                        f" ({texture_source_load_error})"
                        if texture_source_load_error
                        else ""
                    ),
                )
                for reference in texture_references
            )
        else:
            issue = (
                "official KTX-Software executable is unavailable"
                if texture_references
                else "model has no selected Texture2D outputs"
            )
            texture_variant_issues.extend(
                TextureVariantIssue(
                    reference.texture_index,
                    reference.texture,
                    "ktx-tool-unavailable"
                    if ktx_executable is None
                    else "selected-output-missing",
                    issue,
                )
                for reference in texture_references
            )

        atomic_write(runtime_dir / "model.moc3", moc)

        motions = []
        motion_references = []
        motion_prefix = f"{model_root}/common/motions/"
        for value in paths:
            if not value.startswith(motion_prefix) or not value.casefold().endswith(
                ".fade.asset"
            ):
                continue
            data = store.source_data(value)
            if not data:
                continue
            name = PurePosixPath(value).name.removesuffix(".fade.asset")
            relative = f"motions/{name}.motion3.json"
            write_json(runtime_dir / relative, motion3_from_fade_asset(data))
            fade_in = _number(data.get("FadeInTime"), 1)
            fade_out = _number(data.get("FadeOutTime"), 1)
            motions.append(
                {
                    "name": name,
                    "sourcePath": value,
                    "runtime": _runtime_url(config.id, key, relative),
                    "fadeInTime": fade_in,
                    "fadeOutTime": fade_out,
                }
            )
            motion_references.append(
                {"File": relative, "FadeInTime": fade_in, "FadeOutTime": fade_out}
            )
        if not motions:
            packed_motions = sorted(
                (
                    (str(data.get("MotionName") or ""), str(record["pathId"]), data)
                    for record in records.values()
                    if isinstance((data := record.get("data")), dict)
                    and isinstance(data.get("ParameterCurves"), list)
                    and str(data.get("MotionName") or "").startswith(motion_prefix)
                ),
                key=lambda item: (item[0], item[1]),
            )
            for motion_path, object_id, data in packed_motions:
                name = PurePosixPath(motion_path).name.removesuffix(".motion3.json")
                relative = f"motions/{name}.motion3.json"
                write_json(runtime_dir / relative, motion3_from_fade_asset(data))
                fade_in = _number(data.get("FadeInTime"), 1)
                fade_out = _number(data.get("FadeOutTime"), 1)
                motions.append(
                    {
                        "name": name,
                        "sourcePath": source_path,
                        "bundleObjectId": object_id,
                        "runtime": _runtime_url(config.id, key, relative),
                        "fadeInTime": fade_in,
                        "fadeOutTime": fade_out,
                    }
                )
                motion_references.append(
                    {"File": relative, "FadeInTime": fade_in, "FadeOutTime": fade_out}
                )

        expressions = []
        expression_references = []
        expression_prefix = f"{model_root}/common/expressions/"
        for value in paths:
            if not value.startswith(expression_prefix) or not value.casefold().endswith(
                ".exp3.asset"
            ):
                continue
            data = store.source_data(value)
            if not data:
                continue
            name = PurePosixPath(value).name.removesuffix(".exp3.asset")
            relative = f"expressions/{name}.exp3.json"
            write_json(runtime_dir / relative, exp3_from_expression_asset(data))
            expressions.append(
                {
                    "name": name,
                    "sourcePath": value,
                    "runtime": _runtime_url(config.id, key, relative),
                }
            )
            expression_references.append({"Name": name, "File": relative})
        if not expressions:
            packed_expressions = sorted(
                (
                    (str(data.get("m_Name") or ""), str(record["pathId"]), data)
                    for record in records.values()
                    if isinstance((data := record.get("data")), dict)
                    and data.get("Type") == "Live2D Expression"
                    and isinstance(data.get("Parameters"), list)
                    and str(data.get("m_Name") or "").endswith(".exp3")
                ),
                key=lambda item: (item[0], item[1]),
            )
            for expression_name, object_id, data in packed_expressions:
                name = expression_name.removesuffix(".exp3")
                relative = f"expressions/{name}.exp3.json"
                write_json(runtime_dir / relative, exp3_from_expression_asset(data))
                expressions.append(
                    {
                        "name": name,
                        "sourcePath": source_path,
                        "bundleObjectId": object_id,
                        "runtime": _runtime_url(config.id, key, relative),
                    }
                )
                expression_references.append({"Name": name, "File": relative})

        physics = next(
            (
                physics3_from_rig(data["_rig"])
                for record in records.values()
                if isinstance((data := record.get("data")), dict)
                and isinstance(data.get("_rig"), dict)
                and data["_rig"].get("SubRigs")
            ),
            None,
        )
        if physics:
            write_json(runtime_dir / "physics3.json", physics)

        model3 = {
            "Version": 3,
            "FileReferences": {
                "Moc": "model.moc3",
                "Textures": textures,
                **({"Physics": "physics3.json"} if physics else {}),
                "Motions": {"Motion": motion_references},
                "Expressions": expression_references,
            },
            "Groups": [
                {
                    "Target": "Parameter",
                    "Name": "EyeBlink",
                    "Ids": ["ParamEyeLOpen", "ParamEyeROpen"],
                },
                {"Target": "Parameter", "Name": "LipSync", "Ids": ["ParamMouthOpenY"]},
            ],
        }
        write_json(runtime_dir / "model3.json", model3)
        harmonic = _harmonic_motion(records)
        motion_sync = _motion_sync(records)
        runtime = {
            "model": _runtime_url(config.id, key, "model3.json"),
            "moc": _runtime_url(config.id, key, "model.moc3"),
            "physics": _runtime_url(config.id, key, "physics3.json")
            if physics
            else None,
            "textures": textures,
            "textureVariants": sorted(
                texture_variants,
                key=lambda value: int(value.get("textureIndex", 0)),
            ),
            "harmonicMotion": harmonic,
            "motionSync": motion_sync,
        }
        native_texture_variant_count += len(texture_variants)
        native_texture_variant_bytes += sum(
            int(value.get("byteLength") or 0) for value in texture_variants
        )
        native_texture_variant_issues.extend(
            {"live2dKey": key, **issue.as_dict()} for issue in texture_variant_issues
        )
        models[key] = {
            "live2dKey": key,
            "live2dName": live2d_name,
            "modelType": "live" if raw_mode == "live" else "adv",
            "mode": raw_mode,
            "quality": "low" if key.casefold().endswith("_low") else None,
            "costumeId": None,
            "assetId": None,
            "characterId": character_id,
            "characterKey": character_key,
            "subCharacter": sub_character,
            "sourcePath": source_path,
            "mocSourcePath": moc_source,
            "profile": _profile(records),
            "runtime": runtime,
            "motions": motions,
            "expressions": expressions,
            "harmonicMotion": harmonic,
        }

    # Unity's live-stage low exports omit the MotionSyncData component while
    # their normal sibling carries the exact character-specific CRI profile.
    # Copy that authored profile instead of substituting one global fallback
    # (010/Sakiko intentionally uses a different I sensitivity).
    for key, model in models.items():
        runtime = model["runtime"]
        if runtime.get("motionSync") is not None or not key.casefold().endswith("_low"):
            continue
        normal = models.get(key[:-4])
        normal_motion_sync = (
            normal.get("runtime", {}).get("motionSync") if normal else None
        )
        if normal_motion_sync is not None:
            runtime["motionSync"] = copy.deepcopy(normal_motion_sync)
    # Adopted low models keep the base pair's motionSync; if their normal
    # sibling was rebuilt in this run with a different profile, follow it.
    for key in adopted_model_keys:
        model = models.get(key)
        if model is None or not key.casefold().endswith("_low"):
            continue
        normal = models.get(key[:-4])
        if normal is None:
            continue
        sibling_sync = normal.get("runtime", {}).get("motionSync")
        if sibling_sync is None:
            # The rebuilt sibling has no motionSync; drop the stale adopted one.
            model["runtime"]["motionSync"] = None
        elif model.get("runtime", {}).get("motionSync") != sibling_sync:
            model["runtime"]["motionSync"] = copy.deepcopy(sibling_sync)

    provision_file = (
        PROJECT_ROOT / "public" / "cubism-runtime" / "vega-cubism-web-runtime.mjs"
    )
    provision_sha = sha256_file(provision_file) if provision_file.is_file() else ""
    identities = {
        key: (
            str(base_models[key].get("previewInputSha256") or "")
            if key in adopted_model_keys
            else _preview_input_identity(
                index.get("sources", {}), layout, config.id, model, provision_sha
            )
        )
        for key, model in models.items()
    }
    for key, model in models.items():
        model["previewInputSha256"] = identities[key]

    previews, reuse_summary = build_live2d_previews(
        layout,
        config.id,
        source_id,
        models,
        identities=identities,
        reuse_manifest=reuse_manifest,
        restore_output=restore_output,
        reuse_concurrency=reuse_concurrency,
    )
    for key, model in models.items():
        model["preview"] = previews[key]

    result = {
        "schema": "haneoka-live2d-build-v1",
        "server": config.id,
        "sourceId": source_id,
        "modelCount": len(models),
        "previewSchema": PREVIEW_SCHEMA,
        "previewRenderedCount": sum(
            1 for preview in previews.values() if preview.get("status") == "rendered"
        ),
        "previewUnavailableCount": sum(
            1 for preview in previews.values() if preview.get("status") != "rendered"
        ),
        "previewReusedCount": reuse_summary.get("restored", 0),
        "previewReuseRestoreFailureCount": reuse_summary.get("failed", 0),
        "nativeTextureVariantCount": native_texture_variant_count,
        "nativeTextureVariantBytes": native_texture_variant_bytes,
        "nativeTextureVariantReusedCount": native_texture_variant_reused,
        "nativeTextureVariantFailureCount": len(native_texture_variant_issues),
        "nativeTextureVariantIssues": native_texture_variant_issues,
        "skippedModelCount": len(skipped_models),
        "models": models,
        "skippedModels": skipped_models,
    }
    write_json(
        layout.reports / "live2d-textures.json",
        {
            "schema": "haneoka-live2d-native-textures-report-v1",
            "server": config.id,
            "sourceId": source_id,
            "buildId": build_id,
            "variantCount": native_texture_variant_count,
            "variantBytes": native_texture_variant_bytes,
            "reusedCount": native_texture_variant_reused,
            "failureCount": len(native_texture_variant_issues),
            "issues": native_texture_variant_issues,
        },
        pretty=True,
    )
    write_json(layout.metadata / "live2d.json", result, pretty=True)
    return result
