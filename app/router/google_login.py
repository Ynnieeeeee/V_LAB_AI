from app.services.oauth_google import oauth
from fastapi import APIRouter, Request, Depends
from starlette.responses import RedirectResponse
from sqlmodel import Session, select
from app.models.base_db import engine
from app.models.profiles import Profiles
from app.utils.create_access_token import create_access_token
from app.utils.get_current_user import get_current_user
from app.utils.admin_schema import ensure_admin_schema
import uuid

router = APIRouter()

@router.get("/auth/google")
async def login_google(request: Request):
    redirect_url = request.url_for("google_callback")
    return await oauth.google.authorize_redirect(request, redirect_url)

@router.get("/auth/google/callback")
async def google_callback(request: Request):
    token = await oauth.google.authorize_access_token(request)
    user = token["userinfo"]
    email = user["email"]
    username = user["name"]
    avatar = user["picture"]

    with Session(engine) as session:
        ensure_admin_schema(session)
        session.commit()

        stmt = select(Profiles).where(Profiles.email == email)
        db_user = session.exec(stmt).first()

        if not db_user:
            db_user = Profiles(
                id_profile=uuid.uuid4(),
                username=username,
                avt_url=avatar,
                email=email,
                provider="google"
            )
            session.add(db_user)
            session.commit()

        access_token = create_access_token({
            "sub": str(db_user.id_profile)
        })

    if db_user.role == "admin":
        return RedirectResponse(
            url=f"http://127.0.0.1:8000/dashboard?token={access_token}"
        )
    else:
        return RedirectResponse(
            url=f"http://127.0.0.1:8000/?token={access_token}"
        )
    
@router.get("/auth/me")
def get_me(current_user: Profiles = Depends(get_current_user)):
    return current_user
