"""Helioponic Backend — FastAPI Application Factory & Entrypoint.

Realigned to match raw firmware architecture:
  - Sensor payload uses hardware-native field names (jarak_cm, tds_value, current_ph, pompa1, pompa2)
  - Device config sync (JARAK_ON/OFF, TDS_ON/OFF) via MQTT downlink
  - WebSocket broadcasting of the same field names
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.database import connect_db, close_db, ensure_indexes
from app.services.water import WaterCalculator
from app.mqtt.subscriber import MQTTSubscriber
from app.routers.websocket import hub

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Global MQTT client reference
mqtt_subscriber: MQTTSubscriber | None = None

    # ── WebSocket broadcast callbacks ───────────────────────────────────────

async def _broadcast_sensor_reading(reading_data: dict):
    """Callback from MQTT subscriber to broadcast sensor data via WebSocket."""
    await hub.broadcast(reading_data)


async def _broadcast_alarm(alarm_data: dict):
    """Callback from MQTT subscriber to broadcast alarm events via WebSocket."""
    await hub.broadcast(alarm_data)


async def _broadcast_status(status_data: dict):
    """Callback from MQTT subscriber to broadcast device status via WebSocket."""
    await hub.broadcast(status_data)


# ── Database persistence callbacks ─────────────────────────────────────

async def _save_sensor(record: dict):
    from app.core.database import get_database
    db = await get_database()
    await db.sensor_logs.insert_one(record)


async def _save_water(record: dict):
    from app.core.database import get_database
    db = await get_database()
    await db.water_records.insert_one(record)


# ── MQTT downlink publish callback (used by devices router) ────────────

async def _publish_downlink(config_payload: dict):
    """Callback from devices router to publish config via MQTT."""
    global mqtt_subscriber
    if mqtt_subscriber:
        await mqtt_subscriber.publish_downlink(config_payload)


# ── Application Lifecycle ──────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle: startup & shutdown."""
    global mqtt_subscriber

    # ── Startup ────────────────────────────────────────────────────
    logger.info("Starting Helioponic Backend...")
    await connect_db()
    await ensure_indexes()

    # Initialize services
    water_calc = WaterCalculator()

    # Initialize MQTT subscriber
    try:
        mqtt_subscriber = MQTTSubscriber(
            water_calc=water_calc,
            on_sensor_reading=_broadcast_sensor_reading,
        )
        mqtt_subscriber.save_sensor = _save_sensor
        mqtt_subscriber.save_water = _save_water

        # Wire notification persistence callback
        async def _save_notification(notif: dict):
            from app.core.database import get_database
            db = await get_database()
            await db.notifications.insert_one(notif)

        mqtt_subscriber.save_notification = _save_notification

        # Wire device config fetcher for threshold automation in MQTT path
        async def _get_device_config(device_id: str) -> dict | None:
            from app.core.database import get_database
            db = await get_database()
            config = await db.device_configs.find_one(
                {"device_id": device_id},
                sort=[("updated_at", -1)],
            )
            return config

        mqtt_subscriber.get_device_config = _get_device_config

        # Wire alarm & status broadcast callbacks
        mqtt_subscriber.on_alarm = _broadcast_alarm
        mqtt_subscriber.on_status = _broadcast_status

        await mqtt_subscriber.connect()
        logger.info("MQTT subscriber connected and listening")
    except Exception as e:
        logger.warning(f"MQTT not available: {e}. Downlink publishing disabled.")

    # Wire downlink callback into devices router
    from app.routers import devices as devices_router
    devices_router.mqtt_publish_downlink = _publish_downlink

    # Wire callbacks into analytics router
    from app.routers import analytics as analytics_router

    # WebSocket broadcast — independent of MQTT, always wire it
    analytics_router.websocket_broadcast = _broadcast_sensor_reading

    # MQTT actuator publish — only if MQTT subscriber is available
    if mqtt_subscriber:
        analytics_router.mqtt_actuator_publish = mqtt_subscriber.publish_actuator

    # Wire night mode publish callback into night_mode router
    async def _publish_night_mode(night_mode_payload: dict):
        """Callback from night mode router to publish via MQTT night_mode topic."""
        if mqtt_subscriber:
            await mqtt_subscriber.publish_night_mode(night_mode_payload)

    from app.routers import night_mode as night_mode_router
    night_mode_router.mqtt_publish_downlink = _publish_night_mode

    # ── Hysteresis state reset on config change ────────────────────────────
    # Wire callbacks so that when the mobile app updates thresholds via
    # PUT /devices/config, the automation engine resets its hysteresis state
    # and re-evaluates with fresh state.
    async def _reset_notif_state(device_id: str):
        from app.routers import analytics as analytics_router
        analytics_router.reset_notif_state(device_id)

    async def _reset_subscriber_state(device_id: str):
        if mqtt_subscriber:
            mqtt_subscriber.reset_state(device_id)

    devices_router.reset_subscriber_state = _reset_subscriber_state
    devices_router.reset_notif_state = _reset_notif_state

    logger.info(f"Server starting on port {settings.server_port}")
    yield

    # ── Shutdown ────────────────────────────────────────────────────
    logger.info("Shutting down Helioponic Backend...")
    if mqtt_subscriber:
        await mqtt_subscriber.disconnect()
    await close_db()


# ── FastAPI Application ────────────────────────────────────────────────

app = FastAPI(
    title="Helioponic Backend",
    description="Smart hydroponic monitoring — REST API, WebSocket & MQTT backend",
    version="3.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS middleware — allow all origins during development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Router Registration ────────────────────────────────────────────────

from app.routers import analytics, auth, devices, websocket, night_mode

API_PREFIX = "/api/v1"

app.include_router(analytics.router, prefix=API_PREFIX)
app.include_router(auth.router, prefix=API_PREFIX)
app.include_router(devices.router, prefix=API_PREFIX)
app.include_router(websocket.router)
app.include_router(night_mode.router, prefix=API_PREFIX)


# ── Direct entry point (for debugging) ─────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.server_port,
        reload=True,
        log_level=settings.log_level.lower(),
    )
