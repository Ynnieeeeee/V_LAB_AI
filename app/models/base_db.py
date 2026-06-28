import os

from sqlmodel import SQLModel, create_engine, text, Session
from app.config import DATABASE_URL


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


engine = create_engine(
    DATABASE_URL,
    echo=_env_bool("SQL_ECHO", False),
    connect_args={
        "prepare_threshold": None,
        "connect_timeout": int(os.getenv("DB_CONNECT_TIMEOUT_SECONDS", "10")),
    },
    pool_pre_ping=True,
    pool_timeout=int(os.getenv("DB_POOL_TIMEOUT_SECONDS", "10")),
    pool_recycle=int(os.getenv("DB_POOL_RECYCLE_SECONDS", "1800")),
)

def check_db_connection():
    """Kết nối CSDL"""
    try:
        with engine.connect() as conn:
            result = conn.execute(text("SELECT 1"))
            print("Connection sucessfully: ", result.scalar())
    except Exception as e:
        print("Connection failed: ", e)

def create_db_and_tables():
    """Tạo bảng trong db"""
    SQLModel.metadata.create_all(engine)

def get_session():
    """Lấy session"""
    with Session(engine) as session:
        yield session
