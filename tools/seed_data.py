"""Quick data seeder — posts realistic sensor readings for testing the mobile app."""
import httpx, time, random

BASE = "http://192.168.100.16:8000/api/v1"
DEVICE = "HELIO_DBG"
readings = []

# Simulate 10 minutes of sensor data with realistic values
base_ts = int(time.time()) - 600  # 10 min ago
for i in range(20):
    ts = base_ts + i * 30
    # Realistic hydroponic values (tank depth: 7cm):
    # pH drifts between 5.5 and 6.5
    # TDS slowly increases (nutrients accumulate)
    # Water level slowly drops (evaporation), range 2-6cm
    ph = round(random.uniform(5.5, 6.8), 1)
    tds = round(random.uniform(80, 250), 1)
    jarak = random.randint(1, 6)  # cm from sensor to water surface (0-7 tank)
    # ⚠️  Pompa states TIDAK dikirim — backend automation yg menentukan.
    # Backend compute via evaluate_thresholds berdasarkan jarak & tds,
    # lalu publish actuator command ke MQTT helioponic/actuator/downlink.

    payload = {
        "device_id": DEVICE,
        "ts": ts,
        "jarak_cm": jarak,
        "tds_value": tds,
        "current_ph": ph,
    }
    readings.append(payload)

# Post all readings
print(f"Posting {len(readings)} sensor readings to {DEVICE} (no pompa fields)...")
for i, r in enumerate(readings):
    resp = httpx.post(f"{BASE}/sensors/reading", json=r, timeout=10)
    status = "OK" if resp.status_code == 200 else f"FAIL({resp.status_code})"
    print(f"  [{i+1:2d}] pH={r['current_ph']:.1f} TDS={r['tds_value']:.0f} jarak={r['jarak_cm']}cm -> {status}")

# Also post one current reading for "latest" (no pompa fields)
latest = {
    "device_id": DEVICE, "ts": int(time.time()),
    "jarak_cm": 4, "tds_value": 175.0, "current_ph": 6.2,
}
resp = httpx.post(f"{BASE}/sensors/reading", json=latest, timeout=10)
print(f"\n  Latest: pH=6.2 TDS=175 jarak=4 -> {'OK' if resp.status_code==200 else f'FAIL({resp.status_code})'}")

print("\nDone! Check the mobile app now.")
