#!/bin/bash
set -u

LOG_FILE="dummy_traffic_delta_MODELF1.log"
STATS_LOG="telemetry_stats_delta1.log"
READY_FILE="listener.ready"
ERR_DIR="sim_errors"
DEVICE_COUNT=100
TEST_DURATION=30
READY_TIMEOUT=10  

echo "Cleaning up old processes..."
pkill -9 -f "sim.js"
pkill -9 -f "dummy-listener.js"

echo "Removing old log files..."
rm -f "$LOG_FILE" "$STATS_LOG" "$READY_FILE" listener.out.log listener.err.log
rm -rf "$ERR_DIR"
mkdir -p "$ERR_DIR"

echo "Starting dummy listener..."
node dummy-listener.js > listener.out.log 2> listener.err.log &
LISTENER_PID=$!

echo "Waiting for listener to be ready..."
elapsed=0
while [ ! -f "$READY_FILE" ]; do
    sleep 0.5
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge $((READY_TIMEOUT * 2)) ]; then
        echo "ERROR: Listener did not become ready within ${READY_TIMEOUT}s. Check listener.err.log."
        kill -TERM "$LISTENER_PID" 2>/dev/null
        exit 1
    fi
    if ! kill -0 "$LISTENER_PID" 2>/dev/null; then
        echo "ERROR: Listener process crashed immediately after start. Check listener.err.log."
        exit 1
    fi
done
echo "Listener ready."

echo "Starting stress test with $DEVICE_COUNT devices..."
SIM_PIDS=()
for i in $(seq 1 "$DEVICE_COUNT"); do
    SKIP_CERT=true node sim.js "dev-$i" "modelF" "v1" > /dev/null 2> "$ERR_DIR/dev-$i.err.log" &
    SIM_PIDS+=("$!")
done

echo "Test running for ${TEST_DURATION} seconds..."
sleep "$TEST_DURATION"

echo "Stopping all processes..."

for pid in "${SIM_PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null
done
sleep 1

pkill -9 -f "sim.js" 2>/dev/null


kill -TERM "$LISTENER_PID" 2>/dev/null
sleep 1
if kill -0 "$LISTENER_PID" 2>/dev/null; then
   echo "Listener did not respond to TERM, force killing with -9..."
    kill -9 "$LISTENER_PID" 2>/dev/null
fi

FAILED=$(grep -rl . "$ERR_DIR" 2>/dev/null | wc -l)
if [ "$FAILED" -gt 0 ]; then
   echo "WARNING: $FAILED simulator(s) wrote to stderr — check the files in $ERR_DIR/"
fi

echo "Test complete."