#!/usr/bin/env bash
# =============================================================================
# Helioponic — IoT Simulator v3.0
# =============================================================================
# Auto-simulation script untuk development. Menerbitkan data sensor realistis
# via MQTT ke topic helioponic/sensor/uplink setiap 1 detik.
#
# Data disimpan ke MongoDB oleh backend dan bisa langsung dibaca oleh
# mobile app secara real-time via WebSocket / REST API.
#
# Payload format menggunakan nama field firmware asli:
#   jarak_cm, tds_value, current_ph, pompa1, pompa2
#
# Fitur:
#   - Pump state machine (pompa1, pompa2)
#   - Skenario alarm (pH out of range, water level rendah)
#   - Random variasi data realistis
#   - Auto-register test user + device (--register)
#   - Log real-time ke terminal
#
# Usage:
#   chmod +x tools/simulate.sh
#   ./tools/simulate.sh                           # Mode normal
#   ./tools/simulate.sh --alarm                   # pH out of range
#   ./tools/simulate.sh --filling                 # Level air naik (PDAM)
#   ./tools/simulate.sh --register                # Register device + mulai
#   ./tools/simulate.sh --device HELIO_CUSTOM_01  # Device ID kustom
#   ./tools/simulate.sh --count 10                # Kirim 10 data lalu selesai
#   ./tools/simulate.sh --help                    # Bantuan
# =============================================================================

set -euo pipefail

# ---- Konfigurasi Default ----
BROKER="localhost"
PORT=1883
TOPIC="helioponic/sensor/uplink"
DEVICE_ID="HELIO_SIM_001"
INTERVAL=1          # detik antar publish (match hardware 1s)
MODE="normal"
MAX_COUNT=0         # 0 = tak terbatas (Ctrl+C untuk berhenti)
DO_REGISTER=false
API_BASE="http://localhost:8000/api/v1"

# ---- Warna Terminal ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ---- Parsing Argumen ----
while [[ $# -gt 0 ]]; do
  case $1 in
    --broker)    BROKER="$2"; shift 2 ;;
    --port)      PORT="$2"; shift 2 ;;
    --interval)  INTERVAL="$2"; shift 2 ;;
    --device)    DEVICE_ID="$2"; shift 2 ;;
    --count)     MAX_COUNT="$2"; shift 2 ;;
    --alarm)     MODE="alarm"; shift ;;
    --filling)   MODE="filling"; shift ;;
    --register)  DO_REGISTER=true; shift ;;
    --api)       API_BASE="$2"; shift 2 ;;
    --help)
      echo "Helioponic IoT Simulator — v3.0"
      echo ""
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --broker HOST      MQTT broker host (default: localhost)"
      echo "  --port PORT        MQTT broker port (default: 1883)"
      echo "  --interval SECONDS Publish interval (default: 1)"
      echo "  --device ID        Device ID (default: HELIO_SIM_001)"
      echo "  --count N          Kirim N data lalu selesai (default: tak terbatas)"
      echo "  --alarm            Simulasi alarm (pH/TDS out of range)"
      echo "  --filling          Simulasi pengisian air (jarak_cm mengecil)"
      echo "  --register         Register test user + device via API"
      echo "  --api URL          Base URL backend API"
      echo "  --help             Tampilkan bantuan ini"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 --help"
      exit 1
      ;;
  esac
done

# =============================================================================
# FUNGSI REGISTER — Buat user + device via REST API
# =============================================================================

register_user_and_device() {
  local email="sim@helioponic.io"
  local password="sim123"
  local name="Simulation User"

  echo ""
  echo -e "${CYAN}══════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Mendaftarkan User & Device via API...${NC}"
  echo -e "${CYAN}══════════════════════════════════════════════${NC}"
  echo ""

  local health
  health=$(curl -s --connect-timeout 3 "$API_BASE/health" 2>/dev/null || echo "")
  if [[ -z "$health" ]]; then
    echo -e "${RED}✗ Backend API tidak reachable di $API_BASE${NC}"
    echo "  Pastikan Docker container sudah running:"
    echo "    docker compose up -d"
    exit 1
  fi
  echo -e "${GREEN}✓ Backend API reachable${NC}"

  echo -e "Registering user: ${YELLOW}$email${NC} / device: ${YELLOW}$DEVICE_ID${NC}..."
  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/auth/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"email\": \"$email\",
      \"password\": \"$password\",
      \"name\": \"$name\",
      \"device_id\": \"$DEVICE_ID\",
      \"device_name\": \"$DEVICE_ID (Simulated)\"
    }" 2>/dev/null || echo "")

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  if [[ "$http_code" == "201" ]]; then
    echo -e "${GREEN}✓ Registrasi berhasil!${NC}"
    echo "  Email:    $email"
    echo "  Password: $password"
    echo "  Device:   $DEVICE_ID"
    echo -e "${YELLOW}Gunakan kredensial ini untuk login di mobile app.${NC}"
  elif [[ "$http_code" == "409" ]]; then
    echo -e "${YELLOW}⚠ User atau device sudah terdaftar.${NC}"
  else
    echo -e "${RED}✗ Gagal register: HTTP $http_code${NC}"
    echo "  $body"
    exit 1
  fi
  echo ""
}

if [[ "$DO_REGISTER" == true ]]; then
  register_user_and_device
fi

# ---- Verifikasi Prasyarat ----
if ! command -v mosquitto_pub &>/dev/null; then
  echo -e "${RED}Error: mosquitto_pub tidak ditemukan.${NC}"
  echo "Install Mosquitto clients:"
  echo "  Ubuntu/Debian: sudo apt install mosquitto-clients"
  echo "  macOS: brew install mosquitto"
  exit 1
fi

# ---- Header ----
echo -e "${CYAN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        Helioponic IoT Simulator v3.0                ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  Mode:     ${YELLOW}$MODE${NC}"
echo -e "${CYAN}║${NC}  Device:   ${YELLOW}$DEVICE_ID${NC}"
echo -e "${CYAN}║${NC}  Broker:   ${GREEN}$BROKER:$PORT${NC}"
echo -e "${CYAN}║${NC}  Topic:    ${GREEN}$TOPIC${NC}"
echo -e "${CYAN}║${NC}  Interval: ${GREEN}${INTERVAL}s${NC}"
if [[ $MAX_COUNT -gt 0 ]]; then
  echo -e "${CYAN}║${NC}  Count:    ${GREEN}$MAX_COUNT publishes${NC}"
fi
echo -e "${CYAN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ---- Helper: random float ----
random_float() {
  local min=$1 max=$2
  awk -v min="$min" -v max="$max" 'BEGIN{srand(); printf "%.1f", min+rand()*(max-min)}'
}

random_int() {
  local min=$1 max=$2
  echo $(( RANDOM % (max - min + 1) + min ))
}

# ---- Build Payload (raw firmware field names) ----
# Maps 1:1 to helioponic_esp32.ino publishSensorData()
build_payload() {
  local ts=$1 jarak=$2 tds=$3 ph=$4 p1=$5 p2=$6
  cat <<EOF
{
  "device_id": "$DEVICE_ID",
  "ts": $ts,
  "jarak_cm": $jarak,
  "tds_value": $tds,
  "current_ph": $ph,
  "pompa1": $p1,
  "pompa2": $p2
}
EOF
}

# ---- Persistent State ----
prev_jarak=20
prev_tds=200.0
prev_ph=6.5

# ---- Counter & Timing ----
count=0
start_time=$(date +%s)

# ---- Trap ----
cleanup() {
  echo ""
  echo -e "${CYAN}══════════════════════════════════════════════${NC}"
  echo -e "${GREEN}Simulasi selesai.${NC}"
  echo "Total publish: $count"
  elapsed=$(( $(date +%s) - start_time ))
  echo "Durasi: ${elapsed}s"
  echo -e "${CYAN}══════════════════════════════════════════════${NC}"
  exit 0
}
trap cleanup SIGINT SIGTERM

# ---- Main Loop ----
echo -e "${YELLOW}Memulai simulasi... (Ctrl+C untuk berhenti)${NC}"
echo ""

while true; do
  ts=$(date +%s)

  # ── JARAK_CM (Ultrasonic distance) ──
  # Normal range: 5-25 cm. 999 = out of range.
  # Semakin kecil jarak = air lebih tinggi
  if [[ "$MODE" == "filling" ]]; then
    # PDAM filling: jarak mengecil (air naik)
    jarak=$(awk -v prev="$prev_jarak" 'BEGIN{srand(); printf "%.0f", prev - (rand()*3+1)}')
  else
    # Normal: random walk, 5-25 cm
    jarak=$(awk -v prev="$prev_jarak" 'BEGIN{srand(); printf "%.0f", prev + (rand()-0.5)*4}')
  fi
  if [[ "$jarak" -lt 2 ]]; then jarak=2; fi
  if [[ "$jarak" -gt 200 ]]; then jarak=200; fi
  prev_jarak=$jarak

  # ── TDS_VALUE (TDS in ppm) ──
  # Normal range: 100-400 ppm. Alarm: < 50 atau > 800
  tds_target=$([[ "$MODE" == "alarm" ]] && echo "850" || echo "$(random_int 150 350)")
  tds=$(awk -v prev="$prev_tds" -v target="$tds_target" 'BEGIN{srand(); printf "%.0f", prev + (target-prev)*0.2}')
  if [[ "$tds" -lt 0 ]]; then tds=0; fi
  if [[ "$tds" -gt 1000 ]]; then tds=1000; fi
  prev_tds=$tds

  # ── CURRENT_PH (pH value) ──
  # Normal range: 5.5-7.5. Alarm: < 5.0
  ph_target=$([[ "$MODE" == "alarm" ]] && echo "4.5" || echo "$(random_float 5.5 7.0)")
  ph=$(awk -v prev="$prev_ph" -v target="$ph_target" 'BEGIN{srand(); printf "%.1f", prev + (target-prev)*0.15}')
  if (( $(echo "$ph < 0" | bc -l) )); then ph=0; fi
  if (( $(echo "$ph > 14" | bc -l) )); then ph=14; fi
  prev_ph=$ph

  # ── POMPA STATES ──
  # Automation logic (matches ESP32 firmware):
  # Pompa ON  → jarak > 105 && tds > 105
  # Pompa OFF → jarak < 95 || tds < 95
  p1=0; p2=0
  if [[ "$jarak" -gt 105 && $(echo "$tds > 105" | bc -l) -eq 1 ]]; then
    p1=1; p2=1
  elif [[ "$jarak" -lt 95 ]] || (echo "$tds < 95" | bc -l); then
    p1=0; p2=0
  fi

  # Build & publish
  build_payload "$ts" "$jarak" "$tds" "$ph" "$p1" "$p2" > /tmp/helioponic_payload_$$.json

  if mosquitto_pub -h "$BROKER" -p "$PORT" -t "$TOPIC" -f /tmp/helioponic_payload_$$.json; then
    count=$((count + 1))
    echo -e "[${GREEN}✓${NC}] ${BLUE}$(date '+%H:%M:%S')${NC} jarak=${CYAN}${jarak}cm${NC} tds=${CYAN}${tds}ppm${NC} pH=${CYAN}${ph}${NC} p1=${p1} p2=${p2}"

    if [[ $MAX_COUNT -gt 0 && $count -ge $MAX_COUNT ]]; then
      cleanup
    fi
  else
    echo -e "[${RED}✗${NC}] ${BLUE}$(date '+%H:%M:%S')${NC} ${RED}Publish gagal!${NC} Cek koneksi ke broker $BROKER:$PORT"
  fi

  # Juga kirim ke REST API sebagai fallback
  curl -s -X POST "$API_BASE/sensors/reading" \
    -H "Content-Type: application/json" \
    -d @/tmp/helioponic_payload_$$.json \
    -o /dev/null 2>/dev/null || true

  sleep "${INTERVAL}.0"
done
