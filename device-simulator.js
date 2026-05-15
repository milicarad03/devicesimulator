const fs = require("fs");
const mqtt = require("mqtt");

const BROKER_URL = "mqtt://localhost:1883";
const CONFIG_FILE = "./device-data.json";

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));

const DEVICE_ID = config.deviceId;
const INTERVAL_MS = config.intervalMs || 5000;

const TELEMETRY_TOPIC = `iot/devices/${DEVICE_ID}/telemetry`;
const STATUS_TOPIC = `iot/devices/${DEVICE_ID}/status`;
const COMMAND_TOPIC = `iot/devices/${DEVICE_ID}/commands`;
const RESPONSE_TOPIC = `iot/devices/${DEVICE_ID}/response`;

const client = mqtt.connect(BROKER_URL);

let currentIndex = 0;

let deviceState = {
  led: false,
  mode: "AUTO",
};

function nowIso() {
  return new Date().toISOString();
}

client.on("connect", () => {
  console.log("[MQTT] Connected to broker:", BROKER_URL);

  client.subscribe(COMMAND_TOPIC, (err) => {
    if (err) {
      console.error("[MQTT] Failed to subscribe:", err);
      return;
    }

    console.log("[MQTT] Subscribed to:", COMMAND_TOPIC);
  });

  client.publish(
    STATUS_TOPIC,
    JSON.stringify({
      deviceId: DEVICE_ID,
      timestamp: nowIso(),
      status: "online",
    }),
    { qos: 1, retain: true }
  );

  setInterval(sendTelemetry, INTERVAL_MS);
});

client.on("message", (topic, payload) => {
  try {
    const command = JSON.parse(payload.toString());

    console.log("[COMMAND RECEIVED]", command);

    if (command.command === "SET_LED") {
      deviceState.led = Boolean(command.value);

      sendCommandResponse(command.command, true, {
        state: deviceState,
      });

      return;
    }

    if (command.command === "SET_MODE") {
      deviceState.mode = String(command.value);

      sendCommandResponse(command.command, true, {
        state: deviceState,
      });

      return;
    }

    sendCommandResponse(command.command, false, {
      error: "Unknown command",
    });
  } catch (error) {
    console.error("[MQTT] Invalid command payload:", error.message);
  }
});

function sendTelemetry() {
  const telemetryItem = config.telemetry[currentIndex];

  const message = {
    deviceId: DEVICE_ID,
    timestamp: nowIso(),
    data: {
      ...telemetryItem,
      led: deviceState.led,
      mode: deviceState.mode,
    },
  };

  client.publish(
    TELEMETRY_TOPIC,
    JSON.stringify(message),
    { qos: 1 }
  );

  console.log("[TELEMETRY SENT]", message);

  currentIndex = (currentIndex + 1) % config.telemetry.length;
}

function sendCommandResponse(command, success, extraData = {}) {
  const response = {
    deviceId: DEVICE_ID,
    timestamp: nowIso(),
    command,
    success,
    ...extraData,
  };

  client.publish(
    RESPONSE_TOPIC,
    JSON.stringify(response),
    { qos: 1 }
  );

  console.log("[RESPONSE SENT]", response);
}

process.on("SIGINT", () => {
  console.log("\n[MQTT] Stopping simulator...");

  client.publish(
    STATUS_TOPIC,
    JSON.stringify({
      deviceId: DEVICE_ID,
      timestamp: nowIso(),
      status: "offline",
    }),
    { qos: 1, retain: true },
    () => {
      client.end();
      process.exit(0);
    }
  );
});