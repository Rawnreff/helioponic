"""
Night Mode router — activate/deactivate night mode via REST + MQTT.

When night mode is activated:
  - All pumps are turned OFF
  - Bang-bang automation is disabled on the ESP32
  - Current thresholds are saved for restoration
  - Only manual commands are accepted

When night mode is deactivated:
  - Saved thresholds are restored
  - Bang-bang automation resumes
  - Pumps return to auto state
"""

import logging
from datetime import datetime, UTC
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.core.database import get_database
from app.core.auth import get_current_user_id, verify_device_access

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/night-mode", tags=["night_mode"])

# Global reference to MQTT downlink publisher (set by main.py)
mqtt_publish_downlink = None


class NightModeActivateRequest(BaseModel):
    device_id: str = "HELIO_001"


class NightModeDeactivateRequest(BaseModel):
    device_id: str = "HELIO_001"


class NightModeStatusResponse(BaseModel):
    active: bool
    device_id: str
    activated_at: Optional[str] = None
    deactivated_at: Optional[str] = None
    saved_thresholds: Optional[dict] = None


@router.post("/activate")
async def activate_night_mode(
    req: NightModeActivateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Activate night mode for a device.

    Saves current thresholds to a night_mode_snapshots collection,
    then publishes a night_mode/downlink MQTT message to the ESP32
    instructing it to disable all pumps and automation.
    """
    device_id = req.device_id
    await verify_device_access(db, device_id, user_id)
    now = datetime.now(UTC)

    # Fetch current device config to save for restoration
    current_config = await db.device_configs.find_one(
        {"device_id": device_id},
        sort=[("updated_at", -1)],
    )

    saved_thresholds = {}
    if current_config:
        saved_thresholds = {
            "tank_depth_cm": float(current_config.get("tank_depth_cm", 32.0)),
            "jarak_on": float(current_config.get("jarak_on", 105)),
            "jarak_off": float(current_config.get("jarak_off", 95)),
            "tds_on": current_config.get("tds_on", 95.0),
            "tds_off": current_config.get("tds_off", 105.0),
            "auto_enabled": current_config.get("auto_enabled", True),
        }

    # Save night mode snapshot
    snapshot = {
        "device_id": device_id,
        "active": True,
        "activated_at": now,
        "saved_thresholds": saved_thresholds,
    }
    # Upsert: keep only one snapshot per device
    existing = await db.night_mode_snapshots.find_one({"device_id": device_id})
    if existing:
        await db.night_mode_snapshots.update_one(
            {"_id": existing["_id"]},
            {"$set": snapshot},
        )
    else:
        await db.night_mode_snapshots.insert_one(snapshot)

    # Publish to MQTT downlink — ESP32 turns off all pumps + blocks automation
    if mqtt_publish_downlink:
        await mqtt_publish_downlink({
            "type": "night_mode",
            "active": True,
            "device_id": device_id,
        })

    logger.info(f"Night mode activated for device {device_id}")
    return {
        "success": True,
        "message": "night mode activated — all pumps stopped, automation disabled",
        "device_id": device_id,
        "activated_at": now.isoformat(),
    }


@router.post("/deactivate")
async def deactivate_night_mode(
    req: NightModeDeactivateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Deactivate night mode for a device.

    Retrieves saved thresholds from the snapshot and restores them,
    then publishes a night_mode/downlink MQTT message to the ESP32
    to re-enable automation.
    """
    device_id = req.device_id
    await verify_device_access(db, device_id, user_id)

    # Check if night mode is active
    snapshot = await db.night_mode_snapshots.find_one({"device_id": device_id})
    if not snapshot or not snapshot.get("active"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="night mode is not active for this device",
        )

    now = datetime.now(UTC)
    saved = snapshot.get("saved_thresholds", {})

    # Restore thresholds to device_configs
    restored_config = {
        "device_id": device_id,
        "tank_depth_cm": float(saved.get("tank_depth_cm", 32.0)),
        "jarak_on": float(saved.get("jarak_on", 5)),
        "jarak_off": float(saved.get("jarak_off", 2)),
        "tds_on": saved.get("tds_on", 95.0),
        "tds_off": saved.get("tds_off", 105.0),
        "auto_enabled": saved.get("auto_enabled", True),
        "updated_at": now,
    }
    await db.device_configs.insert_one(restored_config)

    # Mark snapshot as inactive
    await db.night_mode_snapshots.update_one(
        {"_id": snapshot["_id"]},
        {"$set": {"active": False, "deactivated_at": now}},
    )

    # Publish to MQTT downlink — ESP32 restores thresholds + re-enables automation
    if mqtt_publish_downlink:
        await mqtt_publish_downlink({
            "type": "night_mode",
            "active": False,
            "device_id": device_id,
            "jarak_on": restored_config["jarak_on"],
            "jarak_off": restored_config["jarak_off"],
            "tds_on": restored_config["tds_on"],
            "tds_off": restored_config["tds_off"],
            "tank_depth_cm": restored_config["tank_depth_cm"],
        })

    logger.info(f"Night mode deactivated for device {device_id}")
    return {
        "success": True,
        "message": "night mode deactivated — automation restored",
        "device_id": device_id,
        "deactivated_at": now.isoformat(),
    }


@router.get("/status")
async def get_night_mode_status(
    device_id: str = Query("HELIO_001"),
    user_id: str = Depends(get_current_user_id),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    """Check if night mode is currently active for a device."""
    await verify_device_access(db, device_id, user_id)

    snapshot = await db.night_mode_snapshots.find_one({"device_id": device_id})
    if not snapshot:
        return NightModeStatusResponse(
            active=False,
            device_id=device_id,
        )

    return NightModeStatusResponse(
        active=snapshot.get("active", False),
        device_id=device_id,
        activated_at=snapshot.get("activated_at").isoformat() if snapshot.get("activated_at") else None,
        deactivated_at=snapshot.get("deactivated_at").isoformat() if snapshot.get("deactivated_at") else None,
        saved_thresholds=snapshot.get("saved_thresholds"),
    )
