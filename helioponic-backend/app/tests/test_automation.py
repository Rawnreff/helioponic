"""Tests for the threshold automation engine (app/services/automation.py).

Covers the 4-pump bang-bang hysteresis logic:
  - Pompa 1 (Water Refill):  jarak_cm bang-bag hysteresis
  - Pompa 2 (pH DOWN):       pH bang-bang hysteresis
  - Pompa 3+4 (Nutrisi A+B): Tandem TDS — both ON when tds < tds_on, both OFF when tds > tds_off
"""

import pytest

from app.services.automation import evaluate_thresholds
from .conftest import create_test_device_config, create_test_user, create_test_device, get_auth_header


# ===========================================================================
# Unit: evaluate_thresholds
# ===========================================================================

class TestEvaluateThresholds:
    """4-pump bang-bang hysteresis: P1=water, P2=pH, P3+P4=TDS tandem."""

    DEFAULTS = {
        "jarak_on": 105,     # cm — water ON threshold (jarak > 105 → pump ON)
        "jarak_off": 95,     # cm — water OFF threshold (jarak < 95 → pump OFF)
        "tds_on": 95.0,      # ppm — TDS LOW threshold (tds < 95 → dosing ON)
        "tds_off": 105.0,    # ppm — TDS HIGH threshold (tds > 105 → dosing OFF)
    }

    def test_pompa1_on_when_jarak_high(self):
        """jarak > JARAK_ON → Pompa 1 turns ON (water). TDS low → P3+P4 also ON."""
        p1, p2, p3, p4 = evaluate_thresholds(120, 50, self.DEFAULTS, 0, 0, 0, 0)
        assert p1 == 1  # water low → ON
        assert p3 == 1  # TDS 50 < 95 (tds_on) → ON (nutrients depleted)
        assert p4 == 1  # TDS 50 < 95 → P4 also ON (tandem)

    def test_pompa3_pompa4_tandem_tds_low(self):
        """tds < TDS_ON (95) → Pompa 3 AND Pompa 4 both turn ON simultaneously."""
        p1, p2, p3, p4 = evaluate_thresholds(80, 50, self.DEFAULTS, 0, 0, 0, 0)
        assert p1 == 0  # water normal → OFF
        assert p2 == 0  # pH not provided, rule_ph not in config
        assert p3 == 1  # TDS 50 < 95 → ON (nutrients low)
        assert p4 == 1  # TANDEM: P4 same as P3

    def test_pompa3_pompa4_off_when_tds_high(self):
        """tds > TDS_OFF (105) → Pompa 3 AND 4 both turn OFF."""
        p1, p2, p3, p4 = evaluate_thresholds(80, 150, self.DEFAULTS, 0, 0, 0, 0)
        assert p1 == 0  # water normal → OFF
        assert p3 == 0  # TDS 150 > 105 → OFF (nutrients sufficient)
        assert p4 == 0  # TANDEM: P4 same as P3

    def test_both_tandem_pumps_on_within_deadband(self):
        """Within hysteresis band (tds 95-105) → keep current state (both stay ON)."""
        p1, p2, p3, p4 = evaluate_thresholds(100, 100, self.DEFAULTS, 0, 0, 1, 1)
        assert p3 == 1  # stays ON (deadband)
        assert p4 == 1  # stays ON (deadband)

    def test_both_tandem_pumps_off_within_deadband(self):
        """Within hysteresis band (tds 95-105) → keep current state (both stay OFF)."""
        p1, p2, p3, p4 = evaluate_thresholds(100, 100, self.DEFAULTS, 0, 0, 0, 0)
        assert p3 == 0  # stays OFF (deadband)
        assert p4 == 0  # stays OFF (deadband)

    def test_auto_disabled_keeps_all_states(self):
        """auto_enabled=False → return all 4 current states unchanged."""
        config = {**self.DEFAULTS, "auto_enabled": False}
        p1, p2, p3, p4 = evaluate_thresholds(120, 200, config, 0, 0, 0, 0)
        assert p1 == 0
        assert p2 == 0
        assert p3 == 0
        assert p4 == 0

    def test_auto_disabled_pumps_on(self):
        """auto_enabled=False → return current states unchanged even if ON."""
        config = {**self.DEFAULTS, "auto_enabled": False}
        p1, p2, p3, p4 = evaluate_thresholds(120, 200, config, 1, 1, 1, 1)
        assert p1 == 1
        assert p2 == 1
        assert p3 == 1
        assert p4 == 1

    def test_rule_water_disabled_pompa1_unchanged(self):
        """rule_water=False → Pompa 1 automation skipped. TDS still works."""
        config = {**self.DEFAULTS, "rule_water": False}
        p1, p2, p3, p4 = evaluate_thresholds(120, 50, config, 0, 0, 0, 0)
        assert p1 == 0  # rule_water=False → unchanged
        assert p3 == 1  # tds=50<95 → ON
        assert p4 == 1  # tandem

    def test_rule_tds_disabled_pompa3_pompa4_unchanged(self):
        """rule_tds=False → P3+P4 automation skipped."""
        config = {**self.DEFAULTS, "rule_tds": False}
        p1, p2, p3, p4 = evaluate_thresholds(120, 50, config, 0, 0, 0, 0)
        assert p1 == 1  # jarak=120>105 → ON
        assert p3 == 0  # rule_tds=False → unchanged (even though TDS<95)
        assert p4 == 0  # tandem

    def test_all_rules_disabled_keeps_state(self):
        """All rules disabled → no automation triggers for any pump."""
        config = {**self.DEFAULTS, "rule_ph": False, "rule_tds": False, "rule_water": False}
        p1, p2, p3, p4 = evaluate_thresholds(120, 50, config, 1, 0, 1, 0)
        assert p1 == 1
        assert p2 == 0
        assert p3 == 1
        assert p4 == 0

    def test_custom_thresholds(self):
        """Custom thresholds should be used instead of defaults."""
        custom = {"jarak_on": 50, "jarak_off": 40, "tds_on": 400, "tds_off": 500}
        p1, p2, p3, p4 = evaluate_thresholds(60, 300, custom, 0, 0, 0, 0)
        assert p1 == 1  # jarak=60 > 50 → P1 ON
        assert p3 == 1  # tds=300 < 400 → P3+P4 ON
        assert p4 == 1

        p1, p2, p3, p4 = evaluate_thresholds(35, 300, custom, 1, 1, 1, 1)
        assert p1 == 0  # jarak=35 < 40 → P1 OFF
        assert p3 == 1  # tds=300 < 400 → still ON
        assert p4 == 1

        p1, p2, p3, p4 = evaluate_thresholds(35, 600, custom, 1, 1, 1, 1)
        assert p1 == 0  # jarak=35 < 40 → P1 OFF
        assert p3 == 0  # tds=600 > 500 → OFF
        assert p4 == 0


# ===========================================================================
# Integration: POST /sensors/reading with automation
# ===========================================================================

class TestPostSensorReadingAutomation:
    """End-to-end tests for the REST endpoint with the 4-pump automation engine."""

    @pytest.mark.asyncio
    async def test_sensor_reading_with_automation(self, client, mock_db):
        """high jarak → P1 ON. low tds → P3+P4 ON. All reported AS-IS."""
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
                "pompa3": 0,
                "pompa4": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        # Backend persists actual hardware states (pumps_reported), not computed ones.
        assert data["pumps_reported"]["pompa1"] == 0
        assert data["pumps_reported"]["pompa3"] == 0
        assert data["pumps_reported"]["pompa4"] == 0

    @pytest.mark.asyncio
    async def test_sensor_reading_hardware_pump_states_persisted(self, client, mock_db):
        """When hardware reports pumps ON, backend persists the actual states."""
        await create_test_device_config(mock_db)

        response = await client.post(
            "/api/v1/sensors/reading",
            json={
                "device_id": "HELIO_TEST",
                "ts": 1760000000,
                "jarak_cm": 80,
                "tds_value": 200,
                "current_ph": 6.5,
                "pompa1": 1,
                "pompa2": 1,
                "pompa3": 1,
                "pompa4": 1,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["pumps_reported"]["pompa1"] == 1
        assert data["pumps_reported"]["pompa2"] == 1
        assert data["pumps_reported"]["pompa3"] == 1
        assert data["pumps_reported"]["pompa4"] == 1

    @pytest.mark.asyncio
    async def test_sensor_reading_with_automation_tandem_tds(self, client, mock_db):
        """tds low → P3+P4 both reported as-is from hardware."""
        await create_test_device_config(mock_db)

        response = await client.post(
            "/api/v1/sensors/reading",
            json={
                "device_id": "HELIO_TEST",
                "ts": 1760000000,
                "jarak_cm": 80,
                "tds_value": 50,
                "current_ph": 6.5,
                "pompa1": 0,
                "pompa2": 0,
                "pompa3": 0,
                "pompa4": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["pumps_reported"]["pompa3"] == 0  # hardware says OFF
        assert data["pumps_reported"]["pompa4"] == 0


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
                "pompa3": 0,
                "pompa4": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        # Automation is disabled → pumps reported as-is (backend doesn't override hardware)
        assert data["pumps_reported"]["pompa1"] == 0
        assert data["pumps_reported"]["pompa2"] == 0
        assert data["pumps_reported"]["pompa3"] == 0
        assert data["pumps_reported"]["pompa4"] == 0




