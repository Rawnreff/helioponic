"""
Analytics & data router — sensor, energy, water, actuator endpoints.

All endpoints use the raw firmware field names (jarak_cm, tds_value, current_ph, pompa1, pompa2).
"""

import logging
from datetime import datetime, timedelta, UTC
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from motor.motor_asyncio import AsyncIOMotorDatabase

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
    """
    device_id = reading.device_id or "HELIO_001"
    now = datetime.now(UTC)

    # Fetch latest device config for threshold automation
    config = await db.device_configs.find_one(
        {"device_id": device_id},
        sort=[("updated_at", -1)],
    )
    config_dict = config or {}

    # Apply threshold automation
    pompa1, pompa2 = evaluate_thresholds(
        reading.jarak_cm,
        reading.tds_value,
        config_dict,
        reading.pompa1,
        reading.pompa2,
    )

    # Build and save the record
    record = {
        "device_id": device_id,
        "recorded_at": now,
        "jarak_cm": reading.jarak_cm,
        "tds_value": reading.tds_value,
        "current_ph": reading.current_ph,
        "pompa1": pompa1,
        "pompa2": pompa2,
    }
    await db.sensor_logs.insert_one(record)

    # Compute energy deltas
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
        wh = energy_calc.calculate_total_pump_wh(pompa1, pompa2, elapsed)
        energy_record = EnergyRecord(
            device_id=device_id,
            recorded_at=now,
            pompa1_wh=wh["pompa1_wh"],
            pompa2_wh=wh["pompa2_wh"],
            total_wh=wh["total_wh"],
        )
        await db.energy_records.insert_one(energy_record.model_dump())

    logger.info(f"Sensor reading saved for device {device_id}")
    return {
        "status": "ok",
        "message": "sensor reading saved",
        "pumps_applied": {"pompa1": pompa1, "pompa2": pompa2},
    }


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
