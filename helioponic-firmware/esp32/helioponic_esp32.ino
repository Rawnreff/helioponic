// =============================================================================
// Helioponic — ESP32 Firmware (Entry Point)
// =============================================================================
//
// Architecture:
//   helioponic_esp32.ino      — Entry point (setup + loop)
//   helioponic_esp32_raw.ino  — Hardware layer (sensors, pump control)
//   helioponic_esp32_old.ino  — Connectivity layer (WiFi, MQTT, publish)
//   secrets.h                 — WiFi & MQTT credentials (gitignored)
//
// This file provides setup() and loop() which orchestrate the hardware
// and connectivity layers defined in the included .ino files.
// =============================================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// WiFi & MQTT credentials (gitignored — copy from secrets.h.example)
#include "secrets.h"

// Hardware layer: sensor reading, pump control, Serial1 communication
#include "helioponic_esp32_raw.ino"

// Connectivity layer: WiFi, MQTT, publish, downlink handlers
#include "helioponic_esp32_old.ino"

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  initHardware();
  initConnectivity();

  Serial.println("Helioponic ESP32 SYSTEM READY (Ultrasonik + TDS + pH + MQTT)");
}

// =============================================================================
// MAIN LOOP
// =============================================================================
void loop() {
  unsigned long now = millis();

  // ---- Connectivity maintenance (WiFi + MQTT reconnect + publish) ----
  runConnectivityCycle(now);

  // ---- Sensor cycle every SENSOR_LOOP_MS ----
  if (now - lastSensorMillis >= SENSOR_LOOP_MS) {
    lastSensorMillis = now;
    runSensorCycle();
  }
}
