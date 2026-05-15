from sqlmodel import SQLModel, Field
from datetime import datetime, timezone
import uuid

class MascotMessages(SQLModel, table=True):
    __tablename__="message_mascot"

    id_msg_mascot: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    id_conv: uuid.UUID = Field(foreign_key="conversions.id_conv")
    role: str
    context: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))