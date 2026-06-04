const mqtt = require("mqtt");
const validateConfig = require("./validator");

const BROKER_URL = "mqtt://localhost:1883";
const CONFIG_FILE = "./smart-light.data.json";
const SCHEMA_FILE = "./smart-light.schema.json";

const config = validateConfig(CONFIG_FILE, SCHEMA_FILE);

const DEVICE_ID = config.meta.serial;
const INTERVAL_MS = config.sendInterval || 3000;

const TELEMETRY_TOPIC = `iot/devices/${DEVICE_ID}/telemetry`;
const STATUS_TOPIC = `iot/devices/${DEVICE_ID}/status`;
const COMMAND_TOPIC = `iot/devices/${DEVICE_ID}/commands`;
const RESPONSE_TOPIC = `iot/devices/${DEVICE_ID}/response`;

const client = mqtt.connect(BROKER_URL);

let currentIndex = 0;

let deviceState = {
  power: config.state?.power ?? false,
  brightness: config.state?.brightness ?? 50,
  color: config.state?.color ?? { r: 255, g: 255, b: 255 },
  mode: config.state?.mode ?? "AUTO",
};

function nowIso() {
  return new Date().toISOString();
}

client.on("connect", () => {
  console.log("[SMART LIGHT MQTT] Connected to broker:", BROKER_URL);

  client.subscribe(COMMAND_TOPIC, (err) => {
    if (err) {
      console.error("[SMART LIGHT MQTT] Failed to subscribe:", err);
      return;
    }

    console.log("[SMART LIGHT MQTT] Subscribed to:", COMMAND_TOPIC);
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

    console.log("[SMART LIGHT COMMAND RECEIVED]", command);

    if (command.command === "SET_POWER") {
      deviceState.power = Boolean(command.value);

      sendCommandResponse(command.command, true, {
        state: deviceState,
      });

      return;
    }

    if (command.command === "SET_BRIGHTNESS") {
      const brightness = Number(command.value);

      if (Number.isNaN(brightness) || brightness < 0 || brightness > 100) {
        sendCommandResponse(command.command, false, {
          error: "Brightness must be number between 0 and 100",
        });
        return;
      }

      deviceState.brightness = brightness;

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

    if (command.command === "SET_COLOR") {
      const color = command.value;

      if (
        !color ||
        typeof color.r !== "number" ||
        typeof color.g !== "number" ||
        typeof color.b !== "number"
      ) {
        sendCommandResponse(command.command, false, {
          error: "Color must be { r: number, g: number, b: number }",
        });
        return;
      }

      deviceState.color = {
        r: color.r,
        g: color.g,
        b: color.b,
      };

      sendCommandResponse(command.command, true, {
        state: deviceState,
      });

      return;
    }

    sendCommandResponse(command.command, false, {
      error: "Unknown command",
    });
  } catch (error) {
    console.error("[SMART LIGHT MQTT] Invalid command payload:", error.message);
  }
});

function sendTelemetry() {
  const event = config.events[currentIndex];

  const message = {
    meta: {
      serial: DEVICE_ID,
      deviceType: config.meta.deviceType,
      location: config.meta.location,
    },
    timestamp: nowIso(),
    state: {
      ...event,
      power: deviceState.power,
      brightness: deviceState.brightness,
      color: deviceState.color,
      mode: deviceState.mode,
    },
  };

  client.publish(
    TELEMETRY_TOPIC,
    JSON.stringify(message),
    { qos: 1 }
  );

  console.log("[SMART LIGHT TELEMETRY SENT]", message);

  currentIndex = (currentIndex + 1) % config.events.length;
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

  console.log("[SMART LIGHT RESPONSE SENT]", response);
}

process.on("SIGINT", () => {
  console.log("\n[SMART LIGHT MQTT] Stopping simulator...");

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