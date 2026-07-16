#!/bin/bash

echo "Cleaning up old processes..."
pkill -9 -f "sim-test-delta.js"
pkill -9 -f "dummy-listener.js"

echo "Removing old log files..."
rm -f dummy_traffic_delta_MODELF1.log
rm -f telemetry_stats_delta1.log

echo "Starting dummy listener..."
node dummy-listener.js > /dev/null 2>&1 &
LISTENER_PID=$!

echo "Starting stress test with 100 devices..."
for i in {1..100}
do
   SKIP_CERT=true node sim-test-delta.js "dev-$i" "modelF" "v1" > /dev/null 2>&1 &
done

echo "Test running for 30 seconds..."
sleep 30

echo "Stopping all processes..."
pkill -9 -f "sim-test-delta.js"
kill -9 $LISTENER_PID 2>/dev/null

echo "Test complete."