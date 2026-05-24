from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime, timezone
from sqlalchemy import Column, String, CheckConstraint
import uuid

class Payments(SQLModel, table=True):
    __tablename__="payments"

    id_payment: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    id_profile: uuid.UUID = Field(foreign_key="profiles.id_profile")
    id_sub: uuid.UUID | None = Field(default=None, foreign_key="subscriptions.id_sub")
    id_plan: uuid.UUID = Field(foreign_key="subscription_plans.id_plan")
    amount: Optional[float] = Field(default=None)
    currency: str = Field(default="VND", sa_column=Column(String))
    method: Optional[str] = Field(default=None)
    status: str = Field(default="pending", sa_column=Column(String))
    transaction_id: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    __table_args__ = (
        CheckConstraint(
            "status in ('pending','completed','failed','refunded')",
            name="check_payment_status"
        ),
    ) 
