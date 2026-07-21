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

    Includes water level (jarak), nutrient (tds), pH thresholds,
    and tank geometry (tank_depth_cm) for water level percentage display.
    ph_min / ph_max define the acceptable pH range for Pompa 2 (pH Dosing).
    """
    device_id: str = "HELIO_001"
    tank_depth_cm: float = Field(32.0, ge=5, le=200, description="Tank/reservoir depth in cm (sensor-to-bottom distance)")
    jarak_on: float = Field(5.0, ge=0, le=200, description="Distance (cm) to trigger pump ON — water level is low")
    jarak_off: float = Field(2.0, ge=0, le=200, description="Distance (cm) to trigger pump OFF — water level is sufficient")
    tds_on: float = Field(95.0, ge=0, le=2000, description="TDS (ppm) — dosing ON when below this (nutrients low)")
    tds_off: float = Field(105.0, ge=0, le=2000, description="TDS (ppm) — dosing OFF when above this (nutrients sufficient)")
    ph_min: float = Field(5.5, ge=0, le=14, description="pH minimum — dosing ON when pH drops below this")
    ph_max: float = Field(6.5, ge=0, le=14, description="pH maximum — dosing ON when pH rises above this")

    @classmethod
    def validate_ph_range(cls, v: "DeviceConfigPayload") -> "DeviceConfigPayload":
        """Ensure ph_min < ph_max."""
        if v.ph_min >= v.ph_max:
            raise ValueError("ph_min must be less than ph_max")
        return v


class DeviceConfig(BaseModel):
    """Device configuration document in the device_configs collection.

    Stores the automation boundary values and tank geometry
    synced to ESP32 via MQTT downlink.
    """
    device_id: str = "HELIO_001"
    tank_depth_cm: float = 32.0  # total reservoir depth (sensor-to-bottom)
    jarak_on: float = 5.0
    jarak_off: float = 2.0
    tds_on: float = 95.0     # dosing ON  when TDS drops below this (LOW threshold)
    tds_off: float = 105.0   # dosing OFF when TDS rises above this (HIGH threshold)
    ph_min: float = 5.5
    ph_max: float = 6.5
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    class Settings:
        name = "device_configs"
