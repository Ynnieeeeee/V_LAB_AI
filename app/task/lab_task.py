from app.services.image_service import search_tool_image
from app.services.mesh_service import MeshService
from app.models.tools import Tools
from app.models.base_db import engine
from sqlmodel import Session
import asyncio
import trimesh
import numpy as np
import os

def align_model_to_floor(local_path):
    try:
        mesh = trimesh.load(local_path)
        plane_origin, n_object = trimesh.registration.plane_fit(mesh.vertices)

        target_vector = np.array([0, 1, 0]) 
        rotation_matrix = trimesh.geometry.align_vectors(n_object, target_vector)
        mesh.apply_transform(rotation_matrix)

        y_min = mesh.vertices[:, 1].min()
        translation = [0, -y_min, 0]
        mesh.apply_translation(translation)
        
        mesh.export(local_path)
        print(f"Căn chỉnh thành công theo trục Y: {local_path}")

    except Exception as e:
        print(f"Lỗi khi căn chỉnh mô hình: {e}")

async def start_3d_pipeline_task(tool_ids: list, engine):
    service_3d = MeshService()
    from app.services.vision_service import VisionService
    vision_service = VisionService()
    
    # Xác định thư mục gốc của dự án (project root)
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../"))

    for t_id in tool_ids:
        with Session(engine) as session:
            tool = session.get(Tools, t_id)
            if not tool: continue

            # 1. Tự động tìm kiếm ảnh 2D nếu chưa có
            if not tool.image_2d_url:
                print(f"Đang tìm ảnh cho: {tool.name_tool_en}")
                image_url = search_tool_image(tool.name_tool_en)
                if image_url:
                    tool.image_2d_url = image_url
                    session.add(tool)
                    session.commit()
                else:
                    print(f"Không tìm thấy ảnh cho {tool.name_tool_en}, bỏ qua.")
                    continue

            # 2. Phân tích chất liệu từ ảnh 2D (Sử dụng VisionService và ColorService)
            print(f"Đang phân tích chất liệu: {tool.name_tool_en}")
            
            # Lấy màu sắc chính xác bằng Pixel Analysis
            from app.services.color_service import ColorService
            color_service = ColorService()
            extracted_color = color_service.get_dominant_color(tool.image_2d_url)

            # Lấy loại chất liệu bằng AI Vision
            pbr_data = vision_service.analyze_material(tool.image_2d_url)
            
            if pbr_data:
                # Ưu tiên màu sắc từ ColorService (pixel-perfect) hơn là AI guess
                tool.material_color = extracted_color if extracted_color != "#ffffff" else pbr_data.get('material_color', '#ffffff')
                
                tool.material_type = pbr_data.get('material_type', 'OTHER')
                tool.roughness = pbr_data.get('roughness', 0.5)
                tool.metalness = pbr_data.get('metalness', 0.0)
                tool.is_glass = pbr_data.get('is_glass', False)
                tool.ior = pbr_data.get('ior', 1.5)
                tool.transmission = pbr_data.get('transmission', 0.0)
                session.add(tool)
                session.commit()

            # 3. Gửi Task tạo Model 3D
            print(f"Gửi Task Tripo: {tool.name_tool_en}")
            task_id = service_3d.create_3d_task(tool.image_2d_url)

            if task_id:
                for _ in range(60): # Chờ tối đa 5 phút
                    await asyncio.sleep(5)
                    res = service_3d.check_task_status(task_id)

                    if isinstance(res, str) and res.startswith("http"):
                        local_url = service_3d.download_and_get_local_url(res, tool.name_tool_en)
                        if local_url:
                            # Chuyển đổi URL tương đối thành Path vật lý
                            filename = local_url.split('/')[-1]
                            full_path = os.path.join(base_dir, "app", "static", "models", filename)
                            
                            if os.path.exists(full_path):
                                align_model_to_floor(full_path)

                            # Refresh tool instance from session before final commit
                            tool = session.get(Tools, t_id)
                            tool.model_3d_url = local_url
                            session.add(tool)
                            session.commit()
                            print(f"Hoàn tất dụng cụ: {tool.name_tool_en}")
                        break
                    elif "ERROR" in str(res): 
                        print(f"Lỗi Tripo cho {tool.name_tool_en}: {res}")
                        break


