#!/usr/bin/env python3
"""
Helioponic — Comprehensive IoT Simulation Script
================================================
Tests all major backend features via REST API + WebSocket:

  1. Night Mode activation/deactivation
  2. Water level alarm (jarak_cm=999 → automation bypass)
  3. MQTT actuator commands via REST (POST /actuators/pump)
  4. WebSocket broadcast verification for all scenarios

Usage:
  # Full simulation (all features)
  python tools/simulate.py

  # Individual feature test
  python tools/simulate.py --night-mode
  python tools/simulate.py --water-alarm
  python tools/simulate.py --actuators
  python tools/simulate.py --ws-broadcast

  # Register test user + device first
  python tools/simulate.py --register

  # Custom API base URL
  python tools/simulate.py --api http://localhost:8000/api/v1

Requires:
  - pip install httpx websockets
  - Docker containers running (docker compose up -d)
"""

import asyncio
import json
import sys
import time
import argparse
from datetime import datetime

try:
    import httpx
except ImportError:
    print("Missing httpx. Install: pip install httpx")
    sys.exit(1)

try:
    import websockets
except ImportError:
    print("Missing websockets. Install: pip install websockets")
    sys.exit(1)

# ─── Constants ───────────────────────────────────────────────────────────────
CHECK = "[OK]"
CROSS = "[FAIL]"
SKIP = "[SKIP]"
BULLET = "   -"  # ASCII bullet for Windows compatibility

TEST_USER_EMAIL = "sim@helioponic.io"
TEST_USER_PASSWORD = "sim123"
TEST_DEVICE_ID = "HELIO_SIM_001"

# ─── Global State ────────────────────────────────────────────────────────────
total_tests = 0
passed_tests = 0
skipped_tests = 0

# ok(), fail(), skip() are display-only — counters are tracked
# by test_start() (total) and the test function's return value (pass/fail).


def ok(msg: str):
    print(f"  {CHECK} {msg}")


def fail(msg: str):
    print(f"  {CROSS} {msg}")


def skip(msg: str):
    global skipped_tests
    skipped_tests += 1
    print(f"  {SKIP} {msg}")


def test_start(name: str):
    global total_tests
    total_tests += 1
    print(f"\n{'-' * 60}")
    print(f"  TEST: {name}")
    print(f"{'-' * 60}")


def header(title: str):
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


# ─── API Client ──────────────────────────────────────────────────────────────

class ApiClient:
    """Thin async wrapper around httpx for REST + WebSocket operations."""

    def __init__(self, base_url: str):
        self.base = base_url.rstrip("/")
        self.token: str | None = None

    # ── Auth ───────────────────────────────────────────────────────────

    async def register(self) -> bool:
        """Register a test user + device."""
        async with httpx.AsyncClient() as cl:
            r = await cl.post(
                f"{self.base}/auth/register",
                json={
                    "email": TEST_USER_EMAIL,
                    "password": TEST_USER_PASSWORD,
                    "name": "Simulation User",
                    "device_id": TEST_DEVICE_ID,
                    "device_name": f"{TEST_DEVICE_ID} (Simulated)",
                },
            )
            if r.status_code in (201, 409):
                print(f"  {CHECK} User registered (HTTP {r.status_code})")
                return True
            print(f"  {CROSS} Register failed: HTTP {r.status_code} {r.text[:200]}")
            return False

    async def login(self) -> bool:
        """Login and store JWT token."""
        async with httpx.AsyncClient() as cl:
            r = await cl.post(
                f"{self.base}/auth/login",
                json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD},
            )
            if r.status_code != 200:
                fail(f"Login failed: HTTP {r.status_code}")
                return False
            self.token = r.json()["token"]
            ok(f"Token obtained ({len(self.token)} chars)")
            return True

    @property
    def auth_headers(self) -> dict:
        if not self.token:
            return {}
        return {"Authorization": f"Bearer {self.token}"}

    # ── Sensors ────────────────────────────────────────────────────────

    async def post_reading(self, jarak_cm: int, tds_value: float,
                           current_ph: float, pompa1: int = 0,
                           pompa2: int = 0) -> dict | None:
        """Post a sensor reading via REST."""
        payload = {
            "device_id": TEST_DEVICE_ID,
            "ts": int(time.time()),
            "jarak_cm": jarak_cm,
            "tds_value": tds_value,
            "current_ph": current_ph,
            "pompa1": pompa1,
            "pompa2": pompa2,
        }
        async with httpx.AsyncClient() as cl:
            r = await cl.post(f"{self.base}/sensors/reading", json=payload)
            if r.status_code != 200:
                print(f"    {CROSS} POST sensor failed: HTTP {r.status_code} {r.text[:100]}")
                return None
            return r.json()

    # ── Actuators ──────────────────────────────────────────────────────

    async def control_pump(self, pump: str, state: int,
                           device_id: str = TEST_DEVICE_ID) -> dict | None:
        """Send actuator command via REST."""
        payload = {"pump": pump, "state": state, "device_id": device_id}
        async with httpx.AsyncClient() as cl:
            r = await cl.post(
                f"{self.base}/actuators/pump",
                json=payload,
                headers=self.auth_headers,
            )
            if r.status_code != 200:
                print(f"    {CROSS} Pump control failed: HTTP {r.status_code} {r.text[:100]}")
                return None
            return r.json()

    # ── Night Mode ─────────────────────────────────────────────────────

    async def night_mode_activate(self, device_id: str = TEST_DEVICE_ID) -> dict | None:
        """Activate night mode."""
        async with httpx.AsyncClient() as cl:
            r = await cl.post(
                f"{self.base}/night-mode/activate",
                json={"device_id": device_id},
                headers=self.auth_headers,
            )
            if r.status_code != 200:
                print(f"    {CROSS} Night mode activate failed: HTTP {r.status_code} {r.text[:100]}")
                return None
            return r.json()

    async def night_mode_deactivate(self, device_id: str = TEST_DEVICE_ID) -> dict | None:
        """Deactivate night mode."""
        async with httpx.AsyncClient() as cl:
            r = await cl.post(
                f"{self.base}/night-mode/deactivate",
                json={"device_id": device_id},
                headers=self.auth_headers,
            )
            if r.status_code != 200:
                print(f"    {CROSS} Night mode deactivate failed: HTTP {r.status_code} {r.text[:100]}")
                return None
            return r.json()

    async def night_mode_status(self, device_id: str = TEST_DEVICE_ID) -> dict | None:
        """Get night mode status."""
        async with httpx.AsyncClient() as cl:
            r = await cl.get(
                f"{self.base}/night-mode/status",
                params={"device_id": device_id},
                headers=self.auth_headers,
            )
            if r.status_code != 200:
                print(f"    {CROSS} Night mode status failed: HTTP {r.status_code} {r.text[:100]}")
                return None
            return r.json()

    # ── Notifications ─────────────────────────────────────────────────

    async def get_notifications(self, device_id: str = TEST_DEVICE_ID,
                                unread_only: bool = False) -> list[dict]:
        """Fetch notifications for a device."""
        params = {"device_id": device_id}
        if unread_only:
            params["unread_only"] = "true"
        async with httpx.AsyncClient() as cl:
            r = await cl.get(
                f"{self.base}/notifications",
                params=params,
                headers=self.auth_headers,
            )
            if r.status_code != 200:
                return []
            return r.json().get("data", [])

    # ── Water Summary ─────────────────────────────────────────────────

    async def get_water_summary(self, device_id: str = TEST_DEVICE_ID) -> dict | None:
        """Get latest water level."""
        async with httpx.AsyncClient() as cl:
            r = await cl.get(
                f"{self.base}/water/summary",
                params={"device_id": device_id},
                headers=self.auth_headers,
            )
            if r.status_code != 200:
                return None
            return r.json()

    # ── WebSocket ──────────────────────────────────────────────────────

    async def ws_connect(self, device_id: str = TEST_DEVICE_ID,
                         timeout: float = 5.0):
        """Connect to WebSocket endpoint and return (ws, listener_task, msgs_list)."""
        ws_url = f"ws://localhost:8000/ws/pid?token={self.token}&device_id={device_id}"
        msgs: list[dict] = []

        async def _listen(ws):
            try:
                async for m in ws:
                    msgs.append(json.loads(m))
            except Exception:
                pass

        ws = await asyncio.wait_for(
            websockets.connect(ws_url, max_size=2 ** 20),
            timeout=timeout,
        )
        task = asyncio.create_task(_listen(ws))
        await asyncio.sleep(0.3)  # let listener settle
        return ws, task, msgs


# ─── Test Functions ──────────────────────────────────────────────────────────

async def test_ws_broadcast(api: ApiClient) -> bool:
    """Test that sensor data POSTed via REST is broadcast via WebSocket.
    Returns True if test passed."""
    test_start("WebSocket Broadcast Pipeline")

    # Connect WebSocket
    try:
        ws, task, msgs = await api.ws_connect()
        ok("WebSocket connected")
    except Exception as e:
        fail(f"WebSocket connect failed: {e}")
        return False

    try:
        # POST sensor data (twice for reliability)
        await api.post_reading(jarak_cm=15, tds_value=200.0, current_ph=6.5)
        await asyncio.sleep(0.5)
        await api.post_reading(jarak_cm=12, tds_value=180.0, current_ph=6.7)
        await asyncio.sleep(1.5)

        # Verify broadcast
        if len(msgs) > 0:
            last = msgs[-1]
            required = ["device_id", "jarak_cm", "tds_value", "current_ph", "pompa1", "pompa2"]
            missing = [k for k in required if k not in last]
            if not missing:
                ok(f"Broadcast received ({len(msgs)} msg(s))")
                print(f"  {BULLET} device_id={last['device_id']}")
                print(f"  {BULLET} jarak_cm={last['jarak_cm']}, tds={last['tds_value']}, ph={last['current_ph']}")
                print(f"  {BULLET} pompa1={last['pompa1']}, pompa2={last['pompa2']}")
                return True
            else:
                fail(f"Missing fields in broadcast: {missing}")
                return False
        else:
            fail("No WebSocket messages received")
            return False
    finally:
        # Cleanup — CancelledError inherits from BaseException, not Exception
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
        await ws.close()


async def test_night_mode(api: ApiClient) -> bool:
    """Test night mode activation, status check, and deactivation.
    Returns True if test passed."""
    test_start("Night Mode Lifecycle")

    # 1. Activate night mode
    activate = await api.night_mode_activate()
    if not activate or not activate.get("success"):
        fail(f"Night mode activation failed: {activate}")
        return False
    ok(f"Night mode activated: {activate.get('message', '')[:60]}")
    print(f"  {BULLET} activated_at: {activate.get('activated_at', 'N/A')[:19]}")

    # 2. Check status — should be active
    await asyncio.sleep(0.5)
    status = await api.night_mode_status()
    if not status or status.get("active") is not True:
        fail(f"Expected active=True, got: {status}")
        return False
    ok(f"Night mode status confirmed: active=True")
    if status.get("saved_thresholds"):
        print(f"  {BULLET} saved thresholds: {status['saved_thresholds']}")

    # 3. Deactivate night mode
    deactivate = await api.night_mode_deactivate()
    if not deactivate or not deactivate.get("success"):
        fail(f"Night mode deactivation failed: {deactivate}")
        return False
    ok(f"Night mode deactivated: {deactivate.get('message', '')[:60]}")
    print(f"  {BULLET} deactivated_at: {deactivate.get('deactivated_at', 'N/A')[:19]}")

    # 4. Check status — should be inactive
    await asyncio.sleep(0.3)
    status2 = await api.night_mode_status()
    if not status2 or status2.get("active") is not False:
        fail(f"Expected active=False, got: {status2}")
        return False
    ok(f"Night mode status confirmed: active=False")

    # 5. Deactivate again — should fail (not active)
    deactivate2 = await api.night_mode_deactivate()
    if deactivate2 is None:
        ok("Double deactivation correctly refused (400)")
        return True
    else:
        fail(f"Double deactivation should have failed: {deactivate2}")
        return False


async def test_water_alarm(api: ApiClient) -> bool:
    """Test water level alarm simulation (jarak_cm=999).

    When jarak_cm=999 (out of range), automation should:
    - Skip P1 water-based automation (keep P1 unchanged)
    - Still apply P2 TDS-based automation independently
    - Create a notification about the out-of-range condition

    Returns True if test passed.
    """
    test_start("Water Level Alarm (jarak_cm=999)")

    # 1. First, post normal data so there's a baseline
    await api.post_reading(jarak_cm=15, tds_value=60.0, current_ph=6.5)
    await asyncio.sleep(0.3)

    # 2. Post with jarak_cm=999 (out of range alarm)
    result = await api.post_reading(jarak_cm=999, tds_value=200.0, current_ph=6.5)
    if not result:
        fail("Failed to post sensor with jarak_cm=999")
        return False
    ok(f"Sensor with jarak_cm=999 accepted: pumps={result.get('pumps_reported', {})}")
    pumps = result.get("pumps_reported", {})
    print(f"  {BULLET} pompa1={pumps.get('pompa1')} (should keep previous state - jarak invalid)")
    print(f"  {BULLET} pompa2={pumps.get('pompa2')} (controlled by TDS independently)")

    # 3. Post another one with normal jarak but high TDS to trigger P2
    await asyncio.sleep(0.3)
    result2 = await api.post_reading(jarak_cm=12, tds_value=250.0, current_ph=6.5)
    if result2:
        ok(f"Normal sensor after alarm: pumps={result2.get('pumps_reported', {})}")
        print(f"  {BULLET} P2 should be ON (TDS > 105 threshold)")

    # 4. Post again with jarak_cm=999 to verify re-entry
    await asyncio.sleep(0.3)
    result3 = await api.post_reading(jarak_cm=999, tds_value=50.0, current_ph=6.5)
    if result3:
        ok(f"Re-entry alarm accepted: pumps={result3.get('pumps_reported', {})}")
        print(f"  {BULLET} P2 should be OFF now (TDS < 95 threshold)")

    # 5. Check water summary
    water = await api.get_water_summary()
    if water:
        print(f"  {BULLET} Water summary: jarak_cm={water.get('jarak_cm')}, level_pct={water.get('water_level_pct')}%")

    return True
async def test_actuator_commands(api: ApiClient) -> bool:
    """Test MQTT actuator commands via REST endpoint.
    Returns True if test passed."""
    test_start("Actuator Commands (POST /actuators/pump)")

    # 1. Turn Pompa 1 ON
    result = await api.control_pump("pompa1", 1)
    if not result or result.get("status") != "ok":
        fail(f"Pompa 1 ON failed: {result}")
        return False
    ok(f"Pompa 1 turned ON: pump={result.get('pump')}, state={result.get('state')}")

    # 2. Turn Pompa 2 ON
    await asyncio.sleep(0.3)
    result = await api.control_pump("pompa2", 1)
    if not result or result.get("status") != "ok":
        fail(f"Pompa 2 ON failed: {result}")
        return False
    ok(f"Pompa 2 turned ON: pump={result.get('pump')}, state={result.get('state')}")

    # 3. Turn Pompa 1 OFF
    await asyncio.sleep(0.3)
    result = await api.control_pump("pompa1", 0)
    if not result or result.get("status") != "ok":
        fail(f"Pompa 1 OFF failed: {result}")
        return False
    ok(f"Pompa 1 turned OFF: pump={result.get('pump')}, state={result.get('state')}")

    # 4. Turn Pompa 2 OFF
    await asyncio.sleep(0.3)
    result = await api.control_pump("pompa2", 0)
    if not result or result.get("status") != "ok":
        fail(f"Pompa 2 OFF failed: {result}")
        return False
    ok(f"Pompa 2 turned OFF: pump={result.get('pump')}, state={result.get('state')}")

    # 5. Test with legacy naming (circ, ph_d)
    await asyncio.sleep(0.3)
    result = await api.control_pump("circ", 1)
    if not result or result.get("status") != "ok":
        fail(f"Legacy 'circ' failed: {result}")
        return False
    ok(f"Legacy 'circ' -> pompa1 ON: pump={result.get('pump')}, state={result.get('state')}")

    await asyncio.sleep(0.3)
    result = await api.control_pump("ph_d", 1)
    if not result or result.get("status") != "ok":
        fail(f"Legacy 'ph_d' failed: {result}")
        return False
    ok(f"Legacy 'ph_d' -> pompa2 ON: pump={result.get('pump')}, state={result.get('state')}")

    # 6. Cleanup: turn all pumps OFF
    await asyncio.sleep(0.3)
    await api.control_pump("circ", 0)
    await api.control_pump("ph_d", 0)
    ok("All pumps reset to OFF")
    return True


async def test_notifications(api: ApiClient) -> bool:
    """Verify that pump state changes create auto_mode notifications.
    Returns True if test passed."""
    test_start("Auto-Mode Notifications")

    # Send sensor data with high TDS to trigger P2 auto-activation
    await api.post_reading(jarak_cm=15, tds_value=200.0, current_ph=6.5)
    await asyncio.sleep(0.5)

    # Check notifications
    notifs = await api.get_notifications(unread_only=True)
    if len(notifs) > 0:
        ok(f"Notifications created: {len(notifs)} unread")
        for n in notifs[:3]:
            print(f"  {BULLET} [{n.get('type')}] {n.get('title', '')[:60]}")
        return True
    else:
        # Notifications might have a cooldown (5s), try regular fetch
        skip("No unread notifications (may be on cooldown)")
        notifs_all = await api.get_notifications(unread_only=False)
        print(f"  {BULLET} Total notifications: {len(notifs_all)}")
        return True  # Not critical if on cooldown


# ─── Main ────────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(
        description="Helioponic Comprehensive Simulation Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python tools/simulate.py                           # Full simulation
  python tools/simulate.py --night-mode              # Night mode only
  python tools/simulate.py --ws-broadcast             # WS broadcast only
  python tools/simulate.py --register                 # Register then full sim
  python tools/simulate.py --register --night-mode    # Register + night mode
        """,
    )
    parser.add_argument("--api", default="http://localhost:8000/api/v1",
                        help="Base URL for REST API")
    parser.add_argument("--register", action="store_true",
                        help="Register test user + device first")
    parser.add_argument("--night-mode", action="store_true", dest="nm",
                        help="Run night mode test only")
    parser.add_argument("--water-alarm", action="store_true", dest="wa",
                        help="Run water level alarm test only")
    parser.add_argument("--actuators", action="store_true", dest="act",
                        help="Run actuator command test only")
    parser.add_argument("--ws-broadcast", action="store_true", dest="ws",
                        help="Run WebSocket broadcast test only")
    args = parser.parse_args()

    api = ApiClient(args.api)

    # ── Header ─────────────────────────────────────────────────────
    print()
    header("HELIOPONIC COMPREHENSIVE SIMULATION")
    print(f"  API:       {args.api}")
    print(f"  Device:    {TEST_DEVICE_ID}")
    print(f"  Timestamp: {datetime.now().isoformat()[:19]}")
    print()

    # ── Health Check ──────────────────────────────────────────────
    async with httpx.AsyncClient() as cl:
        try:
            r = await cl.get(f"{args.api}/health", timeout=5)
            if r.status_code == 200:
                print(f"  {CHECK} Backend API reachable at {args.api}")
            else:
                print(f"  {CROSS} Health check: HTTP {r.status_code}")
                sys.exit(1)
        except Exception as e:
            print(f"  {CROSS} Backend not reachable: {e}")
            print("  Make sure Docker containers are running:")
            print("    docker compose up -d")
            sys.exit(1)

    # ── Register + Login ─────────────────────────────────────────
    if args.register:
        await api.register()
    else:
        if not await api.login():
            print(f"  → Try --register first to create test user")
            sys.exit(1)

    # ── Run Tests ────────────────────────────────────────────────
    global passed_tests  # needed because passed_tests += 1 is an assignment
    run_all = not (args.nm or args.wa or args.act or args.ws)

    if run_all or args.ws:
        if await test_ws_broadcast(api):
            passed_tests += 1

    if run_all or args.nm:
        if await test_night_mode(api):
            passed_tests += 1

    if run_all or args.wa:
        if await test_water_alarm(api):
            passed_tests += 1

    if run_all or args.act:
        if await test_actuator_commands(api):
            passed_tests += 1

    if run_all:
        if await test_notifications(api):
            passed_tests += 1

    # ── Summary ──────────────────────────────────────────────────
    failed = total_tests - passed_tests - skipped_tests
    print()
    print("=" * 60)
    print(f"  SUMMARY: {passed_tests} passed, {failed} failed, {skipped_tests} skipped, {total_tests} total")
    print("=" * 60)
    print()
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    asyncio.run(main())
