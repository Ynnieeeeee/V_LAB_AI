from fastapi import HTTPException, Depends, APIRouter, BackgroundTasks
from app.services.lab_service import LabServices
from app.models.tools import Tools
from app.models.conversations import Conversations
from app.models.profiles import Profiles
from app.models.base_db import engine, get_session
from sqlmodel import Session, select
from app.task.lab_task import start_3d_pipeline_task
from app.utils.get_current_user import get_current_user
from app.utils.tool_classifier import ensure_tools_metadata_columns

router = APIRouter(prefix="/api/lab", tags=["Laboratory"])
lab_service = LabServices()
@router.post("/generate")
async def generate_lab(
    payload: dict, 
    backgroundtask: BackgroundTasks, 
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user)
):
    user_text = payload.get("text")
    id_conv = payload.get("id_conv") 
    subject = payload.get("subject", "chemistry")

    if not user_text:
        raise HTTPException(
            status_code=400,
            detail="Thiếu thông tin mô tả"
        )
    
    # Nếu không có id_conv, tạo mới cuộc hội thoại
    if not id_conv or id_conv == "null" or id_conv == "undefined":
        new_conv = Conversations(
            id_profile=user.id_profile,
            title=user_text[:50],
            subject_type=subject
        )
        session.add(new_conv)
        session.commit()
        session.refresh(new_conv)
        id_conv = new_conv.id_conv
    
    # 1. AI trích xuất dụng cụ dựa trên ngữ cảnh môn học
    extracted_data = await lab_service.process_user_request(user_text, id_conv, subject)

    tool_ids_to_process = []
    response_data = []

    for item in extracted_data:
        # Sử dụng dụng cụ đã được LabService tạo
        response_data.append({
            "name": item["name_vi"],
            "quantity": item["quantity"],
            "ready": item["model_3d_url"] is not None,
            "tool_type": item.get("tool_type", "unknown"),
            "is_heating_source": item.get("is_heating_source", False),
            "heating_power": item.get("heating_power", 0),
            "max_temperature": item.get("max_temperature", 25),
            "is_toggleable": item.get("is_toggleable", False)
        })

        # Nếu chưa có model 3D, mới đưa vào hàng chờ Pipeline để tạo tự động
        if not item["model_3d_url"]:
            tool_ids_to_process.append(item["id_tool"])

    if tool_ids_to_process:
        backgroundtask.add_task(start_3d_pipeline_task, tool_ids_to_process, engine)

    return {
        "status": "success",
        "conversation_id": id_conv,
        "data": response_data
    }

@router.get("/status")
async def get_tool_status(id_conv: str, session: Session = Depends(get_session)):
    ensure_tools_metadata_columns(session)
    session.commit()

    # CHỈ LẤY dụng cụ của cuộc hội thoại hiện tại
    statement = select(Tools).where(
        Tools.id_conv == id_conv,
        Tools.model_3d_url != None
    )
    result = session.exec(statement).all()
    return result
