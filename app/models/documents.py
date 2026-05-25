from sqlmodel import SQLModel, Field
from typing import Optional
import uuid
from datetime import datetime, timezone
from sqlalchemy import Column
from sqlalchemy.dialects.postgresql import JSONB 

class Documents(SQLModel, table=True):
    __tablename__="documents"

    id_doc: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    title: Optional[str] = None
    source: Optional[str] = None
    doc_metadata: dict | None = Field(default=None, sa_column=Column("doc_metadata", JSONB))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    is_deleted: bool = Field(default=False)
