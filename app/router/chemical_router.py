from fastapi import APIRouter, Depends
from sqlmodel import Session, select
from app.models.base_db import get_session
from app.models.chemicals import Chemicals
from app.models.profiles import Profiles
from app.utils.get_current_user import get_current_user
from app.utils.subscription_utils import require_active_plan

router = APIRouter(prefix="/api", tags=["Chemicals"])

@router.get("/cabinet/chemicals")
def get_cabinet(
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    """Trả về tất cả hóa chất trong tủ, chỉ cho user có gói hợp lệ."""
    require_active_plan(session, user.id_profile)

    stmt = select(Chemicals).where(
        Chemicals.is_in_cabinet == True
    ).order_by(Chemicals.shelf_number)

    results = session.exec(stmt).all()
    return results
