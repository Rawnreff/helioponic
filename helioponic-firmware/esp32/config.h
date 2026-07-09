// =============================================================================
// Helioponic — ESP32 Configuration
// =============================================================================
// SOURCE OF TRUTH: helioponic_esp32_raw.ino
//
// The ESP32 is the system master:
//   - Reads water level (HC-SR04 ultrasonic), TDS, pH sensors directly
//   - Runs local pump automation using embedded thresholds
//   - Sends pump commands to Arduino Uno via Serial1
//   - Reads pump feedback from Arduino Uno via Serial1
//   - Connects to WiFi and publishes JSON sensor data via MQTT
//   - Subscribes to MQTT downlink topics for remote threshold/actuator control
// =============================================================================
#ifndef CONFIG_H
#define CONFIG_H

// ---- Sensor Pin Mapping (from raw calibration) ----
#define TRIG_PIN          12    // HC-SR04 Trigger
#define ECHO_PIN          13    // HC-SR04 Echo
#define TDS_SENSOR_PIN    4     // ADC1 GPIO4 — TDS sensor
#define PH_SENSOR_PIN     5     // ADC1 GPIO5 — pH sensor

// ---- Serial1 Pins (Communication with Arduino Uno) ----
// ESP32 TX (pin 17) -> Arduino RX (pin 0)
// ESP32 RX (pin 18) <- Arduino TX (pin 1)
#define TX1_PIN           17
#define RX1_PIN           18

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
#define MQTT_PUBLISH_MS   1000    // Publish to MQTT every 1 second
#define MQTT_RECONNECT_MS 5000    // MQTT reconnect delay (ms)
#define SERIAL_BAUD       115200  // ESP32 debug console baud

// ---- Device Identity ----
#define DEVICE_ID         "HELIO_001"

// ---- MQTT Broker ----
#define MQTT_BROKER       "localhost"
#define MQTT_PORT         1883
#define MQTT_CLIENT_ID    "helioponic_esp32_001"

// ---- MQTT Topics ----
#define TOPIC_UPLINK            "helioponic/sensor/uplink"        // ESP32 -> Broker (QoS 0)
#define TOPIC_DOWNLINK          "helioponic/config/downlink"      // Broker -> ESP32 — threshold config (QoS 1)
#define TOPIC_ACTUATOR_DOWNLINK "helioponic/actuator/downlink"    // Broker -> ESP32 — pump command (QoS 1)

#endif // CONFIG_H
