from langchain_huggingface import ChatHuggingFace, HuggingFaceEndpoint, HuggingFaceEmbeddings
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage, AIMessage
from langchain_postgres import PGVector
from langchain.agents import create_agent
from app.config import DATABASE_URL, HF_TOKEN

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


