from fastapi import FastAPI, Request, HTTPException
from contextlib import asynccontextmanager
from starlette.middleware.sessions import SessionMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from pathlib import Path
import uuid
from app.models.base_db import check_db_connection, create_db_and_tables, engine
from sqlmodel import Session
from app.utils.tool_classifier import ensure_tools_metadata_columns
from app.router.lab_router import router as lab_router
from app.router.google_login import router as google_login
from app.router.get_msg import router as get_msg
from app.router.message_router import router as message_router
from app.router.conversation_router import router as conversation_router
from app.router.chemical_router import router as chemical_router
from app.router.reaction_rule_router import router as reaction_router
from app.router.subscription_router import router as subscription_router
from app.router.payment_router import router as payment_router
from app.router.admin_router import router as admin_router
from app.utils.admin_schema import ensure_admin_schema
from app.utils.subscription_utils import ensure_default_subscription_plans
from app.utils.lab_layout_schema import ensure_lab_layout_schema

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Start application...")
    check_db_connection()
    create_db_and_tables()
    try:
        with Session(engine) as session:
            ensure_admin_schema(session)
            ensure_default_subscription_plans(session)
            ensure_lab_layout_schema(session)
            session.commit()
    except Exception as exc:
        print(f"Admin schema migration failed: {exc}")
    try:
        with Session(engine) as session:
            ensure_tools_metadata_columns(session, backfill_existing=True)
            session.commit()
    except Exception as exc:
        print(f"Tool metadata migration failed: {exc}")
    yield
    print("Shutdown application...")

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  
    allow_credentials=True,
    allow_methods=["*"],  
    allow_headers=["*"], 
)

BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "src"
ASSETS_DIR = TEMPLATE_DIR / "assets"
STATIC_DIR = BASE_DIR / "static"

templates = Jinja2Templates(directory=str(TEMPLATE_DIR))
app.add_middleware(
    SessionMiddleware,
    secret_key="super-secret-key",
    same_site="lax",
    https_only=False
)

# Mount bằng đường dẫn tuyệt đối để tránh lỗi 500/TemplateNotFound khi chạy uvicorn
# từ thư mục khác. Chỉ mount /static nếu thư mục thật sự tồn tại.
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

app.include_router(lab_router)
app.include_router(google_login)
app.include_router(get_msg)
app.include_router(message_router)
app.include_router(conversation_router)
app.include_router(chemical_router)
app.include_router(reaction_router)   
app.include_router(subscription_router) 
app.include_router(payment_router) 
app.include_router(admin_router)

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/chat", response_class=HTMLResponse)
async def chat_home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/chat/{conversation_id}", response_class=HTMLResponse)
async def chat_conversation_page(request: Request, conversation_id: str):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})

@app.get("/subscription", response_class=HTMLResponse)
@app.get("/subscription.html", response_class=HTMLResponse)
async def subscription_page(request: Request):
    return FileResponse(TEMPLATE_DIR / "subscription.html", media_type="text/html")

@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard_page(request: Request):
    return FileResponse(TEMPLATE_DIR / "dashboard.html", media_type="text/html")

@app.get("/{conversation_id}", response_class=HTMLResponse)
async def legacy_conversation_page(request: Request, conversation_id: str):
    try:
        uuid.UUID(conversation_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Not found")
    return templates.TemplateResponse("index.html", {"request": request})
