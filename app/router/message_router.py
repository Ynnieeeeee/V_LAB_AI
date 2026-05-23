from fastapi import APIRouter, HTTPException, Depends
from sqlmodel import select, Session
from app.models.base_db import engine
from app.models.profiles import Profiles
from app.models.conversations import Conversations
from app.models.messages import Messages
from app.models.tools import Tools
from app.schema.chat_response import ChatRequest
from app.utils.get_current_user import get_current_user
from app.services.lab_service import LabServices
import uuid

router = APIRouter()

@router.post("/chat/send")
async def send_messages(req: ChatRequest, user: Profiles = Depends(get_current_user)):
    """gửi tin nhắn đến hệ thống"""
    with Session(engine) as session:
        if not req.id_conv:
            db_conv = Conversations(
                id_profile=user.id_profile,
                title=req.question[:50],
                subject_type=req.subject
            )
            session.add(db_conv)
            session.commit()
            conv_id = db_conv.id_conv
            current_subject = req.subject

        else:
            db_conv = session.get(Conversations, req.id_conv)
            conv_id = db_conv.id_conv
            current_subject = db_conv.subject_type

        lab_service = LabServices()
        tool_result = await lab_service.process_user_request(
            user_text=req.question,
            id_conv=conv_id,
            subject_code=current_subject
        )
        return{
            "conversation_id": conv_id,
            "tools": tool_result,
            "answer": f"Hệ thống {current_subject} đã sẵn sàng"
        }
    
@router.get("/api/chat/{conversation_id}")
async def get_messages(conversation_id: uuid.UUID, user: Profiles = Depends(get_current_user)):
    """Lấy toàn bộ dữ liệu của 1 cuộc hội thoại"""
    with Session(engine) as session:
        conversation = session.get(Conversations, conversation_id)
        if not conversation or conversation.id_profile != user.id_profile:
            raise HTTPException(
                status_code=404,
                detail="Conversation not found"
            )
        
        msg_stmt = select(Messages).where(Messages.id_conv == conversation_id).order_by(Messages.created_at.asc())
        messages = session.exec(msg_stmt).all()

        tool_stmt = select(Tools).where(Tools.id_conv == conversation_id, Tools.is_deleted == False)
        tools = session.exec(tool_stmt).all()

        return{
            "subject_type": conversation.subject_type,
            "title": conversation.title,
            "messeges": messages,
            "tools": tools
        }

        
        