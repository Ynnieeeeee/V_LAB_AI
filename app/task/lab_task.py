import asyncio
import os
import uuid

import trimesh
from sqlmodel import Session

from app.models.tools import Tools
from app.services.image_service import (
    SINGLE_IMAGE_FAILURE_MESSAGE,
    clean_tool_image_for_3d,
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
    session.add(tool)
    session.commit()
    print(f"[3DPipeline] Dung fallback model cho {tool.name_tool_en}: {fallback_url} | reason={reason}")
    return True


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
                if tool.model_3d_url:
                    print(f"[3DPipeline] Tool da co model, bo qua: {tool.name_tool_en} -> {tool.model_3d_url}")
                    continue

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
                        session.add(tool)
                        session.commit()
                    else:
                        print(f"{SINGLE_IMAGE_FAILURE_MESSAGE} ({tool.name_tool_en})")
                        apply_local_fallback_model(session, tool, service_3d, "missing_image")
                        continue

                cleaned_image_url = clean_tool_image_for_3d(
                    tool.image_2d_url,
                    tool.name_tool_en,
                    tool.id_tool,
                    tool.tool_type,
                )
                if cleaned_image_url and cleaned_image_url != tool.image_2d_url:
                    tool.image_2d_url = cleaned_image_url
                    session.add(tool)
                    session.commit()

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
                    task_id = service_3d.create_3d_task(
                        tool.image_2d_url,
                        tool.name_tool_en,
                        tool.name_tool_vi,
                        tool.tool_type,
                        model_attempt,
                    )
                    if not task_id:
                        print(f"[3DPipeline] Khong tao duoc Tripo task cho: {tool.name_tool_en}")
                        last_failure = "tripo_create_task_failed"
                        break

                    for _ in range(60):
                        await asyncio.sleep(5)
                        res = service_3d.check_task_status(task_id)
                        print(f"[3DPipeline] Trang thai {tool.name_tool_en}: {res}")

                        if isinstance(res, str) and res.startswith("http"):
                            local_url = service_3d.download_and_get_local_url(res, tool.name_tool_en)
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
                        apply_local_fallback_model(session, tool, service_3d, last_failure)
        except Exception as exc:
            print(f"[3DPipeline] Loi pipeline cho tool {key}: {exc}")
        finally:
            PROCESSING_TOOL_IDS.discard(key)
