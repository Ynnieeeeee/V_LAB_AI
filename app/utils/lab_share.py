from __future__ import annotations

from datetime import datetime, timezone
import secrets
import uuid

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import jwt
from sqlmodel import Session, select, text

from app.config import ALGORITHM, PUBLIC_BASE_URL, SECRET_KEY
from app.models.base_db import engine
from app.models.conversations import Conversations
from app.models.profiles import Profiles
from app.models.tools import Tools
from app.utils.public_urls import select_public_base_url


SHARE_TOKEN_HEADER = "X-Lab-Share-Token"
optional_security = HTTPBearer(auto_error=False)


def _sqlite_columns(session: Session, table_name: str) -> set[str]:
    rows = session.exec(text(f"PRAGMA table_info({table_name})")).all()
    return {row[1] for row in rows}


def _postgres_columns(session: Session, table_name: str) -> set[str]:
    rows = session.exec(
        text(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = :table_name
            """
        ).params(table_name=table_name)
    ).all()
    return {row[0] for row in rows}


def _safe_exec(session: Session, statement: str) -> None:
    try:
        session.exec(text(statement))
    except Exception as exc:
        message = str(exc).lower()
        ignored = ("already exists", "duplicate column", "duplicate key")
        if not any(item in message for item in ignored):
            raise


def ensure_lab_share_schema(session: Session) -> None:
    bind = session.get_bind()
    dialect = bind.dialect.name if bind else ""
    table_name = "conversions"

    columns = {
        "share_token": ("varchar", None, "TEXT", None),
        "is_shared": ("boolean", "false", "BOOLEAN", "0"),
        "share_created_at": ("timestamp with time zone", None, "DATETIME", None),
    }

    if dialect == "sqlite":
        existing = _sqlite_columns(session, table_name)
        for column, (_, _, sqlite_type, sqlite_default) in columns.items():
            if column in existing:
                continue
            default_sql = f" DEFAULT {sqlite_default}" if sqlite_default is not None else ""
            session.exec(text(f"ALTER TABLE {table_name} ADD COLUMN {column} {sqlite_type}{default_sql}"))
        session.exec(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversions_share_token "
                "ON conversions (share_token) WHERE share_token IS NOT NULL"
            )
        )
        return

    if dialect == "postgresql":
        existing = _postgres_columns(session, table_name)
        for column, (column_type, default_value, _, _) in columns.items():
            if column in existing:
                continue
            default_sql = f" DEFAULT {default_value}" if default_value is not None else ""
            _safe_exec(
                session,
                f"ALTER TABLE public.{table_name} ADD COLUMN {column} {column_type}{default_sql}",
            )
        _safe_exec(
            session,
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversions_share_token "
            "ON public.conversions (share_token) WHERE share_token IS NOT NULL",
        )
        return

    for column, (column_type, default_value, _, _) in columns.items():
        default_sql = f" DEFAULT {default_value}" if default_value is not None else ""
        _safe_exec(
            session,
            f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS {column} {column_type}{default_sql}",
        )


def get_optional_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_security),
) -> Profiles | None:
    if not credentials:
        return None

    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        profile_id = uuid.UUID(str(payload.get("sub")))
    except Exception:
        return None

    with Session(engine) as session:
        return session.exec(select(Profiles).where(Profiles.id_profile == profile_id)).first()


def get_request_share_token(request: Request) -> str | None:
    token = request.headers.get(SHARE_TOKEN_HEADER)
    if token:
        return token.strip()
    for key in ("share_token", "share"):
        token = request.query_params.get(key)
        if token:
            return token.strip()
    return None


def build_share_url(request: Request, token: str) -> str:
    base_url = select_public_base_url(PUBLIC_BASE_URL, str(request.base_url))
    return f"{base_url}/share/lab/{token}"


def ensure_share_token(session: Session, conversation: Conversations) -> str:
    ensure_lab_share_schema(session)
    if conversation.share_token:
        conversation.is_shared = True
        conversation.share_created_at = conversation.share_created_at or datetime.now(timezone.utc)
        session.add(conversation)
        return conversation.share_token

    for _ in range(5):
        token = secrets.token_urlsafe(24)
        existing = session.exec(
            select(Conversations).where(Conversations.share_token == token)
        ).first()
        if existing:
            continue
        conversation.share_token = token
        conversation.is_shared = True
        conversation.share_created_at = datetime.now(timezone.utc)
        session.add(conversation)
        return token

    raise HTTPException(status_code=500, detail="Could not create share token")


def get_shared_conversation(session: Session, token: str | None) -> Conversations | None:
    if not token or not token.replace("-", "").replace("_", "").isalnum():
        return None
    if not 24 <= len(token) <= 128:
        return None
    return session.exec(
        select(Conversations).where(
            Conversations.share_token == token,
            Conversations.is_shared == True,
            Conversations.is_deleted == False,
        )
    ).first()


def parse_conversation_uuid(value) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="id_conv khong hop le")


def require_lab_conversation_access(
    session: Session,
    conversation_id,
    request: Request,
    user: Profiles | None = None,
) -> Conversations:
    conv_uuid = parse_conversation_uuid(conversation_id)
    conversation = session.get(Conversations, conv_uuid)
    if not conversation or conversation.is_deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")

    if conversation.id_profile == user.id_profile:
        return conversation

    token = get_request_share_token(request)
    if token and conversation.is_shared and conversation.share_token == token:
        return conversation

    raise HTTPException(status_code=404, detail="Conversation not found")


def require_lab_tool_access(
    session: Session,
    tool: Tools | None,
    request: Request,
    user: Profiles | None = None,
) -> Conversations:
    if not tool or tool.is_deleted:
        raise HTTPException(status_code=404, detail="Khong tim thay dung cu")
    if not tool.id_conv:
        raise HTTPException(status_code=403, detail="Khong co quyen cap nhat dung cu nay")
    return require_lab_conversation_access(session, tool.id_conv, request, user)


def require_authenticated_or_shared_lab(
    session: Session,
    request: Request,
    user: Profiles | None = None,
) -> None:
    if user:
        return
    raise HTTPException(status_code=401, detail="Authentication required")
