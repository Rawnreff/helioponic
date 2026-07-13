"""
Threshold-based automation engine — refactored for independent pump control.

Per PRD specification (F-02.1 through F-02.6):
  - Pompa 1 (Circulation/Water Refill): Controlled by WATER LEVEL only (jarak_cm)
    → ON when jarak_cm > jarak_on (water low, need refill)
    → OFF when jarak_cm < jarak_off (water sufficient)
    → Priority: HIGH (water is more critical)

  - Pompa 2 (pH/TDS Dosing): Controlled by NUTRIENT/TDS only (tds_value)
    → ON when tds_value > tds_on (nutrients low, need dosing)
    → OFF when tds_value < tds_off (nutrients sufficient)
    → Priority: LOW (nutrients are less critical)

Respects per-device automation rules:
  - auto_enabled: Master toggle — if False, skip all automation
  - rule_ph: pH rule toggle — if False, skip Pompa 2 automation
  - rule_tds: TDS rule toggle — if False, skip TDS-based triggers for Pompa 2
  - rule_water: Water rule toggle — if False, skip distance-based triggers for Pompa 1
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
    jarak_cm: int,
    tds_value: float,
    config: dict,
    pompa1_state: int,
    pompa2_state: int,
) -> tuple[int, int]:
    """Apply independent bang-bang hysteresis automation (PRD-aligned).

    Pompa 1 is controlled by water level (jarak_cm) only.
    Pompa 2 is controlled by nutrient/TDS (tds_value) only.
    Each has independent hysteresis with separate deadbands.

    Respects automation rule toggles from the device config:
      - If auto_enabled=False, returns current states unchanged
      - If rule_water=False, Pompa 1 automation is skipped
      - If rule_tds=False, Pompa 2 TDS-based triggers are skipped
      - If rule_ph=False, Pompa 2 automation is skipped

    Args:
        jarak_cm:   Current ultrasonic distance reading (cm). 999 = out of range.
        tds_value:  Current TDS reading (ppm).
        config:     Device configuration dict with keys: jarak_on, jarak_off,
                    tds_on, tds_off, auto_enabled, rule_ph, rule_tds, rule_water.
        pompa1_state: Current Pompa 1 state (0 or 1).
        pompa2_state: Current Pompa 2 state (0 or 1).

    Returns:
        Tuple of (pompa1_new_state, pompa2_new_state).
    """
    jarak_on  = config.get("jarak_on", 5)
    jarak_off = config.get("jarak_off", 2)
    tds_on    = config.get("tds_on", 95.0)     # LOW threshold — dosing ON  when TDS drops below
    tds_off   = config.get("tds_off", 105.0)   # HIGH threshold — dosing OFF when TDS rises above

    rules = get_automation_rules(config)

    ultrasonik_valid = (jarak_cm != 999 and jarak_cm > 0)

    # ── Master Toggle: if auto is disabled, return current states ─────
    if not rules["auto_enabled"]:
        return pompa1_state, pompa2_state

    # =====================================================================
    # PRIORITY 1: Pompa 1 — Water Level Control (jarak_cm based)
    # =====================================================================
    p1 = pompa1_state

    if rules["rule_water"] and ultrasonik_valid:
        # Hysteresis bang-bang: Pompa 1 ON/OFF based on water level
        if jarak_cm > jarak_on:
            # Water too low → turn pump ON
            p1 = 1
            logger.debug(f"AUTO-WATER: jarak={jarak_cm}>{jarak_on} → pompa1=ON")
        elif jarak_cm < jarak_off:
            # Water sufficient → turn pump OFF
            p1 = 0
            logger.debug(f"AUTO-WATER: jarak={jarak_cm}<{jarak_off} → pompa1=OFF")
        # else: within deadband (jarak_off <= jarak_cm <= jarak_on) → no change

    # =====================================================================
    # PRIORITY 2: Pompa 2 — TDS/Nutrient Dosing (tds_value based)
    # =====================================================================
    p2 = pompa2_state

    # Pompa 2 (TDS Dosing) — controlled by rule_tds (primary) or rule_ph (backward compat)
    # If rule_tds is explicitly in config, use it directly.
    # Otherwise fall back to rule_ph (for backward compatibility with existing configs).
    if "rule_tds" in config:
        pompa2_enabled = rules["rule_tds"]
    else:
        pompa2_enabled = rules["rule_ph"]
    if pompa2_enabled:
        # Pompa 2 is controlled by TDS (nutrient) thresholds
        # CORRECTED LOGIC: When TDS is LOW, nutrients are low → dosing ON
        # When TDS is HIGH, nutrients sufficient → dosing OFF
        #   tds_on  = LOW  threshold — pump ON  when TDS drops below this
        #   tds_off = HIGH threshold — pump OFF when TDS rises above this
        # Hysteresis: tds_off > tds_on (deadband in between)
        if tds_value < tds_on:
            # Nutrients too low → turn dosing pump ON
            p2 = 1
            logger.debug(f"AUTO-TDS: tds={tds_value:.0f}<{tds_on:.0f} → pompa2=ON")
        elif tds_value > tds_off:
            # Nutrients sufficient → turn dosing pump OFF
            p2 = 0
            logger.debug(f"AUTO-TDS: tds={tds_value:.0f}>{tds_off:.0f} → pompa2=OFF")
        # else: within deadband (tds_off <= tds_value <= tds_on) → no change

    return p1, p2
