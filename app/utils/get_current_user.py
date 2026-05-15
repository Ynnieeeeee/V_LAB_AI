from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt
from uuid import UUID

from app.config import SECRET_KEY
from sqlmodel import Session, select
from app.models.base_db import engine
from app.models.profiles import Profiles

security = HTTPBearer()

def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
):

    token = credentials.credentials

    try:

        payload = jwt.decode(
            token,
            SECRET_KEY,
            algorithms=["HS256"]
        )

        id_user = UUID(payload.get("sub"))

    except Exception:

        raise HTTPException(
            status_code=401,
            detail="Invalid token"
        )

    with Session(engine) as session:

        stmt = select(Profiles).where(
            Profiles.id_profile == id_user
        )

        user = session.exec(stmt).first()

        if not user:

            raise HTTPException(
                status_code=404,
                detail="User not found"
            )

        return user