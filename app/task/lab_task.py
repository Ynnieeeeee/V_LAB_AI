import asyncio
import os
import uuid
from datetime import datetime

import trimesh
from sqlmodel import Session

from app.models.tools import Tools
from app.services.image_service import (
    SINGLE_IMAGE_FAILURE_MESSAGE,
    clean_tool_image_for_3d,
    compute_image_hash,
    search_tool_image,
    validate_single_object_image,
)
from app.services.mesh_service import MeshService
from app.utils.tool_classifier import ensure_tools_metadata_columns


PROCESSING_TOOL_IDS = set()


def _normalize_tool_id(tool_id):
    try:
        return uuid.UUID(str(tool_id))
    except Exception:
        return tool_id


def get_processing_tool_ids():
    return set(PROCESSING_TOOL_IDS)


def align_model_to_floor(local_path):
    """Only translate the model to touch the floor; keep AI-generated orientation intact."""
    try:
        loaded = trimesh.load(local_path, force="scene")
        bounds = getattr(loaded, "bounds", None)
        if bounds is None:
            print(f"Khong tim thay bounds de can chinh: {local_path}")
            return

        y_min = float(bounds[0][1])
        loaded.apply_translation([0, -y_min, 0])
        loaded.export(local_path)
        print(f"Can chinh cham san thanh cong, khong xoay truc model: {local_path}")
    except Exception as exc:
        print(f"Loi khi can chinh mo hinh: {exc}")


def apply_local_fallback_model(session, tool, service_3d, reason):
    fallback_url = service_3d.get_local_fallback_model_url(
        name_vi=tool.name_tool_vi,
        name_en=tool.name_tool_en,
        tool_type=tool.tool_type,
    )
    if not fallback_url:
        print(f"[3DPipeline] Khong co fallback model cho {tool.name_tool_en}: {reason}")
        return False
    tool.model_3d_url = fallback_url
    tool.model_generation_status = "fallback"
    tool.model_image_hash = tool.image_hash
    tool.force_regenerate_model = False
    session.add(tool)
    session.commit()
    print(f"[3DPipeline] Dung fallback model cho {tool.name_tool_en}: {fallback_url} | reason={reason}")
    return True


NON_FALLBACK_FAILURES = {
    "missing_public_base_url_for_cleaned_image",
    "non_public_base_url_for_cleaned_image",
    "missing_image_url",
}


def should_apply_local_fallback(reason):
    return reason not in NON_FALLBACK_FAILURES


def mark_model_generation_failed(session, tool, reason):
    if reason in {"missing_public_base_url_for_cleaned_image", "non_public_base_url_for_cleaned_image"}:
        tool.model_generation_status = "failed_public_image_url"
        tool.force_regenerate_model = True
        tool.model_3d_url = None
        tool.model_image_hash = None
        tool.model_job_id = None
    else:
        tool.model_generation_status = "failed"
    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()


def _model_matches_current_image(tool):
    if not tool.model_3d_url or tool.force_regenerate_model:
        return False
    if tool.image_hash and tool.model_image_hash == tool.image_hash:
        return True
    return not tool.image_hash and not tool.model_image_hash


def _model_reuse_reason(tool):
    if tool.image_hash and tool.model_image_hash == tool.image_hash:
        return "model hash matches image hash"
    if not tool.image_hash and not tool.model_image_hash:
        return "legacy model without hash"
    return "not reusable"


def _reset_model_for_new_image(tool, image_hash, reason):
    if image_hash and tool.image_hash != image_hash:
        print(f"[Image2Model] image hash changed: old={tool.image_hash} new={image_hash}")
        tool.image_hash = image_hash
    print(f"[Image2Model] reset cached model: {reason}")
    tool.model_3d_url = None
    tool.model_generation_status = "pending"
    tool.force_regenerate_model = True
    tool.updated_at = datetime.utcnow()


async def start_3d_pipeline_task(tool_ids: list, engine):
    queued_ids = []
    for raw_id in tool_ids:
        normalized_id = _normalize_tool_id(raw_id)
        key = str(normalized_id)
        if key in PROCESSING_TOOL_IDS:
            print(f"[3DPipeline] Dang xu ly tool, bo qua enqueue trung: {key}")
            continue
        PROCESSING_TOOL_IDS.add(key)
        queued_ids.append(normalized_id)

    if not queued_ids:
        return

    service_3d = MeshService()
    from app.services.vision_service import VisionService
    vision_service = VisionService()
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../"))

    for t_id in queued_ids:
        key = str(t_id)
        try:
            with Session(engine) as session:
                ensure_tools_metadata_columns(session)
                session.commit()
                tool = session.get(Tools, t_id)
                if not tool:
                    print(f"[3DPipeline] Khong tim thay tool: {key}")
                    continue
                if _model_matches_current_image(tool):
                    print("[Image2Model] FORCE regenerate:", False)
                    print("[Image2Model] image_url used:", tool.image_2d_url)
                    print("[Image2Model] image_hash:", tool.image_hash)
                    print("[Image2Model] old model_image_hash:", tool.model_image_hash)
                    print("[Image2Model] old model_3d_url:", tool.model_3d_url)
                    print("[Image2Model] skip reason:", _model_reuse_reason(tool))
                    print(f"[3DPipeline] Tool da co model dung hash, bo qua: {tool.name_tool_en} -> {tool.model_3d_url}")
                    continue

                if tool.image_2d_url and not tool.image_hash:
                    tool.image_hash = compute_image_hash(tool.image_2d_url)
                    session.add(tool)
                    session.commit()

                if tool.model_3d_url:
                    print("[Image2Model] FORCE regenerate:", True)
                    print("[Image2Model] image_url used:", tool.image_2d_url)
                    print("[Image2Model] image_hash:", tool.image_hash)
                    print("[Image2Model] old model_image_hash:", tool.model_image_hash)
                    print("[Image2Model] old model_3d_url:", tool.model_3d_url)
                    _reset_model_for_new_image(tool, tool.image_hash, "cached_model_hash_mismatch")
                    session.add(tool)
                    session.commit()

                print(f"[3DPipeline] Bat dau xu ly: {tool.name_tool_en} ({tool.id_tool})")

                if tool.image_2d_url:
                    validation = validate_single_object_image(
                        tool.image_2d_url,
                        tool.name_tool_en,
                        tool.name_tool_vi,
                        tool.tool_type,
                    )
                    print(f"[ToolImage] validation: {validation}")
                    if not validation.get("isValid"):
                        print(f"[ImageValidation] rejected existing image: {validation.get('reason')}")
                        tool.image_2d_url = None
                        session.add(tool)
                        session.commit()

                if not tool.image_2d_url:
                    print(f"Dang tim anh cho: {tool.name_tool_en}")
                    image_url = search_tool_image(
                        tool.name_tool_en,
                        tool.name_tool_vi,
                        tool.tool_type,
                        tool.subject_type,
                    )
                    if image_url:
                        tool.image_2d_url = image_url
                        tool.image_hash = compute_image_hash(image_url)
                        tool.model_generation_status = "pending"
                        tool.force_regenerate_model = True
                        session.add(tool)
                        session.commit()
                    else:
                        print(f"{SINGLE_IMAGE_FAILURE_MESSAGE} ({tool.name_tool_en})")
                        apply_local_fallback_model(session, tool, service_3d, "missing_image")
                        continue

                original_public_url = tool.image_2d_url if (tool.image_2d_url and tool.image_2d_url.startswith(("http://", "https://"))) else None
                if tool.image_2d_url and tool.image_2d_url.startswith("/static/"):
                    public_base_url = os.getenv("PUBLIC_BASE_URL") or os.getenv("APP_PUBLIC_URL") or PUBLIC_BASE_URL
                    if not public_base_url or service_3d._is_non_public_base_url(public_base_url):
                        print(f"[3DPipeline] Local image found but PUBLIC_BASE_URL is missing/private. Searching for public image URL to use as fallback...")
                        public_search_url = search_tool_image(
                            tool.name_tool_en,
                            tool.name_tool_vi,
                            tool.tool_type,
                            tool.subject_type,
                        )
                        if public_search_url:
                            print(f"[3DPipeline] Found public search URL: {public_search_url}")
                            original_public_url = public_search_url

                cleaned_image_url = clean_tool_image_for_3d(
                    tool.image_2d_url,
                    tool.name_tool_en,
                    tool.id_tool,
                    tool.tool_type,
                )
                if cleaned_image_url and cleaned_image_url != tool.image_2d_url:
                    previous_image_url = tool.image_2d_url
                    tool.image_2d_url = cleaned_image_url
                    cleaned_hash = compute_image_hash(cleaned_image_url)
                    _reset_model_for_new_image(tool, cleaned_hash, f"image_changed:{previous_image_url}->{cleaned_image_url}")
                    session.add(tool)
                    session.commit()
                elif tool.image_2d_url:
                    current_hash = compute_image_hash(tool.image_2d_url)
                    if current_hash and current_hash != tool.image_hash:
                        _reset_model_for_new_image(tool, current_hash, "image_hash_changed")
                        session.add(tool)
                        session.commit()

                if _model_matches_current_image(tool):
                    print("[Image2Model] FORCE regenerate:", False)
                    print("[Image2Model] image_url used:", tool.image_2d_url)
                    print("[Image2Model] image_hash:", tool.image_hash)
                    print("[Image2Model] old model_image_hash:", tool.model_image_hash)
                    print("[Image2Model] old model_3d_url:", tool.model_3d_url)
                    print("[Image2Model] skip reason:", _model_reuse_reason(tool))
                    print(f"[3DPipeline] Reuse model after hash check: {tool.model_3d_url}")
                    continue

                print(f"Dang phan tich chat lieu: {tool.name_tool_en}")
                from app.services.color_service import ColorService
                color_service = ColorService()
                extracted_color = color_service.get_dominant_color(tool.image_2d_url)
                pbr_data = vision_service.analyze_material(tool.image_2d_url)

                if pbr_data:
                    tool.material_color = extracted_color if extracted_color != "#ffffff" else pbr_data.get("material_color", "#ffffff")
                    tool.material_type = pbr_data.get("material_type", "OTHER")
                    tool.roughness = pbr_data.get("roughness", 0.5)
                    tool.metalness = pbr_data.get("metalness", 0.0)
                    tool.is_glass = pbr_data.get("is_glass", False)
                    tool.ior = pbr_data.get("ior", 1.5)
                    tool.transmission = pbr_data.get("transmission", 0.0)
                    session.add(tool)
                    session.commit()

                completed = False
                last_failure = "unknown"
                for model_attempt in range(1, 4):
                    print(f"Gui Task Tripo: {tool.name_tool_en} attempt={model_attempt}")
                    print("[Image2Model] FORCE regenerate:", bool(tool.force_regenerate_model))
                    print("[Image2Model] image_url used:", tool.image_2d_url)
                    print("[Image2Model] image_hash:", tool.image_hash)
                    print("[Image2Model] old model_image_hash:", tool.model_image_hash)
                    print("[Image2Model] old model_3d_url:", tool.model_3d_url)
                    print("[Image2Model] preparing 3D API request...")
                    task_id = service_3d.create_3d_task(
                        tool.image_2d_url,
                        tool.name_tool_en,
                        tool.name_tool_vi,
                        tool.tool_type,
                        model_attempt,
                        fallback_public_url=original_public_url,
                    )
                    if not task_id:
                        print(f"[3DPipeline] Khong tao duoc Tripo task cho: {tool.name_tool_en}")
                        last_failure = service_3d.last_image_url_error or "tripo_create_task_failed"
                        break

                    tool = session.get(Tools, t_id)
                    tool.model_job_id = task_id
                    tool.model_generation_status = "running"
                    tool.updated_at = datetime.utcnow()
                    session.add(tool)
                    session.commit()

                    for _ in range(60):
                        await asyncio.sleep(5)
                        res = service_3d.check_task_status(task_id)
                        print(f"[3DPipeline] Trang thai {tool.name_tool_en}: {res}")

                        if isinstance(res, str) and res.startswith("http"):
                            local_url = service_3d.download_and_get_local_url(
                                res,
                                tool.name_tool_en,
                                tool.image_hash,
                                tool.id_tool,
                            )
                            if not local_url:
                                last_failure = "download_failed"
                                break

                            full_path = service_3d.local_model_path_from_url(local_url)
                            validation = None
                            if full_path and os.path.exists(full_path):
                                validation = service_3d.validate_and_repair_single_object_model(
                                    full_path,
                                    tool.name_tool_en,
                                    tool.tool_type,
                                )
                            if validation and not validation.get("accepted"):
                                last_failure = validation.get("reason", "duplicated_model")
                                print(f"[ModelValidation] rejected duplicated model: {last_failure}")
                                break

                            if full_path and os.path.exists(full_path):
                                align_model_to_floor(full_path)

                            tool = session.get(Tools, t_id)
                            tool.model_3d_url = local_url
                            tool.model_image_hash = tool.image_hash
                            tool.model_generation_status = "completed"
                            tool.force_regenerate_model = False
                            tool.updated_at = datetime.utcnow()
                            session.add(tool)
                            session.commit()
                            print(f"[ModelValidation] final accepted: {local_url}")
                            print(f"Hoan tat dung cu: {tool.name_tool_en}")
                            completed = True
                            break

                        if "ERROR" in str(res):
                            print(f"Loi Tripo cho {tool.name_tool_en}: {res}")
                            last_failure = str(res)
                            break

                    if completed:
                        break

                if not completed:
                    tool = session.get(Tools, t_id)
                    if tool and not tool.model_3d_url:
                        mark_model_generation_failed(session, tool, last_failure)
                        if should_apply_local_fallback(last_failure):
                            apply_local_fallback_model(session, tool, service_3d, last_failure)
                        else:
                            print(
                                "[3DPipeline] Skip fallback model because the cleaned image was not sent "
                                f"to the 3D API: {last_failure}"
                            )
        except Exception as exc:
            print(f"[3DPipeline] Loi pipeline cho tool {key}: {exc}")
        finally:
            PROCESSING_TOOL_IDS.discard(key)
