from fastapi import Request, APIRouter, Depends, HTTPException
from sqlmodel import SQLModel, Session, select
from app.utils.get_current_user import get_current_user
from app.models.profiles import Profiles
from app.models.conversations import Conversations
from app.models.base_db import engine
import uuid
from datetime import datetime, timezone

router = APIRouter()

@router.get("/chat/conversation")
async def get_conversation(user: Profiles = Depends(get_current_user)):
    """Lấy ds tất cả các cuộc hội thoại"""
    with Session(engine) as session:
        stmt = select(Conversations).where(
            Conversations.id_profile == user.id_profile,
            Conversations.is_deleted == False
            ).order_by(Conversations.updated_at.desc())
        conversations = session.exec(stmt).all()

        return[
            {
                "id": c.id_conv,
                "title": c.title,
                "subject": c.subject_type,
                "updated_at": c.updated_at
            }
            for c in conversations
        ]

@router.get("/chat/conversation/search")
async def search_conversation(q: str, user: Profiles = Depends(get_current_user)):
    """Tìm kiếm lịch sử"""
    with Session(engine) as session:
        stmt = select(Conversations).where(
            Conversations.id_profile == user.id_profile,
            Conversations.is_deleted == False,
            Conversations.title.ilike(f"%{q}%")
        ).order_by(Conversations.updated_at.desc())

        result = session.exec(stmt).all()

        return[
            {
                "id": c.id_conv,
                "title": c.title,
                "subject": c.subject_type,
                "updated_at": c.updated_at
            }
            for c in result
        ]
    
@router.put("/chat/conversation/{conversation_id}")
async def rename_conversation(conversation_id: uuid.UUID, data: dict, user: Profiles = Depends(get_current_user)):
    """Đổi tên cuộc hội thoại"""
    with Session(engine) as session:
        conversation = session.get(Conversations, conversation_id)
        if not conversation or conversation.id_profile != user.id_profile:
            raise HTTPException(
                status_code=404,
                detail="Conversation not found"
            )
        
        new_title = data.get("title")
        if not new_title:
            raise HTTPException(
                status_code=400,
                detail="Tiêu đề không được để trống"
            )
        
        conversation.title = new_title
        conversation.updated_at = datetime.now(timezone.utc)

        session.add(conversation)
        session.commit()
        session.refresh(conversation)

        return{
            "id": conversation.id_conv,
            "title": conversation.title,
            "message": "Cập nhật thành công"
        }

@router.delete("/chat/conversation/{conversation_id}")
async def delete_conversation(conversation_id: uuid.UUID, user: Profiles = Depends(get_current_user)):
    """Xóa ảo cuộc hội thoại"""
    with Session(engine) as session:
        conversation = session.get(Conversations, conversation_id)
        if not conversation or conversation.id_profile != user.id_profile:
            raise HTTPException(
                status_code=404,
                detail="Không tìm thấy cuộc hội thoại hoặc bạn không có quyền xóa"
            )
        
        conversation.is_deleted = True
        conversation.updated_at = datetime.now(timezone.utc)
        session.add(conversation)
        session.commit()

        return{
            "message": "Đã xóa cuộc hội thoại thành công",
            "id": conversation_id
        }