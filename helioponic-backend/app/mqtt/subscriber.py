"""
Async MQTT subscriber — listens for ESP32 telemetry on all topics.

Uses paho-mqtt with loop_forever() for reliable Docker connectivity.
The threaded loop handles automatic reconnection with exponential backoff.

Topics subscribed:
  - helioponic/sensor/uplink  (QoS 0) — sensor telemetry every 1s
  - helioponic/alarm/uplink   (QoS 1) — water level alarm events
  - helioponic/status/uplink  (QoS 1) — device heartbeat every 30s

ARCHITECTURE (Unified Single-Source):
  ALL incoming telemetry — whether from physical ESP32 or software simulator —
  is treated as a strict, read-only Source of Truth. The backend persists
  pump states EXACTLY as reported and NEVER computes or overrides them.
  The automation engine (evaluate_thresholds) is used READ-ONLY for
  notification detection, never for mutating persisted data.

Data flow:
  1. Receive JSON payload from MQTT topic
  2. Parse into appropriate model
  3. For sensor uplink: persist reported pump states AS-IS,
     evaluate thresholds for notifications only (read-only)
  4. For alarm uplink: create water_alarm notification, broadcast via WebSocket
  5. For status uplink: update device online status, broadcast via WebSocket
  6. Batch water level writes at 60s intervals (aggregation)
"""

import asyncio
import json
import logging
import threading
from datetime import datetime, UTC
from typing import Optional, Callable, Awaitable

import paho.mqtt.client as mqtt

from app.core.config import settings
from app.models.sensor import SensorReading, SensorRecord
from app.models.water import WaterRecord
from app.services.water import WaterCalculator
from app.services.automation import evaluate_thresholds, get_automation_rules

logger = logging.getLogger(__name__)

# MQTT Topics
TOPIC_UPLINK        = "helioponic/sensor/uplink"
TOPIC_ALARM_UPLINK  = "helioponic/alarm/uplink"
TOPIC_STATUS_UPLINK = "helioponic/status/uplink"

# Default interval for delta calculations when timing info is unavailable
INTERVAL_SECONDS = 1.0

# Water aggregation interval (seconds) — batch writes, not every second
AGGREGATION_INTERVAL_S = 60.0

# ─── Notification Cooldown Constants ──────────────────────────────────
# 30-minute cooldown for ALL notification types to eliminate spamming.
NOTIF_COOLDOWN_SECONDS = 1800.0  # 30 minutes


# 2-Minute ingestion throttle: tracks last DB persist time per device
_mqtt_last_persist: dict[str, datetime] = {}


def _mqtt_should_persist(device_id: str, now: datetime) -> bool:
    """Check if 120 seconds have elapsed since last DB write for this device.
    WebSocket broadcast still happens every reading.
    """
    last = _mqtt_last_persist.get(device_id)
    if last is None or (now - last).total_seconds() >= 120:
        _mqtt_last_persist[device_id] = now
        return True
    return False


class MQTTSubscriber:
    """Async MQTT subscriber that persists data and broadcasts via WebSocket.

    Uses paho-mqtt with loop_forever() for reliable reconnection.
    The threaded MQTT loop automatically reconnects with exponential backoff.
    Incoming messages are dispatched to the asyncio event loop via
    run_coroutine_threadsafe() for non-blocking async processing.

    UNIFIED INGESTION:
      All telemetry is treated as Source of Truth — persisted AS-IS.
      The automation engine is used READ-ONLY for notification detection.
      DB writes are throttled to once every 120 seconds (2-minute interval).
    """

    def __init__(
        self,
        water_calc: WaterCalculator,
        on_sensor_reading: Optional[Callable[[dict], Awaitable[None]]] = None,
    ):
        self.water_calc = water_calc
        self.on_sensor_reading = on_sensor_reading

        # paho-mqtt client
        self._client: Optional[mqtt.Client] = None

        # Reference to the event loop for dispatching async callbacks
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        # State for notification dedup (per-device keyed by device_id)
        self._state: dict[str, dict] = {}  # device_id -> {prev_p1, prev_p2, ...}

        # Per-type notification cooldown tracker: key = f"{device_id}:{notif_type}"
        # Stores the datetime of the last notification of each type for each device.
        # Used for 30-minute dedup on pump state change and threshold warnings.
        self._notif_cooldowns: dict[str, datetime] = {}

        # Callback for database-level notification dedup (belt-and-suspenders check)
        self.check_recent_notification: Optional[Callable[[str, str, str], Awaitable[bool]]] = None

        # State for water level aggregation (per-device, batched every 60s)
        self._agg_state: dict[str, dict] = {}  # device_id -> {water_pct_sum, water_count, last_flush}

        # Callbacks for database persistence (set by app)
        self.save_sensor: Optional[Callable[[dict], Awaitable[None]]] = None
        self.save_water: Optional[Callable[[dict], Awaitable[None]]] = None
        self.save_notification: Optional[Callable[[dict], Awaitable[None]]] = None
        self.get_device_config: Optional[Callable[[str], Awaitable[Optional[dict]]]] = None

        # Callbacks for broadcasting (sensor, alarm, status)
        self.on_alarm: Optional[Callable[[dict], Awaitable[None]]] = None
        self.on_status: Optional[Callable[[dict], Awaitable[None]]] = None

    async def connect(self):
        """Connect to the MQTT broker and start the background network loop.

        Uses paho-mqtt's loop_start() which runs a background thread that
        handles reconnection automatically with exponential backoff.
        """
        host = settings.mqtt_broker
        port = settings.mqtt_port

        logger.info(f"Connecting to MQTT broker at {host}:{port}...")

        # Capture the running event loop for async dispatch
        self._loop = asyncio.get_running_loop()

        # Create paho-mqtt client with MQTT v3.1.1
        # Append a random suffix to client_id to prevent session-collision
        # on rapid reconnect (Mosquitto rejects duplicate client IDs)
        import random, string
        client_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
        client_id = f"{settings.mqtt_client_id}_{client_suffix}"
        self._client = mqtt.Client(
            client_id=client_id,
            protocol=mqtt.MQTTv311,
        )

        # Set authentication if configured
        username = settings.mqtt_username
        password = settings.mqtt_password
        if username:
            self._client.username_pw_set(username, password)

        # Wire callbacks (VERSION1: integer rc values)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message

        # Reconnect delay: start with 5s, max 60s, exponential backoff
        self._client.reconnect_delay_set(min_delay=5, max_delay=60)

        # connect_async() sets the broker connection parameters (host,
        # port, keepalive) used by loop_forever(). It does NOT actually
        # establish the TCP connection — just queues it internally.
        # Then loop_forever(retry_first_connection=True) handles the
        # entire lifecycle (connect, I/O, reconnect) in its daemon thread
        # with zero event loop interference.
        self._client.connect_async(host, port, 60)
        self._thread = threading.Thread(
            target=self._client.loop_forever,
            kwargs={"retry_first_connection": True},
            daemon=True,
        )
        self._thread.start()

        logger.info(f"MQTT subscriber connected to {host}:{port}")

    async def disconnect(self):
        """Disconnect from the MQTT broker and stop the background loop."""
        if self._client:
            self._client.loop_stop()
            try:
                self._client.disconnect()
            except Exception:
                pass
            self._client = None
            logger.info("MQTT subscriber disconnected")

    # ── paho-mqtt callbacks (called from threaded loop) ────────────────────

    def _on_connect(self, client, userdata, flags, rc, properties=None):
        """Callback when connected to broker (called from paho thread).

        Subscribe is called here so it also fires on auto-reconnect.
        The subscribe packet is queued on the background thread's
        outbound queue and sent when the thread processes it.
        """
        if rc == 0:
            logger.info("MQTT subscriber connected (rc=0)")
            client.subscribe(TOPIC_UPLINK, qos=0)
            client.subscribe(TOPIC_ALARM_UPLINK, qos=1)
            client.subscribe(TOPIC_STATUS_UPLINK, qos=1)
            logger.info(f"Subscribed to: {TOPIC_UPLINK} (QoS 0), {TOPIC_ALARM_UPLINK} (QoS 1), {TOPIC_STATUS_UPLINK} (QoS 1)")
        elif rc == 5:
            logger.warning("MQTT connection refused: not authorized (rc=5)")
        else:
            logger.warning(f"MQTT connection failed (rc={rc}) — will auto-reconnect")

    def _on_disconnect(self, client, userdata, *args):
        """Callback when disconnected from broker (called from paho thread).

        paho-mqtt 2.x VERSION2 callback signature:
            on_disconnect(client, userdata, flags, reason_code, properties)
        args[0] = DisconnectFlags enum, args[1] = reason_code
        VERSION1 (legacy): args[0] = rc, no args[1]
        The reconnect_delay_set() handles auto-reconnection with backoff.
        """
        # Extract reason_code correctly for both VERSION1 and VERSION2
        if len(args) >= 2:
            reason_code = args[1]  # VERSION2: reason_code is second positional
        else:
            reason_code = args[0] if args else -1  # VERSION1: rc is first
        if reason_code != 0:
            logger.warning(f"MQTT disconnected unexpectedly (rc={reason_code}) — auto-reconnecting")

    def _on_message(self, client, userdata, msg):
        """Callback when an MQTT message arrives (called from paho thread).

        Dispatches to the async handler via run_coroutine_threadsafe()
        to ensure async operations run on the main event loop.
        """
        if self._loop is None:
            return

        try:
            # Dispatch to async handler on the event loop
            asyncio.run_coroutine_threadsafe(
                self._handle_message(msg.topic, msg.payload),
                self._loop,
            )
        except Exception as e:
            logger.error(f"Failed to dispatch MQTT message: {e}")

    # ── Async message handling ────────────────────────────────────────────

    async def _handle_message(self, topic: str, payload: bytes):
        """Route incoming MQTT message to the appropriate handler."""
        if topic == TOPIC_UPLINK:
            await self._handle_uplink(payload)
        elif topic == TOPIC_ALARM_UPLINK:
            await self._handle_alarm(payload)
        elif topic == TOPIC_STATUS_UPLINK:
            await self._handle_status(payload)

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

    async def _is_night_mode_active(self, device_id: str) -> bool:
        """Check if night mode is currently active for a device."""
        if self.get_device_config:
            try:
                from app.core.database import get_database
                db = await get_database()
                snap = await db.night_mode_snapshots.find_one({"device_id": device_id})
                return bool(snap and snap.get("active"))
            except Exception:
                pass
        return False

    async def _handle_uplink(self, payload: bytes):
        """Process a sensor uplink message from the ESP32.

        UNIFIED INGESTION:
          ALL telemetry (ESP32 or simulator) is treated as Source of Truth.
          Pump states are persisted EXACTLY as reported — the backend NEVER
          computes or overrides them.

        1. Parse JSON payload
        2. Persist the reported pump states AS-IS to sensor_logs
        3. Check thresholds for notification purposes only (read-only)
        4. Aggregate water level deltas (batched every 60s)
        5. Broadcast via WebSocket
        """
        try:
            data = json.loads(payload)
            reading = SensorReading(**data)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Failed to parse MQTT payload: {e}")
            return

        now = datetime.now(UTC)
        device_id = reading.device_id or "HELIO_001"

        # ----- 1. Fetch device config for threshold evaluation (READ-ONLY) -----
        config = await self._get_device_config(device_id)
        auto_rules = get_automation_rules(config) if config else {}
        auto_enabled = auto_rules.get("auto_enabled", True)
        is_night = await self._is_night_mode_active(device_id)

        # ----- 2. Persist reported pump states AS-IS (UNIFIED SOURCE OF TRUTH) -----
        # 2-minute throttling: DB writes limited to 120s intervals
        persist = _mqtt_should_persist(device_id, now)

        if persist:
            sensor_record = SensorRecord(
                device_id=device_id,
                recorded_at=now,
                jarak_cm=reading.jarak_cm,
                tds_value=reading.tds_value,
                current_ph=reading.current_ph,
                pompa1=reading.pompa1,
                pompa2=reading.pompa2,
                pompa3=reading.pompa3,
                pompa4=reading.pompa4,
            )
            if self.save_sensor:
                await self.save_sensor(sensor_record.model_dump())

            logger.debug(
                f"MQTT: device={device_id} jarak={reading.jarak_cm} tds={reading.tds_value} "
                f"→ p1={reading.pompa1} p2={reading.pompa2} p3={reading.pompa3} p4={reading.pompa4} (persisted AS-IS)"
            )
        else:
            logger.debug(
                f"MQTT: device={device_id} — throttled (last write < 120s ago), WS broadcast only"
            )

        # ----- 3. Check thresholds for NOTIFICATIONS ONLY (read-only) -----
        # Pump state change notifications: only when auto mode is ENABLED
        # (no spam in manual mode — user is in control)
        # Threshold warnings: ALWAYS fire when conditions are critical,
        # regardless of auto mode, so safety notifications still arrive.
        if not is_night and config:
            desired_p1, desired_p2, desired_p3, desired_p4 = evaluate_thresholds(
                reading.jarak_cm,
                reading.tds_value,
                config,
                reading.pompa1,
                reading.pompa2,
                reading.pompa3,
                reading.pompa4,
                current_ph=reading.current_ph,
            )

            # Threshold warnings fire regardless of auto_enabled (safety)
            await self._create_threshold_warnings(
                device_id, reading.jarak_cm, reading.tds_value, config, now,
                current_ph=reading.current_ph,
            )

            # Pump state change notifications only when auto is active
            if auto_enabled:
                await self._create_auto_notification(
                    device_id, reading.pompa1, reading.pompa2, reading.pompa3, reading.pompa4,
                    desired_p1, desired_p2, desired_p3, desired_p4, now
                )

        # ----- 4. Aggregate water level deltas (batched every 60s) -----
        await self._process_deltas_aggregated(
            device_id, reading.jarak_cm, now
        )

        # ----- 5. Broadcast via WebSocket -----
        if self.on_sensor_reading:
            broadcast_data = {
                "type": "sensor_update",
                "device_id": device_id,
                "ts": reading.ts,
                "jarak_cm": reading.jarak_cm,
                "tds_value": reading.tds_value,
                "current_ph": reading.current_ph,
                "pompa1": reading.pompa1,
                "pompa2": reading.pompa2,
                "pompa3": reading.pompa3,
                "pompa4": reading.pompa4,
                "water_level_pct": self.water_calc.jarak_to_water_level_pct(reading.jarak_cm),
                "night_mode": is_night,
                "auto_enabled": auto_enabled,
                "recorded_at": now.isoformat(),
            }
            await self.on_sensor_reading(broadcast_data)

    # ── Notification helpers ──────────────────────────────────────────────

    def _notif_cooldown_key(self, device_id: str, notif_type: str) -> str:
        """Generate a stable cache key for notification cooldown tracking."""
        return f"{device_id}:{notif_type}"

    def _is_notif_on_cooldown(self, device_id: str, notif_type: str, now: datetime) -> bool:
        """Check if a notification type is in 30-minute cooldown for this device.

        Uses in-memory cache (self._notif_cooldowns) for O(1) lookup.
        This is the PRIMARY dedup layer — fast, no DB hit.
        """
        key = self._notif_cooldown_key(device_id, notif_type)
        last = self._notif_cooldowns.get(key)
        if last is None:
            return False
        elapsed = (now - last).total_seconds()
        return elapsed < NOTIF_COOLDOWN_SECONDS

    def _mark_notif_sent(self, device_id: str, notif_type: str, now: datetime):
        """Record that a notification was sent (updates cooldown timer)."""
        key = self._notif_cooldown_key(device_id, notif_type)
        self._notif_cooldowns[key] = now

    def _get_state(self, device_id: str) -> dict:
        if device_id not in self._state:
            self._state[device_id] = {
                "prev_p1": -1,
                "prev_p2": -1,
                "prev_p3": -1,
                "prev_p4": -1,
            }
        return self._state[device_id]

    def reset_state(self, device_id: str):
        """Reset automation hysteresis & notification state for a device.

        Called when device thresholds are updated so the notification engine
        re-evaluates with fresh state instead of continuing from previous
        hysteresis values.
        Also clears the per-type notification cooldown cache so new
        notifications can be generated after a threshold change.
        """
        if device_id in self._state:
            del self._state[device_id]
        # Clear all cooldown keys for this device
        keys_to_delete = [k for k in self._notif_cooldowns if k.startswith(f"{device_id}:")]
        for k in keys_to_delete:
            del self._notif_cooldowns[k]
        if device_id in self._state or keys_to_delete:
            logger.info(f"Reset automation & notification state for device {device_id}")

    async def _create_auto_notification(
        self, device_id: str, actual_p1: int, actual_p2: int,
        actual_p3: int, actual_p4: int,
        desired_p1: int, desired_p2: int, desired_p3: int, desired_p4: int,
        now: datetime
    ):
        """Create auto_mode notifications when pump states change.

        Each pump has its own notification type with dedicated 30-minute cooldown:
          - Pompa 1 → type='pump1_state' (Water Circulation/Refill)
          - Pompa 2 → type='pump2_state' (pH DOWN Dosing)
          - Pompa 3+4 → type='nutrients_dosing' (Nutrient A+B, tandem)

        Messages include the triggering sensor values for full context.
        Priority is 'medium' for standard auto-mode activations.
        """
        if not self.save_notification:
            return

        state = self._get_state(device_id)

        # Detect pump state transitions (first reading initializes prev state)
        p1_changed = state["prev_p1"] != -1 and state["prev_p1"] != actual_p1
        p2_changed = state["prev_p2"] != -1 and state["prev_p2"] != actual_p2
        p3_changed = state["prev_p3"] != -1 and state["prev_p3"] != actual_p3
        p4_changed = state["prev_p4"] != -1 and state["prev_p4"] != actual_p4

        # Update state
        state["prev_p1"] = actual_p1
        state["prev_p2"] = actual_p2
        state["prev_p3"] = actual_p3
        state["prev_p4"] = actual_p4

        # Early exit: no pump changed state
        if not p1_changed and not p2_changed and not p3_changed and not p4_changed:
            return

        # ── Build notifications per pump, respecting 30-minute cooldown ──
        notifications_to_create: list[dict] = []

        # Pompa 1 — Water Circulation/Refill
        if p1_changed:
            notif_type = "pump1_state"
            p1_label = "ON" if actual_p1 else "OFF"
            # Fetch current jarak from sensor reading context
            # (the caller has access to reading — we'll reconstruct from params)

            if not self._is_notif_on_cooldown(device_id, notif_type, now):
                self._mark_notif_sent(device_id, notif_type, now)
                notifications_to_create.append({
                    "device_id": device_id,
                    "type": notif_type,
                    "title": f"Pompa 1 (Sirkulasi/Refill) → {p1_label}",
                    "message": (
                        f"Pompa 1 turned {p1_label} based on water distance "
                        f"(threshold expects {'ON' if desired_p1 else 'OFF'})"
                        if actual_p1 != desired_p1 else
                        f"Pompa 1 turned {p1_label}"
                    ),
                    "priority": "medium",
                    "read": False,
                    "created_at": now,
                })

        # Pompa 2 — pH DOWN Dosing
        if p2_changed:
            notif_type = "pump2_state"
            p2_label = "ON" if actual_p2 else "OFF"

            if not self._is_notif_on_cooldown(device_id, notif_type, now):
                self._mark_notif_sent(device_id, notif_type, now)
                notifications_to_create.append({
                    "device_id": device_id,
                    "type": notif_type,
                    "title": f"Pompa 2 (pH DOWN Dosing) → {p2_label}",
                    "message": (
                        f"Pompa 2 turned {p2_label} — pH exceeds threshold, dosing pH DOWN "
                        f"(threshold expects {'ON' if desired_p2 else 'OFF'})"
                        if actual_p2 != desired_p2 else
                        f"Pompa 2 turned {p2_label}"
                    ),
                    "priority": "medium",
                    "read": False,
                    "created_at": now,
                })

        # Pompa 3 & 4 — Tandem Nutrient A+B Dosing
        if p3_changed or p4_changed:
            notif_type = "nutrients_dosing"
            ab_label = "ON" if (actual_p3 or actual_p4) else "OFF"

            if not self._is_notif_on_cooldown(device_id, notif_type, now):
                self._mark_notif_sent(device_id, notif_type, now)
                notifications_to_create.append({
                    "device_id": device_id,
                    "type": notif_type,
                    "title": f"Nutrient Dosing (A+B) → {ab_label}",
                    "message": (
                        f"Pompa 3 (Nutrisi A) and Pompa 4 (Nutrisi B) turned {ab_label} "
                        f"- TDS level triggered dosing "
                        f"(threshold expects {'ON' if desired_p3 else 'OFF'})"
                        if (actual_p3 != desired_p3 or actual_p4 != desired_p4) else
                        f"Pompa 3 and Pompa 4 turned {ab_label}"
                    ),
                    "priority": "medium",
                    "read": False,
                    "created_at": now,
                })

        # Persist all deduped notifications
        for notif in notifications_to_create:
            await self.save_notification(notif)

    async def _create_threshold_warnings(
        self, device_id: str, jarak_cm: float, tds_value: float,
        config: dict, now: datetime,
        current_ph: float | None = None,
    ):
        """Create warning notifications when sensor values approach critical levels.

        Uses the per-type in-memory cooldown cache with 30-minute dedup for
        standard warnings. Critical alarms (water sensor failure) use a
        shorter 5-minute cooldown since they represent active emergencies.

        Threshold warnings fire regardless of auto_enabled (safety).

        Notification types:
          - 'water_level_warning' — water approaching critical (jarak near threshold)
          - 'water_alarm'         — water sensor out of range (jarak=999) [priority: high]
          - 'ph_warning'          — pH exceeds safe maximum
          - 'tds_warning'         — TDS below minimum threshold
        """
        if not self.save_notification:
            return

        jarak_on = config.get("jarak_on", 5.0)
        tds_on = config.get("tds_on", 95.0)

        # ── Water level approaching critical (within 10% of trigger) ──
        notif_type = "water_level_warning"
        if (jarak_cm != 999 and jarak_cm > 0 and jarak_cm > jarak_on * 0.9
                and not self._is_notif_on_cooldown(device_id, notif_type, now)):
            self._mark_notif_sent(device_id, notif_type, now)
            await self.save_notification({
                "device_id": device_id,
                "type": notif_type,
                "title": "Water Level Approaching Critical",
                "message": f"Water distance: {jarak_cm}cm (trigger: {jarak_on}cm) — Pompa 1 (Refill) may activate",
                "priority": "medium",
                "read": False,
                "created_at": now,
            })

        # ── Water sensor out of range (jarak_cm == 999 — sensor failure) ──
        notif_type = "water_alarm"
        if jarak_cm == 999 and not self._is_notif_on_cooldown(device_id, notif_type, now):
            self._mark_notif_sent(device_id, notif_type, now)
            await self.save_notification({
                "device_id": device_id,
                "type": notif_type,
                "title": "⚠️ Water Level Sensor Out of Range",
                "message": "Ultrasonic sensor reading 999cm — check water level and sensor connection immediately",
                "priority": "high",
                "read": False,
                "created_at": now,
            })

        # ── pH warning (pH > ph_max — pH DOWN needed) ──
        ph_max = config.get("ph_max", 6.5)
        notif_type = "ph_warning"
        if (current_ph is not None and current_ph > 0 and current_ph > ph_max
                and not self._is_notif_on_cooldown(device_id, notif_type, now)):
            self._mark_notif_sent(device_id, notif_type, now)
            await self.save_notification({
                "device_id": device_id,
                "type": notif_type,
                "title": "pH Too High — Dosing Needed",
                "message": f"pH {current_ph:.1f} exceeds threshold {ph_max:.1f} — Pompa 2 (pH DOWN) activated",
                "priority": "medium",
                "read": False,
                "created_at": now,
            })

        # ── TDS warning (tds < tds_on — Nutrients A+B needed) ──
        notif_type = "tds_warning"
        if (tds_value > 0 and tds_value < tds_on
                and not self._is_notif_on_cooldown(device_id, notif_type, now)):
            self._mark_notif_sent(device_id, notif_type, now)
            await self.save_notification({
                "device_id": device_id,
                "type": notif_type,
                "title": "TDS Low — Nutrients Needed",
                "message": f"TDS {tds_value:.0f}ppm below threshold {tds_on:.0f}ppm — Pompa 3+4 (Nutrisi A+B) activated",
                "priority": "medium",
                "read": False,
                "created_at": now,
            })

    # ── Alarm handler ──────────────────────────────────────────────────────

    async def _handle_alarm(self, payload: bytes):
        """Process a water level alarm from the ESP32."""
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            logger.error("Failed to parse alarm payload")
            return

        device_id = data.get("device_id", "HELIO_001")
        alarm_type = data.get("alarm_type", "water_level")
        message = data.get("message", "Water level alarm triggered")
        ts = data.get("ts", 0)
        now = datetime.now(UTC)

        logger.warning(f"ALARM: device={device_id}, type={alarm_type}")

        # Persist alarm notification
        if self.save_notification:
            await self.save_notification({
                "device_id": device_id,
                "type": "water_alarm",
                "title": "Water Level Alarm",
                "message": message,
                "priority": "high",
                "read": False,
                "created_at": now,
            })

        # Broadcast via WebSocket
        if self.on_alarm:
            await self.on_alarm({
                "type": "alarm",
                "device_id": device_id,
                "alarm_type": alarm_type,
                "message": message,
                "ts": ts,
            })

    # ── Status handler ─────────────────────────────────────────────────────

    async def _handle_status(self, payload: bytes):
        """Process a device status heartbeat from the ESP32.

        The ESP32 publishes to helioponic/status/uplink every 30 seconds.
        Updates device online status in DB and broadcasts via WebSocket.
        """
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            logger.error("Failed to parse status payload")
            return

        device_id = data.get("device_id", "HELIO_001")
        status = data.get("status", "online")
        ts = data.get("ts", 0)
        version = data.get("version", "unknown")
        night_mode = bool(data.get("night_mode", 0))
        wifi_rssi = data.get("wifi_rssi", 0)

        # Update device is_online in database
        try:
            from app.core.database import get_database
            db = await get_database()
            await db.devices.update_one(
                {"device_id": device_id},
                {"$set": {
                    "is_online": (status == "online"),
                    "last_seen": datetime.now(UTC),
                    "firmware_version": version,
                    "wifi_rssi": wifi_rssi,
                }},
            )
        except Exception as e:
            logger.warning(f"Failed to update device status in DB: {e}")

        # Broadcast via WebSocket
        if self.on_status:
            await self.on_status({
                "type": "status_update",
                "device_id": device_id,
                "status": status,
                "night_mode": night_mode,
                "wifi_rssi": wifi_rssi,
                "version": version,
                "ts": ts,
            })

    # ── Water level aggregation (batched every 60s) ───────────────────────

    def _get_agg_state(self, device_id: str) -> dict:
        if device_id not in self._agg_state:
            self._agg_state[device_id] = {
                "water_pct_sum": 0.0, "water_count": 0,
                "last_jarak": 0, "last_flush": datetime.now(UTC),
            }
        return self._agg_state[device_id]

    async def _process_deltas_aggregated(
        self, device_id: str, jarak_cm: float, now: datetime
    ):
        """Aggregate water level deltas and flush to DB every 60 seconds.

        Instead of writing every 1 second (86,400+ docs/day), we accumulate
        in memory and flush one aggregated record every AGGREGATION_INTERVAL_S.
        This reduces MongoDB writes by 60x.
        """
        agg = self._get_agg_state(device_id)

        # Accumulate water level for averaging
        if jarak_cm != 999 and jarak_cm > 0:
            pct = self.water_calc.jarak_to_water_level_pct(jarak_cm)
            agg["water_pct_sum"] += pct
            agg["water_count"] += 1
            agg["last_jarak"] = jarak_cm

        # Flush every AGGREGATION_INTERVAL_S
        elapsed = (now - agg["last_flush"]).total_seconds()
        if elapsed >= AGGREGATION_INTERVAL_S:
            if self.save_water and agg["water_count"] > 0:
                avg_pct = agg["water_pct_sum"] / agg["water_count"]
                await self.save_water(WaterRecord(
                    device_id=device_id, recorded_at=now,
                    jarak_cm=agg["last_jarak"],
                    water_level_pct=round(avg_pct, 2),
                ).model_dump())

            # Reset accumulators
            agg["water_pct_sum"] = 0.0
            agg["water_count"] = 0
            agg["last_flush"] = now

    # ── MQTT publish methods (thread-safe) ────────────────────────────────

    async def publish_downlink(self, config_payload: dict):
        """Publish threshold config to ESP32 via MQTT (QoS 1)."""
        if not self._client:
            return
        payload = json.dumps(config_payload)
        info = self._client.publish(
            "helioponic/config/downlink",
            payload=payload,
            qos=1,
        )
        logger.info(f"Published config to helioponic/config/downlink: {payload} (rc={info.rc})")

    async def publish_night_mode(self, night_mode_payload: dict):
        """Publish night mode command to ESP32 via MQTT (QoS 1)."""
        if not self._client:
            return
        payload = json.dumps(night_mode_payload)
        info = self._client.publish(
            "helioponic/night_mode/downlink",
            payload=payload,
            qos=1,
        )
        logger.info(f"Published night mode to helioponic/night_mode/downlink: {payload} (rc={info.rc})")

    async def publish_actuator(self, pump: str, state: int):
        """Publish pump/relay command to ESP32 via MQTT (QoS 1)."""
        if not self._client:
            return
        payload = json.dumps({"pump": pump, "state": state})
        info = self._client.publish(
            "helioponic/actuator/downlink",
            payload=payload,
            qos=1,
        )
        logger.info(f"Published actuator: {payload} (rc={info.rc})")
