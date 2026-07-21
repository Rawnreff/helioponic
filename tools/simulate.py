#!/usr/bin/env python3
"""
Helioponic — Hardware Simulator v5.0 (Python)
==============================================
Reactive physics-based hardware emulator matching ESP32 firmware behavior.

Features ported from simulate.sh v4.x:
  - Physics engine: sensor values react to pump states (realistic)
  - 200ms sensor loop + 1000ms publish cycle (feedback delay)
  - JWT authentication for all API calls
  - Periodic threshold & auto_rules polling (every ~6s)
  - Auto Mode detection (respects auto_enabled from backend)
  - Manual override timeout (30 min auto-clear)
  - Water level alarm (rising edge on jarak_cm==999)
  - Status heartbeat every 30s to helioponic/status/uplink
  - State change logging with trigger sensor values
  - [AUTO] / [MANUAL] mode tags in publish log

Usage:
  python tools/simulate.py                              # Start simulation
  python tools/simulate.py --device HELIO_CUSTOM       # Custom device ID
  python tools/simulate.py --register                   # Register test user first
  python tools/simulate.py --count 10                   # Send N publishes then exit
  python tools/simulate.py --thresholds ph_min=5.0 ph_max=7.0  # Custom thresholds

Requires:
  - pip install paho-mqtt httpx
  - Docker containers running (docker compose up -d)
"""

import argparse
import asyncio
import json
import logging
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

# ─── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("simulator")

# ─── Constants ──────────────────────────────────────────────────────────────
MQTT_BROKER = "localhost"
MQTT_PORT = 1883

TOPIC_UPLINK = "helioponic/sensor/uplink"
TOPIC_STATUS = "helioponic/status/uplink"
TOPIC_ALARM = "helioponic/alarm/uplink"
TOPIC_DOWNLINK = "helioponic/actuator/downlink"

TEST_USER_EMAIL = "sim@helioponic.io"
TEST_USER_PASSWORD = "sim123"
DEVICE_ID_DEFAULT = "HELIO_SIM_001"

FW_VERSION = "3.3.0"

# Tank geometry (matches backend WaterCalculator)
TANK_DEPTH_CM = 7.0

# Physics rates per second
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
OVERRIDE_TIMEOUT = 1800     # 30 minutes auto-clear
ALARM_COOLDOWN = 60         # 60 seconds alarm cooldown

# Pump names for override tracking
ALL_PUMPS = ["pompa1", "pompa2", "pompa3", "pompa4"]


# ============================================================================
# Internal Bang-Bang Hysteresis Engine (matches app/services/automation.py)
# ============================================================================

class HysteresisController:
    """4-pump bang-bang hysteresis — matches backend evaluate_thresholds().

    Pompa 1 (Water Refill):    jarak_cm > jarak_on → ON, jarak_cm < jarak_off → OFF
    Pompa 2 (pH DOWN):          pH > ph_max → ON, pH < ph_min → OFF
    Pompa 3 & 4 (Nutrient A+B): TANDEM — tds < tds_on → both ON, tds > tds_off → both OFF
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
    """Simulates environmental changes based on active pump states (all 4 pumps).

    Each tick (dt seconds):
      - pompa1=ON:  jarak_cm decreases (water rises) by JARAK_REFILL_RATE * dt
      - pompa1=OFF: jarak_cm increases (usage) by JARAK_EVAP_RATE * dt
      - pompa2=ON:  current_ph decreases (pH DOWN dosing) by PH_DOWN_RATE * dt
      - pompa2=OFF: current_ph rises by PH_DRIFT_UP_RATE * dt
      - pompa3=ON AND pompa4=ON: tds_value increases (nutrients added)
      - Otherwise: tds_value slowly decays (consumption)
    """

    def __init__(self, tank_depth_cm: float = 32.0):
        # Initial sensor state — TDS starts at 400 (midpoint of user range 300-500)
        self.jarak_cm = 3.5
        self.tds_value = 400.0
        self.current_ph = 6.8
        self.tank_depth_cm = tank_depth_cm

    def tick(self, pompa1: int, pompa2: int, pompa3: int, pompa4: int, dt: float = 1.0):
        """Advance physics simulation by dt seconds based on all 4 pump states."""

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

        # ── TDS (Nutrient) - Reactive to Pompa 3 & Pompa 4 ──
        if pompa3 == 1 and pompa4 == 1:
            self.tds_value += TDS_DOSE_RATE * dt
        else:
            # Slow decay (nutrient consumption) + small random noise
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
# Simulator
# ============================================================================

class Simulator:
    """Reactive physics-based hardware emulator with ESP32-like behavior.

    Runs a 200ms sensor loop with phased publishes every 5 cycles (1000ms):
      1. Read physics engine (sensor values react to pump states)
      2. Evaluate hysteresis (if auto mode enabled)
      3. Apply manual overrides
      4. Check water alarm
      5. Publish every 5th cycle (using feedback-delayed state)
      6. Feedback delay update (pub = cmd)
      7. Heartbeat every 150th cycle (30s)
      8. Periodic config + auto_rules fetch (every 30 cycles = 6s)
    """

    def __init__(self, device_id: str, api_base: str,
                 thresholds: dict | None = None,
                 register_first: bool = False):
        self.device_id = device_id
        self.api_base = api_base
        self.running = True
        self.max_publishes = 0
        self.publish_count = 0

        # ── Manual override state ──
        self.overrides: dict[str, int | None] = {p: None for p in ALL_PUMPS}
        # Per-pump override timestamps (not a single shared timestamp)
        self.override_times: dict[str, float] = {p: 0.0 for p in ALL_PUMPS}

        # ── Pump states ──
        # cmd_p = commanded state (what ESP32 tells Arduino)
        # pub_p = published state (what Arduino feedback confirms — 1 cycle lag)
        self.cmd_p1, self.cmd_p2, self.cmd_p3, self.cmd_p4 = 0, 0, 0, 0
        self.pub_p1, self.pub_p2, self.pub_p3, self.pub_p4 = 0, 0, 0, 0

        # ── Hysteresis controller ──
        cfg = thresholds or {}
        self.hysteresis = HysteresisController(cfg)
        self.tank_depth_cm = cfg.get("tank_depth_cm", 32.0)

        # ── Physics engine ──
        self.physics = PhysicsEngine(tank_depth_cm=self.tank_depth_cm)

        # ── Auto mode (from backend /devices/automation) ──
        self.auto_enabled = True
        self.prev_auto_enabled = True

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
        self._prev_jarak_on = 0
        self._prev_jarak_off = 0
        self._prev_tds_on = 0
        self._prev_tds_off = 0
        self._prev_ph_min = 0
        self._prev_ph_max = 0

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

        logger.info(f"Simulator started for device={self.device_id}")
        logger.info(f"  Tank depth: {self.tank_depth_cm}cm | "
                    f"Thresholds: jarak_on={self.hysteresis.jarak_on}, "
                    f"jarak_off={self.hysteresis.jarak_off}")
        logger.info(f"              ph_min={self.hysteresis.ph_min}, "
                    f"ph_max={self.hysteresis.ph_max}")
        logger.info(f"              tds_on={self.hysteresis.tds_on}, "
                    f"tds_off={self.hysteresis.tds_off}")
        logger.info(f"  Auto mode: {self.auto_enabled}")
        logger.info(f"  Sensor: {SENSOR_INTERVAL}s | Publish: {PUBLISH_INTERVAL}s | "
                    f"Poll: {POLL_INTERVAL}s")
        logger.info("")

        await self._run_loop()

    async def stop(self):
        """Graceful shutdown."""
        self.running = False
        if self._mqtt_client:
            self._mqtt_client.loop_stop()
            self._mqtt_client.disconnect()
        if self._http:
            await self._http.aclose()
        logger.info("Simulator stopped")

    # ── MQTT Setup ──────────────────────────────────────────────────────

    def _setup_mqtt(self):
        """Setup MQTT client and subscribe to actuator/downlink."""
        suffix = ''.join(random.choices("abcdefghijklmnopqrstuvwxyz", k=4))
        client_id = f"helioponic_sim_{suffix}"

        self._mqtt_client = mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)
        self._mqtt_client.on_connect = self._on_mqtt_connect
        self._mqtt_client.on_message = self._on_mqtt_message
        # Use same credentials as backend (from mosquitto/config/init-passwd.sh)
        self._mqtt_client.username_pw_set("helioponic", "helioponic_mqtt_2024")
        self._mqtt_client.connect_async(MQTT_BROKER, MQTT_PORT, 60)
        self._mqtt_client.loop_start()

    def _on_mqtt_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            client.subscribe(TOPIC_DOWNLINK, qos=1)
            logger.info(f"MQTT connected, subscribed to {TOPIC_DOWNLINK}")
        else:
            logger.warning(f"MQTT connect failed (rc={rc})")

    def _on_mqtt_message(self, client, userdata, msg):
        """Handle incoming actuator commands from mobile app."""
        try:
            data = json.loads(msg.payload)
            pump = data.get("pump")
            state = data.get("state")

            pump_map = {
                "pompa1": "pompa1", "circ": "pompa1",
                "pompa2": "pompa2", "ph_d": "pompa2",
                "pompa3": "pompa3", "nut_a": "pompa3",
                "pompa4": "pompa4", "nut_b": "pompa4",
            }
            if pump in pump_map:
                key = pump_map[pump]
                self.overrides[key] = int(state)
                # Track per-pump timestamp for override expiry
                self.override_times[key] = time.time()
                logger.info(f"\033[91mOVERRIDE: {key} -> {state}\033[0m")
        except Exception as e:
            logger.warning(f"Failed to parse actuator command: {e}")

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
                    "name": "Simulation User",
                    "device_id": self.device_id,
                    "device_name": f"{self.device_id} (Simulated)",
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
                    self._prev_tank_depth = new_tank
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
                    logger.info(f"\033[92mThresholds updated:\033[0m "
                                f"tank_depth={self.tank_depth_cm}cm "
                                f"jarak_on={new['jarak_on']} jarak_off={new['jarak_off']} "
                                f"tds_on={new['tds_on']} tds_off={new['tds_off']} "
                                f"ph_min={new['ph_min']} ph_max={new['ph_max']}")
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
                    status = "ENABLED" if new_auto else "DISABLED"
                    logger.info(f"\033[93mAUTO MODE {status}\033[0m")
        except Exception as e:
            logger.debug(f"Automation fetch failed: {e}")

    # ── Helper Methods ─────────────────────────────────────────────────

    def _clear_expired_overrides(self):
        """Clear manual overrides older than OVERRIDE_TIMEOUT (30 min).

        Uses per-pump timestamps so each override expires independently.
        """
        now = time.time()
        for pump in ALL_PUMPS:
            if self.overrides[pump] is not None:
                age = now - self.override_times.get(pump, 0)
                if age >= OVERRIDE_TIMEOUT:
                    logger.info(f"\033[93mOVERRIDE EXPIRED: {pump} ({age:.0f}s > {OVERRIDE_TIMEOUT}s) - returning to auto\033[0m")
                    self.overrides[pump] = None
                    self.override_times[pump] = 0.0

    def _check_water_alarm(self, readings: dict):
        """Check water level alarm (rising edge on jarak_cm==999)."""
        jarak = readings.get("jarak_cm", 0)
        currently_alarming = (jarak == 999)
        if currently_alarming and not self.alarm_was_active:
            now = time.time()
            if now - self.last_alarm_time >= ALARM_COOLDOWN:
                self.last_alarm_time = now
                payload = {
                    "device_id": self.device_id,
                    "alarm_type": "water_level",
                    "message": "Water level critical - ultrasonic out of qod (jarak_cm=999)",
                    "ts": int(now),
                }
                self._publish(TOPIC_ALARM, payload)
                logger.info("\033[91m[ALARM] Water level critical (jarak_cm=999)\033[0m")
        self.alarm_was_active = currently_alarming

    def _publish_heartbeat(self):
        """Publish status heartbeat to helioponic/status/uplink."""
        payload = {
            "device_id": self.device_id,
            "status": "online",
            "ts": int(time.time()),
            "version": FW_VERSION,
            "night_mode": 0,
            "wifi_rssi": -45,
        }
        self._publish(TOPIC_STATUS, payload)

    def _publish(self, topic: str, payload: dict):
        """Publish JSON payload to MQTT topic (QoS 1 for important topics)."""
        if not self._mqtt_client:
            return
        qos = 1 if topic != TOPIC_UPLINK else 0
        self._mqtt_client.publish(topic, json.dumps(payload), qos=qos)

    # ── Main Simulation Loop ──────────────────────────────────────────

    async def _run_loop(self):
        """Main loop: 200ms sensor cycle, 1000ms publish cycle."""
        tick = 0
        start_time = time.time()

        while self.running:
            tick += 1
            dt = SENSOR_INTERVAL  # 0.2s

            # ── 1. Clear expired overrides ──
            self._clear_expired_overrides()

            # ── 2. Read current sensor values ──
            readings = self.physics.get_readings()

            # ── 3. Compute pump states via hysteresis ──
            p1, p2, p3, p4 = self.cmd_p1, self.cmd_p2, self.cmd_p3, self.cmd_p4
            old_p1, old_p2, old_p3, old_p4 = p1, p2, p3, p4

            if self.auto_enabled:
                desired = self.hysteresis.evaluate(
                    readings["jarak_cm"],
                    readings["tds_value"],
                    readings["current_ph"],
                    p1, p2, p3, p4,
                )
                p1, p2, p3, p4 = desired

            # ── 4. Apply manual overrides (always — even in AUTO mode, override wins) ──
            has_override = False
            ov1 = self.overrides["pompa1"]
            ov2 = self.overrides["pompa2"]
            ov3 = self.overrides["pompa3"]
            ov4 = self.overrides["pompa4"]

            if ov1 is not None: p1 = ov1; has_override = True
            if ov2 is not None: p2 = ov2; has_override = True
            if ov3 is not None: p3 = ov3; has_override = True
            if ov4 is not None: p4 = ov4; has_override = True

            # ── 5. Apply state changes (if any) + log ──
            self.cmd_p1, self.cmd_p2, self.cmd_p3, self.cmd_p4 = p1, p2, p3, p4

            # Determine correct mode tag for logging
            mode_tag = "\033[91m[MANUAL]\033[0m" if has_override and not self.auto_enabled else ("\033[96m[AUTO]\033[0m" if self.auto_enabled else "")

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

            # ── 6. Advance physics based on cmd states ──
            self.physics.tick(self.cmd_p1, self.cmd_p2, self.cmd_p3, self.cmd_p4, dt)

            # ── 7. Check water alarm ──
            self._check_water_alarm(readings)

            # ── 8. PUBLISH every 5th tick (1000ms) using FEEDBACK state (pub) ──
            if tick % 5 == 0:
                readings = self.physics.get_readings()
                payload = {
                    "device_id": self.device_id,
                    "ts": int(time.time()),
                    "jarak_cm": readings["jarak_cm"],
                    "tds_value": readings["tds_value"],
                    "current_ph": readings["current_ph"],
                    "pompa1": self.pub_p1,
                    "pompa2": self.pub_p2,
                    "pompa3": self.pub_p3,
                    "pompa4": self.pub_p4,
                }
                self._publish(TOPIC_UPLINK, payload)

                # REST fallback
                if self._http and self.token:
                    try:
                        await self._http.post(
                            f"{self.api_base}/sensors/reading",
                            json=payload,
                            headers={"Authorization": f"Bearer {self.token}"},
                            timeout=3,
                        )
                    except Exception:
                        pass

                self.publish_count += 1

                # Status tags
                has_override = any(v is not None for v in self.overrides.values())
                ov_tag = " \033[91m[MANUAL]\033[0m" if has_override else ""
                auto_tag = " \033[93m[MANUAL MODE]\033[0m" if not self.auto_enabled else ""

                print(f"\033[92m[OK]\033[0m "
                      f"jarak=\033[96m{readings['jarak_cm']}cm\033[0m "
                      f"tds=\033[96m{readings['tds_value']}ppm\033[0m "
                      f"ph=\033[96m{readings['current_ph']}\033[0m "
                      f"P1=\033[93m{self.pub_p1}\033[0m "
                      f"P2=\033[93m{self.pub_p2}\033[0m "
                      f"P3=\033[93m{self.pub_p3}\033[0m "
                      f"P4=\033[93m{self.pub_p4}\033[0m"
                      f"{ov_tag}{auto_tag}")

                if self.max_publishes > 0 and self.publish_count >= self.max_publishes:
                    logger.info(f"Reached max publishes ({self.max_publishes})")
                    await self.stop()
                    return

            # ── 9. Feedback delay: pub = cmd (1 cycle lag) ──
            self.pub_p1, self.pub_p2, self.pub_p3, self.pub_p4 = \
                self.cmd_p1, self.cmd_p2, self.cmd_p3, self.cmd_p4

            # ── 10. Status heartbeat every 150 ticks (30s) ──
            if tick % 150 == 0:
                self._publish_heartbeat()

            # ── 11. Periodic fetch (every 30 ticks = ~6s) ──
            # Use create_task so HTTP doesn't block the 200ms sensor loop
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
        description="Helioponic Hardware Simulator v5.0 (Python)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--device", default=DEVICE_ID_DEFAULT,
                        help=f"Device ID (default: {DEVICE_ID_DEFAULT})")
    parser.add_argument("--api", default="http://localhost:8000/api/v1",
                        help="Backend API base URL")
    parser.add_argument("--register", action="store_true",
                        help="Register test user + device first")
    parser.add_argument("--count", type=int, default=0,
                        help="Send N publishes then exit (default: unlimited)")
    parser.add_argument("--thresholds", nargs="*", default=[],
                        help="Custom thresholds: jarak_on=5.0 jarak_off=2.0")
    args = parser.parse_args()

    thresholds = parse_thresholds(args.thresholds)

    sim = Simulator(
        device_id=args.device,
        api_base=args.api,
        thresholds=thresholds,
        register_first=args.register,
    )
    sim.max_publishes = args.count

    # Handle Ctrl+C gracefully
    try:
        loop = asyncio.get_event_loop()
        loop.add_signal_handler(signal.SIGINT, lambda: asyncio.create_task(sim.stop()))
        loop.add_signal_handler(signal.SIGTERM, lambda: asyncio.create_task(sim.stop()))
    except (NotImplementedError, AttributeError):
        # Windows doesn't support add_signal_handler - use KeyboardInterrupt instead
        pass

    print()
    print("=" * 65)
    print("  HELIOPONIC HARDWARE SIMULATOR v5.0 (Python)")
    print("  Reactive Physics-Based Emulation")
    print("=" * 65)
    print(f"  Device:   {args.device}")
    print(f"  API:      {args.api}")
    print(f"  MQTT:     {MQTT_BROKER}:{MQTT_PORT}")
    print(f"  Topics:   ^ {TOPIC_UPLINK}")
    print(f"            v {TOPIC_DOWNLINK}")
    print(f"  Sensor:   {SENSOR_INTERVAL}s | Publish: {PUBLISH_INTERVAL}s")
    print(f"  Physics:  Reactive (water/pH/TDS respond to pump states)")
    if thresholds:
        print(f"  Custom thresholds: {thresholds}")
    print(f"  Ctrl+C to stop")
    print("=" * 65)
    print()

    try:
        await sim.start()
    except asyncio.CancelledError:
        pass
    finally:
        await sim.stop()
    print("\nSimulation ended.\n")


if __name__ == "__main__":
    asyncio.run(main())
