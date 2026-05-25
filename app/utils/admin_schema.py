from sqlmodel import Session, text


def _sqlite_columns(session: Session, table_name: str) -> set[str]:
    rows = session.exec(text(f"PRAGMA table_info({table_name})")).all()
    return {row[1] for row in rows}


def _postgres_columns(session: Session, table_name: str) -> set[str]:
    rows = session.exec(text("""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = :table_name
    """).params(table_name=table_name)).all()
    return {row[0] for row in rows}


def _safe_exec(session: Session, statement: str) -> None:
    try:
        session.exec(text(statement))
    except Exception as exc:
        message = str(exc).lower()
        if "already exists" not in message and "duplicate column" not in message:
            raise


def ensure_admin_schema(session: Session) -> None:
    bind = session.get_bind()
    dialect = bind.dialect.name if bind else ""

    table_columns = {
        "profiles": {
            "is_deleted": ("boolean", "false", "BOOLEAN", "0"),
        },
        "documents": {
            "updated_at": ("timestamp with time zone", "now()", "DATETIME", "CURRENT_TIMESTAMP"),
            "is_deleted": ("boolean", "false", "BOOLEAN", "0"),
        },
    }

    for table_name, columns in table_columns.items():
        if dialect == "sqlite":
            existing = _sqlite_columns(session, table_name)
            for column, (_, _, sqlite_type, sqlite_default) in columns.items():
                if column in existing:
                    continue
                session.exec(text(
                    f"ALTER TABLE {table_name} ADD COLUMN {column} {sqlite_type} DEFAULT {sqlite_default}"
                ))
        elif dialect == "postgresql":
            existing = _postgres_columns(session, table_name)
            for column, (column_type, default_value, _, _) in columns.items():
                if column in existing:
                    continue
                _safe_exec(
                    session,
                    f"ALTER TABLE public.{table_name} ADD COLUMN {column} {column_type} DEFAULT {default_value}",
                )
        else:
            for column, (column_type, default_value, _, _) in columns.items():
                _safe_exec(
                    session,
                    f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS {column} {column_type} DEFAULT {default_value}",
                )
