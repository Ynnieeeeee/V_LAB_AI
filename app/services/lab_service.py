from langchain_huggingface import HuggingFaceEndpoint, ChatHuggingFace
from fastapi import HTTPException
from langchain_core.output_parsers import PydanticOutputParser
from langchain_core.prompts import PromptTemplate
from app.config import HF_TOKEN
from app.models.tools import Tools
from app.models.conversations import Conversations
from app.models.messages import Messages
from app.schema.tool_response import LabToolList
from app.models.base_db import engine
from app.utils.tool_classifier import classify_tool_by_name, ensure_tools_metadata_columns
from sqlmodel import select, Session
import uuid
import os
import re
from pathlib import Path
from urllib.parse import urlparse


APP_DIR = Path(__file__).resolve().parents[1]
STATIC_MODEL_DIR = APP_DIR / "static" / "models"
MODEL_URL_PREFIX = "/static/models/"


def _normalize_tool_vi_name(value: str = "") -> str:
    return re.sub(r"\s+", " ", str(value or "").casefold()).strip()


def _local_static_model_exists(model_url: str = "") -> bool:
    if not model_url or not str(model_url).startswith(MODEL_URL_PREFIX):
        return True
    filename = os.path.basename(urlparse(str(model_url)).path)
    return bool(filename and (STATIC_MODEL_DIR / filename).exists())


def find_reusable_model_tool(session: Session, name_vi: str, subject_code: str) -> Tools | None:
    normalized_name = _normalize_tool_vi_name(name_vi)
    if not normalized_name:
        return None

    statement = (
        select(Tools)
        .where(
            Tools.model_3d_url != None,
            Tools.force_regenerate_model == False,
            Tools.is_deleted == False,
        )
        .order_by(Tools.created_at.desc())
    )
    buckets = ([], [], [], [])
    for candidate in session.exec(statement).all():
        if _normalize_tool_vi_name(candidate.name_tool_vi) != normalized_name:
            continue
        if not _local_static_model_exists(candidate.model_3d_url):
            continue

        same_subject = candidate.subject_type == subject_code
        is_template = candidate.id_conv is None
        if same_subject and is_template:
            buckets[0].append(candidate)
        elif same_subject:
            buckets[1].append(candidate)
        elif is_template:
            buckets[2].append(candidate)
        else:
            buckets[3].append(candidate)

    for bucket in buckets:
        if bucket:
            return bucket[0]
    return None


class LabServices:
    def __init__(self):
        self.llm_engine = HuggingFaceEndpoint(
            repo_id="Qwen/Qwen2.5-7B-Instruct",
            huggingfacehub_api_token=HF_TOKEN,
            temperature=0.1,
            max_new_tokens=512,
            task="conversational"
        )
        
        self.llm = ChatHuggingFace(llm=self.llm_engine)
        self.parser = PydanticOutputParser(pydantic_object=LabToolList)

        self.template = """
        <|system|>
        Bạn là một chuyên gia về thiết bị phòng thí nghiệm chuyên ngành {subject}.
        Nhiệm vụ: Trích xuất dụng cụ từ câu tiếng Việt, dịch tên sang tiếng Anh chuyên ngành chính xác nhất cho lĩnh vực {subject}.
        Lưu ý: Nếu tên dụng cụ có thể hiểu theo nhiều nghĩa, hãy chọn nghĩa thuộc về {subject}.
        {format_instructions}
        <|user|>
        Trích xuất dụng cụ từ câu: "{query}"
        <|assistant|>
        JSON:
        """

        self.prompt = PromptTemplate(
            template=self.template,
            input_variables=["query", "subject"],
            partial_variables={"format_instructions": self.parser.get_format_instructions()}
        )

    async def process_user_request(self, user_text: str, id_conv: uuid.UUID, subject_code: str = "general", max_quantity_per_request: int | None = None):
        subject_map = {
            "chemistry": "Hóa học",
            "physics": "Vật lý",
            "biology": "Sinh học",
            "general": "Phòng thí nghiệm chung"
        }
        subject_name = subject_map.get(subject_code, "Phòng thí nghiệm")
        chain = self.prompt | self.llm | self.parser

        final_results = []

        # Gộp tất cả vào một Session duy nhất
        with Session(engine) as session:
            ensure_tools_metadata_columns(session)
            session.commit()
            # 1. Lưu tin nhắn User
            user_msg = Messages(id_conv=id_conv, role="user", content=user_text)
            session.add(user_msg)

            try:
                extracted_data = chain.invoke({"query": user_text, "subject": subject_name})
            except Exception as e:
                print(f"Error: {e}")
                return []

            requested_quantity = sum(max(1, int(item.quantity or 1)) for item in extracted_data.tools)
            if max_quantity_per_request is not None and requested_quantity > max_quantity_per_request:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        f"Yêu cầu này cần {requested_quantity} dụng cụ, "
                        f"nhưng gói hiện tại chỉ còn {max_quantity_per_request} dụng cụ trong hôm nay."
                    )
                )

            for item in extracted_data.tools:
                tool_meta = classify_tool_by_name(item.name_vi, item.name_en)
                # tìm trong csdl: Để lấy Model 3D đã có sẵn (không lọc theo id_conv)
                # Chỉ lọc theo tên và môn học để lấy link model
                statement = select(Tools).where(
                    Tools.name_tool_en == item.name_en.lower(),
                    Tools.subject_type == subject_code,
                    Tools.id_conv == None # Giả sử các model mẫu có id_conv là Null
                ).limit(1)
                
                template_tool = session.exec(statement).first()
                if template_tool and template_tool.model_3d_url:
                    print(
                        "[LabService] Template model exists; Vietnamese-name lookup decides reuse:",
                        item.name_en,
                        template_tool.model_3d_url,
                    )

                # luôn tạo mới bản ghi Tool cho cuộc hội thoại này
                reusable_model_tool = find_reusable_model_tool(session, item.name_vi, subject_code)
                if reusable_model_tool:
                    template_tool = reusable_model_tool
                    print(
                        "[LabService] Reuse existing 3D model by Vietnamese name:",
                        item.name_vi,
                        reusable_model_tool.model_3d_url,
                    )
                has_reusable_model = reusable_model_tool is not None

                new_tool = Tools(
                    id_conv=id_conv,
                    name_tool_vi=item.name_vi,
                    name_tool_en=item.name_en.lower(),
                    subject_type=subject_code,
                    quantity=item.quantity,
                    description=f"Dụng cụ {subject_name}: {item.name_vi}",
                    # Copy đầy đủ từ mẫu nếu có
                    image_2d_url=template_tool.image_2d_url if template_tool else None,
                    image_hash=template_tool.image_hash if template_tool else None,
                    model_3d_url=reusable_model_tool.model_3d_url if has_reusable_model else None,
                    model_image_hash=(reusable_model_tool.model_image_hash or reusable_model_tool.image_hash) if has_reusable_model else None,
                    model_generation_status="completed" if has_reusable_model else "pending",
                    force_regenerate_model=False if has_reusable_model else True,
                    material_color=template_tool.material_color if template_tool else "#ffffff",
                    material_type=template_tool.material_type if template_tool else None,
                    roughness=template_tool.roughness if template_tool else 0.5,
                    metalness=template_tool.metalness if template_tool else 0.0,
                    clearcoat=template_tool.clearcoat if template_tool else 0.0,
                    is_glass=template_tool.is_glass if template_tool else False,
                    ior=template_tool.ior if template_tool else 1.5,
                    transmission=template_tool.transmission if template_tool else 0.0,
                    thickness=template_tool.thickness if template_tool else 0.0,
                    tool_type=tool_meta["tool_type"],
                    is_heating_source=tool_meta["is_heating_source"],
                    heating_power=tool_meta["heating_power"],
                    max_temperature=tool_meta["max_temperature"],
                    is_toggleable=tool_meta["is_toggleable"],
                    is_support_stand=tool_meta["is_support_stand"],
                    can_support_tools=tool_meta["can_support_tools"],
                    support_height=tool_meta["support_height"],
                    support_radius=tool_meta["support_radius"],
                    scale_x=template_tool.scale_x if template_tool and template_tool.has_custom_scale else 1,
                    scale_y=template_tool.scale_y if template_tool and template_tool.has_custom_scale else 1,
                    scale_z=template_tool.scale_z if template_tool and template_tool.has_custom_scale else 1,
                    has_custom_scale=template_tool.has_custom_scale if template_tool else False,
                    rotation_x=template_tool.rotation_x if template_tool else 0,
                    rotation_y=template_tool.rotation_y if template_tool else 0,
                    rotation_z=template_tool.rotation_z if template_tool else 0,
                    positions={},
                    capabilities=tool_meta.get("capabilities", []),
                    ports=tool_meta.get("ports", {}),
                    attach_points=tool_meta.get("attach_points", {}),
                    assembly_role=tool_meta.get("assembly_role", "none")
                )
                
                session.add(new_tool)
                # Flush để lấy ID nếu cần, nhưng chưa Commit ngay
                session.flush() 

                final_results.append({
                    "id_tool": new_tool.id_tool,
                    "name_vi": item.name_vi,
                    "name_en": item.name_en,
                    "quantity": item.quantity,
                    "model_3d_url": new_tool.model_3d_url,
                    "subject_type": subject_code,
                    "tool_type": new_tool.tool_type,
                    "is_heating_source": new_tool.is_heating_source,
                    "heating_power": new_tool.heating_power,
                    "max_temperature": new_tool.max_temperature,
                    "is_toggleable": new_tool.is_toggleable,
                    "is_support_stand": new_tool.is_support_stand,
                    "can_support_tools": new_tool.can_support_tools,
                    "support_height": new_tool.support_height,
                    "support_radius": new_tool.support_radius,
                    "scale_x": new_tool.scale_x,
                    "scale_y": new_tool.scale_y,
                    "scale_z": new_tool.scale_z,
                    "has_custom_scale": new_tool.has_custom_scale,
                    "rotation_x": new_tool.rotation_x,
                    "rotation_y": new_tool.rotation_y,
                    "rotation_z": new_tool.rotation_z,
                    "positions": new_tool.positions,
                    "capabilities": new_tool.capabilities,
                    "ports": new_tool.ports,
                    "attach_points": new_tool.attach_points,
                    "assembly_role": new_tool.assembly_role
                })
            
            # 2. Lưu tin nhắn Bot
            bot_content = f"Đã cập nhật {len(final_results)} dụng cụ vào phòng thí nghiệm {subject_name}."
            bot_msg = Messages(id_conv=id_conv, role="assistant", content=bot_content)
            session.add(bot_msg)

            # Commit một lần duy nhất cho toàn bộ giao dịch
            session.commit()

        return final_results
