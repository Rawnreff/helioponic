"""Tests for the MQTT subscriber (app/mqtt/subscriber.py).

Tests core logic paths of _handle_uplink and _process_deltas using
mock callbacks (no real MQTT broker or MongoDB needed).

All payloads use raw firmware field names: jarak_cm, tds_value, current_ph, pompa1, pompa2.
"""

import json
from datetime import datetime, timedelta, UTC

import pytest

from app.mqtt.subscriber import MQTTSubscriber
from app.models.sensor import SensorReading
from app.services.energy import EnergyCalculator
from app.services.water import WaterCalculator


# ─── Helpers ─────────────────────────────────────────────────────────────

def make_uplink(overrides: dict = None) -> bytes:
    """Create a sensor uplink JSON payload as bytes using raw firmware field names.

    Default values are within the hysteresis deadband (jarak=95-105, tds=95-105)
    so threshold automation preserves the incoming pump states.
    """
    payload = {
        "device_id": "HELIO_001",
        "ts": 1760000000,
        "jarak_cm": 100,       # Within deadband (95-105) — automation won't override
        "tds_value": 100.0,     # Within deadband (95-105) — automation won't override
        "current_ph": 6.5,
        "pompa1": 1,
        "pompa2": 0,
    }
    if overrides:
        payload.update(overrides)
    return json.dumps(payload).encode("utf-8")


class CallbackStore:
    """Simple store to capture async callback arguments for assertions."""

    def __init__(self):
        self.sensor_records = []
        self.energy_records = []
        self.water_records = []
        self.broadcast_data = []

    async def save_sensor(self, record: dict):
        self.sensor_records.append(record)

    async def save_energy(self, record: dict):
        self.energy_records.append(record)

    async def save_water(self, record: dict):
        self.water_records.append(record)

    async def on_sensor_reading(self, data: dict):
        self.broadcast_data.append(data)


def make_subscriber(cb: CallbackStore = None) -> tuple[MQTTSubscriber, CallbackStore]:
    """Create an MQTTSubscriber with mock callbacks."""
    if cb is None:
        cb = CallbackStore()

    sub = MQTTSubscriber(
        energy_calc=EnergyCalculator(),
        water_calc=WaterCalculator(),
        on_sensor_reading=cb.on_sensor_reading,
    )
    sub.save_sensor = cb.save_sensor
    sub.save_energy = cb.save_energy
    sub.save_water = cb.save_water

    return sub, cb


# ===========================================================================
# _handle_uplink — basic parsing & persistence
# ===========================================================================

class TestUplinkBasic:
    """Core MQTT message processing flow."""

    @pytest.mark.asyncio
    async def test_parse_and_save_sensor(self):
        """Basic uplink: parse JSON with raw firmware field names and save."""
        sub, cb = make_subscriber()
        await sub._handle_uplink(make_uplink())

        assert len(cb.sensor_records) == 1
        rec = cb.sensor_records[0]
        assert rec["device_id"] == "HELIO_001"
        assert rec["jarak_cm"] == 100
        assert rec["tds_value"] == 100.0
        assert rec["current_ph"] == 6.5
        assert rec["pompa1"] == 1
        assert rec["pompa2"] == 0

    @pytest.mark.asyncio
    async def test_save_energy_and_water_on_second_message(self):
        """Energy & water records saved after the first message (delta needs prev state)."""
        sub, cb = make_subscriber()

        # First call: initializes state, no energy/water saved yet
        await sub._handle_uplink(make_uplink())
        assert len(cb.energy_records) == 0
        assert len(cb.water_records) == 0

        # Second call: computes deltas, saves energy & water
        # Both jarak values are within deadband, so automation preserves pump states
        await sub._handle_uplink(make_uplink({"jarak_cm": 98, "pompa1": 1, "pompa2": 0}))
        assert len(cb.sensor_records) == 2
        assert len(cb.energy_records) == 1
        assert len(cb.water_records) == 1

        energy = cb.energy_records[0]
        assert energy["pompa1_wh"] > 0  # pompa1 was ON
        assert energy["total_wh"] == energy["pompa1_wh"] + energy["pompa2_wh"]
        assert energy["pompa2_wh"] == 0  # pompa2 was OFF

    @pytest.mark.asyncio
    async def test_broadcast_callback(self):
        """WebSocket callback receives the sensor data with automated pump states."""
        sub, cb = make_subscriber()
        await sub._handle_uplink(make_uplink())

        assert len(cb.broadcast_data) == 1
        data = cb.broadcast_data[0]
        assert data["device_id"] == "HELIO_001"
        assert data["jarak_cm"] == 100
        assert data["tds_value"] == 100.0
        assert data["current_ph"] == 6.5
        assert data["pompa1"] == 1
        assert data["pompa2"] == 0

    @pytest.mark.asyncio
    async def test_malformed_json(self):
        """Malformed JSON should be caught without crashing."""
        sub, cb = make_subscriber()
        await sub._handle_uplink(b"not-json-at-all")

        assert len(cb.sensor_records) == 0
        assert len(cb.broadcast_data) == 0

    @pytest.mark.asyncio
    async def test_device_id_default(self):
        """Missing device_id defaults to 'HELIO_001'."""
        sub, cb = make_subscriber()
        payload = json.dumps({
            "ts": 1760000000, "jarak_cm": 15, "tds_value": 200,
            "current_ph": 6.5, "pompa1": 1, "pompa2": 0,
        }).encode("utf-8")

        await sub._handle_uplink(payload)
        assert cb.sensor_records[0]["device_id"] == "HELIO_001"


# ===========================================================================
# _process_deltas — energy & water state machine
# ===========================================================================

class TestProcessDeltas:
    """Direct tests of the delta calculation state machine."""

    @pytest.mark.asyncio
    async def test_first_message_initializes(self):
        """First call initializes prev state, no records emitted."""
        sub = MQTTSubscriber(EnergyCalculator(), WaterCalculator())
        now = datetime.now(UTC)

        await sub._process_deltas("HELIO_001", 15, 1, 0, now)

        assert sub._initialized is True
        assert sub._prev_jarak_cm == 15

    @pytest.mark.asyncio
    async def test_elapsed_time_capped(self):
        """Interval > 60s is capped to INTERVAL_SECONDS."""
        sub = MQTTSubscriber(EnergyCalculator(), WaterCalculator())
        cb = CallbackStore()
        sub.save_energy = cb.save_energy
        sub.save_water = cb.save_water

        now = datetime.now(UTC)

        # Initialize
        await sub._process_deltas("HELIO_001", 15, 1, 0, now)

        # Second call with a huge time skip (2 hours later)
        later = now + timedelta(hours=2)
        await sub._process_deltas("HELIO_001", 15, 1, 0, later)

        assert len(cb.energy_records) == 1
        wh = cb.energy_records[0]["pompa1_wh"]
        # If elapsed was capped to 1s, wh = 15W * (1/3600) ≈ 0.00417
        # If elapsed was NOT capped (7200s), wh = 15 * (7200/3600) = 30
        assert wh < 0.1, f"Expected capped Wh, got {wh}"

    @pytest.mark.asyncio
    async def test_consecutive_calls_produce_deltas(self):
        """Multiple calls with different readings produce valid records."""
        sub = MQTTSubscriber(EnergyCalculator(), WaterCalculator())
        cb = CallbackStore()
        sub.save_energy = cb.save_energy
        sub.save_water = cb.save_water

        base = datetime.now(UTC)

        # 1st call: init
        await sub._process_deltas("HELIO_001", 15, 1, 0, base)
        assert len(cb.energy_records) == 0

        # 2nd call: 1s later, same distance
        t2 = base + timedelta(seconds=1)
        await sub._process_deltas("HELIO_001", 15, 1, 0, t2)
        assert len(cb.energy_records) == 1
        assert len(cb.water_records) == 1
        assert cb.water_records[0]["jarak_cm"] == 15

        # 3rd call: 1s later, pompa2 turned ON
        t3 = t2 + timedelta(seconds=1)
        await sub._process_deltas("HELIO_001", 15, 1, 1, t3)
        assert len(cb.energy_records) == 2
        energy2 = cb.energy_records[1]
        assert energy2["pompa2_wh"] > 0  # pompa2 now ON


# ===========================================================================
# Edge cases
# ===========================================================================

class TestUplinkEdgeCases:
    """Edge cases for the MQTT subscriber."""

    @pytest.mark.asyncio
    async def test_non_uplink_topic_ignored(self):
        """Messages on non-uplink topics are ignored."""
        sub, cb = make_subscriber()
        await sub._handle_message("helioponic/config/downlink", b"{}")
        assert len(cb.sensor_records) == 0

    @pytest.mark.asyncio
    async def test_zero_values(self):
        """All zero/normal values should parse correctly."""
        sub, cb = make_subscriber()
        payload = json.dumps({
            "device_id": "HELIO_001", "ts": 1760000000,
            "jarak_cm": 999, "tds_value": 0.0, "current_ph": 7.0,
            "pompa1": 0, "pompa2": 0,
        }).encode("utf-8")

        await sub._handle_uplink(payload)
        rec = cb.sensor_records[0]
        assert rec["jarak_cm"] == 999  # out of range
        assert rec["tds_value"] == 0.0
        assert rec["pompa1"] == 0
        assert rec["pompa2"] == 0
