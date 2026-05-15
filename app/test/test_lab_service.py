import asyncio
import json
from app.services.lab_service import LabServices  
from app.models.base_db import engine, create_db_and_tables
from sqlmodel import SQLModel

async def test_lab_logic():
    print("Đang khởi tạo Database")
    create_db_and_tables()

    print("Đang kết nối Hugging Face (Qwen 2.5)")
    service = LabServices()

    test_queries = [
        "Tôi muốn 1 căn phòng có 1 giá đỡ, 3 ống nghiệm và 1 cốc thủy tinh",
    ]

    for query in test_queries:
        print(f"\n[Test Input]: {query}")
        print("Đang xử lý...")
        
        try:
            results = await service.process_user_request(query)
            
            if results:
                print("[Kết quả trả về]:")
                print(json.dumps(results, indent=4, ensure_ascii=False))
                
                for res in results:
                    status = "Đã có 3D" if res['model_3d_url'] else "Chờ tạo 3D (Đã lưu vào DB)"
                    print(f" -> {res['name_vi']} ({res['name_en']}): {status}")
            else:
                print("(!) Không trích xuất được dữ liệu hoặc lỗi LLM.")
                
        except Exception as e:
            print(f"(X) Lỗi trong quá trình test: {e}")

if __name__ == "__main__":
    asyncio.run(test_lab_logic())