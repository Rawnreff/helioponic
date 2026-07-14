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
#   jarak_cm, tds_value, current_ph
#   ⚠️  Pompa1/pompa2 TIDAK dikirim — backend automation yg menentukan
#
# Fitur:
#   - Hanya mengirim sensor readings (jarak, tds, ph)
#   - Pump states ditentukan oleh backend automation & mobile app
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
MQTT_USER="helioponic"
MQTT_PASS="helioponic_mqtt_2024"
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

# ---- Compute pump states (bang-bang hysteresis, matches backend) ----
# Pompa 1 (Water Refill): ON when jarak > JARAK_ON, OFF when jarak < JARAK_OFF
# Pompa 2 (pH DOWN):      ON when pH > PH_MAX, OFF when pH < PH_MIN
JARAK_ON=5.0
JARAK_OFF=2.0
PH_MAX=6.5
PH_MIN=5.5

# ---- Fetch device config dari backend (sync dengan AutomationScreen) ----
# Meng-override JARAK_ON/OFF dan PH_MIN/MAX dengan nilai dari backend.
# Kalau backend unreachable, pakai hardcoded defaults di atas.
fetch_device_config() {
  local url="$API_BASE/devices/config?device_id=$DEVICE_ID"
  local response
  response=$(curl -s --connect-timeout 3 "$url" 2>/dev/null || echo "")

  if [[ -n "$response" ]]; then
    # Parse JSON key-value pairs, handling spaces after colon (e.g. "jarak_on": 2.0)
    local fetched_jarak_on fetched_jarak_off fetched_ph_min fetched_ph_max
    fetched_jarak_on=$(echo "$response" | sed -n 's/.*"jarak_on"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')
    fetched_jarak_off=$(echo "$response" | sed -n 's/.*"jarak_off"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')
    fetched_ph_min=$(echo "$response" | sed -n 's/.*"ph_min"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')
    fetched_ph_max=$(echo "$response" | sed -n 's/.*"ph_max"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')

    if [[ -n "$fetched_jarak_on" ]]; then JARAK_ON=$fetched_jarak_on; fi
    if [[ -n "$fetched_jarak_off" ]]; then JARAK_OFF=$fetched_jarak_off; fi
    if [[ -n "$fetched_ph_min" ]]; then PH_MIN=$fetched_ph_min; fi
    if [[ -n "$fetched_ph_max" ]]; then PH_MAX=$fetched_ph_max; fi

    echo -e "${GREEN}✓ Thresholds synced from backend:${NC}"
    echo "  jarak_on=$JARAK_ON jarak_off=$JARAK_OFF ph_min=$PH_MIN ph_max=$PH_MAX"
  else
    echo -e "${YELLOW}⚠ Backend unreachable — using hardcoded defaults:${NC}"
    echo "  jarak_on=$JARAK_ON jarak_off=$JARAK_OFF ph_min=$PH_MIN ph_max=$PH_MAX"
  fi
}

# Panggil fetch config di startup
fetch_device_config

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
# Kirim SENSOR + PUMP states (unified format).
# pompa1/pompa2 WAJIB dikirim (required int 0/1).
# Backend memperlakukan SEMUA data sebagai Source of Truth — persist AS-IS.
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

compute_pumps() {
  local jarak=$1 tds=$2 ph=$3
  local p1=0 p2=0

  # Pompa 1 — Water Level
  if (( $(echo "$jarak > $JARAK_ON" | awk '{print ($1 > $2)}') )); then p1=1; fi
  if (( $(echo "$jarak < $JARAK_OFF" | awk '{print ($1 < $2)}') )); then p1=0; fi

  # Pompa 2 — pH DOWN
  if (( $(echo "$ph > $PH_MAX" | awk '{print ($1 > $2)}') )); then p2=1; fi
  if (( $(echo "$ph < $PH_MIN" | awk '{print ($1 < $2)}') )); then p2=0; fi

  echo "$p1 $p2"
}

# ---- Persistent State ----
prev_jarak=2.5  # Typical water level (~4.5cm air di tank 7cm = ~64%)
prev_tds=200.0
prev_ph=6.0  # Start below default ph_max (6.5) so pH crossing is visible quickly
prev_p1=0
prev_p2=0

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
  if [[ "$MODE" == "filling" ]]; then
    jarak=$(awk -v prev="$prev_jarak" 'BEGIN{srand(); printf "%.1f", prev - (rand()*1.2+0.3)}')
  else
    jarak=$(awk -v prev="$prev_jarak" 'BEGIN{srand(); printf "%.1f", prev + (rand()-0.5)*1.5}')
  fi
  if (( $(echo "$jarak < 0" | awk '{print ($1 < 0)}') )); then jarak=0.0; fi
  if (( $(echo "$jarak > 4" | awk '{print ($1 > 4)}') )); then jarak=4.0; fi
  jarak=$(printf "%.1f" "$jarak")
  prev_jarak=$jarak

  # ── TDS_VALUE (TDS in ppm) ──
  tds_target=$([[ "$MODE" == "alarm" ]] && echo "850" || echo "$(random_int 150 350)")
  tds=$(awk -v prev="$prev_tds" -v target="$tds_target" 'BEGIN{srand(); printf "%.0f", prev + (target-prev)*0.2}')
  if [[ "$tds" -lt 0 ]]; then tds=0; fi
  if [[ "$tds" -gt 1000 ]]; then tds=1000; fi
  prev_tds=$tds

  # ── CURRENT_PH (pH value) ──
  ph_target=$([[ "$MODE" == "alarm" ]] && echo "4.5" || echo "$(random_float 5.5 7.0)")
  ph=$(awk -v prev="$prev_ph" -v target="$ph_target" 'BEGIN{srand(); printf "%.1f", prev + (target-prev)*0.15}')
  if (( $(echo "$ph < 0" | awk '{print ($1 < 0)}') )); then ph=0; fi
  if (( $(echo "$ph > 14" | awk '{print ($1 > 14)}') )); then ph=14; fi
  prev_ph=$ph

  # ── POMPA STATES (computed via bang-bang hysteresis) ──
  read p1 p2 <<< "$(compute_pumps "$jarak" "$tds" "$ph")"
  # Apply hysteresis: don't change if in deadband
  if [[ "$p1" != "$prev_p1" ]]; then
    # Only change if hysteresis condition is met
    if [[ "$p1" == "1" ]] && (( $(echo "$jarak > $JARAK_ON" | awk '{print ($1 > $2)}') )); then prev_p1=1; fi
    if [[ "$p1" == "0" ]] && (( $(echo "$jarak < $JARAK_OFF" | awk '{print ($1 < $2)}') )); then prev_p1=0; fi
  fi
  if [[ "$p2" != "$prev_p2" ]]; then
    if [[ "$p2" == "1" ]] && (( $(echo "$ph > $PH_MAX" | awk '{print ($1 > $2)}') )); then prev_p2=1; fi
    if [[ "$p2" == "0" ]] && (( $(echo "$ph < $PH_MIN" | awk '{print ($1 < $2)}') )); then prev_p2=0; fi
  fi
  p1=$prev_p1
  p2=$prev_p2

  # Build & publish — DENGAN pompa1/pompa2 (unified ingestion)
  build_payload "$ts" "$jarak" "$tds" "$ph" "$p1" "$p2" > /tmp/helioponic_payload_$$.json

  if mosquitto_pub -h "$BROKER" -p "$PORT" -u "$MQTT_USER" -P "$MQTT_PASS" -t "$TOPIC" -f /tmp/helioponic_payload_$$.json; then
    count=$((count + 1))
    echo -e "[${GREEN}✓${NC}] ${BLUE}$(date '+%H:%M:%S')${NC} jarak=${CYAN}${jarak}cm${NC} tds=${CYAN}${tds}ppm${NC} pH=${CYAN}${ph}${NC} P1=${YELLOW}$p1${NC} P2=${YELLOW}$p2${NC}"

    if [[ $MAX_COUNT -gt 0 && $count -ge $MAX_COUNT ]]; then
      cleanup
    fi
  else
    echo -e "[${RED}✗${NC}] ${BLUE}$(date '+%H:%M:%S')${NC} ${RED}Publish gagal!${NC} Cek koneksi ke broker $BROKER:$PORT"
  fi

  # Juga kirim ke REST API sebagai fallback (with pompa fields)
  curl -s -X POST "$API_BASE/sensors/reading" \
    -H "Content-Type: application/json" \
    -d @/tmp/helioponic_payload_$$.json \
    -o /dev/null 2>/dev/null || true

  sleep "${INTERVAL}.0"
done
