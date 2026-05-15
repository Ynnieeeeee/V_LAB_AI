import asyncio
from app.models.base_db import create_db_and_tables, engine
from app.models.tools import Tools
from app.services.image_service import update_missing_images
from sqlmodel import Session, SQLModel, select

def prepare_test_data():
    """Tạo dữ liệu mẫu nếu DB trống"""
    with Session(engine) as session:
        statement = select(Tools).where(Tools.image_2d_url == None)
        results = session.exec(statement).all()
        
        if not results:
            print("--- Đang tạo dữ liệu mẫu để test ---")
            test_tool = Tools(
                name_tool_vi="Cốc thủy tinh",
                name_tool_en="beaker",
                description="Dùng để đựng dung dịch"
            )
            session.add(test_tool)
            session.commit()
            print("Đã thêm 'beaker' vào DB.")

def test_image_search():
    create_db_and_tables()
    
    prepare_test_data()
    
    print("--- Bắt đầu chạy update_missing_images ---")
    update_missing_images(engine)
    print("--- Hoàn thành ---")

if __name__ == "__main__":
    test_image_search()