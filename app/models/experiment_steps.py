from sqlmodel import SQLModel, Field
import uuid

class ExpermentSteps(SQLModel, table=True):
    __tablename__="experiment_steps"

    id_step: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    id_conv: uuid.UUID = Field(foreign_key="conversions.id_conv")
    id_chemical: uuid.UUID = Field(foreign_key="chemicals.id_chemical")
    id_tool: uuid.UUID = Field(foreign_key="tools.id_tool")
    action_description: str
    is_completed: bool = Field(default=False)