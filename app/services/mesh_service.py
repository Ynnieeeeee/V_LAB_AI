import requests
import time
import os
from sqlmodel import select, Session
from app.models.base_db import engine
from app.config import TRIPO_API_KEY
from app.models.tools import Tools
from app.services.vision_service import VisionService
from app.utils.tool_classifier import ensure_tools_metadata_columns

class MeshService:
    def __init__(self):
        self.headers = {
            "Authorization": f"Bearer {TRIPO_API_KEY}",
            "Content-Type": "application/json"
        }
        self.base_url = "https://api.tripo3d.ai/v2/openapi"
        self.model_dir = os.path.join("app", "static", "models")
        if not os.path.exists(self.model_dir):
            os.makedirs(self.model_dir, exist_ok=True)

    def create_3d_task(self, image_url):
        """Tạo task image-to-3d"""
        payload = {
            "type": "image_to_model",
            "model_version": "P1-20260311", 
            "file": {
                "type": "jpg", 
                "url": image_url
            },
            "face_limit": 5000,
            "texture": True,
            "pbr": True
        }
        try:
            response = requests.post(f"{self.base_url}/task", headers=self.headers, json=payload)
            result = response.json()
            if result.get("code") == 0:
                return result.get("data", {}).get("task_id")
            print(f"API Error: {result.get('message')}")
            return None
        except Exception as e:
            print(f"Lỗi kết nối khi tạo Task: {e}")
            return None
        
    def check_task_status(self, task_id):
        """Kiểm tra trạng thái và lấy link GLB từ cấu trúc result.pbr_model"""
        try:
            response = requests.get(f"{self.base_url}/task/{task_id}", headers=self.headers)
            result = response.json()
            
            if result.get("code") == 0:
                data = result.get("data", {})
                status = data.get("status")
                progress = data.get("progress", 0)
                output = data.get("output", {})
                res_dict = data.get("result", {})

                if isinstance(res_dict, dict) and "pbr_model" in res_dict:
                    model_url = res_dict["pbr_model"].get("url")
                    if model_url: return model_url

                if isinstance(output, dict):
                    if output.get("pbr_model") and isinstance(output["pbr_model"], str):
                        return output["pbr_model"]
                    
                    model_files = output.get("model_files", [])
                    for f in model_files:
                        if isinstance(f, dict) and f.get("url"):
                            return f.get("url")

                if status == "success":
                    return "ERROR_SUCCESS_BUT_LINK_HIDDEN"

                if status in ["queued", "running"]:
                    return f"{status} ({progress}%)"

                return f"ERROR_{status.upper()}"
            
            return f"ERROR_API_{result.get('code')}"
        except Exception as e:
            return f"ERROR_CONNECTION: {str(e)}"

    def download_and_get_local_url(self, model_url, tool_name_en):
        """Tải file và trả về đường dẫn tương đối để lưu DB"""
        try:
            safe_name = tool_name_en.lower().replace(' ', '_')
            filename = f"{safe_name}_{int(time.time())}.glb"
            file_path = os.path.join(self.model_dir, filename)
            
            resp = requests.get(model_url, stream=True, timeout=60)
            if resp.status_code == 200:
                with open(file_path, 'wb') as f:
                    for chunk in resp.iter_content(chunk_size=8192):
                        f.write(chunk)
                
                if os.path.exists(file_path):
                    print(f"File saved at: {file_path}")
                    # Trả về path tương đối cho Web
                    return f"/static/models/{filename}"
        except Exception as e:
            print(f"Lỗi tải file: {e}")
        return None

def run_3d_pipeline(engine):
    service = MeshService()
    vision = VisionService()
    
    with Session(engine) as session:
        ensure_tools_metadata_columns(session)
        session.commit()
        statement = select(Tools).where(Tools.image_2d_url != None, Tools.model_3d_url == None)
        pending_tools = session.exec(statement).all()

        if not pending_tools:
            print("\n[Hệ thống] Tất cả dụng cụ đã có Model 3D. Không có gì để làm.")
            return

        print(f"\nTìm thấy {len(pending_tools)} dụng cụ cần tạo model. Bắt đầu tiến trình")

        for tool in pending_tools:
            print(f"\nĐang xử lý: {tool.name_tool_en}")

            pbr_data = vision.analyze_material(tool.image_2d_url)

            if pbr_data:
                tool.material_color = pbr_data.get('material_color', '#ffffff')
                tool.roughness = pbr_data.get('roughness', 0.5)
                tool.metalness = pbr_data.get('metalness', 0.0)
                tool.is_glass = pbr_data.get('is_glass', False)
                tool.clearcoat = pbr_data.get('clearcoat', 1.0)
                tool.ior = pbr_data.get('ior', 1.52)

                session.add(tool)
                session.commit()
                print(f"Đã cập nhật thuộc tính vật liệu cho {tool.name_tool_en}")

            task_id = service.create_3d_task(tool.image_2d_url)
            
            if not task_id:
                print(f"Bỏ qua {tool.name_tool_en} do lỗi tạo Task.")
                continue

            success = False
            retry_count = 0
            while retry_count < 60:
                res = service.check_task_status(task_id)
                
                if isinstance(res, str) and res.startswith("http"):
                    print(f"Link thành công: {res[:60]}...")
                    local_link = service.download_and_get_local_url(res, tool.name_tool_en)
                    
                    if local_link:
                        tool.model_3d_url = local_link
                        session.add(tool)
                        session.commit()
                        print(f"Hoàn tất: {tool.name_tool_en} -> {local_link}")
                        success = True
                    break
                
                elif "ERROR" in str(res):
                    print(f"Lỗi: {res}")
                    break
                else:
                    print(f"{tool.name_tool_en}: {res}")
                    time.sleep(5)
                    retry_count += 1
            
            if not success:
                print(f"Thất bại hoặc Timeout với: {tool.name_tool_en}")
            
            if tool != pending_tools[-1]:
                print("Nghỉ 10 giây trước khi sang dụng cụ tiếp theo")
                time.sleep(10)
