import requests
import uuid
from deep_translator import GoogleTranslator
from sqlmodel import Session
from app.models.chemicals import Chemicals
from app.models.tools import Tools
from app.models.base_db import engine

translator = GoogleTranslator(source='en', target='vi')

# --- BỔ SUNG THAM SỐ chemical_type VÀO HÀM ---
def load_data_chemical(name_en, name_vi, shelf, color='#ffffff', state='Lỏng', id_tool=None, chemical_type='generic_solution'):
    """Lấy thông tin hóa chất từ pubchem và nạp kèm nhãn phân loại tự động"""
    api_url = f"https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{name_en}/property/MolecularFormula,MolecularWeight/JSON"

    try:
        response = requests.get(api_url)
        if response.status_code != 200:
            print(f"Không tìm thấy chất {name_en}")
            return
        
        data = response.json()['PropertyTable']['Properties'][0]
        cid = data['CID']

        # Lấy mô tả từ pubchem
        desc_url = f"https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{cid}/description/JSON"
        desc_res = requests.get(desc_url).json()
        desc_list = desc_res.get('InformationList', {}).get('Information', [])

        raw_description = "Chưa có mô tả chi tiết"
        for info in desc_list:
            if 'Description' in info:
                raw_description = info['Description']
                break

        try:
            description_vi = translator.translate(raw_description)
            print(f"Đã dịch mô tả của {name_vi}")
        except:
            description_vi = raw_description

        transmission = 0.9 if state=='Lỏng' else 0.0
        roughness  = 0.1 if state=='Lỏng' else 0.8

        new_chem = Chemicals(
            name_vi=name_vi,
            formula=data['MolecularFormula'],
            modecular_weight=data['MolecularWeight'], 
            physical_state=state,
            material_color=color,
            transmission=transmission,
            roughness=roughness,
            safery_info=f"Cảnh báo an toàn GHS: Xem chi tiết tại PubChem CID {cid}",
            description=description_vi,
            is_in_cabinet=True,
            shelf_number=shelf,
            image_url=f"https://pubchem.ncbi.nlm.nih.gov/image/imgsrv.fcgi?cid={cid}",
            id_tool=id_tool,
            # --- LƯU TRƯỜNG PHÂN LOẠI XUỐNG DATABASE ---
            chemical_type=chemical_type 
        )

        with Session(engine) as session:
            session.add(new_chem)
            session.commit()
            print(f"Đã nạp thành công {name_vi} - Loại: {chemical_type} (CID: {cid})")
    except Exception as e:
        print(f"Lỗi khi xử lý {name_en}: {e}")


if __name__=="__main__":
    id_lo_dung = "b84116bb-f88e-4d45-b3ed-35e2afc31086"

    # --- ĐÃ BỔ SUNG TRƯỜNG "type" ĐỂ PHÂN NHÓM TỰ ĐỘNG ---
    chemicals_list = [
        # --- HÓA VÔ CƠ & LỚP 10 (Tốc độ phản ứng, Halogen, Oxi-Lưu huỳnh) ---
        {"en": "sodium", "vi": "Natri", "shelf": 1, "color": "#C0C0C0", "state": "Rắn", "tool": id_lo_dung, "type": "alkali_metal"},
        {"en": "water", "vi": "Nước", "shelf": 1, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "water"},
        {"en": "hydrochloric acid", "vi": "Axit Clohidric", "shelf": 1, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "strong_acid"},
        {"en": "manganese dioxide", "vi": "Mangan Đioxit", "shelf": 1, "color": "#333333", "state": "Rắn", "tool": id_lo_dung, "type": "catalyst"},
        {"en": "sulfuric acid", "vi": "Axit Sunfuric", "shelf": 2, "color": "#FCF3CF", "state": "Lỏng", "tool": id_lo_dung, "type": "strong_acid"},

        # --- HÓA 11 (Nitơ - Photpho, Điện li, Hữu cơ cơ bản) ---
        {"en": "nitric acid", "vi": "Axit Nitric", "shelf": 2, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "strong_acid"},
        {"en": "ammonia", "vi": "Amoniac", "shelf": 2, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "weak_base"},
        {"en": "sodium hydroxide", "vi": "Natri Hydroxit", "shelf": 2, "color": "#ffffff", "state": "Rắn", "tool": id_lo_dung, "type": "strong_base"},
        {"en": "copper(II) sulfate", "vi": "Đồng(II) Sunfat", "shelf": 3, "color": "#0074D9", "state": "Rắn", "tool": id_lo_dung, "type": "salt_solution"},
        {"en": "barium chloride", "vi": "Bari Clorua", "shelf": 3, "color": "#ffffff", "state": "Rắn", "tool": id_lo_dung, "type": "salt_solution"},

        # --- HÓA HỮU CƠ (Lớp 11 & 12: Hidrocacbon, Ancol, Este, Polime) ---
        {"en": "ethanol", "vi": "Ancol Etylic", "shelf": 4, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "alcohol"},
        {"en": "acetic acid", "vi": "Axit Axetic", "shelf": 4, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "weak_acid"},
        {"en": "benzene", "vi": "Benzen", "shelf": 4, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "hydrocarbon"},
        {"en": "glucose", "vi": "Glucozơ", "shelf": 5, "color": "#ffffff", "state": "Rắn", "tool": id_lo_dung, "type": "carbohydrate"},
        {"en": "acetone", "vi": "Axeton", "shelf": 5, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "ketone"},

        # --- CHẤT CHỈ THỊ & THUỐC THỬ (Rất quan trọng cho Virtual Lab) ---
        {"en": "phenolphthalein", "vi": "Phenolphthalein", "shelf": 6, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "indicator_phenol"},
        {"en": "silver nitrate", "vi": "Bạc Nitrat", "shelf": 6, "color": "#ffffff", "state": "Lỏng", "tool": id_lo_dung, "type": "salt_solution"},
        {"en": "potassium permanganate", "vi": "Kali Pemanganat", "shelf": 6, "color": "#85144b", "state": "Rắn", "tool": id_lo_dung, "type": "oxidizer"},
        {"en": "iodine", "vi": "Iốt", "shelf": 6, "color": "#4B0082", "state": "Rắn", "tool": id_lo_dung, "type": "halogen"},
    ]

    for item in chemicals_list:
        load_data_chemical(
            name_en=item['en'], 
            name_vi=item['vi'], 
            shelf=item['shelf'], 
            color=item['color'], 
            state=item['state'], 
            id_tool=item['tool'],
            # Truyền nhãn loại chất vào hàm
            chemical_type=item.get('type', 'generic_solution')
        )