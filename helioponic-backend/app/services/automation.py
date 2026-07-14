"""
Threshold-based automation engine — clean independent pump control.

Pompa 1 (Water Refill):
  → ON  when jarak_cm > jarak_on  (water too low, refill needed)
  → OFF when jarak_cm < jarak_off (water sufficiently refilled)
  → Deadband: no change

Pompa 2 (pH DOWN Dosing):
  → ON  when pH > ph_max  (pH too high, dose pH DOWN)
  → OFF when pH < ph_min  (pH sufficiently low, stop dosing)
  → Deadband: no change (hysteresis)

TDS (Nutrient) control:
  → Only takes over Pompa 2 when rule_ph is disabled
  → ON  when tds < tds_on  (nutrients low, dose)
  → OFF when tds > tds_off (nutrients sufficient, stop)
"""

import logging

logger = logging.getLogger(__name__)


def get_automation_rules(config: dict) -> dict:
    """Extract automation rules from config with defaults."""
    return {
        "auto_enabled": config.get("auto_enabled", True),
        "rule_ph": config.get("rule_ph", True),
        "rule_tds": config.get("rule_tds", True),
        "rule_water": config.get("rule_water", True),
    }


def evaluate_thresholds(
    jarak_cm: float,
    tds_value: float,
    config: dict,
    pompa1_state: int,
    pompa2_state: int,
    current_ph: float | None = None,
) -> tuple[int, int]:
    """Bang-bang hysteresis automation — each pump controlled independently.

    Pompa 1 (Water Level): ON when jarak_cm > jarak_on, OFF when jarak_cm < jarak_off.
    Pompa 2 (pH DOWN):     ON when pH > ph_max, OFF when pH < ph_min.
    Pompa 2 (TDS backup):  Only if rule_ph disabled — ON when tds < tds_on, OFF when tds > tds_off.
    """
    jarak_on  = config.get("jarak_on", 5.0)
    jarak_off = config.get("jarak_off", 2.0)
    tds_on    = config.get("tds_on", 95.0)
    tds_off   = config.get("tds_off", 105.0)
    ph_min    = config.get("ph_min", 5.5)
    ph_max    = config.get("ph_max", 6.5)

    rules = get_automation_rules(config)
    ultrasonik_valid = (jarak_cm != 999 and jarak_cm > 0)
    ph_valid = current_ph is not None and current_ph > 0

    # ── Master Toggle ──
    if not rules["auto_enabled"]:
        return pompa1_state, pompa2_state

    # =====================================================================
    # Pompa 1 — Water Level (bang-bang hysteresis)
    # =====================================================================
    p1 = pompa1_state
    if rules["rule_water"] and ultrasonik_valid:
        if jarak_cm > jarak_on:
            p1 = 1
            logger.debug(f"AUTO-P1: jarak={jarak_cm}>{jarak_on} → ON")
        elif jarak_cm < jarak_off:
            p1 = 0
            logger.debug(f"AUTO-P1: jarak={jarak_cm}<{jarak_off} → OFF")
        # else: deadband → no change (hysteresis)

    # =====================================================================
    # Pompa 2 — pH DOWN (bang-bang hysteresis, same pattern as Pompa 1)
    # =====================================================================
    p2 = pompa2_state

    # ── pH mode (default): pure hysteresis, independent of TDS ──
    if rules["rule_ph"] and ph_valid:
        if current_ph > ph_max:
            p2 = 1
            logger.debug(f"AUTO-P2: pH={current_ph:.1f}>{ph_max:.1f} → ON (pH DOWN)")
        elif current_ph < ph_min:
            p2 = 0
            logger.debug(f"AUTO-P2: pH={current_ph:.1f}<{ph_min:.1f} → OFF (pH OK)")
        # else: deadband (ph_min <= pH <= ph_max) → no change (hysteresis)

    # ── TDS mode: only when rule_ph is disabled or pH data invalid ──
    elif rules["rule_tds"]:
        if tds_value < tds_on:
            p2 = 1
            logger.debug(f"AUTO-P2: tds={tds_value:.0f}<{tds_on:.0f} → ON (TDS dosing)")
        elif tds_value > tds_off:
            p2 = 0
            logger.debug(f"AUTO-P2: tds={tds_value:.0f}>{tds_off:.0f} → OFF (TDS OK)")

    return p1, p2
