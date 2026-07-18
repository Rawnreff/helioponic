import json, urllib.request

BASE = "http://localhost:8000/api/v1"

def api(method, path, data=None, headers=None):
    h = headers or {}
    body = json.dumps(data).encode() if data else None
    if body: h["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=h, method=method)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Login
res = api("POST", "/auth/login", data={"email": "debug@test.com", "password": "debug123456"})
token = res["token"]
headers = {"Authorization": f"Bearer {token}"}

# Test config defaults
res = api("GET", "/devices/config?device_id=HELIO_NEW_TEST", headers=headers)
print(f"Config defaults for new device:")
print(f"  jarak_on={res['jarak_on']}, jarak_off={res['jarak_off']}")
print(f"  tds_on={res['tds_on']}, tds_off={res['tds_off']}")
assert res['jarak_on'] == 5, f"jarak_on should be 5, got {res['jarak_on']}"
assert res['jarak_off'] == 2, f"jarak_off should be 2, got {res['jarak_off']}"

# Test water level calculation
res = api("GET", "/water/summary?device_id=HELIO_DBG", headers=headers)
print(f"\nWater summary for HELIO_DBG: water_level_pct={res['water_level_pct']:.1f}%, jarak_cm={res['jarak_cm']}")

# Verify compute: (7 - 18) / 7 * 100 = negative -> 0, but jarak_cm=18 > 7 so WaterCalculator returns 0
print(f"\n  Manual check: tank=7cm, jarak={res['jarak_cm']}cm -> water_pct={res['water_level_pct']:.1f}%")
print(f"  (jarak={res['jarak_cm']} > 7, so WaterCalculator returns 0%)")

print("\nAll config assertions passed!")
