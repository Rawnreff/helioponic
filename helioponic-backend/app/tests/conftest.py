"""Pytest fixtures for Helioponic tests.

Uses mongomock_motor for an in-memory MongoDB (no real DB needed).
FastAPI testing with httpx.AsyncClient.
"""

import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from mongomock_motor import AsyncMongoMockClient

from app.core.config import settings
from app.core.database import get_database
from app.core.auth import hash_password, create_access_token
from app.main import app


@pytest_asyncio.fixture
async def mock_db():
    """Provide a mock MongoDB database for each test."""
    client = AsyncMongoMockClient()
    db = client[settings.mongo_db]

    async def override_get_database():
        return db

    app.dependency_overrides[get_database] = override_get_database
    yield db
    app.dependency_overrides.clear()
    client.close()


@pytest_asyncio.fixture
async def client(mock_db):
    """Provide an async HTTP client against the FastAPI test app."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def create_test_user(db, email="test@example.com", password="test123", name="Test User"):
    """Insert a user directly into the mock DB and return their ObjectId."""
    hashed = hash_password(password)
    result = await db.users.insert_one({
        "email": email,
        "password_hash": hashed,
        "name": name,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    })
    return result.inserted_id


async def create_test_device(db, user_id, device_id="HELIO_TEST", name="Test Device"):
    """Insert a device linked to a user into the mock DB."""
    await db.devices.insert_one({
        "user_id": str(user_id),
        "device_id": device_id,
        "name": name,
        "is_active": True,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    })


async def create_test_device_config(db, device_id="HELIO_TEST", overrides: dict = None):
    """Insert a device config with default thresholds and automation rules."""
    config = {
        "device_id": device_id,
        "jarak_on": 105.0,
        "jarak_off": 95.0,
        "tds_on": 95.0,
        "tds_off": 105.0,
        "auto_enabled": True,
        "rule_ph": True,
        "rule_tds": True,
        "rule_water": True,
        "updated_at": "2026-01-01T00:00:00Z",
    }
    if overrides:
        config.update(overrides)
    await db.device_configs.insert_one(config)


def get_auth_header(user_id, email="test@example.com"):
    """Generate a valid Authorization header for a given user_id."""
    token = create_access_token(str(user_id), email)
    return {"Authorization": f"Bearer {token}"}


def make_sensor_payload(overrides: dict = None) -> dict:
    """Create a sensor reading payload matching the raw firmware field names."""
    payload = {
        "device_id": "HELIO_TEST",
        "ts": 1760000000,
        "jarak_cm": 15.0,
        "tds_value": 200.0,
        "current_ph": 6.5,
        "pompa1": 1,
        "pompa2": 0,
        "pompa3": 0,
        "pompa4": 0,
    }
    if overrides:
        payload.update(overrides)
    return payload
