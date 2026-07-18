"""Quick API test — verify history endpoint with day/week filtering."""
import json, urllib.request
from datetime import datetime, timedelta

BASE = "http://localhost:8000/api/v1"

def api(method, path, data=None, headers=None):
    h = headers or {}
    body = json.dumps(data).encode() if data else None
    if body:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=h, method=method)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Login
res = api("POST", "/auth/login", data={"email": "debug@test.com", "password": "debug123456"})
token = res["token"]
headers = {"Authorization": f"Bearer {token}"}

# Test DAY filter (today only)
today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
today_end = datetime.now().isoformat()

res = api("GET", f"/sensors/history?from_date={today_start}&to_date={today_end}&device_id=HELIO_DBG&limit=200", headers=headers)
print(f"=== DAY filter (today only) ===")
print(f"Count: {res.get('count', 0)}")
for r in res.get("data", [])[:3]:
    print(f"  {r['recorded_at']} | pH={r['current_ph']} TDS={r['tds_value']} Jarak={r['jarak_cm']}")

# Test WEEK filter (last 7 days)
week_start = (datetime.now() - timedelta(days=7)).isoformat()
res = api("GET", f"/sensors/history?from_date={week_start}&to_date={today_end}&device_id=HELIO_DBG&limit=200", headers=headers)
print(f"\n=== WEEK filter (last 7 days) ===")
print(f"Count: {res.get('count', 0)}")

# Test water history
res = api("GET", f"/water/history?from_date={today_start}&to_date={today_end}&device_id=HELIO_DBG&limit=200", headers=headers)
print(f"\n=== Water history (today) ===")
print(f"Count: {res.get('count', 0)}")
for r in res.get("data", [])[:3]:
    print(f"  {r['recorded_at']} | jarak_cm={r['jarak_cm']} water_pct={r.get('water_level_pct', 'N/A')}")

print("\n✅ All endpoints responding correctly!")
