# Helioponic Firmware

> Firmware for the Helioponic hydroponic system hardware layer.
> **Architecture:** ESP32 (Master) + Arduino Uno (Slave) via UART Serial @ 9600 baud.
> **Pump Configuration:** 4-pump architecture — Water Refill (P1), pH DOWN (P2), Nutrisi A (P3), Nutrisi B (P4).

---

## Architecture

```
┌─────────────────────────────────┐        Serial1 (9600 8N1)          ┌──────────────────────────────┐
│         ESP32 (MASTER)          │  P1:/P2:/P3:/P4: commands ──────► │   Arduino Uno (SLAVE)        │
│                                 │  ◄──── F1:/F2:/F3:/F4: feedback   │                              │
│                                 │                                    │                              │
│  • HC-SR04 Ultrasonic GPIO12/13 │                                    │  • 4x Active-LOW Relays     │
│  • TDS Sensor GPIO4             │                                    │     POMPA1 (GPIO4) — Water  │
│  • pH Sensor GPIO5              │                                    │     POMPA2 (GPIO5) — pH DOWN│
│  • WiFi + MQTT Client           │                                    │     POMPA3 (GPIO6) — Nut A  │
│  • 4-pump bang-bang hysteresis  │                                    │     POMPA4 (GPIO7) — Nut B  │
│  • MQTT publisher (1s)          │                                    │  • Reads P1:-P4: commands   │
│  • MQTT downlink subscriber     │                                    │  • Sends F1:-F4: feedback   │
└──────────────┬──────────────────┘                                    └──────────────────────────────┘
               │
          MQTT (QoS 0/1)
               │
       ┌───────▼────────┐
       │   Mosquitto    │
       │    Broker      │
       └───────┬────────┘
               │
       ┌───────▼────────────┐
       │ Python FastAPI     │
       │ (helioponic-backend)│
       └────────────────────┘
```

---

## 4-Pump Configuration Matrix

| Pump | Label | Controlled By | Function | Tandem |
|:----:|-------|---------------|----------|:------:|
| **Pompa 1** | Water Refill / Sirkulasi | Ultrasonic (`jarak_cm`) | Refills tank when water too low | No |
| **Pompa 2** | pH DOWN Dosing | pH sensor (`current_ph`) | Doses pH DOWN when pH too high | No |
| **Pompa 3** | Nutrisi A Dosing | TDS (`tds_value`) | Doses Nutrient A when TDS low | **Yes (with P4)** |
| **Pompa 4** | Nutrisi B Dosing | TDS (`tds_value`) | Doses Nutrient B when TDS low | **Yes (with P3)** |

### Tandem TDS Logic (Pompa 3 & 4)
- **Trigger ON:** When `tds_value < tds_on`, both **Pompa 3** AND **Pompa 4** turn ON simultaneously
- **Trigger OFF:** When `tds_value > tds_off`, both **Pompa 3** AND **Pompa 4** turn OFF simultaneously
- The two nutrient pumps always operate as a pair — never independently

---

## Wiring Guide

### Arduino Uno (Slave — Relay Actuator)

| Component     | Arduino Pin | Notes                        |
|---------------|-------------|------------------------------|
| Relay POMPA1  | GPIO4       | Active-LOW (LOW = ON) — Water |
| Relay POMPA2  | GPIO5       | Active-LOW (LOW = ON) — pH    |
| Relay POMPA3  | GPIO6       | Active-LOW (LOW = ON) — Nut A |
| Relay POMPA4  | GPIO7       | Active-LOW (LOW = ON) — Nut B |
| UART RX       | D0 (RX)     | ← ESP32 TX1 (pin 17)         |
| UART TX       | D1 (TX)     | → ESP32 RX1 (pin 18)         |

> **Important:** When uploading to the Arduino Uno, disconnect its TX/RX from the ESP32 to avoid serial conflict.

### ESP32 (Master — Sensor + MQTT Gateway)

| Component          | ESP32 Pin   | Notes                          |
|--------------------|-------------|--------------------------------|
| HC-SR04 TRIG       | GPIO12      | Digital output                 |
| HC-SR04 ECHO       | GPIO13      | Digital input                  |
| TDS Sensor         | GPIO4       | ADC1 — analog                  |
| pH Sensor          | GPIO5       | ADC1 — analog                  |
| Serial1 TX         | GPIO17      | → Arduino RX (D0)              |
| Serial1 RX         | GPIO18      | ← Arduino TX (D1)              |
| Built-in LED       | GPIO2       | Blinks on MQTT publish         |

---

## Serial Protocol (9600 baud)

### ESP32 → Arduino (Pump Commands)

```
P1:1\n     → Pompa 1 ON  (Water Refill / Circulation)
P1:0\n     → Pompa 1 OFF
P2:1\n     → Pompa 2 ON  (pH DOWN Dosing)
P2:0\n     → Pompa 2 OFF
P3:1\n     → Pompa 3 ON  (Nutrisi A Dosing)
P3:0\n     → Pompa 3 OFF
P4:1\n     → Pompa 4 ON  (Nutrisi B Dosing)
P4:0\n     → Pompa 4 OFF
```

### Arduino → ESP32 (Execution Feedback)

```
F1:ON\n    → Pompa 1 is ON
F1:OFF\n   → Pompa 1 is OFF
F2:ON\n    → Pompa 2 is ON
F2:OFF\n   → Pompa 2 is OFF
F3:ON\n    → Pompa 3 is ON (Nutrisi A)
F3:OFF\n   → Pompa 3 is OFF
F4:ON\n    → Pompa 4 is ON (Nutrisi B)
F4:OFF\n   → Pompa 4 is OFF
```

---

## Telemetry Field Names (1:1 with firmware variables)

The ESP32 publishes JSON every 1 second to `helioponic/sensor/uplink` using exact variable names from `helioponic_esp32.ino`:

| JSON Field   | C++ Variable      | Source         | Description                            |
|-------------|-------------------|----------------|----------------------------------------|
| `device_id` | `DEVICE_ID`       | .ino #define   | Unique device identifier               |
| `ts`        | `time(nullptr)`   | NTP            | Unix epoch timestamp                   |
| `jarak_cm`  | `jarakCm`         | HC-SR04        | Ultrasonic distance (cm). 999 = OOR    |
| `tds_value` | `current_tds`     | TDS GPIO4      | Total Dissolved Solids (ppm)           |
| `current_ph`| `current_ph`      | pH GPIO5       | pH reading (0.0–14.0)                  |
| `pompa1`    | `statusPompa1DariUno` | Arduino F1 | Pump 1 state (0/1) — Water Refill      |
| `pompa2`    | `statusPompa2DariUno` | Arduino F2 | Pump 2 state (0/1) — pH DOWN Dosing    |
| `pompa3`    | `statusPompa3DariUno` | Arduino F3 | Pump 3 state (0/1) — Nutrisi A Dosing  |
| `pompa4`    | `statusPompa4DariUno` | Arduino F4 | Pump 4 state (0/1) — Nutrisi B Dosing  |

---

## MQTT Topics

| Topic | Direction | QoS | Frequency | Payload (JSON) |
|-------|-----------|:---:|:---------:|----------------|
| `helioponic/sensor/uplink` | ESP32 → Broker | 0 | Every 1s | `{device_id, ts, jarak_cm, tds_value, current_ph, pompa1, pompa2, pompa3, pompa4}` |
| `helioponic/status/uplink` | ESP32 → Broker | 1 | Every 30s | `{device_id, status, version, night_mode, wifi_rssi}` |
| `helioponic/alarm/uplink` | ESP32 → Broker | 1 | On-event | `{device_id, alarm_type, message, ts}` |
| `helioponic/config/downlink` | Backend → ESP32 | 1 | On-demand | `{jarak_on, jarak_off, tds_on, tds_off, ph_max, ph_min}` |
| `helioponic/actuator/downlink` | Backend → ESP32 | 1 | On-demand | `{pump, state}` — pump: `pompa1`/`circ`, `pompa2`/`ph_d`, `pompa3`/`nut_a`, `pompa4`/`nut_b` |
| `helioponic/night_mode/downlink` | Backend → ESP32 | 1 | On-demand | `{active, jarak_on?, jarak_off?, tds_on?, tds_off?}` |

### Uplink Payload Example (sensor data)

```json
{
  "device_id": "HELIO_001",
  "ts": 1719504000,
  "jarak_cm": 15,
  "tds_value": 200.5,
  "current_ph": 6.5,
  "pompa1": 1,
  "pompa2": 0,
  "pompa3": 0,
  "pompa4": 0
}
```

### Status Heartbeat Payload (every 30s)

```json
{
  "device_id": "HELIO_001",
  "status": "online",
  "ts": 1719504000,
  "version": "3.3.0",
  "night_mode": 0,
  "wifi_rssi": -45
}
```

### Config Downlink Payload (threshold update)

```json
{
  "jarak_on": 5.0,
  "jarak_off": 2.0,
  "tds_on": 95.0,
  "tds_off": 105.0,
  "ph_max": 6.5,
  "ph_min": 5.5
}
```

### Actuator Downlink Payload (pump toggle from mobile)

Accepts both raw firmware names and legacy aliases:
```json
{ "pump": "pompa1", "state": 1 }
{ "pump": "circ",   "state": 0 }   // alias for pompa1
{ "pump": "ph_d",   "state": 1 }   // alias for pompa2
{ "pump": "nut_a",  "state": 1 }   // alias for pompa3
{ "pump": "nut_b",  "state": 0 }   // alias for pompa4
```

### Night Mode Downlink Payload

```json
{ "active": true }
```

On deactivation, optional thresholds can be provided:
```json
{
  "active": false,
  "jarak_on": 5.0,
  "jarak_off": 2.0,
  "tds_on": 95.0,
  "tds_off": 105.0
}
```

---

## Installation

### Arduino Uno

1. Open `arduino_uno/helioponic_uno.ino` in the Arduino IDE
2. Select **Arduino Uno** as the board
3. Select the correct COM port
4. Upload

> No external libraries required — uses only built-in `Serial` and `pinMode`/`digitalWrite`.

### ESP32

1. Install ESP32 board support in Arduino IDE:
   - File → Preferences → Additional Boards Manager URLs:
     ```
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-packages/package_esp32_index.json
     ```
   - Tools → Board → Boards Manager → Search "ESP32" → Install

2. Install required libraries via Library Manager:
   - `PubSubClient` by Nick O'Leary
   - `ArduinoJson` by Benoit Blanchon

3. Create `helioponic_esp32.ino` from the example template:
   ```bash
   cp esp32/helioponic_esp32.example.ino esp32/helioponic_esp32.ino
   ```
   Then edit the CREDENTIALS section at the top of `helioponic_esp32.ino`:
   ```cpp
   #define WIFI_SSID     "YourWiFiSSID"
   #define WIFI_PASSWORD "YourWiFiPassword"
   #define MQTT_USER     ""
   #define MQTT_PASS     ""
   ```

4. (Optional) Edit the hardware config section at the top of `esp32/helioponic_esp32.ino`
   if you need to change pin mappings, calibration values, or thresholds.

5. Open `esp32/helioponic_esp32.ino` in the Arduino IDE

6. Select your ESP32 board (e.g., **ESP32 Dev Module**)

7. Select the correct COM port

8. Upload

> **Note:** All hardware configuration and credentials are embedded directly
> in `helioponic_esp32.ino`. The local file is gitignored. For GitHub,
> use the template `helioponic_esp32.example.ino` with placeholder values.

---

## Local Edge Automation (4-Pump Independent Bang-Bang Hysteresis)

The ESP32 runs pump automation locally — fully autonomous during network outages.

Each pump is controlled **independently** by its own sensor with bang-bang hysteresis:

| Priority | Pump | Controlled By | ON Condition | OFF Condition |
|:--------:|------|--------------|-------------|--------------|
| HIGH | **Pompa 1** (Water Refill) | Ultrasonic `jarak_cm` | `jarak_cm > jarak_on` | `jarak_cm < jarak_off` |
| MED | **Pompa 2** (pH DOWN Dosing) | pH sensor `current_ph` | `current_ph > ph_max` | `current_ph < ph_min` |
| MED | **Pompa 3** (Nutrisi A) | TDS `tds_value` | `tds_value < tds_on` (tandem with P4) | `tds_value > tds_off` |
| MED | **Pompa 4** (Nutrisi B) | TDS `tds_value` | `tds_value < tds_on` (tandem with P3) | `tds_value > tds_off` |
| — | Inside deadband | — | Preserve existing state | |

### Default Thresholds (can be overridden via MQTT config downlink)

- **jarak_on  = 5.0 cm** — water low, turn Pompa 1 ON
- **jarak_off = 2.0 cm** — water recovered, turn Pompa 1 OFF
- **tds_on    = 95 ppm** — nutrients low, turn Pompa 3 & 4 ON (tandem)
- **tds_off   = 105 ppm** — nutrients sufficient, turn Pompa 3 & 4 OFF
- **ph_max    = 6.5** — pH too high, turn Pompa 2 ON (pH DOWN)
- **ph_min    = 5.5** — pH sufficiently low, turn Pompa 2 OFF

### Manual Override

MQTT actuator commands set `manualOverride` flags that persist until the next MQTT
command clears them. During manual override, the bang-bang logic skips that pump.
Each pump (P1–P4) has its own independent manual override flag.

### Night Mode

When active via MQTT `night_mode/downlink`:
- All 4 pumps are forced OFF immediately
- Automation is paused
- Only manual commands are accepted
- On deactivation, saved thresholds are restored and automation resumes

---

## Testing Without Hardware

Use `mosquitto_pub` to simulate ESP32 payloads:

```bash
# Simulate sensor data (with all 4 pump states)
mosquitto_pub -h localhost -t "helioponic/sensor/uplink" -m '{
  "device_id":"HELIO_001",
  "ts":1719504000,
  "jarak_cm":15,
  "tds_value":200.5,
  "current_ph":6.5,
  "pompa1":1,
  "pompa2":0,
  "pompa3":0,
  "pompa4":0
}'

# Simulate config downlink (update thresholds)
mosquitto_pub -h localhost -t "helioponic/config/downlink" -q 1 -m '{
  "jarak_on":5.0,
  "jarak_off":2.0,
  "tds_on":95.0,
  "tds_off":105.0,
  "ph_max":6.5,
  "ph_min":5.5
}'

# Simulate actuator command for pompa3
mosquitto_pub -h localhost -t "helioponic/actuator/downlink" -q 1 -m '{
  "pump":"pompa3",
  "state":1
}'
```

Or use the automated simulation script:
```bash
bash tools/simulate.sh
```

Refer to `MOBILE_TESTING_GUIDE.md` and `TESTING_GUIDE.md` in `guides/` for detailed instructions.

---

## Troubleshooting

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| No serial data | TX/RX crossed or baud mismatch | Verify wiring: ESP32 TX1 (17)→Uno RX (0) |
| MQTT connection fails | Wrong broker address | Check `MQTT_BROKER` in the CREDENTIALS section of `.ino` |
| WiFi disconnects | Weak signal | Verify credentials in the CREDENTIALS section of `.ino` |
| JSON parse error | Payload too large | Reduce buffer size or use `mqttClient.setBufferSize(512)` |
| pH reads 0 or 14 | Sensor not calibrated | Adjust `PH_SLOPE` / `PH_INTERCEPT` in the `.ino` file |
| Relays not activating | Wrong logic (HIGH vs LOW) | Relays are Active-LOW: `LOW = ON`, `HIGH = OFF` |
| Ultrasonic reads 999 | Out of range or disconnected | Check TRIG/ECHO wiring to HC-SR04 |
| P3/P4 not responding | Missing relay pins | Verify POMPA3 on GPIO6 and POMPA4 on GPIO7 |
