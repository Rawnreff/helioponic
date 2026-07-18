"""Seed sensor data for July 1-16, 2026 at ~2-minute intervals (~11520 records).

Uses realistic sensor values with natural diurnal variation
and posts via REST /sensors/reading endpoint.
"""
import json, urllib.request, sys, math, random, time
from datetime import datetime, timedelta, UTC

BASE = "http://localhost:8000/api/v1"
DEVICE_ID = "HELIO_DBG"  # already registered to debug@test.com
INTERVAL_MINUTES = 2  # 2-minute spacing = production throttle rate

# ── API helper ────────────────────────────────────────

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
        return json.loads(e.read()), e.code
    except Exception as e:
        return {"error": str(e)}, 0

# ── Step 1: Login ─────────────────────────────────────

print("[1] Logging in...")
res, code = api("POST", "/auth/login",
    data={"email": "debug@test.com", "password": "debug123456"})
if code != 200:
    print(f"  FAILED: {res}")
    sys.exit(1)
headers = {"Authorization": f"Bearer {res['token']}"}
print(f"  OK — logged in as {res['user']['email']}")

# ── Step 2: Ensure HELIO_SIM_001 is registered ────────

print(f"\n[2] Checking if {DEVICE_ID} is registered...")
res, code = api("GET", "/devices", headers=headers)
existing = [d["device_id"] for d in res.get("devices", [])]
print(f"  Existing devices: {existing}")

if DEVICE_ID not in existing:
    print(f"  Adding {DEVICE_ID}...")
    res, code = api("POST", "/devices", headers=headers,
        data={"device_id": DEVICE_ID, "name": "Helio SIM"})
    if code == 200:
        print(f"  OK — added")
    else:
        print(f"  FAILED: {res}")
        sys.exit(1)
else:
    print(f"  Already registered")

# ── Step 3: Seed data ─────────────────────────────────

print(f"\n[3] Seeding sensor data for {DEVICE_ID}...")
print(f"    Date range: 2026-07-01 00:00 -> 2026-07-16 23:58")
print(f"    Interval: {INTERVAL_MINUTES} minutes")

BASE_PH = 6.2
BASE_TDS = 280.0
BASE_JARAK = 3.5

random.seed(42)
start = datetime(2026, 7, 1, 0, 0, 0, tzinfo=UTC)
end   = datetime(2026, 7, 16, 23, 59, 0, tzinfo=UTC)

current = start
batch = []
batch_size = 50
total = 0
errors = 0
t0 = time.time()

while current <= end:
    # Diurnal variation: pH drops slightly during day, TDS rises slightly
    hour_of_day = current.hour
    hour_phase = math.sin((hour_of_day - 6) * math.pi / 12)  # peak at noon

    ph = BASE_PH + hour_phase * 0.3 + random.uniform(-0.2, 0.2)
    ph = round(max(4.0, min(8.0, ph)), 2)

    tds = BASE_TDS + hour_phase * 40 + random.uniform(-20, 20)
    tds = round(max(100, min(500, tds)), 0)

    # Water level slowly drops over 16 days, with daily top-ups
    day_progress = (current - start).total_seconds() / (16 * 86400)
    jarak_raw = BASE_JARAK + day_progress * 2.5 + hour_phase * 0.3 + random.uniform(-0.3, 0.3)
    jarak = round(max(0.5, min(6.5, jarak_raw)), 1)

    # Pump states: bang-bang hysteresis
    pompa1 = 1 if jarak > 5 else 0
    pompa2 = 1 if tds < 95 else 0
    pompa3 = 0
    pompa4 = 0

    batch.append({
        "device_id": DEVICE_ID,
        "ts": int(current.timestamp()),
        "jarak_cm": jarak,
        "tds_value": tds,
        "current_ph": ph,
        "pompa1": pompa1,
        "pompa2": pompa2,
        "pompa3": pompa3,
        "pompa4": pompa4,
    })

    if len(batch) >= batch_size:
        for record in batch:
            res, code = api("POST", "/sensors/reading", headers=headers, data=record)
            if code == 200:
                total += 1
            else:
                errors += 1
        batch = []
        elapsed = time.time() - t0
        rate = total / elapsed if elapsed > 0 else 0
        print(f"\r    Seeded: {total:>6d} records  |  errors: {errors}  |  "
              f"now: {current.strftime('%b %d %H:%M')}  |  "
              f"{rate:.0f} rec/s", end="")

    current += timedelta(minutes=INTERVAL_MINUTES)

# Flush remaining
for record in batch:
    res, code = api("POST", "/sensors/reading", headers=headers, data=record)
    if code == 200:
        total += 1
    else:
        errors += 1

elapsed = time.time() - t0
print(f"\r    Seeded: {total:>6d} records  |  errors: {errors}  |  "
      f"{total/elapsed:.0f} rec/s")
print(f"\n    Done in {elapsed:.1f}s")

# ── Step 4: Verify ────────────────────────────────────

print(f"\n[4] Verifying data...")
res, code = api("GET", f"/sensors/history?device_id={DEVICE_ID}"
    f"&from_date=2026-07-01T00:00:00Z"
    f"&to_date=2026-07-16T23:59:59Z"
    f"&limit=3",
    headers=headers)
if code == 200:
    records = res.get("data", [])
    count = res.get("count", 0)
    print(f"    Jul 1-16: {count} records")
    if records:
        first = records[-1].get("recorded_at", "N/A")
        last  = records[0].get("recorded_at", "N/A")
        print(f"    First: {str(first)[:19]}")
        print(f"    Last:  {str(last)[:19]}")
else:
    print(f"    FAILED: {res}")

# Per-day breakdown
print(f"\n    Per-day summary:")
for day in range(1, 17):
    d = f"2026-07-{day:02d}"
    res, code = api("GET",
        f"/sensors/history?device_id={DEVICE_ID}"
        f"&from_date={d}T00:00:00Z"
        f"&to_date={d}T23:59:59Z"
        f"&limit=1",
        headers=headers)
    cnt = res.get("count", 0) if code == 200 else "ERR"
    print(f"    {d}: {str(cnt):>5s} records")

print(f"\n{'='*50}")
print(f"SEEDING COMPLETE — {total} records seeded, {errors} errors")
print(f"{'='*50}")
