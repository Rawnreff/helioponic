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
//         - Pompa 2 (pH DOWN): controlled by current_ph only
//         - Pompa 3 & 4 (Nutrient A+B Dosing): BOTH controlled by tds_value (tandem)
//   3. Send pump commands to Arduino (P1:/P2:/P3:/P4:) via Serial1
//   4. Read pump feedback (F1:/F2:/F3:/F4:) from Arduino via Serial1
//   5. Package all data as JSON and publish to MQTT topic
//   6. Subscribe to MQTT downlinks for config, actuator, night mode
//   7. Publish heartbeat status every 30s
//   8. Detect water level alarm (rising edge on jarak_cm==999)
//
// 4-Pump Bang-Bang Hysteresis Logic (matches backend automation.py):
//   - Pompa 1 (Water Level):  ON when jarak_cm > jarak_on,  OFF when jarak_cm < jarak_off
//   - Pompa 2 (pH DOWN):       ON when current_ph > ph_max,  OFF when current_ph < ph_min
//   - Pompa 3+4 (Nutrient A+B): BOTH ON simultaneously when tds < tds_on, BOTH OFF when tds > tds_off
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
//   Publish:  helioponic/sensor/uplink     - JSON sensor + pump states (QoS 0, 1s)
//   Publish:  helioponic/status/uplink     - Device heartbeat (QoS 1, 30s)
//   Publish:  helioponic/alarm/uplink      - Water alarm event (QoS 1, on-event)
//   Subscribe: helioponic/config/downlink   - Threshold updates (QoS 1)
//   Subscribe: helioponic/actuator/downlink - Pump commands (QoS 1)
//   Subscribe: helioponic/night_mode/downlink - Night mode toggle (QoS 1)
//
// Startup Sequence:
//   1. Init hardware (relay OFF, serial comm)
//   2. Connect WiFi
//   3. HTTP GET /api/v1/devices/config?device_id=X - fetch thresholds
//   4. Fallback to compile-time defaults if HTTP fails
//   5. Connect to MQTT broker, subscribe to all downlink topics
//   6. Publish status heartbeat (online)
//   7. Enter main loop
//
// Warning: Credentials are placeholders - copy to helioponic_esp32.ino and fill in.
// =============================================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>

// =============================================================================
// CREDENTIALS - Replace these with your own values
// =============================================================================
#define WIFI_SSID        "YourWiFiSSID"
#define WIFI_PASSWORD    "YourWiFiPassword"
#define MQTT_USER        "helioponic"
#define MQTT_PASS        "helioponic_mqtt_2024"

// =============================================================================
// HARDWARE CONFIGURATION
// =============================================================================

#define TRIG_PIN          12
#define ECHO_PIN          13
#define TDS_SENSOR_PIN    4
#define PH_SENSOR_PIN     5
#define TX1_PIN           17
#define RX1_PIN           18

#define VREF              3.3f
#define ADC_RESOLUTION    4095.0f
#define TDS_FACTOR        0.50f
#define TEMPERATURE       25.0f
#define PH_SLOPE          -5.70f
#define PH_INTERCEPT      21.34f

#define JARAK_ON          5
#define JARAK_OFF         2
#define TDS_ON            95
#define TDS_OFF           105
#define PH_MAX            6.5
#define PH_MIN            5.5

#define ADC_OVERSAMPLE_N  16
#define SENSOR_LOOP_MS    200
#define MQTT_PUBLISH_MS   1000
#define MQTT_RECONNECT_MS 5000
#define STATUS_PUBLISH_MS 30000
#define ALARM_COOLDOWN_MS 60000
#define HTTP_TIMEOUT_MS   5000
#define SERIAL_BAUD       115200
#define MANUAL_OVERRIDE_TIMEOUT_MS 1800000

#define DEVICE_ID         "HELIO_SIM_001"
#define FW_VERSION        "3.3.0"

#define MQTT_BROKER       "192.168.1.100"
#define MQTT_PORT         1883
#define MQTT_CLIENT_ID    "helioponic_esp32_sim"

#define TOPIC_UPLINK            "helioponic/sensor/uplink"
#define TOPIC_STATUS_UPLINK     "helioponic/status/uplink"
#define TOPIC_ALARM_UPLINK      "helioponic/alarm/uplink"
#define TOPIC_DOWNLINK          "helioponic/config/downlink"
#define TOPIC_ACTUATOR_DOWNLINK "helioponic/actuator/downlink"
#define TOPIC_NIGHT_MODE        "helioponic/night_mode/downlink"

#define API_BASE_URL          "http://192.168.1.100:8000/api/v1"
#define CONFIG_ENDPOINT       "/devices/config?device_id="

// =============================================================================
// GLOBAL STATE
// =============================================================================

float TDS_FACTOR_RUNTIME = TDS_FACTOR;
float PH_SLOPE_RUNTIME   = PH_SLOPE;
float PH_INTERCEPT_RUNTIME = PH_INTERCEPT;

float current_tds = 0.0f;
float current_ph  = 0.0f;
int   jarakCm     = 0;

bool perintahPompa1 = false;
bool perintahPompa2 = false;
bool perintahPompa3 = false;
bool perintahPompa4 = false;

bool manualOverridePompa1 = false;
bool manualOverridePompa2 = false;
bool manualOverridePompa3 = false;
bool manualOverridePompa4 = false;
unsigned long manualOverridePompa1Time = 0;
unsigned long manualOverridePompa2Time = 0;
unsigned long manualOverridePompa3Time = 0;
unsigned long manualOverridePompa4Time = 0;

String statusPompa1DariUno = "OFF";
String statusPompa2DariUno = "OFF";
String statusPompa3DariUno = "OFF";
String statusPompa4DariUno = "OFF";

int   runtime_jarak_on  = JARAK_ON;
int   runtime_jarak_off = JARAK_OFF;
float runtime_tds_on    = TDS_ON;
float runtime_tds_off   = TDS_OFF;
float runtime_ph_max    = PH_MAX;
float runtime_ph_min    = PH_MIN;

bool nightModeActive = false;
bool alarmWasActive = false;
unsigned long lastAlarmTime = 0;

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
unsigned long lastSensorMillis = 0;
unsigned long lastPublishMillis = 0;
unsigned long lastStatusMillis = 0;
unsigned long lastMqttRetry = 0;
unsigned long lastWifiCheck = 0;

#define SERIAL_BUF_SIZE 128
static char serialBuf[SERIAL_BUF_SIZE];
static int  serialIdx = 0;

bool lastSentPompa1 = false;
bool lastSentPompa2 = false;
bool lastSentPompa3 = false;
bool lastSentPompa4 = false;

bool    wifiConnecting = false;
unsigned long wifiConnectStart = 0;
bool    configFetched = false;
#define WIFI_CONNECT_TIMEOUT_MS  20000

// =============================================================================
// Helper functions
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

void flushSerial1Input() {
  while (Serial1.available() > 0) {
    Serial1.read();
  }
}

void parseSerial1Line(const char* line) {
  if (strncmp(line, "F1:", 3) == 0) {
    statusPompa1DariUno = (strstr(line + 3, "ON") != NULL) ? "ON" : "OFF";
  } else if (strncmp(line, "F2:", 3) == 0) {
    statusPompa2DariUno = (strstr(line + 3, "ON") != NULL) ? "ON" : "OFF";
  } else if (strncmp(line, "F3:", 3) == 0) {
    statusPompa3DariUno = (strstr(line + 3, "ON") != NULL) ? "ON" : "OFF";
  } else if (strncmp(line, "F4:", 3) == 0) {
    statusPompa4DariUno = (strstr(line + 3, "ON") != NULL) ? "ON" : "OFF";
  }
}

// =============================================================================
// WiFi
// =============================================================================

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (wifiConnecting) return;
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiConnecting = true;
  wifiConnectStart = millis();
}

void processWiFi(unsigned long now) {
  if (!wifiConnecting) return;
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnecting = false;
    Serial.println("\nWiFi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
    if (!configFetched) {
      configFetched = true;
      fetchConfigViaHTTP();
    }
    return;
  }
  if (now - wifiConnectStart >= WIFI_CONNECT_TIMEOUT_MS) {
    wifiConnecting = false;
    Serial.println("\nWiFi failed - will retry later");
  } else if ((now - wifiConnectStart) % 1000 < 200) {
    Serial.print(".");
  }
}

// =============================================================================
// HTTP Config Fetch
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
      if (doc.containsKey("ph_min"))    runtime_ph_min    = doc["ph_min"]    | PH_MIN;
      Serial.println("Thresholds synced via HTTP");
    } else {
      Serial.print("HTTP config parse error: ");
      Serial.println(error.c_str());
    }
  } else {
    Serial.print("HTTP config failed (code: ");
    Serial.print(httpCode);
    Serial.println(") - using compile-time defaults");
  }
  http.end();
}

// =============================================================================
// MQTT
// =============================================================================

void attemptMQTT() {
  if (mqttClient.connected()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.print("Connecting to MQTT... ");
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
  } else {
    Serial.print("failed (rc=");
    Serial.print(mqttClient.state());
    Serial.println(") will retry");
  }
}

// =============================================================================
// Downlink handlers
// =============================================================================

void handleConfigDownlink(const char* message) {
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) return;
  if (doc.containsKey("jarak_on"))  runtime_jarak_on  = doc["jarak_on"]  | JARAK_ON;
  if (doc.containsKey("jarak_off")) runtime_jarak_off = doc["jarak_off"] | JARAK_OFF;
  if (doc.containsKey("tds_on"))    runtime_tds_on    = doc["tds_on"]    | TDS_ON;
  if (doc.containsKey("tds_off"))   runtime_tds_off   = doc["tds_off"]   | TDS_OFF;
  if (doc.containsKey("ph_max"))    runtime_ph_max    = doc["ph_max"]    | PH_MAX;
  if (doc.containsKey("ph_min"))    runtime_ph_min    = doc["ph_min"]    | PH_MIN;
  Serial.println("Config downlink processed");
}

void handleCalibrationDownlink(const char* message) {
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) return;
  bool updated = false;
  if (doc.containsKey("tds_factor")) { TDS_FACTOR_RUNTIME = doc["tds_factor"]; updated = true; }
  if (doc.containsKey("ph_slope")) { PH_SLOPE_RUNTIME = doc["ph_slope"]; updated = true; }
  if (doc.containsKey("ph_intercept")) { PH_INTERCEPT_RUNTIME = doc["ph_intercept"]; updated = true; }
  if (updated) Serial.println("Calibration updated");
}

void handleNightModeDownlink(const char* message) {
  StaticJsonDocument<128> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) return;
  bool active = doc["active"] | false;
  nightModeActive = active;
  if (active) {
    Serial.println("NIGHT MODE ACTIVATED");
    perintahPompa1 = false; perintahPompa2 = false;
    perintahPompa3 = false; perintahPompa4 = false;
    manualOverridePompa1 = false; manualOverridePompa2 = false;
    manualOverridePompa3 = false; manualOverridePompa4 = false;
    flushSerial1Input();
    Serial1.println("P1:0"); Serial1.println("P2:0");
    Serial1.println("P3:0"); Serial1.println("P4:0");
  } else {
    Serial.println("NIGHT MODE DEACTIVATED");
    if (doc.containsKey("jarak_on"))  runtime_jarak_on  = doc["jarak_on"]  | JARAK_ON;
    if (doc.containsKey("jarak_off")) runtime_jarak_off = doc["jarak_off"] | JARAK_OFF;
    if (doc.containsKey("tds_on"))    runtime_tds_on    = doc["tds_on"]    | TDS_ON;
    if (doc.containsKey("tds_off"))   runtime_tds_off   = doc["tds_off"]   | TDS_OFF;
    if (doc.containsKey("ph_max"))    runtime_ph_max    = doc["ph_max"]    | PH_MAX;
  }
}

void handleActuatorCommand(const char* message) {
  StaticJsonDocument<128> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) return;
  const char* pump = doc["pump"] | "";
  int state = doc["state"] | 0;
  if (strlen(pump) == 0) return;

  if (strcmp(pump, "pompa1") == 0 || strcmp(pump, "circ") == 0) {
    perintahPompa1 = (state == 1);
    manualOverridePompa1 = true; manualOverridePompa1Time = millis();
    flushSerial1Input(); Serial1.print("P1:"); Serial1.println(state ? "1" : "0");
  } else if (strcmp(pump, "pompa2") == 0 || strcmp(pump, "ph_d") == 0) {
    perintahPompa2 = (state == 1);
    manualOverridePompa2 = true; manualOverridePompa2Time = millis();
    flushSerial1Input(); Serial1.print("P2:"); Serial1.println(state ? "1" : "0");
  } else if (strcmp(pump, "pompa3") == 0 || strcmp(pump, "nut_a") == 0) {
    perintahPompa3 = (state == 1);
    manualOverridePompa3 = true; manualOverridePompa3Time = millis();
    flushSerial1Input(); Serial1.print("P3:"); Serial1.println(state ? "1" : "0");
  } else if (strcmp(pump, "pompa4") == 0 || strcmp(pump, "nut_b") == 0) {
    perintahPompa4 = (state == 1);
    manualOverridePompa4 = true; manualOverridePompa4Time = millis();
    flushSerial1Input(); Serial1.print("P4:"); Serial1.println(state ? "1" : "0");
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char message[length + 1];
  memcpy(message, payload, length);
  message[length] = '\0';
  if (strcmp(topic, TOPIC_ACTUATOR_DOWNLINK) == 0) { handleActuatorCommand(message); return; }
  if (strcmp(topic, TOPIC_NIGHT_MODE) == 0) { handleNightModeDownlink(message); return; }
  handleConfigDownlink(message);
  handleCalibrationDownlink(message);
}

// =============================================================================
// 4-Pump Bang-Bang Automation + Override Management
// =============================================================================

void clearExpiredManualOverrides(unsigned long now) {
  if (manualOverridePompa1 && (now - manualOverridePompa1Time >= MANUAL_OVERRIDE_TIMEOUT_MS)) {
    manualOverridePompa1 = false; Serial.println("OVERRIDE: pompa1 expired");
  }
  if (manualOverridePompa2 && (now - manualOverridePompa2Time >= MANUAL_OVERRIDE_TIMEOUT_MS)) {
    manualOverridePompa2 = false; Serial.println("OVERRIDE: pompa2 expired");
  }
  if (manualOverridePompa3 && (now - manualOverridePompa3Time >= MANUAL_OVERRIDE_TIMEOUT_MS)) {
    manualOverridePompa3 = false; Serial.println("OVERRIDE: pompa3 expired");
  }
  if (manualOverridePompa4 && (now - manualOverridePompa4Time >= MANUAL_OVERRIDE_TIMEOUT_MS)) {
    manualOverridePompa4 = false; Serial.println("OVERRIDE: pompa4 expired");
  }
}

void runBangBangAutomation() {
  if (nightModeActive) return;
  bool ultrasonikValid = (jarakCm != 999 && jarakCm > 0);

  // Pompa 1 - Water Level (bang-bang hysteresis)
  if (!manualOverridePompa1 && ultrasonikValid) {
    if (jarakCm > runtime_jarak_on) {
      if (!perintahPompa1) {
        perintahPompa1 = true;
        Serial.print("AUTO-P1: jarak="); Serial.print(jarakCm);
        Serial.print(">"); Serial.print(runtime_jarak_on);
        Serial.println(" -> pompa1=ON");
      }
    } else if (jarakCm < runtime_jarak_off) {
      if (perintahPompa1) {
        perintahPompa1 = false;
        Serial.print("AUTO-P1: jarak="); Serial.print(jarakCm);
        Serial.print("<"); Serial.print(runtime_jarak_off);
        Serial.println(" -> pompa1=OFF");
      }
    }
  }

  // Pompa 2 - pH DOWN (bang-bang hysteresis)
  // ON when pH > ph_max, OFF when pH < ph_min. Deadband in between.
  if (!manualOverridePompa2) {
    if (current_ph > runtime_ph_max) {
      if (!perintahPompa2) {
        perintahPompa2 = true;
        Serial.print("AUTO-P2: pH="); Serial.print(current_ph, 1);
        Serial.print(">"); Serial.print(runtime_ph_max, 1);
        Serial.println(" -> pompa2=ON (pH DOWN)");
      }
    } else if (current_ph < runtime_ph_min) {
      if (perintahPompa2) {
        perintahPompa2 = false;
        Serial.print("AUTO-P2: pH="); Serial.print(current_ph, 1);
        Serial.print("<"); Serial.print(runtime_ph_min, 1);
        Serial.println(" -> pompa2=OFF (pH OK)");
      }
    }
  }

  // Pompa 3 & 4 - TANDEM TDS Nutrient Dosing
  // Both ON simultaneously when tds < tds_on, both OFF when tds > tds_off.
  if (!manualOverridePompa3 && !manualOverridePompa4) {
    if (current_tds < runtime_tds_on) {
      if (!perintahPompa3 || !perintahPompa4) {
        perintahPompa3 = true;
        perintahPompa4 = true;
        Serial.print("AUTO-TDS: tds="); Serial.print(current_tds, 0);
        Serial.print("<"); Serial.print(runtime_tds_on, 0);
        Serial.println(" -> pompa3+4=ON (Nutrient A+B)");
      }
    } else if (current_tds > runtime_tds_off) {
      if (perintahPompa3 || perintahPompa4) {
        perintahPompa3 = false;
        perintahPompa4 = false;
        Serial.print("AUTO-TDS: tds="); Serial.print(current_tds, 0);
        Serial.print(">"); Serial.print(runtime_tds_off, 0);
        Serial.println(" -> pompa3+4=OFF");
      }
    }
  }
}

// =============================================================================
// Water Level Alarm
// =============================================================================

void checkWaterAlarm(unsigned long now) {
  bool currentlyAlarming = (jarakCm == 999);
  if (currentlyAlarming && !alarmWasActive) {
    if (now - lastAlarmTime >= ALARM_COOLDOWN_MS) {
      lastAlarmTime = now;
      Serial.println("WATER LEVEL ALARM");
      StaticJsonDocument<128> doc;
      doc["device_id"] = DEVICE_ID;
      doc["alarm_type"] = "water_level";
      doc["message"] = "Water level critical - ultrasonic out of range";
      doc["ts"] = time(nullptr);
      char buffer[128];
      serializeJson(doc, buffer);
      mqttClient.publish(TOPIC_ALARM_UPLINK, buffer, true);
    }
  }
  alarmWasActive = currentlyAlarming;
}

// =============================================================================
// Publish functions
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
  doc["pompa3"]     = (statusPompa3DariUno == "ON") ? 1 : 0;
  doc["pompa4"]     = (statusPompa4DariUno == "ON") ? 1 : 0;
  char buffer[256];
  serializeJson(doc, buffer);
  mqttClient.publish(TOPIC_UPLINK, buffer, false);
}

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
}

// =============================================================================
// Serial communication with Arduino
// =============================================================================

void sendPumpCommands() {
  if (perintahPompa1 != lastSentPompa1) {
    lastSentPompa1 = perintahPompa1;
    flushSerial1Input(); Serial1.print("P1:"); Serial1.println(perintahPompa1 ? "1" : "0");
  }
  if (perintahPompa2 != lastSentPompa2) {
    lastSentPompa2 = perintahPompa2;
    flushSerial1Input(); Serial1.print("P2:"); Serial1.println(perintahPompa2 ? "1" : "0");
  }
  if (perintahPompa3 != lastSentPompa3) {
    lastSentPompa3 = perintahPompa3;
    flushSerial1Input(); Serial1.print("P3:"); Serial1.println(perintahPompa3 ? "1" : "0");
  }
  if (perintahPompa4 != lastSentPompa4) {
    lastSentPompa4 = perintahPompa4;
    flushSerial1Input(); Serial1.print("P4:"); Serial1.println(perintahPompa4 ? "1" : "0");
  }
}

void readArduinoFeedback() {
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
  delay(100);
  Serial1.begin(9600, SERIAL_8N1, RX1_PIN, TX1_PIN);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(TDS_SENSOR_PIN, INPUT);
  pinMode(PH_SENSOR_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(TDS_SENSOR_PIN, ADC_11db);
  analogSetPinAttenuation(PH_SENSOR_PIN, ADC_11db);
  connectWiFi();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);
  Serial.print("Helioponic ESP32 v");
  Serial.print(FW_VERSION);
  Serial.println(" SYSTEM READY (4-Pump)");
}

// =============================================================================
// MAIN LOOP - 200ms sensor cycle, 1000ms publish cycle
// =============================================================================

void loop() {
  unsigned long now = millis();

  // WiFi maintenance
  if (now - lastWifiCheck >= 30000) {
    lastWifiCheck = now;
    if (WiFi.status() != WL_CONNECTED) connectWiFi();
  }
  processWiFi(now);

  // MQTT maintenance
  if (!mqttClient.connected()) {
    if (now - lastMqttRetry >= MQTT_RECONNECT_MS) {
      lastMqttRetry = now;
      attemptMQTT();
    }
  }
  mqttClient.loop();

  // Sensor loop: every 200ms
  if (now - lastSensorMillis >= SENSOR_LOOP_MS) {
    lastSensorMillis = now;

    // Read ultrasonic
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);
    long durasi = pulseIn(ECHO_PIN, HIGH, 30000);
    jarakCm = durasi * 0.034 / 2;
    if (jarakCm > 7 || jarakCm <= 0) jarakCm = 999;

    // Read TDS
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

    // Read pH
    delayMicroseconds(200);
    float ph_voltage = readAnalogVoltage(PH_SENSOR_PIN);
    current_ph = PH_SLOPE_RUNTIME * ph_voltage + PH_INTERCEPT_RUNTIME;
    if (current_ph < 0) current_ph = 0;
    if (current_ph > 14) current_ph = 14;

    // Clear expired overrides
    clearExpiredManualOverrides(now);

    // Run 4-pump bang-bang automation
    runBangBangAutomation();

    // Send commands to Arduino (Serial1)
    sendPumpCommands();

    // Read feedback from Arduino (Serial1)
    readArduinoFeedback();

    // Check water level alarm
    checkWaterAlarm(now);
  }

  // Publish loop: every 1000ms (5 sensor cycles)
  if (now - lastPublishMillis >= MQTT_PUBLISH_MS) {
    lastPublishMillis = now;
    publishSensorData();
  }

  // Status heartbeat: every 30s
  publishStatusHeartbeat(now);
}
