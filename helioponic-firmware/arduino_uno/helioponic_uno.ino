// =============================================================================
// Helioponic — Arduino Uno Firmware (Entry Point)
// =============================================================================
//
// Architecture:
//   helioponic_uno.ino      — Entry point (setup + loop)
//   helioponic_uno_raw.ino  — Hardware layer (relay control, serial protocol)
//
// The Arduino Uno is the relay actuator slave. It receives pump commands
// (P1:/P2:) from the ESP32 master via Serial and toggles 2 active-LOW relays.
// Feedback (F1:/F2:) is sent back to the ESP32.
// =============================================================================

// Hardware layer: relay control, Serial command parsing
#include "helioponic_uno_raw.ino"

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  initRelays();
}

// =============================================================================
// MAIN LOOP — Process Serial commands from ESP32
// =============================================================================
void loop() {
  processSerialCommand();
}
