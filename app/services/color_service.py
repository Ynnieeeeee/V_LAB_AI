import requests
import os
from PIL import Image
from io import BytesIO
from collections import Counter

class ColorService:
    def _open_image(self, image_url):
        if image_url and image_url.startswith("/static/"):
            local_path = os.path.abspath(os.path.join("app", image_url.lstrip("/").replace("/", os.sep)))
            return Image.open(local_path)
        if image_url and os.path.exists(image_url):
            return Image.open(image_url)
        response = requests.get(image_url, timeout=10)
        response.raise_for_status()
        return Image.open(BytesIO(response.content))

    def get_dominant_color(self, image_url):
        """Trích xuất màu sắc chủ đạo từ ảnh (loại bỏ màu nền trắng/đen)"""
        try:
            img = self._open_image(image_url)
            img = img.convert('RGB')
            img = img.resize((50, 50))  # Resize để xử lý nhanh hơn
            
            pixels = list(img.getdata())
            
            # Lọc bỏ màu trắng (nền lab thường trắng) và màu quá tối (nền đen)
            filtered_pixels = [
                p for p in pixels 
                if not (p[0] > 230 and p[1] > 230 and p[2] > 230) # Không phải trắng
                and not (p[0] < 20 and p[1] < 20 and p[2] < 20)  # Không phải đen
            ]
            
            if not filtered_pixels:
                return "#ffffff" # Mặc định là trắng nếu không tìm thấy màu khác
            
            # Lấy màu xuất hiện nhiều nhất
            most_common = Counter(filtered_pixels).most_common(1)[0][0]
            return '#{:02x}{:02x}{:02x}'.format(*most_common)
            
        except Exception as e:
            print(f"Lỗi trích xuất màu: {e}")
            return "#ffffff"
