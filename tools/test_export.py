"""Quick test: hit /sensors/export for daily/weekly/monthly and show row counts."""
import json, urllib.request, urllib.error

BASE = "http://localhost:8000/api/v1"

def api(method, path, data=None, headers=None):
    h = headers or {}
    body = json.dumps(data).encode() if data else None
    if body:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read(), r.status
    except urllib.error.HTTPError as e:
        return e.read(), e.code

# Login
data, code = api("POST", "/auth/login",
    data={"email": "sim@helioponic.io", "password": "sim123"})
if code != 200:
    print(f"Login failed: {data}")
    exit(1)
token = json.loads(data)["token"]
h = {"Authorization": f"Bearer {token}"}

# Test all three ranges
start_dates = {
    "daily":   "2026-07-16T00:00:00.000Z",
    "weekly":  "2026-07-10T00:00:00.000Z",
    "monthly": "2026-07-01T00:00:00.000Z",
}
end_date = "2026-07-16T23:59:59.000Z"

for rng, start in start_dates.items():
    body, code = api("GET",
        f"/sensors/export?range={rng}&device_id=HELIO_SIM_001"
        f"&from_date={start}&to_date={end_date}&limit=50000",
        headers=h)

    if code != 200:
        print(f"{rng:>7s}: ERROR {code} — {body[:200]}")
        continue

    text = body.decode("utf-8")
    lines = text.strip().split("\n")
    header = lines[0] if lines else "(empty)"
    row_count = len(lines) - 1 if lines else 0

    # Show first 3 and last 2 timestamps (format: "Jul 16, 12:00:00 AM" — note comma)
    timestamps = []
    for line in lines[1:]:
        # Timestamp format has commas, so take first TWO segments:
        # "Jul 16, 12:00:00 AM,6.2,280,..." → first two comma-seps are the timestamp
        parts = line.split(",")
        ts = ",".join(parts[:2]).strip()  # "Jul 16" + ", 12:00:00 AM"
        if ts:
            timestamps.append(ts)

    first_ts = timestamps[0] if timestamps else "N/A"
    last_ts = timestamps[-1] if timestamps else "N/A"

    print(f"{rng:>7s}: {row_count:>5d} rows  "
          f"first={first_ts:<25s}  last={last_ts:<25s}  "
          f"size={len(text):>6d}B")

    # Check for duplicates: compare consecutive timestamps
    dup_groups = {}
    for ts in timestamps:
        dup_groups[ts] = dup_groups.get(ts, 0) + 1
    dups = {ts: n for ts, n in dup_groups.items() if n > 1}
    if dups:
        sample = list(dups.keys())[:3]
        print(f"         DUPS: {len(dups)} duplicate timestamps (e.g. {sample})")
    else:
        print(f"         [OK] no duplicate timestamps")

print("\nExpected row counts after aggregation:")
print(f"  daily:   ~720 rows  (1 day × 60min × 720rec/day ≈ 720 groups)")
print(f"  weekly:  ~336 rows  (7 days × 48 half-hours = 336 groups)")
print(f"  monthly: ~192 rows  (16 days × 12 two-hour blocks = 192 groups)")
