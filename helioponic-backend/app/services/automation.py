"""
Threshold-based automation engine — 4-pump independent bang-bang control.

Pompa 1 (Water Refill / Sirkulasi):
  → ON  when jarak_cm > jarak_on  (water too low, refill needed)
  → OFF when jarak_cm < jarak_off (water sufficiently refilled)
  → Deadband: no change (hysteresis)

Pompa 2 (pH DOWN Dosing):
  → ON  when pH > ph_max  (pH too high, dose pH DOWN)
  → OFF when pH < ph_min  (pH sufficiently low, stop dosing)
  → Deadband: no change (hysteresis)

Pompa 3 (Nutrisi A) & Pompa 4 (Nutrisi B) — TANDEM Nutrient Dosing:
  → Both ON  simultaneously when tds < tds_on  (nutrients low, dose A+B)
  → Both OFF simultaneously when tds > tds_off (nutrients sufficient, stop)
  → Deadband: no change (hysteresis)
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
    pompa3_state: int = 0,
    pompa4_state: int = 0,
    current_ph: float | None = None,
) -> tuple[int, int, int, int]:
    """Bang-bang hysteresis automation — 4 independent pumps.

    Returns (pompa1, pompa2, pompa3, pompa4) desired states.

    Pompa 1 (Water Level):  ON when jarak_cm > jarak_on, OFF when jarak_cm < jarak_off.
    Pompa 2 (pH DOWN):       ON when pH > ph_max, OFF when pH < ph_min.
    Pompa 3+4 (TDS Nutrient): Both ON when tds < tds_on, Both OFF when tds > tds_off.
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
        return pompa1_state, pompa2_state, pompa3_state, pompa4_state

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
    # Pompa 2 — pH DOWN (bang-bang hysteresis)
    # =====================================================================
    p2 = pompa2_state
    if rules["rule_ph"] and ph_valid:
        if current_ph > ph_max:
            p2 = 1
            logger.debug(f"AUTO-P2: pH={current_ph:.1f}>{ph_max:.1f} → ON (pH DOWN)")
        elif current_ph < ph_min:
            p2 = 0
            logger.debug(f"AUTO-P2: pH={current_ph:.1f}<{ph_min:.1f} → OFF (pH OK)")
        # else: deadband (ph_min <= pH <= ph_max) → no change (hysteresis)

    # =====================================================================
    # Pompa 3 & Pompa 4 — TANDEM TDS Nutrient Dosing
    # Both turn ON simultaneously when nutrients low, both OFF when sufficient.
    # =====================================================================
    p3 = pompa3_state
    p4 = pompa4_state
    if rules["rule_tds"]:
        if tds_value < tds_on:
            p3 = 1
            p4 = 1
            logger.debug(f"AUTO-TDS: tds={tds_value:.0f}<{tds_on:.0f} → Pompa3+4 ON (Nutrients A+B dosing)")
        elif tds_value > tds_off:
            p3 = 0
            p4 = 0
            logger.debug(f"AUTO-TDS: tds={tds_value:.0f}>{tds_off:.0f} → Pompa3+4 OFF (Nutrients sufficient)")
        # else: deadband → no change (hysteresis)

    return p1, p2, p3, p4
