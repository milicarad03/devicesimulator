const fs = require("fs");
const mqtt = require("mqtt");
const validateConfig = require("./validator");

const BROKER_URL = "mqtt://localhost:1883";
const REGISTRATION_URL = "http://localhost:3000/device-certificates/register";

const CONFIG_FILE = "./device-data.json";
const SCHEMA_FILE = "./device-model.schema.json";

const config = validateConfig(CONFIG_FILE, SCHEMA_FILE);

const DEVICE_ID = config.deviceId;
const INTERVAL_MS = config.intervalMs || 5000;

const TELEMETRY_TOPIC = `iot/devices/${DEVICE_ID}/telemetry`;
const STATUS_TOPIC = `iot/devices/${DEVICE_ID}/status`;
const COMMAND_TOPIC = `iot/devices/${DEVICE_ID}/commands`;
const RESPONSE_TOPIC = `iot/devices/${DEVICE_ID}/response`;

let client = null;
let telemetryTimer = null;
let currentIndex = 0;

let deviceState = {
  led: false,
  mode: "AUTO",
};

function nowIso() {
  return new Date().toISOString();
}

async function registerDevice() {
  console.log("[DEVICE REGISTRATION] Starting registration...");

  const csrPem = fs.readFileSync(
    "./certs/device/operational-device.csr",
    "utf8"
  );

  const factoryDeviceCertPem = fs.readFileSync(
    "./certs/device/factory-device.crt",
    "utf8"
  );

  const factoryProofBase64 = fs
    .readFileSync("./certs/device/factory-proof.sig")
    .toString("base64");

  const response = await fetch(REGISTRATION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      deviceId: DEVICE_ID,
      csrPem,
      factoryDeviceCertPem,
      factoryProofBase64,
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `[DEVICE REGISTRATION] Failed: ${response.status} ${responseText}`
    );
  }

  const result = JSON.parse(responseText);

  fs.writeFileSync(
    "./certs/device/operational-device.crt",
    result.operationalDeviceCertPem
  );

  fs.writeFileSync(
    "./certs/device/operational-ca.crt",
    result.operationalCaCertPem
  );

  console.log("[DEVICE REGISTRATION] Registration successful");
  console.log("[DEVICE REGISTRATION] Saved operational-device.crt");
  console.log("[DEVICE REGISTRATION] Saved operational-ca.crt");
}

function connectMqtt() {
  client = mqtt.connect(BROKER_URL);

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

    telemetryTimer = setInterval(sendTelemetry, INTERVAL_MS);
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

  client.on("error", (error) => {
    console.error("[MQTT] Error:", error.message);
  });
}

function sendTelemetry() {
  const telemetryItem = config.telemetry[currentIndex];

  const message = {
    deviceId: DEVICE_ID,
    ...telemetryItem,
    led: deviceState.led,
    mode: deviceState.mode,
  };

  client.publish(TELEMETRY_TOPIC, JSON.stringify(message), { qos: 1 });

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

  client.publish(RESPONSE_TOPIC, JSON.stringify(response), { qos: 1 });

  console.log("[RESPONSE SENT]", response);
}

process.on("SIGINT", () => {
  console.log("\n[MQTT] Stopping simulator...");

  if (telemetryTimer) {
    clearInterval(telemetryTimer);
  }

  if (!client) {
    process.exit(0);
  }

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

async function main() {
  try {
    await registerDevice();
    connectMqtt();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();