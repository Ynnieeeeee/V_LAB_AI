from sqlmodel import SQLModel, create_engine, text, Session
from app.config import DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    echo=True,
    connect_args={"prepare_threshold": None},
    pool_pre_ping=True
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
