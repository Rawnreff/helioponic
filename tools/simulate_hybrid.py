#!/usr/bin/env python3
"""
Helioponic — Hybrid Simulator v2.1 (Python)
=============================================
Reactive physics-based hybrid emulator matching ESP32 firmware behavior.

Architecture (Hybrid Feedback Loop):
  PhysicsEngine + Local Hysteresis ──► sensor-only inject ──► ESP32 ──► pump control ──► uplink
                                        │                                    │
                                   display +                              Backend
                                   REST fallback

Features ported from simulate.py v5.0:
  • Physics engine — sensor values react to LOCAL pump states (realistic)
  • Local HysteresisController — identical bang-bang logic as simulate.py
  • 200ms sensor loop + 1000ms publish cycle
  • JWT authentication for all API calls
  • Periodic threshold & auto_rules polling (every ~6s)
  • Auto Mode detection (respects auto_enabled from backend)
  • Threshold propagation to ESP32 via MQTT config/downlink
  • Manual override monitoring (ESP32 handles actuator commands)
  • Water level alarm (rising edge on jarak_cm==999)
  • Status heartbeat every 30s to helioponic/status/uplink
  • REST fallback for sensor readings (with local pump states)
  • Scenario presets for initial physics state

Key differences from simulate.py:
  • Publishes sensor-only data to inject topic (ESP32 does bang-bang independently)
  • ESP32 uplink pump states shown as comparison (gray text if different)
  • Physical pumps controlled by ESP32, not Python
  • Thresholds synced from backend → ESP32 via config/downlink

Usage:
  python tools/simulate_hybrid.py                                    # Start simulation
  python tools/simulate_hybrid.py --device HELIO_CUSTOM              # Custom device ID
  python tools/simulate_hybrid.py --api http://192.168.100.16:8000/api/v1  # Custom API
  python tools/simulate_hybrid.py --register                         # Register test user first
  python tools/simulate_hybrid.py --scenario water-low               # Start with low water
  python tools/simulate_hybrid.py --scenario cycle                   # Cycle through states
  python tools/simulate_hybrid.py --count 50                         # 50 publishes then exit
  python tools/simulate_hybrid.py --thresholds ph_min=5.0 ph_max=7.0 # Custom thresholds

Requires:
  pip install paho-mqtt httpx
  Docker containers running (docker compose up -d)
  ESP32 with hybrid firmware uploaded
"""

import argparse
import asyncio
import json
import logging
import os
import random
import signal
import sys
import time
from datetime import datetime
from typing import Optional

try:
    import httpx
except ImportError:
    print("Missing httpx. Install: pip install httpx")
    sys.exit(1)

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("Missing paho-mqtt. Install: pip install paho-mqtt")
    sys.exit(1)

__version__ = "2.1.0"

# ─── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("hybrid-sim")

# ─── Constants ──────────────────────────────────────────────────────────────
MQTT_BROKER_DEFAULT = "localhost"
MQTT_PORT_DEFAULT = 1883

# Topics — publish
TOPIC_INJECT   = "helioponic/sensor/inject"        # simulate → ESP32 (sensor-only)
TOPIC_STATUS   = "helioponic/status/uplink"         # heartbeat → Backend
TOPIC_ALARM    = "helioponic/alarm/uplink"          # alarm → Backend
TOPIC_CONFIG   = "helioponic/config/downlink"       # thresholds → ESP32

# Topics — subscribe (monitoring)
TOPIC_UPLINK   = "helioponic/sensor/uplink"         # ESP32 → Backend (pump feedback)
TOPIC_DOWNLINK = "helioponic/actuator/downlink"     # Backend → ESP32 (manual override)

TEST_USER_EMAIL = "sim@helioponic.io"
TEST_USER_PASSWORD = "sim123"
DEVICE_ID_DEFAULT = "HELIO_SIM_001"

FW_VERSION = "3.3.0"

# Tank geometry (matches backend WaterCalculator)
TANK_DEPTH_CM = 7.0

# Physics rates per second (matches simulate.py)
JARAK_REFILL_RATE = 0.08   # cm/s — water level rises when pompa1=ON
JARAK_EVAP_RATE = 0.02     # cm/s — water level drops when pompa1=OFF
PH_DOWN_RATE = 0.015        # pH/s — pH drops when pompa2=ON
PH_DRIFT_UP_RATE = 0.002    # pH/s — pH rises when pompa2=OFF
TDS_DOSE_RATE = 1.5         # ppm/s — TDS rises when both P3+P4=ON
TDS_DECAY_RATE = 0.3        # ppm/s — TDS decays slowly when pumps OFF

# Timing constants
SENSOR_INTERVAL = 0.2       # 200ms sensor cycle
PUBLISH_INTERVAL = 1.0      # 1000ms = 5 sensor cycles
HEARTBEAT_INTERVAL = 30     # 30 seconds = 150 sensor cycles
POLL_INTERVAL = 6           # 6 seconds = 30 sensor cycles
OVERRIDE_TIMEOUT = 1800     # 30 minutes auto-clear (matches simulate.py)

# Pump names for override tracking
ALL_PUMPS = ["pompa1", "pompa2", "pompa3", "pompa4"]

# Pump alias mapping for actuator commands
PUMP_ALIAS_MAP = {
    "pompa1": "pompa1", "circ": "pompa1",
    "pompa2": "pompa2", "ph_d": "pompa2",
    "pompa3": "pompa3", "nut_a": "pompa3",
    "pompa4": "pompa4", "nut_b": "pompa4",
}

# Scenario presets — initial physics state only; physics takes over after
SCENARIO_PRESETS = {
    "normal": {
        "desc": "Kondisi ideal — physics akan menggerakkan nilai secara natural",
        "jarak_cm": 3.5,
        "tds_value": 400.0,
        "current_ph": 6.0,
    },
    "water-low": {
        "desc": "Air surut — pompa1 ON → physics refill air",
        "jarak_cm": 6.5,
        "tds_value": 400.0,
        "current_ph": 6.0,
    },
    "water-full": {
        "desc": "Air penuh — pompa1 OFF → physics evaporasi",
        "jarak_cm": 1.2,
        "tds_value": 400.0,
        "current_ph": 6.0,
    },
    "ph-high": {
        "desc": "pH tinggi — pompa2 ON → physics turunkan pH",
        "jarak_cm": 3.5,
        "tds_value": 400.0,
        "current_ph": 7.5,
    },
    "ph-low": {
        "desc": "pH rendah — pompa2 OFF → physics naikkan pH",
        "jarak_cm": 3.5,
        "tds_value": 400.0,
        "current_ph": 4.8,
    },
    "tds-low": {
        "desc": "Nutrisi habis — pompa3+4 ON → physics tambah nutrisi",
        "jarak_cm": 3.5,
        "tds_value": 70.0,
        "current_ph": 6.0,
    },
    "tds-high": {
        "desc": "Nutrisi jenuh — pompa3+4 OFF → physics decay",
        "jarak_cm": 3.5,
        "tds_value": 550.0,
        "current_ph": 6.0,
    },
    "out-of-range": {
        "desc": "Sensor ultrasonic error (jarak=999) → alarm",
        "jarak_cm": 999.0,
        "tds_value": 400.0,
        "current_ph": 6.0,
    },
    "cycle": {
        "desc": "Mulai dari normal, biarkan physics+ESP32 automasi berjalan",
        "jarak_cm": 3.5,
        "tds_value": 400.0,
        "current_ph": 6.5,
    },
}


# ============================================================================
# Hysteresis Controller — matches simulate.py exactly
# ============================================================================

class HysteresisController:
    """4-pump bang-bang hysteresis — matches backend evaluate_thresholds().

    Pompa 1 (Water Refill):    jarak_cm > jarak_on → ON, jarak_cm < jarak_off → OFF
    Pompa 2 (pH DOWN):          pH > ph_max → ON, pH < ph_min → OFF
    Pompa 3 & 4 (Nutrient A+B): TANDEM — tds < tds_on → both ON, tds > tds_off → both OFF

    Runs locally in simulate_hybrid.py for physics + display.
    ESP32 independently runs its own hysteresis with same thresholds.
    """

    def __init__(self, config: dict):
        self.jarak_on = config.get("jarak_on", 5.0)
        self.jarak_off = config.get("jarak_off", 2.0)
        self.tds_on = config.get("tds_on", 95.0)
        self.tds_off = config.get("tds_off", 105.0)
        self.ph_min = config.get("ph_min", 5.5)
        self.ph_max = config.get("ph_max", 6.5)

    def evaluate(self, jarak_cm: float, tds_value: float, current_ph: float,
                 pompa1_state: int, pompa2_state: int,
                 pompa3_state: int = 0, pompa4_state: int = 0) -> tuple[int, int, int, int]:
        """Evaluate thresholds and return desired pump states (bang-bang hysteresis)."""
        ultrasonik_valid = (jarak_cm != 999 and jarak_cm > 0)
        ph_valid = current_ph > 0

        # Pompa 1 — Water Level
        p1 = pompa1_state
        if ultrasonik_valid:
            if jarak_cm > self.jarak_on:
                p1 = 1
            elif jarak_cm < self.jarak_off:
                p1 = 0

        # Pompa 2 — pH DOWN
        p2 = pompa2_state
        if ph_valid:
            if current_ph > self.ph_max:
                p2 = 1
            elif current_ph < self.ph_min:
                p2 = 0

        # Pompa 3 & Pompa 4 — TANDEM TDS Nutrient Dosing
        p3 = pompa3_state
        p4 = pompa4_state
        if tds_value < self.tds_on:
            p3 = 1
            p4 = 1
        elif tds_value > self.tds_off:
            p3 = 0
            p4 = 0
        # else: deadband → no change (hysteresis)

        return p1, p2, p3, p4


# ============================================================================
# Physics Engine — simulates environment changes based on pump states
# ============================================================================

class PhysicsEngine:
    """Simulates environmental changes based on ESP32 pump states.

    Each tick (dt seconds):
      - pompa1=ON:  jarak_cm decreases (water rises) by JARAK_REFILL_RATE * dt
      - pompa1=OFF: jarak_cm increases (evaporation) by JARAK_EVAP_RATE * dt
      - pompa2=ON:  current_ph decreases (pH DOWN dosing) by PH_DOWN_RATE * dt
      - pompa2=OFF: current_ph rises by PH_DRIFT_UP_RATE * dt
      - pompa3=ON AND pompa4=ON: tds_value increases (nutrients added)
      - Otherwise: tds_value slowly decays (consumption)
    """

    def __init__(self, initial: dict | None = None, tank_depth_cm: float = 32.0):
        init = initial or {}
        self.jarak_cm = init.get("jarak_cm", 3.5)
        self.tds_value = init.get("tds_value", 400.0)
        self.current_ph = init.get("current_ph", 6.8)
        self.tank_depth_cm = tank_depth_cm

    def reset_to(self, preset: dict):
        """Reset physics to a scenario preset."""
        self.jarak_cm = preset.get("jarak_cm", 3.5)
        self.tds_value = preset.get("tds_value", 400.0)
        self.current_ph = preset.get("current_ph", 6.8)

    def tick(self, pompa1: int, pompa2: int, pompa3: int, pompa4: int, dt: float = 1.0):
        """Advance physics simulation by dt seconds based on pump states."""

        # ── Water Level (jarak_cm) ──
        if pompa1 == 1:
            self.jarak_cm -= JARAK_REFILL_RATE * dt
        else:
            self.jarak_cm += JARAK_EVAP_RATE * dt
        self.jarak_cm = max(0.5, min(self.tank_depth_cm - 0.3, self.jarak_cm))

        # ── pH Level ──
        if pompa2 == 1:
            self.current_ph -= PH_DOWN_RATE * dt
        else:
            self.current_ph += PH_DRIFT_UP_RATE * dt
        self.current_ph = max(4.0, min(8.5, self.current_ph))

        # ── TDS (Nutrient) ──
        if pompa3 == 1 and pompa4 == 1:
            self.tds_value += TDS_DOSE_RATE * dt
        else:
            noise = (random.random() - 0.5) * 0.5 * dt
            self.tds_value -= TDS_DECAY_RATE * dt + noise
        self.tds_value = max(50, min(800, self.tds_value))

    def get_readings(self) -> dict:
        """Return current sensor readings (rounded to realistic precision)."""
        return {
            "jarak_cm": round(self.jarak_cm, 1),
            "tds_value": round(self.tds_value, 0),
            "current_ph": round(self.current_ph, 1),
        }


# ============================================================================
# Hybrid Simulator v2.0
# ============================================================================

class HybridSimulatorV2:
    """Reactive physics-based hybrid simulator with local hysteresis + ESP32 pump authority.

    Runs a 200ms sensor loop:
      1. Read physics engine sensor values
      2. Evaluate local HysteresisController (bang-bang, same as simulate.py)
      3. Apply manual overrides (monitored from MQTT actuator/downlink)
      4. Log state changes
      5. Tick physics engine using LOCAL pump states
      6. Check water alarm
      7. Publish to inject topic every 5th cycle (1000ms) — sensor only
      8. Status heartbeat every 150th cycle (30s)
      9. Periodic config + auto_rules fetch (every 30 cycles = 6s)
     10. Propagate new thresholds to ESP32

    Local hysteresis decides pump states for physics + display (matches simulate.py).
    ESP32 independently runs its own hysteresis with same thresholds
    for physical pump control. ESP32 uplink states shown as comparison.
    """

    def __init__(self, device_id: str, api_base: str,
                 scenario: str = "normal",
                 thresholds: dict | None = None,
                 register_first: bool = False,
                 broker: str = MQTT_BROKER_DEFAULT,
                 port: int = MQTT_PORT_DEFAULT,
                 mqtt_user: Optional[str] = None,
                 mqtt_pass: Optional[str] = None):
        self.device_id = device_id
        self.api_base = api_base
        self.scenario_name = scenario
        self.broker = broker
        self.port = port
        self.mqtt_user = mqtt_user or os.environ.get("MQTT_USER", "helioponic")
        self.mqtt_pass = mqtt_pass or os.environ.get("MQTT_PASS", "helioponic_mqtt_2024")
        self.running = True
        self.max_publishes = 0
        self.publish_count = 0

        # ── ESP32 pump state feedback (updated via uplink) ──
        self._esp32_p1 = 0
        self._esp32_p2 = 0
        self._esp32_p3 = 0
        self._esp32_p4 = 0
        self._last_uplink_ts = 0.0
        self._last_uplink_readings: dict = {}

        # ── Local pump states (decided by local hysteresis — matches simulate.py) ──
        self._local_p1 = 0
        self._local_p2 = 0
        self._local_p3 = 0
        self._local_p4 = 0

        # ── Manual override state (per-pump, matches simulate.py) ──
        self.overrides: dict[str, int | None] = {p: None for p in ALL_PUMPS}
        self.override_times: dict[str, float] = {p: 0.0 for p in ALL_PUMPS}

        # ── Hysteresis controller (threshold tracking only) ──
        cfg = thresholds or {}
        self.hysteresis = HysteresisController(cfg)
        self.tank_depth_cm = cfg.get("tank_depth_cm", 32.0)

        # ── Physics engine ──
        preset = SCENARIO_PRESETS.get(scenario, SCENARIO_PRESETS["normal"])
        self.physics = PhysicsEngine(preset, tank_depth_cm=self.tank_depth_cm)

        # ── Auto mode (from backend /devices/automation) ──
        self.auto_enabled = True

        # ── Water alarm state ──
        self.alarm_was_active = False
        self.last_alarm_time = 0.0

        # ── REST API client ──
        self.token: str | None = None
        self._register_first = register_first
        self._http: httpx.AsyncClient | None = None

        # ── MQTT ──
        self._mqtt_client: mqtt.Client | None = None

        # ── Previous threshold values for change detection ──
        self._prev_jarak_on = 0.0
        self._prev_jarak_off = 0.0
        self._prev_tds_on = 0.0
        self._prev_tds_off = 0.0
        self._prev_ph_min = 0.0
        self._prev_ph_max = 0.0

    # ── Lifecycle ───────────────────────────────────────────────────────

    async def start(self):
        """Start the simulator: connect MQTT, login, fetch config, run loop."""
        self._setup_mqtt()
        self._http = httpx.AsyncClient()

        if self._register_first:
            await self._register()
        await self._login()
        await self._fetch_device_config()
        await self._fetch_automation_rules()

        # Push initial thresholds to ESP32
        await self._push_thresholds_to_esp32()

        scenario_desc = SCENARIO_PRESETS.get(self.scenario_name, {}).get("desc", "Unknown")
        print()
        print("=" * 65)
        print("  HELIOPONIC HYBRID SIMULATOR v2.1 (Python)")
        print("  Local Hysteresis + Physics Engine (matches simulate.py)")
        print("=" * 65)
        print(f"  Device:    {self.device_id}")
        print(f"  API:       {self.api_base}")
        print(f"  MQTT:      {self.broker}:{self.port}")
        print(f"  Scenario:  {self.scenario_name} — {scenario_desc}")
        print(f"  Publish:   {TOPIC_INJECT}")
        print(f"  Monitor:   {TOPIC_UPLINK} (ESP32 pump feedback)")
        print(f"  Monitor:   {TOPIC_DOWNLINK} (manual override)")
        print(f"  Push cfg:  {TOPIC_CONFIG}")
        print()
        print(f"  Thresholds: jarak_on={self.hysteresis.jarak_on}, "
              f"jarak_off={self.hysteresis.jarak_off}")
        print(f"              ph_min={self.hysteresis.ph_min}, "
              f"ph_max={self.hysteresis.ph_max}")
        print(f"              tds_on={self.hysteresis.tds_on}, "
              f"tds_off={self.hysteresis.tds_off}")
        print(f"  Auto mode: {self.auto_enabled}")
        print(f"  Sensor:    {SENSOR_INTERVAL}s | Publish: {PUBLISH_INTERVAL}s | "
              f"Poll: {POLL_INTERVAL}s")
        print(f"  Ctrl+C to stop")
        print("=" * 65)
        print()

        await self._run_loop()

    async def stop(self):
        """Graceful shutdown."""
        self.running = False
        if self._mqtt_client:
            self._mqtt_client.loop_stop()
            self._mqtt_client.disconnect()
        if self._http:
            await self._http.aclose()
        logger.info("Hybrid simulator stopped")
        if self.publish_count > 0:
            logger.info(f"  Total publishes: {self.publish_count}")

    # ── MQTT Setup ──────────────────────────────────────────────────────

    def _setup_mqtt(self):
        """Setup MQTT client — subscribe to ESP32 uplink and actuator downlink."""
        suffix = ''.join(random.choices("abcdefghijklmnopqrstuvwxyz", k=4))
        client_id = f"helioponic_hybrid_{suffix}"

        self._mqtt_client = mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)
        self._mqtt_client.on_connect = self._on_mqtt_connect
        self._mqtt_client.on_message = self._on_mqtt_message
        if self.mqtt_user and self.mqtt_pass:
            self._mqtt_client.username_pw_set(self.mqtt_user, self.mqtt_pass)
        self._mqtt_client.connect_async(self.broker, self.port, 60)
        self._mqtt_client.loop_start()

    def _on_mqtt_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            # Subscribe for ESP32 feedback (pump states) + manual override monitoring
            client.subscribe(TOPIC_UPLINK, qos=0)
            client.subscribe(TOPIC_DOWNLINK, qos=1)
            logger.info(f"MQTT connected, subscribed: {TOPIC_UPLINK}, {TOPIC_DOWNLINK}")
        else:
            logger.warning(f"MQTT connect failed (rc={rc})")

    def _on_mqtt_message(self, client, userdata, msg):
        """Handle MQTT messages: ESP32 uplink (pump feedback) + actuator downlink (override)."""
        try:
            topic = msg.topic
            data = json.loads(msg.payload)

            if topic == TOPIC_UPLINK:
                did = data.get("device_id", "")
                if did == self.device_id:
                    # Update ESP32 pump states for comparison
                    self._esp32_p1 = data.get("pompa1", 0)
                    self._esp32_p2 = data.get("pompa2", 0)
                    self._esp32_p3 = data.get("pompa3", 0)
                    self._esp32_p4 = data.get("pompa4", 0)
                    self._last_uplink_ts = time.time()
                    self._last_uplink_readings = {
                        "jarak_cm": data.get("jarak_cm", 0),
                        "tds_value": data.get("tds_value", 0),
                        "current_ph": data.get("current_ph", 0),
                    }

            elif topic == TOPIC_DOWNLINK:
                pump = data.get("pump")
                state = data.get("state")
                if pump is not None and pump in PUMP_ALIAS_MAP:
                    key = PUMP_ALIAS_MAP[pump]
                    self.overrides[key] = int(state)
                    self.override_times[key] = time.time()
                    logger.info(f"\033[91m[OVERRIDE] {key} -> {state} (from mobile app)\033[0m")

        except json.JSONDecodeError:
            pass
        except Exception as e:
            logger.debug(f"MQTT message error: {e}")

    # ── MQTT Publish Helpers ────────────────────────────────────────────

    def _publish(self, topic: str, payload: dict, qos: int = 0):
        """Publish JSON payload to MQTT topic."""
        if not self._mqtt_client:
            return
        self._mqtt_client.publish(topic, json.dumps(payload), qos=qos)

    def _publish_heartbeat(self):
        """Publish status heartbeat."""
        payload = {
            "device_id": self.device_id,
            "status": "online",
            "ts": int(time.time()),
            "version": FW_VERSION,
            "night_mode": 0,
            "wifi_rssi": -45,
        }
        self._publish(TOPIC_STATUS, payload)

    async def _push_thresholds_to_esp32(self):
        """Push current thresholds to ESP32 via config/downlink."""
        payload = {
            "device_id": self.device_id,
            "jarak_on": self.hysteresis.jarak_on,
            "jarak_off": self.hysteresis.jarak_off,
            "tds_on": self.hysteresis.tds_on,
            "tds_off": self.hysteresis.tds_off,
            "ph_min": self.hysteresis.ph_min,
            "ph_max": self.hysteresis.ph_max,
        }
        self._publish(TOPIC_CONFIG, payload, qos=1)
        logger.info(f"\033[92mThresholds pushed to ESP32\033[0m: "
                    f"jarak_on={self.hysteresis.jarak_on} jarak_off={self.hysteresis.jarak_off} "
                    f"tds_on={self.hysteresis.tds_on} tds_off={self.hysteresis.tds_off} "
                    f"ph_min={self.hysteresis.ph_min} ph_max={self.hysteresis.ph_max}")

    # ── REST Auth ──────────────────────────────────────────────────────

    async def _register(self):
        if not self._http:
            return
        try:
            r = await self._http.post(
                f"{self.api_base}/auth/register",
                json={
                    "email": TEST_USER_EMAIL,
                    "password": TEST_USER_PASSWORD,
                    "name": "Hybrid Simulation User",
                    "device_id": self.device_id,
                    "device_name": f"{self.device_id} (Hybrid Sim)",
                },
                timeout=10,
            )
            if r.status_code == 201:
                self.token = r.json().get("token")
                logger.info("Registration successful (JWT obtained)")
            elif r.status_code == 409:
                logger.info("User/device already registered")
        except Exception as e:
            logger.warning(f"Register failed: {e}")

    async def _login(self):
        if not self._http:
            return
        try:
            r = await self._http.post(
                f"{self.api_base}/auth/login",
                json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD},
                timeout=10,
            )
            if r.status_code == 200:
                self.token = r.json()["token"]
                logger.info("Logged in successfully (JWT token obtained)")
            else:
                logger.warning("Login failed — try --register")
        except Exception as e:
            logger.warning(f"Login failed: {e}")

    # ── API Polling ────────────────────────────────────────────────────

    async def _fetch_device_config(self):
        """Fetch device thresholds from backend API."""
        if not self._http or not self.token:
            return
        try:
            r = await self._http.get(
                f"{self.api_base}/devices/config",
                params={"device_id": self.device_id},
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=5,
            )
            if r.status_code == 200:
                data = r.json()
                new = {
                    "jarak_on": data.get("jarak_on", self.hysteresis.jarak_on),
                    "jarak_off": data.get("jarak_off", self.hysteresis.jarak_off),
                    "tds_on": data.get("tds_on", self.hysteresis.tds_on),
                    "tds_off": data.get("tds_off", self.hysteresis.tds_off),
                    "ph_min": data.get("ph_min", self.hysteresis.ph_min),
                    "ph_max": data.get("ph_max", self.hysteresis.ph_max),
                }
                # Update tank depth from config
                new_tank = data.get("tank_depth_cm", self.tank_depth_cm)
                if new_tank != self.tank_depth_cm:
                    self.tank_depth_cm = new_tank
                    self.physics.tank_depth_cm = new_tank
                    changed_tank = True
                else:
                    changed_tank = False

                # Detect changes
                changed = False
                if (new["jarak_on"] != self._prev_jarak_on or
                    new["jarak_off"] != self._prev_jarak_off or
                    new["tds_on"] != self._prev_tds_on or
                    new["tds_off"] != self._prev_tds_off or
                    new["ph_min"] != self._prev_ph_min or
                    new["ph_max"] != self._prev_ph_max):
                    changed = True
                    self._prev_jarak_on = new["jarak_on"]
                    self._prev_jarak_off = new["jarak_off"]
                    self._prev_tds_on = new["tds_on"]
                    self._prev_tds_off = new["tds_off"]
                    self._prev_ph_min = new["ph_min"]
                    self._prev_ph_max = new["ph_max"]

                # Apply new values
                for key, val in new.items():
                    setattr(self.hysteresis, key, val)

                if changed or changed_tank:
                    logger.info(f"\033[92mThresholds updated from backend:\033[0m "
                                f"tank_depth={self.tank_depth_cm}cm "
                                f"jarak_on={new['jarak_on']} jarak_off={new['jarak_off']} "
                                f"tds_on={new['tds_on']} tds_off={new['tds_off']} "
                                f"ph_min={new['ph_min']} ph_max={new['ph_max']}")
                    # Propagate to ESP32 immediately
                    self._publish(TOPIC_CONFIG, {
                        "device_id": self.device_id,
                        "tank_depth_cm": self.tank_depth_cm,
                        "jarak_on": new["jarak_on"],
                        "jarak_off": new["jarak_off"],
                        "tds_on": new["tds_on"],
                        "tds_off": new["tds_off"],
                        "ph_min": new["ph_min"],
                        "ph_max": new["ph_max"],
                    }, qos=1)
        except Exception as e:
            logger.debug(f"Config fetch failed: {e}")

    async def _fetch_automation_rules(self):
        """Fetch automation rules (auto_enabled) from backend API."""
        if not self._http or not self.token:
            return
        try:
            r = await self._http.get(
                f"{self.api_base}/devices/automation",
                params={"device_id": self.device_id},
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=5,
            )
            if r.status_code == 200:
                data = r.json()
                new_auto = data.get("auto_enabled", True)
                if new_auto != self.auto_enabled:
                    self.auto_enabled = new_auto
                    status = "\033[92mENABLED\033[0m" if new_auto else "\033[91mDISABLED\033[0m"
                    logger.info(f"\033[93mAUTO MODE: {status}\033[0m")
        except Exception as e:
            logger.debug(f"Automation fetch failed: {e}")

    # ── Alarm ──────────────────────────────────────────────────────────

    def _check_water_alarm(self, readings: dict):
        """Check water level alarm (rising edge on jarak_cm==999)."""
        jarak = readings.get("jarak_cm", 0)
        currently_alarming = (jarak == 999)
        if currently_alarming and not self.alarm_was_active:
            now = time.time()
            ALARM_COOLDOWN = 60
            if now - self.last_alarm_time >= ALARM_COOLDOWN:
                self.last_alarm_time = now
                payload = {
                    "device_id": self.device_id,
                    "alarm_type": "water_level",
                    "message": "Water level critical - ultrasonic out of range (jarak_cm=999)",
                    "ts": int(now),
                }
                self._publish(TOPIC_ALARM, payload)
                logger.info("\033[91m[ALARM] Water level critical (jarak_cm=999)\033[0m")
        self.alarm_was_active = currently_alarming

    # ── Override Expiry ────────────────────────────────────────────────

    def _clear_expired_overrides(self):
        """Clear manual overrides older than OVERRIDE_TIMEOUT (30 min).

        Uses per-pump timestamps so each override expires independently.
        Matches simulate.py exactly.
        """
        now = time.time()
        for pump in ALL_PUMPS:
            if self.overrides[pump] is not None:
                age = now - self.override_times.get(pump, 0)
                if age >= OVERRIDE_TIMEOUT:
                    logger.info(f"\033[93mOVERRIDE EXPIRED: {pump} ({age:.0f}s > {OVERRIDE_TIMEOUT}s) - returning to auto\033[0m")
                    self.overrides[pump] = None
                    self.override_times[pump] = 0.0

    # ── Main Loop ──────────────────────────────────────────────────────

    async def _run_loop(self):
        """Main loop: 200ms sensor cycle, 1000ms publish cycle.

        Flow matches simulate.py exactly:
          1. Clear expired manual overrides
          2. Read current sensor values from physics engine
          3. Evaluate hysteresis locally (if auto mode enabled)
          4. Apply ALL manual overrides (per-pump, from MQTT downlink)
          5. Log state changes
          6. Tick physics with LOCAL pump states (not ESP32 uplink)
          7. Check water alarm
          8. PUBLISH every 5th tick (1000ms): inject to ESP32 + REST fallback
          9. Status heartbeat every 150 ticks (30s)
         10. Config + automation poll every 30 ticks (~6s)

        The ESP32 independently runs its own hysteresis with same thresholds,
        controlling the physical pumps. Its uplink states are monitored for
        comparison but not used for physics decisions.
        """
        tick = 0

        while self.running:
            tick += 1
            dt = SENSOR_INTERVAL  # 0.2s

            # ── 1. Clear expired overrides ──
            self._clear_expired_overrides()

            # ── 2. Read current sensor values ──
            readings = self.physics.get_readings()

            # ── 3. Compute pump states via local hysteresis ──
            p1, p2, p3, p4 = self._local_p1, self._local_p2, self._local_p3, self._local_p4
            old_p1, old_p2, old_p3, old_p4 = p1, p2, p3, p4

            if self.auto_enabled:
                desired = self.hysteresis.evaluate(
                    readings["jarak_cm"],
                    readings["tds_value"],
                    readings["current_ph"],
                    p1, p2, p3, p4,
                )
                p1, p2, p3, p4 = desired

            # ── 4. Apply manual overrides (always — override wins even in AUTO) ──
            ov1 = self.overrides["pompa1"]
            ov2 = self.overrides["pompa2"]
            ov3 = self.overrides["pompa3"]
            ov4 = self.overrides["pompa4"]

            has_override = False
            if ov1 is not None:
                p1 = ov1; has_override = True
            if ov2 is not None:
                p2 = ov2; has_override = True
            if ov3 is not None:
                p3 = ov3; has_override = True
            if ov4 is not None:
                p4 = ov4; has_override = True

            # ── 5. Apply state changes + log ──
            self._local_p1, self._local_p2, self._local_p3, self._local_p4 = p1, p2, p3, p4

            # Determine mode tag for logging
            if has_override and not self.auto_enabled:
                mode_tag = "\033[91m[MANUAL]\033[0m"
            elif self.auto_enabled:
                mode_tag = "\033[96m[AUTO]\033[0m"
            else:
                mode_tag = "\033[93m[MANUAL MODE]\033[0m"

            if p1 != old_p1:
                logger.info(f"  {mode_tag} P1: \033[93m{old_p1}->{p1}\033[0m "
                            f"(jarak={readings['jarak_cm']}cm)")
            if p2 != old_p2:
                logger.info(f"  {mode_tag} P2: \033[93m{old_p2}->{p2}\033[0m "
                            f"(ph={readings['current_ph']})")
            if p3 != old_p3:
                logger.info(f"  {mode_tag} P3: \033[93m{old_p3}->{p3}\033[0m "
                            f"(tds={readings['tds_value']}ppm)")
            if p4 != old_p4:
                logger.info(f"  {mode_tag} P4: \033[93m{old_p4}->{p4}\033[0m "
                            f"(tds={readings['tds_value']}ppm)")

            # ── 6. Advance physics based on LOCAL pump states ──
            self.physics.tick(p1, p2, p3, p4, dt)

            # ── 7. Check water alarm ──
            self._check_water_alarm(readings)

            # ── 8. PUBLISH every 5th tick (1000ms) ──
            if tick % 5 == 0:
                readings = self.physics.get_readings()

                # Sensor-only inject payload to ESP32 (ESP32 runs its own hysteresis)
                inject_payload = {
                    "device_id": self.device_id,
                    "ts": int(time.time()),
                    "jarak_cm": readings["jarak_cm"],
                    "tds_value": readings["tds_value"],
                    "current_ph": readings["current_ph"],
                }
                self._publish(TOPIC_INJECT, inject_payload, qos=1)

                # REST fallback — sensor data with LOCAL pump states
                if self._http and self.token:
                    try:
                        await self._http.post(
                            f"{self.api_base}/sensors/reading",
                            json={
                                **inject_payload,
                                "pompa1": p1,
                                "pompa2": p2,
                                "pompa3": p3,
                                "pompa4": p4,
                            },
                            headers={"Authorization": f"Bearer {self.token}"},
                            timeout=3,
                        )
                    except Exception:
                        pass

                self.publish_count += 1

                # Display publish line with LOCAL pump states
                p1_s = f"\033[93m{p1}\033[0m"
                p2_s = f"\033[93m{p2}\033[0m"
                p3_s = f"\033[93m{p3}\033[0m"
                p4_s = f"\033[93m{p4}\033[0m"

                # Mode tag
                if has_override and not self.auto_enabled:
                    display_tag = " \033[91m[MANUAL]\033[0m"
                elif not self.auto_enabled:
                    display_tag = " \033[93m[MANUAL MODE]\033[0m"
                elif has_override:
                    display_tag = " \033[91m[MANUAL OVERRIDE]\033[0m"
                else:
                    display_tag = " \033[96m[AUTO]\033[0m"

                # ESP32 comparison (show if different)
                esp32_diff = ""
                if (p1 != self._esp32_p1 or p2 != self._esp32_p2 or
                    p3 != self._esp32_p3 or p4 != self._esp32_p4):
                    esp32_diff = f" \033[90mESP32: P1={self._esp32_p1} P2={self._esp32_p2} P3={self._esp32_p3} P4={self._esp32_p4}\033[0m"

                print(f"\033[92m[OK]\033[0m "
                      f"jarak=\033[96m{readings['jarak_cm']}cm\033[0m "
                      f"tds=\033[96m{readings['tds_value']}ppm\033[0m "
                      f"ph=\033[96m{readings['current_ph']}\033[0m "
                      f"P1={p1_s} P2={p2_s} P3={p3_s} P4={p4_s}"
                      f"{display_tag}{esp32_diff}")

                if self.max_publishes > 0 and self.publish_count >= self.max_publishes:
                    logger.info(f"Reached max publishes ({self.max_publishes})")
                    await self.stop()
                    return

            # ── 9. Status heartbeat every 150 ticks (30s) ──
            if tick % 150 == 0:
                self._publish_heartbeat()
                # Show current thresholds for debugging
                logger.info(f"\033[90mTHRESH: tank={self.tank_depth_cm}cm jarak_on={self.hysteresis.jarak_on} jarak_off={self.hysteresis.jarak_off} "
                            f"tds_on={self.hysteresis.tds_on} tds_off={self.hysteresis.tds_off} "
                            f"ph_min={self.hysteresis.ph_min} ph_max={self.hysteresis.ph_max}\033[0m")

            # ── 10. Periodic config + automation fetch (every 30 ticks = ~6s) ──
            if tick % 30 == 0:
                asyncio.create_task(self._fetch_device_config())
                asyncio.create_task(self._fetch_automation_rules())

            # ── Sleep for remaining time (200ms cycle) ──
            await asyncio.sleep(SENSOR_INTERVAL)


# ============================================================================
# Main
# ============================================================================

def parse_thresholds(args_list: list[str]) -> dict:
    """Parse --thresholds key=val key=val into dict."""
    result = {}
    for item in args_list:
        if "=" in item:
            k, v = item.split("=", 1)
            try:
                result[k] = float(v)
            except ValueError:
                result[k] = v
    return result


async def main():
    parser = argparse.ArgumentParser(
        description="Helioponic Hybrid Simulator v2.0 (Python)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Architecture:
  LocalHysteresis + PhysicsEngine > inject topic > ESP32 > pump control > uplink > (compare)

The ESP32 uplink pump states are shown in gray if they differ from local decisions.

Scenarios (initial physics state, then physics takes over):
  normal        Kondisi ideal (~3.5cm, ~400ppm, ~6.0pH)
  water-low     Air surut (~6.5cm) > pompa1 ON > physics refill
  water-full    Air penuh (~1.2cm) > pompa1 OFF > physics evaporasi
  ph-high       pH tinggi (~7.5) > pompa2 ON > physics turunkan
  ph-low        pH rendah (~4.8) > pompa2 OFF > physics naikkan
  tds-low       TDS rendah (~70ppm) > pompa3+4 ON > physics tambah
  tds-high      TDS tinggi (~550ppm) > pompa3+4 OFF > physics decay
  out-of-range  Jarak=999 > alarm
  cycle         Mulai normal, biarkan physics+ESP32 automasi

Env vars:
  MQTT_USER     MQTT username
  MQTT_PASS     MQTT password
        """
    )
    parser.add_argument("--device", default=DEVICE_ID_DEFAULT,
                        help=f"Device ID (default: {DEVICE_ID_DEFAULT})")
    parser.add_argument("--api", default="http://localhost:8000/api/v1",
                        help="Backend API base URL (default: http://localhost:8000/api/v1)")
    parser.add_argument("--scenario", default="normal",
                        choices=list(SCENARIO_PRESETS.keys()),
                        help="Initial scenario preset (default: normal)")
    parser.add_argument("--register", action="store_true",
                        help="Register test user + device first")
    parser.add_argument("--count", type=int, default=0,
                        help="Send N publishes then exit (default: unlimited)")
    parser.add_argument("--thresholds", nargs="*", default=[],
                        help="Custom thresholds: jarak_on=5.0 jarak_off=2.0 ...")
    parser.add_argument("--broker", default=MQTT_BROKER_DEFAULT,
                        help=f"MQTT broker host (default: {MQTT_BROKER_DEFAULT})")
    parser.add_argument("--port", type=int, default=MQTT_PORT_DEFAULT,
                        help=f"MQTT broker port (default: {MQTT_PORT_DEFAULT})")
    parser.add_argument("--mqtt-user", default=None,
                        help="MQTT username (env: MQTT_USER)")
    parser.add_argument("--mqtt-pass", default=None,
                        help="MQTT password (env: MQTT_PASS)")
    parser.add_argument("--version", action="version",
                        version=f"%(prog)s v{__version__}",
                        help="Show version number and exit")

    args = parser.parse_args()

    thresholds = parse_thresholds(args.thresholds)

    sim = HybridSimulatorV2(
        device_id=args.device,
        api_base=args.api,
        scenario=args.scenario,
        thresholds=thresholds,
        register_first=args.register,
        broker=args.broker,
        port=args.port,
        mqtt_user=args.mqtt_user,
        mqtt_pass=args.mqtt_pass,
    )
    sim.max_publishes = args.count

    # Handle Ctrl+C gracefully
    try:
        loop = asyncio.get_event_loop()
        loop.add_signal_handler(signal.SIGINT, lambda: asyncio.create_task(sim.stop()))
        loop.add_signal_handler(signal.SIGTERM, lambda: asyncio.create_task(sim.stop()))
    except (NotImplementedError, AttributeError):
        # Windows doesn't support add_signal_handler
        pass

    try:
        await sim.start()
    except asyncio.CancelledError:
        pass
    finally:
        await sim.stop()
    print("\nHybrid simulation ended.\n")


if __name__ == "__main__":
    asyncio.run(main())
