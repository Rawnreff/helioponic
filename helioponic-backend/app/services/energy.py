"""
Energy (Watt-hour) calculation service — domain logic for 2-pump hardware.

Hardware configuration (from raw firmware):
  - Pompa 1 (pompa1): Circulation pump  — 15W
  - Pompa 2 (pompa2): pH dosing pump   — 15W
"""

from app.models.sensor import SensorRecord
from datetime import datetime


class EnergyCalculator:
    """Handles Watt-hour calculations for solar production and pump consumption."""

    # Pump power ratings in Watts
    POMPA1_WATTS: float = 15.0  # Circulation pump
    POMPA2_WATTS: float = 15.0  # pH dosing pump

    def calculate_pump_wh(self, pump_watts: float, pump_on_seconds: float) -> float:
        """Compute energy consumed by a single pump.

        Formula: Wh = PumpWatts * (pumpOnSeconds / 3600)
        """
        return pump_watts * (pump_on_seconds / 3600.0)

    def calculate_pompa1_wh(self, pompa1_state: int, interval_seconds: float) -> float:
        """Compute energy consumed by Pompa 1 (circulation) over the interval."""
        return self.calculate_pump_wh(
            self.POMPA1_WATTS,
            float(pompa1_state) * interval_seconds,
        )

    def calculate_pompa2_wh(self, pompa2_state: int, interval_seconds: float) -> float:
        """Compute energy consumed by Pompa 2 (pH dosing) over the interval."""
        return self.calculate_pump_wh(
            self.POMPA2_WATTS,
            float(pompa2_state) * interval_seconds,
        )

    def calculate_total_pump_wh(
        self, pompa1_state: int, pompa2_state: int, interval_seconds: float
    ) -> dict:
        """Calculate Wh for both pumps over a time interval.

        Returns dict with keys: pompa1_wh, pompa2_wh, total_wh.
        """
        pompa1_wh = self.calculate_pompa1_wh(pompa1_state, interval_seconds)
        pompa2_wh = self.calculate_pompa2_wh(pompa2_state, interval_seconds)
        return {
            "pompa1_wh": pompa1_wh,
            "pompa2_wh": pompa2_wh,
            "total_wh": pompa1_wh + pompa2_wh,
        }
