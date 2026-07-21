"""
Water volume calculation service — domain logic for 4-pump hardware.

Water level is derived from the ultrasonic distance reading (jarak_cm).
  water_level_cm = TANK_HEIGHT_CM - jarak_cm
  water_level_pct = (water_level_cm / TANK_HEIGHT_CM) * 100

Pump 1 (pompa1) = Water refill / Circulation pump — refills tank when water low
Pump 2 (pompa2) = pH DOWN dosing pump — doses pH down when pH too high
Pump 3 (pompa3) = Nutrisi A dosing pump — tandem with Pump 4 for nutrients
Pump 4 (pompa4) = Nutrisi B dosing pump — tandem with Pump 3 for nutrients
"""

from datetime import datetime


class WaterCalculator:
    """Handles water level differentiation.

    Tank geometry is configurable per device via device_configs.
    """

    def __init__(self, tank_depth_cm: float = 32.0):
        """Initialize with tank depth from device config.

        Args:
            tank_depth_cm: Total tank depth in cm (sensor-to-bottom).
                           Default 32cm for standard reservoir.
        """
        self.tank_depth_cm = tank_depth_cm

    def jarak_to_water_level_pct(self, jarak_cm: float, tank_depth_cm: float | None = None) -> float:
        """Convert ultrasonic distance reading to water level percentage.

        Tank depth = tank_depth_cm or self.tank_depth_cm (configurable per device)
        Formula: water_level_pct = ((tank_depth - jarak_cm) / tank_depth) × 100

        Examples (32cm tank):
          - jarak_cm = 0  → water depth = 32cm → 100% (tank full)
          - jarak_cm = 16 → water depth = 16cm → 50% (half full)
          - jarak_cm = 32 → water depth = 0cm → 0% (empty)
          - jarak_cm > 32 → 0% (sensor error or no water)

        If jarak_cm is 999 (out of range), return 0.
        """
        if jarak_cm >= 999 or jarak_cm < 0:
            return 0.0
        depth = tank_depth_cm if tank_depth_cm is not None else self.tank_depth_cm
        water_depth = depth - float(jarak_cm)
        if water_depth < 0:
            return 0.0
        return (water_depth / depth) * 100.0

    def level_delta_to_volume(self, level_delta_pct: float) -> float:
        """Convert water level percentage change to volume in liters.

        1% of tank height → volume = 1%_height_cm * 2500 cm² → liters.
        """
        delta_cm = (level_delta_pct / 100.0) * self.tank_depth_cm
        volume_cm3 = delta_cm * 2500.0  # default 50cm x 50cm base area
        return volume_cm3 / 1000.0

    def calculate_water_delta(
        self,
        prev_jarak_cm: float,
        curr_jarak_cm: float,
    ) -> tuple[float, float]:
        """Calculate water level change.

        Returns (water_level_pct, volume_change_liters).
        Positive volume = water added, negative = water consumed.
        """
        prev_pct = self.jarak_to_water_level_pct(prev_jarak_cm)
        curr_pct = self.jarak_to_water_level_pct(curr_jarak_cm)
        delta_pct = curr_pct - prev_pct
        volume_l = self.level_delta_to_volume(delta_pct)
        return curr_pct, volume_l
