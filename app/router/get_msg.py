from fastapi import Depends, HTTPException, APIRouter
from sqlmodel import SQLModel, select, Session
from app.models.base_db import engine
from app.models.messages import Messages
from app.models.profiles import Profiles
from app.utils.get_current_user import get_current_user

router = APIRouter()

router.get("/messages/{conversation_id}")
async def get_messages(conversation_id: str, user: Profiles = Depends(get_current_user)):
    """Lấy ds tin nhắn của 1 cuộc trò chuyện"""
    with Session(engine) as session:
        stmt = select(Messages).where(Messages.id_conv == conversation_id).order_by(Messages.created_at)
        msg = session.exec(stmt).all()

        if not msg:
            raise HTTPException(
                status_code=404,
                detail="Conversation not found"
            )
        
        return msg

