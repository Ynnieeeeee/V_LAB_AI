from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.models.base_db import get_session
from app.models.profiles import Profiles
from app.models.subscription_plans import SubscriptionPlans
from app.utils.get_current_user import get_current_user
from app.utils.subscription_utils import (
    get_user_plan_info,
    upgrade_subscription,
)


router = APIRouter(prefix="/subscription", tags=["Subscription"])


@router.get("/plans")
def list_subscription_plans(session: Session = Depends(get_session)):
    plans = session.exec(select(SubscriptionPlans).order_by(SubscriptionPlans.price)).all()
    return plans


@router.get("/me")
def my_subscription(
    current_user: Profiles = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    info = get_user_plan_info(session, current_user.id_profile)
    plan = info.get("plan")
    subscription = info.get("subscription")

    return {
        "has_plan": info["has_plan"],
        "plan": plan,
        "subscription": subscription,
        "limits": {
            "tool_limit_per_day": info["tool_limit_per_day"],
        },
    }


@router.post("/upgrade")
def upgrade_plan(
    plan_id: UUID,
    current_user: Profiles = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """
    Chỉ dùng cho admin/test nội bộ.
    Luồng production nên nâng cấp qua /payment và VNPAY IPN/return.
    """
    try:
        plan = session.get(SubscriptionPlans, plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail="Gói subscription không tồn tại")

        subscription = upgrade_subscription(
            session=session,
            id_profile=current_user.id_profile,
            new_plan_id=plan_id,
            duration_days=plan.duration_days or 30,
        )

        return {
            "message": "Plan upgraded successfully",
            "subscription_id": str(subscription.id_sub),
            "plan_id": str(plan.id_plan),
            "plan_name": plan.plan_name,
            "start_date": subscription.start_date,
            "end_date": subscription.end_date,
        }

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=str(e))
