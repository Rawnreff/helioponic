"""
Analytics & data router — sensor, energy, water, actuator endpoints.

All endpoints use the raw firmware field names (jarak_cm, tds_value, current_ph, pompa1, pompa2).
"""

import logging
from datetime import datetime, timedelta, UTC
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from bson.objectid import ObjectId

from app.core.database import get_database
from app.core.auth import get_current_user_id, verify_device_access
from pydantic import BaseModel, Field

from app.models.sensor import SensorReading
from app.models.energy import EnergyRecord
from app.models.water import WaterRecord
from app.services.automation import evaluate_thresholds
from app.services.energy import EnergyCalculator

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
    limit: int = Query(100, ge=1, le=1000),
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


# ─── Energy ─────────────────────────────────────────────────────────────

@router.get("/energy/summary")
async def get_energy_summary(
    device_id: str = Query("HELIO_001"),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return aggregated energy totals for today."""
    await verify_device_access(db, device_id, user_id)

    start_of_day = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    pipeline = [
        {"$match": {"device_id": device_id, "recorded_at": {"$gte": start_of_day}}},
        {"$group": {
            "_id": None,
            "pompa1_wh": {"$sum": "$pompa1_wh"},
            "pompa2_wh": {"$sum": "$pompa2_wh"},
            "total_wh": {"$sum": "$total_wh"},
        }},
    ]
    result = await db.energy_records.aggregate(pipeline).to_list(1)
    if not result:
        return {"pompa1_wh": 0, "pompa2_wh": 0, "total_wh": 0}
    summary = result[0]
    del summary["_id"]
    return summary


@router.get("/energy/history")
async def get_energy_history(
    from_date: str = Query(default=None),
    to_date: str = Query(default=None),
    device_id: str = Query("HELIO_001"),
    limit: int = Query(100, ge=1, le=1000),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return historical energy data for charts."""
    await verify_device_access(db, device_id, user_id)

    now = datetime.now(UTC)
    from_dt = datetime.fromisoformat(from_date) if from_date else now - timedelta(hours=24)
    to_dt = datetime.fromisoformat(to_date) if to_date else now

    cursor = db.energy_records.find({
        "device_id": device_id,
        "recorded_at": {"$gte": from_dt, "$lte": to_dt},
    }).sort("recorded_at", -1).limit(limit)

    records = [_format_energy_record(r) async for r in cursor]
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
    pump: str = Field(..., pattern="^(pompa1|pompa2|circ|ph_d)$")
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
    }

    record[pump_field] = state
    await db.sensor_logs.insert_one(record)

    # Publish actuator command via MQTT to reach ESP32
    if mqtt_actuator_publish:
        await mqtt_actuator_publish(pump, state)

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
            "recorded_at": now.isoformat(),
        }
        await websocket_broadcast(ws_data)

    logger.info(f"Pump control: device_id={device_id}, pump={pump}, state={state}")
    return {"status": "ok", "pump": pump, "state": state}


# ─── POST /sensors/reading (public, for IoT simulation) ─────────────────

@router.post("/sensors/reading")
async def post_sensor_reading(
    reading: SensorReading,
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Accept a sensor reading (from simulator or ESP32) via REST.

    Applies threshold automation and persists to sensor_logs.
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

    # ⚠️  DESIGN RULE: ESP32 pump states are SOURCE OF TRUTH — persist AS-IS.
    # evaluate_thresholds() is used READ-ONLY for notification detection.
    actual_pompa1 = reading.pompa1
    actual_pompa2 = reading.pompa2

    # Persist the ESP32's ACTUAL pump states (NEVER override with backend computation)
    record = {
        "device_id": device_id,
        "recorded_at": now,
        "jarak_cm": reading.jarak_cm,
        "tds_value": reading.tds_value,
        "current_ph": reading.current_ph,
        "pompa1": actual_pompa1,
        "pompa2": actual_pompa2,
    }
    await db.sensor_logs.insert_one(record)

    # Check night mode before creating notifications
    from app.core.database import get_database
    is_night = False
    try:
        snap = await db.night_mode_snapshots.find_one({"device_id": device_id})
        is_night = bool(snap and snap.get("active"))
    except Exception:
        pass

    # Threshold evaluation for NOTIFICATIONS ONLY (read-only, never mutates DB)
    if not is_night and config_dict:
        desired_p1, desired_p2 = evaluate_thresholds(
            reading.jarak_cm,
            reading.tds_value,
            config_dict,
            actual_pompa1,
            actual_pompa2,
        )
        # Detect pump state transitions from ESP32's reported actual values
        await _create_rest_notification(
            db, device_id, actual_pompa1, actual_pompa2,
            desired_p1, desired_p2, now
        )
        # Detect threshold violations (jarak/tds approaching limits)
        await _create_rest_threshold_warnings(
            db, device_id, reading.jarak_cm, reading.tds_value, config_dict, now
        )

    # Compute energy deltas (using actual pump states)
    prev_record = await db.sensor_logs.find_one(
        {"device_id": device_id},
        sort=[("recorded_at", -1)],
        skip=1,
    )
    if prev_record and prev_record.get("recorded_at"):
        prev_ts = prev_record["recorded_at"]
        if isinstance(prev_ts, str):
            prev_ts = prev_ts.replace("Z", "+00:00")
            prev_ts = datetime.fromisoformat(prev_ts)
        # Make sure both datetimes are offset-aware (UTC) for subtraction
        if prev_ts.tzinfo is None:
            prev_ts = prev_ts.replace(tzinfo=UTC)
        elapsed = (now - prev_ts).total_seconds()
        if elapsed > 60.0:
            elapsed = 1.0
        elif elapsed < 0.5:
            elapsed = 1.0

        energy_calc = EnergyCalculator()
        wh = energy_calc.calculate_total_pump_wh(actual_pompa1, actual_pompa2, elapsed)
        energy_record = EnergyRecord(
            device_id=device_id,
            recorded_at=now,
            pompa1_wh=wh["pompa1_wh"],
            pompa2_wh=wh["pompa2_wh"],
            total_wh=wh["total_wh"],
        )
        await db.energy_records.insert_one(energy_record.model_dump())

    # Broadcast to WebSocket clients (REST fallback path, actual pump states)
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
            "pompa1": actual_pompa1,
            "pompa2": actual_pompa2,
            "water_level_pct": water_calc.jarak_to_water_level_pct(reading.jarak_cm),
            "night_mode": is_night,
            "recorded_at": now.isoformat(),
        }
        await websocket_broadcast(broadcast_data)

    logger.info(f"Sensor reading saved for device {device_id}")
    return {
        "status": "ok",
        "message": "sensor reading saved",
        "pumps_reported": {"pompa1": actual_pompa1, "pompa2": actual_pompa2},
    }


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
        "read_at": n.get("read_at").isoformat() if n.get("read_at") else None,
        "timestamp": n.get("created_at").isoformat() if n.get("created_at") else None,
        "created_at": n.get("created_at").isoformat() if n.get("created_at") else None,
        "device_id": n.get("device_id", ""),
    }


# ─── REST Notification Helper ───────────────────────────────────────────

# Track previous pump states for REST path notification (per device)
_rest_notif_state: dict[str, dict] = {}  # device_id -> {p1, p2, last_notif}


async def _create_rest_notification(
    db: AsyncIOMotorDatabase,
    device_id: str,
    actual_p1: int,
    actual_p2: int,
    desired_p1: int,
    desired_p2: int,
    now: datetime,
):
    """Create auto_mode notification via REST path (fallback when MQTT is down).

    Tracks ACTUAL hardware pump states (from ESP32), not backend-computed states.
    Also detects if hardware state differs from threshold-desired state (alert).
    Uses cooldown-based dedup (5 seconds) to prevent spam.
    """
    prev = _rest_notif_state.get(device_id)
    if prev is None:
        # First reading for this device — initialize and skip
        _rest_notif_state[device_id] = {"p1": actual_p1, "p2": actual_p2, "last": now}
        return

    p1_changed = prev["p1"] != actual_p1
    p2_changed = prev["p2"] != actual_p2

    # Update state
    prev["p1"] = actual_p1
    prev["p2"] = actual_p2

    if not p1_changed and not p2_changed:
        return

    # Cooldown check (5 seconds)
    elapsed = (now - prev["last"]).total_seconds()
    if elapsed < 5.0:
        return

    prev["last"] = now

    # Build notification with actual hardware states
    p1_label = "ON" if actual_p1 else "OFF"
    p2_label = "ON" if actual_p2 else "OFF"

    if p1_changed and p2_changed:
        title = "Both Pumps Changed State"
        message = f"Pompa 1 → {p1_label}, Pompa 2 → {p2_label}"
    elif p1_changed:
        title = "Pompa 1 Changed State"
        message = f"Pompa 1 (Water Refill) → {p1_label}"
    else:
        title = "Pompa 2 Changed State"
        message = f"Pompa 2 (TDS Dosing) → {p2_label}"

    # If hardware state differs from threshold-desired, note it
    if actual_p1 != desired_p1:
        message += f" (threshold expects {'ON' if desired_p1 else 'OFF'})"
    if actual_p2 != desired_p2:
        message += f" (threshold expects {'ON' if desired_p2 else 'OFF'})"

    notification = {
        "device_id": device_id,
        "type": "auto_mode",
        "title": title,
        "message": message,
        "priority": "medium",
        "read": False,
        "created_at": now,
    }
    await db.notifications.insert_one(notification)


# Track threshold warning state for REST path (per device)
_rest_warning_state: dict[str, dict] = {}


async def _create_rest_threshold_warnings(
    db: AsyncIOMotorDatabase,
    device_id: str,
    jarak_cm: int,
    tds_value: float,
    config: dict,
    now: datetime,
):
    """Create warning notifications when sensor values approach critical levels (REST path)."""
    if device_id not in _rest_warning_state:
        _rest_warning_state[device_id] = {"last_warn": {}, "cooldown": 60.0}

    state = _rest_warning_state[device_id]
    last_warn = state["last_warn"]
    cooldown = state["cooldown"]

    jarak_on = config.get("jarak_on", 105)

    # Water level approaching critical (within 10% of trigger)
    if jarak_cm != 999 and jarak_cm > 0 and jarak_cm > jarak_on * 0.9:
        last = last_warn.get("water", datetime.min.replace(tzinfo=UTC))
        if (now - last).total_seconds() > cooldown:
            await db.notifications.insert_one({
                "device_id": device_id,
                "type": "tds_warning",
                "title": "Water Level Approaching Critical",
                "message": f"Water distance: {jarak_cm}cm (trigger: {jarak_on}cm)",
                "priority": "medium",
                "read": False,
                "created_at": now,
            })
            last_warn["water"] = now

    # Water out of range (jarak_cm == 999 means sensor failure)
    if jarak_cm == 999:
        last = last_warn.get("water_alarm", datetime.min.replace(tzinfo=UTC))
        if (now - last).total_seconds() > 60.0:
            await db.notifications.insert_one({
                "device_id": device_id,
                "type": "water_alarm",
                "title": "Water Level Sensor Out of Range",
                "message": "Ultrasonic sensor reading 999cm — check water level immediately",
                "priority": "high",
                "read": False,
                "created_at": now,
            })
            last_warn["water_alarm"] = now


# ─── Helpers ────────────────────────────────────────────────────────────

def _format_sensor_record(record: dict) -> dict:
    """Format a MongoDB sensor_logs document for API response."""
    return {
        "id": str(record["_id"]),
        "device_id": record.get("device_id", ""),
        "recorded_at": record.get("recorded_at").isoformat() if record.get("recorded_at") else None,
        "jarak_cm": record.get("jarak_cm", 999),
        "tds_value": record.get("tds_value", 0),
        "current_ph": record.get("current_ph", 0),
        "pompa1": record.get("pompa1", 0),
        "pompa2": record.get("pompa2", 0),
    }


def _format_energy_record(record: dict) -> dict:
    """Format a MongoDB energy_records document for API response."""
    return {
        "id": str(record["_id"]),
        "recorded_at": record.get("recorded_at").isoformat() if record.get("recorded_at") else None,
        "pompa1_wh": record.get("pompa1_wh", 0),
        "pompa2_wh": record.get("pompa2_wh", 0),
        "total_wh": record.get("total_wh", 0),
    }


def _format_water_record(record: dict) -> dict:
    """Format a MongoDB water_records document for API response.

    Validates through WaterRecord model for type safety.
    """
    validated = WaterRecord.model_validate(record)
    return {
        "id": str(record["_id"]),
        "device_id": validated.device_id,
        "recorded_at": validated.recorded_at.isoformat() if validated.recorded_at else None,
        "jarak_cm": validated.jarak_cm,
        "water_level_pct": validated.water_level_pct,
    }
