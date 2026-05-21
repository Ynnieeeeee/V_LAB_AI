from langchain_huggingface import HuggingFaceEndpoint, ChatHuggingFace
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

    async def process_user_request(self, user_text: str, id_conv: uuid.UUID, subject_code: str = "general"):
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

                # luôn tạo mới bản ghi Tool cho cuộc hội thoại này
                new_tool = Tools(
                    id_conv=id_conv,
                    name_tool_vi=item.name_vi,
                    name_tool_en=item.name_en.lower(),
                    subject_type=subject_code,
                    quantity=item.quantity,
                    description=f"Dụng cụ {subject_name}: {item.name_vi}",
                    # Copy đầy đủ từ mẫu nếu có
                    image_2d_url=template_tool.image_2d_url if template_tool else None,
                    model_3d_url=template_tool.model_3d_url if template_tool else None,
                    material_color=template_tool.material_color if template_tool else "#ffffff",
                    material_type=template_tool.material_type if template_tool else None,
                    roughness=template_tool.roughness if template_tool else 0.5,
                    metalness=template_tool.metalness if template_tool else 0.0,
                    is_glass=template_tool.is_glass if template_tool else False,
                    ior=template_tool.ior if template_tool else 1.5,
                    transmission=template_tool.transmission if template_tool else 0.0,
                    tool_type=tool_meta["tool_type"],
                    is_heating_source=tool_meta["is_heating_source"],
                    heating_power=tool_meta["heating_power"],
                    max_temperature=tool_meta["max_temperature"],
                    is_toggleable=tool_meta["is_toggleable"]
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
                    "is_toggleable": new_tool.is_toggleable
                })
            
            # 2. Lưu tin nhắn Bot
            bot_content = f"Đã cập nhật {len(final_results)} dụng cụ vào phòng thí nghiệm {subject_name}."
            bot_msg = Messages(id_conv=id_conv, role="assistant", content=bot_content)
            session.add(bot_msg)

            # Commit một lần duy nhất cho toàn bộ giao dịch
            session.commit()

        return final_results
