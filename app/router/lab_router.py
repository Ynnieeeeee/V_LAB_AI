from datetime import datetime
import json
import math
import time
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from sqlalchemy import and_, or_
from sqlmodel import Session, select

from app.models.base_db import engine, get_session
from app.models.conversations import Conversations
from app.models.profiles import Profiles
from app.models.tools import Tools
from app.services.image_service import SINGLE_IMAGE_FAILURE_MESSAGE
from app.services.lab_service import LabServices, find_reusable_model_tool
from app.services.mesh_service import MeshService
from app.task.lab_task import get_processing_tool_ids, start_3d_pipeline_task
from app.utils.get_current_user import get_current_user
from app.utils.subscription_utils import require_tool_limit, require_active_plan
from app.utils.tool_classifier import ensure_tools_metadata_columns


router = APIRouter(prefix="/api/lab", tags=["Laboratory"])
lab_service = LabServices()
LAST_PIPELINE_REQUEUE_AT = {}
LEGACY_FALLBACK_CUTOFF = datetime(2026, 6, 10)
LEGACY_RECOVERABLE_STATUSES = ("pending", "running", "failed", "failed_public_image_url")


def _restore_legacy_room_models(id_conv, session: Session) -> int:
    """Restore models erased by the old fallback-to-regeneration migration.

    Before the strict single-image pipeline was introduced, failed generations
    were represented by a local fallback GLB.  The previous status endpoint
    cleared those URLs while merely opening a room.  Recover old rows from an
    existing reusable model first, then from the same local fallback catalogue
    used by the legacy pipeline.
    """
    statement = select(Tools).where(
        Tools.id_conv == id_conv,
        Tools.is_deleted == False,
        Tools.created_at < LEGACY_FALLBACK_CUTOFF,
        Tools.model_3d_url == None,
        Tools.model_generation_status.in_(LEGACY_RECOVERABLE_STATUSES),
    )
    legacy_tools = session.exec(statement).all()
    if not legacy_tools:
        return 0

    processing_ids = get_processing_tool_ids()
    fallback_service = MeshService()
    restored = 0

    for tool in legacy_tools:
        if str(tool.id_tool) in processing_ids:
            continue

        reusable = find_reusable_model_tool(
            session,
            tool.name_tool_vi,
            tool.subject_type,
        )
        if reusable and reusable.id_tool != tool.id_tool:
            model_url = reusable.model_3d_url
            model_image_hash = reusable.model_image_hash or reusable.image_hash
            restored_status = (
                "fallback"
                if reusable.model_generation_status == "fallback"
                else "completed"
            )
        else:
            model_url = fallback_service.get_local_fallback_model_url(
                name_vi=tool.name_tool_vi,
                name_en=tool.name_tool_en,
                tool_type=tool.tool_type,
            )
            model_image_hash = tool.image_hash
            restored_status = "fallback"

        if not model_url:
            continue

        tool.model_3d_url = model_url
        tool.model_image_hash = model_image_hash
        tool.model_generation_status = restored_status
        tool.model_job_id = None
        tool.force_regenerate_model = False
        tool.updated_at = datetime.utcnow()
        session.add(tool)
        restored += 1

    if restored:
        session.commit()
        print(f"[LabStatus] Restored {restored} legacy tools for room {id_conv}")

    return restored


def _model_failure_response(tool: Tools) -> dict:
    return {
        "id_tool": str(tool.id_tool),
        "name_tool_vi": tool.name_tool_vi,
        "name_tool_en": tool.name_tool_en,
        "tool_type": tool.tool_type,
        "model_generation_status": tool.model_generation_status,
        "message": SINGLE_IMAGE_FAILURE_MESSAGE,
        "created_at": tool.created_at,
        "updated_at": tool.updated_at,
    }


@router.post("/generate")
async def generate_lab(
    payload: dict,
    backgroundtask: BackgroundTasks,
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    user_text = payload.get("text")
    id_conv = payload.get("id_conv")
    subject = payload.get("subject", "chemistry")

    ensure_tools_metadata_columns(session)
    session.commit()

    if not user_text:
        raise HTTPException(status_code=400, detail="Thieu thong tin mo ta")

    # Chặn ngay từ backend theo subscription_plans.tool_limit_per_day.
    # Kiểm tra tối thiểu 1 lượt trước khi gọi AI.
    plan_limit = require_tool_limit(session, user.id_profile, requested_quantity=1)

    if not id_conv or id_conv == "null" or id_conv == "undefined":
        new_conv = Conversations(
            id_profile=user.id_profile,
            title=user_text[:50],
            subject_type=subject,
        )
        session.add(new_conv)
        session.commit()
        session.refresh(new_conv)
        id_conv = new_conv.id_conv

    extracted_data = await lab_service.process_user_request(
        user_text,
        id_conv,
        subject,
        max_quantity_per_request=plan_limit.get("remaining_tools_today"),
    )

    tool_ids_to_process = []
    response_data = []

    for item in extracted_data:
        response_data.append({
            "id_tool": item["id_tool"],
            "name": item["name_vi"],
            "quantity": item["quantity"],
            "ready": item["model_3d_url"] is not None,
            "tool_type": item.get("tool_type", "unknown"),
            "is_heating_source": item.get("is_heating_source", False),
            "heating_power": item.get("heating_power", 0),
            "max_temperature": item.get("max_temperature", 25),
            "is_toggleable": item.get("is_toggleable", False),
            "is_support_stand": item.get("is_support_stand", False),
            "can_support_tools": item.get("can_support_tools", False),
            "support_height": item.get("support_height", 0.8),
            "support_radius": item.get("support_radius", 1.0),
            "scale_x": item.get("scale_x", 1),
            "scale_y": item.get("scale_y", 1),
            "scale_z": item.get("scale_z", 1),
            "has_custom_scale": item.get("has_custom_scale", False),
            "rotation_x": item.get("rotation_x", 0),
            "rotation_y": item.get("rotation_y", 0),
            "rotation_z": item.get("rotation_z", 0),
            "positions": item.get("positions", {}),
            "capabilities": item.get("capabilities", []),
            "ports": item.get("ports", {}),
            "attach_points": item.get("attach_points", {}),
            "assembly_role": item.get("assembly_role", "none"),
        })

        if not item["model_3d_url"]:
            tool_ids_to_process.append(item["id_tool"])

    if tool_ids_to_process:
        print(f"[LabGenerate] Queue 3D tools: {[str(tool_id) for tool_id in tool_ids_to_process]}")
        backgroundtask.add_task(start_3d_pipeline_task, tool_ids_to_process, engine)

    return {
        "status": "success",
        "conversation_id": id_conv,
        "data": response_data,
    }


def _queue_pending_3d_tools(id_conv, backgroundtask: BackgroundTasks, session: Session) -> None:
    pending_statement = select(Tools).where(
        Tools.id_conv == id_conv,
        Tools.is_deleted == False,
        or_(
            and_(
                Tools.model_3d_url == None,
                Tools.model_generation_status != "failed",
            ),
            Tools.force_regenerate_model == True,
        ),
    )
    pending_tools = session.exec(pending_statement).all()
    processing_ids = get_processing_tool_ids()
    now = time.time()
    requeue_ids = []
    for tool in pending_tools:
        key = str(tool.id_tool)
        last_attempt = LAST_PIPELINE_REQUEUE_AT.get(key, 0)
        if key in processing_ids or now - last_attempt < 60:
            continue
        LAST_PIPELINE_REQUEUE_AT[key] = now
        requeue_ids.append(tool.id_tool)

    if requeue_ids:
        print(f"[LabStatus] Requeue pending 3D tools: {[str(tool_id) for tool_id in requeue_ids]}")
        backgroundtask.add_task(start_3d_pipeline_task, requeue_ids, engine)


@router.get("/status")
async def get_tool_status(
    id_conv: str,
    backgroundtask: BackgroundTasks,
    include_failures: bool = False,
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    conversation = session.get(Conversations, uuid.UUID(str(id_conv)))
    if not conversation or conversation.id_profile != user.id_profile or conversation.is_deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")

    ensure_tools_metadata_columns(session)
    session.commit()
    _restore_legacy_room_models(id_conv, session)
    _queue_pending_3d_tools(id_conv, backgroundtask, session)

    statement = select(Tools).where(
        Tools.id_conv == id_conv,
        Tools.is_deleted == False,
        Tools.model_3d_url != None,
        Tools.force_regenerate_model == False,
    )
    result = session.exec(statement).all()
    print(f"[LabStatus] ready tools for {id_conv}: {len(result)}")

    if include_failures:
        failed_statement = select(Tools).where(
            Tools.id_conv == id_conv,
            Tools.is_deleted == False,
            Tools.model_3d_url == None,
            Tools.image_2d_url == None,
            Tools.model_generation_status == "failed",
        )
        failed_tools = session.exec(failed_statement).all()
        return {
            "tools": result,
            "failed": [_model_failure_response(tool) for tool in failed_tools],
        }

    return result


def _should_regenerate_model(tool: Tools) -> bool:
    if not tool.model_3d_url or tool.force_regenerate_model:
        return True
    return False


@router.get("/tools/{id_tool}/model-debug")
async def get_tool_model_debug(
    id_tool: str,
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    require_active_plan(session, user.id_profile)

    ensure_tools_metadata_columns(session)
    session.commit()
    try:
        tool_uuid = uuid.UUID(str(id_tool))
    except ValueError:
        raise HTTPException(status_code=400, detail="id_tool khong hop le")

    tool = session.get(Tools, tool_uuid)
    if not tool:
        raise HTTPException(status_code=404, detail="Khong tim thay dung cu")

    conversation = session.get(Conversations, tool.id_conv) if tool.id_conv else None
    if conversation and conversation.id_profile != user.id_profile:
        raise HTTPException(status_code=403, detail="Khong co quyen xem dung cu nay")

    return {
        "id_tool": tool.id_tool,
        "image_2d_url": tool.image_2d_url,
        "image_hash": tool.image_hash,
        "model_3d_url": tool.model_3d_url,
        "model_image_hash": tool.model_image_hash,
        "model_generation_status": tool.model_generation_status,
        "model_job_id": tool.model_job_id,
        "force_regenerate_model": tool.force_regenerate_model,
        "shouldRegenerateModel": _should_regenerate_model(tool),
    }


@router.post("/tools/{id_tool}/regenerate-model")
async def regenerate_tool_model(
    id_tool: str,
    backgroundtask: BackgroundTasks,
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    require_tool_limit(session, user.id_profile, requested_quantity=1)
    ensure_tools_metadata_columns(session)
    session.commit()
    try:
        tool_uuid = uuid.UUID(str(id_tool))
    except ValueError:
        raise HTTPException(status_code=400, detail="id_tool khong hop le")

    tool = session.get(Tools, tool_uuid)
    if not tool:
        raise HTTPException(status_code=404, detail="Khong tim thay dung cu")
    conversation = session.get(Conversations, tool.id_conv) if tool.id_conv else None
    if conversation and conversation.id_profile != user.id_profile:
        raise HTTPException(status_code=403, detail="Khong co quyen cap nhat dung cu nay")

    tool.force_regenerate_model = True
    tool.model_3d_url = None
    tool.model_image_hash = None
    tool.model_generation_status = "pending"
    tool.model_job_id = None
    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()
    backgroundtask.add_task(start_3d_pipeline_task, [tool.id_tool], engine)
    return {
        "status": "queued",
        "id_tool": tool.id_tool,
        "force_regenerate_model": tool.force_regenerate_model,
        "model_generation_status": tool.model_generation_status,
    }



@router.patch("/tools/{id_tool}/soft-delete")
async def soft_delete_tool(
    id_tool: str,
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    try:
        tool_uuid = uuid.UUID(str(id_tool))
    except ValueError:
        raise HTTPException(status_code=400, detail="id_tool khong hop le")

    ensure_tools_metadata_columns(session)
    session.commit()

    tool = session.get(Tools, tool_uuid)
    if not tool:
        raise HTTPException(status_code=404, detail="Khong tim thay dung cu")

    conversation = session.get(Conversations, tool.id_conv) if tool.id_conv else None
    if conversation and conversation.id_profile != user.id_profile:
        raise HTTPException(status_code=403, detail="Khong co quyen xoa dung cu nay")

    tool.is_deleted = True
    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()
    session.refresh(tool)

    return {
        "status": "success",
        "id_tool": tool.id_tool,
        "is_deleted": tool.is_deleted,
    }


def _coerce_scale(value, field_name: str) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field_name} khong hop le")
    if not math.isfinite(numeric) or numeric <= 0 or numeric > 100:
        raise HTTPException(status_code=400, detail=f"{field_name} nam ngoai gioi han")
    return numeric


@router.patch("/tools/{id_tool}/scale")
async def update_tool_scale(
    id_tool: str,
    payload: dict,
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    try:
        tool_uuid = uuid.UUID(str(id_tool))
    except ValueError:
        raise HTTPException(status_code=400, detail="id_tool khong hop le")

    ensure_tools_metadata_columns(session)
    session.commit()

    tool = session.get(Tools, tool_uuid)
    if not tool:
        raise HTTPException(status_code=404, detail="Khong tim thay dung cu")

    conversation = session.get(Conversations, tool.id_conv) if tool.id_conv else None
    if conversation and conversation.id_profile != user.id_profile:
        raise HTTPException(status_code=403, detail="Khong co quyen cap nhat dung cu nay")

    tool.scale_x = _coerce_scale(payload.get("scale_x"), "scale_x")
    tool.scale_y = _coerce_scale(payload.get("scale_y"), "scale_y")
    tool.scale_z = _coerce_scale(payload.get("scale_z"), "scale_z")
    tool.has_custom_scale = True
    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()
    session.refresh(tool)
    return {
        "status": "success",
        "id_tool": tool.id_tool,
        "scale_x": tool.scale_x,
        "scale_y": tool.scale_y,
        "scale_z": tool.scale_z,
        "has_custom_scale": tool.has_custom_scale,
    }


def _coerce_rotation(value, field_name: str) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field_name} khong hop le")
    if not math.isfinite(numeric):
        raise HTTPException(status_code=400, detail=f"{field_name} nam ngoai gioi han")
    return numeric


def _coerce_position(value, field_name: str) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field_name} khong hop le")
    if not math.isfinite(numeric) or abs(numeric) > 1000:
        raise HTTPException(status_code=400, detail=f"{field_name} nam ngoai gioi han")
    return numeric


@router.patch("/tools/{id_tool}/position")
async def update_tool_position(
    id_tool: str,
    payload: dict,
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    try:
        tool_uuid = uuid.UUID(str(id_tool))
    except ValueError:
        raise HTTPException(status_code=400, detail="id_tool khong hop le")

    ensure_tools_metadata_columns(session)
    session.commit()

    tool = session.get(Tools, tool_uuid)
    if not tool:
        raise HTTPException(status_code=404, detail="Khong tim thay dung cu")

    conversation = session.get(Conversations, tool.id_conv) if tool.id_conv else None
    if conversation and conversation.id_profile != user.id_profile:
        raise HTTPException(status_code=403, detail="Khong co quyen cap nhat dung cu nay")

    instance_id = str(payload.get("instance_id") or "default")
    raw_positions = tool.positions or {}
    if isinstance(raw_positions, str):
        try:
            raw_positions = json.loads(raw_positions) or {}
        except json.JSONDecodeError:
            raw_positions = {}
    positions = dict(raw_positions)
    positions[instance_id] = {
        "x": _coerce_position(payload.get("position_x"), "position_x"),
        "y": _coerce_position(payload.get("position_y"), "position_y"),
        "z": _coerce_position(payload.get("position_z"), "position_z"),
    }

    tool.positions = positions
    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()
    session.refresh(tool)
    return {
        "status": "success",
        "id_tool": tool.id_tool,
        "instance_id": instance_id,
        "position": positions[instance_id],
        "positions": tool.positions,
    }


@router.patch("/tools/{id_tool}/rotation")
async def update_tool_rotation(
    id_tool: str,
    payload: dict,
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    try:
        tool_uuid = uuid.UUID(str(id_tool))
    except ValueError:
        raise HTTPException(status_code=400, detail="id_tool khong hop le")

    ensure_tools_metadata_columns(session)
    session.commit()

    tool = session.get(Tools, tool_uuid)
    if not tool:
        raise HTTPException(status_code=404, detail="Khong tim thay dung cu")

    conversation = session.get(Conversations, tool.id_conv) if tool.id_conv else None
    if conversation and conversation.id_profile != user.id_profile:
        raise HTTPException(status_code=403, detail="Khong co quyen cap nhat dung cu nay")

    tool.rotation_x = _coerce_rotation(payload.get("rotation_x", 0), "rotation_x")
    tool.rotation_y = _coerce_rotation(payload.get("rotation_y", 0), "rotation_y")
    tool.rotation_z = _coerce_rotation(payload.get("rotation_z", 0), "rotation_z")
    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()
    session.refresh(tool)
    return {
        "status": "success",
        "id_tool": tool.id_tool,
        "rotation_x": tool.rotation_x,
        "rotation_y": tool.rotation_y,
        "rotation_z": tool.rotation_z,
    }
