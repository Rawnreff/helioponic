"""Async MongoDB connection via Motor driver."""

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from app.core.config import settings

client: AsyncIOMotorClient | None = None


async def get_database() -> AsyncIOMotorDatabase:
    """Return the application database instance."""
    global client
    if client is None:
        client = AsyncIOMotorClient(settings.mongo_uri)
    return client[settings.mongo_db]


async def connect_db():
    """Initialize the MongoDB connection (called at startup)."""
    global client
    if client is None:
        client = AsyncIOMotorClient(settings.mongo_uri)
    await client.admin.command("ping")
    print(f"[INFO] Connected to MongoDB — database={settings.mongo_db}")


async def close_db():
    """Close the MongoDB connection (called at shutdown)."""
    global client
    if client:
        client.close()
        client = None
        print("[INFO] MongoDB connection closed")


async def get_collection(name: str):
    """Helper to get a collection from the application database."""
    db = await get_database()
    return db[name]


async def ensure_indexes():
    """Create required indexes for all collections."""
    db = await get_database()

    # sensor_logs indexes
    await db.sensor_logs.create_index("device_id")
    await db.sensor_logs.create_index([("recorded_at", -1)])
    await db.sensor_logs.create_index([("device_id", 1), ("recorded_at", -1)])
    # (TTL index for sensor_logs removed by user request — data retained permanently)

    # water_records indexes
    await db.water_records.create_index("device_id")
    await db.water_records.create_index([("device_id", 1), ("recorded_at", -1)])

    # device_configs indexes (also stores automation rules)
    await db.device_configs.create_index("device_id")
    await db.device_configs.create_index([("device_id", 1), ("updated_at", -1)])

    # users indexes
    await db.users.create_index("email", unique=True)

    # devices indexes
    await db.devices.create_index("device_id", unique=True)
    await db.devices.create_index("user_id")

    # notifications indexes
    await db.notifications.create_index("device_id")
    await db.notifications.create_index([("device_id", 1), ("created_at", -1)])
    await db.notifications.create_index([("device_id", 1), ("read", 1)])
    # TTL index: auto-delete old notifications after 30 days
    await db.notifications.create_index(
        [("created_at", 1)],
        expireAfterSeconds=2592000,  # 30 days
        name="notifications_ttl_30d",
    )

    # night_mode_snapshots indexes
    await db.night_mode_snapshots.create_index("device_id", unique=True)

    print("[INFO] MongoDB indexes ensured")
