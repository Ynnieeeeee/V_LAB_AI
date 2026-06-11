import asyncio
import os
import uuid
from datetime import datetime
from pathlib import Path

from sqlmodel import Session

from app.models.tools import Tools
from app.services.image_service import (
    SINGLE_IMAGE_FAILURE_MESSAGE,
    compute_image_hash,
    search_tool_image,
    validate_single_object_image,
)
from app.services.mesh_service import ENABLE_HEAVY_MODEL_VALIDATION, MODEL_URL_PREFIX, MeshService
from app.utils.tool_classifier import ensure_tools_metadata_columns


PROCESSING_TOOL_IDS = set()
APP_DIR = Path(__file__).resolve().parents[1]
STATIC_MODEL_DIR = APP_DIR / "static" / "models"


def _normalize_tool_id(tool_id):
    try:
        return uuid.UUID(str(tool_id))
    except Exception:
        return tool_id


def get_processing_tool_ids():
    return set(PROCESSING_TOOL_IDS)


def _local_static_model_path_from_url(model_url: str = ""):
    if not model_url or not str(model_url).startswith(MODEL_URL_PREFIX):
        return None
    filename = os.path.basename(str(model_url).split("?")[0].split("/")[-1])
    if not filename:
        return None
    return STATIC_MODEL_DIR / filename


def align_model_to_floor(local_path):
    """Only translate the model to touch the floor; keep AI-generated orientation intact."""
    try:
        import trimesh

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


def mark_model_generation_failed(session, tool, reason):
    if reason in {"missing_public_base_url_for_cleaned_image", "non_public_base_url_for_cleaned_image"}:
        tool.model_generation_status = "failed_public_image_url"
        tool.force_regenerate_model = True
        tool.model_3d_url = None
        tool.model_image_hash = None
        tool.model_job_id = None
    else:
        tool.model_generation_status = "failed"
        tool.force_regenerate_model = False
        tool.model_job_id = None
    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()


def _is_public_image_url(image_url: str = "") -> bool:
    return bool(image_url and image_url.startswith(("http://", "https://")))


def _save_completed_model_url(session, tool_id, model_url: str, image_hash: str | None = None):
    if not model_url or not str(model_url).startswith(MODEL_URL_PREFIX):
        print("[3DPipeline] Refuse to save non-local model_3d_url")
        return None
    local_path = _local_static_model_path_from_url(model_url)
    if not local_path or not local_path.exists():
        print("[3DPipeline] Refuse to save model_3d_url because local file is missing")
        return None
    tool = session.get(Tools, tool_id)
    if not tool:
        return None
    tool.model_3d_url = model_url
    tool.model_image_hash = image_hash or tool.image_hash
    tool.model_generation_status = "completed"
    tool.force_regenerate_model = False
    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()
    session.refresh(tool)
    if tool.model_3d_url != model_url:
        print("[3DPipeline] DB verify failed after saving model_3d_url")
        return None
    print(f"[3DPipeline] Saved model_3d_url to DB: {tool.name_tool_en} -> {model_url}")
    return tool


def _model_url_log_state(model_url: str = "") -> str:
    if not model_url:
        return "empty"
    if str(model_url).startswith(MODEL_URL_PREFIX):
        return "local"
    return "non_local"


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

                if tool.image_2d_url and not _is_public_image_url(tool.image_2d_url):
                    print(
                        "[Image2Model] Existing image is local/private; replacing with a direct internet URL:",
                        tool.image_2d_url,
                    )
                    tool.image_2d_url = None
                    tool.image_hash = None
                    _reset_model_for_new_image(tool, None, "replace_local_image_with_public_url")
                    session.add(tool)
                    session.commit()

                if _model_matches_current_image(tool):
                    print("[Image2Model] FORCE regenerate:", False)
                    print("[Image2Model] image_url used:", tool.image_2d_url)
                    print("[Image2Model] image_hash:", tool.image_hash)
                    print("[Image2Model] old model_image_hash:", tool.model_image_hash)
                    print("[Image2Model] old model_3d_url:", _model_url_log_state(tool.model_3d_url))
                    print("[Image2Model] skip reason:", _model_reuse_reason(tool))
                    print(
                        f"[3DPipeline] Tool da co model dung hash, bo qua: "
                        f"{tool.name_tool_en} ({_model_url_log_state(tool.model_3d_url)})"
                    )
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
                    print("[Image2Model] old model_3d_url:", _model_url_log_state(tool.model_3d_url))
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
                        print(
                            "[ImageValidation] existing image did not pass strict search validation; "
                            f"keep provided image_2d_url: {validation.get('reason')}"
                        )

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
                        mark_model_generation_failed(session, tool, "missing_image")
                        continue

                if tool.image_2d_url:
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
                    print("[Image2Model] old model_3d_url:", _model_url_log_state(tool.model_3d_url))
                    print("[Image2Model] skip reason:", _model_reuse_reason(tool))
                    print(f"[3DPipeline] Reuse model after hash check: {_model_url_log_state(tool.model_3d_url)}")
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
                    print("[Image2Model] old model_3d_url:", _model_url_log_state(tool.model_3d_url))
                    print("[Image2Model] preparing 3D API request...")
                    task_id = service_3d.create_3d_task(
                        tool.image_2d_url,
                        tool.name_tool_en,
                        tool.name_tool_vi,
                        tool.tool_type,
                        model_attempt,
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

                        if isinstance(res, str) and res.startswith("http"):
                            print(f"[3DPipeline] Trang thai {tool.name_tool_en}: model_url_ready")
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
                            if not full_path or not os.path.exists(full_path):
                                last_failure = "download_missing_local_file"
                                print("[3DPipeline] Download returned local URL but file is missing; model_3d_url will not be saved")
                                break

                            validation = None
                            if ENABLE_HEAVY_MODEL_VALIDATION:
                                validation = service_3d.validate_and_repair_single_object_model(
                                    full_path,
                                    tool.name_tool_en,
                                    tool.tool_type,
                                )
                            else:
                                print("[ModelValidation] skipped heavy mesh validation")
                            if validation and not validation.get("accepted"):
                                last_failure = validation.get("reason", "duplicated_model")
                                print(f"[ModelValidation] rejected local model copy: {last_failure}; model_3d_url will not be saved")
                                break

                            if ENABLE_HEAVY_MODEL_VALIDATION:
                                align_model_to_floor(full_path)

                            tool = _save_completed_model_url(session, t_id, local_url, tool.image_hash)
                            if not tool:
                                last_failure = "non_local_model_url"
                                break
                            print(f"[ModelValidation] final accepted: {local_url}")
                            print(f"Hoan tat dung cu: {tool.name_tool_en}")
                            completed = True
                            break

                        print(f"[3DPipeline] Trang thai {tool.name_tool_en}: {res}")
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
                        print(f"[3DPipeline] No local model saved for {tool.name_tool_en}: {last_failure}")
        except Exception as exc:
            print(f"[3DPipeline] Loi pipeline cho tool {key}: {exc}")
        finally:
            PROCESSING_TOOL_IDS.discard(key)
