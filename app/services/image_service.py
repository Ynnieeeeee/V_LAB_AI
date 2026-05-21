from serpapi import GoogleSearch
from app.config import SERPAPI_KEY
from app.models.base_db import engine
from sqlmodel import select, Session
from app.models.tools import Tools
from app.utils.tool_classifier import ensure_tools_metadata_columns

def search_tool_image(tool_name_en: str):
    # Sử dụng query cực kỳ chi tiết để lấy ảnh sạch nhất, tránh "dính nền"
    search_query = f"{tool_name_en} laboratory equipment, isolated on pure white background, high resolution, front view, no shadows"
    params = {
        "engine": "google_images",
        "q": search_query,
        "api_key": SERPAPI_KEY,
        "num": 1,
        "ijn": 0
    }

    search = GoogleSearch(params)
    results = search.get_dict()

    if "images_results" in results and len(results["images_results"]) > 0:
        return results["images_results"][0]["original"]
    return None

def update_missing_images(engine):
    with Session(engine) as session:
        ensure_tools_metadata_columns(session)
        session.commit()
        statement = select(Tools).where(Tools.image_2d_url == None)
        pending_tools = session.exec(statement).all()

        for tool in pending_tools:
            print(f"Đang tìm ảnh cho: {tool.name_tool_en}")
            url = search_tool_image(tool.name_tool_en)
            if url:
                tool.image_2d_url = url
                session.add(tool)
                print(f"Đã tìm thấy: {url}")

        session.commit()
