"""Tests for auth endpoints (Register, Login, Profile, Password, Delete Account).

Ported from Go (helioponic-backend/internal/handlers/auth_handler_test.go).
"""

import pytest
from httpx import AsyncClient

from app.core.auth import hash_password, create_access_token, verify_password
from app.models.auth import (
    RegisterRequest, LoginRequest, AuthResponse, UserResponse,
    UpdateProfileRequest, UpdatePasswordRequest,
)
from .conftest import create_test_user, create_test_device, get_auth_header


# ===========================================================================
# POST /api/v1/auth/register
# ===========================================================================

class TestRegister:
    """Tests matching Go TestRegister_Success, TestRegister_DuplicateEmail,
    TestRegister_DuplicateDeviceID, TestRegister_InvalidRequest."""

    @pytest.mark.asyncio
    async def test_register_success(self, client: AsyncClient, mock_db):
        """Go equivalent: TestRegister_Success — register with valid data."""
        response = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "newuser@example.com",
                "password": "password123",
                "name": "New User",
                "device_id": "HELIO_NEW",
                "device_name": "Test Device",
            },
        )
        assert response.status_code == 201
        data = response.json()
        assert "token" in data
        assert data["token"] != ""
        assert data["user"]["email"] == "newuser@example.com"
        assert data["user"]["name"] == "New User"
        assert data["user"]["id"] != ""

        # Verify user was created in DB
        user = await mock_db.users.find_one({"email": "newuser@example.com"})
        assert user is not None
        assert user["name"] == "New User"

        # Verify device was created
        device = await mock_db.devices.find_one({"device_id": "HELIO_NEW"})
        assert device is not None
        assert device["name"] == "Test Device"

    @pytest.mark.asyncio
    async def test_register_duplicate_email(self, client: AsyncClient, mock_db):
        """Go equivalent: TestRegister_DuplicateEmail."""
        # Pre-create a user
        await create_test_user(mock_db, email="existing@example.com")

        response = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "existing@example.com",
                "password": "password123",
                "device_id": "HELIO_002",
            },
        )
        assert response.status_code == 409
        assert response.json()["detail"] == "email already registered"

    @pytest.mark.asyncio
    async def test_register_duplicate_device_id(self, client: AsyncClient, mock_db):
        """Go equivalent: TestRegister_DuplicateDeviceID."""
        # Pre-create a user with a device
        user_id = await create_test_user(mock_db, email="user1@example.com")
        await create_test_device(mock_db, user_id, device_id="HELIO_001")

        response = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "user2@example.com",
                "password": "password123",
                "device_id": "HELIO_001",  # duplicate
            },
        )
        assert response.status_code == 409
        assert response.json()["detail"] == "device ID already registered by another user"

    @pytest.mark.asyncio
    async def test_register_invalid_request(self, client: AsyncClient):
        """Go equivalent: TestRegister_InvalidRequest — missing required fields."""
        response = await client.post(
            "/api/v1/auth/register",
            json={"name": "No Email"},  # missing email, password, device_id
        )
        assert response.status_code == 422  # FastAPI validation error


# ===========================================================================
# POST /api/v1/auth/login
# ===========================================================================

class TestLogin:
    """Tests matching Go TestLogin_Success, TestLogin_WrongPassword,
    TestLogin_UnknownEmail, TestLogin_InvalidRequest."""

    @pytest.mark.asyncio
    async def test_login_success(self, client: AsyncClient, mock_db):
        """Go equivalent: TestLogin_Success."""
        await create_test_user(mock_db, email="login@example.com", password="correctpassword", name="Login User")

        response = await client.post(
            "/api/v1/auth/login",
            json={"email": "login@example.com", "password": "correctpassword"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["token"] != ""
        assert data["user"]["email"] == "login@example.com"
        assert data["user"]["name"] == "Login User"

    @pytest.mark.asyncio
    async def test_login_wrong_password(self, client: AsyncClient, mock_db):
        """Go equivalent: TestLogin_WrongPassword."""
        await create_test_user(mock_db, email="login@example.com", password="correctpassword")

        response = await client.post(
            "/api/v1/auth/login",
            json={"email": "login@example.com", "password": "wrongpassword"},
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "invalid email or password"

    @pytest.mark.asyncio
    async def test_login_unknown_email(self, client: AsyncClient):
        """Go equivalent: TestLogin_UnknownEmail."""
        response = await client.post(
            "/api/v1/auth/login",
            json={"email": "unknown@example.com", "password": "password"},
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "invalid email or password"

    @pytest.mark.asyncio
    async def test_login_invalid_request(self, client: AsyncClient):
        """Go equivalent: TestLogin_InvalidRequest — missing fields."""
        response = await client.post(
            "/api/v1/auth/login",
            json={"foo": "bar"},
        )
        assert response.status_code == 422  # FastAPI validation


# ===========================================================================
# PUT /api/v1/auth/profile
# ===========================================================================

class TestUpdateProfile:
    """Tests matching Go TestUpdateProfile_Success, TestUpdateProfile_InvalidRequest,
    TestUpdateProfile_EmailConflict, TestUpdateProfile_SameEmailAllowed,
    TestUpdateProfile_Unauthorized."""

    @pytest.mark.asyncio
    async def test_update_profile_success(self, client: AsyncClient, mock_db):
        """Go equivalent: TestUpdateProfile_Success."""
        user_id = await create_test_user(mock_db, email="old@example.com", name="Old Name")
        headers = get_auth_header(user_id, "old@example.com")

        response = await client.put(
            "/api/v1/auth/profile",
            json={"name": "New Name", "email": "new@example.com"},
            headers=headers,
        )
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(user_id)
        assert data["name"] == "New Name"
        assert data["email"] == "new@example.com"

        # Verify DB was updated
        updated = await mock_db.users.find_one({"_id": user_id})
        assert updated["name"] == "New Name"
        assert updated["email"] == "new@example.com"

    @pytest.mark.asyncio
    async def test_update_profile_invalid_request(self, client: AsyncClient, mock_db):
        """Go equivalent: TestUpdateProfile_InvalidRequest."""
        user_id = await create_test_user(mock_db)
        headers = get_auth_header(user_id)

        response = await client.put(
            "/api/v1/auth/profile",
            json={"foo": "bar"},  # missing required fields
            headers=headers,
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_profile_email_conflict(self, client: AsyncClient, mock_db):
        """Go equivalent: TestUpdateProfile_EmailConflict."""
        user1_id = await create_test_user(mock_db, email="user1@example.com", name="User 1")
        await create_test_user(mock_db, email="user2@example.com", name="User 2")

        # User 2 tries to take User 1's email
        headers = get_auth_header(user1_id, "user1@example.com")
        response = await client.put(
            "/api/v1/auth/profile",
            json={"name": "User 1", "email": "user2@example.com"},  # already taken
            headers=headers,
        )
        assert response.status_code == 409
        assert response.json()["detail"] == "email already in use by another account"

    @pytest.mark.asyncio
    async def test_update_profile_same_email_allowed(self, client: AsyncClient, mock_db):
        """Go equivalent: TestUpdateProfile_SameEmailAllowed."""
        user_id = await create_test_user(mock_db, email="same@example.com", name="Same")
        headers = get_auth_header(user_id, "same@example.com")

        response = await client.put(
            "/api/v1/auth/profile",
            json={"name": "Same Updated", "email": "same@example.com"},  # same email
            headers=headers,
        )
        assert response.status_code == 200
        assert response.json()["name"] == "Same Updated"

    @pytest.mark.asyncio
    async def test_update_profile_unauthorized(self, client: AsyncClient):
        """Go equivalent: TestUpdateProfile_Unauthorized — no JWT."""
        response = await client.put(
            "/api/v1/auth/profile",
            json={"name": "Test", "email": "test@example.com"},
        )
        assert response.status_code == 401
        assert "missing authorization header" in response.json()["detail"]


# ===========================================================================
# PUT /api/v1/auth/password
# ===========================================================================

class TestUpdatePassword:
    """Tests matching Go TestUpdatePassword_Success, TestUpdatePassword_WrongOldPassword,
    TestUpdatePassword_InvalidRequest, TestUpdatePassword_Unauthorized."""

    @pytest.mark.asyncio
    async def test_update_password_success(self, client: AsyncClient, mock_db):
        """Go equivalent: TestUpdatePassword_Success."""
        user_id = await create_test_user(mock_db, email="pw@example.com", password="oldpass123", name="PW User")
        headers = get_auth_header(user_id, "pw@example.com")

        response = await client.put(
            "/api/v1/auth/password",
            json={"old_password": "oldpass123", "new_password": "newpass456"},
            headers=headers,
        )
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert response.json()["message"] == "password updated successfully"

        # Verify new password works
        user = await mock_db.users.find_one({"_id": user_id})
        assert verify_password("newpass456", user["password_hash"])
        assert not verify_password("oldpass123", user["password_hash"])

    @pytest.mark.asyncio
    async def test_update_password_wrong_old_password(self, client: AsyncClient, mock_db):
        """Go equivalent: TestUpdatePassword_WrongOldPassword."""
        user_id = await create_test_user(mock_db, email="wrongpw@example.com", password="correctpass")
        headers = get_auth_header(user_id, "wrongpw@example.com")

        response = await client.put(
            "/api/v1/auth/password",
            json={"old_password": "wrongpass", "new_password": "newpass456"},
            headers=headers,
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "current password is incorrect"

    @pytest.mark.asyncio
    async def test_update_password_invalid_request(self, client: AsyncClient, mock_db):
        """Go equivalent: TestUpdatePassword_InvalidRequest."""
        user_id = await create_test_user(mock_db)
        headers = get_auth_header(user_id)

        response = await client.put(
            "/api/v1/auth/password",
            json={"foo": "bar"},
            headers=headers,
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_password_unauthorized(self, client: AsyncClient):
        """Go equivalent: TestUpdatePassword_Unauthorized."""
        response = await client.put(
            "/api/v1/auth/password",
            json={"old_password": "old", "new_password": "new123456"},
        )
        assert response.status_code == 401


# ===========================================================================
# DELETE /api/v1/auth/account
# ===========================================================================

class TestDeleteAccount:
    """Tests matching Go TestDeleteAccount_Success, TestDeleteAccount_CascadeDevices,
    TestDeleteAccount_Unauthorized, TestDeleteAccount_UserNotFound."""

    @pytest.mark.asyncio
    async def test_delete_account_success(self, client: AsyncClient, mock_db):
        """Go equivalent: TestDeleteAccount_Success."""
        user_id = await create_test_user(mock_db, email="delete@example.com", name="Delete Me")
        await create_test_device(mock_db, user_id, device_id="DEL_001")
        headers = get_auth_header(user_id, "delete@example.com")

        response = await client.delete("/api/v1/auth/account", headers=headers)
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert response.json()["message"] == "account permanently deleted"

        # Verify user is gone
        user = await mock_db.users.find_one({"_id": user_id})
        assert user is None

    @pytest.mark.asyncio
    async def test_delete_account_cascade_devices(self, client: AsyncClient, mock_db):
        """Go equivalent: TestDeleteAccount_CascadeDevices."""
        user_id = await create_test_user(mock_db, email="cascade@example.com", name="Cascade")
        await create_test_device(mock_db, user_id, device_id="CAS_001")
        await create_test_device(mock_db, user_id, device_id="CAS_002")

        # Add a sensor record
        await mock_db.sensor_logs.insert_one({
            "device_id": "CAS_001",
            "recorded_at": "2026-01-01T00:00:00Z",
            "ph": 6.5,
        })

        headers = get_auth_header(user_id, "cascade@example.com")
        response = await client.delete("/api/v1/auth/account", headers=headers)
        assert response.status_code == 200

        # Verify devices deleted
        dev_count = await mock_db.devices.count_documents({"user_id": str(user_id)})
        assert dev_count == 0

        # Verify sensor records deleted
        sensor_count = await mock_db.sensor_logs.count_documents({})
        assert sensor_count == 0

        # Verify user deleted
        user = await mock_db.users.find_one({"_id": user_id})
        assert user is None

    @pytest.mark.asyncio
    async def test_delete_account_unauthorized(self, client: AsyncClient):
        """Go equivalent: TestDeleteAccount_Unauthorized."""
        response = await client.delete("/api/v1/auth/account")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_delete_account_user_not_found(self, client: AsyncClient, mock_db):
        """Go equivalent: TestDeleteAccount_UserNotFound."""
        # Use a valid token but with a syntactically valid yet non-existent ObjectId.
        # "000000000000000000000042" is a valid 24-char hex that won't match any user.
        fake_id = "000000000000000000000042"
        token = create_access_token(fake_id, "nonexistent@example.com")
        headers = {"Authorization": f"Bearer {token}"}

        response = await client.delete("/api/v1/auth/account", headers=headers)
        assert response.status_code == 404
        assert response.json()["detail"] == "user not found"
