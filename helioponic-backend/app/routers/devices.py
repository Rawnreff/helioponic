"""
Device management and configuration router.

Provides endpoints for:
  - Managing device registration
  - Syncing hardware thresholds (JARAK_ON, JARAK_OFF, TDS_ON, TDS_OFF)
    to the ESP32 via MQTT downlink
"""

import logging
from datetime import datetime, UTC
from fastapi import APIRouter, Depends, HTTPException, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.database import get_database
from app.core.auth import get_current_user_id
from app.models.auth import DeviceResponse, AddDeviceRequest
from app.models.threshold import DeviceConfigPayload
from app.models.automation import AutomationRulesPayload, AutomationRulesResponse
from bson.objectid import ObjectId

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/devices", tags=["devices"])

# Global references (set by main.py)
mqtt_publish_downlink = None
reset_subscriber_state = None  # async callable to reset subscriber hysteresis state
reset_notif_state = None  # async callable to reset REST notification state


@router.get("")
async def list_devices(
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """List all devices owned by the authenticated user."""
    devices = []
    async for dev in db.devices.find({"user_id": user_id}).sort("created_at", -1):
        devices.append({
            "id": str(dev["_id"]),
            "device_id": dev["device_id"],
            "name": dev.get("name", ""),
            "is_active": dev.get("is_active", True),
            "created_at": dev.get("created_at"),
        })
    return {"devices": devices, "count": len(devices)}


@router.post("", response_model=DeviceResponse, status_code=status.HTTP_201_CREATED)
async def add_device(
    req: AddDeviceRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Register an additional device for the authenticated user."""
    existing = await db.devices.find_one({"device_id": req.device_id})
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="device ID already registered",
        )

    device_doc = {
        "user_id": user_id,
        "device_id": req.device_id,
        "name": req.name or req.device_id,
        "is_active": True,
        "created_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
    }
    result = await db.devices.insert_one(device_doc)

    logger.info(f"Device added: user_id={user_id}, device_id={req.device_id}")
    return DeviceResponse(
        id=str(result.inserted_id),
        device_id=req.device_id,
        name=req.name or req.device_id,
        is_active=True,
        created_at=device_doc["created_at"],
    )


@router.delete("/{device_id}")
async def remove_device(
    device_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Remove a device and all its associated data."""
    device = await db.devices.find_one({"device_id": device_id, "user_id": user_id})
    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="device not found or not owned by you",
        )

    await db.sensor_logs.delete_many({"device_id": device_id})
    await db.device_configs.delete_many({"device_id": device_id})
    await db.devices.delete_one({"_id": device["_id"]})

    logger.info(f"Device removed: user_id={user_id}, device_id={device_id}")
    return {
        "status": "ok",
        "message": "device removed successfully",
        "device_id": device_id,
    }


# =============================================================================
# Device Configuration Sync (JARAK_ON/OFF, TDS_ON/OFF)
# =============================================================================


@router.get("/config")
async def get_device_config(
    device_id: str = "HELIO_001",
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return the current device configuration thresholds.

    Returns default values if no configuration has been saved yet.
    Defaults: jarak_on=5, jarak_off=2 for 7cm tank depth.
    """
    config = await db.device_configs.find_one(
        {"device_id": device_id},
        sort=[("updated_at", -1)],
    )
    if not config:
        return {
            "device_id": device_id,
            "jarak_on": 5.0,
            "jarak_off": 2.0,
            "tds_on": 105.0,
            "tds_off": 95.0,
            "ph_min": 5.5,
            "ph_max": 6.5,
            "updated_at": None,
        }

    return {
        "device_id": config.get("device_id", device_id),
        "jarak_on": config.get("jarak_on", 5.0),
        "jarak_off": config.get("jarak_off", 2.0),
        "tds_on": config.get("tds_on", 105.0),
        "tds_off": config.get("tds_off", 95.0),
        "ph_min": config.get("ph_min", 5.5),
        "ph_max": config.get("ph_max", 6.5),
        "updated_at": config.get("updated_at").isoformat() if config.get("updated_at") else None,
    }


# =============================================================================
# Automation Rules (Auto-Pump Master Toggle + IF-THEN Rule Toggles)
# =============================================================================


@router.get("/automation")
async def get_automation_rules(
    device_id: str = "HELIO_001",
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Return the automation rules state for a device.

    Returns the master toggle (auto_enabled) and individual rule
    toggles (rule_ph, rule_tds, rule_water) that the mobile app
    displays in AutomationScreen.

    Defaults: all enabled.
    """
    config = await db.device_configs.find_one(
        {"device_id": device_id},
        sort=[("updated_at", -1)],
    )
    if not config:
        return {
            "device_id": device_id,
            "auto_enabled": True,
            "rule_ph": True,
            "rule_tds": True,
            "rule_water": True,
            "updated_at": None,
        }

    return {
        "device_id": device_id,
        "auto_enabled": config.get("auto_enabled", True),
        "rule_ph": config.get("rule_ph", True),
        "rule_tds": config.get("rule_tds", True),
        "rule_water": config.get("rule_water", True),
        "updated_at": config.get("updated_at").isoformat() if config.get("updated_at") else None,
    }


@router.put("/automation", response_model=AutomationRulesResponse)
async def update_automation_rules(
    payload: AutomationRulesPayload,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Update the automation rules state for a device.

    Saves the master toggle and individual rule toggles so that
    the mobile app's UI state persists across app restarts.

    These rules are used by evaluate_thresholds() in the automation
    engine to decide whether to apply automatic pump control.
    """
    device_id = payload.device_id

    # Upsert: update existing doc or insert new one
    existing = await db.device_configs.find_one(
        {"device_id": device_id},
        sort=[("updated_at", -1)],
    )

    now = datetime.now(UTC)
    update_data = {
        "auto_enabled": payload.auto_enabled,
        "rule_ph": payload.rule_ph,
        "rule_tds": payload.rule_tds,
        "rule_water": payload.rule_water,
        "updated_at": now,
    }

    if existing:
        await db.device_configs.update_one(
            {"_id": existing["_id"]},
            {"$set": update_data},
        )
    else:
        update_data["device_id"] = device_id
        update_data["jarak_on"] = 5.0
        update_data["jarak_off"] = 2.0
        update_data["tds_on"] = 105.0
        update_data["tds_off"] = 95.0
        update_data["ph_min"] = 5.5
        update_data["ph_max"] = 6.5
        await db.device_configs.insert_one(update_data)

    logger.info(
        f"Automation rules updated: device_id={device_id}, "
        f"auto_enabled={payload.auto_enabled}, "
        f"rule_ph={payload.rule_ph}, rule_tds={payload.rule_tds}, rule_water={payload.rule_water}"
    )
    return AutomationRulesResponse(
        device_id=device_id,
        auto_enabled=payload.auto_enabled,
        rule_ph=payload.rule_ph,
        rule_tds=payload.rule_tds,
        rule_water=payload.rule_water,
        updated_at=now.isoformat(),
    )


@router.put("/config")
async def update_device_config(
    payload: DeviceConfigPayload,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Update device automation boundaries and publish to MQTT downlink.

    When called by the mobile app:
      1. Saves the new thresholds to the device_configs collection
      2. Immediately publishes them as a JSON packet via MQTT to
         helioponic/config/downlink, which the ESP32 receives and applies
         to its runtime threshold variables.
    """
    device_id = payload.device_id

    # Save to MongoDB
    config_doc = {
        "device_id": device_id,
        "jarak_on": payload.jarak_on,
        "jarak_off": payload.jarak_off,
        "tds_on": payload.tds_on,
        "tds_off": payload.tds_off,
        "ph_min": payload.ph_min,
        "ph_max": payload.ph_max,
        "updated_at": datetime.now(UTC),
    }
    result = await db.device_configs.insert_one(config_doc)
    config_doc["id"] = str(result.inserted_id)

    # Publish to MQTT downlink for the ESP32
    if mqtt_publish_downlink:
        await mqtt_publish_downlink({
            "jarak_on": payload.jarak_on,
            "jarak_off": payload.jarak_off,
            "tds_on": payload.tds_on,
            "tds_off": payload.tds_off,
            "ph_min": payload.ph_min,
            "ph_max": payload.ph_max,
        })

    # Reset automation hysteresis state so threshold changes take effect immediately
    if reset_subscriber_state:
        await reset_subscriber_state(device_id)
    # Also reset REST path notification state
    if reset_notif_state:
        await reset_notif_state(device_id)

    logger.info(
        f"Device config updated: device_id={device_id}, "
        f"jarak_on={payload.jarak_on}, jarak_off={payload.jarak_off}, "
        f"tds_on={payload.tds_on}, tds_off={payload.tds_off}, "
        f"ph_min={payload.ph_min}, ph_max={payload.ph_max}"
    )
    return {
        "status": "ok",
        "device_id": device_id,
        "jarak_on": payload.jarak_on,
        "jarak_off": payload.jarak_off,
        "tds_on": payload.tds_on,
        "tds_off": payload.tds_off,
        "ph_min": payload.ph_min,
        "ph_max": payload.ph_max,
        "updated_at": config_doc["updated_at"].isoformat(),
    }
