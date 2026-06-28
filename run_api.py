import uvicorn
import os
from dotenv import load_dotenv


load_dotenv()

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=os.getenv("UVICORN_RELOAD", "false").strip().lower() in {"1", "true", "yes", "on"},
        proxy_headers=True
    )
