import time
from sqlmodel import Session, select
from app.models.base_db import engine
from app.models.tools import Tools
from app.services.mesh_service import MeshService

def check_db_before_test():
    """Kiểm tra xem trong DB đã thực sự có dữ liệu chờ xử lý chưa"""
    with Session(engine) as session:
        statement = select(Tools).where(Tools.image_2d_url != None, Tools.model_3d_url == None)
        pending = session.exec(statement).all()
        
        if not pending:
            print("\n[Thông báo] Không tìm thấy dụng cụ nào cần tạo Model 3D.")
            return []
        
        print(f"\nTìm thấy {len(pending)} dụng cụ đang chờ tạo 3D:")
        for t in pending:
            print(f" - {t.name_tool_en}: {t.image_2d_url}")
        return pending

def run_test():
    print("\n" + "="*55)
    print("Bắt đầu tạo mô hình")
    print("="*55)
    
    pending_tools = check_db_before_test()
    if not pending_tools:
        return

    service = MeshService()
    
    with Session(engine) as session:
        for index, tool in enumerate(pending_tools):
            print(f"\n[{index + 1}/{len(pending_tools)}] Xử lý: {tool.name_tool_en}")
            
            task_id = service.create_3d_task(tool.image_2d_url)
            if not task_id:
                print(f"Bỏ qua {tool.name_tool_en} do lỗi tạo Task.")
                continue

            retry_count = 0
            success = False
            while retry_count < 60:
                res = service.check_task_status(task_id)
                
                if isinstance(res, str) and res.startswith("http"):
                    print(f"Tripo Link: {res[:50]}")
                    
                    local_link = service.download_and_get_local_url(res, tool.name_tool_en)
                    if local_link:
                        db_tool = session.get(Tools, tool.id_tool)
                        db_tool.model_3d_url = local_link
                        session.add(db_tool)
                        session.commit()
                        
                        print(f"Hoàn tất: {tool.name_tool_en} -> {local_link}")
                        success = True
                    break
                
                elif "ERROR" in str(res):
                    print(f"Lỗi: {res}")
                    break
                else:
                    print(f"Trạng thái: {res}")
                    time.sleep(5)
                    retry_count += 1
            
            if not success:
                print(f"Thất bại hoặc Timeout với: {tool.name_tool_en}")

            if index < len(pending_tools) - 1:
                print("\nNghỉ 10 giây trước khi sang dụng cụ tiếp theo...")
                time.sleep(10)

    print("\n" + "="*55)
    print("Toàn bộ tiến trình đã hoàn tất")
    print("Hãy kiểm tra folder: app/static/models")
    print("="*55)

if __name__ == "__main__":
    run_test()