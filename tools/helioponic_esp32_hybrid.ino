// =============================================================================
// Helioponic — ESP32 Firmware (HYBRID TESTING - OPSI 1)
// =============================================================================
// MODIFIED VERSION for hybrid testing:
//   Sensor data from simulate_hybrid.py (MQTT inject) → ESP32 → real 4 pumps
//
// Perubahan dari firmware original:
//   1. + TOPIC_INJECT      — subscribe ke "helioponic/sensor/inject"
//   2. + handleSensorInject() — parse data sensor dari simulate_hybrid.py
//   3. + injectModeActive     — flag: pakai data inject atau sensor fisik
//   4. + INJECT_TIMEOUT_MS    — fallback ke sensor fisik jika inject berhenti
//   5. Loop: skip baca pin fisik jika injectModeActive=true
//   6. Automation & pump control TETAP JALAN (bang-bang hysteresis lokal)
//
// Cara pakai:
//   1. Compile dan upload ke ESP32 seperti biasa
//   2. Jalankan simulate_hybrid.py: python tools/simulate_hybrid.py
//   3. ESP32 otomatis pakai data dari simulate_hybrid.py
//   4. 4 pompa REAL terkontrol berdasarkan automation ESP32
//   5. Jika simulate_hybrid.py mati → ESP32 fallback ke sensor fisik
//
// =============================================================================
// This file is a MODIFIED TEMPLATE for hybrid testing.
// For production, use the original helioponic_esp32.example.ino instead.
// =============================================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>

// =============================================================================
// CREDENTIALS - Replace these with your own values
// =============================================================================
#define WIFI_SSID        "CesarioZlatanRazka"
#define WIFI_PASSWORD    "291206wedding"
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
#define TANK_DEPTH_CM     32.0   // cm — total reservoir depth (sensor-to-bottom, configurable)

#define ADC_OVERSAMPLE_N  16
#define SENSOR_LOOP_MS    200
#define MQTT_PUBLISH_MS   1000
#define MQTT_RECONNECT_MS 5000
#define STATUS_PUBLISH_MS 30000
#define ALARM_COOLDOWN_MS 60000
#define HTTP_TIMEOUT_MS   5000
#define SERIAL_BAUD       115200
#define MANUAL_OVERRIDE_TIMEOUT_MS 1800000

// ═════════════════════════════════════════════════════════════════════════════
// HYBRID TESTING CONFIG
// ═════════════════════════════════════════════════════════════════════════════
// INJECT_TIMEOUT_MS: jika tidak ada data inject selama ini, fallback ke sensor
// fisik. Set 0 untuk nonaktifkan fallback (tetap di inject mode).
#define INJECT_TIMEOUT_MS   10000    // 10 detik timeout
// ═════════════════════════════════════════════════════════════════════════════

#define DEVICE_ID         "HELIO_SIM_001"
#define FW_VERSION        "3.3.0-hybrid"

#define MQTT_BROKER       "192.168.100.16"
#define MQTT_PORT         1883
#define MQTT_CLIENT_ID    "helioponic_esp32_hybrid"

#define TOPIC_UPLINK            "helioponic/sensor/uplink"
#define TOPIC_STATUS_UPLINK     "helioponic/status/uplink"
#define TOPIC_ALARM_UPLINK      "helioponic/alarm/uplink"
#define TOPIC_DOWNLINK          "helioponic/config/downlink"
#define TOPIC_ACTUATOR_DOWNLINK "helioponic/actuator/downlink"
#define TOPIC_NIGHT_MODE        "helioponic/night_mode/downlink"
// ═══ HYBRID: topic baru untuk menerima data sensor dari simulate_hybrid.py ═══
#define TOPIC_INJECT            "helioponic/sensor/inject"

#define API_BASE_URL          "http://192.168.100.16:8000/api/v1"
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
float runtime_tank_depth = TANK_DEPTH_CM;

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

// ═════════════════════════════════════════════════════════════════════════════
// HYBRID: Injection mode state
// ═════════════════════════════════════════════════════════════════════════════
bool            injectModeActive   = false;    // true = pakai data inject
unsigned long   lastInjectTime     = 0;        // terakhir kali terima data inject
float           inject_jarak       = 0.0f;     // jarak dari inject
float           inject_tds         = 0.0f;     // TDS dari inject
float           inject_ph          = 0.0f;     // pH dari inject
bool            injectWarningShown = false;    // cegah spam log warning
// ═════════════════════════════════════════════════════════════════════════════

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
      if (doc.containsKey("tank_depth_cm")) runtime_tank_depth = doc["tank_depth_cm"];
      if (doc.containsKey("jarak_on"))  runtime_jarak_on  = doc["jarak_on"];
      if (doc.containsKey("jarak_off")) runtime_jarak_off = doc["jarak_off"];
      if (doc.containsKey("tds_on"))    runtime_tds_on    = doc["tds_on"];
      if (doc.containsKey("tds_off"))   runtime_tds_off   = doc["tds_off"];
      if (doc.containsKey("ph_max"))    runtime_ph_max    = doc["ph_max"];
      if (doc.containsKey("ph_min"))    runtime_ph_min    = doc["ph_min"];
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
    // ═══ HYBRID: subscribe ke topic inject ═══
    mqttClient.subscribe(TOPIC_INJECT, 0);  // QoS 0 (cepat, seperti uplink)
    Serial.print("Subscribed to inject topic: ");
    Serial.println(TOPIC_INJECT);
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
  if (doc.containsKey("tank_depth_cm")) runtime_tank_depth = doc["tank_depth_cm"];
  if (doc.containsKey("jarak_on"))  runtime_jarak_on  = doc["jarak_on"];
  if (doc.containsKey("jarak_off")) runtime_jarak_off = doc["jarak_off"];
  if (doc.containsKey("tds_on"))    runtime_tds_on    = doc["tds_on"];
  if (doc.containsKey("tds_off"))   runtime_tds_off   = doc["tds_off"];
  if (doc.containsKey("ph_max"))    runtime_ph_max    = doc["ph_max"];
  if (doc.containsKey("ph_min"))    runtime_ph_min    = doc["ph_min"];
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
    if (doc.containsKey("tank_depth_cm")) runtime_tank_depth = doc["tank_depth_cm"];
    if (doc.containsKey("jarak_on"))  runtime_jarak_on  = doc["jarak_on"];
    if (doc.containsKey("jarak_off")) runtime_jarak_off = doc["jarak_off"];
    if (doc.containsKey("tds_on"))    runtime_tds_on    = doc["tds_on"];
    if (doc.containsKey("tds_off"))   runtime_tds_off   = doc["tds_off"];
    if (doc.containsKey("ph_max"))    runtime_ph_max    = doc["ph_max"];
  }
}

void handleActuatorCommand(const char* message) {
  StaticJsonDocument<128> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.print("ACTUATOR: JSON parse error: "); Serial.println(error.c_str());
    return;
  }
  const char* pump = doc["pump"] | "";
  int state = doc["state"] | 0;
  if (strlen(pump) == 0) return;

  Serial.print("ACTUATOR: received "); Serial.print(pump);
  Serial.print(" -> "); Serial.print(state ? "ON" : "OFF");
  Serial.print(" (override=true)");

  if (strcmp(pump, "pompa1") == 0 || strcmp(pump, "circ") == 0) {
    perintahPompa1 = (state == 1);
    manualOverridePompa1 = true; manualOverridePompa1Time = millis();
    flushSerial1Input(); Serial1.print("P1:"); Serial1.println(state ? "1" : "0");
    Serial.print(" -> sent P1:"); Serial.println(state ? "1" : "0");
  } else if (strcmp(pump, "pompa2") == 0 || strcmp(pump, "ph_d") == 0) {
    perintahPompa2 = (state == 1);
    manualOverridePompa2 = true; manualOverridePompa2Time = millis();
    flushSerial1Input(); Serial1.print("P2:"); Serial1.println(state ? "1" : "0");
    Serial.print(" -> sent P2:"); Serial.println(state ? "1" : "0");
  } else if (strcmp(pump, "pompa3") == 0 || strcmp(pump, "nut_a") == 0) {
    perintahPompa3 = (state == 1);
    manualOverridePompa3 = true; manualOverridePompa3Time = millis();
    flushSerial1Input(); Serial1.print("P3:"); Serial1.println(state ? "1" : "0");
    Serial.print(" -> sent P3:"); Serial.println(state ? "1" : "0");
  } else if (strcmp(pump, "pompa4") == 0 || strcmp(pump, "nut_b") == 0) {
    perintahPompa4 = (state == 1);
    manualOverridePompa4 = true; manualOverridePompa4Time = millis();
    flushSerial1Input(); Serial1.print("P4:"); Serial1.println(state ? "1" : "0");
    Serial.print(" -> sent P4:"); Serial.println(state ? "1" : "0");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// HYBRID: handleSensorInject — terima data sensor dari simulate_hybrid.py
// ═════════════════════════════════════════════════════════════════════════════
void handleSensorInject(const char* message) {
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.print("INJECT: JSON parse error: ");
    Serial.println(error.c_str());
    return;
  }

  // Validasi: harus ada minimal satu field sensor
  bool hasJarak = doc.containsKey("jarak_cm");
  bool hasTds   = doc.containsKey("tds_value");
  bool hasPh    = doc.containsKey("current_ph");

  if (!hasJarak && !hasTds && !hasPh) {
    Serial.println("INJECT: payload has no sensor fields, ignored");
    return;
  }

  // Simpan nilai dari inject
  if (hasJarak) inject_jarak = doc["jarak_cm"].as<float>();
  if (hasTds)   inject_tds   = doc["tds_value"].as<float>();
  if (hasPh)    inject_ph    = doc["current_ph"].as<float>();

  // Update timestamp dan aktifkan inject mode
  lastInjectTime = millis();
  
  if (!injectModeActive) {
    injectModeActive = true;
    injectWarningShown = false;
    Serial.println("═══════════════════════════════════════════");
    Serial.println("HYBRID MODE ACTIVE: Using injected sensor data");
    Serial.print("  jarak="); Serial.print(inject_jarak, 1);
    Serial.print("cm  tds="); Serial.print(inject_tds, 0);
    Serial.print("ppm  ph="); Serial.println(inject_ph, 1);
    Serial.println("═══════════════════════════════════════════");
  }

  // Log setiap 5 detik (tidak setiap publish)
  static unsigned long lastInjectLog = 0;
  unsigned long now = millis();
  if (now - lastInjectLog >= 5000) {
    lastInjectLog = now;
    Serial.print("INJECT: jarak="); Serial.print(inject_jarak, 1);
    Serial.print("cm  tds="); Serial.print(inject_tds, 0);
    Serial.print("ppm  ph="); Serial.println(inject_ph, 1);
  }
}

// ═════════════════════════════════════════════════════════════════════════════

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char message[length + 1];
  memcpy(message, payload, length);
  message[length] = '\0';

  // ═══ DEBUG: print EVERY message to confirm MQTT works ═══
  static unsigned long lastDebug = 0;
  if (millis() - lastDebug >= 5000) {
    lastDebug = millis();
    Serial.print("MQTT RX: topic="); Serial.print(topic);
    Serial.print(" len="); Serial.println(length);
  }
  
  // ═══ HYBRID: prioritaskan inject topic ═══
  if (strcmp(topic, TOPIC_INJECT) == 0) { handleSensorInject(message); return; }
  
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
  // ═══ HYBRID: publish COMMANDED state (perintahPompa), bukan Arduino feedback ═══
  // Arduino feedback (statusPompaDariUno) bisa pending → published state selalu 0
  // meskipun ESP32 sudah kirim perintah P1:1 via Serial1. Pakai perintahPompa
  // supaya simulate_hybrid.py langsung lihat keputusan automasi/manual ESP32.
  doc["pompa1"]     = perintahPompa1 ? 1 : 0;
  doc["pompa2"]     = perintahPompa2 ? 1 : 0;
  doc["pompa3"]     = perintahPompa3 ? 1 : 0;
  doc["pompa4"]     = perintahPompa4 ? 1 : 0;
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
    Serial.print("SEND P1:"); Serial.print(perintahPompa1 ? "1" : "0");
    flushSerial1Input(); Serial1.print("P1:"); Serial1.println(perintahPompa1 ? "1" : "0");
    Serial.println(" -> Serial1 OK");
  }
  if (perintahPompa2 != lastSentPompa2) {
    lastSentPompa2 = perintahPompa2;
    Serial.print("SEND P2:"); Serial.print(perintahPompa2 ? "1" : "0");
    flushSerial1Input(); Serial1.print("P2:"); Serial1.println(perintahPompa2 ? "1" : "0");
    Serial.println(" -> Serial1 OK");
  }
  if (perintahPompa3 != lastSentPompa3) {
    lastSentPompa3 = perintahPompa3;
    Serial.print("SEND P3:"); Serial.print(perintahPompa3 ? "1" : "0");
    flushSerial1Input(); Serial1.print("P3:"); Serial1.println(perintahPompa3 ? "1" : "0");
    Serial.println(" -> Serial1 OK");
  }
  if (perintahPompa4 != lastSentPompa4) {
    lastSentPompa4 = perintahPompa4;
    Serial.print("SEND P4:"); Serial.print(perintahPompa4 ? "1" : "0");
    flushSerial1Input(); Serial1.print("P4:"); Serial1.println(perintahPompa4 ? "1" : "0");
    Serial.println(" -> Serial1 OK");
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

// ═════════════════════════════════════════════════════════════════════════════
// HYBRID: Cek apakah inject masih aktif, fallback jika timeout
// ═════════════════════════════════════════════════════════════════════════════
void checkInjectTimeout(unsigned long now) {
  if (!injectModeActive) return;
  
  // ═══ FIX: gunakan millis() saat ini, bukan 'now' dari awal loop() ═══
  // 'now' bisa lebih kecil dari lastInjectTime (set di mqttCallback)
  // menyebabkan underflow unsigned → langsung timeout
  unsigned long current = millis();
  unsigned long elapsed = current - lastInjectTime;
  if (elapsed >= INJECT_TIMEOUT_MS) {
    injectModeActive = false;
    Serial.println("═══════════════════════════════════════════");
    Serial.print("HYBRID MODE TIMEOUT: no inject data for ");
    Serial.print(elapsed / 1000);
    Serial.println("s — falling back to physical sensors");
    Serial.println("═══════════════════════════════════════════");
  } else if (!injectWarningShown && elapsed >= INJECT_TIMEOUT_MS / 2) {
    // Warning setengah timeout
    injectWarningShown = true;
    Serial.print("WARNING: inject data stalled for ");
    Serial.print(elapsed / 1000);
    Serial.print("s — will fallback in ");
    Serial.print((INJECT_TIMEOUT_MS - elapsed) / 1000);
    Serial.println("s");
  }
}
// ═════════════════════════════════════════════════════════════════════════════

// =============================================================================
// SETUP
// =============================================================================

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(500);

  Serial1.begin(9600, SERIAL_8N1, RX1_PIN, TX1_PIN);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(TDS_SENSOR_PIN, ADC_11db);
  analogSetPinAttenuation(PH_SENSOR_PIN, ADC_11db);

  connectWiFi();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);

  Serial.print("Helioponic ESP32 HYBRID v");
  Serial.print(FW_VERSION);
  Serial.println(" SYSTEM READY");
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

  // ═══ HYBRID: cek timeout inject mode ═══
  checkInjectTimeout(now);

  // Sensor loop: every 200ms
  if (now - lastSensorMillis >= SENSOR_LOOP_MS) {
    lastSensorMillis = now;

    // ═══════════════════════════════════════════════════════════════════════
    // HYBRID: Pilih sumber data sensor
    //   injectModeActive=true  → pakai data dari simulate_hybrid.py
    //   injectModeActive=false → baca sensor fisik seperti biasa
    // ═══════════════════════════════════════════════════════════════════════
    if (injectModeActive) {
      // ── Pakai data dari MQTT inject ──
      // Konversi ke tipe yang sesuai dengan variabel global
      jarakCm     = (int)round(inject_jarak);
      current_tds = inject_tds;
      current_ph  = inject_ph;
      
      // Debug log setiap 5 detik
      static unsigned long lastInjectSensorLog = 0;
      if (now - lastInjectSensorLog >= 5000) {
        lastInjectSensorLog = now;
        Serial.print("[INJECT] jarak="); Serial.print(jarakCm);
        Serial.print("cm  tds="); Serial.print(current_tds, 0);
        Serial.print("ppm  ph="); Serial.println(current_ph, 1);
      }
    } else {
      // ── Baca sensor fisik (original behavior) ──
      
      // Read ultrasonic
      digitalWrite(TRIG_PIN, LOW);
      delayMicroseconds(2);
      digitalWrite(TRIG_PIN, HIGH);
      delayMicroseconds(10);
      digitalWrite(TRIG_PIN, LOW);
      long durasi = pulseIn(ECHO_PIN, HIGH, 30000);
      jarakCm = durasi * 0.034 / 2;
      if (jarakCm > (int)round(runtime_tank_depth) || jarakCm <= 0) jarakCm = 999;

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
    }

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
