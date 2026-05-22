import requests
import time
import os
import re
import unicodedata
import numpy as np
import trimesh
from sqlmodel import select, Session
from app.models.base_db import engine
from app.config import PUBLIC_BASE_URL, TRIPO_API_KEY
from app.models.tools import Tools
from app.services.image_service import (
    SINGLE_IMAGE_FAILURE_MESSAGE,
    clean_tool_image_for_3d,
    validate_single_object_image,
)
from app.services.vision_service import VisionService
from app.utils.tool_classifier import ensure_tools_metadata_columns


MAX_MODEL_GENERATION_ATTEMPTS = 3
MODEL_DUPLICATE_FAILURE_MESSAGE = "Model 3D bị phát hiện có nhiều bản sao dụng cụ, không đưa vào scene."
MODEL_NEGATIVE_PROMPT = (
    "multiple objects, duplicate tools, repeated copies, row of objects, set, collection, "
    "bundle, rack, many tubes, many laboratory tools, extra equipment"
)
SLENDER_TOOL_HINTS = (
    "gas tube",
    "delivery tube",
    "glass tubing",
    "tube",
    "ống dẫn",
    "ong dan",
    "ống thủy tinh",
    "ong thuy tinh",
    "pipette",
    "dropper",
    "stirring rod",
    "glass rod",
    "đũa",
    "dua",
)

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

    def _normalize_tool_text(self, value=""):
        normalized = unicodedata.normalize("NFD", str(value or ""))
        without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
        without_marks = without_marks.replace("Ä‘", "d").replace("Ä", "d")
        return re.sub(r"\s+", " ", without_marks.lower()).strip()

    def _static_model_url(self, filename):
        path = os.path.join(self.model_dir, filename)
        if os.path.exists(path):
            return f"/static/models/{filename}"
        return None

    def local_model_path_from_url(self, local_url):
        if not local_url or not local_url.startswith("/static/models/"):
            return None
        filename = local_url.split("/")[-1]
        return os.path.join(self.model_dir, filename)

    def get_local_fallback_model_url(self, name_vi="", name_en="", tool_type=""):
        """Return a reusable local GLB when Tripo cannot create a new model."""
        text_value = self._normalize_tool_text(f"{name_vi} {name_en} {tool_type}")
        candidates = [
            (("spirit lamp", "alcohol lamp", "burner", "den con", "heater", "hot plate", "bep"), ["spirit_lamp_1779422134.glb"]),
            (("tripod", "support stand", "ring stand", "lab stand", "holder", "gia do", "kieng"), ["tripping_stand_1779441089.glb", "holder_1779442212.glb"]),
            (("beaker", "coc", "cup"), ["glass_beaker_1778512516.glb", "glass_cup_1777647016.glb"]),
            (("erlenmeyer", "triangle flask", "binh tam giac"), ["erlenmeyer_flask_1779453161.glb", "triangle_flask_1778157689.glb"]),
            (("test tube", "ong nghiem"), ["test_tube_1779004216.glb", "test_tube_1777966870.glb"]),
            (("funnel", "pheu"), ["glass_funnel_1778157377.glb"]),
            (("gas tube", "delivery tube", "tubing", "ong dan khi"), ["l-shaped_glass_tubing_1778778815.glb", "sharp-pointed_glass_tubing_1778824304.glb"]),
            (("stirring", "glass rod", "stirrer", "dua thuy tinh"), ["glass_stirrer_1777967194.glb"]),
            (("flask", "binh cau", "round bottom"), ["round-bottomed_flask_1778075272.glb", "glass_flask_1779214208.glb"]),
            (("bottle", "jar"), ["chemical_bottle_1778830207.glb", "desiccant_bottle_1778158655.glb"]),
        ]
        for keywords, filenames in candidates:
            if any(keyword in text_value for keyword in keywords):
                for filename in filenames:
                    url = self._static_model_url(filename)
                    if url:
                        return url

        defaults_by_type = {
            "heating_source": "spirit_lamp_1779422134.glb",
            "support_stand": "tripping_stand_1779441089.glb",
            "container": "glass_beaker_1778512516.glb",
            "dropping_funnel": "glass_funnel_1778157377.glb",
            "funnel": "glass_funnel_1778157377.glb",
            "gas_tube": "l-shaped_glass_tubing_1778778815.glb",
            "gas_collector": "chemical_bottle_1778830207.glb",
            "stirring_tool": "glass_stirrer_1777967194.glb",
            "measuring_tool": "glass_beaker_1778512516.glb",
            "clamp_tool": "holder_1779442212.glb",
        }
        filename = defaults_by_type.get(str(tool_type or "").lower(), "glass_beaker_1778512516.glb")
        return self._static_model_url(filename)

    def _to_public_image_url(self, image_url):
        if not image_url:
            return None
        if image_url.startswith("http://") or image_url.startswith("https://"):
            return image_url
        if image_url.startswith("/static/"):
            if not PUBLIC_BASE_URL:
                print(
                    "[3DPipeline] Cleaned local image requires PUBLIC_BASE_URL before sending to Tripo: "
                    f"{image_url}"
                )
                return None
            return f"{PUBLIC_BASE_URL.rstrip('/')}{image_url}"
        return image_url

    def _is_slender_tool(self, tool_name_en="", name_vi="", tool_type=""):
        text_value = self._normalize_tool_text(f"{name_vi} {tool_name_en} {tool_type}")
        return any(self._normalize_tool_text(hint) in text_value for hint in SLENDER_TOOL_HINTS)

    def build_image_to_model_prompt(self, tool_name_en="", name_vi="", tool_type="", attempt=1):
        tool_label = tool_name_en or name_vi or "laboratory tool"
        prompt = (
            f"Generate a 3D model of exactly ONE single laboratory {tool_label} from the input image. "
            "Create exactly ONE object. The final 3D model must contain only one connected object. "
            "Do not duplicate the object. Do not create a set, row, collection, bundle, or repeated copies. "
            "Preserve the input image as one object only."
        )
        if self._is_slender_tool(tool_name_en, name_vi, tool_type):
            prompt += (
                " This is a single slender continuous laboratory tube or rod, not a rack, "
                "not a bundle, not a collection, and not multiple tubes."
            )
        if attempt > 1:
            prompt += " Previous result incorrectly created multiple copies. Regenerate only ONE single object."
        return prompt

    def create_3d_task(self, image_url, tool_name_en="", name_vi="", tool_type="", attempt=1):
        """Tạo task image-to-3d"""
        public_image_url = self._to_public_image_url(image_url)
        if not public_image_url:
            return None
        file_type = "png" if public_image_url.lower().split("?")[0].endswith(".png") else "jpg"
        prompt = self.build_image_to_model_prompt(tool_name_en, name_vi, tool_type, attempt)
        print(f"[Image2Model] input image: {image_url}")
        print(f"[Image2Model] tool name: {name_vi or tool_name_en}")
        print(f"[Image2Model] prompt: {prompt}")
        payload = {
            "type": "image_to_model",
            "model_version": "P1-20260311", 
            "file": {
                "type": file_type, 
                "url": public_image_url
            },
            "prompt": prompt,
            "negative_prompt": MODEL_NEGATIVE_PROMPT,
            "face_limit": 5000,
            "texture": True,
            "pbr": True
        }
        try:
            response = requests.post(f"{self.base_url}/task", headers=self.headers, json=payload, timeout=60)
            result = response.json()
            if result.get("code") == 0:
                return result.get("data", {}).get("task_id")
            print(f"[3DPipeline] Tripo create task API Error: {result.get('message')} | raw={result}")
            return None
        except Exception as e:
            print(f"Lỗi kết nối khi tạo Task: {e}")
            return None
        
    def check_task_status(self, task_id):
        """Kiểm tra trạng thái và lấy link GLB từ cấu trúc result.pbr_model"""
        try:
            response = requests.get(f"{self.base_url}/task/{task_id}", headers=self.headers, timeout=60)
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

    def _iter_scene_meshes(self, local_path):
        loaded = trimesh.load(local_path, force="scene")
        if isinstance(loaded, trimesh.Scene):
            meshes = loaded.dump(concatenate=False)
        else:
            meshes = [loaded]
        return [mesh for mesh in meshes if isinstance(mesh, trimesh.Trimesh) and len(mesh.faces) > 0]

    def _component_records(self, local_path):
        records = []
        mesh_count = 0
        for mesh in self._iter_scene_meshes(local_path):
            mesh_count += 1
            try:
                parts = mesh.split(only_watertight=False)
            except Exception:
                parts = []
            if not parts:
                parts = [mesh]
            for part in parts:
                if not isinstance(part, trimesh.Trimesh) or len(part.faces) == 0:
                    continue
                bounds = np.asarray(part.bounds, dtype=float)
                if bounds.shape != (2, 3) or not np.isfinite(bounds).all():
                    continue
                extents = np.maximum(bounds[1] - bounds[0], 1e-9)
                records.append({
                    "mesh": part,
                    "bounds": bounds,
                    "extents": extents,
                    "center": (bounds[0] + bounds[1]) / 2,
                    "area": float(getattr(part, "area", 0.0) or 0.0),
                    "faces": int(len(part.faces)),
                    "diag": float(np.linalg.norm(extents)),
                })
        return records, mesh_count

    def _box_gap(self, bounds_a, bounds_b):
        gap = np.maximum(0, np.maximum(bounds_a[0] - bounds_b[1], bounds_b[0] - bounds_a[1]))
        return float(np.linalg.norm(gap))

    def _union_bounds(self, records):
        mins = np.min([record["bounds"][0] for record in records], axis=0)
        maxs = np.max([record["bounds"][1] for record in records], axis=0)
        return np.array([mins, maxs])

    def _cluster_components(self, records):
        if not records:
            return []
        scene_bounds = self._union_bounds(records)
        scene_diag = max(float(np.linalg.norm(scene_bounds[1] - scene_bounds[0])), 1e-9)
        typical_diag = float(np.median([record["diag"] for record in records if record["diag"] > 0] or [scene_diag]))
        merge_gap = max(scene_diag * 0.012, typical_diag * 0.10)
        parent = list(range(len(records)))

        def find(index):
            while parent[index] != index:
                parent[index] = parent[parent[index]]
                index = parent[index]
            return index

        def union(a, b):
            root_a = find(a)
            root_b = find(b)
            if root_a != root_b:
                parent[root_b] = root_a

        for i, record_a in enumerate(records):
            for j in range(i + 1, len(records)):
                if self._box_gap(record_a["bounds"], records[j]["bounds"]) <= merge_gap:
                    union(i, j)

        grouped = {}
        for index in range(len(records)):
            grouped.setdefault(find(index), []).append(index)

        clusters = []
        for indices in grouped.values():
            cluster_records = [records[index] for index in indices]
            bounds = self._union_bounds(cluster_records)
            extents = np.maximum(bounds[1] - bounds[0], 1e-9)
            clusters.append({
                "indices": indices,
                "bounds": bounds,
                "center": (bounds[0] + bounds[1]) / 2,
                "extents": extents,
                "area": sum(record["area"] for record in cluster_records),
                "faces": sum(record["faces"] for record in cluster_records),
                "diag": float(np.linalg.norm(extents)),
            })
        return clusters

    def _significant_clusters(self, clusters):
        if not clusters:
            return []
        max_area = max(cluster["area"] for cluster in clusters) or 1.0
        max_faces = max(cluster["faces"] for cluster in clusters) or 1
        max_diag = max(cluster["diag"] for cluster in clusters) or 1.0
        significant = [
            cluster for cluster in clusters
            if (
                cluster["area"] >= max_area * 0.16
                or cluster["faces"] >= max_faces * 0.16
                or cluster["diag"] >= max_diag * 0.35
            )
        ]
        return significant or [max(clusters, key=lambda cluster: cluster["area"])]

    def _clusters_have_repeated_shape(self, clusters):
        if len(clusters) < 2:
            return False
        similar_pairs = 0
        for i, first in enumerate(clusters):
            first_shape = np.sort(first["extents"]) / max(first["diag"], 1e-9)
            for second in clusters[i + 1:]:
                second_shape = np.sort(second["extents"]) / max(second["diag"], 1e-9)
                area_ratio = min(first["area"], second["area"]) / max(first["area"], second["area"], 1e-9)
                face_ratio = min(first["faces"], second["faces"]) / max(first["faces"], second["faces"], 1)
                shape_distance = float(np.linalg.norm(first_shape - second_shape))
                if area_ratio >= 0.45 and face_ratio >= 0.45 and shape_distance <= 0.28:
                    similar_pairs += 1
        return similar_pairs >= 1

    def _clusters_form_row(self, clusters):
        if len(clusters) < 3:
            return False
        centers = np.array([cluster["center"] for cluster in clusters])
        spreads = np.ptp(centers, axis=0)
        primary = float(np.max(spreads))
        secondary = float(np.partition(spreads, -2)[-2]) if len(spreads) >= 2 else 0.0
        return primary > 0 and primary >= max(secondary * 1.8, 1e-6)

    def validate_single_object_model(self, local_path, tool_name_en="", tool_type=""):
        try:
            records, mesh_count = self._component_records(local_path)
        except Exception as exc:
            return {
                "accepted": False,
                "reason": f"model_load_failed={type(exc).__name__}",
                "mesh_count": 0,
                "component_count": 0,
                "duplicate_detected": False,
            }
        clusters = self._cluster_components(records)
        significant = self._significant_clusters(clusters)
        duplicate_detected = False
        if len(significant) >= 2:
            duplicate_detected = self._clusters_have_repeated_shape(significant)
        if len(significant) >= 3 and self._clusters_form_row(significant):
            duplicate_detected = True

        print(f"[ModelValidation] mesh count: {mesh_count}")
        print(f"[ModelValidation] component count: {len(significant)}")
        print(f"[ModelValidation] duplicate detected: {duplicate_detected}")
        return {
            "accepted": bool(records) and not duplicate_detected,
            "reason": "duplicate_model_detected" if duplicate_detected else "single_object_model_ok",
            "mesh_count": mesh_count,
            "component_count": len(significant),
            "duplicate_detected": duplicate_detected,
            "records": records,
            "clusters": clusters,
            "significant_clusters": significant,
        }

    def keep_largest_connected_component(self, local_path, validation):
        records = validation.get("records") or []
        clusters = validation.get("significant_clusters") or []
        if not records or len(clusters) < 2:
            return False
        all_bounds = self._union_bounds(records)
        scene_center = (all_bounds[0] + all_bounds[1]) / 2

        def cluster_rank(cluster):
            distance = float(np.linalg.norm(cluster["center"] - scene_center))
            return (cluster["area"], cluster["faces"], -distance)

        keep_cluster = max(clusters, key=cluster_rank)
        keep_indices = set(keep_cluster["indices"])
        scene = trimesh.Scene()
        for index in keep_indices:
            scene.add_geometry(records[index]["mesh"], node_name=f"kept_component_{index}")
        scene.export(local_path)
        print(
            "[ModelValidation] kept one component group:",
            f"kept={len(keep_indices)} removed={max(0, len(records) - len(keep_indices))}",
        )
        return True

    def validate_and_repair_single_object_model(self, local_path, tool_name_en="", tool_type=""):
        validation = self.validate_single_object_model(local_path, tool_name_en, tool_type)
        if validation.get("accepted"):
            print(f"[ModelValidation] final accepted: {local_path}")
            return validation
        print(f"[ModelValidation] rejected duplicated model: {validation.get('reason')}")
        if validation.get("duplicate_detected") and self.keep_largest_connected_component(local_path, validation):
            repaired = self.validate_single_object_model(local_path, tool_name_en, tool_type)
            if repaired.get("accepted"):
                repaired["repaired"] = True
                print(f"[ModelValidation] final accepted: {local_path}")
                return repaired
            print(f"[ModelValidation] rejected duplicated model after repair: {repaired.get('reason')}")
            return repaired
        return validation

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

            validation = validate_single_object_image(
                tool.image_2d_url,
                tool.name_tool_en,
                tool.name_tool_vi,
                tool.tool_type,
            )
            print(f"[ToolImage] validation: {validation}")
            if not validation.get("isValid"):
                print(f"[ImageValidation] rejected existing image: {validation.get('reason')}")
                print(f"{SINGLE_IMAGE_FAILURE_MESSAGE} ({tool.name_tool_en})")
                continue

            cleaned_image_url = clean_tool_image_for_3d(
                tool.image_2d_url,
                tool.name_tool_en,
                tool.id_tool,
                tool.tool_type,
            )
            if cleaned_image_url and cleaned_image_url != tool.image_2d_url:
                tool.image_2d_url = cleaned_image_url
                session.add(tool)
                session.commit()

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

            task_id = service.create_3d_task(
                tool.image_2d_url,
                tool.name_tool_en,
                tool.name_tool_vi,
                tool.tool_type,
                1,
            )
            
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
                        local_path = service.local_model_path_from_url(local_link)
                        validation = None
                        if local_path and os.path.exists(local_path):
                            validation = service.validate_and_repair_single_object_model(
                                local_path,
                                tool.name_tool_en,
                                tool.tool_type,
                            )
                        if validation and not validation.get("accepted"):
                            print(f"[ModelValidation] rejected duplicated model: {validation.get('reason')}")
                            break
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
