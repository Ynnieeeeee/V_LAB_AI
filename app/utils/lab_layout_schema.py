import logging

from sqlmodel import Session, text


logger = logging.getLogger(__name__)


def _sqlite_columns(session: Session, table_name: str) -> set[str]:
    rows = session.exec(text(f"PRAGMA table_info({table_name})")).all()
    return {row[1] for row in rows}


def _postgres_columns(session: Session, table_name: str) -> set[str]:
    rows = session.exec(text("""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = :table_name
    """).bindparams(table_name=table_name)).all()
    columns = set()
    for row in rows:
        try:
            columns.add(str(row[0]))
        except Exception:
            columns.add(str(row))
    return columns


def _safe_exec(session: Session, statement: str) -> None:
    try:
        session.exec(text(statement))
    except Exception as exc:
        logger.warning("[LabLayoutSchema] schema update skipped/failed: %s | %s", statement, exc)
        try:
            session.rollback()
        except Exception:
            pass


def ensure_lab_layout_schema(session: Session) -> None:
    bind = session.get_bind()
    dialect = bind.dialect.name if bind else ""

    if dialect == "sqlite":
        existing = _sqlite_columns(session, "conversions")
        if "lab_layout" not in existing:
            session.exec(text("ALTER TABLE conversions ADD COLUMN lab_layout TEXT DEFAULT '{}'"))
    elif dialect == "postgresql":
        existing = _postgres_columns(session, "conversions")
        if "lab_layout" not in existing:
            _safe_exec(
                session,
                "ALTER TABLE public.conversions ADD COLUMN lab_layout jsonb DEFAULT '{}'::jsonb",
            )
    else:
        _safe_exec(
            session,
            "ALTER TABLE conversions ADD COLUMN IF NOT EXISTS lab_layout json DEFAULT '{}'",
        )
