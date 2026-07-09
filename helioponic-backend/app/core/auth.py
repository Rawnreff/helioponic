"""Authentication utilities — JWT, password hashing, device ownership checks.

Migrated from Go (helioponic-backend/internal/middleware/jwt.go).
"""

import logging
from datetime import datetime, timedelta, UTC
from typing import Optional, Any
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError, ExpiredSignatureError
from passlib.context import CryptContext
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.config import settings
from app.core.database import get_database

logger = logging.getLogger(__name__)

# Password hashing context (bcrypt)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Token scheme
token_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash."""
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(user_id: str, email: str) -> str:
    """Create a signed JWT access token."""
    expire = datetime.now(UTC) + timedelta(hours=settings.jwt_expiration_hours)
    to_encode = {
        "user_id": user_id,
        "email": email,
        "iss": "helioponic-backend",
        "exp": expire,
        "iat": datetime.now(UTC),
    }
    return jwt.encode(to_encode, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> Optional[dict]:
    """Decode and validate a JWT token. Returns claims dict or None."""
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except (JWTError, ExpiredSignatureError) as e:
        logger.warning(f"Token validation failed: {e}")
        return None


async def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(token_scheme),
) -> str:
    """FastAPI dependency: extract and validate user ID from JWT.

    Returns the user_id (string) or raises 401.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing authorization header",
        )

    token = credentials.credentials
    claims = decode_token(token)
    if claims is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired token",
        )

    return claims.get("user_id")


async def get_jwt_service():
    """FastAPI dependency that provides JWT service. Placeholder for future scope."""
    return {"secret": settings.jwt_secret}


async def verify_device_access(db: AsyncIOMotorDatabase, device_id: str, user_id: str):
    """Verify that the requested device belongs to the authenticated user.

    If the device_id is empty or not provided, skip check.
    """
    if not device_id:
        return

    device = await db.devices.find_one({"device_id": device_id})
    if device is None or device.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="device not accessible: this device does not belong to you",
        )
