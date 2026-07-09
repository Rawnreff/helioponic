// =============================================================================
// Helioponic — Arduino Uno Firmware
// =============================================================================
// SOURCE OF TRUTH: helioponic_uno_raw.ino
//
// The Arduino Uno is the relay actuator slave. It:
//   - Receives pump commands (P1:/P2:) from the ESP32 master via Serial
//   - Toggles 2 active-LOW relays (POMPA1 on pin 4, POMPA2 on pin 5)
//   - Sends execution feedback (F1:/F2:) back to the ESP32
//
// No sensors are read on this board — all sensor data is collected
// by the ESP32 (helioponic_esp32.ino).
// =============================================================================

#include "config.h"

// ---- Pump State Tracking ----
String stateP1 = "OFF";
String stateP2 = "OFF";

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  // Kunci logika HIGH sebelum deklarasi OUTPUT agar relay tidak trigger acak
  // saat MCB dinaikkan (Active-LOW: HIGH = relay OFF)
  digitalWrite(RELAY_POMPA1, HIGH);
  digitalWrite(RELAY_POMPA2, HIGH);

  pinMode(RELAY_POMPA1, OUTPUT);
  pinMode(RELAY_POMPA2, OUTPUT);

  Serial.begin(SERIAL_BAUD);
}

// =============================================================================
// MAIN LOOP — Process Serial commands from ESP32
// =============================================================================
void loop() {
  if (Serial.available() > 0) {
    String dataMasuk = Serial.readStringUntil('\n');
    dataMasuk.trim();

    // ---- Command: P1: (Pompa 1 / Circulation) ----
    if (dataMasuk.startsWith("P1:")) {
      String cmd = dataMasuk.substring(3);
      if (cmd == "1" && stateP1 != "ON") {
        digitalWrite(RELAY_POMPA1, LOW);  // LOW = relay ON (Active-LOW)
        stateP1 = "ON";
      } else if (cmd == "0" && stateP1 != "OFF") {
        digitalWrite(RELAY_POMPA1, HIGH); // HIGH = relay OFF
        stateP1 = "OFF";
      }
    }

    // ---- Command: P2: (Pompa 2 / pH Dosing) ----
    else if (dataMasuk.startsWith("P2:")) {
      String cmd = dataMasuk.substring(3);
      if (cmd == "1" && stateP2 != "ON") {
        digitalWrite(RELAY_POMPA2, LOW);  // LOW = relay ON (Active-LOW)
        stateP2 = "ON";
      } else if (cmd == "0" && stateP2 != "OFF") {
        digitalWrite(RELAY_POMPA2, HIGH); // HIGH = relay OFF
        stateP2 = "OFF";
      }
    }

    // ---- Send Execution Feedback ----
    Serial.print("F1:");
    Serial.println(stateP1);
    Serial.print("F2:");
    Serial.println(stateP2);
  }
}
