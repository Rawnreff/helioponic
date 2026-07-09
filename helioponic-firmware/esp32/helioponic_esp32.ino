// =============================================================================
// Helioponic — ESP32 Firmware (Production)
// =============================================================================
// SOURCE OF TRUTH: helioponic_esp32_raw.ino
//
// Architecture:
//   ESP32 (Master) — reads sensors, runs automation, handles networking
//   Arduino Uno (Slave) — executes relay commands, sends feedback via Serial1
//
// Sensor-to-Cloud Pipeline:
//   1. Read local sensors: Ultrasonic (water level), TDS, pH
//   2. Run local pump automation (bang-bang hysteresis)
//   3. Send pump commands to Arduino (P1:/P2:) via Serial1
//   4. Read pump feedback (F1:/F2:) from Arduino via Serial1
//   5. Package all data as JSON and publish to MQTT topic
//   6. Subscribe to MQTT downlink for remote threshold/actuator updates
//
// MQTT Topics:
//   Publish:  helioponic/sensor/uplink    — JSON sensor + pump states (QoS 0, 1s)
//   Subscribe: helioponic/config/downlink  — Threshold updates from backend (QoS 1)
//   Subscribe: helioponic/actuator/downlink  — Pump commands from mobile app (QoS 1)
//
// ⚠️ WiFi & MQTT credentials are defined in secrets.h (gitignored).
//    Copy secrets.h.example to secrets.h and fill in your values.
// =============================================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#include "secrets.h"

// =============================================================================
// HARDWARE CONFIGURATION (formerly config.h)
// =============================================================================

// ---- Sensor Pin Mapping (from raw calibration) ----
#define TRIG_PIN          12    // HC-SR04 Trigger
#define ECHO_PIN          13    // HC-SR04 Echo
#define TDS_SENSOR_PIN    4     // ADC1 GPIO4 — TDS sensor
#define PH_SENSOR_PIN     5     // ADC1 GPIO5 — pH sensor

// ---- Serial1 Pins (Communication with Arduino Uno) ----
// ESP32 TX (pin 17) -> Arduino RX (pin 0)
// ESP32 RX (pin 18) <- Arduino TX (pin 1)
#define TX1_PIN           17
#define RX1_PIN           18

// ---- ADC Calibration (ESP32, 3.3V / 12-bit) ----
#define VREF              3.3f
#define ADC_RESOLUTION    4095.0f

// ---- TDS Calibration ----
// NOTE: Based on empirical testing, TDS_FACTOR may need adjustment.
// The raw baseline uses 0.50f; comments suggest 0.83f for recalibration.
#define TDS_FACTOR        0.50f
#define TEMPERATURE       25.0f

// ---- pH Calibration ----
#define PH_SLOPE          -5.70f
#define PH_INTERCEPT      21.34f

// ---- Local Pump Automation Thresholds ----
// These thresholds control the bang-bang hysteresis logic.
// They can be overridden remotely via MQTT downlink.
#define JARAK_ON          105     // cm — water too low, turn pump ON
#define JARAK_OFF         95      // cm — water recovered, turn pump OFF
#define TDS_ON            105     // ppm — nutrients too low, turn pump ON
#define TDS_OFF           95      // ppm — nutrients recovered, turn pump OFF

// ---- Sampling ----
#define ADC_OVERSAMPLE_N  16      // Number of ADC samples for averaging

// ---- Timing ----
#define SENSOR_LOOP_MS    1000    // Read sensors & control pumps every 1 second
#define MQTT_PUBLISH_MS   1000    // Publish to MQTT every 1 second
#define MQTT_RECONNECT_MS 5000    // MQTT reconnect delay (ms)
#define SERIAL_BAUD       115200  // ESP32 debug console baud

// ---- Device Identity ----
#define DEVICE_ID         "HELIO_001"

// ---- MQTT Broker Defaults ----
// Override these in secrets.h if needed (e.g. for physical deployment).
#ifndef MQTT_BROKER
#define MQTT_BROKER       "localhost"
#endif
#define MQTT_PORT         1883
#define MQTT_CLIENT_ID    "helioponic_esp32_001"

// ---- MQTT Topics ----
#define TOPIC_UPLINK            "helioponic/sensor/uplink"        // ESP32 -> Broker (QoS 0)
#define TOPIC_DOWNLINK          "helioponic/config/downlink"      // Broker -> ESP32 — threshold config (QoS 1)
#define TOPIC_ACTUATOR_DOWNLINK "helioponic/actuator/downlink"    // Broker -> ESP32 — pump command (QoS 1)

// =============================================================================
// GLOBAL STATE
// =============================================================================

// ---- PRESERVED: Raw calibration constants (from _raw firmware) ----
float TDS_FACTOR_RUNTIME = TDS_FACTOR;
float PH_SLOPE_RUNTIME   = PH_SLOPE;
float PH_INTERCEPT_RUNTIME = PH_INTERCEPT;

// ---- PRESERVED: Global sensor state (from _raw firmware) ----
float current_tds = 0.0f;
float current_ph  = 0.0f;
int   jarakCm     = 0;

// ---- PRESERVED: Pump state (from _raw firmware) ----
bool perintahPompa1 = false;     // Pump 1 command state
bool perintahPompa2 = false;     // Pump 2 command state

// ---- PRESERVED: Arduino feedback (from _raw firmware) ----
String statusPompa1DariUno = "OFF";
String statusPompa2DariUno = "OFF";

// ---- Runtime downlink thresholds (overridable via MQTT) ----
int   runtime_jarak_on  = JARAK_ON;
int   runtime_jarak_off = JARAK_OFF;
float runtime_tds_on    = TDS_ON;
float runtime_tds_off   = TDS_OFF;

// ---- MQTT / WiFi globals ----
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
unsigned long lastSensorMillis = 0;
unsigned long lastPublishMillis = 0;
unsigned long lastMqttRetry = 0;
unsigned long lastWifiCheck = 0;

// ---- Serial ring buffer for Arduino feedback ----
#define SERIAL_BUF_SIZE 128
static char serialBuf[SERIAL_BUF_SIZE];
static int  serialIdx = 0;

// =============================================================================
// PRESERVED: Analog oversampling function (from _raw firmware)
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
// PRESERVED: Flush Serial1 input buffer (from _raw firmware)
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
// ADDED: WiFi connection
// =============================================================================
void connectWiFi() {
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi failed — will retry in loop");
  }
}

// =============================================================================
// ADDED: MQTT connection handler
// =============================================================================
void attemptMQTT() {
  if (mqttClient.connected()) return;
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
    Serial.print("Subscribed to: ");
    Serial.println(TOPIC_DOWNLINK);
    Serial.print("Subscribed to: ");
    Serial.println(TOPIC_ACTUATOR_DOWNLINK);
  } else {
    Serial.print("failed (rc=");
    Serial.print(mqttClient.state());
    Serial.println(") will retry");
  }
}

// =============================================================================
// ADDED: Config downlink handler — threshold updates from backend
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

  // Update runtime thresholds with received values (config keys only)
  // Accepted keys: jarak_on, jarak_off, tds_on, tds_off
  // These map 1:1 to the device_configs fields published by the backend.
  if (doc.containsKey("jarak_on"))   runtime_jarak_on  = doc["jarak_on"]  | JARAK_ON;
  if (doc.containsKey("jarak_off"))  runtime_jarak_off = doc["jarak_off"] | JARAK_OFF;
  if (doc.containsKey("tds_on"))     runtime_tds_on    = doc["tds_on"]    | TDS_ON;
  if (doc.containsKey("tds_off"))    runtime_tds_off   = doc["tds_off"]   | TDS_OFF;

  Serial.println("Runtime thresholds updated:");
  Serial.print("  jarak_on = ");  Serial.println(runtime_jarak_on);
  Serial.print("  jarak_off = "); Serial.println(runtime_jarak_off);
  Serial.print("  tds_on = ");    Serial.println(runtime_tds_on);
  Serial.print("  tds_off = ");   Serial.println(runtime_tds_off);
}

// =============================================================================
// ADDED: Actuator downlink handler — pump commands from mobile app
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

  // Map pump name to Serial1 protocol and override local state
  if (strcmp(pump, "pompa1") == 0 || strcmp(pump, "circ") == 0) {
    perintahPompa1 = (state == 1);
    flushSerial1Input();
    Serial1.print("P1:");
    Serial1.println(state ? "1" : "0");
  } else if (strcmp(pump, "pompa2") == 0 || strcmp(pump, "ph_d") == 0) {
    perintahPompa2 = (state == 1);
    flushSerial1Input();
    Serial1.print("P2:");
    Serial1.println(state ? "1" : "0");
  } else {
    Serial.println("Unknown pump — ignoring");
  }
}

// =============================================================================
// ADDED: Route MQTT messages by topic
// =============================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char message[length + 1];
  memcpy(message, payload, length);
  message[length] = '\0';

  if (strcmp(topic, TOPIC_ACTUATOR_DOWNLINK) == 0) {
    handleActuatorCommand(message);
    return;
  }
  handleConfigDownlink(message);
}

// =============================================================================
// ADDED: Publish sensor data to MQTT in structured JSON
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
    Serial.println("MQTT publish failed");
  }
}

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(1000);

  // ---- Serial1 for Arduino Uno communication ----
  Serial1.begin(9600, SERIAL_8N1, RX1_PIN, TX1_PIN);

  // ---- PRESERVED: Sensor pin setup (from _raw firmware) ----
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(TDS_SENSOR_PIN, ADC_11db);
  analogSetPinAttenuation(PH_SENSOR_PIN, ADC_11db);

  // ---- WiFi + NTP + MQTT ----
  connectWiFi();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);

  Serial.println("Helioponic ESP32 SYSTEM READY (Ultrasonik + TDS + pH + MQTT)");
}

// =============================================================================
// MAIN LOOP
// =============================================================================
void loop() {
  unsigned long now = millis();

  // ---- ADDED: Maintain WiFi ----
  if (now - lastWifiCheck >= 30000) {
    lastWifiCheck = now;
    if (WiFi.status() != WL_CONNECTED) connectWiFi();
  }

  // ---- ADDED: Maintain MQTT ----
  if (!mqttClient.connected()) {
    if (now - lastMqttRetry >= MQTT_RECONNECT_MS) {
      lastMqttRetry = now;
      attemptMQTT();
    }
  }
  mqttClient.loop();

  // ---- PRESERVED: Sensor loop every SENSOR_LOOP_MS (from _raw firmware) ----
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
    if (jarakCm > 400 || jarakCm <= 0) jarakCm = 999;  // Out of range

    // ========== 2. BACA TDS ==========
    pinMode(TDS_SENSOR_PIN, INPUT);
    delayMicroseconds(200);
    float tds_voltage = readAnalogVoltage(TDS_SENSOR_PIN);

    float tds_value = 0.0f;
    if (tds_voltage > 0.10f) {
      float compensationCoefficient = 1.0f + 0.02f * (TEMPERATURE - 25.0f);
      float compensationVoltage = tds_voltage / compensationCoefficient;

      // PRESERVED: Polynomial TDS-to-EC conversion (from _raw firmware)
      float ec = (133.42f * pow(compensationVoltage, 3)
                  - 255.86f * pow(compensationVoltage, 2)
                  + 857.39f * compensationVoltage);
      tds_value = ec * TDS_FACTOR_RUNTIME;
      if (tds_value < 0.0f) tds_value = 0.0f;
    }
    current_tds = tds_value;

    // ========== 3. BACA pH ==========
    pinMode(PH_SENSOR_PIN, INPUT);
    delayMicroseconds(200);
    float ph_voltage = readAnalogVoltage(PH_SENSOR_PIN);
    current_ph = PH_SLOPE_RUNTIME * ph_voltage + PH_INTERCEPT_RUNTIME;
    if (current_ph < 0) current_ph = 0;
    if (current_ph > 14) current_ph = 14;

    // ========== 4. LOGIKA KONTROL POMPA (PRESERVED from _raw firmware) ==========
    bool ultrasonikValid = (jarakCm != 999);

    if (ultrasonikValid) {
      // Pompa 1 — Circulation (hysteresis ON/OFF)
      if (jarakCm > runtime_jarak_on && current_tds > runtime_tds_on) {
        perintahPompa1 = true;
      } else if (jarakCm < runtime_jarak_off || current_tds < runtime_tds_off) {
        perintahPompa1 = false;
      }

      // Pompa 2 — pH Dosing (hysteresis ON/OFF, same thresholds)
      if (jarakCm > runtime_jarak_on && current_tds > runtime_tds_on) {
        perintahPompa2 = true;
      } else if (jarakCm < runtime_jarak_off || current_tds < runtime_tds_off) {
        perintahPompa2 = false;
      }
    }

    // ========== 5. KIRIM PERINTAH KE ARDUINO via Serial1 ==========
    flushSerial1Input();
    Serial1.print("P1:");
    Serial1.println(perintahPompa1 ? "1" : "0");
    Serial1.print("P2:");
    Serial1.println(perintahPompa2 ? "1" : "0");

    // ========== 6. BACA FEEDBACK dari Arduino ==========
    unsigned long waitStart = millis();
    while (millis() - waitStart < 100) {
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
  }

  // ---- ADDED: Publish to MQTT every MQTT_PUBLISH_MS ----
  if (now - lastPublishMillis >= MQTT_PUBLISH_MS) {
    lastPublishMillis = now;
    publishSensorData();
  }
}
