// =============================================================================
// Helioponic — Arduino Uno Firmware
// =============================================================================
// Role: Sensor reading + local relay control (edge automation)
// Communicates with ESP32 via UART Serial (TX/RX)
//
// Protocol (Uno → ESP32, CSV every 2s, terminated with \n):
//   pH,TDS,temp,hum,wl,v_solar,i_solar,circ,ph_d,nut_a,nut_b,raw
//
// Protocol (ESP32 → Uno):
//   THRESH:pH,PPM,minWL,maxWL
//
// =============================================================================

#include <EEPROM.h>
#include <DHT.h>
#include <Adafruit_INA219.h>

#include "config.h"

// ---- Global Objects ----
DHT dht(DHT_PIN, DHT22);
Adafruit_INA219 ina219;

// ---- Threshold State (loaded from EEPROM, can be updated by ESP32) ----
struct Thresholds {
  float targetPH;
  float targetPPM;
  float minWaterLevel;
  float maxWaterLevel;
};

Thresholds thresh;

// ---- EEPROM Layout ----
#define EEPROM_MAGIC          0xAB
#define EEPROM_ADDR_MAGIC     0
#define EEPROM_ADDR_DATA      1

// ---- Pump State ----
struct PumpState {
  bool circ;
  bool phD;
  bool nutA;
  bool nutB;
  bool raw;
};

PumpState pumps = {false, false, false, false, false};

// ---- Timing ----
unsigned long lastSensorSend = 0;
unsigned long pumpChangeTime[5] = {0, 0, 0, 0, 0};  // millis when each pump last toggled

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  Serial.begin(115200);
  dht.begin();
  Wire.begin();
  ina219.begin();

  // Relay pins — set as OUTPUT, start HIGH (relays OFF)
  pinMode(RELAY_CIRC,  OUTPUT); digitalWrite(RELAY_CIRC,  HIGH);
  pinMode(RELAY_PH_D,  OUTPUT); digitalWrite(RELAY_PH_D,  HIGH);
  pinMode(RELAY_NUT_A, OUTPUT); digitalWrite(RELAY_NUT_A, HIGH);
  pinMode(RELAY_NUT_B, OUTPUT); digitalWrite(RELAY_NUT_B, HIGH);
  pinMode(RELAY_RAW,   OUTPUT); digitalWrite(RELAY_RAW,   HIGH);

  // HC-SR04
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  // Load thresholds from EEPROM or set defaults
  loadThresholds();
}

// =============================================================================
// MAIN LOOP
// =============================================================================
void loop() {
  unsigned long now = millis();

  // --- 1. Check for incoming Serial data from ESP32 (threshold updates) ---
  handleSerialCommands();

  // --- 2. Read sensors and run hysteresis (non-blocking) ---
  if (now - lastSensorSend >= SENSOR_INTERVAL_MS) {
    lastSensorSend = now;

    // Read all sensors
    float ph      = readPHSensor();
    float tds     = readTDSSensor();
    float temp    = dht.readTemperature();
    float hum     = dht.readHumidity();
    float wl      = readWaterLevel();
    float vSolar  = 0.0;
    float iSolar  = 0.0;

    // Read INA219 (solar sensor)
    readSolar(&vSolar, &iSolar);

    // Run local hysteresis logic (edge automation)
    runHysteresis(ph, tds, wl, now);

    // Send CSV to ESP32
    char buf[128];
    snprintf(buf, sizeof(buf),
      "%.2f,%.0f,%.1f,%.0f,%.1f,%.2f,%.3f,%d,%d,%d,%d,%d",
      ph, tds, temp, hum, wl, vSolar, iSolar,
      pumps.circ, pumps.phD, pumps.nutA, pumps.nutB, pumps.raw
    );
    Serial.println(buf);
  }
}

// =============================================================================
// SENSOR READINGS
// =============================================================================

float readPHSensor() {
  // pH sensor: analog reading → voltage → pH value
  // Typical: 4.2V = pH 7.0, lower voltage = more acidic
  // Calibration: pH = 7.0 + (2.5 - voltage) / 0.18
  // Requires calibration per sensor
  int raw = analogRead(PH_SENSOR_PIN);
  float voltage = raw * (5.0 / 1023.0);
  float pH = 7.0 + (2.5 - voltage) / 0.18;
  return constrain(pH, 0.0, 14.0);
}

float readTDSSensor() {
  // TDS sensor: analog reading → voltage → ppm
  // Reference: 2.3V ≈ 700ppm at 25°C
  int raw = analogRead(TDS_SENSOR_PIN);
  float voltage = raw * (5.0 / 1023.0);
  float tds = (133.42 * voltage * voltage * voltage
             - 255.86 * voltage * voltage
             + 857.39 * voltage) * 0.5;
  return constrain(tds, 0.0, 2000.0);
}

float readWaterLevel() {
  // HC-SR04 Ultrasonic: distance → water level %
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000);  // timeout 30ms
  if (duration == 0) return 0.0;

  float distance = duration * 0.034 / 2;  // cm from sensor to water
  float tankHeight = 30.0;                 // total tank depth in cm
  float level = ((tankHeight - distance) / tankHeight) * 100.0;
  return constrain(level, 0.0, 100.0);
}

void readSolar(float* vSolar, float* iSolar) {
  *vSolar = ina219.getBusVoltage_V();
  *iSolar = ina219.getCurrent_mA() / 1000.0;  // mA → A
  if (*vSolar < 0) *vSolar = 0;
  if (*iSolar < 0) *iSolar = 0;
}

// =============================================================================
// EDGE AUTOMATION — HYSTERESIS CONTROL
// =============================================================================

void runHysteresis(float ph, float tds, float wl, unsigned long now) {
  // --- pH Control ---
  // If pH > target + hysteresis → turn ON pH dosing pump (acid)
  // If pH < target - hysteresis → turn OFF
  if (ph > thresh.targetPH + PH_HYSTERESIS) {
    setPump(RELAY_PH_D, &pumps.phD, true, now);
  } else if (ph < thresh.targetPH - PH_HYSTERESIS) {
    setPump(RELAY_PH_D, &pumps.phD, false, now);
  }

  // --- Nutrient (PPM) Control ---
  // If PPM < target - hysteresis → turn ON nutrient A+B pumps briefly
  // Simplified: doses A+B when below threshold
  if (tds < thresh.targetPPM - PPM_HYSTERESIS) {
    setPump(RELAY_NUT_A, &pumps.nutA, true, now);
    setPump(RELAY_NUT_B, &pumps.nutB, true, now);
  } else if (tds > thresh.targetPPM + PPM_HYSTERESIS) {
    setPump(RELAY_NUT_A, &pumps.nutA, false, now);
    setPump(RELAY_NUT_B, &pumps.nutB, false, now);
  }

  // --- Water Level Control ---
  // If water level < min → turn ON raw water pump (PDAM fill)
  // If water level > max → turn OFF
  if (wl < thresh.minWaterLevel) {
    setPump(RELAY_RAW, &pumps.raw, true, now);
  } else if (wl > thresh.maxWaterLevel) {
    setPump(RELAY_RAW, &pumps.raw, false, now);
  }

  // --- Circulation Pump — always on during daytime ---
  // For MVP: keep circulation pump running continuously
  // (can be extended with a timer for night-off)
  setPump(RELAY_CIRC, &pumps.circ, true, now);
}

void setPump(int pin, bool* state, bool target, unsigned long now) {
  if (*state == target) return;  // Already in desired state

  int pumpIndex = -1;
  if (pin == RELAY_CIRC)  pumpIndex = 0;
  if (pin == RELAY_PH_D)  pumpIndex = 1;
  if (pin == RELAY_NUT_A) pumpIndex = 2;
  if (pin == RELAY_NUT_B) pumpIndex = 3;
  if (pin == RELAY_RAW)   pumpIndex = 4;

  // Enforce minimum on/off time to protect relays
  if (pumpIndex >= 0) {
    unsigned long elapsed = now - pumpChangeTime[pumpIndex];
    if (target == true && elapsed < PUMP_MIN_OFF_MS) return;  // Min off-time
    if (target == false && elapsed < PUMP_MIN_ON_MS) return;  // Min on-time
    pumpChangeTime[pumpIndex] = now;
  }

  // Relay module: LOW = ON, HIGH = OFF
  digitalWrite(pin, target ? LOW : HIGH);
  *state = target;
}

// =============================================================================
// SERIAL COMMANDS (from ESP32)
// =============================================================================

// Ring buffer for non-blocking serial command processing
#define CMD_BUF_SIZE  64
static char cmdBuffer[CMD_BUF_SIZE];
static int cmdIdx = 0;

void handleSerialCommands() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      cmdBuffer[cmdIdx] = '\0';

      // Parse: THRESH:6.0,800.0,20.0,90.0
      if (strncmp(cmdBuffer, "THRESH:", 7) == 0) {
        char* token = cmdBuffer + 7;
        thresh.targetPH       = atof(strtok(token, ","));
        thresh.targetPPM      = atof(strtok(NULL, ","));
        thresh.minWaterLevel  = atof(strtok(NULL, ","));
        thresh.maxWaterLevel  = atof(strtok(NULL, ","));
        saveThresholds();
      }

      cmdIdx = 0;
    } else if (cmdIdx < CMD_BUF_SIZE - 1) {
      cmdBuffer[cmdIdx++] = c;
    }
  }
}

// =============================================================================
// EEPROM PERSISTENCE
// =============================================================================

void loadThresholds() {
  byte magic = EEPROM.read(EEPROM_ADDR_MAGIC);
  if (magic == EEPROM_MAGIC) {
    float* ptr = (float*)&thresh;
    for (int i = 0; i < sizeof(Thresholds); i++) {
      ((byte*)ptr)[i] = EEPROM.read(EEPROM_ADDR_DATA + i);
    }
  } else {
    thresh.targetPH       = DEFAULT_TARGET_PH;
    thresh.targetPPM      = DEFAULT_TARGET_PPM;
    thresh.minWaterLevel  = DEFAULT_MIN_WATER_LEVEL;
    thresh.maxWaterLevel  = DEFAULT_MAX_WATER_LEVEL;
  }
}

void saveThresholds() {
  EEPROM.write(EEPROM_ADDR_MAGIC, EEPROM_MAGIC);
  byte* ptr = (byte*)&thresh;
  for (int i = 0; i < sizeof(Thresholds); i++) {
    EEPROM.write(EEPROM_ADDR_DATA + i, ptr[i]);
  }
#if defined(ESP8266) || defined(ESP32)
  EEPROM.commit();
#endif
}
