"""
Pydantic schemas for sensor readings from the ESP32 firmware.

Field names match the raw firmware variables 1:1:
  - jarak_cm   → ultrasonic water distance (cm)
  - tds_value  → TDS reading (ppm)
  - current_ph → pH reading
  - pompa1     → pump 1 relay state (0/1) — circulation/water refill
  - pompa2     → pump 2 relay state (0/1) — pH DOWN dosing
  - pompa3     → pump 3 relay state (0/1) — Nutrisi A dosing
  - pompa4     → pump 4 relay state (0/1) — Nutrisi B dosing

MQTT uplink topic:  helioponic/sensor/uplink
MQTT downlink topic: helioponic/config/downlink
"""

from pydantic import BaseModel, Field
from datetime import datetime


class SensorReading(BaseModel):
    """MQTT uplink payload from ESP32 — published every 1 second.

    ALL incoming telemetry (whether from ESP32 or simulator) is treated
    as a strict, read-only Source of Truth. The backend persists pump
    states exactly as reported and NEVER computes/overrides them.

    Maps 1:1 to the raw firmware's JSON output defined in helioponic_esp32.ino.
    """
    device_id: str = "HELIO_001"
    ts: int                     # Unix epoch timestamp (seconds)
    jarak_cm: float = 999       # Ultrasonic distance (cm), 999 = out of range, supports decimals (e.g. 1.3cm)
    tds_value: float = 0.0      # TDS in ppm
    current_ph: float = 0.0     # pH value (0.0–14.0)
    pompa1: int = Field(..., ge=0, le=1)  # Pump 1 (water circulation/refill) — REQUIRED: 0 or 1
    pompa2: int = Field(..., ge=0, le=1)  # Pump 2 (pH DOWN dosing) — REQUIRED: 0 or 1
    pompa3: int = Field(..., ge=0, le=1)  # Pump 3 (Nutrisi A dosing) — REQUIRED: 0 or 1
    pompa4: int = Field(..., ge=0, le=1)  # Pump 4 (Nutrisi B dosing) — REQUIRED: 0 or 1


class SensorRecord(BaseModel):
    """Persisted sensor reading document in the sensor_logs collection."""
    device_id: str
    recorded_at: datetime
    jarak_cm: float
    tds_value: float
    current_ph: float
    pompa1: int
    pompa2: int
    pompa3: int
    pompa4: int

    class Settings:
        name = "sensor_logs"
