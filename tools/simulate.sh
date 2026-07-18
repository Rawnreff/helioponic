#!/usr/bin/env bash
# =============================================================================
# Helioponic - IoT Simulator (DEPRECATED — use simulate.py instead)
# =============================================================================
# ⚠️  This bash simulator is DEPRECATED.
# ⚠️  Please use the Python version instead:
# ⚠️    python tools/simulate.py
# ⚠️
# ⚠️  The Python version (v5.0) has all features plus:
# ⚠️    - Physics engine: sensor values react to pump states (realistic)
# ⚠️    - Proper floating point (no awk hacks)
# ⚠️    - Native JSON parsing
# ⚠️    - No 'local' keyword bugs
# ⚠️    - Proper async HTTP (doesn't block sensor loop)
# ⚠️
# ⚠️  This file is kept for reference only and will be removed in a future update.
#
# Legacy usage (not recommended):
#   bash tools/simulate.sh                           # Normal mode
#   bash tools/simulate.sh --alarm                   # pH out of range
#   bash tools/simulate.sh --filling                 # Water level rising
#   bash tools/simulate.sh --register                # Register device first
#   bash tools/simulate.sh --device CUSTOM_ID       # Custom device ID
#   bash tools/simulate.sh --count 10               # Send N data then exit
#   bash tools/simulate.sh --help                   # Show help
# =============================================================================

set -euo pipefail

# ---- Configuration ----
BROKER="localhost"
PORT=1883
MQTT_USER="helioponic"
MQTT_PASS="helioponic_mqtt_2024"
TOPIC_SENSOR="helioponic/sensor/uplink"
TOPIC_STATUS="helioponic/status/uplink"
TOPIC_ALARM="helioponic/alarm/uplink"
DEVICE_ID="HELIO_SIM_001"
MODE="normal"
MAX_COUNT=0
DO_REGISTER=false
API_BASE="http://localhost:8000/api/v1"

# JWT authentication token — obtained via login API
AUTH_TOKEN=""

# Simulation credentials for API auth
SIM_EMAIL="sim@helioponic.io"
SIM_PASSWORD="sim123"

# ESP32 timing constants (matches firmware)
SENSOR_INTERVAL=0.2     # 200ms per sensor cycle
PUBLISH_INTERVAL=1.0    # 1000ms per publish cycle
HEARTBEAT_INTERVAL=30   # 30 seconds between heartbeats
OVERRIDE_TIMEOUT=1800   # 30 minutes auto-clear
ALARM_COOLDOWN=60       # 60 seconds alarm cooldown
FW_VERSION="3.3.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ---- Argument Parsing ----
while [[ $# -gt 0 ]]; do
  case $1 in
    --broker)    BROKER="$2"; shift 2 ;;
    --port)      PORT="$2"; shift 2 ;;
    --device)    DEVICE_ID="$2"; shift 2 ;;
    --count)     MAX_COUNT="$2"; shift 2 ;;
    --alarm)     MODE="alarm"; shift ;;
    --filling)   MODE="filling"; shift ;;
    --register)  DO_REGISTER=true; shift ;;
    --api)       API_BASE="$2"; shift 2 ;;
    --help)
      echo "Helioponic IoT Simulator v4.1 (ESP32-Mimic)"
      echo ""
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --broker HOST      MQTT broker host (default: localhost)"
      echo "  --port PORT        MQTT broker port (default: 1883)"
      echo "  --device ID        Device ID (default: HELIO_SIM_001)"
      echo "  --count N          Send N publishes then exit (default: unlimited)"
      echo "  --alarm            Simulate alarm (pH/TDS out of range)"
      echo "  --filling          Simulate rising water level"
      echo "  --register         Register test user + device via API"
      echo "  --api URL          Backend API base URL"
      exit 0
      ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# =============================================================================
# Registration (via REST API)
# =============================================================================

register_user_and_device() {
  local email="$SIM_EMAIL"
  local password="$SIM_PASSWORD"
  local name="Simulation User"
  echo ""
  echo -e "${CYAN}Registering user & device via API...${NC}"
  echo ""

  local health
  health=$(curl -s --connect-timeout 3 "$API_BASE/health" 2>/dev/null || echo "")
  if [[ -z "$health" ]]; then
    echo -e "${RED}Backend API not reachable at $API_BASE${NC}"
    echo "  Ensure Docker is running: docker compose up -d"
    exit 1
  fi
  echo -e "${GREEN}Backend API reachable${NC}"

  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\",\"name\":\"$name\",\"device_id\":\"$DEVICE_ID\",\"device_name\":\"$DEVICE_ID (Simulated)\"}" 2>/dev/null || echo "")

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  if [[ "$http_code" == "201" ]]; then
    echo -e "${GREEN}Registration successful!${NC}"
    echo "  Email: $email / Password: $password / Device: $DEVICE_ID"
    # Extract token from registration response and save it
    AUTH_TOKEN=$(echo "$body" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  elif [[ "$http_code" == "409" ]]; then
    echo -e "${YELLOW}User or device already registered.${NC}"
  else
    echo -e "${RED}Registration failed: HTTP $http_code${NC}"
    exit 1
  fi
  echo ""
}

if [[ "$DO_REGISTER" == true ]]; then
  register_user_and_device
fi

# =============================================================================
# Login — get JWT token for authenticated API calls
# =============================================================================

login() {
  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$SIM_EMAIL\",\"password\":\"$SIM_PASSWORD\"}" 2>/dev/null || echo "")

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  if [[ "$http_code" == "200" ]]; then
    AUTH_TOKEN=$(echo "$body" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    if [[ -n "$AUTH_TOKEN" ]]; then
      echo -e "${GREEN}Logged in successfully (JWT token obtained)${NC}"
    fi
  else
    echo -e "${YELLOW}Login failed (HTTP $http_code) - API calls will use defaults${NC}"
  fi
}

# Try to login (succeeds if user was previously registered)
login

# =============================================================================
# Threshold & Sensor Range Configuration
# =============================================================================

JARAK_ON=5.0
JARAK_OFF=2.0
TDS_ON=95.0
TDS_OFF=105.0
PH_MAX=6.5
PH_MIN=5.5

# Auto mode flag — fetched from /devices/automation
AUTO_ENABLED=true

# Dynamic sensor ranges (calculated after fetch_device_config)
JARAK_MIN=0.0
JARAK_MAX=0.0
TDS_MIN=0
TDS_MAX=0
PH_RANGE_MIN=0.0
PH_RANGE_MAX=0.0

calc_sensor_ranges() {
  # All sensor ranges are HARDCODED (not dynamic based on thresholds).
  # The thresholds are applied by compute_pumps() when deciding pump states.
  # This ensures sensor values always cross typical threshold ranges.
  JARAK_MIN=0.5
  JARAK_MAX=15.0
  TDS_MIN=300
  TDS_MAX=500
  PH_RANGE_MIN=4.0
  PH_RANGE_MAX=9.0
}

# Track previous threshold values for change detection
PREV_JARAK_ON=0
PREV_JARAK_OFF=0
PREV_TDS_ON=0
PREV_TDS_OFF=0
PREV_PH_MIN=0
PREV_PH_MAX=0

fetch_device_config() {
  local url="$API_BASE/devices/config?device_id=$DEVICE_ID"
  local response
  if [[ -n "$AUTH_TOKEN" ]]; then
    response=$(curl -s --connect-timeout 3 -H "Authorization: Bearer $AUTH_TOKEN" "$url" 2>/dev/null || echo "")
  else
    response=$(curl -s --connect-timeout 3 "$url" 2>/dev/null || echo "")
  fi

  if [[ -n "$response" ]]; then
    f_jon=$(echo "$response" | sed -n 's/.*"jarak_on"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')
    f_joff=$(echo "$response" | sed -n 's/.*"jarak_off"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')
    f_ton=$(echo "$response" | sed -n 's/.*"tds_on"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')
    f_toff=$(echo "$response" | sed -n 's/.*"tds_off"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')
    f_phmin=$(echo "$response" | sed -n 's/.*"ph_min"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')
    f_phmax=$(echo "$response" | sed -n 's/.*"ph_max"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p')

    [[ -n "$f_jon" ]] && JARAK_ON=$f_jon
    [[ -n "$f_joff" ]] && JARAK_OFF=$f_joff
    [[ -n "$f_ton" ]] && TDS_ON=$f_ton
    [[ -n "$f_toff" ]] && TDS_OFF=$f_toff
    [[ -n "$f_phmin" ]] && PH_MIN=$f_phmin
    [[ -n "$f_phmax" ]] && PH_MAX=$f_phmax
  fi

  # Detect changes and print only when thresholds actually change
  if [[ "$JARAK_ON" != "$PREV_JARAK_ON" || "$JARAK_OFF" != "$PREV_JARAK_OFF" || \
        "$TDS_ON" != "$PREV_TDS_ON" || "$TDS_OFF" != "$PREV_TDS_OFF" || \
        "$PH_MIN" != "$PREV_PH_MIN" || "$PH_MAX" != "$PREV_PH_MAX" ]]; then
    echo -e "${GREEN}Thresholds updated:${NC}"
    echo "  jarak_on=$JARAK_ON jarak_off=$JARAK_OFF tds_on=$TDS_ON tds_off=$TDS_OFF ph_min=$PH_MIN ph_max=$PH_MAX"
    PREV_JARAK_ON=$JARAK_ON
    PREV_JARAK_OFF=$JARAK_OFF
    PREV_TDS_ON=$TDS_ON
    PREV_TDS_OFF=$TDS_OFF
    PREV_PH_MIN=$PH_MIN
    PREV_PH_MAX=$PH_MAX
  fi
}

# Fetch automation rules (auto_enabled, rule_ph, rule_tds, rule_water)
# Called initially and then periodically in the main loop
fetch_automation_rules() {
  local url="$API_BASE/devices/automation?device_id=$DEVICE_ID"
  local response
  if [[ -n "$AUTH_TOKEN" ]]; then
    response=$(curl -s --connect-timeout 2 -H "Authorization: Bearer $AUTH_TOKEN" "$url" 2>/dev/null || echo "")
  else
    response=$(curl -s --connect-timeout 2 "$url" 2>/dev/null || echo "")
  fi

  if [[ -n "$response" ]]; then
    local f_auto
    f_auto=$(echo "$response" | sed -n 's/.*"auto_enabled"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p')
    if [[ -n "$f_auto" ]]; then
      if [[ "$f_auto" != "$AUTO_ENABLED" ]]; then
        if [[ "$f_auto" == "true" ]]; then
          echo -e "${GREEN}AUTO MODE ENABLED (detected via API poll)${NC}"
        else
          echo -e "${YELLOW}AUTO MODE DISABLED (detected via API poll) - pumps will not change state${NC}"
        fi
        AUTO_ENABLED=$f_auto
      fi
    fi
  fi
}

fetch_device_config
calc_sensor_ranges
echo -e "${GREEN}Sensor ranges:${NC}"
echo "  jarak=[$JARAK_MIN-$JARAK_MAX]cm tds=[${TDS_MIN}-${TDS_MAX}]ppm ph=[$PH_RANGE_MIN-$PH_RANGE_MAX]"
fetch_automation_rules

# ---- Prerequisites ----
if ! command -v mosquitto_pub &>/dev/null; then
  echo -e "${RED}Error: mosquitto_pub not found${NC}"
  echo "Install Mosquitto clients: sudo apt install mosquitto-clients"
  exit 1
fi

if ! command -v mosquitto_sub &>/dev/null; then
  echo -e "${YELLOW}Warning: mosquitto_sub not found - override listener disabled${NC}"
  HAS_MOSQUITTO_SUB=false
else
  HAS_MOSQUITTO_SUB=true
fi

# ---- Header ----
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Helioponic IoT Simulator v4.1            ${NC}"
echo -e "${CYAN}  (ESP32-Mimic Mode)                        ${NC}"
echo -e "${CYAN}============================================${NC}"
echo -e "  Mode:     ${YELLOW}$MODE${NC}"
echo -e "  Device:   ${YELLOW}$DEVICE_ID${NC}"
echo -e "  Auto:     ${YELLOW}$AUTO_ENABLED${NC}"
echo -e "  Broker:   ${GREEN}$BROKER:$PORT${NC}"
echo -e "  Publish:  ${GREEN}${PUBLISH_INTERVAL}s${NC}"
echo -e "  Sensor:   ${GREEN}${SENSOR_INTERVAL}s${NC}"
if [[ $MAX_COUNT -gt 0 ]]; then
  echo -e "  Count:    ${GREEN}$MAX_COUNT publishes${NC}"
fi
echo -e "${CYAN}============================================${NC}"
echo ""

# =============================================================================
# Helper Functions
# =============================================================================

random_float() {
  local min=$1 max=$2
  awk -v min="$min" -v max="$max" 'BEGIN{srand(); printf "%.1f", min+rand()*(max-min)}'
}

random_int() {
  local min=$1 max=$2
  echo $(( RANDOM % (max - min + 1) + min ))
}

# ---- MQTT Publish Helper ----
mqtt_publish() {
  local topic=$1 file=$2
  mosquitto_pub -h "$BROKER" -p "$PORT" -u "$MQTT_USER" -P "$MQTT_PASS" -t "$topic" -f "$file" 2>/dev/null
}

# =============================================================================
# Override Mechanism (MQTT actuator/downlink listener)
# =============================================================================

OVERRIDE_FILE="/tmp/helioponic_overrides_$$.txt"
OVERRIDE_TIME_FILE="/tmp/helioponic_override_times_$$.txt"
: > "$OVERRIDE_FILE"
: > "$OVERRIDE_TIME_FILE"

read_override() {
  local pump=$1
  local val
  val=$(grep "^${pump}:" "$OVERRIDE_FILE" 2>/dev/null | tail -1 | cut -d: -f2)
  echo "${val:-}"
}

read_override_time() {
  local pump=$1
  local t
  t=$(grep "^${pump}:" "$OVERRIDE_TIME_FILE" 2>/dev/null | tail -1 | cut -d: -f2)
  echo "${t:-0}"
}

start_mqtt_listener() {
  if [[ "$HAS_MOSQUITTO_SUB" != true ]]; then
    echo -e "${YELLOW}MQTT override listener disabled (mosquitto_sub not found)${NC}"
    return
  fi
  local ACTUATOR_TOPIC="helioponic/actuator/downlink"
  mosquitto_sub -h "$BROKER" -p "$PORT" -u "$MQTT_USER" -P "$MQTT_PASS" -t "$ACTUATOR_TOPIC" -q 1 2>/dev/null | while read -r line; do
    [[ -z "$line" ]] && continue
    local pump state
    pump=$(echo "$line" | sed -n 's/.*"pump"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    state=$(echo "$line" | sed -n 's/.*"state"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p')
    if [[ -n "$pump" && -n "$state" ]]; then
      local now
      now=$(date +%s)
      echo "${pump}:${state}" >> "$OVERRIDE_FILE"
      echo "${pump}:${now}" >> "$OVERRIDE_TIME_FILE"
      echo -e "${RED}OVERRIDE: ${pump} -> ${state}${NC}"
    fi
  done &
  echo -e "${GREEN}MQTT override listener started ($ACTUATOR_TOPIC)${NC}"
}

# =============================================================================
# Clear expired manual overrides (30 min timeout, matches ESP32 firmware)
# =============================================================================
clear_expired_overrides() {
  local now
  now=$(date +%s)
  local override_active=false

  for pump in pompa1 pompa2 pompa3 pompa4; do
    local val t
    val=$(read_override "$pump")
    t=$(read_override_time "$pump")
    if [[ -n "$val" && "$t" -gt 0 ]]; then
      local age=$(( now - t ))
      if [[ "$age" -ge "$OVERRIDE_TIMEOUT" ]]; then
        grep -v "^${pump}:" "$OVERRIDE_FILE" > "${OVERRIDE_FILE}.tmp" && mv "${OVERRIDE_FILE}.tmp" "$OVERRIDE_FILE"
        grep -v "^${pump}:" "$OVERRIDE_TIME_FILE" > "${OVERRIDE_TIME_FILE}.tmp" && mv "${OVERRIDE_TIME_FILE}.tmp" "$OVERRIDE_TIME_FILE"
        echo -e "${YELLOW}OVERRIDE EXPIRED: ${pump} (${age}s > ${OVERRIDE_TIMEOUT}s) - returning to auto${NC}"
      else
        override_active=true
      fi
    fi
  done
  echo "$override_active"
}

# =============================================================================
# Build payload JSON
# =============================================================================

build_payload() {
  local ts=$1 jarak=$2 tds=$3 ph=$4 p1=$5 p2=$6 p3=$7 p4=$8
  cat <<EOF
{
  "device_id": "$DEVICE_ID",
  "ts": $ts,
  "jarak_cm": $jarak,
  "tds_value": $tds,
  "current_ph": $ph,
  "pompa1": $p1,
  "pompa2": $p2,
  "pompa3": $p3,
  "pompa4": $p4
}
EOF
}

build_heartbeat() {
  local ts=$1 night_mode=$2
  cat <<EOF
{
  "device_id": "$DEVICE_ID",
  "status": "online",
  "ts": $ts,
  "version": "$FW_VERSION",
  "night_mode": $night_mode,
  "wifi_rssi": -45
}
EOF
}

build_alarm() {
  local ts=$1
  cat <<EOF
{
  "device_id": "$DEVICE_ID",
  "alarm_type": "water_level",
  "message": "Water level critical - ultrasonic out of range (jarak_cm=999)",
  "ts": $ts
}
EOF
}

# =============================================================================
# 4-Pump Bang-Bang Hysteresis (matches backend automation.py)
# =============================================================================

compute_pumps() {
  local jarak=$1 tds=$2 ph=$3
  local p1=0 p2=0 p3=0 p4=0

  # Pompa 1 - Water Level
  if (( $(echo "$jarak > $JARAK_ON" | awk '{print ($1 > $2)}') )); then p1=1; fi
  if (( $(echo "$jarak < $JARAK_OFF" | awk '{print ($1 < $2)}') )); then p1=0; fi

  # Pompa 2 - pH DOWN (bang-bang hysteresis)
  if (( $(echo "$ph > $PH_MAX" | awk '{print ($1 > $2)}') )); then p2=1; fi
  if (( $(echo "$ph < $PH_MIN" | awk '{print ($1 < $2)}') )); then p2=0; fi

  # Pompa 3 & 4 - TANDEM TDS Nutrient Dosing
  if (( $(echo "$tds < $TDS_ON" | awk '{print ($1 < $2)}') )); then p3=1; p4=1; fi
  if (( $(echo "$tds > $TDS_OFF" | awk '{print ($1 > $2)}') )); then p3=0; p4=0; fi

  echo "$p1 $p2 $p3 $p4"
}

# =============================================================================
# State
# =============================================================================

# Sensor values (updated every 200ms) - initialized to midpoint of dynamic ranges
sensor_jarak=$(awk "BEGIN { printf \"%.1f\", ($JARAK_MIN + $JARAK_MAX) / 2 }")
sensor_tds=$(awk "BEGIN { printf \"%.0f\", ($TDS_MIN + $TDS_MAX) / 2 }")
sensor_ph=$(awk "BEGIN { printf \"%.1f\", ($PH_RANGE_MIN + $PH_RANGE_MAX) / 2 }")

# Commanded pump states (what ESP32 tells Arduino to do)
cmd_p1=0; cmd_p2=0; cmd_p3=0; cmd_p4=0

# Published pump states (what ESP32 reads back from Arduino - feedback delayed)
pub_p1=0; pub_p2=0; pub_p3=0; pub_p4=0

# Previous commanded state for hysteresis
prev_cmd_p1=0; prev_cmd_p2=0; prev_cmd_p3=0; prev_cmd_p4=0

# Override active flag
override_active=false

# Alarm state
alarm_was_active=false
last_alarm_time=0

# Night mode (not directly simulated, but tracked)
night_mode=false

# Counters
publish_count=0
heartbeat_count=0
sensor_cycle=0
start_time=$(date +%s)

# =============================================================================
# Cleanup Trap
# =============================================================================

cleanup() {
  echo ""
  jobs -p 2>/dev/null | xargs -r kill 2>/dev/null || true
  rm -f "$OVERRIDE_FILE" "$OVERRIDE_TIME_FILE" 2>/dev/null || true
  echo -e "${CYAN}============================================${NC}"
  echo -e "${GREEN}Simulation finished.${NC}"
  echo "  Publishes: $publish_count"
  echo "  Heartbeats: $heartbeat_count"
  echo "  Duration: $(( $(date +%s) - start_time ))s"
  echo -e "${CYAN}============================================${NC}"
  exit 0
}
trap cleanup SIGINT SIGTERM

# =============================================================================
# Start
# =============================================================================

start_mqtt_listener

echo -e "${YELLOW}Starting simulation (Ctrl+C to stop)...${NC}"
echo ""

# =============================================================================
# Main Loop - 200ms sensor cycle with phased publish/heartbeat
# =============================================================================

while true; do
  cycle_start=$(date +%s%N)

  # ==========================================================================
  # 1. Clear expired overrides (matches ESP32 firmware behavior)
  # ==========================================================================
  override_active=$(clear_expired_overrides)

  # ==========================================================================
  # 2. Generate sensor data (like ESP32 reading ADCs every 200ms)
  # ==========================================================================
  ts=$(date +%s)

  # -- JARAK_CM (Ultrasonic) --
  if [[ "$MODE" == "filling" ]]; then
    sensor_jarak=$(awk -v prev="$sensor_jarak" 'BEGIN{srand(); printf "%.1f", prev - (rand()*1.2+0.3)}')
  else
    sensor_jarak=$(awk -v prev="$sensor_jarak" -v min="$JARAK_MIN" -v max="$JARAK_MAX" 'BEGIN{srand(); step=(max-min)/8; printf "%.1f", prev + (rand()-0.5)*step*2}')
  fi
  if (( $(echo "$sensor_jarak < $JARAK_MIN" | awk '{print ($1 < $2)}') )); then sensor_jarak=$JARAK_MIN; fi
  if (( $(echo "$sensor_jarak > $JARAK_MAX" | awk '{print ($1 > $2)}') )); then sensor_jarak=$JARAK_MAX; fi
  sensor_jarak=$(printf "%.1f" "$sensor_jarak")

  # -- TDS_VALUE (user requested range: 300-500ppm) --
  if [[ "$MODE" == "alarm" ]]; then
    tds_target=850
  else
    tds_target=$(awk -v min="$TDS_MIN" -v max="$TDS_MAX" 'BEGIN{srand(); printf "%.0f", min + rand()*(max-min)}')
  fi
  sensor_tds=$(awk -v prev="$sensor_tds" -v target="$tds_target" 'BEGIN{srand(); printf "%.0f", prev + (target-prev)*0.05}')
  [[ "$sensor_tds" -lt 0 ]] && sensor_tds=0
  [[ "$sensor_tds" -gt 1000 ]] && sensor_tds=1000

  # -- CURRENT_PH --
  if [[ "$MODE" == "alarm" ]]; then
    ph_target=4.5
  else
    ph_target=$(awk -v min="$PH_RANGE_MIN" -v max="$PH_RANGE_MAX" 'BEGIN{srand(); printf "%.1f", min + rand()*(max-min)}')
  fi
  sensor_ph=$(awk -v prev="$sensor_ph" -v target="$ph_target" 'BEGIN{srand(); printf "%.1f", prev + (target-prev)*0.04}')
  if (( $(echo "$sensor_ph < 0" | awk '{print ($1 < 0)}') )); then sensor_ph=0; fi
  if (( $(echo "$sensor_ph > 14" | awk '{print ($1 > 14)}') )); then sensor_ph=14; fi

  # ==========================================================================
  # 3. Compute pump states via bang-bang hysteresis
  #    SKIPPED when auto mode is disabled (user toggled OFF in AutomationScreen)
  # ==========================================================================
  if [[ "$AUTO_ENABLED" == "true" ]]; then
    # Save previous states for change detection
    old_p1=$cmd_p1; old_p2=$cmd_p2; old_p3=$cmd_p3; old_p4=$cmd_p4

    read -r comp_p1 comp_p2 comp_p3 comp_p4 <<< "$(compute_pumps "$sensor_jarak" "$sensor_tds" "$sensor_ph")"

    # Apply hysteresis: don't change within deadband
    if [[ "$comp_p1" != "$prev_cmd_p1" ]]; then
      if [[ "$comp_p1" == "1" ]] && (( $(echo "$sensor_jarak > $JARAK_ON" | awk '{print ($1 > $2)}') )); then cmd_p1=1; fi
      if [[ "$comp_p1" == "0" ]] && (( $(echo "$sensor_jarak < $JARAK_OFF" | awk '{print ($1 < $2)}') )); then cmd_p1=0; fi
    fi
    if [[ "$comp_p2" != "$prev_cmd_p2" ]]; then
      if [[ "$comp_p2" == "1" ]] && (( $(echo "$sensor_ph > $PH_MAX" | awk '{print ($1 > $2)}') )); then cmd_p2=1; fi
      if [[ "$comp_p2" == "0" ]] && (( $(echo "$sensor_ph < $PH_MIN" | awk '{print ($1 < $2)}') )); then cmd_p2=0; fi
    fi
    if [[ "$comp_p3" != "$prev_cmd_p3" ]]; then
      if [[ "$comp_p3" == "1" ]] && (( $(echo "$sensor_tds < $TDS_ON" | awk '{print ($1 < $2)}') )); then cmd_p3=1; cmd_p4=1; fi
      if [[ "$comp_p3" == "0" ]] && (( $(echo "$sensor_tds > $TDS_OFF" | awk '{print ($1 > $2)}') )); then cmd_p3=0; cmd_p4=0; fi
    fi

    prev_cmd_p1=$cmd_p1; prev_cmd_p2=$cmd_p2; prev_cmd_p3=$cmd_p3; prev_cmd_p4=$cmd_p4

    # ---- Log pump state changes (shows WHY pump changed state) ----
    if [[ "$old_p1" != "$cmd_p1" ]]; then
      echo -e "  ${CYAN}[AUTO]${NC} P1: ${YELLOW}$old_p1→$cmd_p1${NC} (jarak=$sensor_jarak, jarak_on=$JARAK_ON, jarak_off=$JARAK_OFF)"
    fi
    if [[ "$old_p2" != "$cmd_p2" ]]; then
      echo -e "  ${CYAN}[AUTO]${NC} P2: ${YELLOW}$old_p2→$cmd_p2${NC} (ph=$sensor_ph, ph_min=$PH_MIN, ph_max=$PH_MAX)"
    fi
    if [[ "$old_p3" != "$cmd_p3" ]]; then
      if [[ "$cmd_p3" == "1" ]]; then
        echo -e "  ${CYAN}[AUTO]${NC} P3: ${YELLOW}$old_p3→$cmd_p3${NC} (tds=$sensor_tds < tds_on=$TDS_ON)"
      else
        echo -e "  ${CYAN}[AUTO]${NC} P3: ${YELLOW}$old_p3→$cmd_p3${NC} (tds=$sensor_tds > tds_off=$TDS_OFF)"
      fi
    fi
    if [[ "$old_p4" != "$cmd_p4" ]]; then
      if [[ "$cmd_p4" == "1" ]]; then
        echo -e "  ${CYAN}[AUTO]${NC} P4: ${YELLOW}$old_p4→$cmd_p4${NC} (tds=$sensor_tds < tds_on=$TDS_ON)"
      else
        echo -e "  ${CYAN}[AUTO]${NC} P4: ${YELLOW}$old_p4→$cmd_p4${NC} (tds=$sensor_tds > tds_off=$TDS_OFF)"
      fi
    fi
  fi
  # When auto is disabled, cmd_p* stays unchanged (pumps hold their last state)

  # ==========================================================================
  # 4. Apply manual overrides (from MQTT actuator/downlink)
  #    Overrides always work, even when auto mode is disabled
  # ==========================================================================
  ov_p1=$(read_override "pompa1")
  ov_p2=$(read_override "pompa2")
  ov_p3=$(read_override "pompa3")
  ov_p4=$(read_override "pompa4")

  [[ -n "$ov_p1" ]] && { cmd_p1=$ov_p1; }
  [[ -n "$ov_p2" ]] && { cmd_p2=$ov_p2; }
  [[ -n "$ov_p3" ]] && { cmd_p3=$ov_p3; cmd_p4=$ov_p3; }
  [[ -n "$ov_p4" ]] && { cmd_p4=$ov_p4; }

  # ==========================================================================
  # 5. FEEDBACK DELAY: Published state is the PREVIOUS commanded state
  # ==========================================================================

  # ==========================================================================
  # 6. Check water level alarm (same rising-edge logic as ESP32 firmware)
  # ==========================================================================
  if (( $(echo "$sensor_jarak == 999" | awk '{print ($1 == $2)}') )); then
    if [[ "$alarm_was_active" == false ]]; then
      now_ts=$(date +%s)
      if (( now_ts - last_alarm_time >= ALARM_COOLDOWN )); then
        last_alarm_time=$now_ts
        build_alarm "$now_ts" > "/tmp/helioponic_alarm_$$.json"
        if mqtt_publish "$TOPIC_ALARM" "/tmp/helioponic_alarm_$$.json"; then
          echo -e "${RED}[ALARM] Water level critical (jarak_cm=999)${NC}"
        fi
      fi
    fi
    alarm_was_active=true
  else
    alarm_was_active=false
  fi

  # ==========================================================================
  # 7. Publish sensor data every PUBLISH_INTERVAL (1 second = 5 sensor cycles)
  # ==========================================================================
  if (( sensor_cycle % 5 == 0 )); then
    build_payload "$ts" "$sensor_jarak" "$sensor_tds" "$sensor_ph" \
      "$pub_p1" "$pub_p2" "$pub_p3" "$pub_p4" > "/tmp/helioponic_payload_$$.json"

    if mqtt_publish "$TOPIC_SENSOR" "/tmp/helioponic_payload_$$.json"; then
      publish_count=$((publish_count + 1))

      ov_tag=""
      [[ -n "$ov_p1" || -n "$ov_p2" || -n "$ov_p3" || -n "$ov_p4" ]] && ov_tag="${RED}[MANUAL]${NC}"
      auto_tag=""
      [[ "$AUTO_ENABLED" == "false" ]] && auto_tag="${YELLOW}[MANUAL MODE]${NC}"

      echo -e "[${GREEN}OK${NC}] $(date '+%H:%M:%S') jarak=${CYAN}${sensor_jarak}cm${NC} tds=${CYAN}${sensor_tds}ppm${NC} ph=${CYAN}${sensor_ph}${NC} P1=${YELLOW}$pub_p1${NC} P2=${YELLOW}$pub_p2${NC} P3=${YELLOW}$pub_p3${NC} P4=${YELLOW}$pub_p4${NC}${ov_tag}${auto_tag}"

      if [[ $MAX_COUNT -gt 0 && $publish_count -ge $MAX_COUNT ]]; then
        cleanup
      fi
    else
      echo -e "[${RED}FAIL${NC}] $(date '+%H:%M:%S') Publish failed - check MQTT broker"
    fi

    # Also send to REST API as fallback (with auth if available)
    if [[ -n "$AUTH_TOKEN" ]]; then
      curl -s -X POST "$API_BASE/sensors/reading" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        -d @/tmp/helioponic_payload_$$.json \
        -o /dev/null 2>/dev/null || true
    else
      curl -s -X POST "$API_BASE/sensors/reading" \
        -H "Content-Type: application/json" \
        -d @/tmp/helioponic_payload_$$.json \
        -o /dev/null 2>/dev/null || true
    fi
  fi

  # ==========================================================================
  # 8. FEEDBACK DELAY UPDATE: After publish, shift command to published
  # ==========================================================================
  pub_p1=$cmd_p1
  pub_p2=$cmd_p2
  pub_p3=$cmd_p3
  pub_p4=$cmd_p4

  # ==========================================================================
  # 9. Publish status heartbeat every 30 seconds
  # ==========================================================================
  if (( sensor_cycle % 150 == 0 )); then
    hb_ts=$(date +%s)
    build_heartbeat "$hb_ts" "$([[ "$night_mode" == true ]] && echo 1 || echo 0)" > "/tmp/helioponic_heartbeat_$$.json"
    if mqtt_publish "$TOPIC_STATUS" "/tmp/helioponic_heartbeat_$$.json"; then
      heartbeat_count=$((heartbeat_count + 1))
    fi
  fi

  # ==========================================================================
  # 10. Periodically re-fetch thresholds & automation rules (every 30 cycles = ~6 seconds)
  #     to detect changes from AutomationScreen in real-time
  # ==========================================================================
  if (( sensor_cycle % 30 == 0 )); then
    fetch_device_config
    fetch_automation_rules
  fi

  sensor_cycle=$((sensor_cycle + 1))

  # ==========================================================================
  # Sleep for remaining time to maintain 200ms cycle
  # ==========================================================================
  cycle_end=$(date +%s%N)
  elapsed_ns=$(( cycle_end - cycle_start ))
  elapsed_s=$(awk "BEGIN { printf \"%.3f\", $elapsed_ns / 1000000000 }")
  sleep_needed=$(awk "BEGIN { printf \"%.3f\", $SENSOR_INTERVAL - $elapsed_s }")
  if (( $(echo "$sleep_needed > 0" | awk '{print ($1 > 0)}') )); then
    sleep "$sleep_needed"
  fi

done
