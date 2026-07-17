#!/usr/bin/env python3
"""
Helioponic — July 2026 Data Seeder
====================================
Seeds realistic sensor data from July 1 to July 15, 2026
for all 4 pumps. Each day gets ~288 readings (every 5 minutes)
with realistic diurnal patterns.

Usage:
  python tools/seed_july.py                          # Seed default (HELIO_001)
  python tools/seed_july.py --device HELIO_DBG       # Custom device
  python tools/seed_july.py --api http://localhost:8000/api/v1
  python tools/seed_july.py --days 7                  # Seed 7 days from July 1
"""

import argparse
import httpx
import random
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

# ─── Constants ────────────────────────────────────────────────────────────
TANK_DEPTH_CM = 7.0

# Healthy diurnal ranges
PH_MIN, PH_MAX = 5.5, 6.8
TDS_MIN, TDS_MAX = 150, 350
JARAK_MIN, JARAK_MAX = 1.5, 5.5  # cm (0-7 tank depth)

# Threshold values (matching backend defaults)
JARAK_ON = 5.0
JARAK_OFF = 2.0
TDS_ON = 95.0
TDS_OFF = 105.0
PH_ON = 6.5
PH_OFF = 5.5

DEVICE_DEFAULT = "HELIO_001"
API_DEFAULT = "http://localhost:8000/api/v1"
JWT_DEFAULT = None  # Will be filled from login if needed


def compute_pumps(jarak: float, tds: float, ph: float) -> dict:
    """Bang-bang hysteresis matching the backend evaluate_thresholds()."""
    p1 = 1 if jarak > JARAK_ON else (0 if jarak < JARAK_OFF else 0)
    p2 = 1 if ph > PH_ON else (0 if ph < PH_OFF else 0)
    p3 = 1 if tds < TDS_ON else (0 if tds > TDS_OFF else 0)
    p4 = p3  # Tandem: Nut A + Nut B always together
    return {"pompa1": p1, "pompa2": p2, "pompa3": p3, "pompa4": p4}


def generate_day(base_date: datetime) -> list[dict]:
    """Generate ~288 sensor readings for one day (every 5 minutes)."""
    readings = []

    # Starting conditions (midnight values)
    ph = 6.2
    tds = 250.0
    jarak = 3.5

    for minute in range(0, 24 * 60, 5):
        ts = base_date + timedelta(minutes=minute)
        epoch = int(ts.timestamp())

        # ── Diurnal variation ──
        hour = ts.hour + ts.minute / 60.0
        # pH is more acidic at night (CO₂ from plants), rises during day
        ph_offset = -0.3 * (1 if hour < 6 or hour > 20 else 0)  # night dip
        # TDS drops slightly during day (nutrient uptake)
        tds_offset = -20 * (1 if 8 < hour < 18 else 0)  # day consumption
        # Water level drops during day (evapotranspiration)
        jarak_offset = 1.0 * (1 if 10 < hour < 16 else 0)  # day evaporation

        base_ph = 6.2 + ph_offset + random.uniform(-0.15, 0.15)
        base_tds = 250.0 + tds_offset + random.uniform(-15, 15)
        base_jarak = 3.5 + jarak_offset + random.uniform(-0.3, 0.3)

        ph = max(PH_MIN, min(PH_MAX, round(base_ph, 1)))
        tds = max(TDS_MIN, min(TDS_MAX, round(base_tds, 0)))
        jarak = max(JARAK_MIN, min(JARAK_MAX, round(base_jarak, 1)))

        pumps = compute_pumps(jarak, tds, ph)

        readings.append({
            "device_id": "",  # filled at runtime
            "ts": epoch,
            "jarak_cm": jarak,
            "tds_value": tds,
            "current_ph": ph,
            "pompa1": pumps["pompa1"],
            "pompa2": pumps["pompa2"],
            "pompa3": pumps["pompa3"],
            "pompa4": pumps["pompa4"],
        })

    return readings


def main():
    parser = argparse.ArgumentParser(description="Helioponic July 2026 Data Seeder")
    parser.add_argument("--device", default=DEVICE_DEFAULT, help=f"Device ID (default: {DEVICE_DEFAULT})")
    parser.add_argument("--api", default=API_DEFAULT, help=f"API URL (default: {API_DEFAULT})")
    parser.add_argument("--days", type=int, default=15, help="Number of days to seed from July 1 (default: 15)")
    parser.add_argument("--email", default=None, help="Login email (optional, for authenticated API)")
    parser.add_argument("--password", default=None, help="Login password")
    parser.add_argument("--no-token", action="store_true", help="Skip auth (for open endpoints)")
    args = parser.parse_args()

    client = httpx.Client(base_url=args.api, timeout=15)

    # ── Authenticate if credentials provided ──
    token: Optional[str] = None
    if args.email and args.password:
        print(f"Logging in as {args.email}...")
        r = client.post("/auth/login", json={"email": args.email, "password": args.password})
        if r.status_code == 200:
            token = r.json().get("token")
            print("  Login OK")
        else:
            print(f"  Login failed: {r.status_code} {r.text}")
            return
    elif not args.no_token:
        # Try default test user
        try:
            r = client.post("/auth/login", json={"email": "sim@helioponic.io", "password": "sim123"})
            if r.status_code == 200:
                token = r.json().get("token")
                print("Logged in as sim@helioponic.io")
            else:
                print("No auth credentials provided. Use --no-token for public endpoints or --email/--password.")
                print("Falling back to no auth...")
        except Exception as e:
            print(f"Auth failed: {e}. Continuing without token.")
    else:
        print("Skipping auth (--no-token)")

    headers = {"Authorization": f"Bearer {token}"} if token else {}

    # ── Generate and post data ──
    start_date = datetime(2026, 7, 1, tzinfo=timezone.utc)
    total_readings = 0

    print(f"\nSeeding data for device: {args.device}")
    print(f"Period: July 1 to July {min(args.days, 15)}, 2026 ({min(args.days, 15)} days)")
    print(f"API:    {args.api}")
    print(f"Auth:   {'Bearer token' if token else 'None (public endpoint)'}")
    print()

    for day_offset in range(min(args.days, 15)):
        day = start_date + timedelta(days=day_offset)
        readings = generate_day(day)
        date_str = day.strftime("%Y-%m-%d")

        # Add device_id to each reading
        for r in readings:
            r["device_id"] = args.device

        success = 0
        failed = 0
        for i, reading in enumerate(readings):
            try:
                r = client.post("/sensors/reading", json=reading, headers=headers)
                if r.status_code == 200:
                    success += 1
                else:
                    failed += 1
                    if failed <= 3:
                        print(f"    [{i}] FAIL({r.status_code}): {r.text[:100]}")
            except Exception as e:
                failed += 1
                if failed <= 3:
                    print(f"    [{i}] ERROR: {e}")

            # Progress indicator every 50 readings
            if (i + 1) % 50 == 0:
                print(f"  {date_str}: {i+1}/{len(readings)} posted...")

        total_readings += success
        status = "[OK]" if failed == 0 else f"[FAIL {failed}]"
        print(f"  [{date_str}] {success} readings posted {status}")

    print(f"\n{'='*50}")
    print(f"  Done! {total_readings} total readings seeded.")
    print(f"  Check the mobile app → Analytics → tap Calendar icon")
    print(f"  Only dates with data (July 1-{min(args.days, 15)}) will be enabled.")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
