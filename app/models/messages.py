from sqlmodel import SQLModel, Field
from typing import Optional
import uuid
from datetime import datetime, timezone

class Messages(SQLModel, table=True):
    __tablename__="messages"

    id_msg: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    id_conv: uuid.UUID = Field(foreign_key="conversions.id_conv")
    role: Optional[str]
    content: Optional[str]
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))