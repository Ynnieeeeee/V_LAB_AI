from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from app.router.payment_router import router as payment_router


BASE_DIR = Path(__file__).resolve().parent
ASSETS_DIR = BASE_DIR / "src" / "assets"

app = FastAPI(title="Payment API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
app.include_router(payment_router)


@app.get("/")
async def payment_home(request: Request):
    host = request.url.hostname or "127.0.0.1"
    return RedirectResponse(f"{request.url.scheme}://{host}:8000/")
