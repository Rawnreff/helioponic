"""Seed sensor data for July 1-16 directly into MongoDB (bypasses REST).

REST endpoint stamps recorded_at with server receive time (now),
ignoring the ts field — so historical seeding MUST go direct to DB.
"""
import math, random, sys, time
from datetime import datetime, timedelta, UTC
from pymongo import MongoClient

DEVICE_ID = "HELIO_SIM_001"
MONGO_URI = "mongodb://localhost:27018/helioponic"
INTERVAL_MINUTES = 2  # 2-minute spacing

print(f"[1] Connecting to MongoDB...")
client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = client.get_default_database()
# Verify connection
client.admin.command("ping")
print(f"    OK — connected")

# Clear existing data
print(f"\n[2] Clearing sensor_logs for {DEVICE_ID}...")
result = db.sensor_logs.delete_many({"device_id": DEVICE_ID})
print(f"    Deleted {result.deleted_count} records")

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
batch_size = 500
total = 0
t0 = time.time()

while current <= end:
    hour_of_day = current.hour
    hour_phase = math.sin((hour_of_day - 6) * math.pi / 12)

    ph = round(max(4.0, min(8.0, BASE_PH + hour_phase * 0.3 + random.uniform(-0.2, 0.2))), 2)
    tds = round(max(100, min(500, BASE_TDS + hour_phase * 40 + random.uniform(-20, 20))), 0)

    day_progress = (current - start).total_seconds() / (16 * 86400)
    jarak_raw = BASE_JARAK + day_progress * 2.5 + hour_phase * 0.3 + random.uniform(-0.3, 0.3)
    jarak = round(max(0.5, min(6.5, jarak_raw)), 1)

    pompa1 = 1 if jarak > 5 else 0
    pompa2 = 1 if tds < 95 else 0

    batch.append({
        "device_id": DEVICE_ID,
        "ts": int(current.timestamp()),
        "recorded_at": current,
        "jarak_cm": jarak,
        "tds_value": tds,
        "current_ph": ph,
        "pompa1": pompa1,
        "pompa2": pompa2,
        "pompa3": 0,
        "pompa4": 0,
    })

    if len(batch) >= batch_size:
        db.sensor_logs.insert_many(batch)
        total += len(batch)
        elapsed = time.time() - t0
        rate = total / elapsed if elapsed > 0 else 0
        print(f"\r    Seeded: {total:>6d} records  |  now: {current.strftime('%b %d %H:%M')}  |  "
              f"{rate:.0f} rec/s", end="")
        batch = []

    current += timedelta(minutes=INTERVAL_MINUTES)

# Flush remaining
if batch:
    db.sensor_logs.insert_many(batch)
    total += len(batch)

elapsed = time.time() - t0
print(f"\r    Seeded: {total:>6d} records  |  "
      f"{total/elapsed:.0f} rec/s")
print(f"    Done in {elapsed:.1f}s")

# ── Verify ────────────────────────────────────────────

print(f"\n[4] Verifying...")
from_dt = datetime(2026, 7, 1, 0, 0, 0, tzinfo=UTC)
to_dt   = datetime(2026, 7, 16, 23, 59, 59, tzinfo=UTC)

count = db.sensor_logs.count_documents({
    "device_id": DEVICE_ID,
    "recorded_at": {"$gte": from_dt, "$lte": to_dt},
})
print(f"    Jul 1-16 range: {count} records")

first = db.sensor_logs.find_one({"device_id": DEVICE_ID}, sort=[("recorded_at", 1)])
last  = db.sensor_logs.find_one({"device_id": DEVICE_ID}, sort=[("recorded_at", -1)])
if first and last:
    print(f"    First: {first['recorded_at']}")
    print(f"    Last:  {last['recorded_at']}")

print(f"\n    Per-day summary:")
for day in range(1, 17):
    d_start = datetime(2026, 7, day, 0, 0, 0, tzinfo=UTC)
    d_end   = datetime(2026, 7, day, 23, 59, 59, tzinfo=UTC)
    cnt = db.sensor_logs.count_documents({
        "device_id": DEVICE_ID,
        "recorded_at": {"$gte": d_start, "$lte": d_end},
    })
    print(f"    2026-07-{day:02d}: {cnt:>5d} records")

print(f"\n{'='*50}")
print(f"SEEDING COMPLETE — {total} records in MongoDB")
print(f"{'='*50}")

client.close()
