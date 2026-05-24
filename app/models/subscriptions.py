from datetime import datetime
from typing import Optional
import uuid

from sqlmodel import Field, SQLModel


class Subscriptions(SQLModel, table=True):
    __tablename__ = "subscriptions"

    id_sub: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    id_profile: uuid.UUID = Field(foreign_key="profiles.id_profile", index=True)
    id_plan: uuid.UUID = Field(foreign_key="subscription_plans.id_plan", index=True)
    start_date: Optional[datetime] = Field(default=None)
    end_date: Optional[datetime] = Field(default=None)
    is_active: Optional[bool] = Field(default=True, index=True)
