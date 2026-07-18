"""Check MongoDB sensor data availability for July 1-17, 2026."""
import json, urllib.request, sys

BASE = "http://localhost:8000/api/v1"

def api(method, path, data=None, headers=None):
    h = headers or {}
    body = json.dumps(data).encode() if data else None
    if body:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code
    except Exception as e:
        return {"error": str(e)}, 0

# Login
res, code = api("POST", "/auth/login",
    data={"email": "debug@test.com", "password": "debug123456"})
if code != 200:
    print(f"Login failed: {res}")
    sys.exit(1)
headers = {"Authorization": f"Bearer {res['token']}"}

# Check device list
res, code = api("GET", "/devices", headers=headers)
print("=" * 60)
print("DEVICE LIST")
print("=" * 60)
for d in res.get("devices", []):
    print(f"  {d['device_id']:<18} {d.get('name', ''):<20} active={d.get('is_active', False)}")

# For each device, check date range Jul 1-17
for dev in res.get("devices", []):
    did = dev["device_id"]
    print(f"\n{'='*60}")
    print(f"DEVICE: {did}")
    print(f"{'='*60}")

    # Full range count
    r, code = api("GET",
        f"/sensors/history?device_id={did}"
        f"&from_date=2026-07-01T00:00:00Z"
        f"&to_date=2026-07-17T23:59:59Z"
        f"&limit=5",
        headers=headers)
    if code == 200:
        count = r.get("count", 0)
        print(f"  Jul 1-17 records: {count}")
        records = r.get("data", [])
        if records:
            oldest = records[-1].get("recorded_at", "N/A")
            newest = records[0].get("recorded_at", "N/A")
            print(f"  Oldest: {str(oldest)[:19]}")
            print(f"  Newest: {str(newest)[:19]}")
    else:
        print(f"  Error: {r}")

    # Latest record
    r, code = api("GET", f"/sensors/latest?device_id={did}", headers=headers)
    if code == 200 and "message" not in r:
        print(f"  Latest:  jarak={r.get('jarak_cm')}cm tds={r.get('tds_value')}ppm ph={r.get('current_ph')}")
        print(f"           recorded={str(r.get('recorded_at', 'N/A'))[:19]}")
        print(f"           p1={r.get('pompa1')} p2={r.get('pompa2')} p3={r.get('pompa3')} p4={r.get('pompa4')}")

    # Per-day breakdown for Jul 1-17
    print(f"\n  Per-day breakdown (Jul 1-17):")
    for day in range(1, 18):
        d = f"2026-07-{day:02d}"
        r, code = api("GET",
            f"/sensors/history?device_id={did}"
            f"&from_date={d}T00:00:00Z"
            f"&to_date={d}T23:59:59Z"
            f"&limit=1",
            headers=headers)
        count = r.get("count", 0) if code == 200 else "ERR"
        marker = " ←" if count and count > 0 else ""
        print(f"    {d}: {str(count):>5s} records{marker}")

print("\n" + "=" * 60)
print("DONE")
print("=" * 60)
