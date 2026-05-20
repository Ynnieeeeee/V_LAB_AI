from app.models.base_db import engine
from app.models.message_mascot import MascotMessages
from app.models.messages import Messages
from app.models.conversations import Conversations
from app.schema.chat_response import ChatRequest
from app.utils.get_current_user import get_current_user
from app.models.profiles import Profiles
from app.models.conversations import Conversations
from app.models.chemicals import Chemicals
from app.models.tools import Tools
from app.models.experiment_steps import ExpermentSteps
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select, delete, text
from app.task.rag import ask_questions_with_plan
from datetime import datetime
import unicodedata
import uuid
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

def _norm(value: str) -> str:
    text_value = unicodedata.normalize("NFD", str(value or "").lower())
    text_value = "".join(ch for ch in text_value if unicodedata.category(ch) != "Mn")
    return " ".join(text_value.replace("đ", "d").replace("Ä‘", "d").split())

def _step_to_dict(step: ExpermentSteps) -> dict:
    return {
        "id_step": str(step.id_step),
        "id_conv": str(step.id_conv) if step.id_conv else None,
        "step_order": step.step_order,
        "id_chemical": str(step.id_chemical) if step.id_chemical else None,
        "id_tool": str(step.id_tool) if step.id_tool else None,
        "chemical_name_vi": step.chemical_name_vi,
        "action_type": step.action_type,
        "target_amount": float(step.target_amount) if step.target_amount is not None else None,
        "unit": step.unit,
        "tolerance": float(step.tolerance) if step.tolerance is not None else None,
        "actual_amount": float(step.actual_amount or 0),
        "auto_stop": step.auto_stop,
        "heating_required": step.heating_required,
        "target_temperature": float(step.target_temperature) if step.target_temperature is not None else None,
        "is_completed": step.is_completed,
        "is_failed": step.is_failed,
        "action_description": step.action_description
    }

def _ensure_experiment_steps_columns(session: Session):
    statements = [
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS step_order INTEGER DEFAULT 0",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS chemical_name_vi VARCHAR",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS action_type VARCHAR DEFAULT 'pour'",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS target_amount DOUBLE PRECISION",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS unit VARCHAR",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS tolerance DOUBLE PRECISION",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS actual_amount DOUBLE PRECISION DEFAULT 0",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS auto_stop BOOLEAN DEFAULT TRUE",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS heating_required BOOLEAN DEFAULT FALSE",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS target_temperature DOUBLE PRECISION",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS is_failed BOOLEAN DEFAULT FALSE",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS experiment_id VARCHAR",
        "ALTER TABLE experiment_steps ADD COLUMN IF NOT EXISTS reaction_id VARCHAR"
    ]
    for statement in statements:
        session.exec(text(statement))

def _as_uuid(value):
    if not value:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None

def _resolve_chemical(session: Session, name_vi: str):
    if not name_vi:
        return None
    wanted = _norm(name_vi)
    chemicals = session.exec(select(Chemicals)).all()
    for chemical in chemicals:
        names = [chemical.name_vi, chemical.formula, chemical.chemical_type]
        if wanted in {_norm(name) for name in names}:
            return chemical
    for chemical in chemicals:
        if wanted and wanted in _norm(chemical.name_vi):
            return chemical
    return None

def _resolve_tool(session: Session, id_tool=None, chemical=None, id_conv=None):
    parsed_id = _as_uuid(id_tool)
    if parsed_id:
        tool = session.get(Tools, parsed_id)
        if tool:
            return tool
    if chemical and chemical.id_tool:
        tool = session.get(Tools, chemical.id_tool)
        if tool:
            return tool
    if id_conv:
        conv_tool = session.exec(select(Tools).where(Tools.id_conv == id_conv)).first()
        if conv_tool:
            return conv_tool
    return session.exec(select(Tools)).first()

def _persist_experiment_plan_steps(session: Session, id_conversation, experiment_plan: dict):
    if not experiment_plan:
        logger.info("No experiment_plan for conversation %s; skip experiment_steps insert", id_conversation)
        return None

    logger.info("Persisting experiment_plan for conversation %s: %s", id_conversation, experiment_plan)

    try:
        _ensure_experiment_steps_columns(session)
        session.exec(delete(ExpermentSteps).where(ExpermentSteps.id_conv == id_conversation))

        last_chemical = None
        last_tool = None
        inserted_steps = []
        for step in experiment_plan.get("steps", []):
            chemical = _resolve_chemical(session, step.get("chemical_name_vi")) or last_chemical
            tool = _resolve_tool(session, step.get("id_tool"), chemical, id_conversation) or last_tool

            if chemical:
                last_chemical = chemical
                step["id_chemical"] = str(chemical.id_chemical)
            if tool:
                last_tool = tool
                step["id_tool"] = str(tool.id_tool)

            db_step = ExpermentSteps(
                id_conv=id_conversation,
                step_order=int(step.get("step_order") or 0),
                id_chemical=chemical.id_chemical if chemical else None,
                id_tool=tool.id_tool if tool else None,
                chemical_name_vi=step.get("chemical_name_vi"),
                action_type=step.get("action_type") or "pour",
                target_amount=step.get("target_amount"),
                unit=step.get("unit"),
                tolerance=step.get("tolerance") if step.get("tolerance") is not None else 0.1,
                actual_amount=0,
                auto_stop=bool(step.get("auto_stop", True)),
                heating_required=bool(step.get("heating_required", False)),
                target_temperature=step.get("target_temperature"),
                is_completed=False,
                is_failed=False,
                experiment_id=experiment_plan.get("experiment_id"),
                reaction_id=experiment_plan.get("reaction_id"),
                action_description=step.get("action_description") or ""
            )
            session.add(db_step)
            inserted_steps.append(db_step)

        session.flush()
        experiment_plan["steps"] = [_step_to_dict(step) for step in inserted_steps]
        experiment_plan["required_conditions"]["steps"] = [
            {
                "step": step["step_order"],
                "action": "heat" if step["action_type"] == "heat" else "add_chemical",
                "chemical": step["chemical_name_vi"],
                "amount": step["target_amount"],
                "unit": step["unit"],
                "temperature_min": step["target_temperature"]
            }
            for step in experiment_plan["steps"]
        ]
        logger.info("Inserted %s experiment_steps for conversation %s", len(inserted_steps), id_conversation)
    except Exception:
        logger.exception("Failed to persist experiment_steps for conversation %s. Plan=%s", id_conversation, experiment_plan)
        raise

    return experiment_plan

@router.post("/message/send")
def message_mascot_send(req: ChatRequest, user: Profiles = Depends(get_current_user)):
    with Session(engine) as session:
        current_subject = req.subject
        id_conversation = _as_uuid(req.id_conv)
        existing_conv = session.get(Conversations, id_conversation) if id_conversation else None
        if (
            not existing_conv or
            existing_conv.id_profile != user.id_profile or
            existing_conv.is_deleted
        ):
            conv = Conversations(
                id_profile=user.id_profile,
                title=req.question[:50],
                subject_type=req.subject
            )
            session.add(conv)
            session.commit()
            session.refresh(conv)
            id_conversation = conv.id_conv
            existing_conv = None
        else:
            id_conversation = existing_conv.id_conv
            current_subject = existing_conv.subject_type or req.subject

        history = []
        if existing_conv:
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
        experiment_plan = _persist_experiment_plan_steps(session, id_conversation, experiment_plan)

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

@router.get("/api/experiment-steps/{id_conversation}")
def get_experiment_steps(id_conversation: str, user: Profiles = Depends(get_current_user)):
    with Session(engine) as session:
        conv_id = _as_uuid(id_conversation)
        conversation = session.get(Conversations, conv_id) if conv_id else None
        if not conversation or conversation.id_profile != user.id_profile or conversation.is_deleted:
            raise HTTPException(status_code=404, detail="Conversation not found")

        _ensure_experiment_steps_columns(session)
        steps = session.exec(
            select(ExpermentSteps)
            .where(ExpermentSteps.id_conv == conv_id)
            .order_by(ExpermentSteps.step_order)
        ).all()
        logger.info("Fetched %s experiment_steps for conversation %s", len(steps), conv_id)
        return {
            "id_conversation": str(conv_id),
            "steps": [_step_to_dict(step) for step in steps]
        }

@router.patch("/api/experiment-steps/{id_step}")
def update_experiment_step(id_step: str, payload: dict, user: Profiles = Depends(get_current_user)):
    with Session(engine) as session:
        step_id = _as_uuid(id_step)
        step = session.get(ExpermentSteps, step_id) if step_id else None
        if not step:
            raise HTTPException(status_code=404, detail="Experiment step not found")

        conversation = session.get(Conversations, step.id_conv)
        if not conversation or conversation.id_profile != user.id_profile or conversation.is_deleted:
            raise HTTPException(status_code=404, detail="Conversation not found")

        if "actual_amount" in payload:
            step.actual_amount = float(payload.get("actual_amount") or 0)
        if "is_completed" in payload:
            step.is_completed = bool(payload.get("is_completed"))
        elif step.target_amount is not None and step.actual_amount is not None:
            step.is_completed = float(step.actual_amount) >= float(step.target_amount)
        if "is_failed" in payload:
            step.is_failed = bool(payload.get("is_failed"))

        session.add(step)
        session.commit()
        session.refresh(step)
        logger.info(
            "Updated experiment_step %s: actual_amount=%s target_amount=%s completed=%s",
            step.id_step,
            step.actual_amount,
            step.target_amount,
            step.is_completed
        )
        return _step_to_dict(step)
        
@router.get("/api/message/full_history/{id_conversation}")
def get_full_history(id_conversation: str, user: Profiles = Depends(get_current_user)):
    with Session(engine) as session:
        conv_id = _as_uuid(id_conversation)
        conversation = session.get(Conversations, conv_id) if conv_id else None
        if not conversation or conversation.id_profile != user.id_profile or conversation.is_deleted:
            raise HTTPException(status_code=404, detail="Conversation not found")

        msg_stmt = select(Messages).where(
            Messages.id_conv == conv_id
        ).order_by(Messages.created_at)

        msg = session.exec(msg_stmt).all()

        msg_mascot_stmt = select(MascotMessages).where(
            MascotMessages.id_conv == conv_id
        ).order_by(MascotMessages.created_at)

        msg_mascot = session.exec(msg_mascot_stmt).all()

        return{
            "id_conversation": str(conv_id),
            "chat_history": msg,
            "mascot_instructions": msg_mascot
        }

            
