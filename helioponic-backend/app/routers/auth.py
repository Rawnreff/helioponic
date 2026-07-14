"""Authentication & account management router.

Migrated from Go (helioponic-backend/internal/handlers/auth_handler.go).
"""

import logging
from datetime import datetime, timedelta, UTC
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.database import get_database
from app.core.auth import (
    hash_password, verify_password, create_access_token,
    get_current_user_id, get_jwt_service,
)
from bson.objectid import ObjectId

from app.models.auth import (
    RegisterRequest, LoginRequest, AuthResponse, UserResponse,
    UpdateProfileRequest, UpdatePasswordRequest, DeleteAccountResponse,
    ErrorResponse, Device, User,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(req: RegisterRequest, db: AsyncIOMotorDatabase = Depends(get_database)):
    """Register a new user with email, password, and initial device ID."""
    # Check if email already exists
    existing = await db.users.find_one({"email": req.email})
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="email already registered",
        )

    # Check if device_id already registered
    existing_device = await db.devices.find_one({"device_id": req.device_id})
    if existing_device:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="device ID already registered by another user",
        )

    # Hash password and create user
    hashed = hash_password(req.password)
    user_doc = {
        "email": req.email,
        "password_hash": hashed,
        "name": req.name,
        "created_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
    }
    result = await db.users.insert_one(user_doc)
    user_id = result.inserted_id

    # Create device linked to user
    device_doc = {
        "user_id": str(user_id),
        "device_id": req.device_id,
        "name": req.device_name or req.device_id,
        "is_active": True,
        "created_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
    }
    await db.devices.insert_one(device_doc)

    # Generate JWT
    token = create_access_token(str(user_id), req.email)

    logger.info(f"User registered: email={req.email}, device_id={req.device_id}")
    return AuthResponse(
        token=token,
        user=UserResponse(id=str(user_id), email=req.email, name=req.name),
    )


@router.post("/login", response_model=AuthResponse)
async def login(req: LoginRequest, db: AsyncIOMotorDatabase = Depends(get_database)):
    """Login with email and password. Returns a JWT token."""
    user = await db.users.find_one({"email": req.email})
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid email or password",
        )

    if not verify_password(req.password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid email or password",
        )

    user_id = str(user["_id"])
    token = create_access_token(user_id, req.email)

    logger.info(f"User logged in: email={req.email}")
    return AuthResponse(
        token=token,
        user=UserResponse(id=user_id, email=user["email"], name=user.get("name", "")),
    )


@router.put("/profile", response_model=UserResponse)
async def update_profile(
    req: UpdateProfileRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Update the authenticated user's name and email."""
    # Check if new email is already taken by another user
    existing = await db.users.find_one({"email": req.email})
    if existing and str(existing["_id"]) != user_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="email already in use by another account",
        )

    await db.users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {"name": req.name, "email": req.email, "updated_at": datetime.now(UTC)}},
    )

    logger.info(f"Profile updated: user_id={user_id}, email={req.email}")
    return UserResponse(id=user_id, email=req.email, name=req.name)


@router.put("/password")
async def update_password(
    req: UpdatePasswordRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Update the authenticated user's password."""
    user = await db.users.find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")

    if not verify_password(req.old_password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="current password is incorrect",
        )

    new_hashed = hash_password(req.new_password)
    await db.users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {"password_hash": new_hashed, "updated_at": datetime.now(UTC)}},
    )

    logger.info(f"Password updated: user_id={user_id}")
    return {"status": "ok", "message": "password updated successfully"}


@router.delete("/account", response_model=DeleteAccountResponse)
async def delete_account(
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Permanently delete the user account and all associated data."""
    user = await db.users.find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")

    # Find all devices belonging to this user
    device_ids = []
    async for dev in db.devices.find({"user_id": user_id}):
        device_ids.append(dev["device_id"])

    if device_ids:
        # Delete all sensor records for user's devices
        await db.sensor_logs.delete_many({"device_id": {"$in": device_ids}})
        # Delete device configs (thresholds + automation rules) for user's devices
        await db.device_configs.delete_many({"device_id": {"$in": device_ids}})
        # Delete water records for user's devices
        await db.water_records.delete_many({"device_id": {"$in": device_ids}})
        # Delete devices
        await db.devices.delete_many({"user_id": user_id})

    # Delete the user
    await db.users.delete_one({"_id": ObjectId(user_id)})

    logger.info(f"Account deleted: user_id={user_id}")
    return DeleteAccountResponse(status="ok", message="account permanently deleted")
