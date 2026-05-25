from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from shutil import copyfileobj

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select, text

from app.models.base_db import engine, get_session
from app.models.documents import Documents
from app.models.payments import Payments
from app.models.profiles import Profiles
from app.models.subscription_plans import SubscriptionPlans
from app.models.tools import Tools
from app.utils.admin_schema import ensure_admin_schema
from app.utils.get_current_user import get_current_user
from app.utils.tool_classifier import ensure_tools_metadata_columns


router = APIRouter(prefix="/api/admin", tags=["Admin"])
DATA_PDF_DIR = Path(__file__).resolve().parents[1] / "data" / "pdf"
ALLOWED_ROLES = {"admin", "user"}
ALLOWED_SUBJECTS = {"chemistry", "physics", "biology", "general"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _require_admin(current_user: Profiles = Depends(get_current_user)) -> Profiles:
    if current_user.role != "admin" or getattr(current_user, "is_deleted", False):
        raise HTTPException(status_code=403, detail="Admin permission required")
    return current_user


def _parse_uuid(value: str, field_name: str = "id") -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field_name} khong hop le")


def _metadata(document: Documents) -> dict:
    return dict(document.doc_metadata or {})


def _subject_from_document(document: Documents) -> str:
    return str(_metadata(document).get("subject") or "general")


def _safe_filename(filename: str) -> str:
    stem = Path(filename or "document.pdf").stem
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", stem).strip("-._") or "document"
    return f"{stem}.pdf"


def _ensure_admin_tables(session: Session) -> None:
    ensure_admin_schema(session)
    ensure_tools_metadata_columns(session)
    session.commit()


def _profile_payload(profile: Profiles) -> dict:
    return {
        "id_profile": str(profile.id_profile),
        "username": profile.username,
        "email": profile.email,
        "avt_url": profile.avt_url,
        "provider": profile.provider,
        "role": profile.role,
        "created_at": profile.created_at,
        "updated_at": profile.updated_at,
        "is_deleted": profile.is_deleted,
    }


def _document_payload(document: Documents) -> dict:
    metadata = _metadata(document)
    return {
        "id_doc": str(document.id_doc),
        "title": document.title,
        "source": document.source,
        "subject": metadata.get("subject") or "general",
        "vector_status": metadata.get("vector_status") or "unknown",
        "chunk_count": metadata.get("chunk_count") or 0,
        "metadata": metadata,
        "created_at": document.created_at,
        "updated_at": document.updated_at,
        "is_deleted": document.is_deleted,
    }


def _tool_payload(tool: Tools) -> dict:
    return {
        "id_tool": str(tool.id_tool),
        "id_conv": str(tool.id_conv) if tool.id_conv else None,
        "name_tool_vi": tool.name_tool_vi,
        "name_tool_en": tool.name_tool_en,
        "subject_type": tool.subject_type,
        "tool_type": tool.tool_type,
        "quantity": tool.quantity,
        "model_generation_status": tool.model_generation_status,
        "model_3d_url": tool.model_3d_url,
        "image_2d_url": tool.image_2d_url,
        "is_deleted": tool.is_deleted,
        "created_at": tool.created_at,
        "updated_at": tool.updated_at,
    }


def _payment_payload(payment: Payments, profiles: dict[uuid.UUID, Profiles], plans: dict[uuid.UUID, SubscriptionPlans]) -> dict:
    profile = profiles.get(payment.id_profile)
    plan = plans.get(payment.id_plan)
    return {
        "id_payment": str(payment.id_payment),
        "user": profile.email or profile.username if profile else str(payment.id_profile),
        "plan": plan.plan_name if plan else str(payment.id_plan),
        "amount": payment.amount or 0,
        "currency": payment.currency,
        "method": payment.method,
        "status": payment.status,
        "transaction_id": payment.transaction_id,
        "created_at": payment.created_at,
    }


def _delete_vectors_for_source(source: str | None) -> None:
    if not source:
        return

    statements = [
        "DELETE FROM langchain_pg_embedding WHERE cmetadata ->> 'source' = :source",
        "DELETE FROM langchain_bg_embedding WHERE metadata ->> 'source' = :source",
        "DELETE FROM langchain_bg_embedding WHERE cmetadata ->> 'source' = :source",
    ]

    with Session(engine) as cleanup_session:
        for statement in statements:
            try:
                cleanup_session.exec(text(statement).params(source=source))
                cleanup_session.commit()
            except Exception:
                cleanup_session.rollback()


def _set_document_vector_status(doc_id: uuid.UUID, status: str, **metadata_updates) -> None:
    with Session(engine) as session:
        ensure_admin_schema(session)
        document = session.get(Documents, doc_id)
        if not document:
            return

        metadata = _metadata(document)
        metadata.update(metadata_updates)
        metadata["vector_status"] = status
        metadata["last_vector_status_at"] = _now().isoformat()
        document.doc_metadata = metadata
        document.updated_at = _now()
        session.add(document)
        session.commit()


def _vectorize_document(doc_id: uuid.UUID, file_path: str, subject: str) -> None:
    _set_document_vector_status(doc_id, "processing")
    try:
        _delete_vectors_for_source(file_path)

        from app.scripts.document_chunk import chunk_document
        from app.scripts.embed_document import embed_document
        from app.scripts.load_documents import load_documents

        docs = load_documents(file_path, subject_tag=subject)
        chunks = chunk_document(docs)
        chunk_count = embed_document(chunks) if chunks else 0

        _set_document_vector_status(
            doc_id,
            "completed",
            chunk_count=chunk_count,
            last_vectorized_at=_now().isoformat(),
        )
    except Exception as exc:
        _set_document_vector_status(
            doc_id,
            "failed",
            vector_error=str(exc)[:500],
        )


@router.get("/overview")
def get_overview(
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)

    users = session.exec(select(Profiles).where(Profiles.is_deleted == False)).all()
    documents = session.exec(select(Documents).where(Documents.is_deleted == False)).all()
    tools = session.exec(select(Tools)).all()
    payments = session.exec(select(Payments).order_by(Payments.created_at.desc())).all()

    completed_payments = [payment for payment in payments if payment.status == "completed"]
    revenue_total = sum(float(payment.amount or 0) for payment in completed_payments)
    pending_total = sum(float(payment.amount or 0) for payment in payments if payment.status == "pending")

    revenue_by_month: dict[str, float] = {}
    for payment in completed_payments:
        month = payment.created_at.strftime("%Y-%m") if payment.created_at else "unknown"
        revenue_by_month[month] = revenue_by_month.get(month, 0) + float(payment.amount or 0)

    payment_statuses: dict[str, int] = {}
    for payment in payments:
        payment_statuses[payment.status] = payment_statuses.get(payment.status, 0) + 1

    return {
        "totals": {
            "users": len(users),
            "documents": len(documents),
            "tools": len([tool for tool in tools if not tool.is_deleted]),
            "deleted_tools": len([tool for tool in tools if tool.is_deleted]),
            "revenue": revenue_total,
            "pending_revenue": pending_total,
        },
        "revenue_by_month": [
            {"month": month, "amount": amount}
            for month, amount in sorted(revenue_by_month.items())[-8:]
        ],
        "payment_statuses": payment_statuses,
    }


@router.get("/users")
def list_users(
    q: str | None = None,
    include_deleted: bool = False,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    users = session.exec(select(Profiles).order_by(Profiles.created_at.desc())).all()
    normalized_q = (q or "").strip().lower()

    result = []
    for profile in users:
        if profile.is_deleted and not include_deleted:
            continue
        haystack = " ".join([
            profile.username or "",
            profile.email or "",
            profile.role or "",
            profile.provider or "",
        ]).lower()
        if normalized_q and normalized_q not in haystack:
            continue
        result.append(_profile_payload(profile))

    return result


@router.post("/users")
def create_user(
    payload: dict,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    role = str(payload.get("role") or "user").strip().lower()
    if role not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail="Role khong hop le")

    email = (payload.get("email") or "").strip()
    if email:
        existing = session.exec(select(Profiles).where(Profiles.email == email)).first()
        if existing and not existing.is_deleted:
            raise HTTPException(status_code=409, detail="Email da ton tai")

    profile = Profiles(
        username=(payload.get("username") or "").strip() or None,
        email=email or None,
        avt_url=(payload.get("avt_url") or "").strip() or None,
        provider=(payload.get("provider") or "local").strip() or "local",
        role=role,
        created_at=_now(),
        updated_at=_now(),
        is_deleted=False,
    )
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return _profile_payload(profile)


@router.put("/users/{user_id}")
def update_user(
    user_id: str,
    payload: dict,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    profile = session.get(Profiles, _parse_uuid(user_id, "user_id"))
    if not profile:
        raise HTTPException(status_code=404, detail="Khong tim thay nguoi dung")

    role = payload.get("role")
    if role is not None:
        role = str(role).strip().lower()
        if role not in ALLOWED_ROLES:
            raise HTTPException(status_code=400, detail="Role khong hop le")
        profile.role = role

    for field in ("username", "email", "avt_url", "provider"):
        if field in payload:
            value = payload.get(field)
            setattr(profile, field, str(value).strip() if value else None)

    if "is_deleted" in payload:
        profile.is_deleted = bool(payload.get("is_deleted"))

    profile.updated_at = _now()
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return _profile_payload(profile)


@router.delete("/users/{user_id}")
def delete_user(
    user_id: str,
    session: Session = Depends(get_session),
    current_user: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    user_uuid = _parse_uuid(user_id, "user_id")
    if user_uuid == current_user.id_profile:
        raise HTTPException(status_code=400, detail="Khong the xoa chinh tai khoan admin dang dung")

    profile = session.get(Profiles, user_uuid)
    if not profile:
        raise HTTPException(status_code=404, detail="Khong tim thay nguoi dung")

    profile.is_deleted = True
    profile.updated_at = _now()
    session.add(profile)
    session.commit()
    return {"status": "success", "id_profile": str(profile.id_profile), "is_deleted": profile.is_deleted}


@router.get("/documents")
def list_documents(
    q: str | None = None,
    subject: str | None = None,
    include_deleted: bool = False,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    documents = session.exec(select(Documents).order_by(Documents.created_at.desc())).all()
    normalized_q = (q or "").strip().lower()
    normalized_subject = (subject or "").strip().lower()

    result = []
    for document in documents:
        if document.is_deleted and not include_deleted:
            continue
        metadata = _metadata(document)
        doc_subject = str(metadata.get("subject") or "general").lower()
        haystack = " ".join([document.title or "", document.source or "", doc_subject]).lower()
        if normalized_q and normalized_q not in haystack:
            continue
        if normalized_subject and normalized_subject != "all" and doc_subject != normalized_subject:
            continue
        result.append(_document_payload(document))

    return result


@router.post("/documents")
def upload_document(
    background_tasks: BackgroundTasks,
    title: str | None = Form(default=None),
    subject: str = Form(default="general"),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    current_user: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    normalized_subject = subject.strip().lower() if subject else "general"
    if normalized_subject not in ALLOWED_SUBJECTS:
        raise HTTPException(status_code=400, detail="Mon hoc khong hop le")
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Chi ho tro file PDF")

    target_dir = DATA_PDF_DIR / normalized_subject
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_filename(file.filename)
    target_path = target_dir / f"{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{safe_name}"

    with target_path.open("wb") as output:
        copyfileobj(file.file, output)

    document = Documents(
        title=(title or Path(file.filename).stem).strip(),
        source=str(target_path),
        doc_metadata={
            "subject": normalized_subject,
            "original_filename": file.filename,
            "uploaded_by": str(current_user.id_profile),
            "vector_status": "queued",
            "chunk_count": 0,
        },
        created_at=_now(),
        updated_at=_now(),
        is_deleted=False,
    )
    session.add(document)
    session.commit()
    session.refresh(document)

    background_tasks.add_task(
        _vectorize_document,
        document.id_doc,
        str(target_path),
        normalized_subject,
    )

    return _document_payload(document)


@router.put("/documents/{doc_id}")
def update_document(
    doc_id: str,
    payload: dict,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    document = session.get(Documents, _parse_uuid(doc_id, "doc_id"))
    if not document:
        raise HTTPException(status_code=404, detail="Khong tim thay tai lieu")

    metadata = _metadata(document)
    if "title" in payload:
        document.title = (payload.get("title") or "").strip() or document.title
    if "subject" in payload:
        subject = str(payload.get("subject") or "general").strip().lower()
        if subject not in ALLOWED_SUBJECTS:
            raise HTTPException(status_code=400, detail="Mon hoc khong hop le")
        metadata["subject"] = subject
    if "is_deleted" in payload:
        document.is_deleted = bool(payload.get("is_deleted"))

    document.doc_metadata = metadata
    document.updated_at = _now()
    session.add(document)
    session.commit()
    session.refresh(document)

    if bool(payload.get("reindex")):
        background_tasks.add_task(
            _vectorize_document,
            document.id_doc,
            document.source,
            _subject_from_document(document),
        )

    return _document_payload(document)


@router.post("/documents/{doc_id}/vectorize")
def revectorize_document(
    doc_id: str,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    document = session.get(Documents, _parse_uuid(doc_id, "doc_id"))
    if not document or document.is_deleted:
        raise HTTPException(status_code=404, detail="Khong tim thay tai lieu")
    if not document.source:
        raise HTTPException(status_code=400, detail="Tai lieu chua co source")

    metadata = _metadata(document)
    metadata["vector_status"] = "queued"
    document.doc_metadata = metadata
    document.updated_at = _now()
    session.add(document)
    session.commit()

    background_tasks.add_task(
        _vectorize_document,
        document.id_doc,
        document.source,
        _subject_from_document(document),
    )
    return {"status": "queued", "id_doc": str(document.id_doc)}


@router.delete("/documents/{doc_id}")
def delete_document(
    doc_id: str,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    document = session.get(Documents, _parse_uuid(doc_id, "doc_id"))
    if not document:
        raise HTTPException(status_code=404, detail="Khong tim thay tai lieu")

    document.is_deleted = True
    metadata = _metadata(document)
    metadata["vector_status"] = "deleted"
    document.doc_metadata = metadata
    document.updated_at = _now()
    session.add(document)
    session.commit()
    _delete_vectors_for_source(document.source)
    return {"status": "success", "id_doc": str(document.id_doc), "is_deleted": document.is_deleted}


@router.get("/tools")
def list_tools(
    q: str | None = None,
    subject: str | None = None,
    include_deleted: bool = True,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    tools = session.exec(select(Tools).order_by(Tools.created_at.desc())).all()
    normalized_q = (q or "").strip().lower()
    normalized_subject = (subject or "").strip().lower()

    result = []
    for tool in tools:
        if tool.is_deleted and not include_deleted:
            continue
        haystack = " ".join([
            tool.name_tool_vi or "",
            tool.name_tool_en or "",
            tool.subject_type or "",
            tool.tool_type or "",
            tool.model_generation_status or "",
        ]).lower()
        if normalized_q and normalized_q not in haystack:
            continue
        if normalized_subject and normalized_subject != "all" and tool.subject_type != normalized_subject:
            continue
        result.append(_tool_payload(tool))

    return result


@router.put("/tools/{tool_id}")
def update_tool(
    tool_id: str,
    payload: dict,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    tool = session.get(Tools, _parse_uuid(tool_id, "tool_id"))
    if not tool:
        raise HTTPException(status_code=404, detail="Khong tim thay dung cu")

    for field in ("name_tool_vi", "name_tool_en", "subject_type", "tool_type", "model_generation_status"):
        if field in payload:
            value = payload.get(field)
            setattr(tool, field, str(value).strip() if value is not None else getattr(tool, field))

    if "quantity" in payload:
        try:
            quantity = int(payload.get("quantity"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="So luong khong hop le")
        tool.quantity = max(0, quantity)

    if "is_deleted" in payload:
        tool.is_deleted = bool(payload.get("is_deleted"))

    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()
    session.refresh(tool)
    return _tool_payload(tool)


@router.patch("/tools/{tool_id}/soft-delete")
def admin_soft_delete_tool(
    tool_id: str,
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    tool = session.get(Tools, _parse_uuid(tool_id, "tool_id"))
    if not tool:
        raise HTTPException(status_code=404, detail="Khong tim thay dung cu")

    tool.is_deleted = True
    tool.updated_at = datetime.utcnow()
    session.add(tool)
    session.commit()
    return {"status": "success", "id_tool": str(tool.id_tool), "is_deleted": tool.is_deleted}


@router.get("/revenue")
def list_revenue(
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    payments = session.exec(select(Payments).order_by(Payments.created_at.desc())).all()
    profiles = {profile.id_profile: profile for profile in session.exec(select(Profiles)).all()}
    plans = {plan.id_plan: plan for plan in session.exec(select(SubscriptionPlans)).all()}
    return [_payment_payload(payment, profiles, plans) for payment in payments]


@router.get("/reports/revenue.csv")
def export_revenue_report(
    session: Session = Depends(get_session),
    _: Profiles = Depends(_require_admin),
):
    _ensure_admin_tables(session)
    payments = session.exec(select(Payments).order_by(Payments.created_at.desc())).all()
    profiles = {profile.id_profile: profile for profile in session.exec(select(Profiles)).all()}
    plans = {plan.id_plan: plan for plan in session.exec(select(SubscriptionPlans)).all()}

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "payment_id",
        "user",
        "plan",
        "amount",
        "currency",
        "method",
        "status",
        "transaction_id",
        "created_at",
    ])

    for payment in payments:
        row = _payment_payload(payment, profiles, plans)
        writer.writerow([
            row["id_payment"],
            row["user"],
            row["plan"],
            row["amount"],
            row["currency"],
            row["method"],
            row["status"],
            row["transaction_id"],
            row["created_at"],
        ])

    output.seek(0)
    headers = {"Content-Disposition": "attachment; filename=revenue-report.csv"}
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers=headers)
