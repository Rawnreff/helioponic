// ========================================================
// KODE ESP32-S3 - FIXED VERSION (UPDATED CALIBRATION)
// Ultrasonik + TDS + pH -> Kontrol Pompa via Serial1 ke Arduino
// ========================================================

#define TRIG_PIN 12       // Sensor Ultrasonik Trigger
#define ECHO_PIN 13       // Sensor Ultrasonik Echo
#define TDS_SENSOR_PIN 4  // ADC1 GPIO 4 - sensor TDS
#define PH_SENSOR_PIN 5   // ADC1 GPIO 5 - sensor pH 
#define TX1_PIN 17        // ESP32 TX -> Arduino RX (pin 0)
#define RX1_PIN 18        // ESP32 RX -> Arduino TX (pin 1)

// ---------- KALIBRASI TDS (ESP32, ADC 3.3V/12-bit) ----------
const float VREF = 3.3f;
const float ADC_RESOLUTION = 4095.0f;

// BAGIAN INI YANG DIUBAH UNTUK KALIBRASI:
// Berdasarkan pengujian Anda, faktor dikoreksi dari 0.50f ke 0.83f
float TDS_FACTOR = 0.50f;         
const float TEMPERATURE = 25.0f;  

// ---------- KALIBRASI pH ----------
float PH_SLOPE = -5.70f;      
float PH_INTERCEPT = 21.34f;  

// ---------- THRESHOLD KONTROL ----------
const int JARAK_ON = 105, JARAK_OFF = 95;
const float TDS_ON = 105, TDS_OFF = 95;  // ppm

// Variabel Global
float current_tds = 0.0f;
float current_ph = 0.0f;
int jarakCm = 0;

// FIX: dipindah jadi global supaya status pompa tidak ke-reset tiap loop (hysteresis berfungsi benar)
bool perintahPompa1 = false;
bool perintahPompa2 = false;

unsigned long lastSensorMillis = 0;
String statusPompa1DariUno = "OFF";
String statusPompa2DariUno = "OFF";

// Baca tegangan rata-rata dari pin analog (oversampling)
float readAnalogVoltage(int pin) {
  const int N = 16;
  unsigned long sum = 0;
  for (int i = 0; i < N; i++) {
    sum += analogRead(pin);
    delay(3);
  }
  float avg = (float)sum / N;
  return avg * VREF / ADC_RESOLUTION;
}

// Bersihkan buffer Serial1
void flushSerial1Input() {
  while (Serial1.available() > 0) {
    Serial1.read();
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial1.begin(9600, SERIAL_8N1, RX1_PIN, TX1_PIN);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(TDS_SENSOR_PIN, ADC_11db);
  analogSetPinAttenuation(PH_SENSOR_PIN, ADC_11db);

  Serial.println("ESP32-S3 SYSTEM READY (Ultrasonik + TDS + pH)");
}

void loop() {
  unsigned long currentMillis = millis();

  if (currentMillis - lastSensorMillis >= 1000) {
    lastSensorMillis = currentMillis;

    // ---------- 1. BACA ULTRASONIK ----------
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);

    long durasi = pulseIn(ECHO_PIN, HIGH, 30000);
    jarakCm = durasi * 0.034 / 2;
    if (jarakCm > 400 || jarakCm <= 0) jarakCm = 999;  

    // ---------- 2. BACA TDS ----------
    pinMode(TDS_SENSOR_PIN, INPUT);
    delay(20);
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

    // ---------- 3. BACA pH ----------
    pinMode(PH_SENSOR_PIN, INPUT);
    delay(20);
    float ph_voltage = readAnalogVoltage(PH_SENSOR_PIN);
    current_ph = PH_SLOPE * ph_voltage + PH_INTERCEPT;
    if (current_ph < 0) current_ph = 0;
    if (current_ph > 14) current_ph = 14;

    // ---------- 4. LOGIKA KONTROL POMPA ----------
    bool ultrasonikValid = (jarakCm != 999);

    if (ultrasonikValid) {
      // Logika Pompa 1 (Dengan Histeresis ON/OFF)
      if (jarakCm > JARAK_ON && current_tds > TDS_ON) {
        perintahPompa1 = true;
      } else if (jarakCm < JARAK_OFF || current_tds < TDS_OFF) {
        perintahPompa1 = false;
      }

      // PERBAIKAN: Logika Pompa 2 disamakan sementara menggunakan JARAK_ON & TDS_ON
      // Silakan ganti threshold ini jika Pompa 2 punya aturan sendiri
      if (jarakCm > JARAK_ON && current_tds > TDS_ON) {
        perintahPompa2 = true;
      } else if (jarakCm < JARAK_OFF || current_tds < TDS_OFF) {
        perintahPompa2 = false;
      }
    }

    // ---------- 5. KIRIM PERINTAH KE ARDUINO ----------
    flushSerial1Input();  
    Serial1.print("P1:");
    Serial1.println(perintahPompa1 ? "1" : "0");
    Serial1.print("P2:");
    Serial1.println(perintahPompa2 ? "1" : "0");

    // ---------- 6. TUNGGU & BACA FEEDBACK ----------
    unsigned long waitStart = millis();
    while (millis() - waitStart < 100) {  
      if (Serial1.available() > 0) {
        String fb = Serial1.readStringUntil('\n');
        fb.trim();
        if (fb.startsWith("F1:")) statusPompa1DariUno = fb.substring(3);
        if (fb.startsWith("F2:")) statusPompa2DariUno = fb.substring(3);
      }
    }

    // ---------- 7. DASHBOARD MONITOR ----------
    Serial.println("====== MONITOR DASHBOARD ESP32-S3 ======");
    Serial.printf("Jarak Air      : %d cm\n", jarakCm);
    Serial.printf("TDS Air        : %.1f ppm\n", current_tds);
    Serial.printf("pH Air         : %.2f\n", current_ph);
    Serial.print("Perintah Pompa1: ");
    Serial.println(perintahPompa1 ? "ON" : "OFF");
    Serial.print("Perintah Pompa2: ");
    Serial.println(perintahPompa2 ? "ON" : "OFF");
    Serial.print("Feedback Pompa1: ");
    Serial.println(statusPompa1DariUno);
    Serial.print("Feedback Pompa2: ");
    Serial.println(statusPompa2DariUno);
    Serial.println("-----------------------------------------");
  }
}