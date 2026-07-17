"""
Analytics & data router — sensor, water, actuator endpoints.

All endpoints use the raw firmware field names (jarak_cm, tds_value, current_ph, pompa1, pompa2, pompa3, pompa4).
"""

import logging
import csv
import io
from datetime import datetime, timedelta, timezone, UTC
from typing import Optional, AsyncGenerator
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from bson.objectid import ObjectId

from app.core.database import get_database
from app.core.auth import get_current_user_id, verify_device_access
from pydantic import BaseModel, Field

from app.models.sensor import SensorReading
from app.models.water import WaterRecord
from app.services.automation import evaluate_thresholds

logger = logging.getLogger(__name__)
router = APIRouter(tags=["analytics"])

# Global references (set by main.py)
mqtt_actuator_publish = None
websocket_broadcast = None  # async callable for WebSocket hub.broadcast()



# ─── Health ─────────────────────────────────────────────────────────────

@router.get("/health")
async def health():
    """Public health check endpoint."""
    return {"status": "ok", "service": "helioponic-backend"}


# ─── Sensors ────────────────────────────────────────────────────────────

@router.get("/sensors/available-dates")
async def get_available_dates(
    device_id: str = Query("HELIO_001"),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return distinct dates (YYYY-MM-DD) that have sensor data for a device.

    Used by the mobile app's date picker to only enable dates with data.
    Performs a simple aggregation on recorded_at field.
    """
    await verify_device_access(db, device_id, user_id)

    pipeline = [
        {"$match": {"device_id": device_id}},
        {"$group": {
            "_id": {
                "$dateToString": {"format": "%Y-%m-%d", "date": "$recorded_at"}
            },
        }},
        {"$sort": {"_id": 1}},
    ]

    try:
        cursor = db.sensor_logs.aggregate(pipeline)
        dates = [doc["_id"] async for doc in cursor]
    except Exception:
        # Fallback: if $dateToString doesn't work (older MongoDB), use projection
        dates = []
        cursor = db.sensor_logs.find(
            {"device_id": device_id},
            {"recorded_at": 1},
        ).sort("recorded_at", 1)
        seen: set[str] = set()
        async for doc in cursor:
            if doc.get("recorded_at"):
                d = doc["recorded_at"]
                if hasattr(d, "strftime"):
                    date_str = d.strftime("%Y-%m-%d")
                else:
                    date_str = str(d)[:10]
                if date_str not in seen:
                    seen.add(date_str)
                    dates.append(date_str)

    return {"dates": dates, "count": len(dates)}


@router.get("/sensors/latest")
async def get_latest_sensor(
    device_id: str = Query("HELIO_001"),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return the most recent sensor reading for a device."""
    await verify_device_access(db, device_id, user_id)

    record = await db.sensor_logs.find_one(
        {"device_id": device_id},
        sort=[("recorded_at", -1)],
    )
    if not record:
        return {"message": "no sensor data yet"}
    return _format_sensor_record(record)


@router.get("/sensors/history")
async def get_sensor_history(
    from_date: str = Query(default=None),
    to_date: str = Query(default=None),
    device_id: str = Query("HELIO_001"),
    limit: int = Query(100, ge=1, le=25000),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return historical sensor readings within a time range."""
    await verify_device_access(db, device_id, user_id)

    now = datetime.now(UTC)
    from_dt = datetime.fromisoformat(from_date) if from_date else now - timedelta(hours=24)
    to_dt = datetime.fromisoformat(to_date) if to_date else now

    cursor = db.sensor_logs.find({
        "device_id": device_id,
        "recorded_at": {"$gte": from_dt, "$lte": to_dt},
    }).sort("recorded_at", -1).limit(limit)

    records = [_format_sensor_record(r) async for r in cursor]
    return {"data": records, "count": len(records)}


# ─── Water ──────────────────────────────────────────────────────────────

@router.get("/water/summary")
async def get_water_summary(
    device_id: str = Query("HELIO_001"),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return the latest water level reading from water_records."""
    await verify_device_access(db, device_id, user_id)

    record = await db.water_records.find_one(
        {"device_id": device_id},
        sort=[("recorded_at", -1)],
    )
    if not record:
        return {"water_level_pct": 0, "jarak_cm": 0}
    return {
        "water_level_pct": record.get("water_level_pct", 0),
        "jarak_cm": record.get("jarak_cm", 0),
    }


@router.get("/water/history")
async def get_water_history(
    from_date: str = Query(default=None),
    to_date: str = Query(default=None),
    device_id: str = Query("HELIO_001"),
    limit: int = Query(100, ge=1, le=1000),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return historical water level data for charts.

    Reads from the water_records collection (populated by MQTT subscriber)
    and returns jarak_cm + computed water_level_pct for each record.
    """
    await verify_device_access(db, device_id, user_id)

    now = datetime.now(UTC)
    from_dt = datetime.fromisoformat(from_date) if from_date else now - timedelta(hours=24)
    to_dt = datetime.fromisoformat(to_date) if to_date else now

    cursor = db.water_records.find({
        "device_id": device_id,
        "recorded_at": {"$gte": from_dt, "$lte": to_dt},
    }).sort("recorded_at", -1).limit(limit)

    records = [_format_water_record(r) async for r in cursor]
    return {"data": records, "count": len(records)}


# ─── Actuator ───────────────────────────────────────────────────────────

class ActuatorRequest(BaseModel):
    """JSON body for pump control — matches ESP32 actuator downlink handler."""
    pump: str = Field(..., pattern="^(pompa1|pompa2|pompa3|pompa4|circ|ph_d|nut_a|nut_b)$")
    state: int = Field(..., ge=0, le=1)
    device_id: str = "HELIO_001"


@router.post("/actuators/pump")
async def control_pump(
    req: ActuatorRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Control a pump relay (0=OFF, 1=ON) and save to sensor_logs.

    Also publishes to MQTT helioponic/actuator/downlink (QoS 1)
    so the ESP32 receives the command and forwards it to Arduino.

    Accepts JSON body with pump names matching either:
      - Raw firmware: pompa1, pompa2
      - Legacy naming: circ, ph_d
    """
    device_id = req.device_id
    pump = req.pump
    state = req.state

    now = datetime.now(UTC)

    # Map pump name to field in the database
    if pump in ("pompa1", "circ"):
        pump_field = "pompa1"
    elif pump in ("pompa2", "ph_d"):
        pump_field = "pompa2"
    elif pump in ("pompa3", "nut_a"):
        pump_field = "pompa3"
    elif pump in ("pompa4", "nut_b"):
        pump_field = "pompa4"
    else:
        raise HTTPException(status_code=400, detail=f"Unknown pump: {pump}")

    # Fetch latest reading to preserve other fields
    latest = await db.sensor_logs.find_one(
        {"device_id": device_id}, sort=[("recorded_at", -1)]
    )

    record = {
        "device_id": device_id,
        "recorded_at": now,
        "jarak_cm": latest.get("jarak_cm", 999) if latest else 999,
        "tds_value": latest.get("tds_value", 0) if latest else 0,
        "current_ph": latest.get("current_ph", 0) if latest else 0,
        "pompa1": latest.get("pompa1", 0) if latest else 0,
        "pompa2": latest.get("pompa2", 0) if latest else 0,
        "pompa3": latest.get("pompa3", 0) if latest else 0,
        "pompa4": latest.get("pompa4", 0) if latest else 0,
    }

    record[pump_field] = state
    await db.sensor_logs.insert_one(record)

    # Publish actuator command via MQTT to reach ESP32
    if mqtt_actuator_publish:
        await mqtt_actuator_publish(pump, state)

    # Fetch auto_enabled & night_mode for WebSocket broadcast
    config = await db.device_configs.find_one(
        {"device_id": device_id},
        sort=[("updated_at", -1)],
    )
    from app.services.automation import get_automation_rules
    auto_rules = get_automation_rules(config or {})
    auto_enabled = auto_rules.get("auto_enabled", True)
    is_night = False
    try:
        snap = await db.night_mode_snapshots.find_one({"device_id": device_id})
        is_night = bool(snap and snap.get("active"))
    except Exception:
        pass

    # Broadcast updated pump state to WebSocket clients
    if websocket_broadcast:
        ws_data = {
            "type": "sensor_update",
            "device_id": device_id,
            "ts": int(now.timestamp()),
            "jarak_cm": record.get("jarak_cm", 999),
            "tds_value": record.get("tds_value", 0),
            "current_ph": record.get("current_ph", 0),
            "pompa1": record.get("pompa1", 0),
            "pompa2": record.get("pompa2", 0),
            "pompa3": record.get("pompa3", 0),
            "pompa4": record.get("pompa4", 0),
            "night_mode": is_night,
            "auto_enabled": auto_enabled,
            "recorded_at": now.isoformat(),
        }
        await websocket_broadcast(ws_data)

    logger.info(f"Pump control: device_id={device_id}, pump={pump}, state={state}")
    return {"status": "ok", "pump": pump, "state": state}


# ─── POST /sensors/reading (public, for IoT simulation) ─────────────────
# NOTE: Ingestion throttle (2-min) is ONLY applied in the MQTT subscriber
# because MQTT receives data every 1-5 seconds. The REST endpoint is called
# by ESP32 every 5 minutes or by seed scripts — naturally throttled by sender.

@router.post("/sensors/reading")
async def post_sensor_reading(
    reading: SensorReading,
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Accept a sensor reading (from simulator or ESP32) via REST.

    Persists every reading AS-IS. Ingestion throttle is ONLY in MQTT subscriber.
    Also creates auto_mode notifications on pump state changes.
    """
    device_id = reading.device_id or "HELIO_001"
    now = datetime.now(UTC)

    # Fetch latest device config for threshold evaluation (READ-ONLY, notification only)
    config = await db.device_configs.find_one(
        {"device_id": device_id},
        sort=[("updated_at", -1)],
    )
    config_dict = config or {}

    # UNIFIED INGESTION: ALL telemetry (ESP32 or simulator) is Source of Truth.
    # Backend persists pump states EXACTLY as reported — NEVER computes/overrides.
    is_night = False
    try:
        snap = await db.night_mode_snapshots.find_one({"device_id": device_id})
        is_night = bool(snap and snap.get("active"))
    except Exception:
        pass

    # Extract auto_enabled from config for WebSocket broadcast
    from app.services.automation import get_automation_rules
    auto_rules = get_automation_rules(config_dict)
    auto_enabled = auto_rules.get("auto_enabled", True)

    # Persist sensor record AS-IS (source of truth)
    # Include the original sensor timestamp (ts) alongside server recorded_at
    record = {
        "device_id": device_id,
        "ts": reading.ts,
        "recorded_at": now,
        "jarak_cm": reading.jarak_cm,
        "tds_value": reading.tds_value,
        "current_ph": reading.current_ph,
        "pompa1": reading.pompa1,
        "pompa2": reading.pompa2,
        "pompa3": reading.pompa3,
        "pompa4": reading.pompa4,
    }
    await db.sensor_logs.insert_one(record)

    logger.debug(
        f"REST: device={device_id} jarak={reading.jarak_cm} tds={reading.tds_value} "
        f"→ p1={reading.pompa1} p2={reading.pompa2} p3={reading.pompa3} p4={reading.pompa4} (persisted AS-IS)"
    )

    # NOTIFICATIONS are created ONLY by the MQTT subscriber (primary ingestion path).
    # The REST endpoint is a fallback for data persistence only — skipping notification
    # creation here prevents DUPLICATE notifications (same reading processed twice).

    # Broadcast to WebSocket clients
    if websocket_broadcast:
        from app.services.water import WaterCalculator
        water_calc = WaterCalculator()
        broadcast_data = {
            "type": "sensor_update",
            "device_id": device_id,
            "ts": reading.ts,
            "jarak_cm": reading.jarak_cm,
            "tds_value": reading.tds_value,
            "current_ph": reading.current_ph,
            "pompa1": reading.pompa1,
            "pompa2": reading.pompa2,
            "pompa3": reading.pompa3,
            "pompa4": reading.pompa4,
            "water_level_pct": water_calc.jarak_to_water_level_pct(reading.jarak_cm),
            "night_mode": is_night,
            "auto_enabled": auto_enabled,
            "recorded_at": now.isoformat(),
        }
        await websocket_broadcast(broadcast_data)

    logger.info(f"Sensor reading saved for device {device_id}")
    return {
        "status": "ok",
        "message": "sensor reading saved",
        "pumps_reported": {
            "pompa1": reading.pompa1,
            "pompa2": reading.pompa2,
            "pompa3": reading.pompa3,
            "pompa4": reading.pompa4,
        },
    }


# ─── CSV Export (simple, all raw data) ───────────────────────────────

CSV_HEADERS = [
    "Timestamp", "pH", "TDS (ppm)", "Water Distance (cm)",
    "Water Level (%)", "Pompa1", "Pompa2", "Pompa3", "Pompa4",
]


@router.get("/sensors/export")
async def export_sensor_csv(
    range: str = Query("daily", pattern="^(daily|weekly|monthly)$"),
    device_id: str = Query("HELIO_001"),
    from_date: str = Query(default=None),
    to_date: str = Query(default=None),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Export ALL raw sensor data as CSV for a given time range.

    - If `from_date` and `to_date` are provided, exports data in that range.
    - Otherwise uses `range` parameter:
      - `daily`   → entire current calendar day (00:00 – 23:59)
      - `weekly`  → last 7 full days
      - `monthly` → last 30 full days

    No downsampling — every stored record is included.
    """
    await verify_device_access(db, device_id, user_id)

    now = datetime.now(UTC)

    # Compute time range with proper day boundaries
    if from_date and to_date:
        # from_date and to_date are full ISO strings from the frontend
        from_dt = datetime.fromisoformat(from_date)
        to_dt = datetime.fromisoformat(to_date)
    else:
        # Use start-of-day boundaries for predictable results
        start_of_today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        if range == "daily":
            from_dt = start_of_today
            to_dt = start_of_today + timedelta(days=1) - timedelta(microseconds=1)
        elif range == "weekly":
            from_dt = start_of_today - timedelta(days=7)
            to_dt = start_of_today + timedelta(days=1) - timedelta(microseconds=1)
        else:
            from_dt = start_of_today - timedelta(days=30)
            to_dt = start_of_today + timedelta(days=1) - timedelta(microseconds=1)

    # Simple raw-data cursor — no aggregation, no downsampling
    cursor = db.sensor_logs.find(
        {
            "device_id": device_id,
            "recorded_at": {"$gte": from_dt, "$lte": to_dt},
        },
        {
            "recorded_at": 1,
            "current_ph": 1,
            "tds_value": 1,
            "jarak_cm": 1,
            "pompa1": 1, "pompa2": 1, "pompa3": 1, "pompa4": 1,
        },
    ).sort("recorded_at", 1)

    # ── Async generator: yields CSV row strings ────────────────────
    async def csv_stream() -> AsyncGenerator[str, None]:
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(CSV_HEADERS)
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate()

        WATER_TANK_CM = 7.0

        async for doc in cursor:
            ts = doc.get("recorded_at")
            ts_str = ts.strftime("%b %d, %I:%M:%S %p") if ts else ""

            ph = doc.get("current_ph", 0) or 0
            tds = doc.get("tds_value", 0) or 0
            jarak = doc.get("jarak_cm", 0) or 0

            # Compute water level pct (7cm tank)
            if jarak >= 999 or jarak < 0:
                water_pct = 0
            else:
                water_depth = WATER_TANK_CM - min(jarak, WATER_TANK_CM)
                water_pct = round(max(0, min(100, (water_depth / WATER_TANK_CM) * 100)))

            p1 = int(doc.get("pompa1", 0) or 0)
            p2 = int(doc.get("pompa2", 0) or 0)
            p3 = int(doc.get("pompa3", 0) or 0)
            p4 = int(doc.get("pompa4", 0) or 0)

            writer.writerow([
                ts_str,
                f"{ph:.1f}",
                f"{tds:.0f}",
                f"{jarak:.1f}",
                str(water_pct),
                str(p1), str(p2), str(p3), str(p4),
            ])
            yield buf.getvalue()
            buf.seek(0)
            buf.truncate()

    filename = f"helioponic_{range}_{now.strftime('%Y-%m-%d')}.csv"
    return StreamingResponse(
        csv_stream(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


# ─── Notifications ─────────────────────────────────────────────────────


@router.get("/notifications")
async def get_notifications(
    device_id: str = Query("HELIO_001"),
    limit: int = Query(20, ge=1, le=100),
    unread_only: bool = Query(False),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return notifications for a device, newest first."""
    await verify_device_access(db, device_id, user_id)

    query = {"device_id": device_id}
    if unread_only:
        query["read"] = False

    cursor = db.notifications.find(query).sort("created_at", -1).limit(limit)
    notifications = [_format_notification(n) async for n in cursor]
    return {"data": notifications, "count": len(notifications)}


@router.get("/notifications/unread-count")
async def get_unread_notification_count(
    device_id: str = Query("HELIO_001"),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return the total count of unread notifications.

    Uses MongoDB count_documents for accurate counting (not limited by fetch limit).
    """
    await verify_device_access(db, device_id, user_id)
    count = await db.notifications.count_documents({
        "device_id": device_id,
        "read": False,
    })
    return {"unread_count": count}


@router.patch("/notifications/{notification_id}/read")
async def mark_notification_read(
    notification_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Mark a single notification as read.

    Verifies the notification's device_id belongs to the current user
    before marking as read, to prevent cross-user access.
    """
    notification = await db.notifications.find_one({"_id": ObjectId(notification_id)})
    if not notification:
        raise HTTPException(status_code=404, detail="notification not found")

    # Verify device ownership before allowing read-mark
    notif_device_id = notification.get("device_id", "")
    if notif_device_id:
        await verify_device_access(db, notif_device_id, user_id)

    result = await db.notifications.update_one(
        {"_id": ObjectId(notification_id)},
        {"$set": {"read": True, "read_at": datetime.now(UTC)}},
    )
    return {"status": "ok", "notification_id": notification_id}


@router.patch("/notifications/read-all")
async def mark_all_notifications_read(
    device_id: str = Query("HELIO_001"),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Mark all notifications for a device as read."""
    await verify_device_access(db, device_id, user_id)
    result = await db.notifications.update_many(
        {"device_id": device_id, "read": False},
        {"$set": {"read": True, "read_at": datetime.now(UTC)}},
    )
    return {"status": "ok", "marked_count": result.modified_count}


def _format_notification(n: dict) -> dict:
    return {
        "id": str(n["_id"]),
        "type": n.get("type", "auto_mode"),
        "title": n.get("title", ""),
        "message": n.get("message", ""),
        "priority": n.get("priority", "medium"),
        "read": n.get("read", False),
        "read_at": _fmt_iso(n.get("read_at")),
        "timestamp": _fmt_iso(n.get("created_at")),
        "created_at": _fmt_iso(n.get("created_at")),
        "device_id": n.get("device_id", ""),
    }


# ─── REST Notification Helper ───────────────────────────────────────────

# NOTE: Notification creation has been REMOVED from the REST path.
# The MQTT subscriber is the primary notification engine — it processes
# every incoming sensor reading and creates notifications with proper
# dedup and cooldowns. The REST path only persists data and broadcasts
# via WebSocket.
#
# If MQTT is unavailable (fallback scenario), notifications are not created.
# This is acceptable because the REST endpoint is only used by the simulator
# as a secondary fallback — real ESP32 devices use MQTT exclusively.

# Keep reset_notif_state for devices.py compatibility (called on threshold update)
_rest_notif_state: dict[str, dict] = {}  # device_id -> {p1, p2, p3, p4, last_notif}


def reset_notif_state(device_id: str):
    """Reset the REST notification state for a device.

    Kept for devices.py backward compatibility — notifications are now
    created exclusively by the MQTT subscriber.
    """
    if device_id in _rest_notif_state:
        del _rest_notif_state[device_id]
        logger.info(f"Reset REST notification state for device {device_id}")


# ─── Helpers ────────────────────────────────────────────────────────────

def _fmt_iso(dt: datetime | None) -> str | None:
    """Format a datetime to ISO string, always including timezone (Z for UTC).

    MongoDB's Motor driver may return naive datetime objects even though
    they represent UTC. Without timezone info, JavaScript's new Date()
    misinterprets the string as LOCAL time instead of UTC, causing
    timestamp shifts by the user's timezone offset (e.g. +7 hours for WIB).
    This helper ensures the output always has timezone info.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _format_sensor_record(record: dict) -> dict:
    """Format a MongoDB sensor_logs document for API response."""
    return {
        "id": str(record["_id"]),
        "device_id": record.get("device_id", ""),
        "ts": record.get("ts", 0),
        "recorded_at": _fmt_iso(record.get("recorded_at")),
        "jarak_cm": record.get("jarak_cm", 999),
        "tds_value": record.get("tds_value", 0),
        "current_ph": record.get("current_ph", 0),
        "pompa1": record.get("pompa1", 0),
        "pompa2": record.get("pompa2", 0),
        "pompa3": record.get("pompa3", 0),
        "pompa4": record.get("pompa4", 0),
    }


def _format_water_record(record: dict) -> dict:
    """Format a MongoDB water_records document for API response.

    Validates through WaterRecord model for type safety.
    """
    validated = WaterRecord.model_validate(record)
    return {
        "id": str(record["_id"]),
        "device_id": validated.device_id,
        "recorded_at": _fmt_iso(validated.recorded_at),
        "jarak_cm": validated.jarak_cm,
        "water_level_pct": validated.water_level_pct,
    }
