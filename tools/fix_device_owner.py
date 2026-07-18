"""Reassign HELIO_SIM_001 to debug@test.com — store user_id as STRING."""
from pymongo import MongoClient

c = MongoClient("mongodb://localhost:27018/helioponic")
db = c.get_default_database()

# Find debug@test.com user
user = db.users.find_one({"email": "debug@test.com"})
if not user:
    print("User not found!")
    exit(1)

# Store as STRING (matching REST API convention), NOT ObjectId
user_id_str = str(user["_id"])
print(f"debug@test.com _id: {user['_id']} (type: {type(user['_id']).__name__})")
print(f"Will store as: {user_id_str} (type: str)")

# Fix HELIO_SIM_001
r = db.devices.update_one(
    {"device_id": "HELIO_SIM_001"},
    {"$set": {"user_id": user_id_str}},
)
print(f"Fixed HELIO_SIM_001: matched={r.matched_count} modified={r.modified_count}")

# Remove HELIO_DBG
r2 = db.devices.delete_one({"device_id": "HELIO_DBG"})
print(f"Removed HELIO_DBG: deleted={r2.deleted_count}")

# Purge old HELIO_DBG sensor data
r3 = db.sensor_logs.delete_many({"device_id": "HELIO_DBG"})
print(f"Purged HELIO_DBG sensor_logs: {r3.deleted_count} records")

# Verify
print("\n--- All devices ---")
for d in db.devices.find({}):
    uid = d["user_id"]
    print(f"  {d['device_id']}: user_id={uid!r} (type: {type(uid).__name__})")

# Verify access check logic
print("\n--- Access check simulation ---")
token_user_id = user_id_str  # what JWT contains
for d in db.devices.find({"user_id": token_user_id}):
    print(f"  {d['device_id']}: token user_id matches = {d['user_id'] == token_user_id}")

c.close()
print("Done!")
