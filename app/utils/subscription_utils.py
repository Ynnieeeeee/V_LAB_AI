from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func
from sqlmodel import Session, select

from app.models.conversations import Conversations
from app.models.profiles import Profiles
from app.models.subscription_plans import SubscriptionPlans
from app.models.subscriptions import Subscriptions
from app.models.tools import Tools


DEFAULT_DURATION_DAYS = 30
UNLIMITED_VALUES = {-1, 999999, 999999999}


def _now() -> datetime:
    """UTC timezone-aware datetime, dùng an toàn với timestamp có timezone."""
    return datetime.now(timezone.utc)


def _as_aware_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _today_start() -> datetime:
    current = _now()
    return datetime(current.year, current.month, current.day, tzinfo=timezone.utc)


def _to_uuid(value: str | UUID | None):
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return value


def get_free_plan(session: Session):
    stmt = select(SubscriptionPlans).where(
        func.lower(SubscriptionPlans.plan_name) == "free"
    )
    return session.exec(stmt).first()


def _admin_plan_info(session: Session, id_profile: str | UUID) -> dict | None:
    profile_id = _to_uuid(id_profile)
    profile = session.get(Profiles, profile_id)
    if not profile or profile.role != "admin" or getattr(profile, "is_deleted", False):
        return None

    return {
        "has_plan": True,
        "subscription": None,
        "plan": None,
        "plan_name": "Admin",
        "tool_limit_per_day": -1,
        "is_admin": True,
    }


def get_active_subscription(session: Session, id_profile: str | UUID):
    profile_id = _to_uuid(id_profile)
    current_time = _now()

    stmt = (
        select(Subscriptions)
        .where(
            Subscriptions.id_profile == profile_id,
            Subscriptions.is_active == True,
        )
        .order_by(Subscriptions.start_date.desc())
    )

    subscriptions = session.exec(stmt).all()

    for sub in subscriptions:
        sub_end_date = _as_aware_utc(sub.end_date)
        if sub_end_date and sub_end_date < current_time:
            sub.is_active = False
            session.add(sub)
            continue
        return sub

    session.commit()
    return None


def get_user_plan(session: Session, id_profile: str | UUID):
    subscription = get_active_subscription(session, id_profile)

    if not subscription:
        return get_free_plan(session)

    plan = session.get(SubscriptionPlans, subscription.id_plan)
    return plan or get_free_plan(session)


def get_user_plan_info(session: Session, id_profile: str | UUID) -> dict:
    admin_info = _admin_plan_info(session, id_profile)
    if admin_info:
        return admin_info

    subscription = get_active_subscription(session, id_profile)
    plan = session.get(SubscriptionPlans, subscription.id_plan) if subscription else get_free_plan(session)

    if not plan:
        return {
            "has_plan": False,
            "subscription": None,
            "plan": None,
            "plan_name": None,
            "tool_limit_per_day": 0,
        }

    return {
        "has_plan": True,
        "subscription": subscription,
        "plan": plan,
        "plan_name": plan.plan_name,
        "tool_limit_per_day": int(plan.tool_limit_per_day or 0),
    }


def _is_unlimited(limit: int | None) -> bool:
    return limit is not None and int(limit) in UNLIMITED_VALUES


def _count_tools_today(session: Session, id_profile: str | UUID) -> int:
    profile_id = _to_uuid(id_profile)
    stmt = (
        select(func.coalesce(func.sum(Tools.quantity), 0))
        .join(Conversations, Tools.id_conv == Conversations.id_conv)
        .where(
            Conversations.id_profile == profile_id,
            Conversations.is_deleted == False,
            Tools.is_deleted == False,
            Tools.created_at >= _today_start(),
        )
    )
    return int(session.exec(stmt).one() or 0)


def require_active_plan(session: Session, id_profile: str | UUID):
    info = get_user_plan_info(session, id_profile)
    if not info["has_plan"]:
        raise HTTPException(
            status_code=403,
            detail="Bạn chưa có gói sử dụng. Vui lòng đăng ký hoặc nâng cấp gói."
        )
    return info


def require_tool_limit(session: Session, id_profile: str | UUID, requested_quantity: int = 1):
    info = require_active_plan(session, id_profile)
    limit = info["tool_limit_per_day"]

    if _is_unlimited(limit):
        info["used_tools_today"] = _count_tools_today(session, id_profile)
        info["remaining_tools_today"] = None
        return info

    if limit <= 0:
        raise HTTPException(
            status_code=403,
            detail=f"Gói {info['plan_name']} không hỗ trợ tạo dụng cụ/phòng lab. Vui lòng nâng cấp gói."
        )

    used = _count_tools_today(session, id_profile)
    requested_quantity = max(1, int(requested_quantity or 1))

    if used + requested_quantity > limit:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Bạn đã dùng {used}/{limit} dụng cụ trong hôm nay. "
                "Vui lòng nâng cấp gói hoặc quay lại vào ngày mai."
            )
        )

    info["used_tools_today"] = used
    info["remaining_tools_today"] = max(0, limit - used)
    return info


def upgrade_subscription(
    session: Session,
    id_profile: str | UUID,
    new_plan_id: str | UUID,
    duration_days: int = DEFAULT_DURATION_DAYS,
):
    profile_id = _to_uuid(id_profile)
    plan_id = _to_uuid(new_plan_id)
    plan = session.get(SubscriptionPlans, plan_id)

    if not plan:
        raise ValueError("Gói subscription không tồn tại")

    stmt = select(Subscriptions).where(
        Subscriptions.id_profile == profile_id,
        Subscriptions.is_active == True,
    )

    current_subscriptions = session.exec(stmt).all()

    for current in current_subscriptions:
        current.is_active = False
        session.add(current)

    start_date = _now()
    end_date = start_date + timedelta(days=duration_days or plan.duration_days or DEFAULT_DURATION_DAYS)

    new_subscription = Subscriptions(
        id_profile=profile_id,
        id_plan=plan_id,
        start_date=start_date,
        end_date=end_date,
        is_active=True,
    )

    session.add(new_subscription)
    session.commit()
    session.refresh(new_subscription)

    return new_subscription
