#!/usr/bin/env python3
"""
Helioponic — Data Flow Diagnostic Script
=========================================
Checks the complete data pipeline ESP32 -> MQTT -> Backend -> MongoDB -> API.

Usage:
  python tools/diagnose_data_flow.py
"""

import json
import urllib.request
import sys

BASE = "http://localhost:8000/api/v1"
PASS = 0
FAIL = 0

def ok(msg):
    global PASS; PASS += 1
    print(f"  [PASS] {msg}")

def f(msg):
    global FAIL; FAIL += 1
    print(f"  [FAIL] {msg}")

def info(msg):
    print(f"   INFO: {msg}")

def api(method, path, data=None, headers=None):
    h = headers or {}
    body = json.dumps(data).encode() if data else None
    if body:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()
            return json.loads(body), e.code
        except:
            return {"detail": body}, e.code
    except Exception as e:
        return {"detail": str(e)}, 0

print("=" * 65)
print("  HELIOPONIC DATA FLOW DIAGNOSTIC")
print("=" * 65)

# Step 1: Health check
print("\n[1] Backend health check...")
res, code = api("GET", "/health")
if code == 200:
    ok(f"Backend healthy: {res.get('status')}")
else:
    f(f"Backend not reachable: HTTP {code}")
    sys.exit(1)

# Step 2: Login
print("\n[2] Login with debug account...")
res, code = api("POST", "/auth/login", data={"email": "debug@test.com", "password": "debug123456"})
if code == 200:
    token = res["token"]
    ok(f"Logged in as: debug@test.com")
else:
    f(f"Login failed: {res}, trying sim@helioponic.io...")
    res, code = api("POST", "/auth/login", data={"email": "sim@helioponic.io", "password": "sim123"})
    if code == 200:
        token = res["token"]
        ok(f"Logged in as: sim@helioponic.io")
    else:
        f(f"Login also failed. Register first: python tools/simulate.sh --register")
        sys.exit(1)

headers = {"Authorization": f"Bearer {token}"}

# Step 3: List user's registered devices
print("\n[3] Registered devices in your account...")
res, code = api("GET", "/devices", headers=headers)
if code == 200:
    devices = res.get("devices", [])
    ok(f"Found {len(devices)} device(s) in your account:")
    for d in devices:
        print(f"       - {d['device_id']} ({d.get('name', 'unnamed')}) [active={d.get('is_active')}]")
    account_device_ids = [d["device_id"] for d in devices]
else:
    f(f"Failed to list devices: HTTP {code}")
    account_device_ids = []

# Step 4: Check if HELIO_001 is in the user's account
print("\n[4] ESP32 device_id check...")
esp_device_id = "HELIO_001"
esp_in_account = esp_device_id in account_device_ids
if esp_in_account:
    ok(f"HELIO_001 IS registered to your account")
else:
    f(f"HELIO_001 is NOT registered to your account!")
    info(f"Your account has: {account_device_ids or '(none)'}")
    info("The ESP32 publishes as 'HELIO_001' but your account has different device(s).")
    info("This is why the mobile app shows no data — device_id mismatch!")
    print()
    print("  >>> FIX: Either:")
    print(f"       1. Add HELIO_001 from the mobile app (Profile -> Add Device)")
    print(f"       2. Or run: python tools/diagnose_data_flow.py --fix")
    print()

# Step 5: Check if data exists in DB for HELIO_001
print("\n[5] Sensor data check for HELIO_001...")
try:
    res, code = api("GET", f"/sensors/latest?device_id=HELIO_001", headers=headers)
    if code == 200 and "jarak_cm" in res:
        ok(f"Data EXISTS for HELIO_001: jarak={res.get('jarak_cm')}cm, tds={res.get('tds_value')}ppm, ph={res.get('current_ph')}")
        print(f"       pompa1={res.get('pompa1')}, pompa2={res.get('pompa2')}")
        print(f"       recorded_at={res.get('recorded_at', 'N/A')[:19]}")
    elif code == 403:
        info(f"Access denied — HELIO_001 belongs to a different user (or none)")
        # Try with no auth (might not need token for this endpoint...)
    else:
        info(f"No sensor data for HELIO_001 yet: {res.get('message', res)}")
except Exception as e:
    info(f"Could not check: {e}")

# Step 6: Check if data exists for account's devices
print("\n[6] Sensor data check for YOUR registered devices...")
for did in account_device_ids:
    try:
        res, code = api("GET", f"/sensors/latest?device_id={did}", headers=headers)
        if code == 200 and "jarak_cm" in res:
            ok(f"Data exists for {did}: jarak={res.get('jarak_cm')}cm, ph={res.get('current_ph')}")
        else:
            info(f"No data for {did}: {res.get('message', 'HTTP '+str(code))}")
    except Exception as e:
        info(f"{did}: error - {e}")

# Step 7: Check MQTT data flow via water summary
print("\n[7] Water summary check for HELIO_001...")
try:
    res, code = api("GET", f"/water/summary?device_id=HELIO_001", headers=headers)
    if code == 200:
        ok(f"Water summary: {res.get('water_level_pct', 0):.1f}% (jarak_cm={res.get('jarak_cm')})")
    else:
        info(f"Water summary unavailable: {res}")
except Exception as e:
    info(f"Error: {e}")

# Step 8: Fix option — add HELIO_001 to user's account
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--fix", action="store_true", help="Add HELIO_001 to your account")
args, _ = parser.parse_known_args()

if args.fix and not esp_in_account:
    print("\n[FIX] Adding HELIO_001 to your account...")
    res, code = api("POST", "/devices", headers=headers, data={
        "device_id": "HELIO_001",
        "name": "ESP32 Hydroponic System"
    })
    if code == 200 or code == 201:
        ok(f"HELIO_001 added to your account!")
        # Re-check sensor data
        res2, code2 = api("GET", "/sensors/latest?device_id=HELIO_001", headers=headers)
        if code2 == 200 and "jarak_cm" in res2:
            ok(f"Now receiving data: jarak={res2.get('jarak_cm')}cm, ph={res2.get('current_ph')}")
        else:
            info(f"Device added but no data visible yet (may need WebSocket reconnect)")
        print()
        print("  >>> NEXT: Reload the mobile app — data should now appear!")
    else:
        f(f"Failed to add device: {res}")

# Summary
print("\n" + "=" * 65)
print(f"  DIAGNOSTIC COMPLETE: {PASS} passed, {FAIL} failed")
print("=" * 65)

if not esp_in_account and not args.fix:
    print("\n  ACTION REQUIRED: ESP32 publishes as 'HELIO_001' but it's not")
    print("  registered to your account. Run with --fix to auto-add it:")
    print("    python tools/diagnose_data_flow.py --fix")
    print()
    print("  OR: Add it manually from the mobile app:")
    print("    Profile -> Add Device -> enter 'HELIO_001'")

sys.exit(0 if FAIL == 0 else 1)
