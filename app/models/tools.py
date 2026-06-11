from sqlmodel import SQLModel, Field
from sqlalchemy import Column, JSON
from typing import Optional
from datetime import datetime
import uuid

class Tools (SQLModel, table=True):
    __tablename__="tools"
    
    id_tool: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True, index=True)
    id_conv: Optional[uuid.UUID] = Field(default=None, foreign_key="conversions.id_conv")
    name_tool_vi: str = Field(nullable=False, index=True)
    name_tool_en: str = Field(nullable=False)
    description: Optional[str] = None
    subject_type: str = Field(index=True, nullable=False, default="general")
    material_type: Optional[str] = None
    image_2d_url: Optional[str] = None
    model_3d_url: Optional[str] = None
    image_hash: Optional[str] = None
    model_image_hash: Optional[str] = None
    model_generation_status: str = Field(default="pending")
    model_job_id: Optional[str] = None
    force_regenerate_model: bool = Field(default=False)
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
    is_support_stand: bool = Field(default=False)
    can_support_tools: bool = Field(default=False)
    support_height: float = Field(default=0.8)
    support_radius: float = Field(default=1.0)
    scale_x: float = Field(default=1)
    scale_y: float = Field(default=1)
    scale_z: float = Field(default=1)
    has_custom_scale: bool = Field(default=False)
    rotation_x: float = Field(default=0)
    rotation_y: float = Field(default=0)
    rotation_z: float = Field(default=0)
    capabilities: list = Field(default_factory=list, sa_column=Column(JSON, default=list))
    ports: dict = Field(default_factory=dict, sa_column=Column(JSON, default=dict))
    attach_points: dict = Field(default_factory=dict, sa_column=Column(JSON, default=dict))
    assembly_role: str = Field(default="none")
    is_deleted: bool = Field(default=False)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
