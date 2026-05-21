from sqlmodel import SQLModel, Field
from typing import Optional
import uuid

class ExpermentSteps(SQLModel, table=True):
    __tablename__="experiment_steps"

    id_step: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    id_conv: Optional[uuid.UUID] = Field(default=None, foreign_key="conversions.id_conv")
    step_order: int = Field(default=0)
    id_chemical: Optional[uuid.UUID] = Field(default=None, foreign_key="chemicals.id_chemical")
    id_tool: Optional[uuid.UUID] = Field(default=None, foreign_key="tools.id_tool")
    chemical_name_vi: Optional[str] = None
    canonical_id: Optional[str] = None
    action_type: str = Field(default="pour")
    target_amount: Optional[float] = None
    unit: Optional[str] = None
    tolerance: Optional[float] = None
    actual_amount: float = Field(default=0)
    auto_stop: bool = Field(default=True)
    heating_required: bool = Field(default=False)
    target_temperature: Optional[float] = None
    is_failed: bool = Field(default=False)
    experiment_id: Optional[str] = None
    reaction_id: Optional[str] = None
    action_description: Optional[str] = None
    is_completed: bool = Field(default=False)
