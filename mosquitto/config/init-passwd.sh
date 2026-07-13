#!/bin/sh
# Generate MQTT password file with correct permissions inside the container.
# Written to /mosquitto/data/ (writable volume) because /mosquitto/config/ is
# mounted read-only.
#
# Only creates the file if it doesn't exist — on restart, the existing
# password file from the persistent data volume is reused.
set -e
if [ ! -f /mosquitto/data/passwd ]; then
    mosquitto_passwd -b -c /mosquitto/data/passwd helioponic helioponic_mqtt_2024
    chmod 0700 /mosquitto/data/passwd
fi
exec /docker-entrypoint.sh "$@"
