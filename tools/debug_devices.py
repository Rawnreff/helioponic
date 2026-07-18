"""Debug: list all devices and their owners."""
from pymongo import MongoClient
c = MongoClient("mongodb://localhost:27018/helioponic")
db = c.get_default_database()

print("=== All devices ===")
for d in db.devices.find():
    print(f"  device_id={d['device_id']}, user_id={d['user_id']}, name={d.get('name')}")

print("\n=== debug@test.com ===")
u = db.users.find_one({"email": "debug@test.com"})
if u:
    uid = u["_id"]
    print(f"  user _id: {uid}")
    print(f"  email: {u['email']}")
    for d in db.devices.find({"user_id": uid}):
        print(f"  device: {d['device_id']}")

print("\n=== HELIO_SIM_001 ===")
d = db.devices.find_one({"device_id": "HELIO_SIM_001"})
print(f"  full doc: {d}")

if d:
    owner = db.users.find_one({"_id": d["user_id"]})
    print(f"  owner: {owner.get('email') if owner else 'N/A'}")

c.close()
