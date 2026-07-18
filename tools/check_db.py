from pymongo import MongoClient
from datetime import datetime, timezone
c = MongoClient("mongodb://localhost:27018/helioponic")
db = c.get_default_database()
count = db.sensor_logs.count_documents({"device_id": "HELIO_DBG"})
print(f"Total: {count}")
first = db.sensor_logs.find_one({"device_id": "HELIO_DBG"}, sort=[("recorded_at", 1)])
last = db.sensor_logs.find_one({"device_id": "HELIO_DBG"}, sort=[("recorded_at", -1)])
print(f"First: {first['recorded_at']}")
print(f"Last:  {last['recorded_at']}")
s = datetime(2026, 7, 1, tzinfo=timezone.utc)
e = datetime(2026, 7, 16, 23, 59, 59, tzinfo=timezone.utc)
print(f"Jul 1-16 match: {db.sensor_logs.count_documents({'device_id': 'HELIO_DBG', 'recorded_at': {'$gte': s, '$lte': e}})}")
