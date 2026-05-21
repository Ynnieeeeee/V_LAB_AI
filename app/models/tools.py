from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime
import uuid

class Tools (SQLModel, table=True):
    __tablename__="tools"
    
    id_tool: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True, index=True)
    id_conv: uuid.UUID = Field(foreign_key="conversions.id_conv")
    name_tool_vi: str = Field(nullable=False, index=True)
    name_tool_en: str = Field(nullable=False)
    description: Optional[str] = None
    subject_type: str = Field(index=True, nullable=False, default="general")
    material_type: Optional[str] = None
    image_2d_url: Optional[str] = None
    model_3d_url: Optional[str] = None
    material_color: Optional[str] = None
    roughness: Optional[float] = Field(default=0.5) 
    metalness: Optional[float] = Field(default=0.0) 
    clearcoat: Optional[float] = Field(default=0.0)
    ior: Optional[float] = Field(default=1.5)
    transmission: Optional[float] = Field(default=0.0)
    thickness: Optional[float] = Field(default=0.0)
    is_glass: bool = Field(default=False)
    quantity: int = Field(default=1)
    tool_type: str = Field(default="unknown")
    is_heating_source: bool = Field(default=False)
    heating_power: float = Field(default=0)
    max_temperature: float = Field(default=25)
    is_toggleable: bool = Field(default=False)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
