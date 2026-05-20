from langchain_huggingface import ChatHuggingFace, HuggingFaceEndpoint, HuggingFaceEmbeddings
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage, AIMessage
from langchain_postgres import PGVector
from langchain.agents import create_agent
from app.config import DATABASE_URL, HF_TOKEN
import re
import unicodedata
        
#Khởi tạo llm
# Tăng temperature lên 0.7 và repetition_penalty lên 1.25 để tránh lặp từ vô hạn
llm = HuggingFaceEndpoint(
    repo_id="Qwen/Qwen2.5-7B-Instruct",
    task="text-generation",
    temperature=0.7,
    max_new_tokens=1024,
    repetition_penalty=1.25,
    huggingfacehub_api_token=HF_TOKEN,
    stop_sequences=["<|endoftext|>", "<|im_end|>", "User:", "Assistant:"]
)

#bọc endpoint thành mô hình chat
model = ChatHuggingFace(llm=llm)
#tạo vector embedding cho truy vấn
embeddings = HuggingFaceEmbeddings(model_name="intfloat/multilingual-e5-base")

connection = DATABASE_URL

vector_store = PGVector(
    embeddings=embeddings,
    connection=connection,
    collection_name="data_chunks"
)

@tool
def retrieved_context(query: str, subject: str):
    """Tìm kiếm thông tin thông tin thí nghiệm, dụng cụ và quy trình trong tài liệu"""
    search_filter = {"subject": subject}
    retrieved_docs = vector_store.similarity_search(
        f"query: {query}",
        k=6,
        filter=search_filter
    )
    serialized = "\n\n".join(
        (f"Nguồn: {doc.metadata.get('source')} (Trang {doc.metadata.get('page')})\n"
         f"Nội dung: {doc.page_content}")
        for doc in retrieved_docs
    )
    return serialized

tools = [retrieved_context]

prompt = """
Bạn là Trợ lý Phòng thí nghiệm Ảo (Virtual Lab AI) hỗ trợ các môn Hóa học, Vật lý, Sinh học.

NHIỆM VỤ:
1. Luôn sử dụng tool `retrieved_context` với đúng `subject` được cung cấp trong ngữ cảnh.
2. Nếu người dùng yêu cầu làm thí nghiệm, bạn BẮT BUỘC phải trích xuất:
   - Thí nghiệm: [Tên thí nghiệm]
   - Dụng cụ & Hóa chất: (Liệt kê chi tiết)
   - Quy trình thực hiện: (Các bước đánh số 1, 2, 3...)
3. Chỉ trả lời dựa trên nội dung tài liệu. Nếu không tìm thấy, hãy nói: "Phòng lab hiện chưa có dữ liệu về thí nghiệm này cho môn [subject]."

QUY TẮC:
- Trả lời bằng tiếng Việt chuyên môn.
- Tuyệt đối không tự bịa các bước thí nghiệm nếu tài liệu không nhắc tới.
"""
agent = create_agent(model, tools, system_prompt=prompt)

def clean_repeating_text(text: str) -> str:
    """
    Hậu xử lý nâng cao giúp phát hiện và cắt bỏ các cụm lặp vô hạn (inline loops)
    cũng như các dòng trùng lặp liên tiếp do lỗi suy luận (degeneration) của LLM.
    """
    if not text:
        return text
        
    # 1. Quét tìm và xử lý các cụm lặp vô hạn trên cùng một dòng (inline loops)
    lines = text.split('\n')
    cleaned_lines = []
    for line in lines:
        line_stripped = line.strip()
        if not line_stripped:
            cleaned_lines.append("")
            continue
            
        n = len(line_stripped)
        best_len = 0
        best_pos = -1
        
        # Tìm các chuỗi lặp có độ dài từ 10 đến 300 ký tự
        for length in range(10, min(300, n // 3)):
            for start in range(n - 3 * length):
                chunk = line_stripped[start:start+length]
                # Kiểm tra xem chunk có lặp lại liên tiếp ít nhất 3 lần không
                if (line_stripped[start+length:start+2*length] == chunk and 
                    line_stripped[start+2*length:start+3*length] == chunk):
                    best_len = length
                    best_pos = start
                    break
            if best_len > 0:
                break
                
        if best_len > 0:
            # Tìm thấy chuỗi lặp! Giữ lại phần trước lặp và lần lặp đầu tiên, cắt bỏ phần lặp thừa
            truncated = line_stripped[:best_pos+best_len].rstrip(",. ") + "..."
            # Khôi phục khoảng trắng thụt lề ban đầu của dòng
            indent = line[:len(line) - len(line.lstrip())]
            cleaned_lines.append(indent + truncated)
        else:
            cleaned_lines.append(line)
            
    # 2. Loại bỏ các dòng lặp lại liên tiếp hoặc dòng quá trùng lặp (duplicate lines)
    seen = set()
    unique_lines = []
    for line in cleaned_lines:
        line_stripped = line.strip()
        if not line_stripped:
            unique_lines.append("")
            continue
        
        # Nếu dòng dài hơn 15 ký tự và đã xuất hiện trước đó, bỏ qua để tránh lặp dòng
        if len(line_stripped) > 15:
            if line_stripped in seen:
                continue
            seen.add(line_stripped)
            
        unique_lines.append(line)
        
    return '\n'.join(unique_lines)

def _normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFD", str(value or "").lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", text.replace("đ", "d")).strip()

def _fail_messages() -> dict:
    return {
        "wrong_chemical": "Bạn đã dùng sai hóa chất.",
        "missing_chemical": "Bạn chưa lấy đủ hóa chất cần thiết.",
        "wrong_amount": "Khối lượng hoặc thể tích chưa đúng.",
        "wrong_order": "Bạn đã thực hiện sai thứ tự thao tác.",
        "wrong_temperature": "Điều kiện nhiệt độ chưa phù hợp."
    }

def _chem(name_vi: str, name_en: str, amount: float, unit: str, tolerance: float, role: str = "reactant") -> dict:
    return {
        "name_vi": name_vi,
        "name_en": name_en,
        "amount": amount,
        "unit": unit,
        "tolerance": tolerance,
        "role": role
    }

def _step(step: int, chemical: str, amount: float, unit: str, action: str = "add_chemical") -> dict:
    return {
        "step": step,
        "action": action,
        "chemical": chemical,
        "amount": amount,
        "unit": unit
    }

def _plan(
    experiment_id: str,
    title: str,
    chemicals: list,
    steps: list,
    success_reaction_id: str,
    success_message: str,
    temperature_min=None,
    temperature_max=None,
    heating_required: bool = False,
    order_required: bool = True
) -> dict:
    return {
        "experiment_id": experiment_id,
        "title": title,
        "required_chemicals": chemicals,
        "required_conditions": {
            "temperature_min": temperature_min,
            "temperature_max": temperature_max,
            "heating_required": heating_required,
            "order_required": order_required,
            "steps": steps
        },
        "success_reaction_id": success_reaction_id,
        "success_message": success_message,
        "fail_messages": _fail_messages()
    }

def build_experiment_plan(question: str, answer_text: str, selected_subject: str = "Chemistry"):
    """
    Tao JSON plan cho frontend kiem tra thao tac 3D.
    RAG van sinh cau tra loi tu nhien; lop nay chuan hoa cac thi nghiem hoa hoc
    pho bien sang luong mac dinh an toan cho mo phong neu tai lieu khong neu ro.
    """
    haystack = _normalize_text(f"{question}\n{answer_text}")
    subject = _normalize_text(selected_subject)
    if subject and "chem" not in subject and "hoa" not in subject and "general" not in subject:
        return None

    experiment_words = [
        "thi nghiem", "thuc hien", "dieu che", "phan ung", "trang bac",
        "este", "hidro", "hydro", "ket tua", "dun nong"
    ]
    if not any(word in haystack for word in experiment_words):
        return None

    if ("natri" in haystack or re.search(r"\bna\b", haystack)) and ("hcl" in haystack or "axit clohidric" in haystack or "axit loang" in haystack):
        return _plan(
            "prepare_h2_from_na_hcl",
            "Điều chế khí hidro từ natri và axit clohidric",
            [
                _chem("Axit Clohidric", "hydrochloric acid", 20, "ml", 2),
                _chem("Natri", "sodium", 0.5, "g", 0.05)
            ],
            [
                _step(1, "Axit Clohidric", 20, "ml"),
                _step(2, "Natri", 0.5, "g")
            ],
            "sodium_acid_first",
            "Thí nghiệm thành công: Natri phản ứng với axit tạo khí hidro."
        )

    if ("natri" in haystack or re.search(r"\bna\b", haystack)) and ("nuoc" in haystack or "h2o" in haystack):
        return _plan(
            "prepare_h2_from_na_water",
            "Natri phản ứng với nước tạo khí hidro",
            [
                _chem("Nước", "water", 20, "ml", 2),
                _chem("Natri", "sodium", 0.5, "g", 0.05)
            ],
            [
                _step(1, "Nước", 20, "ml"),
                _step(2, "Natri", 0.5, "g")
            ],
            "sodium_water_after_acid_depleted",
            "Thí nghiệm thành công: Natri phản ứng với nước tạo khí hidro."
        )

    if ("cuso4" in haystack or "dong" in haystack) and ("nh3" in haystack or "amoniac" in haystack):
        nh3_amount = 20 if ("du" in haystack or "xanh tham" in haystack or "phuc" in haystack) else 5
        return _plan(
            "copper_sulfate_ammonia",
            "Đồng(II) sunfat tác dụng với amoniac",
            [
                _chem("Đồng(II) Sunfat", "copper(II) sulfate", 10, "ml", 1),
                _chem("Amoniac", "ammonia", nh3_amount, "ml", 2)
            ],
            [
                _step(1, "Đồng(II) Sunfat", 10, "ml"),
                _step(2, "Amoniac", nh3_amount, "ml")
            ],
            "cu_so4_nh3_limited",
            "Thí nghiệm thành công: CuSO4 phản ứng với NH3 tạo kết tủa hoặc phức xanh thẫm tùy lượng NH3."
        )

    if ("trang bac" in haystack or "tollens" in haystack or ("agno3" in haystack and "gluco" in haystack)):
        return _plan(
            "silver_mirror_tollens_glucose",
            "Phản ứng tráng bạc của glucozơ",
            [
                _chem("Bạc Nitrat", "silver nitrate", 5, "ml", 0.5),
                _chem("Amoniac", "ammonia", 10, "ml", 1),
                _chem("Glucozơ", "glucose", 5, "ml", 0.5)
            ],
            [
                _step(1, "Bạc Nitrat", 5, "ml"),
                _step(2, "Amoniac", 10, "ml"),
                _step(3, "Glucozơ", 5, "ml"),
                {"step": 4, "action": "heat", "temperature_min": 45}
            ],
            "silver_mirror_from_tollens_glucose_heat",
            "Thí nghiệm thành công: Glucozơ khử phức bạc amoniac tạo lớp bạc bám trong ống nghiệm.",
            temperature_min=45,
            heating_required=True
        )

    if "este" in haystack or ("axit axetic" in haystack and ("ancol etylic" in haystack or "ethanol" in haystack)):
        return _plan(
            "ethyl_acetate_esterification",
            "Este hóa axit axetic với ancol etylic",
            [
                _chem("Axit Axetic", "acetic acid", 5, "ml", 0.5),
                _chem("Ancol Etylic", "ethanol", 5, "ml", 0.5),
                _chem("Axit Sunfuric", "sulfuric acid", 2, "ml", 0.3, "catalyst")
            ],
            [
                _step(1, "Axit Axetic", 5, "ml"),
                _step(2, "Ancol Etylic", 5, "ml"),
                _step(3, "Axit Sunfuric", 2, "ml"),
                {"step": 4, "action": "heat", "temperature_min": 80}
            ],
            "esterification_acetic_ethanol",
            "Thí nghiệm thành công: tạo ethyl acetate và dung dịch tách thành hai lớp.",
            temperature_min=80,
            heating_required=True
        )

    if ("kmno4" in haystack or "pemanganat" in haystack) and ("hcl" in haystack or "axit clohidric" in haystack):
        return _plan(
            "kmno4_conc_hcl_chlorine",
            "Kali pemanganat tác dụng với axit clohidric tạo khí clo",
            [
                _chem("Kali Pemanganat", "potassium permanganate", 5, "ml", 0.5),
                _chem("Axit Clohidric", "hydrochloric acid", 10, "ml", 1)
            ],
            [
                _step(1, "Kali Pemanganat", 5, "ml"),
                _step(2, "Axit Clohidric", 10, "ml")
            ],
            "kmno4_hcl_chlorine",
            "Thí nghiệm thành công: KMnO4 oxi hóa HCl tạo khí clo màu vàng lục."
        )

    if ("mno2" in haystack or "mangan dioxit" in haystack) and ("hcl" in haystack or "axit clohidric" in haystack):
        return _plan(
            "mno2_hcl_heat_chlorine",
            "Mangan đioxit tác dụng với axit clohidric khi đun nóng",
            [
                _chem("Mangan Đioxit", "manganese dioxide", 0.5, "g", 0.05),
                _chem("Axit Clohidric", "hydrochloric acid", 10, "ml", 1)
            ],
            [
                _step(1, "Mangan Đioxit", 0.5, "g"),
                _step(2, "Axit Clohidric", 10, "ml"),
                {"step": 3, "action": "heat", "temperature_min": 45}
            ],
            "mno2_hcl_heat_chlorine",
            "Thí nghiệm thành công: MnO2 phản ứng với HCl khi đun nóng tạo khí clo.",
            temperature_min=45,
            heating_required=True
        )

    return None

def ask_questions(question: str, selected_subject: str, history: list = None):
    """Trả lời câu hỏi"""
    input_messages = []
    
    if history:
        for msg in history:
            # Xử lý cả dạng dict và dạng tuple/list nếu có
            if isinstance(msg, dict):
                role = msg.get("role")
                content = msg.get("content") or msg.get("context")
            else:
                role, content = msg
                
            if role == "user":
                input_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                input_messages.append(AIMessage(content=content))
    
    # 2. Chuẩn hóa subject để khớp với metadata
    subject = (selected_subject or "general").lower()
    
    context_aware_query = f"[Môn học: {subject}] {question}"
    input_messages.append(HumanMessage(content=context_aware_query))

    # 3. Thực hiện gọi Agent
    try:
        response = agent.invoke({"messages": input_messages})
        answer = response["messages"][-1].content
        
        # Áp dụng bộ lọc dọn dẹp các đoạn text lặp vô hạn
        answer = clean_repeating_text(answer)
                
        return answer
    except Exception as e:
        print(f"Error in ask_questions: {e}")
        return "Xin lỗi, mình gặp chút trục trặc khi xử lý câu hỏi. Bạn thử lại nhé!"

def ask_questions_with_plan(question: str, selected_subject: str, history: list = None):
    answer = ask_questions(question, selected_subject=selected_subject, history=history)
    return {
        "answer_text": answer,
        "experiment_plan": build_experiment_plan(question, answer, selected_subject)
    }


