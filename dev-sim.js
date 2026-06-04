
const SCHEMA_FILE = process.argv[2];

if (!SCHEMA_FILE) {
  console.error(" Moraš proslediti šemu kao argument");
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));



const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const mqtt = require("mqtt");
// const validateConfig = require("./validator");

const BROKER_URL = "mqtt://localhost:1883";
const REGISTRATION_URL = "http://localhost:3000/device-certificates/register";

const CONFIG_FILE = "./device-data1.json";
// const SCHEMA_FILE = "./device-model.schema.json";

// const config = validateConfig(CONFIG_FILE, SCHEMA_FILE);
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const {generateTelemetryMessage}=require("./telemetry-generator");
const INTERVAL_MS = config.intervalMs || 5000;

const DEVICE_CERT_DIR = "./certs/device2";

const FACTORY_DEVICE_KEY_PATH = path.join(
  DEVICE_CERT_DIR,
  "factory-device.key"
);

const FACTORY_DEVICE_CERT_PATH = path.join(
  DEVICE_CERT_DIR,
  "factory-device.crt"
);

const OPERATIONAL_DEVICE_KEY_PATH = path.join(
  DEVICE_CERT_DIR,
  "operational-device.key"
);

const OPERATIONAL_DEVICE_CSR_PATH = path.join(
  DEVICE_CERT_DIR,
  "operational-device.csr"
);

const FACTORY_PROOF_PATH = path.join(
  DEVICE_CERT_DIR,
  "factory-proof.sig"
);

const OPERATIONAL_DEVICE_CERT_PATH = path.join(
  DEVICE_CERT_DIR,
  "operational-device.crt"
);

const OPERATIONAL_CA_CERT_PATH = path.join(
  DEVICE_CERT_DIR,
  "operational-ca.crt"
);

let DEVICE_ID = null;

let TELEMETRY_TOPIC = null;
let STATUS_TOPIC = null;
let COMMAND_TOPIC = null;
let RESPONSE_TOPIC = null;

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

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function assertFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[CERT SETUP] Missing ${label}: ${filePath}`);
  }
}

function runOpenSsl(args) {
  execFileSync("openssl", args, {
    stdio: "inherit",
  });
}

function extractCommonNameFromSubject(subject) {
  const match = subject.match(/CN\s*=\s*([^,\n/]+)/);

  return match ? match[1].trim() : null;
}

function getCommonNameFromCertificate(certPath) {
  const subject = execFileSync("openssl", [
    "x509",
    "-in",
    certPath,
    "-noout",
    "-subject",
  ]).toString();

  const commonName = extractCommonNameFromSubject(subject);

  if (!commonName) {
    throw new Error(
      `[CERT SETUP] Cannot extract CN from certificate: ${certPath}`
    );
  }

  return commonName;
}

function getCommonNameFromCsr(csrPath) {
  const subject = execFileSync("openssl", [
    "req",
    "-in",
    csrPath,
    "-noout",
    "-subject",
  ]).toString();

  const commonName = extractCommonNameFromSubject(subject);

  if (!commonName) {
    throw new Error(`[CERT SETUP] Cannot extract CN from CSR: ${csrPath}`);
  }

  return commonName;
}

function setupTopics(deviceId) {
  DEVICE_ID = deviceId;

  TELEMETRY_TOPIC = `iot/devices/${DEVICE_ID}/telemetry`;
  STATUS_TOPIC = `iot/devices/${DEVICE_ID}/status`;
  COMMAND_TOPIC = `iot/devices/${DEVICE_ID}/commands`;
  RESPONSE_TOPIC = `iot/devices/${DEVICE_ID}/response`;

  console.log("[DEVICE] Device identity loaded from CSR:", DEVICE_ID);
  console.log("[MQTT] Telemetry topic:", TELEMETRY_TOPIC);
  console.log("[MQTT] Status topic:", STATUS_TOPIC);
  console.log("[MQTT] Command topic:", COMMAND_TOPIC);
  console.log("[MQTT] Response topic:", RESPONSE_TOPIC);
}

function prepareDeviceRegistrationFiles() {
  console.log("[CERT SETUP] Preparing device registration files...");

  ensureDirectoryExists(DEVICE_CERT_DIR);


  assertFileExists(FACTORY_DEVICE_KEY_PATH, "factory-device.key");
  assertFileExists(FACTORY_DEVICE_CERT_PATH, "factory-device.crt");


  const factoryDeviceId = getCommonNameFromCertificate(
    FACTORY_DEVICE_CERT_PATH
  );

  console.log("[CERT SETUP] Device ID from factory-device.crt:", factoryDeviceId);

  if (!fs.existsSync(OPERATIONAL_DEVICE_KEY_PATH)) {
    console.log("[CERT SETUP] Generating operational-device.key...");

    runOpenSsl([
      "genrsa",
      "-out",
      OPERATIONAL_DEVICE_KEY_PATH,
      "2048",
    ]);
  } else {
    console.log("[CERT SETUP] operational-device.key already exists");
  }

  console.log("[CERT SETUP] Generating operational-device.csr...");

  runOpenSsl([
    "req",
    "-new",
    "-key",
    OPERATIONAL_DEVICE_KEY_PATH,
    "-out",
    OPERATIONAL_DEVICE_CSR_PATH,
    "-subj",
    `/CN=${factoryDeviceId}`,
  ]);

  const csrDeviceId = getCommonNameFromCsr(OPERATIONAL_DEVICE_CSR_PATH);

  console.log("[CERT SETUP] Device ID from operational-device.csr:", csrDeviceId);

  if (factoryDeviceId !== csrDeviceId) {
    throw new Error(
      `[CERT SETUP] CSR CN mismatch. factory=${factoryDeviceId}, csr=${csrDeviceId}`
    );
  }

  setupTopics(csrDeviceId);


  console.log("[CERT SETUP] Generating factory-proof.sig...");

  runOpenSsl([
    "dgst",
    "-sha256",
    "-sign",
    FACTORY_DEVICE_KEY_PATH,
    "-out",
    FACTORY_PROOF_PATH,
    OPERATIONAL_DEVICE_CSR_PATH,
  ]);

  console.log("[CERT SETUP] Device registration files ready");
}

async function registerDevice() {
  console.log("[DEVICE REGISTRATION] Starting registration...");

  prepareDeviceRegistrationFiles();

  const csrPem = fs.readFileSync(OPERATIONAL_DEVICE_CSR_PATH, "utf8");

  const factoryDeviceCertPem = fs.readFileSync(
    FACTORY_DEVICE_CERT_PATH,
    "utf8"
  );

  const factoryProofBase64 = fs
    .readFileSync(FACTORY_PROOF_PATH)
    .toString("base64");

  const response = await fetch(REGISTRATION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
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
    OPERATIONAL_DEVICE_CERT_PATH,
    result.operationalDeviceCertPem
  );

  fs.writeFileSync(
    OPERATIONAL_CA_CERT_PATH,
    result.operationalCaCertPem
  );

  console.log("[DEVICE REGISTRATION] Registration successful");
  console.log("[DEVICE REGISTRATION] Registered device:", result.deviceId);
  console.log("[DEVICE REGISTRATION] Saved operational-device.crt");
  console.log("[DEVICE REGISTRATION] Saved operational-ca.crt");
}

function connectMqtt() {
  if (!DEVICE_ID || !TELEMETRY_TOPIC || !STATUS_TOPIC || !COMMAND_TOPIC) {
    throw new Error("[MQTT] Topics are not initialized. Registration must run first.");
  }

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

  client.on("reconnect", () => {
    console.warn("[MQTT] Reconnecting to broker...");
  });

  client.on("offline", () => {
    console.warn("[MQTT] Client is offline");
  });

  client.on("close", () => {
    console.warn("[MQTT] Connection closed");
  });
}

function sendTelemetry() {
  if (!Array.isArray(config.messages) || config.messages.length === 0) {
    console.error("[TELEMETRY] No messages found in config.messages");
    return;
  }
  const generatedMessage=generateTelemetryMessage();

  const rawMessage = {
    ...config.messages[currentIndex],
  };

  client.publish(TELEMETRY_TOPIC, JSON.stringify(generatedMessage), { qos: 1 });

  console.log("[RAW TELEMETRY SENT]", JSON.stringify(generatedMessage, null, 2));

 // currentIndex = (currentIndex + 1) % config.messages.length;
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