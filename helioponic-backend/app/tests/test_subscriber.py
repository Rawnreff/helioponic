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
        self.water_records = []
        self.broadcast_data = []

    async def save_sensor(self, record: dict):
        self.sensor_records.append(record)

    async def save_water(self, record: dict):
        self.water_records.append(record)

    async def on_sensor_reading(self, data: dict):
        self.broadcast_data.append(data)


def make_subscriber(cb: CallbackStore = None) -> tuple[MQTTSubscriber, CallbackStore]:
    """Create an MQTTSubscriber with mock callbacks."""
    if cb is None:
        cb = CallbackStore()

    sub = MQTTSubscriber(
        water_calc=WaterCalculator(),
        on_sensor_reading=cb.on_sensor_reading,
    )
    sub.save_sensor = cb.save_sensor
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
