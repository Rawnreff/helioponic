"""Restore device ownership: HELIO_SIM_001 -> sim@helioponic.io, HELIO_DBG -> debug@test.com."""
from pymongo import MongoClient
from datetime import datetime, timezone

c = MongoClient("mongodb://localhost:27018/helioponic")
db = c.get_default_database()

# ── Current state ─────────────────────────────────────
print("=== CURRENT STATE ===")
print(f"Total devices: {db.devices.count_documents({})}")

# Sensor data counts
for did in ["HELIO_SIM_001", "HELIO_001", "HELIO_DBG"]:
    cnt = db.sensor_logs.count_documents({"device_id": did})
    print(f"  {did}: {cnt} sensor_logs")

print()
for d in db.devices.find({}):
    owner = db.users.find_one({"_id": d["user_id"]}) if d.get("user_id") else None
    print(f"  {d['device_id']} -> {owner['email'] if owner else 'N/A'}")

# ── Find/create sim@helioponic.io ─────────────────────
sim_user = db.users.find_one({"email": "sim@helioponic.io"})
if sim_user:
    sim_uid = str(sim_user["_id"])
    print(f"\nsim@helioponic.io: EXISTS (id={sim_uid})")
else:
    # Create if not exists
    result = db.users.insert_one({
        "email": "sim@helioponic.io",
        "password_hash": "$2b$12$placeholder",  # can't login without proper hash
        "name": "SimUser",
        "created_at": datetime.now(timezone.utc),
    })
    sim_uid = str(result.inserted_id)
    print(f"\nsim@helioponic.io: CREATED (id={sim_uid})")

# ── Find debug@test.com ───────────────────────────────
debug_user = db.users.find_one({"email": "debug@test.com"})
debug_uid = str(debug_user["_id"])
print(f"debug@test.com: EXISTS (id={debug_uid})")

# ── Apply changes ─────────────────────────────────────
print("\n=== APPLYING CHANGES ===")

# 1. Move HELIO_SIM_001 -> sim@helioponic.io
r = db.devices.update_one(
    {"device_id": "HELIO_SIM_001"},
    {"$set": {"user_id": sim_uid}},
)
print(f"[1] HELIO_SIM_001 -> sim@helioponic.io: matched={r.matched_count} modified={r.modified_count}")

# 2. Re-create HELIO_DBG -> debug@test.com (if not exists)
existing_dbg = db.devices.find_one({"device_id": "HELIO_DBG"})
if existing_dbg:
    r = db.devices.update_one(
        {"device_id": "HELIO_DBG"},
        {"$set": {"user_id": debug_uid, "name": "HELIO_DBG"}},
    )
    print(f"[2] HELIO_DBG re-assigned to debug@test.com: modified={r.modified_count}")
else:
    db.devices.insert_one({
        "device_id": "HELIO_DBG",
        "user_id": debug_uid,
        "name": "HELIO_DBG",
        "is_active": True,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    })
    print(f"[2] HELIO_DBG created for debug@test.com")

# 3. HELIO_001: NO TOUCH
print(f"[3] HELIO_001: NO CHANGE")

# ── Verify ────────────────────────────────────────────
print("\n=== FINAL STATE ===")
for d in db.devices.find({}):
    owner = db.users.find_one({"_id": d["user_id"]}) if d.get("user_id") else None
    cnt = db.sensor_logs.count_documents({"device_id": d["device_id"]})
    print(f"  {d['device_id']:<18s} -> {owner['email'] if owner else 'N/A':<25s} sensor_logs={cnt}")

c.close()
print("\nDone!")
