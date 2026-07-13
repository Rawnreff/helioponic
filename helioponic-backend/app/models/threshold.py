"""
Pydantic schemas for automation threshold configuration.

Field names match the raw firmware variables 1:1:
  - jarak_on  → distance threshold to turn pump ON (cm)
  - jarak_off → distance threshold to turn pump OFF (cm)
  - tds_on    → TDS threshold to turn pump ON (ppm)
  - tds_off   → TDS threshold to turn pump OFF (ppm)

These are persisted in the device_configs collection and synced
to the ESP32 via MQTT downlink topic: helioponic/config/downlink
"""

from pydantic import BaseModel, Field
from datetime import datetime, UTC
from typing import Optional


class DeviceConfigPayload(BaseModel):
    """API request/response payload for device threshold configuration.

    This maps 1:1 to the ESP32's runtime threshold variables
    (runtime_jarak_on, runtime_jarak_off, runtime_tds_on, runtime_tds_off).
    """
    device_id: str = "HELIO_001"
    jarak_on: int = Field(5, ge=0, le=7, description="Distance (cm) to trigger pump ON — tank depth is 7cm")
    jarak_off: int = Field(2, ge=0, le=7, description="Distance (cm) to trigger pump OFF — tank depth is 7cm")
    tds_on: float = Field(95.0, ge=0, le=2000, description="TDS (ppm) — dosing ON when below this (nutrients low)")
    tds_off: float = Field(105.0, ge=0, le=2000, description="TDS (ppm) — dosing OFF when above this (nutrients sufficient)")


class DeviceConfig(BaseModel):
    """Device configuration document in the device_configs collection.

    Stores the automation boundary values that are synced to the
    ESP32's runtime threshold variables via MQTT downlink.
    """
    device_id: str = "HELIO_001"
    jarak_on: int = 5
    jarak_off: int = 2
    tds_on: float = 95.0     # dosing ON  when TDS drops below this (LOW threshold)
    tds_off: float = 105.0   # dosing OFF when TDS rises above this (HIGH threshold)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    class Settings:
        name = "device_configs"
