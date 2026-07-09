// =============================================================================
// Helioponic — ESP32 Hardware Layer (included by helioponic_esp32.ino)
// =============================================================================
// SOURCE OF TRUTH: Original raw firmware
//
// Pure hardware logic — sensor reading, pump control, Serial1 communication.
// No WiFi, no MQTT, no connectivity code here.
// =============================================================================

// ---- Sensor Pin Mapping ----
#define TRIG_PIN          12    // HC-SR04 Trigger
#define ECHO_PIN          13    // HC-SR04 Echo
#define TDS_SENSOR_PIN    4     // ADC1 GPIO4 — TDS sensor
#define PH_SENSOR_PIN     5     // ADC1 GPIO5 — pH sensor

// ---- Serial1 Pins (Communication with Arduino Uno) ----
#define TX1_PIN           17    // ESP32 TX -> Arduino RX (pin 0)
#define RX1_PIN           18    // ESP32 RX <- Arduino TX (pin 1)

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
#define SERIAL_BAUD       115200  // ESP32 debug console baud

// ---- Device Identity ----
#define DEVICE_ID         "HELIO_001"

// ---- Global Sensor/Pump State ----
float current_tds = 0.0f;
float current_ph  = 0.0f;
int   jarakCm     = 0;
bool  perintahPompa1 = false;     // Pump 1 command state
bool  perintahPompa2 = false;     // Pump 2 command state
String statusPompa1DariUno = "OFF";
String statusPompa2DariUno = "OFF";
unsigned long lastSensorMillis = 0;

// ---- Runtime downlink thresholds (overridable via MQTT) ----
int   runtime_jarak_on  = JARAK_ON;
int   runtime_jarak_off = JARAK_OFF;
float runtime_tds_on    = TDS_ON;
float runtime_tds_off   = TDS_OFF;

// ---- Serial ring buffer for Arduino feedback ----
#define SERIAL_BUF_SIZE 128
static char serialBuf[SERIAL_BUF_SIZE];
static int  serialIdx = 0;

// =============================================================================
// Analog oversampling — read averaged voltage from an ADC pin
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
// Flush the Serial1 input buffer
// =============================================================================
void flushSerial1Input() {
  while (Serial1.available() > 0) {
    Serial1.read();
  }
}

// =============================================================================
// Parse a line of feedback from Arduino Uno (F1:/F2:)
// =============================================================================
void parseSerial1Line(const char* line) {
  if (strncmp(line, "F1:", 3) == 0) {
    statusPompa1DariUno = (strstr(line + 3, "ON") != NULL) ? "ON" : "OFF";
  } else if (strncmp(line, "F2:", 3) == 0) {
    statusPompa2DariUno = (strstr(line + 3, "ON") != NULL) ? "ON" : "OFF";
  }
}

// =============================================================================
// Initialize hardware pins and Serial1
// =============================================================================
void initHardware() {
  Serial.begin(SERIAL_BAUD);
  delay(1000);

  Serial1.begin(9600, SERIAL_8N1, RX1_PIN, TX1_PIN);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(TDS_SENSOR_PIN, ADC_11db);
  analogSetPinAttenuation(PH_SENSOR_PIN, ADC_11db);
}

// =============================================================================
// Run one sensor reading + pump control cycle
// Called every SENSOR_LOOP_MS from the main loop
// =============================================================================
void runSensorCycle() {
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

    float ec = (133.42f * pow(compensationVoltage, 3)
                - 255.86f * pow(compensationVoltage, 2)
                + 857.39f * compensationVoltage);
    tds_value = ec * TDS_FACTOR;
    if (tds_value < 0.0f) tds_value = 0.0f;
  }
  current_tds = tds_value;

  // ========== 3. BACA pH ==========
  pinMode(PH_SENSOR_PIN, INPUT);
  delayMicroseconds(200);
  float ph_voltage = readAnalogVoltage(PH_SENSOR_PIN);
  current_ph = PH_SLOPE * ph_voltage + PH_INTERCEPT;
  if (current_ph < 0) current_ph = 0;
  if (current_ph > 14) current_ph = 14;

  // ========== 4. LOGIKA KONTROL POMPA (bang-bang hysteresis) ==========
  bool ultrasonikValid = (jarakCm != 999 && jarakCm > 0);

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
