"""Reset MongoDB: delete HELIO_001, clear HELIO_SIM_001 data, re-seed July 1-17."""
import math, random, time
from datetime import datetime, timedelta, timezone

UTC = timezone.utc
from pymongo import MongoClient

DEVICE_ID = "HELIO_SIM_001"
MONGO_URI = "mongodb://localhost:27018/helioponic"
INTERVAL_MINUTES = 2

print("=" * 60)
print("  HELIOPONIC — Reset & Re-Seed")
print("=" * 60)

client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = client.get_default_database()
client.admin.command("ping")
print("MongoDB connected\n")

# ── STEP 1: Show current state ─────────────────────
print("[1] CURRENT STATE")
print(f"    Devices: {db.devices.count_documents({})}")
for d in db.devices.find({}):
    owner = None
    uid = d.get("user_id")
    if uid:
        for u in db.users.find({}):
            if str(u["_id"]) == str(uid):
                owner = u
                break
    email = owner["email"] if owner else "N/A"
    sl = db.sensor_logs.count_documents({"device_id": d["device_id"]})
    wr = db.water_records.count_documents({"device_id": d["device_id"]})
    print(f"    {d['device_id']:<15s} -> {email:<25s}  sensor_logs={sl:<5d}  water={wr:<4d}")

# ── STEP 2: Delete HELIO_001 ───────────────────────
print("\n[2] DELETE HELIO_001")
r = db.devices.delete_one({"device_id": "HELIO_001"})
print(f"    Deleted: {r.deleted_count} device(s)")

# ── STEP 3: Drop energy_records collection ─────────
print("\n[3] DROP energy_records")
if "energy_records" in db.list_collection_names():
    db.energy_records.drop()
    print("    Collection dropped")
else:
    print("    Already gone (no collection)")

# ── STEP 4: Clear HELIO_SIM_001 data ───────────────
print(f"\n[4] CLEAR {DEVICE_ID} data")
sl = db.sensor_logs.delete_many({"device_id": DEVICE_ID})
wr = db.water_records.delete_many({"device_id": DEVICE_ID})
print(f"    sensor_logs: {sl.deleted_count} deleted")
print(f"    water_records: {wr.deleted_count} deleted")

# ── STEP 5: Re-seed sensor_logs ────────────────────
print(f"\n[5] SEED sensor_logs for {DEVICE_ID}")
print(f"    Range: 2026-07-01 00:00 -> 2026-07-17 23:58")
print(f"    Interval: {INTERVAL_MINUTES} min")

BASE_PH = 6.2
BASE_TDS = 280.0
BASE_JARAK = 3.5

random.seed(42)
start = datetime(2026, 7, 1, 0, 0, 0, tzinfo=UTC)
end = datetime(2026, 7, 17, 23, 59, 0, tzinfo=UTC)

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

    day_progress = (current - start).total_seconds() / (17 * 86400)
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
        print(f"\r    Seeded: {total:>6d}  |  now: {current.strftime('%b %d %H:%M')}  |  {rate:.0f} rec/s", end="")
        batch = []

    current += timedelta(minutes=INTERVAL_MINUTES)

if batch:
    db.sensor_logs.insert_many(batch)
    total += len(batch)

elapsed = time.time() - t0
print(f"\r    Seeded: {total:>6d} records  |  {total / elapsed:.0f} rec/s")
print(f"    Done in {elapsed:.1f}s")

# ── STEP 6: Verify ─────────────────────────────────
print(f"\n[6] VERIFY")
cnt = db.sensor_logs.count_documents({"device_id": DEVICE_ID})
print(f"    HELIO_SIM_001 sensor_logs: {cnt}")

first = db.sensor_logs.find_one({"device_id": DEVICE_ID}, sort=[("recorded_at", 1)])
last = db.sensor_logs.find_one({"device_id": DEVICE_ID}, sort=[("recorded_at", -1)])
if first and last:
    print(f"    First: {first['recorded_at']}")
    print(f"    Last:  {last['recorded_at']}")

print(f"\n    Per-day:")
for day in range(1, 18):
    d_start = datetime(2026, 7, day, 0, 0, 0, tzinfo=UTC)
    d_end = datetime(2026, 7, day, 23, 59, 59, tzinfo=UTC)
    dc = db.sensor_logs.count_documents({
        "device_id": DEVICE_ID,
        "recorded_at": {"$gte": d_start, "$lte": d_end},
    })
    print(f"    07-{day:02d}: {dc:>5d}")

# ── STEP 7: Final state ────────────────────────────
print(f"\n[7] FINAL STATE")
print(f"    Devices: {db.devices.count_documents({})}")
for d in db.devices.find({}):
    owner = None
    uid = d.get("user_id")
    if uid:
        for u in db.users.find({}):
            if str(u["_id"]) == str(uid):
                owner = u
                break
    email = owner["email"] if owner else "N/A"
    sl = db.sensor_logs.count_documents({"device_id": d["device_id"]})
    wr = db.water_records.count_documents({"device_id": d["device_id"]})
    print(f"    {d['device_id']:<15s} -> {email:<25s}  sensor_logs={sl:<5d}  water={wr:<4d}")

collections = db.list_collection_names()
print(f"\n    Collections ({len(collections)}): {', '.join(sorted(collections))}")

print(f"\n{'=' * 60}")
print(f"  DONE — {total} records seeded to {DEVICE_ID}")
print(f"{'=' * 60}")

client.close()

