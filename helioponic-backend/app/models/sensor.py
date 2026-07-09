"""
Pydantic schemas for sensor readings from the ESP32 firmware.

Field names match the raw firmware variables 1:1:
  - jarak_cm   → ultrasonic water distance (cm)
  - tds_value  → TDS reading (ppm)
  - current_ph → pH reading
  - pompa1     → pump 1 relay state (0/1) — circulation
  - pompa2     → pump 2 relay state (0/1) — pH dosing

MQTT uplink topic:  helioponic/sensor/uplink
MQTT downlink topic: helioponic/config/downlink
"""

from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class SensorReading(BaseModel):
    """MQTT uplink payload from ESP32 — published every 1 second.

    Maps 1:1 to the raw firmware's JSON output defined in helioponic_esp32.ino.
    """
    device_id: str = "HELIO_001"
    ts: int                     # Unix epoch timestamp (seconds)
    jarak_cm: int = 999         # Ultrasonic distance (cm), 999 = out of range
    tds_value: float = 0.0      # TDS in ppm
    current_ph: float = 0.0     # pH value (0.0–14.0)
    pompa1: int = Field(0, ge=0, le=1)  # Pump 1 relay state (circulation)
    pompa2: int = Field(0, ge=0, le=1)  # Pump 2 relay state (pH dosing)


class SensorRecord(BaseModel):
    """Persisted sensor reading document in the sensor_logs collection."""
    device_id: str
    recorded_at: datetime
    jarak_cm: int
    tds_value: float
    current_ph: float
    pompa1: int
    pompa2: int

    class Settings:
        name = "sensor_logs"
