from sqlmodel import SQLModel, Field
from typing import Optional
import uuid
from datetime import datetime, timezone

class Profiles(SQLModel, table=True):
    __tablename__="profiles"

    id_profile: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    username: Optional[str] = None
    avt_url: Optional[str] = None
    email: Optional[str] = None
    provider: Optional[str] = 'local'
    role: Optional[str] = Field(default="user")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    is_deleted: bool = Field(default=False)
