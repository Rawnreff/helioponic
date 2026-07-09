"""
Threshold-based automation engine — matches raw ESP32 firmware logic.

The raw firmware uses bang-bang (hysteresis) control:
  Pompa 1 ON  → when jarak_cm > JARAK_ON && tds_value > TDS_ON
  Pompa 1 OFF → when jarak_cm < JARAK_OFF || tds_value < TDS_OFF
  Pompa 2 ON  → when jarak_cm > JARAK_ON && tds_value > TDS_ON
  Pompa 2 OFF → when jarak_cm < JARAK_OFF || tds_value < TDS_OFF

This matches the ESP32's runtime_jarak_on/off and runtime_tds_on/off variables.

Respects per-device automation rules:
  - auto_enabled: Master toggle — if False, skip all automation
  - rule_ph: pH rule toggle — if False, skip Pompa 2 automation
  - rule_tds: TDS rule toggle — if False, skip TDS-based triggers
  - rule_water: Water rule toggle — if False, skip distance-based triggers
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
    """Apply bang-bang hysteresis automation matching raw ESP32 firmware.

    Respects automation rule toggles from the device config:
      - If auto_enabled=False, returns current states unchanged
      - If rule_ph=False, Pompa 2 is not automated
      - If rule_tds=False, TDS thresholds are ignored
      - If rule_water=False, distance thresholds are ignored

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
    jarak_on  = config.get("jarak_on", 105)
    jarak_off = config.get("jarak_off", 95)
    tds_on    = config.get("tds_on", 105.0)
    tds_off   = config.get("tds_off", 95.0)

    rules = get_automation_rules(config)

    ultrasonik_valid = (jarak_cm != 999 and jarak_cm > 0)

    if not ultrasonik_valid:
        # Ultrasonic out of range — keep current states
        return pompa1_state, pompa2_state

    # ── Master Toggle: if auto is disabled, return current states ─────
    if not rules["auto_enabled"]:
        return pompa1_state, pompa2_state

    # ---- Pompa 1 (Circulation) ----
    p1 = pompa1_state
    # Pompa 1 needs both distance (water rule) and TDS (tds rule) triggers
    distance_condition = False
    tds_condition = False

    if rules["rule_water"]:
        distance_condition = jarak_cm > jarak_on
        distance_off_triggered = jarak_cm < jarak_off
    else:
        # If water rule disabled, distance doesn't trigger
        distance_condition = False
        distance_off_triggered = False

    if rules["rule_tds"]:
        tds_condition = tds_value > tds_on
        tds_off_triggered = tds_value < tds_off
    else:
        # If TDS rule disabled, TDS doesn't trigger
        tds_condition = False
        tds_off_triggered = False

    # Apply Pompa 1 logic
    if distance_condition and tds_condition:
        p1 = 1
        logger.debug(f"AUTO: jarak={jarak_cm}>{jarak_on} && tds={tds_value:.0f}>{tds_on:.0f} → pompa1=ON")
    elif distance_off_triggered or tds_off_triggered:
        p1 = 0
        logger.debug(f"AUTO: jarak={jarak_cm}<{jarak_off} || tds={tds_value:.0f}<{tds_off:.0f} → pompa1=OFF")

    # ---- Pompa 2 (pH Dosing) ----
    p2 = pompa2_state

    # If pH rule is disabled, skip Pompa 2 automation entirely
    if rules["rule_ph"]:
        if distance_condition and tds_condition:
            p2 = 1
            logger.debug(f"AUTO: jarak={jarak_cm}>{jarak_on} && tds={tds_value:.0f}>{tds_on:.0f} → pompa2=ON")
        elif distance_off_triggered or tds_off_triggered:
            p2 = 0
            logger.debug(f"AUTO: jarak={jarak_cm}<{jarak_off} || tds={tds_value:.0f}<{tds_off:.0f} → pompa2=OFF")

    return p1, p2
