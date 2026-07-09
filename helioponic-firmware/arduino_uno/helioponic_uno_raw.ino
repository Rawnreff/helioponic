// =============================================================================
// Helioponic — Arduino Uno Hardware Layer (included by helioponic_uno.ino)
// =============================================================================
// SOURCE OF TRUTH: helioponic_uno_raw.ino
//
// Pure relay actuator logic — receiving pump commands (P1:/P2:) via Serial
// and toggling active-LOW relays. Sends feedback (F1:/F2:) back to ESP32.
// =============================================================================

// ---- Relay Pins (Active-LOW: LOW = relay ON, HIGH = relay OFF) ----
#define RELAY_POMPA1  4     // Circulation pump
#define RELAY_POMPA2  5     // pH dosing pump

// ---- Serial Communication ----
#define SERIAL_BAUD   9600

// ---- Pump State Tracking ----
String stateP1 = "OFF";
String stateP2 = "OFF";

// =============================================================================
// Initialize relay pins
// =============================================================================
void initRelays() {
  // Kunci logika HIGH sebelum deklarasi OUTPUT agar relay tidak trigger acak
  // saat MCB dinaikkan (Active-LOW: HIGH = relay OFF)
  digitalWrite(RELAY_POMPA1, HIGH);
  digitalWrite(RELAY_POMPA2, HIGH);

  pinMode(RELAY_POMPA1, OUTPUT);
  pinMode(RELAY_POMPA2, OUTPUT);

  Serial.begin(SERIAL_BAUD);
}

// =============================================================================
// Process one incoming Serial command from ESP32
// Handles P1: and P2: commands, toggles relays, sends feedback
// =============================================================================
void processSerialCommand() {
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
