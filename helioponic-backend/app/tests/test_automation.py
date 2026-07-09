"""Tests for the threshold automation engine (app/services/automation.py).

Covers the bang-bang hysteresis logic matching the raw ESP32 firmware:
  - Pompa 1 ON  → jarak_cm > JARAK_ON && tds_value > TDS_ON
  - Pompa 1 OFF → jarak_cm < JARAK_OFF || tds_value < TDS_OFF
  - Pompa 2 ON  → same conditions as Pompa 1
  - Pompa 2 OFF → same conditions as Pompa 1
"""

import pytest

from app.services.automation import evaluate_thresholds
from .conftest import create_test_device_config, create_test_user, create_test_device, get_auth_header


# ===========================================================================
# Unit: evaluate_thresholds
# ===========================================================================

class TestEvaluateThresholds:
    """Bang-bang hysteresis automation matching raw ESP32 firmware."""

    DEFAULTS = {
        "jarak_on": 105,
        "jarak_off": 95,
        "tds_on": 105.0,
        "tds_off": 95.0,
    }

    def test_both_pumps_on_when_below_thresholds(self):
        """jarak > JARAK_ON and tds > TDS_ON → both pumps turn ON."""
        p1, p2 = evaluate_thresholds(120, 150, self.DEFAULTS, 0, 0)
        assert p1 == 1
        assert p2 == 1

    def test_both_pumps_off_when_jarak_recovered(self):
        """jarak < JARAK_OFF → both pumps turn OFF."""
        p1, p2 = evaluate_thresholds(80, 150, self.DEFAULTS, 1, 1)
        assert p1 == 0
        assert p2 == 0

    def test_both_pumps_off_when_tds_recovered(self):
        """tds < TDS_OFF → both pumps turn OFF."""
        p1, p2 = evaluate_thresholds(120, 50, self.DEFAULTS, 1, 1)
        assert p1 == 0
        assert p2 == 0

    def test_pumps_stay_off_within_band(self):
        """Within hysteresis band → keep current state (OFF)."""
        p1, p2 = evaluate_thresholds(100, 100, self.DEFAULTS, 0, 0)
        assert p1 == 0
        assert p2 == 0

    def test_pumps_stay_on_within_band(self):
        """Within hysteresis band → keep current state (ON)."""
        p1, p2 = evaluate_thresholds(100, 100, self.DEFAULTS, 1, 1)
        assert p1 == 1
        assert p2 == 1

    def test_ultrasonik_invalid_keeps_state(self):
        """jarak_cm = 999 (out of range) → keep current state unchanged."""
        p1, p2 = evaluate_thresholds(999, 200, self.DEFAULTS, 1, 0)
        assert p1 == 1  # unchanged
        assert p2 == 0  # unchanged

    def test_ultrasonik_zero_keeps_state(self):
        """jarak_cm = 0 (invalid) → keep current state unchanged."""
        p1, p2 = evaluate_thresholds(0, 200, self.DEFAULTS, 0, 1)
        assert p1 == 0  # unchanged
        assert p2 == 1  # unchanged

    def test_jarak_boundary_off(self):
        """jarak_cm == JARAK_OFF (95) → not less than, so keep state."""
        p1, p2 = evaluate_thresholds(95, 50, self.DEFAULTS, 1, 1)
        # tds < tds_off (50 < 95), so both turn OFF
        assert p1 == 0
        assert p2 == 0

    def test_tds_boundary_off(self):
        """tds == TDS_OFF (95) → not less than, so check jarak."""
        p1, p2 = evaluate_thresholds(80, 95, self.DEFAULTS, 1, 0)
        # jarak < jarak_off (80 < 95), so both turn OFF
        assert p1 == 0
        assert p2 == 0

    def test_custom_thresholds(self):
        """Custom thresholds should be used instead of defaults."""
        custom = {"jarak_on": 50, "jarak_off": 40, "tds_on": 500, "tds_off": 400}
        p1, p2 = evaluate_thresholds(60, 600, custom, 0, 0)
        assert p1 == 1
        assert p2 == 1

        p1, p2 = evaluate_thresholds(35, 600, custom, 1, 1)
        assert p1 == 0  # jarak < 40
        assert p2 == 0

    # ── Automation Rules Tests ────────────────────────────────────────────

    def test_auto_disabled_keeps_current_state(self):
        """auto_enabled=False → return current states unchanged."""
        config = {**self.DEFAULTS, "auto_enabled": False}
        p1, p2 = evaluate_thresholds(120, 200, config, 0, 0)
        assert p1 == 0  # unchanged (would be ON if auto enabled)
        assert p2 == 0  # unchanged

    def test_auto_disabled_pumps_on(self):
        """auto_enabled=False → return current states unchanged even if ON."""
        config = {**self.DEFAULTS, "auto_enabled": False}
        p1, p2 = evaluate_thresholds(120, 200, config, 1, 1)
        assert p1 == 1  # unchanged (would stay ON anyway, but still)
        assert p2 == 1

    def test_rule_ph_disabled_pompa2_unchanged(self):
        """rule_ph=False → Pompa 2 stays at current state."""
        config = {**self.DEFAULTS, "rule_ph": False}
        p1, p2 = evaluate_thresholds(120, 200, config, 0, 0)
        assert p1 == 1  # Pompa 1 turns ON (not affected by rule_ph)
        assert p2 == 0  # Pompa 2 stays OFF (rule_ph disabled)

    def test_rule_tds_disabled_no_tds_trigger(self):
        """rule_tds=False → TDS thresholds are ignored."""
        config = {**self.DEFAULTS, "rule_tds": False}
        # jarak > jarak_on but TDS rule disabled → shouldn't trigger on TDS alone
        p1, p2 = evaluate_thresholds(120, 200, config, 0, 0)
        # With rule_tds=False, only distance matters but TDS is also needed
        # Since TDS rule is off, tds_condition=False → both pumps stay OFF
        assert p1 == 0
        assert p2 == 0

    def test_rule_water_disabled_no_distance_trigger(self):
        """rule_water=False → distance thresholds are ignored."""
        config = {**self.DEFAULTS, "rule_water": False}
        p1, p2 = evaluate_thresholds(120, 200, config, 0, 0)
        # With rule_water=False, only TDS matters but distance is also needed
        # Since water rule is off, distance_condition=False → both pumps stay OFF
        assert p1 == 0
        assert p2 == 0

    def test_all_rules_disabled_keeps_state(self):
        """All rules disabled → no automation triggers."""
        config = {**self.DEFAULTS, "rule_ph": False, "rule_tds": False, "rule_water": False}
        p1, p2 = evaluate_thresholds(120, 200, config, 1, 0)
        assert p1 == 1  # unchanged
        assert p2 == 0  # unchanged

    def test_only_tds_rule_active_tds_triggers(self):
        """Only rule_tds active, TDS high → trigger. But need both conditions."""
        config = {**self.DEFAULTS, "rule_water": False, "rule_ph": True, "rule_tds": True}
        # rule_water=False → distance_condition=False
        # rule_tds=True and tds > tds_on → tds_condition=True
        # But both must be true to turn ON (distance_condition AND tds_condition)
        # distance_condition=False → pumps stay OFF
        p1, p2 = evaluate_thresholds(120, 200, config, 0, 0)
        assert p1 == 0
        assert p2 == 0

    def test_rule_water_and_tds_active_triggers(self):
        """Both water and TDS rules active, all conditions met → trigger."""
        config = {**self.DEFAULTS, "rule_ph": True, "rule_tds": True, "rule_water": True}
        p1, p2 = evaluate_thresholds(120, 200, config, 0, 0)
        assert p1 == 1
        assert p2 == 1


# ===========================================================================
# Integration: POST /sensors/reading with automation
# ===========================================================================

# ===========================================================================
# Integration: GET/PUT /devices/automation
# ===========================================================================

class TestAutomationRulesAPI:
    """Tests for the automation rules CRUD endpoints."""

    @pytest.mark.asyncio
    async def test_get_automation_rules_defaults(self, client, mock_db):
        """GET without existing config → return default enabled values."""
        user_id = await create_test_user(mock_db)
        await create_test_device(mock_db, user_id, "HELIO_TEST")
        headers = get_auth_header(user_id)

        response = await client.get(
            "/api/v1/devices/automation?device_id=HELIO_TEST",
            headers=headers,
        )
        assert response.status_code == 200
        data = response.json()
        assert data["auto_enabled"] is True
        assert data["rule_ph"] is True
        assert data["rule_tds"] is True
        assert data["rule_water"] is True
        assert data["device_id"] == "HELIO_TEST"

    @pytest.mark.asyncio
    async def test_update_automation_rules(self, client, mock_db):
        """PUT with all disabled → verify stored and returned."""
        user_id = await create_test_user(mock_db)
        await create_test_device(mock_db, user_id, "HELIO_RULES")
        headers = get_auth_header(user_id)

        response = await client.put(
            "/api/v1/devices/automation",
            json={
                "device_id": "HELIO_RULES",
                "auto_enabled": False,
                "rule_ph": False,
                "rule_tds": True,
                "rule_water": False,
            },
            headers=headers,
        )
        assert response.status_code == 200
        data = response.json()
        assert data["auto_enabled"] is False
        assert data["rule_ph"] is False
        assert data["rule_tds"] is True
        assert data["rule_water"] is False
        assert "updated_at" in data

        # Verify the value persists on next GET
        response2 = await client.get(
            "/api/v1/devices/automation?device_id=HELIO_RULES",
            headers=headers,
        )
        assert response2.status_code == 200
        data2 = response2.json()
        assert data2["auto_enabled"] is False
        assert data2["rule_ph"] is False

    @pytest.mark.asyncio
    async def test_automation_rules_affects_automation(self, client, mock_db):
        """With auto_enabled=False → automation engine doesn't override pumps."""
        user_id = await create_test_user(mock_db)
        await create_test_device(mock_db, user_id, "HELIO_AUTO")
        headers = get_auth_header(user_id)

        # First disable automation
        await client.put(
            "/api/v1/devices/automation",
            json={
                "device_id": "HELIO_AUTO",
                "auto_enabled": False,
                "rule_ph": True,
                "rule_tds": True,
                "rule_water": True,
            },
            headers=headers,
        )

        # Now send a sensor reading that would trigger pumps
        response = await client.post(
            "/api/v1/sensors/reading",
            json={
                "device_id": "HELIO_AUTO",
                "ts": 1760000000,
                "jarak_cm": 120,
                "tds_value": 200,
                "current_ph": 6.5,
                "pompa1": 0,
                "pompa2": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        # Automation is disabled → pumps should stay 0
        assert data["pumps_applied"]["pompa1"] == 0
        assert data["pumps_applied"]["pompa2"] == 0


# ===========================================================================
# Integration: POST /sensors/reading with automation
# ===========================================================================

class TestPostSensorReadingAutomation:
    """End-to-end tests for the REST endpoint with the automation engine."""

    @pytest.mark.asyncio
    async def test_sensor_reading_with_automation(self, client, mock_db):
        """high jarak + high tds → both pumps turn ON."""
        await create_test_device_config(mock_db)

        response = await client.post(
            "/api/v1/sensors/reading",
            json={
                "device_id": "HELIO_TEST",
                "ts": 1760000000,
                "jarak_cm": 120,
                "tds_value": 200,
                "current_ph": 6.5,
                "pompa1": 0,
                "pompa2": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["pumps_applied"]["pompa1"] == 1  # turned ON by automation
        assert data["pumps_applied"]["pompa2"] == 1  # turned ON by automation

    @pytest.mark.asyncio
    async def test_sensor_reading_within_band(self, client, mock_db):
        """Values within hysteresis band → pumps stay as-is."""
        await create_test_device_config(mock_db)

        response = await client.post(
            "/api/v1/sensors/reading",
            json={
                "device_id": "HELIO_TEST",
                "ts": 1760000000,
                "jarak_cm": 100,
                "tds_value": 100,
                "current_ph": 6.5,
                "pompa1": 0,
                "pompa2": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["pumps_applied"]["pompa1"] == 0  # stay OFF
        assert data["pumps_applied"]["pompa2"] == 0  # stay OFF

    @pytest.mark.asyncio
    async def test_sensor_reading_no_config_falls_back(self, client, mock_db):
        """No device config → use default thresholds (105/95)."""
        response = await client.post(
            "/api/v1/sensors/reading",
            json={
                "device_id": "HELIO_TEST",
                "ts": 1760000000,
                "jarak_cm": 120,
                "tds_value": 200,
                "current_ph": 6.5,
                "pompa1": 0,
                "pompa2": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        # With empty config, defaults are: jarak_on=105, tds_on=105
        assert data["pumps_applied"]["pompa1"] == 1
        assert data["pumps_applied"]["pompa2"] == 1

    @pytest.mark.asyncio
    async def test_sensor_reading_valid_range(self, client, mock_db):
        """All values within safe range → both pumps OFF."""
        await create_test_device_config(mock_db)

        response = await client.post(
            "/api/v1/sensors/reading",
            json={
                "device_id": "HELIO_TEST",
                "ts": 1760000000,
                "jarak_cm": 15,
                "tds_value": 50,
                "current_ph": 6.5,
                "pompa1": 0,
                "pompa2": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["pumps_applied"]["pompa1"] == 0  # stay OFF
        assert data["pumps_applied"]["pompa2"] == 0  # stay OFF



