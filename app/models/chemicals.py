from sqlmodel import SQLModel, Field
from typing import Optional
import uuid

class Chemicals(SQLModel, table=True):
    __tablename__="chemicals"

    id_chemical: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    id_tool: uuid.UUID = Field(foreign_key="tools.id_tool")
    name_vi: str
    formula: str
    modecular_weight: float
    physical_state: str
    material_color: str
    transmission: float
    roughness: float
    safery_info: str
    description: str
    is_in_cabinet: bool = Field(default=True)
    shelf_number: int
    image_url: str
    chemical_type: str = Field(default="generic_solution")