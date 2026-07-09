"""
Pydantic schemas for water level records.

Field names:
  - jarak_cm        → ultrasonic distance reading (cm)
  - water_level_pct → computed water level percentage

Water level is derived from the ultrasonic distance reading:
    water_level_pct = ((TANK_HEIGHT_CM - jarak_cm) / TANK_HEIGHT_CM) * 100

Persisted in the water_records collection.
"""

from pydantic import BaseModel, Field
from datetime import datetime, UTC


class WaterRecord(BaseModel):
    """Water level document in the water_records collection.

    Stores the raw ultrasonic distance reading and the computed
    water level percentage at each time interval.
    The water_records collection has a compound index on
    device_id + recorded_at so queries can be filtered by device.
    """
    device_id: str = "HELIO_001"
    recorded_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    jarak_cm: int = 999
    water_level_pct: float = 0.0

    class Settings:
        name = "water_records"
