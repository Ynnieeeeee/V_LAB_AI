from sqlmodel import SQLModel, Field
from typing import Optional
import uuid
from datetime import datetime, timezone

class Conversations(SQLModel, table=True):
    __tablename__="conversions"

    id_conv: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    id_profile: uuid.UUID = Field(foreign_key="profiles.id_profile")
    subject_type: str = Field(default="general")
    title: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    is_deleted: bool = False