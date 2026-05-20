from app.models.base_db import engine
from app.models.message_mascot import MascotMessages
from app.models.messages import Messages
from app.models.conversations import Conversations
from app.schema.chat_response import ChatRequest
from app.utils.get_current_user import get_current_user
from app.models.profiles import Profiles
from app.models.conversations import Conversations
from fastapi import APIRouter, Depends
from sqlmodel import Session, select
from app.task.rag import ask_questions_with_plan
from datetime import datetime

router = APIRouter()

@router.post("/message/send")
def message_mascot_send(req: ChatRequest, user: Profiles = Depends(get_current_user)):
    with Session(engine) as session:
        id_conversation = req.id_conv
        current_subject = req.subject
        if not id_conversation:
            conv = Conversations(
                id_profile=user.id_profile,
                title=req.question[:50],
                subject_type=req.subject
            )
            session.add(conv)
            session.commit()
            session.refresh(conv)
            id_conversation = conv.id_conv

        history = []
        if req.id_conv:
            history_stmt = select(MascotMessages).where(
                MascotMessages.id_conv == id_conversation
            ).order_by(MascotMessages.created_at.desc()).limit(5)

            history_results = session.exec(history_stmt).all()
            history_results.reverse()
            history = [{"role": msg.role, "content": msg.context} for msg in history_results]

        user_msg = MascotMessages(
            id_conv=id_conversation,
            role="user",
            context=req.question
        )
        session.add(user_msg)
            
        rag_result = ask_questions_with_plan(req.question, selected_subject=current_subject, history=history)
        answer = rag_result["answer_text"]
        experiment_plan = rag_result["experiment_plan"]

        mascot_message = MascotMessages(
            id_conv=id_conversation,
            role="assistant",
            context=answer
        )
        session.add(mascot_message)

        db_conv = session.get(Conversations, id_conversation)
        if db_conv:
            db_conv.updated_at = datetime.utcnow()

        session.commit()

        return {
            "id_conversation": str(id_conversation),
            "answer": answer,
            "answer_text": answer,
            "experiment_plan": experiment_plan
        }
        
@router.get("/api/message/full_history/{id_conversation}")
def get_full_history(id_conversation: str, user: Profiles = Depends(get_current_user)):
    with Session(engine) as session:
        msg_stmt = select(Messages).where(
            Messages.id_conv == id_conversation
        ).order_by(Messages.created_at)

        msg = session.exec(msg_stmt).all()

        msg_mascot_stmt = select(MascotMessages).where(
            MascotMessages.id_conv == id_conversation
        ).order_by(MascotMessages.created_at)

        msg_mascot = session.exec(msg_mascot_stmt).all()

        return{
            "id_conversation": id_conversation,
            "chat_history": msg,
            "mascot_instructions": msg_mascot
        }

            
