// =============================================================================
// Helioponic — ESP32 Firmware
// =============================================================================
// Role: Wi-Fi gateway + MQTT bridge
// - Reads CSV data from Arduino Uno via UART2 (Serial2)
// - Parses and packages into JSON
// - Publishes to MQTT topic: helioponic/sensor/uplink
// - Subscribes to: helioponic/config/downlink for remote threshold updates
// - Forwards threshold updates to Arduino Uno via Serial2
// =============================================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#include "config.h"
#include "secrets.h"

// ---- Globals ----
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

// ---- Sensor Data Buffer (from Arduino Uno) ----
struct SensorData {
  float ph;
  float tds;
  float temp;
  float hum;
  float wl;
  float vSolar;
  float iSolar;
  int   pumpCirc;
  int   pumpPhD;
  int   pumpNutA;
  int   pumpNutB;
  int   pumpRaw;
};

// ---- Timing ----
unsigned long lastPublish = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastMqttRetry = 0;
bool mqttConnected = false;
bool ledState = false;

// ---- Ring buffer for non-blocking Serial2 reads ----
#define SERIAL_BUF_SIZE  256
static char serialBuf[SERIAL_BUF_SIZE];
static int serialIdx = 0;

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  // Debug serial (USB)
  Serial.begin(SERIAL_BAUD);

  // UART2 for communication with Arduino Uno
  Serial2.begin(SERIAL_BAUD, SERIAL_8N1, RXD2, TXD2);

  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  // Connect to Wi-Fi (blocking is acceptable during setup)
  connectWiFi();

  // Configure NTP for accurate timestamps
  // Indonesia Western Time (UTC+7). Adjust for your timezone.
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");

  // Configure MQTT
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);
}

// =============================================================================
// MAIN LOOP
// =============================================================================
void loop() {
  unsigned long now = millis();

  // --- 1. Maintain MQTT connection (non-blocking) ---
  if (!mqttClient.connected()) {
    if (now - lastMqttRetry >= MQTT_RECONNECT_MS) {
      lastMqttRetry = now;
      attemptMQTT();
    }
  }
  mqttClient.loop();

  // --- 2. Maintain Wi-Fi connection ---
  if (now - lastWifiCheck > 30000) {
    lastWifiCheck = now;
    if (WiFi.status() != WL_CONNECTED) {
      connectWiFi();
    }
  }

  // --- 3. Read Serial data from Arduino Uno (non-blocking ring buffer) ---
  while (Serial2.available() > 0) {
    char c = Serial2.read();
    if (c == '\n') {
      serialBuf[serialIdx] = '\0';

      if (serialIdx > 0) {
        SensorData data;
        if (parseCSV(serialBuf, &data)) {
          if (now - lastPublish >= MQTT_PUBLISH_MS) {
            lastPublish = now;
            publishSensorData(&data);
            ledState = !ledState;
            digitalWrite(STATUS_LED, ledState ? HIGH : LOW);
          }
        }
      }

      serialIdx = 0;
    } else if (serialIdx < SERIAL_BUF_SIZE - 1) {
      serialBuf[serialIdx++] = c;
    }
  }
}

// =============================================================================
// WI-FI
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
    Serial.println("\nWiFi failed — will retry");
  }
}

// =============================================================================
// MQTT
// =============================================================================

void attemptMQTT() {
  if (mqttClient.connected()) return;

  Serial.print("Connecting to MQTT... ");

  boolean connected = false;

  // Attempt with credentials if provided
  if (strlen(MQTT_USER) > 0) {
    connected = mqttClient.connect(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS);
  } else {
    connected = mqttClient.connect(MQTT_CLIENT_ID);
  }

  if (connected) {
    Serial.println("connected");

    // Subscribe to downlink topic for remote threshold updates (QoS 1)
    boolean subResult = mqttClient.subscribe(TOPIC_DOWNLINK, 1);
    if (subResult) {
      Serial.print("Subscribed to: ");
      Serial.println(TOPIC_DOWNLINK);
    }

    ledState = true;
    digitalWrite(STATUS_LED, HIGH);
  } else {
    Serial.print("failed (rc=");
    Serial.print(mqttClient.state());
    Serial.println("), will retry in 5s");
    digitalWrite(STATUS_LED, LOW);
  }
}

/// MQTT callback — handles incoming messages on subscribed topics.
/// Expects JSON payload matching the schema at TOPIC_DOWNLINK.
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  // Null-terminate the payload
  char message[length + 1];
  memcpy(message, payload, length);
  message[length] = '\0';

  Serial.print("MQTT message received on: ");
  Serial.println(topic);
  Serial.print("Payload: ");
  Serial.println(message);

  // Parse JSON threshold update
  // Expected format: { "target_ph": 6.0, "target_ppm": 800, ... }
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.print("JSON parse error: ");
    Serial.println(error.c_str());
    return;
  }

  float targetPH       = doc["target_ph"] | 6.0f;
  float targetPPM      = doc["target_ppm"] | 800.0f;
  float minWaterLevel  = doc["min_water_level"] | 20.0f;
  float maxWaterLevel  = doc["max_water_level"] | 90.0f;

  // Forward to Arduino Uno via Serial2
  // Format: THRESH:pH,PPM,minWL,maxWL\n
  char cmd[64];
  snprintf(cmd, sizeof(cmd), "THRESH:%.2f,%.0f,%.1f,%.1f\n",
           targetPH, targetPPM, minWaterLevel, maxWaterLevel);
  Serial2.print(cmd);

  Serial.print("Forwarded to Arduino: ");
  Serial.print(cmd);
}

// =============================================================================
// DATA PARSING
// =============================================================================

/// Parses a CSV line from Arduino Uno into a SensorData struct.
/// Uses manual char* parsing (no String objects) to avoid heap fragmentation.
/// Expected format: pH,TDS,temp,hum,wl,v_solar,i_solar,circ,ph_d,nut_a,nut_b,raw
bool parseCSV(const char* line, SensorData* data) {
  char buf[SERIAL_BUF_SIZE];
  strncpy(buf, line, SERIAL_BUF_SIZE - 1);
  buf[SERIAL_BUF_SIZE - 1] = '\0';

  char* token = strtok(buf, ",");
  if (token == NULL) return false;
  data->ph       = atof(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->tds      = atof(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->temp     = atof(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->hum      = atof(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->wl       = atof(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->vSolar   = atof(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->iSolar   = atof(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->pumpCirc = atoi(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->pumpPhD  = atoi(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->pumpNutA = atoi(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->pumpNutB = atoi(token);

  token = strtok(NULL, ",");
  if (token == NULL) return false;
  data->pumpRaw  = atoi(token);

  return true;
}

// =============================================================================
// MQTT PUBLISH
// =============================================================================

/// Builds a JSON payload and publishes to TOPIC_UPLINK.
/// Payload format matches SCHEMA.md:
/// { device_id, ts, ph, tds, temp, hum, wl, v_solar, i_solar, pumps: {...} }
void publishSensorData(SensorData* data) {
  // Use a static JSON document to avoid heap fragmentation
  StaticJsonDocument<384> doc;

  doc["device_id"] = DEVICE_ID;
  doc["ts"]        = time(nullptr);  // Unix timestamp (requires NTP or manual set)
  doc["ph"]        = data->ph;
  doc["tds"]       = data->tds;
  doc["temp"]      = data->temp;
  doc["hum"]       = data->hum;
  doc["wl"]        = data->wl;
  doc["v_solar"]   = data->vSolar;
  doc["i_solar"]   = data->iSolar;

  JsonObject pumps = doc.createNestedObject("pumps");
  pumps["circ"]  = data->pumpCirc;
  pumps["ph_d"]  = data->pumpPhD;
  pumps["nut_a"] = data->pumpNutA;
  pumps["nut_b"] = data->pumpNutB;
  pumps["raw"]   = data->pumpRaw;

  char buffer[256];
  size_t len = serializeJson(doc, buffer);

  boolean result = mqttClient.publish(TOPIC_UPLINK, buffer, false);

  if (result) {
    Serial.print("Published: ");
    Serial.println(buffer);
  } else {
    Serial.println("MQTT publish failed");
  }
}
