// =============================================================================
// Helioponic — ESP32 Connectivity Layer (included by helioponic_esp32.ino)
// =============================================================================
//
// WiFi + MQTT connectivity — connecting to broker, publishing sensor data,
// handling downlink config/actuator commands from the backend.
//
// Depends on globals defined in helioponic_esp32_raw.ino (jarakCm, current_tds,
// current_ph, perintahPompa1, perintahPompa2, etc.)
// =============================================================================

// ---- MQTT Broker Defaults ----
// Override these in secrets.h (via #ifndef guard) for physical deployment.
#ifndef MQTT_BROKER
#define MQTT_BROKER       "localhost"
#endif
#define MQTT_PORT         1883
#define MQTT_CLIENT_ID    "helioponic_esp32_001"

// ---- MQTT Topics ----
#define TOPIC_UPLINK            "helioponic/sensor/uplink"        // ESP32 -> Broker (QoS 0)
#define TOPIC_DOWNLINK          "helioponic/config/downlink"      // Broker -> ESP32 — threshold config (QoS 1)
#define TOPIC_ACTUATOR_DOWNLINK "helioponic/actuator/downlink"    // Broker -> ESP32 — pump command (QoS 1)

// ---- Timing ----
#define MQTT_PUBLISH_MS   1000    // Publish to MQTT every 1 second
#define MQTT_RECONNECT_MS 5000    // MQTT reconnect delay (ms)

// ---- Connectivity Globals ----
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
unsigned long lastPublishMillis = 0;
unsigned long lastMqttRetry = 0;
unsigned long lastWifiCheck = 0;

// =============================================================================
// WiFi connection
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
// MQTT connection
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
// MQTT message router
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
  serializeJson(doc, buffer);

  if (mqttClient.publish(TOPIC_UPLINK, buffer, false)) {
    Serial.print("Published: ");
    Serial.println(buffer);
  } else {
    Serial.println("MQTT publish failed");
  }
}

// =============================================================================
// Initialize connectivity (WiFi + NTP + MQTT)
// =============================================================================
void initConnectivity() {
  connectWiFi();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);
}

// =============================================================================
// Run one connectivity maintenance cycle
// Called every loop() iteration — handles WiFi check, MQTT reconnect, MQTT loop
// =============================================================================
void runConnectivityCycle(unsigned long now) {
  // Maintain WiFi
  if (now - lastWifiCheck >= 30000) {
    lastWifiCheck = now;
    if (WiFi.status() != WL_CONNECTED) connectWiFi();
  }

  // Maintain MQTT
  if (!mqttClient.connected()) {
    if (now - lastMqttRetry >= MQTT_RECONNECT_MS) {
      lastMqttRetry = now;
      attemptMQTT();
    }
  }
  mqttClient.loop();

  // Publish sensor data periodically
  if (now - lastPublishMillis >= MQTT_PUBLISH_MS) {
    lastPublishMillis = now;
    publishSensorData();
  }
}
