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
    """Independent bang-bang hysteresis: P1=water, P2=TDS/nutrient."""

    DEFAULTS = {
        "jarak_on": 105,     # cm — water ON threshold (jarak > 105 → pump ON)
        "jarak_off": 95,     # cm — water OFF threshold (jarak < 95 → pump OFF)
        "tds_on": 95.0,      # ppm — TDS LOW threshold (tds < 95 → dosing ON)
        "tds_off": 105.0,    # ppm — TDS HIGH threshold (tds > 105 → dosing OFF)
    }

    def test_pompa1_on_when_jarak_high(self):
        """jarak > JARAK_ON → Pompa 1 turns ON (water). TDS low → P2 also ON."""
        p1, p2 = evaluate_thresholds(120, 50, self.DEFAULTS, 0, 0)
        assert p1 == 1  # water low → ON
        assert p2 == 1  # TDS 50 < 95 (tds_on) → ON (nutrients depleted)

    def test_pompa2_on_when_tds_low(self):
        """tds < TDS_ON (95) → Pompa 2 turns ON (nutrients depleted). P1 unchanged."""
        p1, p2 = evaluate_thresholds(80, 50, self.DEFAULTS, 0, 0)
        assert p1 == 0  # water normal → OFF
        assert p2 == 1  # TDS 50 < 95 → ON (nutrients low)

    def test_pompa2_off_when_tds_high(self):
        """tds > TDS_OFF (105) → Pompa 2 turns OFF (nutrients sufficient). P1 unchanged."""
        p1, p2 = evaluate_thresholds(80, 150, self.DEFAULTS, 0, 0)
        assert p1 == 0  # water normal → OFF
        assert p2 == 0  # TDS 150 > 105 → OFF (nutrients sufficient)

    def test_both_pumps_on_independently(self):
        """jarak > JARAK_ON AND tds < TDS_ON → both ON independently."""
        p1, p2 = evaluate_thresholds(120, 50, self.DEFAULTS, 0, 0)
        assert p1 == 1  # water low → ON
        assert p2 == 1  # TDS 50 < 95 → ON (nutrients low)

    def test_pompa1_off_when_jarak_recovered(self):
        """jarak < JARAK_OFF → Pompa 1 turns OFF. P2 unchanged (tds still low)."""
        p1, p2 = evaluate_thresholds(80, 50, self.DEFAULTS, 1, 1)
        assert p1 == 0  # water recovered → OFF
        assert p2 == 1  # TDS 50 < 95 → stays ON (still low)

    def test_pompa2_off_when_tds_recovered(self):
        """tds > TDS_OFF (105) → Pompa 2 turns OFF. P1 unchanged (jarak still high)."""
        p1, p2 = evaluate_thresholds(120, 200, self.DEFAULTS, 1, 1)
        assert p1 == 1  # water still low → stays ON
        assert p2 == 0  # TDS 200 > 105 → OFF (sufficient)

    def test_pumps_stay_off_within_band(self):
        """Within hysteresis band (tds 95-105) → keep current state (OFF)."""
        p1, p2 = evaluate_thresholds(100, 100, self.DEFAULTS, 0, 0)
        assert p1 == 0
        assert p2 == 0

    def test_pumps_stay_on_within_band(self):
        """Within hysteresis band (tds 95-105) → keep current state (ON)."""
        p1, p2 = evaluate_thresholds(100, 100, self.DEFAULTS, 1, 1)
        assert p1 == 1
        assert p2 == 1

    def test_ultrasonik_invalid_pompa1_unchanged(self):
        """jarak_cm = 999 → P1 unchanged (invalid sensor). P2 still independent."""
        p1, p2 = evaluate_thresholds(999, 50, self.DEFAULTS, 1, 0)
        assert p1 == 1  # unchanged (ultrasonik invalid)
        assert p2 == 1  # TDS 50 < 95 → ON (nutrients low, independent!)

    def test_ultrasonik_zero_pompa1_unchanged(self):
        """jarak_cm = 0 → P1 unchanged. P2 still independent."""
        p1, p2 = evaluate_thresholds(0, 50, self.DEFAULTS, 0, 0)
        assert p1 == 0  # unchanged
        assert p2 == 1  # TDS 50 < 95 → ON

    def test_jarak_boundary_off(self):
        """jarak_cm == JARAK_OFF (95) → not less than, so P1 stays unchanged."""
        p1, p2 = evaluate_thresholds(95, 150, self.DEFAULTS, 1, 1)
        # jarak=95 not >105, not <95 → unchanged
        # tds=150 > 105 → P2 OFF
        assert p1 == 1
        assert p2 == 0

    def test_tds_boundaries(self):
        """tds == 95 (TDS_ON) → not less than, so unchanged.
           tds == 105 (TDS_OFF) → not greater than, so unchanged."""
        p1, p2 = evaluate_thresholds(80, 95, self.DEFAULTS, 0, 1)
        # jarak=80 < 95 → P1 OFF
        # tds=95 not < 95, not > 105 → unchanged (stays ON)
        assert p1 == 0
        assert p2 == 1

    def test_custom_thresholds(self):
        """Custom thresholds should be used instead of defaults."""
        custom = {"jarak_on": 50, "jarak_off": 40, "tds_on": 400, "tds_off": 500}
        p1, p2 = evaluate_thresholds(60, 300, custom, 0, 0)
        assert p1 == 1  # jarak=60 > 50 → P1 ON
        assert p2 == 1  # tds=300 < 400 → P2 ON (nutrients low)

        p1, p2 = evaluate_thresholds(35, 300, custom, 1, 1)
        assert p1 == 0  # jarak=35 < 40 → P1 OFF
        assert p2 == 1  # tds=300 < 400 → still ON (still low)

        p1, p2 = evaluate_thresholds(35, 600, custom, 1, 1)
        assert p1 == 0  # jarak=35 < 40 → P1 OFF
        assert p2 == 0  # tds=600 > 500 → OFF (nutrients sufficient)

    # ── Automation Rules Tests ────────────────────────────────────────────

    def test_auto_disabled_keeps_current_state(self):
        """auto_enabled=False → return current states unchanged."""
        config = {**self.DEFAULTS, "auto_enabled": False}
        p1, p2 = evaluate_thresholds(120, 200, config, 0, 0)
        assert p1 == 0  # unchanged
        assert p2 == 0  # unchanged

    def test_auto_disabled_pumps_on(self):
        """auto_enabled=False → return current states unchanged even if ON."""
        config = {**self.DEFAULTS, "auto_enabled": False}
        p1, p2 = evaluate_thresholds(120, 200, config, 1, 1)
        assert p1 == 1
        assert p2 == 1

    def test_rule_ph_disabled_pompa2_unchanged(self):
        """rule_ph=False (aliases rule_tds) → Pompa 2 stays at current state."""
        config = {**self.DEFAULTS, "rule_ph": False, "rule_tds": False}
        p1, p2 = evaluate_thresholds(80, 50, config, 0, 0)
        assert p1 == 0  # water normal → stays OFF
        assert p2 == 0  # Pompa 2 stays OFF (rules disabled, even though TDS < 95)

    def test_rule_water_disabled_pompa1_unchanged(self):
        """rule_water=False → Pompa 1 automation skipped."""
        config = {**self.DEFAULTS, "rule_water": False}
        p1, p2 = evaluate_thresholds(120, 50, config, 0, 0)
        # P1: rule_water=False → unchanged (0)
        # P2: tds=50<95 → ON
        assert p1 == 0
        assert p2 == 1

    def test_rule_tds_disabled_pompa2_unchanged(self):
        """rule_tds=False → Pompa 2 automation skipped."""
        config = {**self.DEFAULTS, "rule_tds": False}
        p1, p2 = evaluate_thresholds(120, 50, config, 0, 0)
        # P1: jarak=120>105 → ON
        # P2: rule_tds=False → unchanged (0), even though TDS<95
        assert p1 == 1
        assert p2 == 0

    def test_all_rules_disabled_keeps_state(self):
        """All rules disabled → no automation triggers."""
        config = {**self.DEFAULTS, "rule_ph": False, "rule_tds": False, "rule_water": False}
        p1, p2 = evaluate_thresholds(120, 50, config, 1, 0)
        assert p1 == 1  # unchanged
        assert p2 == 0  # unchanged

    def test_independent_rules_water_only(self):
        """Only rule_water active → only P1 triggers."""
        config = {**self.DEFAULTS, "rule_water": True, "rule_tds": False}
        p1, p2 = evaluate_thresholds(120, 50, config, 0, 0)
        assert p1 == 1  # jarak=120>105 → ON
        assert p2 == 0  # rule_tds=False → unchanged (TDS<95 would trigger but disabled)

    def test_independent_rules_tds_only(self):
        """Only rule_tds active → only P2 triggers."""
        config = {**self.DEFAULTS, "rule_water": False, "rule_tds": True}
        p1, p2 = evaluate_thresholds(120, 50, config, 0, 0)
        assert p1 == 0  # rule_water=False → unchanged
        assert p2 == 1  # tds=50<95 → ON (nutrients low)


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
        # Automation is disabled → pumps reported as-is (backend doesn't override hardware)
        assert data["pumps_reported"]["pompa1"] == 0
        assert data["pumps_reported"]["pompa2"] == 0


# ===========================================================================
# Integration: POST /sensors/reading with automation
# ===========================================================================

class TestPostSensorReadingAutomation:
    """End-to-end tests for the REST endpoint with the automation engine."""

    @pytest.mark.asyncio
    async def test_sensor_reading_with_automation(self, client, mock_db):
        """high jarak → P1 ON. high tds → P2 ON. Both ON independently."""
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
        # Backend persists actual hardware states (pumps_reported), not computed ones.
        # Both pumps were sent as 0 → reported as 0.
        assert data["pumps_reported"]["pompa1"] == 0
        assert data["pumps_reported"]["pompa2"] == 0

    @pytest.mark.asyncio
    async def test_sensor_reading_independent_control(self, client, mock_db):
        """Only jarak high, TDS normal → backend reports actual pump states."""
        await create_test_device_config(mock_db)

        response = await client.post(
            "/api/v1/sensors/reading",
            json={
                "device_id": "HELIO_TEST",
                "ts": 1760000000,
                "jarak_cm": 120,
                "tds_value": 50,
                "current_ph": 6.5,
                "pompa1": 0,
                "pompa2": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["pumps_reported"]["pompa1"] == 0  # hardware reports OFF
        assert data["pumps_reported"]["pompa2"] == 0  # hardware reports OFF

    @pytest.mark.asyncio
    async def test_sensor_reading_within_band(self, client, mock_db):
        """Values within hysteresis band → pumps reported as-is."""
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
        assert data["pumps_reported"]["pompa1"] == 0  # hardware reports OFF
        assert data["pumps_reported"]["pompa2"] == 0  # hardware reports OFF

    @pytest.mark.asyncio
    async def test_sensor_reading_no_config_falls_back(self, client, mock_db):
        """No device config → backend persists actual hardware states."""
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
        assert data["pumps_reported"]["pompa1"] == 0  # hardware reports OFF
        assert data["pumps_reported"]["pompa2"] == 0  # hardware reports OFF

    @pytest.mark.asyncio
    async def test_sensor_reading_valid_range(self, client, mock_db):
        """All values within safe range → pump states reported as-is."""
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
        assert data["pumps_reported"]["pompa1"] == 0  # hardware reports OFF
        assert data["pumps_reported"]["pompa2"] == 0  # hardware reports OFF

    @pytest.mark.asyncio
    async def test_sensor_reading_independent_tds_only(self, client, mock_db):
        """Only TDS high, water normal → backend reports actual hardware states."""
        await create_test_device_config(mock_db)

        response = await client.post(
            "/api/v1/sensors/reading",
            json={
                "device_id": "HELIO_TEST",
                "ts": 1760000000,
                "jarak_cm": 80,
                "tds_value": 200,
                "current_ph": 6.5,
                "pompa1": 0,
                "pompa2": 0,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["pumps_reported"]["pompa1"] == 0  # hardware reports OFF
        assert data["pumps_reported"]["pompa2"] == 0  # hardware reports OFF

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
            },
        )
        assert response.status_code == 200
        data = response.json()
        # Backend reports what hardware said — never overrides
        assert data["pumps_reported"]["pompa1"] == 1
        assert data["pumps_reported"]["pompa2"] == 1



