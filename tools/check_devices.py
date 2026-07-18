"""Quick check: all devices in MongoDB."""
from pymongo import MongoClient

c = MongoClient("mongodb://localhost:27018/helioponic")
db = c.get_default_database()

print(f"=== MongoDB: {db.name} ===")
print(f"Total devices: {db.devices.count_documents({})}")

print()
print("--- Users ---")
for u in db.users.find({}):
    print(f"  {u['email']:<30s} _id={str(u['_id'])}")

print()
print("--- Devices ---")
for d in db.devices.find({}):
    uid = d.get("user_id", "N/A")
    uid_type = type(uid).__name__
    # Try to find owner by string match (user_id stored as string)
    owner = None
    if uid and uid != "N/A":
        for u in db.users.find({}):
            if str(u["_id"]) == str(uid):
                owner = u
                break
    email = owner["email"] if owner else "N/A"
    cnt = db.sensor_logs.count_documents({"device_id": d["device_id"]})
    water_cnt = db.water_records.count_documents({"device_id": d["device_id"]})
    energy_cnt = db.energy_records.count_documents({"device_id": d["device_id"]})
    print(f"  {d['device_id']:<20s} user={email:<25s} sensor_logs={cnt:<6d} water={water_cnt:<4d} energy={energy_cnt:<4d}")

# Per-day breakdown for HELIO_SIM_001
print()
print("--- Per-day sensor_logs for HELIO_SIM_001 ---")
from datetime import datetime, timezone
UTC = timezone.utc
first = db.sensor_logs.find_one({"device_id": "HELIO_SIM_001"}, sort=[("recorded_at", 1)])
last = db.sensor_logs.find_one({"device_id": "HELIO_SIM_001"}, sort=[("recorded_at", -1)])
if first:
    print(f"  First: {first['recorded_at']}")
if last:
    print(f"  Last:  {last['recorded_at']}")
total_daily = 0
for day in range(1, 18):
    d_start = datetime(2026, 7, day, 0, 0, 0, tzinfo=UTC)
    d_end = datetime(2026, 7, day, 23, 59, 59, tzinfo=UTC)
    dc = db.sensor_logs.count_documents({
        "device_id": "HELIO_SIM_001",
        "recorded_at": {"$gte": d_start, "$lte": d_end},
    })
    total_daily += dc
    bar = "#" * (dc // 10) if dc > 0 else ""
    print(f"  Jul {day:02d}: {dc:>5d} {bar}")
print(f"  Total (daily sum): {total_daily}")
print(f"  Total (countDocuments): {db.sensor_logs.count_documents({'device_id': 'HELIO_SIM_001'})}")

print()
print("--- Indexes on sensor_logs ---")
for idx in db.sensor_logs.list_indexes():
    ttl = idx.get("expireAfterSeconds", None)
    print(f"  {idx['name']:<30s} keys={idx['key']}  TTL={ttl}")

c.close()
