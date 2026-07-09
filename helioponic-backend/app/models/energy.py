"""
Pydantic schemas for pump energy consumption records.

Field names match the raw firmware variables 1:1:
  - pompa1_wh → circulation pump watt-hours
  - pompa2_wh → pH dosing pump watt-hours
  - total_wh   → total watt-hours (pompa1_wh + pompa2_wh)

Persisted in the energy_records collection.
"""

from pydantic import BaseModel, Field
from datetime import datetime, UTC


class EnergyRecord(BaseModel):
    """Energy consumption document in the energy_records collection.

    Stores watt-hour deltas for each pump per time interval.
    The energy_records collection has a compound index on device_id + recorded_at
    so queries can be filtered by device.
    """
    device_id: str = "HELIO_001"
    recorded_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    pompa1_wh: float = 0.0
    pompa2_wh: float = 0.0
    total_wh: float = 0.0

    class Settings:
        name = "energy_records"
