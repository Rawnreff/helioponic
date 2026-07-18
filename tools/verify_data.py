import json, urllib.request
BASE = "http://localhost:8000/api/v1"

def api(method, path, data=None, headers=None):
    h = headers or {}
    body = json.dumps(data).encode() if data else None
    if body: h["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

res = api("POST", "/auth/login", data={"email": "debug@test.com", "password": "debug123456"})
headers = {"Authorization": f"Bearer {res['token']}"}

print("=== Latest sensor for HELIO_001 ===")
res = api("GET", "/sensors/latest?device_id=HELIO_001", headers=headers)
for k, v in res.items():
    if k != "_id":
        print(f"  {k}: {v}")

print("\n=== Water summary ===")
res = api("GET", "/water/summary?device_id=HELIO_001", headers=headers)
print(f"  water_level_pct: {res.get('water_level_pct', 0):.1f}%")
print(f"  jarak_cm: {res.get('jarak_cm')}")

print("\n=== Latest 3 history records ===")
res = api("GET", "/sensors/history?device_id=HELIO_001&limit=3", headers=headers)
print(f"  Total records: {res.get('count', 0)}")
for r in res.get("data", []):
    print(f"  [{r.get('recorded_at', 'N/A')[:19]}] jarak={r.get('jarak_cm')}cm tds={r.get('tds_value')}ppm ph={r.get('current_ph')} p1={r.get('pompa1')} p2={r.get('pompa2')} p3={r.get('pompa3')} p4={r.get('pompa4')}")
