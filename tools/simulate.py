#!/usr/bin/env python3
"""
Helioponic — Reactive Physics-Based Hardware Simulator
=======================================================
Emulates a real ESP32 + Arduino hardware setup with:

  - **Internal State Engine**: Exact bang-bang hysteresis automation rules
    matching the firmware (evaluate_thresholds replica).
  - **Reactive Physics Engine**: Sensor values change dynamically based on
    active pump states (water level drops when pump1=1, pH drops when pump2=1).
  - **Downlink Command Listener**: Subscribes to MQTT helioponic/actuator/downlink
    for manual override from the mobile app.
  - **Unified Ingestion**: Publishes both sensor readings AND pompa states
    (always 0 or 1, never None) — backend treats all data as Source of Truth.

Usage:
  python tools/simulate.py                          # Start simulation
  python tools/simulate.py --device HELIO_CUSTOM    # Custom device ID
  python tools/simulate.py --register               # Register test user first
  python tools/simulate.py --thresholds ph_min=5.0 ph_max=7.0  # Custom thresholds
  python tools/simulate.py --step-by-step           # Manual step mode (press Enter)

Requires:
  - pip install paho-mqtt httpx
  - Docker containers running (docker compose up -d)
"""

import argparse
import asyncio
import json
import logging
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
TOPIC_DOWNLINK = "helioponic/actuator/downlink"

TEST_USER_EMAIL = "sim@helioponic.io"
TEST_USER_PASSWORD = "sim123"
DEVICE_ID_DEFAULT = "HELIO_SIM_001"

# Tank geometry (matches backend WaterCalculator)
TANK_DEPTH_CM = 7.0

# Physics rates per second (simulated)
# pompa1 ON  → jarak_cm decreases by this much per second (water rising)
# pompa1 OFF → jarak_cm increases by this much per second (evaporation/usage)
JARAK_REFILL_RATE = 0.08   # cm/s — water level rises when pompa1=ON
JARAK_EVAP_RATE = 0.02     # cm/s — water level drops when pompa1=OFF

# pompa2 ON  → pH decreases (pH DOWN dosing)
# pompa2 OFF → pH slowly drifts up (natural)
PH_DOWN_RATE = 0.015        # pH/s — pH drops when pompa2=ON
PH_DRIFT_UP_RATE = 0.002    # pH/s — pH rises when pompa2=OFF

# TDS drift (slow random walk)
TDS_DRIFT_RATE = 0.5        # ppm/s — slow drift when no dosing


# ============================================================================
# Internal Bang-Bang Hysteresis Engine (matches app/services/automation.py)
# ============================================================================

class HysteresisController:
    """Replica of the firmware's bang-bang hysteresis logic.

    Pompa 1 (Water Refill): jarak_cm > jarak_on → ON, jarak_cm < jarak_off → OFF
    Pompa 2 (pH DOWN):      pH > ph_max → ON, pH < ph_min → OFF
    Pompa 2 (TDS backup):   Only if rule_ph disabled — tds < tds_on → ON, tds > tds_off → OFF
    """

    def __init__(self, config: dict):
        self.jarak_on = config.get("jarak_on", 5.0)
        self.jarak_off = config.get("jarak_off", 2.0)
        self.tds_on = config.get("tds_on", 95.0)
        self.tds_off = config.get("tds_off", 105.0)
        self.ph_min = config.get("ph_min", 5.5)
        self.ph_max = config.get("ph_max", 6.5)
        self.rule_ph = config.get("rule_ph", True)
        self.rule_tds = config.get("rule_tds", True)
        self.rule_water = config.get("rule_water", True)
        self.auto_enabled = config.get("auto_enabled", True)

    def evaluate(self, jarak_cm: float, tds_value: float, current_ph: float,
                 pompa1_state: int, pompa2_state: int) -> tuple[int, int]:
        """Evaluate thresholds and return desired pump states.

        Returns (desired_p1, desired_p2).
        """
        if not self.auto_enabled:
            return pompa1_state, pompa2_state

        ultrasonik_valid = (jarak_cm != 999 and jarak_cm > 0)
        ph_valid = current_ph > 0

        # Pompa 1 — Water Level
        p1 = pompa1_state
        if self.rule_water and ultrasonik_valid:
            if jarak_cm > self.jarak_on:
                p1 = 1
            elif jarak_cm < self.jarak_off:
                p1 = 0

        # Pompa 2 — pH DOWN
        p2 = pompa2_state
        if self.rule_ph and ph_valid:
            if current_ph > self.ph_max:
                p2 = 1
            elif current_ph < self.ph_min:
                p2 = 0
        elif self.rule_tds:
            if tds_value < self.tds_on:
                p2 = 1
            elif tds_value > self.tds_off:
                p2 = 0

        return p1, p2


# ============================================================================
# Physics Engine — simulates environment changes based on pump states
# ============================================================================

class PhysicsEngine:
    """Simulates environmental changes based on active pump states.

    Each tick (1 second):
      - pompa1=ON:  jarak_cm decreases (water level rising) by JARAK_REFILL_RATE
      - pompa1=OFF: jarak_cm increases (usage/evaporation) by JARAK_EVAP_RATE
      - pompa2=ON:  current_ph decreases (pH DOWN dosing) by PH_DOWN_RATE
      - pompa2=OFF: current_ph rises by PH_DRIFT_UP_RATE
      - tds_value:  slow random drift
    """

    def __init__(self):
        # Initial sensor state (realistic mid-range)
        self.jarak_cm = 3.5       # ~50% water level
        self.tds_value = 200.0    # mid-range nutrients
        self.current_ph = 6.8     # slightly above ph_max (triggers pH DOWN)

    def tick(self, pompa1: int, pompa2: int, dt: float = 1.0):
        """Advance physics simulation by dt seconds based on current pump states."""

        # ── Water Level (jarak_cm) ──────────────────────────────────────
        # jarak = ultrasonic distance to water surface
        # Smaller jarak = more water (tank is filling)
        if pompa1 == 1:
            # Refill running: water rises → jarak decreases
            self.jarak_cm -= JARAK_REFILL_RATE * dt
        else:
            # No refill: water consumed → jarak increases
            self.jarak_cm += JARAK_EVAP_RATE * dt

        # Clamp jarak_cm to realistic range (0 to tank depth)
        self.jarak_cm = max(0.5, min(TANK_DEPTH_CM - 0.3, self.jarak_cm))

        # ── pH Level ────────────────────────────────────────────────────
        if pompa2 == 1:
            # pH DOWN dosing active: pH decreases
            self.current_ph -= PH_DOWN_RATE * dt
        else:
            # No dosing: pH slowly drifts up
            self.current_ph += PH_DRIFT_UP_RATE * dt

        # Clamp pH to realistic range
        self.current_ph = max(4.0, min(8.5, self.current_ph))

        # ── TDS (Nutrient) ──────────────────────────────────────────────
        # Slow random drift (simulating nutrient consumption/evaporation)
        import random
        self.tds_value += (random.random() - 0.5) * TDS_DRIFT_RATE * dt * 2
        self.tds_value = max(50, min(800, self.tds_value))

    def get_readings(self) -> dict:
        """Return current sensor readings (rounded to realistic precision)."""
        return {
            "jarak_cm": round(self.jarak_cm, 1),
            "tds_value": round(self.tds_value, 0),
            "current_ph": round(self.current_ph, 1),
        }


# ============================================================================
# Simulator — ties together physics, hysteresis, MQTT, and REST
# ============================================================================

class Simulator:
    """Reactive physics-based hardware emulator.

    Runs a 1-second tick loop:
      1. Check for actuator downlink commands (MQTT callback)
      2. Evaluate thresholds using internal hysteresis engine
      3. If threshold-desired state differs from current → transition
      4. Advance physics simulation based on current pump states
      5. Publish sensor + pump states via MQTT (+ REST fallback)
      6. Sleep 1 second
    """

    def __init__(self, device_id: str, api_base: str,
                 thresholds: dict | None = None,
                 register_first: bool = False):
        self.device_id = device_id
        self.api_base = api_base
        self.running = True

        # ── Actuator override state ─────────────────────────────────────
        # When the mobile app sends a manual pump command via
        # POST /actuators/pump, it gets published to MQTT actuator/downlink.
        # The simulator catches this and sets an override.
        # Override persists for 30 seconds (matches backend MANUAL_OVERRIDE_COOLDOWN_S).
        self.manual_override_p1: int | None = None
        self.manual_override_p2: int | None = None
        self.override_time: float = 0

        # ── Current pump states (start with both OFF) ───────────────────
        self.pompa1 = 0
        self.pompa2 = 0

        # ── Physics engine ──────────────────────────────────────────────
        self.physics = PhysicsEngine()

        # ── Hysteresis controller ───────────────────────────────────────
        cfg = thresholds or {}
        self.hysteresis = HysteresisController(cfg)

        # ── REST API client ────────────────────────────────────────────
        self.token: str | None = None
        self._register_first = register_first
        self._http: httpx.AsyncClient | None = None

        # ── MQTT ────────────────────────────────────────────────────────
        self._mqtt_client: mqtt.Client | None = None

    # ── Lifecycle ─────────────────────────────────────────────────────

    async def start(self):
        """Start the simulator: connect MQTT, login, fetch config, run loop."""
        # Setup MQTT
        self._setup_mqtt()

        # Setup HTTP
        self._http = httpx.AsyncClient()

        # Register / login
        if self._register_first:
            await self._register()
        await self._login()

        # ── Fetch device config from backend (sync with AutomationScreen) ──
        await self._fetch_device_config()

        logger.info(f"Simulator started for device={self.device_id}")
        logger.info(f"  Thresholds: jarak_on={self.hysteresis.jarak_on}, "
                    f"jarak_off={self.hysteresis.jarak_off}")
        logger.info(f"              ph_min={self.hysteresis.ph_min}, "
                    f"ph_max={self.hysteresis.ph_max}")
        logger.info(f"              tds_on={self.hysteresis.tds_on}, "
                    f"tds_off={self.hysteresis.tds_off}")
        logger.info(f"  Initial: jarak={self.physics.jarak_cm}cm, "
                    f"tds={self.physics.tds_value}ppm, "
                    f"pH={self.physics.current_ph}")
        logger.info("")

        # Run main loop
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

    # ── MQTT Setup ────────────────────────────────────────────────────

    def _setup_mqtt(self):
        """Setup MQTT client and subscribe to actuator/downlink."""
        import random, string
        suffix = ''.join(random.choices(string.ascii_lowercase, k=4))
        client_id = f"helioponic_sim_{suffix}"

        self._mqtt_client = mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)
        self._mqtt_client.on_connect = self._on_mqtt_connect
        self._mqtt_client.on_message = self._on_mqtt_message
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

            if pump in ("pompa1", "circ"):
                self.manual_override_p1 = int(state)
                self.override_time = time.time()
                logger.info(f"⚡ MANUAL OVERRIDE: pompa1 → {'ON' if state else 'OFF'}")
            elif pump in ("pompa2", "ph_d"):
                self.manual_override_p2 = int(state)
                self.override_time = time.time()
                logger.info(f"⚡ MANUAL OVERRIDE: pompa2 → {'ON' if state else 'OFF'}")
        except Exception as e:
            logger.warning(f"Failed to parse actuator command: {e}")

    # ── REST Auth ────────────────────────────────────────────────────

    async def _register(self):
        """Register test user + device."""
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
            if r.status_code in (201, 409):
                logger.info(f"User registered (HTTP {r.status_code})")
        except Exception as e:
            logger.warning(f"Register failed: {e}")

    async def _login(self):
        """Login and get JWT token."""
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
                logger.info(f"Logged in as {TEST_USER_EMAIL}")
            else:
                logger.warning(f"Login failed (HTTP {r.status_code}) — try --register")
        except Exception as e:
            logger.warning(f"Login failed: {e}")

    # ── Fetch Device Config from Backend ────────────────────────────

    async def _fetch_device_config(self):
        """Fetch device thresholds from backend API (sync dengan AutomationScreen).

        Memanggil GET /api/v1/devices/config?device_id=... untuk mendapatkan
        threshold yang sudah di-set user di AutomationScreen mobile app.
        Jika gagal (backend down / belum login), pakai default yang sudah ada.
        """
        if not self._http or not self.token:
            logger.info("No HTTP client or token — using default thresholds")
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
                cfg = {
                    "jarak_on": data.get("jarak_on", self.hysteresis.jarak_on),
                    "jarak_off": data.get("jarak_off", self.hysteresis.jarak_off),
                    "tds_on": data.get("tds_on", self.hysteresis.tds_on),
                    "tds_off": data.get("tds_off", self.hysteresis.tds_off),
                    "ph_min": data.get("ph_min", self.hysteresis.ph_min),
                    "ph_max": data.get("ph_max", self.hysteresis.ph_max),
                    "rule_ph": data.get("rule_ph", self.hysteresis.rule_ph),
                    "rule_tds": data.get("rule_tds", self.hysteresis.rule_tds),
                    "rule_water": data.get("rule_water", self.hysteresis.rule_water),
                    "auto_enabled": data.get("auto_enabled", self.hysteresis.auto_enabled),
                }
                self.hysteresis = HysteresisController(cfg)
                logger.info(f"✅ Thresholds synced from backend: "
                            f"jarak_on={cfg['jarak_on']}, jarak_off={cfg['jarak_off']}, "
                            f"ph_min={cfg['ph_min']}, ph_max={cfg['ph_max']}")
            else:
                logger.warning(f"Failed to fetch device config (HTTP {r.status_code}) — using defaults")
        except Exception as e:
            logger.warning(f"Failed to fetch device config: {e} — using defaults")

    # ── Main Simulation Loop ─────────────────────────────────────────

    async def _run_loop(self):
        """Main 1-second tick loop."""
        tick = 0
        while self.running:
            tick += 1
            dt = 1.0  # 1-second tick

            # 1. Check manual override expiry (30 seconds)
            if self.manual_override_p1 is not None:
                if time.time() - self.override_time > 30:
                    self.manual_override_p1 = None
                    self.manual_override_p2 = None
                    logger.debug("Manual override expired (30s)")

            # 2. Read current sensor values
            readings = self.physics.get_readings()

            # 3. Determine desired pump states via hysteresis engine
            #    (only if not under manual override)
            desired_p1 = self.pompa1
            desired_p2 = self.pompa2

            if self.manual_override_p1 is None and self.manual_override_p2 is None:
                desired_p1, desired_p2 = self.hysteresis.evaluate(
                    readings["jarak_cm"],
                    readings["tds_value"],
                    readings["current_ph"],
                    self.pompa1,
                    self.pompa2,
                )
            else:
                # Manual override active
                desired_p1 = self.manual_override_p1 if self.manual_override_p1 is not None else self.pompa1
                desired_p2 = self.manual_override_p2 if self.manual_override_p2 is not None else self.pompa2

            # 4. Apply state transitions
            p1_changed = desired_p1 != self.pompa1
            p2_changed = desired_p2 != self.pompa2
            self.pompa1 = desired_p1
            self.pompa2 = desired_p2

            if p1_changed or p2_changed:
                changes = []
                if p1_changed: changes.append(f"P1={'ON' if self.pompa1 else 'OFF'}")
                if p2_changed: changes.append(f"P2={'ON' if self.pompa2 else 'OFF'}")
                logger.info(f"⚡ State change: {', '.join(changes)}")

            # 5. Advance physics based on current pump states
            self.physics.tick(self.pompa1, self.pompa2, dt)
            readings = self.physics.get_readings()

            # 6. Compute water level %
            water_pct = ((TANK_DEPTH_CM - min(readings["jarak_cm"], TANK_DEPTH_CM)) / TANK_DEPTH_CM) * 100

            # 7. Publish via MQTT (with pompa1 + pompa2 — ALWAYS required)
            self._publish_mqtt(readings)

            # 8. Publish via REST fallback
            await self._publish_rest(readings)

            # 9. Log status
            p1_label = "ON " if self.pompa1 else "OFF"
            p2_label = "ON " if self.pompa2 else "OFF"
            override = ""
            if self.manual_override_p1 is not None or self.manual_override_p2 is not None:
                override = " [MANUAL]"
            print(f"  [{tick:4d}] jarak={readings['jarak_cm']:5.1f}cm "
                  f"tds={readings['tds_value']:6.0f}ppm "
                  f"pH={readings['current_ph']:.1f} "
                  f"water={water_pct:5.1f}% "
                  f"P1={p1_label} P2={p2_label}{override}")

            await asyncio.sleep(dt)

    # ── Publish Methods ──────────────────────────────────────────────

    def _publish_mqtt(self, readings: dict):
        """Publish sensor + pump states via MQTT."""
        if not self._mqtt_client:
            return

        payload = {
            "device_id": self.device_id,
            "ts": int(time.time()),
            "jarak_cm": readings["jarak_cm"],
            "tds_value": readings["tds_value"],
            "current_ph": readings["current_ph"],
            "pompa1": self.pompa1,
            "pompa2": self.pompa2,
        }
        self._mqtt_client.publish(TOPIC_UPLINK, json.dumps(payload), qos=0)

    async def _publish_rest(self, readings: dict):
        """Publish sensor + pump states via REST (fallback)."""
        if not self._http or not self.token:
            return

        payload = {
            "device_id": self.device_id,
            "ts": int(time.time()),
            "jarak_cm": readings["jarak_cm"],
            "tds_value": readings["tds_value"],
            "current_ph": readings["current_ph"],
            "pompa1": self.pompa1,
            "pompa2": self.pompa2,
        }
        try:
            await self._http.post(
                f"{self.api_base}/sensors/reading",
                json=payload,
                timeout=3,
            )
        except Exception:
            pass  # REST is fallback, MQTT is primary


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
        description="Helioponic Reactive Physics-Based Simulator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--device", default=DEVICE_ID_DEFAULT,
                        help=f"Device ID (default: {DEVICE_ID_DEFAULT})")
    parser.add_argument("--api", default="http://localhost:8000/api/v1",
                        help="Backend API base URL")
    parser.add_argument("--register", action="store_true",
                        help="Register test user + device first")
    parser.add_argument("--thresholds", nargs="*", default=[],
                        help="Custom thresholds: jarak_on=5.0 jarak_off=2.0 "
                             "ph_min=5.5 ph_max=6.5 tds_on=95.0 tds_off=105.0")
    args = parser.parse_args()

    thresholds = parse_thresholds(args.thresholds)

    sim = Simulator(
        device_id=args.device,
        api_base=args.api,
        thresholds=thresholds,
        register_first=args.register,
    )

    # Handle Ctrl+C gracefully
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: asyncio.create_task(sim.stop()))
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass

    print()
    print("=" * 65)
    print("  HELIOPONIC HARDWARE SIMULATOR v4.0")
    print("  Reactive Physics-Based Emulation")
    print("=" * 65)
    print(f"  Device:   {args.device}")
    print(f"  API:      {args.api}")
    print(f"  MQTT:     {MQTT_BROKER}:{MQTT_PORT}")
    print(f"  Topics:   ↑ {TOPIC_UPLINK}")
    print(f"            ↓ {TOPIC_DOWNLINK}")
    print(f"  Tick:     1 second")
    print(f"  Physics:  Water refill ({JARAK_REFILL_RATE}cm/s), "
          f"pH DOWN ({PH_DOWN_RATE}/s)")
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
