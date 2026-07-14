// =============================================================================
// Helioponic — ESP32 Firmware (EXAMPLE)
// =============================================================================
// This file is a TEMPLATE with placeholder credentials.
// For actual deployment:
//   1. Copy this file to helioponic_esp32.ino
//   2. Fill in your WiFi SSID & password
//   3. (Optional) Set MQTT_USER / MQTT_PASS if your broker requires auth
//   4. Compile and upload to your ESP32
//
// helioponic_esp32.ino is gitignored — your credentials stay local.
//
// Architecture:
//   ESP32 (Master) — reads sensors, runs automation, handles networking
//   Arduino Uno (Slave) — executes relay commands, sends feedback via Serial1
//
// Sensor-to-Cloud Pipeline:
//   1. Read local sensors: Ultrasonic (water level), TDS, pH
//   2. Run local pump automation (independent bang-bang hysteresis)
//         - Pompa 1 (Water Circulation): controlled by jarak_cm only
//         - Pompa 2 (TDS Dosing): controlled by tds_value only
//   3. Send pump commands to Arduino (P1:/P2:) via Serial1
//   4. Read pump feedback (F1:/F2:) from Arduino via Serial1
//   5. Package all data as JSON and publish to MQTT topic
//   6. Subscribe to MQTT downlinks for config, actuator, night mode
//   7. Publish heartbeat status every 30s
//   8. Detect water level alarm (rising edge on jarak_cm==999)
//
// Independent Pump Logic (PRD-aligned):
//   - Pompa 1 ON  when jarak_cm > jarak_on  (water low, need refill)
//   - Pompa 1 OFF when jarak_cm < jarak_off (water sufficient)
//   - Pompa 2 ON  when tds_value > tds_on   (nutrients low, need dosing)
//   - Pompa 2 OFF when tds_value < tds_off  (nutrients sufficient)
//
// Manual Override Preservation:
//   - MQTT actuator commands set manual_override flags
//   - Bang-bang logic skips pumps with active manual override
//   - Override persists until next MQTT command clears it
//
// Night Mode:
//   - When active: all pumps OFF, automation paused
//   - Only manual commands accepted during night mode
//   - State toggled via MQTT night_mode/downlink topic
//
// Water Level Alarm:
//   - Rising edge detection on jarak_cm becoming 999
//   - 60-second cooldown prevents duplicate notifications
//   - Publishes to helioponic/alarm/uplink (QoS 1)
//
// MQTT Topics:
//   Publish:  helioponic/sensor/uplink     — JSON sensor + pump states (QoS 0, 1s)
//   Publish:  helioponic/status/uplink     — Device heartbeat (QoS 1, 30s)
//   Publish:  helioponic/alarm/uplink      — Water alarm event (QoS 1, on-event)
//   Subscribe: helioponic/config/downlink   — Threshold updates (QoS 1)
//   Subscribe: helioponic/actuator/downlink — Pump commands (QoS 1)
//   Subscribe: helioponic/night_mode/downlink — Night mode toggle (QoS 1)
//
// Startup Sequence:
//   1. Init hardware (relay OFF, serial comm)
//   2. Connect WiFi
//   3. HTTP GET /api/v1/devices/config?device_id=X — fetch thresholds
//   4. Fallback to compile-time defaults if HTTP fails
//   5. Connect to MQTT broker, subscribe to all downlink topics
//   6. Publish status heartbeat (online)
//   7. Enter main loop
//
// ⚠️ Credentials are placeholders — copy to helioponic_esp32.ino and fill in.
// =============================================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>

// =============================================================================
// CREDENTIALS — Replace these with your own values
// =============================================================================
// WiFi Credentials (REQUIRED)
#define WIFI_SSID        "YourWiFiSSID"
#define WIFI_PASSWORD    "YourWiFiPassword"

// MQTT Authentication (must match broker's mosquitto/config/passwd)
// Synced from tools/simulate.sh
#define MQTT_USER        "helioponic"
#define MQTT_PASS        "helioponic_mqtt_2024"

// =============================================================================
// HARDWARE CONFIGURATION
// =============================================================================

// ---- Sensor Pin Mapping (from raw calibration) ----
#define TRIG_PIN          12    // HC-SR04 Trigger
#define ECHO_PIN          13    // HC-SR04 Echo
#define TDS_SENSOR_PIN    4     // ADC1 GPIO4 — TDS sensor
#define PH_SENSOR_PIN     5     // ADC1 GPIO5 — pH sensor

// ---- Serial1 Pins (Communication with Arduino Uno) ----
#define TX1_PIN           17
#define RX1_PIN           18

// ---- ADC Calibration (ESP32, 3.3V / 12-bit) ----
#define VREF              3.3f
#define ADC_RESOLUTION    4095.0f

// ---- TDS Calibration ----
#define TDS_FACTOR        0.50f
#define TEMPERATURE       25.0f

// ---- pH Calibration ----
#define PH_SLOPE          -5.70f
#define PH_INTERCEPT      21.34f

// ---- Default Pump Automation Thresholds (tank depth = 7cm) ----
#define JARAK_ON          5       // cm — water too low, turn pump ON  (e.g. 5cm → ~29% water)
#define JARAK_OFF         2       // cm — water recovered, turn pump OFF (e.g. 2cm → ~71% water)
#define TDS_ON            95      // ppm — nutrients too low (LOW threshold), turn dosing ON
#define TDS_OFF           105     // ppm — nutrients sufficient (HIGH threshold), turn dosing OFF
#define PH_MAX            6.5     // pH — pH DOWN threshold: Pompa 2 ON when pH exceeds this

// ---- Sampling ----
#define ADC_OVERSAMPLE_N  16      // Number of ADC samples for averaging

// ---- Timing ----
#define SENSOR_LOOP_MS    200     // Read sensors & control pumps every 200ms
#define MQTT_PUBLISH_MS   1000    // Publish sensor data every 1 second (5 cycles)
#define MQTT_RECONNECT_MS 5000    // MQTT reconnect delay (ms)
#define STATUS_PUBLISH_MS 30000   // Status heartbeat every 30 seconds
#define ALARM_COOLDOWN_MS 60000   // Water alarm cooldown (60 seconds)
#define HTTP_TIMEOUT_MS   5000    // HTTP config fetch timeout
#define SERIAL_BAUD       115200  // ESP32 debug console baud

#define MANUAL_OVERRIDE_TIMEOUT_MS 1800000  // Auto-clear manual override after 30 min

// ---- Device Identity ----
// Synced from tools/simulate.sh DEVICE_ID
#define DEVICE_ID         "HELIO_SIM_001"
#define FW_VERSION        "3.2.0"

// ---- MQTT Broker Defaults ----
// ⚠️ IMPORTANT: Change this to your backend server's IP address.
//    "localhost" will NOT work on ESP32 — it refers to the ESP32 itself.
//    For Docker: use the host machine's LAN IP (e.g., 192.168.1.100).
//    For local dev: use your computer's IP on the same WiFi network.
#define MQTT_BROKER       "192.168.1.100"   // ← CHANGE THIS
#define MQTT_PORT         1883
#define MQTT_CLIENT_ID    "helioponic_esp32_sim"

// ---- MQTT Topics ----
#define TOPIC_UPLINK            "helioponic/sensor/uplink"        // ESP32 -> Broker (QoS 0)
#define TOPIC_STATUS_UPLINK     "helioponic/status/uplink"        // ESP32 -> Broker — heartbeat (QoS 1)
#define TOPIC_ALARM_UPLINK      "helioponic/alarm/uplink"         // ESP32 -> Broker — water alarm (QoS 1)
#define TOPIC_DOWNLINK          "helioponic/config/downlink"      // Broker -> ESP32 — threshold config (QoS 1)
#define TOPIC_ACTUATOR_DOWNLINK "helioponic/actuator/downlink"    // Broker -> ESP32 — pump command (QoS 1)
#define TOPIC_NIGHT_MODE        "helioponic/night_mode/downlink"  // Broker -> ESP32 — night mode (QoS 1)

// ---- HTTP Config Endpoint ----
#define API_BASE_URL          "http://192.168.1.100:8000/api/v1"
#define CONFIG_ENDPOINT       "/devices/config?device_id="

// =============================================================================
// GLOBAL STATE
// =============================================================================

// ---- Calibration constants (runtime-configurable) ----
float TDS_FACTOR_RUNTIME = TDS_FACTOR;
float PH_SLOPE_RUNTIME   = PH_SLOPE;
float PH_INTERCEPT_RUNTIME = PH_INTERCEPT;

// ---- Sensor state ----
float current_tds = 0.0f;
float current_ph  = 0.0f;
int   jarakCm     = 0;

// ---- Pump command state ----
bool perintahPompa1 = false;     // Pump 1 command state (computed by bang-bang or MQTT)
bool perintahPompa2 = false;     // Pump 2 command state

// ---- Manual override flags — G-08: preserve MQTT commands across cycles ----
bool manualOverridePompa1 = false;
bool manualOverridePompa2 = false;
unsigned long manualOverridePompa1Time = 0;  // When override was set (for timeout)
unsigned long manualOverridePompa2Time = 0;

// ---- Arduino feedback ----
String statusPompa1DariUno = "OFF";
String statusPompa2DariUno = "OFF";

// ---- Runtime thresholds (overrideable via MQTT config downlink) ----
int   runtime_jarak_on  = JARAK_ON;
int   runtime_jarak_off = JARAK_OFF;
float runtime_tds_on    = TDS_ON;
float runtime_tds_off   = TDS_OFF;
float runtime_ph_max    = PH_MAX; // pH DOWN threshold: Pompa 2 ON when pH > this

// ---- Night Mode state — G-02 ----
bool nightModeActive = false;

// ---- Water Level Alarm state — G-03 ----
bool alarmWasActive = false;           // Rising edge tracker
unsigned long lastAlarmTime = 0;       // Cooldown timer

// ---- MQTT / WiFi globals ----
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
unsigned long lastSensorMillis = 0;
unsigned long lastPublishMillis = 0;
unsigned long lastStatusMillis = 0;
unsigned long lastMqttRetry = 0;
unsigned long lastWifiCheck = 0;

// ---- Serial ring buffer for Arduino feedback ----
#define SERIAL_BUF_SIZE 128
static char serialBuf[SERIAL_BUF_SIZE];
static int  serialIdx = 0;

// ---- Pump state change tracking (to avoid redundant Serial1 writes) ----
bool lastSentPompa1 = false;
bool lastSentPompa2 = false;

// ---- Non-blocking WiFi connection state ----
bool    wifiConnecting = false;
unsigned long wifiConnectStart = 0;
bool    configFetched = false;       // G-04 deferred — fetch only after WiFi connects
#define WIFI_CONNECT_TIMEOUT_MS  20000  // 20 second timeout per attempt

// =============================================================================
// Analog oversampling function
// =============================================================================
float readAnalogVoltage(int pin) {
  unsigned long sum = 0;
  for (int i = 0; i < ADC_OVERSAMPLE_N; i++) {
    sum += analogRead(pin);
    delayMicroseconds(100);
  }
  float avg = (float)sum / ADC_OVERSAMPLE_N;
  return avg * VREF / ADC_RESOLUTION;
}

// =============================================================================
// Flush Serial1 input buffer
// =============================================================================
void flushSerial1Input() {
  while (Serial1.available() > 0) {
    Serial1.read();
  }
}

// =============================================================================
// Serial1 line parser — read Arduino feedback (F1:/F2:)
// =============================================================================
void parseSerial1Line(const char* line) {
  if (strncmp(line, "F1:", 3) == 0) {
    statusPompa1DariUno = (strstr(line + 3, "ON") != NULL) ? "ON" : "OFF";
  } else if (strncmp(line, "F2:", 3) == 0) {
    statusPompa2DariUno = (strstr(line + 3, "ON") != NULL) ? "ON" : "OFF";
  }
}

// =============================================================================
// WiFi connection — NON-BLOCKING state machine (no delay() calls)
// =============================================================================
// Per project .rules: AVOID delay() in Arduino/ESP32 code.
// connectWiFi() initiates WiFi.begin() and returns immediately.
// The main loop calls processWiFi() each cycle to check progress.
// =============================================================================
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;  // Already connected
  if (wifiConnecting) return;                  // Already trying

  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiConnecting = true;
  wifiConnectStart = millis();
}

// Call this every loop cycle — polls WiFi status without blocking
void processWiFi(unsigned long now) {
  if (!wifiConnecting) return;

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnecting = false;
    Serial.println("\nWiFi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());

    // G-04: Fetch thresholds from backend on FIRST successful WiFi connection
    if (!configFetched) {
      configFetched = true;
      fetchConfigViaHTTP();
    }
    return;
  }

  // Timeout — give up this attempt, will retry on next loop cycle
  if (now - wifiConnectStart >= WIFI_CONNECT_TIMEOUT_MS) {
    wifiConnecting = false;
    Serial.println("\nWiFi failed — will retry later");
  } else if ((now - wifiConnectStart) % 1000 < 200) {
    // Print dot roughly every 1 second (non-blocking, approximate)
    Serial.print(".");
  }
}

// =============================================================================
// G-04: HTTP Config Fetch on Startup
// =============================================================================
void fetchConfigViaHTTP() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("HTTP config: WiFi not connected, using defaults");
    return;
  }

  HTTPClient http;
  String url = String(API_BASE_URL) + CONFIG_ENDPOINT + DEVICE_ID;
  
  Serial.print("HTTP GET: ");
  Serial.println(url);
  
  http.begin(url);
  http.setTimeout(HTTP_TIMEOUT_MS);
  int httpCode = http.GET();

  if (httpCode == 200) {
    String payload = http.getString();
    Serial.print("HTTP config response: ");
    Serial.println(payload);

    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, payload);
    if (!error) {
      if (doc.containsKey("jarak_on"))  runtime_jarak_on  = doc["jarak_on"]  | JARAK_ON;
      if (doc.containsKey("jarak_off")) runtime_jarak_off = doc["jarak_off"] | JARAK_OFF;
      if (doc.containsKey("tds_on"))    runtime_tds_on    = doc["tds_on"]    | TDS_ON;
      if (doc.containsKey("tds_off"))   runtime_tds_off   = doc["tds_off"]   | TDS_OFF;
      if (doc.containsKey("ph_max"))    runtime_ph_max    = doc["ph_max"]    | PH_MAX;

      Serial.println("Thresholds synced via HTTP:");
      Serial.print("  jarak_on = ");  Serial.println(runtime_jarak_on);
      Serial.print("  jarak_off = "); Serial.println(runtime_jarak_off);
      Serial.print("  tds_on = ");    Serial.println(runtime_tds_on);
      Serial.print("  tds_off = ");   Serial.println(runtime_tds_off);
      Serial.print("  ph_max = ");    Serial.println(runtime_ph_max);
    } else {
      Serial.print("HTTP config parse error: ");
      Serial.println(error.c_str());
    }
  } else {
    Serial.print("HTTP config failed (code: ");
    Serial.print(httpCode);
    Serial.println(") — using compile-time defaults");
  }

  http.end();
}

// =============================================================================
// MQTT connection handler
// =============================================================================
void attemptMQTT() {
  if (mqttClient.connected()) return;

  // Don't attempt MQTT if WiFi isn't connected — PubSubClient will just fail
  if (WiFi.status() != WL_CONNECTED) {
    return;  // silently skip, retry on next loop cycle
  }

  Serial.print("Connecting to MQTT at ");
  Serial.print(MQTT_BROKER);
  Serial.print(":");
  Serial.print(MQTT_PORT);
  Serial.print(" ... ");

  bool connected = false;
  if (strlen(MQTT_USER) > 0) {
    connected = mqttClient.connect(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS);
  } else {
    connected = mqttClient.connect(MQTT_CLIENT_ID);
  }

  if (connected) {
    Serial.println("connected");
    mqttClient.subscribe(TOPIC_DOWNLINK, 1);
    mqttClient.subscribe(TOPIC_ACTUATOR_DOWNLINK, 1);
    mqttClient.subscribe(TOPIC_NIGHT_MODE, 1);
    Serial.print("Subscribed to: "); Serial.println(TOPIC_DOWNLINK);
    Serial.print("Subscribed to: "); Serial.println(TOPIC_ACTUATOR_DOWNLINK);
    Serial.print("Subscribed to: "); Serial.println(TOPIC_NIGHT_MODE);
  } else {
    Serial.print("failed (rc=");
    Serial.print(mqttClient.state());
    Serial.println(") will retry");
  }
}

// =============================================================================
// Config downlink handler — threshold updates from backend
// =============================================================================
void handleConfigDownlink(const char* message) {
  Serial.print("Config downlink: ");
  Serial.println(message);

  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.print("JSON parse error: ");
    Serial.println(error.c_str());
    return;
  }

  if (doc.containsKey("jarak_on"))  runtime_jarak_on  = doc["jarak_on"]  | JARAK_ON;
  if (doc.containsKey("jarak_off")) runtime_jarak_off = doc["jarak_off"] | JARAK_OFF;
  if (doc.containsKey("tds_on"))    runtime_tds_on    = doc["tds_on"]    | TDS_ON;
  if (doc.containsKey("tds_off"))   runtime_tds_off   = doc["tds_off"]   | TDS_OFF;
  if (doc.containsKey("ph_max"))    runtime_ph_max    = doc["ph_max"]    | PH_MAX;

  Serial.println("Runtime thresholds updated:");
  Serial.print("  jarak_on = ");  Serial.println(runtime_jarak_on);
  Serial.print("  jarak_off = "); Serial.println(runtime_jarak_off);
  Serial.print("  tds_on = ");    Serial.println(runtime_tds_on);
  Serial.print("  tds_off = ");   Serial.println(runtime_tds_off);
  Serial.print("  ph_max = ");    Serial.println(runtime_ph_max);
}

// =============================================================================
// G-09: Calibration downlink handler
// =============================================================================
void handleCalibrationDownlink(const char* message) {
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) return;  // Silently ignore if no calibration fields

  bool updated = false;
  if (doc.containsKey("tds_factor")) {
    TDS_FACTOR_RUNTIME = doc["tds_factor"];
    updated = true;
  }
  if (doc.containsKey("ph_slope")) {
    PH_SLOPE_RUNTIME = doc["ph_slope"];
    updated = true;
  }
  if (doc.containsKey("ph_intercept")) {
    PH_INTERCEPT_RUNTIME = doc["ph_intercept"];
    updated = true;
  }

  if (updated) {
    Serial.println("Calibration updated:");
    Serial.print("  tds_factor = ");   Serial.println(TDS_FACTOR_RUNTIME);
    Serial.print("  ph_slope = ");     Serial.println(PH_SLOPE_RUNTIME);
    Serial.print("  ph_intercept = "); Serial.println(PH_INTERCEPT_RUNTIME);
  }
}

// =============================================================================
// G-02: Night mode downlink handler
// =============================================================================
void handleNightModeDownlink(const char* message) {
  Serial.print("Night mode downlink: ");
  Serial.println(message);

  StaticJsonDocument<128> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.print("JSON parse error: ");
    Serial.println(error.c_str());
    return;
  }

  bool active = doc["active"] | false;
  nightModeActive = active;

  if (active) {
    Serial.println("🌙 NIGHT MODE ACTIVATED — all pumps OFF, automation paused");
    // Immediately turn off all pumps
    perintahPompa1 = false;
    perintahPompa2 = false;
    manualOverridePompa1 = false;
    manualOverridePompa2 = false;
    flushSerial1Input();
    Serial1.println("P1:0");
    Serial1.println("P2:0");
  } else {
    Serial.println("☀️ NIGHT MODE DEACTIVATED — automation resumed");
    // Restore thresholds if provided in the payload
    if (doc.containsKey("jarak_on"))  runtime_jarak_on  = doc["jarak_on"]  | JARAK_ON;
    if (doc.containsKey("jarak_off")) runtime_jarak_off = doc["jarak_off"] | JARAK_OFF;
    if (doc.containsKey("tds_on"))    runtime_tds_on    = doc["tds_on"]    | TDS_ON;
    if (doc.containsKey("tds_off"))   runtime_tds_off   = doc["tds_off"]   | TDS_OFF;
    if (doc.containsKey("ph_max"))    runtime_ph_max    = doc["ph_max"]    | PH_MAX;
  }
}

// =============================================================================
// Actuator downlink handler — pump commands from mobile app
// =============================================================================
void handleActuatorCommand(const char* message) {
  Serial.print("Actuator command: ");
  Serial.println(message);

  StaticJsonDocument<128> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.print("JSON parse error: ");
    Serial.println(error.c_str());
    return;
  }

  const char* pump = doc["pump"] | "";
  int state = doc["state"] | 0;

  if (strlen(pump) == 0) {
    Serial.println("No pump field in actuator command");
    return;
  }

  Serial.print("Pump: ");
  Serial.print(pump);
  Serial.print(" -> ");
  Serial.println(state ? "ON" : "OFF");

  // Map pump name to Serial1 protocol and set manual override flag
  if (strcmp(pump, "pompa1") == 0 || strcmp(pump, "circ") == 0) {
    perintahPompa1 = (state == 1);
    manualOverridePompa1 = true;  // G-08: Preserve override
    flushSerial1Input();
    Serial1.print("P1:");
    Serial1.println(state ? "1" : "0");
  } else if (strcmp(pump, "pompa2") == 0 || strcmp(pump, "ph_d") == 0) {
    perintahPompa2 = (state == 1);
    manualOverridePompa2 = true;  // G-08: Preserve override
    flushSerial1Input();
    Serial1.print("P2:");
    Serial1.println(state ? "1" : "0");
  } else {
    Serial.println("Unknown pump — ignoring");
  }
}

// =============================================================================
// Route MQTT messages by topic
// =============================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char message[length + 1];
  memcpy(message, payload, length);
  message[length] = '\0';

  if (strcmp(topic, TOPIC_ACTUATOR_DOWNLINK) == 0) {
    handleActuatorCommand(message);
    return;
  }

  if (strcmp(topic, TOPIC_NIGHT_MODE) == 0) {
    handleNightModeDownlink(message);
    return;
  }

  // TOPIC_DOWNLINK — also check for calibration fields
  handleConfigDownlink(message);
  handleCalibrationDownlink(message);
}

// =============================================================================
// G-01 + G-08: Independent bang-bang automation with manual override
// Manual overrides auto-clear after MANUAL_OVERRIDE_TIMEOUT_MS (30 min).
// =============================================================================
void clearExpiredManualOverrides(unsigned long now) {
  if (manualOverridePompa1 && (now - manualOverridePompa1Time >= MANUAL_OVERRIDE_TIMEOUT_MS)) {
    manualOverridePompa1 = false;
    Serial.println("OVERRIDE: pompa1 override expired — returning to auto mode");
  }
  if (manualOverridePompa2 && (now - manualOverridePompa2Time >= MANUAL_OVERRIDE_TIMEOUT_MS)) {
    manualOverridePompa2 = false;
    Serial.println("OVERRIDE: pompa2 override expired — returning to auto mode");
  }
}

void runBangBangAutomation() {
  // Night mode check — G-02: skip automation if night mode active
  if (nightModeActive) {
    return;
  }

  bool ultrasonikValid = (jarakCm != 999 && jarakCm > 0);

  // =====================================================================
  // PRIORITY 1: Pompa 1 — Water Level Control (jarak_cm only)
  // =====================================================================
  if (!manualOverridePompa1 && ultrasonikValid) {
    if (jarakCm > runtime_jarak_on) {
      // Water too low → turn pump ON
      if (!perintahPompa1) {
        perintahPompa1 = true;
        Serial.print("AUTO-WATER: jarak=");
        Serial.print(jarakCm);
        Serial.print(">");
        Serial.print(runtime_jarak_on);
        Serial.println(" → pompa1=ON");
      }
    } else if (jarakCm < runtime_jarak_off) {
      // Water sufficient → turn pump OFF
      if (perintahPompa1) {
        perintahPompa1 = false;
        Serial.print("AUTO-WATER: jarak=");
        Serial.print(jarakCm);
        Serial.print("<");
        Serial.print(runtime_jarak_off);
        Serial.println(" → pompa1=OFF");
      }
    }
    // else: within deadband (jarak_off <= jarak_cm <= jarak_on) → no change
  }

  // =====================================================================
  // PRIORITY 2: Pompa 2 — pH DOWN OR TDS/Nutrient Dosing
  // =====================================================================
  // 💡 Sistem hanya punya pompa pH DOWN (satu arah).
  //   pH DOWN: Pompa 2 ON ketika pH > ph_max (pH terlalu tinggi)
  //   TDS:     Pompa 2 ON ketika TDS < tds_on (nutrisi habis)
  //   Priority: pH DOWN > TDS (pH lebih kritis)
  //
  // tds_on  = LOW  threshold — ON  when TDS drops below this
  // tds_off = HIGH threshold — OFF when TDS rises above this
  // Hysteresis: tds_off > tds_on (deadband between them)
  //
  // CORRECTED LOGIC (PRD v3.2):
  //   - When TDS is LOW → nutrients depleted → dosing pump ON
  //   - When TDS is HIGH → nutrients sufficient → dosing pump OFF
  if (!manualOverridePompa2) {
    bool phDownNeeded = (current_ph > runtime_ph_max);

    if (phDownNeeded) {
      // ═══ pH DOWN: pH too HIGH → Pompa 2 ON (higher priority than TDS) ═══
      if (!perintahPompa2) {
        perintahPompa2 = true;
        Serial.print("AUTO-PH: ph=");
        Serial.print(current_ph, 1);
        Serial.print(">");
        Serial.print(runtime_ph_max, 1);
        Serial.println(" → pompa2=ON (pH DOWN)");
      }
    } else {
      // ═══ pH OK (≤ ph_max) — fall back to TDS control ═══
      if (current_tds < runtime_tds_on) {
        // Nutrients too low → turn dosing pump ON
        if (!perintahPompa2) {
          perintahPompa2 = true;
          Serial.print("AUTO-TDS: tds=");
          Serial.print(current_tds, 0);
          Serial.print("<");
          Serial.print(runtime_tds_on, 0);
          Serial.println(" → pompa2=ON");
        }
      } else if (current_tds > runtime_tds_off) {
        // Nutrients sufficient → turn dosing pump OFF
        if (perintahPompa2) {
          perintahPompa2 = false;
          Serial.print("AUTO-TDS: tds=");
          Serial.print(current_tds, 0);
          Serial.print(">");
          Serial.print(runtime_tds_off, 0);
          Serial.println(" → pompa2=OFF");
        }
      }
      // else: within deadband (tds_on <= current_tds <= tds_off) → no change
    }
  }
}

// =============================================================================
// G-03: Water Level Alarm — rising edge detection + 60s cooldown
// =============================================================================
void checkWaterAlarm(unsigned long now) {
  bool currentlyAlarming = (jarakCm == 999);

  // Rising edge: transitioning from normal to alarm state
  if (currentlyAlarming && !alarmWasActive) {
    // Check cooldown (60 seconds since last alarm)
    if (now - lastAlarmTime >= ALARM_COOLDOWN_MS) {
      lastAlarmTime = now;

      Serial.println("🚨 WATER LEVEL ALARM — ultrasonic out of range!");

      // Publish to alarm/uplink topic
      StaticJsonDocument<128> doc;
      doc["device_id"] = DEVICE_ID;
      doc["alarm_type"] = "water_level";
      doc["message"] = "Water level critical — ultrasonic out of range (jarak_cm=999)";
      doc["ts"] = time(nullptr);

      char buffer[128];
      serializeJson(doc, buffer);
      mqttClient.publish(TOPIC_ALARM_UPLINK, buffer, true);
      Serial.print("Published alarm: ");
      Serial.println(buffer);
    }
  }

  alarmWasActive = currentlyAlarming;
}

// =============================================================================
// Publish sensor data to MQTT
// =============================================================================
void publishSensorData() {
  StaticJsonDocument<256> doc;

  doc["device_id"]  = DEVICE_ID;
  doc["ts"]         = time(nullptr);
  doc["jarak_cm"]   = jarakCm;
  doc["tds_value"]  = current_tds;
  doc["current_ph"] = current_ph;
  doc["pompa1"]     = (statusPompa1DariUno == "ON") ? 1 : 0;
  doc["pompa2"]     = (statusPompa2DariUno == "ON") ? 1 : 0;

  char buffer[256];
  size_t len = serializeJson(doc, buffer);

  if (mqttClient.publish(TOPIC_UPLINK, buffer, false)) {
    Serial.print("Published: ");
    Serial.println(buffer);
  } else {
    Serial.print("MQTT publish FAILED (WiFi=");
    Serial.print(WiFi.status() == WL_CONNECTED ? "OK" : "DOWN");
    Serial.print(", MQTT=");
    Serial.print(mqttClient.connected() ? "connected" : "disconnected");
    Serial.print(", broker=");
    Serial.print(MQTT_BROKER);
    Serial.println(")");
  }
}

// =============================================================================
// G-06: Publish status heartbeat every 30 seconds
// =============================================================================
void publishStatusHeartbeat(unsigned long now) {
  if (now - lastStatusMillis < STATUS_PUBLISH_MS) return;
  lastStatusMillis = now;

  StaticJsonDocument<128> doc;
  doc["device_id"] = DEVICE_ID;
  doc["status"] = "online";
  doc["ts"] = time(nullptr);
  doc["version"] = FW_VERSION;
  doc["night_mode"] = nightModeActive ? 1 : 0;
  doc["wifi_rssi"] = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : -100;

  char buffer[128];
  serializeJson(doc, buffer);
  mqttClient.publish(TOPIC_STATUS_UPLINK, buffer, true);
  Serial.print("Heartbeat: ");
  Serial.println(buffer);
}

// =============================================================================
// Send pump commands to Arduino via Serial1 (ONLY when state actually changed)
// =============================================================================
void sendPumpCommands() {
  if (perintahPompa1 != lastSentPompa1) {
    lastSentPompa1 = perintahPompa1;
    flushSerial1Input();
    Serial1.print("P1:");
    Serial1.println(perintahPompa1 ? "1" : "0");
  }
  if (perintahPompa2 != lastSentPompa2) {
    lastSentPompa2 = perintahPompa2;
    flushSerial1Input();
    Serial1.print("P2:");
    Serial1.println(perintahPompa2 ? "1" : "0");
  }
}

// =============================================================================
// Read Arduino feedback from Serial1 (NON-BLOCKING — reads available bytes only)
// =============================================================================
void readArduinoFeedback() {
  // Non-blocking: only process what's already in the buffer
  while (Serial1.available() > 0) {
    char c = Serial1.read();
    if (c == '\n') {
      serialBuf[serialIdx] = '\0';
      if (serialIdx > 0) parseSerial1Line(serialBuf);
      serialIdx = 0;
    } else if (serialIdx < SERIAL_BUF_SIZE - 1) {
      serialBuf[serialIdx++] = c;
    }
  }
}

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(100);  // Brief pause for Serial to stabilize

  // ---- Serial1 for Arduino Uno communication ----
  Serial1.begin(9600, SERIAL_8N1, RX1_PIN, TX1_PIN);

  // ---- Sensor pin setup (all pinModes here, never in loop) ----
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(TDS_SENSOR_PIN, INPUT);
  pinMode(PH_SENSOR_PIN, INPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(TDS_SENSOR_PIN, ADC_11db);
  analogSetPinAttenuation(PH_SENSOR_PIN, ADC_11db);

  // ---- WiFi + NTP + MQTT (config fetch deferred to processWiFi) ----
  connectWiFi();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);

  Serial.print("Helioponic ESP32 v");
  Serial.print(FW_VERSION);
  Serial.println(" SYSTEM READY (Independent Pumps + Night Mode + Alarm + MQTT)");
}

// =============================================================================
// MAIN LOOP — G-07: 200ms cycle
// =============================================================================
void loop() {
  unsigned long now = millis();

  // ---- Maintain WiFi (non-blocking state machine) ----
  if (now - lastWifiCheck >= 30000) {
    lastWifiCheck = now;
    if (WiFi.status() != WL_CONNECTED) connectWiFi();
  }
  processWiFi(now);  // Poll connection progress (non-blocking)

  // ---- Maintain MQTT ----
  if (!mqttClient.connected()) {
    if (now - lastMqttRetry >= MQTT_RECONNECT_MS) {
      lastMqttRetry = now;
      attemptMQTT();
    }
  }
  mqttClient.loop();

  // ---- Sensor loop every SENSOR_LOOP_MS (200ms) ----
  if (now - lastSensorMillis >= SENSOR_LOOP_MS) {
    lastSensorMillis = now;

    // ========== 1. BACA ULTRASONIK (jarak air) ==========
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);

    long durasi = pulseIn(ECHO_PIN, HIGH, 30000);
    jarakCm = durasi * 0.034 / 2;
    if (jarakCm > 7 || jarakCm <= 0) jarakCm = 999;  // Out of range (tank depth is 7cm)

    // ========== 2. BACA TDS ==========
    delayMicroseconds(200);
    float tds_voltage = readAnalogVoltage(TDS_SENSOR_PIN);

    float tds_value = 0.0f;
    if (tds_voltage > 0.10f) {
      float compensationCoefficient = 1.0f + 0.02f * (TEMPERATURE - 25.0f);
      float compensationVoltage = tds_voltage / compensationCoefficient;
      float ec = (133.42f * pow(compensationVoltage, 3)
                  - 255.86f * pow(compensationVoltage, 2)
                  + 857.39f * compensationVoltage);
      tds_value = ec * TDS_FACTOR_RUNTIME;
      if (tds_value < 0.0f) tds_value = 0.0f;
    }
    current_tds = tds_value;

    // ========== 3. BACA pH ==========
    delayMicroseconds(200);
    float ph_voltage = readAnalogVoltage(PH_SENSOR_PIN);
    current_ph = PH_SLOPE_RUNTIME * ph_voltage + PH_INTERCEPT_RUNTIME;
    if (current_ph < 0) current_ph = 0;
    if (current_ph > 14) current_ph = 14;

    // ========== 4. CLEAR EXPIRED MANUAL OVERRIDES ==========
    clearExpiredManualOverrides(now);

    // ========== 5. G-01: INDEPENDENT BANG-BANG AUTOMATION ==========
    runBangBangAutomation();

    // ========== 5. KIRIM PERINTAH KE ARDUINO via Serial1 ==========
    sendPumpCommands();

    // ========== 6. BACA FEEDBACK dari Arduino ==========
    readArduinoFeedback();

    // ========== 7. G-03: WATER LEVEL ALARM CHECK ==========
    checkWaterAlarm(now);
  }

  // ---- Publish sensor data every MQTT_PUBLISH_MS (1 second / ~5 cycles) ----
  if (now - lastPublishMillis >= MQTT_PUBLISH_MS) {
    lastPublishMillis = now;
    publishSensorData();
  }

  // ---- G-06: Status heartbeat every 30 seconds ----
  publishStatusHeartbeat(now);
}
