import requests
import re
import json
from app.config import HF_TOKEN, PUBLIC_BASE_URL

class VisionService:
    def __init__(self):
        self.api_url = "https://api-inference.huggingface.co/models/llava-hf/llava-1.5-7b-hf"
        self.headers = {"Authorization": f"Bearer {HF_TOKEN}"}

    def extract_json_from_text(self, text: str):
        """Trích xuất JSON từ chuỗi phản hồi của AI bằng Regex"""
        match = re.search(r'(\{.*\})', text, re.DOTALL)
        try:
            if match:
                json_data = match.group(1)
                return json.loads(json_data)
        except Exception as e:
            print(f"Lỗi khi parse JSON: {e}")
            return None

    def analyze_material(self, image_url: str):
        """Phân tích loại chất liệu (classification) để áp dụng bộ thông số PBR chuẩn"""
        if image_url and image_url.startswith("/static/"):
            if not PUBLIC_BASE_URL:
                return {"roughness": 0.5, "metalness": 0.0, "ior": 1.5, "transmission": 0.0, "is_glass": False, "clearcoat": 0.0, "material_color": "#ffffff"}
            image_url = f"{PUBLIC_BASE_URL.rstrip('/')}{image_url}"

        prompt = """
            Act as a Laboratory Equipment Specialist. Analyze the image and identify:
            1. The primary material (GLASS, METAL, PLASTIC, LIQUID, or OTHER).
            2. THE DOMINANT COLOR OF THE MAIN OBJECT ONLY. IGNORE THE BACKGROUND.
            3. Is it fully transparent, semi-transparent, or opaque?

            IMPORTANT: 
            - If the background is white/gray, DO NOT report #FFFFFF unless the object itself is white.
            - Focus on the content (liquid) if present.
            
            OUTPUT ONLY VALID JSON:
            {
              "material_type": "GLASS" | "METAL" | "PLASTIC" | "LIQUID" | "OTHER",
              "primary_color_hex": "#RRGGBB",
              "transparency": "FULL" | "SEMI" | "NONE"
            }
        """

        payload = {
            "inputs": f"User: <image>\n{prompt}\nAssistant:",
            "image": image_url,
            "parameters": {"max_new_tokens": 200}
        }

        try:
            response = requests.post(self.api_url, headers=self.headers, json=payload)
            result = response.json()
            raw_text = result[0].get('generated_text', '') if isinstance(result, list) else str(result)
            data = self.extract_json_from_text(raw_text)

            if data:
                m_type = data.get("material_type", "OTHER").upper()
                m_color = data.get("primary_color_hex", "#ffffff")
                trans = data.get("transparency", "NONE")
                
                # Bản đồ thông số PBR chuẩn theo từng loại vật liệu
                pbr_presets = {
                    "GLASS": {"roughness": 0.05, "metalness": 0.0, "ior": 1.5, "transmission": 0.95, "is_glass": True, "clearcoat": 1.0},
                    "METAL": {"roughness": 0.2, "metalness": 0.9, "ior": 1.5, "transmission": 0.0, "is_glass": False, "clearcoat": 0.5},
                    "PLASTIC": {"roughness": 0.4, "metalness": 0.0, "ior": 1.45, "transmission": 0.0, "is_glass": False, "clearcoat": 0.1},
                    "LIQUID": {"roughness": 0.1, "metalness": 0.0, "ior": 1.33, "transmission": 0.8, "is_glass": True, "clearcoat": 0.0},
                    "OTHER": {"roughness": 0.8, "metalness": 0.0, "ior": 1.4, "transmission": 0.0, "is_glass": False, "clearcoat": 0.0}
                }
                
                res = pbr_presets.get(m_type, pbr_presets["OTHER"]).copy()
                
                # Điều chỉnh dựa trên transparency
                if trans == "FULL":
                    res["transmission"] = 0.95
                    res["is_glass"] = True
                elif trans == "SEMI":
                    res["transmission"] = 0.5
                    res["is_glass"] = True
                
                res["material_color"] = m_color
                return res
                
        except Exception as e:
            print(f"Lỗi Vision Service: {e}")

        return {"roughness": 0.5, "metalness": 0.0, "ior": 1.5, "transmission": 0.0, "is_glass": False, "clearcoat": 0.0, "material_color": "#ffffff"}
