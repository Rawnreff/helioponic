"""Pydantic schemas for user authentication, device management & API DTOs."""

from pydantic import BaseModel, EmailStr, Field
from datetime import datetime, UTC
from typing import Optional


# ─── Database Documents ──────────────────────────────────────────────────


class User(BaseModel):
    """User document in the users collection."""
    email: str
    password_hash: str
    name: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    class Settings:
        name = "users"


class Device(BaseModel):
    """Device document in the devices collection (One-to-Many with users)."""
    user_id: int  # References User.id
    device_id: str
    name: str = ""
    is_active: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    class Settings:
        name = "devices"


# ─── Request / Response DTOs ────────────────────────────────────────────


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6)
    name: str = ""
    device_id: str = Field(..., min_length=1)
    device_name: str = ""


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class AuthResponse(BaseModel):
    token: str
    user: "UserResponse"


class UserResponse(BaseModel):
    id: str
    email: str
    name: str


class DeviceResponse(BaseModel):
    id: str
    device_id: str
    name: str
    is_active: bool
    created_at: datetime


class AddDeviceRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    name: str = ""


class UpdateProfileRequest(BaseModel):
    name: str = Field(..., min_length=1)
    email: EmailStr


class UpdatePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(..., min_length=6)


class DeleteAccountResponse(BaseModel):
    status: str = "ok"
    message: str = "account permanently deleted"


class ErrorResponse(BaseModel):
    error: str
    code: Optional[int] = None
