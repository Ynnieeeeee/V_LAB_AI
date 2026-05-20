from fastapi import FastAPI, Request, HTTPException
from contextlib import asynccontextmanager
from starlette.middleware.sessions import SessionMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
import uuid

from app.models.base_db import check_db_connection, create_db_and_tables
from app.router.lab_router import router as lab_router
from app.router.google_login import router as google_login
from app.router.get_msg import router as get_msg
from app.router.message_router import router as message_router
from app.router.conversation_router import router as conversation_router
from app.router.message_mascot_router import router as mascot_router
from app.router.chemical_router import router as chemical_router
from app.router.reaction_rule_router import router as reaction_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Start application...")
    check_db_connection()
    create_db_and_tables()
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

templates = Jinja2Templates(directory="app/src")
app.add_middleware(SessionMiddleware, secret_key="super-secret-key")

app.mount("/static", StaticFiles(directory="app/static"), name="static")

app.mount("/assets", StaticFiles(directory="app/src/assets"), name="assets")

app.include_router(lab_router)
app.include_router(google_login)
app.include_router(get_msg)
app.include_router(message_router)
app.include_router(conversation_router)
app.include_router(mascot_router)
app.include_router(chemical_router)
app.include_router(reaction_router)     

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

@app.get("/{conversation_id}", response_class=HTMLResponse)
async def legacy_conversation_page(request: Request, conversation_id: str):
    try:
        uuid.UUID(conversation_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Not found")
    return templates.TemplateResponse("index.html", {"request": request})
