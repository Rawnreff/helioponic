#define RELAY_POMPA1  4  
#define RELAY_POMPA2  5  

String stateP1 = "OFF";
String stateP2 = "OFF";

void setup() {
  // Kunci logika HIGH sebelum deklarasi OUTPUT agar relay tidak trigger acak saat MCB naik
  digitalWrite(RELAY_POMPA1, HIGH);
  digitalWrite(RELAY_POMPA2, HIGH);

  pinMode(RELAY_POMPA1, OUTPUT);
  pinMode(RELAY_POMPA2, OUTPUT);

  Serial.begin(9600);
}

void loop() {
  // PROSES RECEPTION DATA PERINTAH DARI ESP32
  if (Serial.available() > 0) {
    String dataMasuk = Serial.readStringUntil('\n');
    dataMasuk.trim();

    bool adaPerubahan = false;

    if (dataMasuk.startsWith("P1:")) {
      String cmd = dataMasuk.substring(3);
      if (cmd == "1" && stateP1 != "ON") {
        digitalWrite(RELAY_POMPA1, LOW);  // LOW = relay ON (Active-Low)
        stateP1 = "ON";
        adaPerubahan = true;
      } else if (cmd == "0" && stateP1 != "OFF") {
        digitalWrite(RELAY_POMPA1, HIGH); // HIGH = relay OFF
        stateP1 = "OFF";
        adaPerubahan = true;
      }
    }
    else if (dataMasuk.startsWith("P2:")) {
      String cmd = dataMasuk.substring(3);
      if (cmd == "1" && stateP2 != "ON") {
        digitalWrite(RELAY_POMPA2, LOW);
        stateP2 = "ON";
        adaPerubahan = true;
      } else if (cmd == "0" && stateP2 != "OFF") {
        digitalWrite(RELAY_POMPA2, HIGH);
        stateP2 = "OFF";
        adaPerubahan = true;
      }
    }

    Serial.print("F1:"); Serial.println(stateP1);
    Serial.print("F2:"); Serial.println(stateP2);
  }
}
