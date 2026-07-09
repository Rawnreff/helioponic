// =============================================================================
// Helioponic — Arduino Uno Configuration
// =============================================================================
// SOURCE OF TRUTH: helioponic_uno_raw.ino
//
// The Arduino Uno acts as a dedicated relay actuator.
// It receives pump commands from the ESP32 via Serial and executes
// active-LOW relay toggling. No sensors are read on the Uno.
//
// Communication: Serial @ 9600 baud
//   ESP32 → Uno: "P1:1\n", "P2:0\n"
//   Uno → ESP32: "F1:ON\n", "F2:OFF\n"
// =============================================================================
#ifndef CONFIG_H
#define CONFIG_H

// ---- Relay Pins (Active-LOW: LOW = relay ON, HIGH = relay OFF) ----
#define RELAY_POMPA1  4     // Circulation pump
#define RELAY_POMPA2  5     // pH dosing pump

// ---- Serial Communication ----
#define SERIAL_BAUD   9600

#endif // CONFIG_H
