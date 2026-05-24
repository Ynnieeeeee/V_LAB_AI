from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from sqlalchemy import func
from sqlmodel import Session, select
from decimal import Decimal
from datetime import datetime
from pathlib import Path
import urllib.parse
import uuid

from app.config import (
    VNPAY_TMN_CODE,
    VNPAY_HASH_SECRET,
    VNPAY_PAYMENT_URL,
    VNPAY_RETURN_URL
)
from app.models.base_db import get_session
from app.models.profiles import Profiles
from app.models.payments import Payments
from app.models.subscription_plans import SubscriptionPlans
from app.utils.get_current_user import get_current_user
from app.utils.payment_utils import generate_secure_hash, validate_response
from app.utils.subscription_utils import upgrade_subscription

router = APIRouter(tags=["Payment"])
PAYMENT_RESULT_PAGE = Path(__file__).resolve().parents[1] / "src" / "payment_result.html"


PLAN_ALIASES = {
    "basic": ("basic", "free"),
    "free": ("free", "basic"),
}


async def _read_payment_payload(request: Request) -> dict:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()

    if content_type == "application/json":
        try:
            payload = await request.json()
        except ValueError:
            return {}
        return payload if isinstance(payload, dict) else {}

    body = await request.body()
    if not body:
        return {}

    try:
        return dict(urllib.parse.parse_qsl(body.decode("utf-8")))
    except UnicodeDecodeError:
        return {}


def _get_plan_by_ref(session: Session, plan_ref: str | uuid.UUID | None):
    if not plan_ref:
        return None

    ref = str(plan_ref).strip()
    if not ref:
        return None

    try:
        return session.get(SubscriptionPlans, uuid.UUID(ref))
    except ValueError:
        pass

    normalized = ref.lower()
    candidate_names = PLAN_ALIASES.get(normalized, (normalized,))

    for name in candidate_names:
        stmt = select(SubscriptionPlans).where(
            func.lower(SubscriptionPlans.plan_name) == name
        )
        plan = session.exec(stmt).first()
        if plan:
            return plan

    return None


def _missing_vnpay_config() -> list[str]:
    config = {
        "VNPAY_TMN_CODE": VNPAY_TMN_CODE,
        "VNPAY_HASH_SECRET": VNPAY_HASH_SECRET,
        "VNPAY_PAYMENT_URL": VNPAY_PAYMENT_URL,
    }
    return [name for name, value in config.items() if not value]


def _get_vnpay_return_url(request: Request) -> str:
    try:
        return str(request.url_for("vnpay_return"))
    except RuntimeError:
        return VNPAY_RETURN_URL or str(request.base_url).rstrip("/") + "/vnpay_return"


@router.post("/payment")
async def create_payment(
    request: Request,
    current_user: Profiles = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    payload = await _read_payment_payload(request)
    plan = _get_plan_by_ref(session, payload.get("plan_id") or payload.get("plan"))

    if not plan:
        return JSONResponse(
            {"error": "Plan not found"},
            status_code=404
        )

    if float(plan.price or 0) <= 0:
        subscription = upgrade_subscription(
            session=session,
            id_profile=current_user.id_profile,
            new_plan_id=plan.id_plan,
            duration_days=plan.duration_days or 30
        )

        return {
            "message": "Plan upgraded successfully",
            "subscription_id": str(subscription.id_sub),
            "plan_id": str(plan.id_plan),
            "plan_name": plan.plan_name,
            "redirect_url": "/chat",
        }

    missing_config = _missing_vnpay_config()
    if missing_config:
        return JSONResponse(
            {
                "detail": (
                    "Chưa cấu hình thanh toán VNPAY: "
                    + ", ".join(missing_config)
                )
            },
            status_code=503
        )

    payment = Payments(
        id_profile=current_user.id_profile,
        id_plan=plan.id_plan,
        amount=plan.price,
        status="pending",
        method="vnpay",
        id_sub=None
    )

    session.add(payment)
    session.commit()
    session.refresh(payment)

    ipaddr = request.headers.get(
        "x-forwarded-for",
        request.client.host if request.client else "127.0.0.1"
    )

    params = {
        "vnp_Version": "2.1.0",
        "vnp_Command": "pay",
        "vnp_TmnCode": VNPAY_TMN_CODE,
        "vnp_Amount": int(float(plan.price or 0) * 100),
        "vnp_CurrCode": "VND",
        "vnp_TxnRef": str(payment.id_payment),
        "vnp_OrderInfo": f"Thanh toan goi {plan.plan_name}",
        "vnp_OrderType": "other",
        "vnp_Locale": "vn",
        "vnp_ReturnUrl": _get_vnpay_return_url(request),
        "vnp_IpAddr": ipaddr,
        "vnp_CreateDate": datetime.now().strftime("%Y%m%d%H%M%S"),
    }

    params["vnp_SecureHash"] = generate_secure_hash(
        params,
        VNPAY_HASH_SECRET
    )

    payment_url = f"{VNPAY_PAYMENT_URL}?{urllib.parse.urlencode(params)}"

    return {"payment_url": payment_url}


@router.get("/ipn")
@router.get("/payment/ipn")
async def payment_ipn(
    request: Request,
    session: Session = Depends(get_session)
):
    params = dict(request.query_params)

    if not params:
        return JSONResponse({"RspCode": "99", "Message": "Invalid request"})

    if not validate_response(params.copy(), VNPAY_HASH_SECRET):
        return JSONResponse({"RspCode": "97", "Message": "Invalid signature"})

    order_id = params.get("vnp_TxnRef")
    response_code = params.get("vnp_ResponseCode")
    transaction_no = params.get("vnp_TransactionNo")
    amount = Decimal(params.get("vnp_Amount", "0")) / Decimal(100)

    payment = session.get(Payments, uuid.UUID(order_id))

    if not payment:
        return JSONResponse({"RspCode": "01", "Message": "Order not found"})

    if Decimal(str(payment.amount)) != amount:
        return JSONResponse({"RspCode": "04", "Message": "Invalid amount"})

    if payment.status == "completed":
        return JSONResponse({"RspCode": "00", "Message": "Order already confirmed"})

    if payment.status != "pending":
        return JSONResponse({"RspCode": "02", "Message": "Order not pending"})

    if response_code == "00":
        plan = session.get(SubscriptionPlans, payment.id_plan)

        if not plan:
            return JSONResponse({"RspCode": "01", "Message": "Plan not found"})

        subscription = upgrade_subscription(
            session=session,
            id_profile=payment.id_profile,
            new_plan_id=plan.id_plan,
            duration_days=plan.duration_days or 30
        )

        payment.status = "completed"
        payment.transaction_id = transaction_no
        payment.id_sub = subscription.id_sub
    else:
        payment.status = "failed"
        payment.transaction_id = transaction_no

    session.add(payment)
    session.commit()

    return JSONResponse({"RspCode": "00", "Message": "Confirm Success"})


@router.get("/vnpay_return")
@router.get("/payment/vnpay_return")
async def vnpay_return(
    request: Request,
    session: Session = Depends(get_session)
):
    params = dict(request.query_params)

    if not validate_response(params.copy(), VNPAY_HASH_SECRET):
        return HTMLResponse("Sai chữ ký")

    order_id = params.get("vnp_TxnRef")
    response_code = params.get("vnp_ResponseCode")
    transaction_no = params.get("vnp_TransactionNo")

    payment = session.get(Payments, uuid.UUID(order_id))

    if not payment:
        return HTMLResponse("Payment not found")

    if payment.status == "pending":
        if response_code == "00":
            plan = session.get(SubscriptionPlans, payment.id_plan)

            if not plan:
                return HTMLResponse("Plan not found")

            subscription = upgrade_subscription(
                session=session,
                id_profile=payment.id_profile,
                new_plan_id=plan.id_plan,
                duration_days=plan.duration_days or 30
            )

            payment.status = "completed"
            payment.transaction_id = transaction_no
            payment.id_sub = subscription.id_sub
        else:
            payment.status = "failed"
            payment.transaction_id = transaction_no

        session.add(payment)
        session.commit()

    return FileResponse(PAYMENT_RESULT_PAGE)
