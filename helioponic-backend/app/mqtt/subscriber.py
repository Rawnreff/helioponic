"""
Async MQTT subscriber — listens for ESP32 sensor uplink messages.

Parses the raw firmware JSON payload which uses hardware-native field names:
  - jarak_cm, tds_value, current_ph, pompa1, pompa2

Uses gmqtt for asyncio-compatible MQTT client.

Data flow:
  1. Receive JSON payload from helioponic/sensor/uplink
  2. Parse into SensorReading model
  3. Fetch device config from DB (via callback) for threshold automation
  4. Apply threshold automation to compute desired pump states
  5. Persist sensor reading (with automated pump states) to MongoDB sensor_logs
  6. Compute energy and water deltas and persist
  7. Broadcast via WebSocket callback
"""

import json
import logging
from datetime import datetime, UTC
from typing import Optional, Callable, Awaitable

from gmqtt import Client as MQTTClient

from app.core.config import settings
from app.models.sensor import SensorReading, SensorRecord
from app.models.energy import EnergyRecord
from app.models.water import WaterRecord
from app.services.energy import EnergyCalculator
from app.services.water import WaterCalculator
from app.services.automation import evaluate_thresholds

logger = logging.getLogger(__name__)

# MQTT Topics
TOPIC_UPLINK = "helioponic/sensor/uplink"

# Default interval for delta calculations when timing info is unavailable
INTERVAL_SECONDS = 1.0


class MQTTSubscriber:
    """Async MQTT subscriber that persists data and broadcasts via WebSocket."""

    def __init__(
        self,
        energy_calc: EnergyCalculator,
        water_calc: WaterCalculator,
        on_sensor_reading: Optional[Callable[[dict], Awaitable[None]]] = None,
    ):
        self._client: Optional[MQTTClient] = None
        self.energy_calc = energy_calc
        self.water_calc = water_calc
        self.on_sensor_reading = on_sensor_reading

        # State for delta calculations
        self._prev_jarak_cm: int = 999
        self._prev_timestamp: datetime = datetime.now(UTC)
        self._initialized: bool = False

        # Callbacks for database persistence (set by app)
        self.save_sensor: Optional[Callable[[dict], Awaitable[None]]] = None
        self.save_energy: Optional[Callable[[dict], Awaitable[None]]] = None
        self.save_water: Optional[Callable[[dict], Awaitable[None]]] = None
        self.get_device_config: Optional[Callable[[str], Awaitable[Optional[dict]]]] = None

    async def connect(self):
        """Connect to the MQTT broker."""
        self._client = MQTTClient(settings.mqtt_client_id)
        self._client.on_connect = self._on_connect
        self._client.on_message = self._on_message

        host = settings.mqtt_broker
        port = settings.mqtt_port
        username = settings.mqtt_username
        password = settings.mqtt_password

        logger.info(f"Connecting to MQTT broker at {host}:{port}...")
        if username:
            self._client.set_auth_credentials(username, password)
        await self._client.connect(host, port)
        logger.info("MQTT subscriber connected")

    async def disconnect(self):
        """Disconnect from the MQTT broker."""
        if self._client:
            await self._client.disconnect()
            logger.info("MQTT subscriber disconnected")

    def _on_connect(self, client, flags, rc, properties):
        """Callback when connected to broker — subscribe to uplink topic."""
        client.subscribe(TOPIC_UPLINK, qos=settings.mqtt_qos)
        logger.info(f"Subscribed to topic: {TOPIC_UPLINK} (QoS {settings.mqtt_qos})")

    async def _on_message(self, client, topic, payload, qos, properties):
        """Handle incoming MQTT messages."""
        await self._handle_message(topic, payload)

    async def _handle_message(self, topic: str, payload: bytes):
        """Process an incoming MQTT message."""
        if topic == TOPIC_UPLINK:
            await self._handle_uplink(payload)

    async def _get_device_config(self, device_id: str) -> dict:
        """Fetch device configuration from database via callback."""
        if self.get_device_config:
            try:
                config = await self.get_device_config(device_id)
                if config:
                    return config
            except Exception as e:
                logger.warning(f"Failed to fetch device config: {e}")
        return {}

    async def _handle_uplink(self, payload: bytes):
        """Process a sensor uplink message from the ESP32.

        1. Parse JSON payload
        2. Fetch device config for threshold automation
        3. Apply threshold automation
        4. Persist sensor reading with automated pump states
        5. Calculate and persist energy/water deltas
        6. Broadcast via WebSocket
        """
        try:
            data = json.loads(payload)
            reading = SensorReading(**data)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Failed to parse MQTT payload: {e}")
            return

        now = datetime.now(UTC)
        device_id = reading.device_id or "HELIO_001"

        # ----- 1. Fetch device config for threshold automation -----
        config = await self._get_device_config(device_id)

        # ----- 2. Apply threshold automation to get desired pump states -----
        pompa1, pompa2 = evaluate_thresholds(
            reading.jarak_cm,
            reading.tds_value,
            config,
            reading.pompa1,
            reading.pompa2,
        )

        # ----- 3. Build sensor record with automated pump states -----
        sensor_record = SensorRecord(
            device_id=device_id,
            recorded_at=now,
            jarak_cm=reading.jarak_cm,
            tds_value=reading.tds_value,
            current_ph=reading.current_ph,
            pompa1=pompa1,
            pompa2=pompa2,
        )

        # ----- 4. Persist sensor reading -----
        if self.save_sensor:
            await self.save_sensor(sensor_record.model_dump())

        # ----- 5. Calculate and persist energy & water deltas -----
        await self._process_deltas(device_id, reading.jarak_cm, pompa1, pompa2, now)

        # ----- 6. Broadcast via WebSocket callback -----
        if self.on_sensor_reading:
            broadcast_data = {
                "device_id": device_id,
                "ts": reading.ts,
                "jarak_cm": reading.jarak_cm,
                "tds_value": reading.tds_value,
                "current_ph": reading.current_ph,
                "pompa1": pompa1,
                "pompa2": pompa2,
                "recorded_at": now.isoformat(),
            }
            await self.on_sensor_reading(broadcast_data)

    async def _process_deltas(
        self, device_id: str, jarak_cm: int, pompa1: int, pompa2: int, now: datetime
    ):
        """Compute energy deltas using previous state and persist results."""
        if not self._initialized:
            self._prev_jarak_cm = jarak_cm
            self._prev_timestamp = now
            self._initialized = True
            return

        # Sanity-check the interval — cap at 60s to prevent absurd values
        elapsed = (now - self._prev_timestamp).total_seconds()
        if elapsed > 60.0:
            elapsed = INTERVAL_SECONDS
        elif elapsed < 0.5:
            elapsed = INTERVAL_SECONDS

        # ----- Energy -----
        energy_result = self.energy_calc.calculate_total_pump_wh(
            pompa1, pompa2, elapsed
        )
        energy_record = EnergyRecord(
            device_id=device_id,
            recorded_at=now,
            pompa1_wh=energy_result["pompa1_wh"],
            pompa2_wh=energy_result["pompa2_wh"],
            total_wh=energy_result["total_wh"],
        )
        if self.save_energy:
            await self.save_energy(energy_record.model_dump())

        # ----- Water -----
        water_level_pct = self.water_calc.jarak_to_water_level_pct(jarak_cm)
        water_record = WaterRecord(
            device_id=device_id,
            recorded_at=now,
            jarak_cm=jarak_cm,
            water_level_pct=water_level_pct,
        )
        if self.save_water:
            await self.save_water(water_record.model_dump())

        # Update previous state
        self._prev_jarak_cm = jarak_cm
        self._prev_timestamp = now

    async def publish_downlink(self, config_payload: dict):
        """Publish threshold config to ESP32 via MQTT (QoS 1)."""
        if not self._client:
            return
        payload = json.dumps(config_payload)
        self._client.publish("helioponic/config/downlink", payload, qos=1)
        logger.info(f"Published config to helioponic/config/downlink: {payload}")

    async def publish_actuator(self, pump: str, state: int):
        """Publish pump/relay command to ESP32 via MQTT (QoS 1)."""
        if not self._client:
            return
        payload = json.dumps({"pump": pump, "state": state})
        self._client.publish("helioponic/actuator/downlink", payload, qos=1)
        logger.info(f"Published actuator: {payload}")
