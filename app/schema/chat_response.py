from pydantic import BaseModel
from typing import Optional

class ChatRequest(BaseModel):
    id_conv: Optional[str] = None
    question: str
    subject: Optional[str] = 'general'