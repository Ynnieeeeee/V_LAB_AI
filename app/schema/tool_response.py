from typing import Optional
from pydantic import BaseModel

class ToolResponse(BaseModel):
    name_vi: str
    name_en: str
    quantity: int
    model_3d_url: Optional[str] = None

class LabToolList(BaseModel):
    tools: list[ToolResponse]