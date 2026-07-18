"""Drop the TTL index on sensor_logs so historical data is never auto-deleted.

Run this ONCE after removing the TTL index creation from database.py.
"""
from pymongo import MongoClient, errors

MONGO_URI = "mongodb://localhost:27018/helioponic"

client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = client.get_default_database()

try:
    client.admin.command("ping")
    print("[OK] MongoDB connected")
except errors.ConnectionFailure:
    print("[ERR] Cannot connect to MongoDB")
    exit(1)

# List all indexes on sensor_logs
print("\n[1] Current indexes on sensor_logs:")
for idx in db.sensor_logs.list_indexes():
    ttl = idx.get("expireAfterSeconds", "—")
    print(f"    {idx['name']:<30s} keys={idx['key']}  TTL={ttl}")

# Drop the TTL index
print("\n[2] Dropping TTL index 'sensor_logs_ttl_7d'...")
try:
    db.sensor_logs.drop_index("sensor_logs_ttl_7d")
    print("    [OK] TTL index dropped — data will no longer be auto-deleted")
except errors.OperationFailure as e:
    if "index not found" in str(e):
        print("    [OK] Index already gone (nothing to drop)")
    else:
        print(f"    [ERR] {e}")
        exit(1)

# Verify
print("\n[3] Verifying indexes on sensor_logs:")
for idx in db.sensor_logs.list_indexes():
    ttl = idx.get("expireAfterSeconds", "—")
    print(f"    {idx['name']:<30s} keys={idx['key']}  TTL={ttl}")

print("\n[DONE] TTL removal complete — sensor data is now permanent.")
client.close()
