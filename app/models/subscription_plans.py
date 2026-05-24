from datetime import datetime
from typing import Optional
import uuid

from sqlmodel import Field, SQLModel


class SubscriptionPlans(SQLModel, table=True):
    __tablename__ = "subscription_plans"

    id_plan: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plan_name: Optional[str] = Field(default=None, index=True)
    tool_limit_per_day: int = Field(default=0)
    mascot_limit_per_day: int = Field(default=0)
    duration_days: Optional[int] = Field(default=30)
    price: Optional[float] = Field(default=0)
    created_at: datetime = Field(default_factory=datetime.utcnow)
