// =============================================================================
// Helioponic — Arduino Uno Firmware
// =============================================================================
// SOURCE OF TRUTH: helioponic_uno_raw.ino
//
// The Arduino Uno is the relay actuator slave. It:
//   - Receives pump commands (P1:/P2:/P3:/P4:) from the ESP32 master via Serial
//   - Toggles 4 active-LOW relays
//     - POMPA1 on pin 4 (Water Circulation/Refill)
//     - POMPA2 on pin 5 (pH DOWN Dosing)
//     - POMPA3 on pin 6 (Nutrisi A Dosing)
//     - POMPA4 on pin 7 (Nutrisi B Dosing)
//   - Sends execution feedback (F1:/F2:/F3:/F4:) back to the ESP32
//
// No sensors are read on this board — all sensor data is collected
// by the ESP32 (helioponic_esp32.ino).
// =============================================================================

// ---- Relay Pins (Active-LOW: LOW = relay ON, HIGH = relay OFF) ----
#define RELAY_POMPA1  4     // Water Circulation/Refill pump
#define RELAY_POMPA2  5     // pH DOWN dosing pump
#define RELAY_POMPA3  6     // Nutrisi A dosing pump
#define RELAY_POMPA4  7     // Nutrisi B dosing pump

// ---- Serial Communication ----
#define SERIAL_BAUD   9600

// ---- Pump State Tracking ----
String stateP1 = "OFF";
String stateP2 = "OFF";
String stateP3 = "OFF";
String stateP4 = "OFF";

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  // Kunci logika HIGH sebelum deklarasi OUTPUT agar relay tidak trigger acak
  // saat MCB dinaikkan (Active-LOW: HIGH = relay OFF)
  digitalWrite(RELAY_POMPA1, HIGH);
  digitalWrite(RELAY_POMPA2, HIGH);
  digitalWrite(RELAY_POMPA3, HIGH);
  digitalWrite(RELAY_POMPA4, HIGH);

  pinMode(RELAY_POMPA1, OUTPUT);
  pinMode(RELAY_POMPA2, OUTPUT);
  pinMode(RELAY_POMPA3, OUTPUT);
  pinMode(RELAY_POMPA4, OUTPUT);

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

    // ---- Command: P3: (Pompa 3 / Nutrisi A Dosing) ----
    else if (dataMasuk.startsWith("P3:")) {
      String cmd = dataMasuk.substring(3);
      if (cmd == "1" && stateP3 != "ON") {
        digitalWrite(RELAY_POMPA3, LOW);  // LOW = relay ON (Active-LOW)
        stateP3 = "ON";
      } else if (cmd == "0" && stateP3 != "OFF") {
        digitalWrite(RELAY_POMPA3, HIGH); // HIGH = relay OFF
        stateP3 = "OFF";
      }
    }

    // ---- Command: P4: (Pompa 4 / Nutrisi B Dosing) ----
    else if (dataMasuk.startsWith("P4:")) {
      String cmd = dataMasuk.substring(3);
      if (cmd == "1" && stateP4 != "ON") {
        digitalWrite(RELAY_POMPA4, LOW);  // LOW = relay ON (Active-LOW)
        stateP4 = "ON";
      } else if (cmd == "0" && stateP4 != "OFF") {
        digitalWrite(RELAY_POMPA4, HIGH); // HIGH = relay OFF
        stateP4 = "OFF";
      }
    }

    // ---- Send Execution Feedback ----
    Serial.print("F1:");
    Serial.println(stateP1);
    Serial.print("F2:");
    Serial.println(stateP2);
    Serial.print("F3:");
    Serial.println(stateP3);
    Serial.print("F4:");
    Serial.println(stateP4);
  }
}
