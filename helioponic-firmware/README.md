# Helioponic Firmware

> Firmware for the Helioponic hydroponic system hardware layer.
> **Architecture:** ESP32 (Master) + Arduino Uno (Slave) via UART Serial @ 9600 baud.

---

## Architecture

```
┌─────────────────────────────────┐        Serial1 (9600 8N1)      ┌──────────────────────────────┐
│         ESP32 (MASTER)          │  P1:1/P1:0, P2:1/P2:0 ──────► │   Arduino Uno (SLAVE)        │
│                                 │  ◄──── F1:ON/F2:OFF           │                              │
│  • HC-SR04 Ultrasonic GPIO12/13 │                                │  • 2x Active-LOW Relays      │
│  • TDS Sensor GPIO4             │                                │     POMPA1 (GPIO4)           │
│  • pH Sensor GPIO5              │                                │     POMPA2 (GPIO5)           │
│  • WiFi + MQTT Client           │                                │  • Reads P1:/P2: commands    │
│  • Bang-bang hysteresis auto    │                                │  • Sends F1:/F2: feedback    │
│  • MQTT publisher (1s)          │                                │                              │
│  • MQTT downlink subscriber     │                                └──────────────────────────────┘
└──────────────┬──────────────────┘
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

## Wiring Guide

### Arduino Uno (Slave — Relay Actuator)

| Component     | Arduino Pin | Notes                        |
|---------------|-------------|------------------------------|
| Relay POMPA1  | GPIO4       | Active-LOW (LOW = ON)        |
| Relay POMPA2  | GPIO5       | Active-LOW (LOW = ON)        |
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
P1:1\n     → Pompa 1 ON
P1:0\n     → Pompa 1 OFF
P2:1\n     → Pompa 2 ON
P2:0\n     → Pompa 2 OFF
```

### Arduino → ESP32 (Execution Feedback)

```
F1:ON\n    → Pompa 1 is ON
F1:OFF\n   → Pompa 1 is OFF
F2:ON\n    → Pompa 2 is ON
F2:OFF\n   → Pompa 2 is OFF
```

---

## Telemetry Field Names (1:1 with firmware variables)

The ESP32 publishes JSON every 1 second to `helioponic/sensor/uplink` using exact variable names from `helioponic_esp32.ino`:

| JSON Field   | C++ Variable      | Source         | Description                        |
|-------------|-------------------|----------------|------------------------------------|
| `device_id` | `DEVICE_ID`       | config.h       | Unique device identifier           |
| `ts`        | `time(nullptr)`   | NTP            | Unix epoch timestamp               |
| `jarak_cm`  | `jarakCm`         | HC-SR04        | Ultrasonic distance (cm). 999 = OOR |
| `tds_value` | `current_tds`     | TDS GPIO4      | Total Dissolved Solids (ppm)       |
| `current_ph`| `current_ph`      | pH GPIO5       | pH reading (0.0–14.0)              |
| `pompa1`    | `statusPompa1DariUno` | Arduino F1 feedback | Pump 1 state (0/1)          |
| `pompa2`    | `statusPompa2DariUno` | Arduino F2 feedback | Pump 2 state (0/1)          |

---

## MQTT Topics

| Topic | Direction | QoS | Frequency | Payload (JSON) |
|-------|-----------|:---:|:---------:|----------------|
| `helioponic/sensor/uplink` | ESP32 → Backend | 0 | Every 1s | `{device_id, ts, jarak_cm, tds_value, current_ph, pompa1, pompa2}` |
| `helioponic/config/downlink` | Backend → ESP32 | 1 | On-demand | `{jarak_on, jarak_off, tds_on, tds_off}` |
| `helioponic/actuator/downlink` | Backend → ESP32 | 1 | On-demand | `{pump, state}` |

### Uplink Payload Example

```json
{
  "device_id": "HELIO_001",
  "ts": 1719504000,
  "jarak_cm": 15,
  "tds_value": 200.5,
  "current_ph": 6.5,
  "pompa1": 1,
  "pompa2": 0
}
```

### Config Downlink Payload (threshold update)

```json
{
  "jarak_on": 105,
  "jarak_off": 95,
  "tds_on": 105.0,
  "tds_off": 95.0
}
```

### Actuator Downlink Payload (pump toggle from mobile)

```json
{
  "pump": "pompa1",
  "state": 1
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

3. Create `esp32/secrets.h` with your WiFi credentials:
   ```cpp
   cp esp32/secrets.h.example esp32/secrets.h
   ```
   Then edit `secrets.h`:
   ```cpp
   #define WIFI_SSID     "YourWiFiSSID"
   #define WIFI_PASSWORD "YourWiFiPassword"
   #define MQTT_USER     ""
   #define MQTT_PASS     ""
   ```

4. (Optional) Edit the hardware config at the top of `esp32/helioponic_esp32.ino`
   if you need to change pin mappings, calibration values, or thresholds.

5. Open `esp32/helioponic_esp32.ino` in the Arduino IDE
6. Select your ESP32 board (e.g., **ESP32 Dev Module**)
7. Select the correct COM port
8. Upload

> **Note:** `config.h` has been removed — all hardware configuration is now
> defined directly at the top of each `.ino` file. Only `secrets.h` remains
> separate (gitignored) for WiFi & MQTT credentials.

---

## Local Edge Automation (Bang-Bang Hysteresis)

The ESP32 runs pump automation locally — fully autonomous during network outages:

| Condition | Action |
|-----------|--------|
| `jarak_cm > jarak_on` **AND** `tds_value > tds_on` | Both pumps ON |
| `jarak_cm < jarak_off` **OR** `tds_value < tds_off` | Both pumps OFF |
| Inside deadband (`jarak_off`–`jarak_on`) | Preserve existing pump state |

Default thresholds (can be overridden via MQTT config downlink):
- **jarak_on = 105 cm** — water low, turn pump ON
- **jarak_off = 95 cm** — water recovered, turn pump OFF
- **tds_on = 105 ppm** — nutrients low, turn pump ON
- **tds_off = 95 ppm** — nutrients recovered, turn pump OFF

---

## Testing Without Hardware

Use `mosquitto_pub` to simulate ESP32 payloads:

```bash
# Simulate sensor data
mosquitto_pub -h localhost -t "helioponic/sensor/uplink" -m '{
  "device_id":"HELIO_001",
  "ts":1719504000,
  "jarak_cm":15,
  "tds_value":200.5,
  "current_ph":6.5,
  "pompa1":1,
  "pompa2":0
}'

# Simulate config downlink (update thresholds)
mosquitto_pub -h localhost -t "helioponic/config/downlink" -q 1 -m '{
  "jarak_on":100,
  "jarak_off":90,
  "tds_on":150.0,
  "tds_off":120.0
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
| MQTT connection fails | Wrong broker address | Check `MQTT_BROKER` in `secrets.h` or set `MQTT_BROKER` in the `.ino` file |
| WiFi disconnects | Weak signal | Verify credentials in `secrets.h` |
| JSON parse error | Payload too large | Reduce buffer size or use `mqttClient.setBufferSize(512)` |
| pH reads 0 or 14 | Sensor not calibrated | Adjust `PH_SLOPE` / `PH_INTERCEPT` in the `.ino` file |
| Relays not activating | Wrong logic (HIGH vs LOW) | Relays are Active-LOW: `LOW = ON`, `HIGH = OFF` |
| Ultrasonic reads 999 | Out of range or disconnected | Check TRIG/ECHO wiring to HC-SR04 |
