from fastapi import APIRouter, Depends
from app.models.base_db import get_session
from app.models.chemicals import Chemicals
from sqlmodel import Session, select

router = APIRouter(prefix="/api", tags=["Chemicals"])

@router.get("/cabinet/chemicals")
def get_cabinet(session: Session = Depends(get_session)):
    """Trả về tất các các hóa chất đang có trong tủ"""
    stmt = select(Chemicals).where(
        Chemicals.is_in_cabinet == True
    ).order_by(Chemicals.shelf_number)

    results = session.exec(stmt).all()
    return results