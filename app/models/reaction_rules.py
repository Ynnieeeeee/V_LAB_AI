from sqlmodel import SQLModel, Field
from typing import Optional
import uuid
from datetime import datetime, timezone

class ReactionRules(SQLModel, table=True):
    __tablename__="reaction_rules"

    id_rule: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    source_type: str
    target_type: str
    result_color: str
    gas_effect: Optional[bool] = Field(default=False)
    reaction_message: str
    formula_gas: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))