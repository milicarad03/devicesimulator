const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const mqtt = require("mqtt");
const winston = require("winston");

// ==========================================
// WINSTON LOGGER CONFIGURATION
// ==========================================
const logger = winston.createLogger({
 
  level: process.env.LOG_LEVEL || "info",
  transports: [

    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[Sim] - ${timestamp}   ${level}: [DeviceSimulator] ${message}`;
        })
      ),
    }),
    
    new winston.transports.File({
      filename: path.join(__dirname, "error.log"),
      level: "error", 
      options: { flags: "a" },
      handleExceptions: true,
      format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        })
      ),
    }),
  ],
});
function handleEarlyError(message) {
  logger.error(message);
  
  
  const timestamp = new Date().toLocaleString();
  try {
    fs.appendFileSync(
      path.join(__dirname, "error.log"), 
      `[${timestamp}] [ERROR] ${message}\n`, 
      "utf8"
    );
  } catch (e) {}
  
  process.exit(1);
}


global.simulatorLogger = logger;

const DEVICE_ARG = process.argv[2];
const MODEL_ARG = process.argv[3];
const VERSION_ARG = process.argv[4];

if (!DEVICE_ARG || !MODEL_ARG || !VERSION_ARG) {
  handleEarlyError("Usage: node sim.js <device> <model> <version>");
  process.exit(1);
}

let DEVICE_FOLDER = /^\d+$/.test(DEVICE_ARG) ? `device-${DEVICE_ARG}` : DEVICE_ARG;

const SCHEMA_FILE = path.join(__dirname, "schema", MODEL_ARG, `${VERSION_ARG}.schema.json`);

if (!fs.existsSync(SCHEMA_FILE)) {
  handleEarlyError(`[SCHEMA] Missing file path: ${SCHEMA_FILE}`);
  process.exit(1);
}

logger.info(`Using schema profile: ${SCHEMA_FILE}`);

const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
const BROKER_URL = "mqtt://localhost:1883";
const REGISTRATION_URL = "http://localhost:3000/device-certificates/register";
const CONFIG_FILE = "./device-data1.json";

if (!fs.existsSync(CONFIG_FILE)) {
  handleEarlyError(`Configuration file missing: ${CONFIG_FILE}`);
  process.exit(1);
}
let deviceState = { led: false, ledColor:"GREEN", mode: "AUTO" };
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const { createTelemetryGenerator } = require("./telemetry-generator3");
const telemetryGenerator = createTelemetryGenerator(schema, deviceState);
const MAX_LOG_SIZE = 5 * 1024 * 1024;

//const INTERVAL_MS = config.intervalMs || 5000;
const ACTIVE_INTERVAL = config.intervalMs || 5000;
//const IDLE_INTERVAL = config.heartbeatMs || 3600000;
const IDLE_INTERVAL = config.heartbeatMs || 120000;
const DEVICE_CERT_DIR = path.join(__dirname, "certs", DEVICE_FOLDER);
logger.debug(`Using local certificates target directory: ${DEVICE_CERT_DIR}`);
////
//const schemaConfig = schema.properties.schemaId["x-reporting"];

const FACTORY_DEVICE_KEY_PATH = path.join(DEVICE_CERT_DIR, "factory-device.key");
const FACTORY_DEVICE_CERT_PATH = path.join(DEVICE_CERT_DIR, "factory-device.crt");
const OPERATIONAL_DEVICE_KEY_PATH = path.join(DEVICE_CERT_DIR, "operational-device.key");
const OPERATIONAL_DEVICE_CSR_PATH = path.join(DEVICE_CERT_DIR, "operational-device.csr");
const FACTORY_PROOF_PATH = path.join(DEVICE_CERT_DIR, "factory-proof.sig");
const OPERATIONAL_DEVICE_CERT_PATH = path.join(DEVICE_CERT_DIR, "operational-device.crt");
const OPERATIONAL_CA_CERT_PATH = path.join(DEVICE_CERT_DIR, "operational-ca.crt");
const STATS_FILE = path.join(__dirname, "telemetry_stats_delta1.log");
let DEVICE_ID = null;
let TELEMETRY_TOPIC = null;
let STATUS_TOPIC = null;
let COMMAND_TOPIC = null;
let RESPONSE_TOPIC = null;

let client = null;
let telemetryTimer = null;

let logCheckCounter = 0;
const supportsLed =
  !!schema.commands?.SET_LED;

const supportsLedColor =
  !!schema.commands?.SET_LED_COLOR;


//let deviceState = { led: false, mode: "AUTO" };
//let deviceState = { led: false, ledColor:"GREEN", mode: "AUTO" };
let isTelemetryActive = false;

const allowedColors = schema.commands?.SET_LED_COLOR?.payload?.properties?.color?.enum || [];

function nowIso() { return new Date().toISOString(); }

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function assertFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[CERT SETUP] Missing foundational component ${label}: ${filePath}`);
  }
}

function runOpenSsl(args) {
  try {
    execFileSync("openssl", args, { stdio: "pipe" });
  } catch (err) {
    logger.error(`OpenSSL execution failed command args: ${args.join(" ")}`);
    throw err;
  }
}

function extractCommonNameFromSubject(subject) {
  const match = subject.match(/CN\s*=\s*([^,\n/]+)/);
  return match ? match[1].trim() : null;
}


function getCommonNameFromCertificate(certPath) {
  const subject = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-subject"]).toString();
  const commonName = extractCommonNameFromSubject(subject);
  if (!commonName) throw new Error(`Cannot extract CN from certificate file: ${certPath}`);
  return commonName;
}

function getCommonNameFromCsr(csrPath) {
  const subject = execFileSync("openssl", ["req", "-in", csrPath, "-noout", "-subject"]).toString();
  const commonName = extractCommonNameFromSubject(subject);
  if (!commonName) throw new Error(`Cannot extract CN from CSR specification: ${csrPath}`);
  return commonName;
}

function setupTopics(deviceId) {
  DEVICE_ID = deviceId;
  TELEMETRY_TOPIC = `iot/devices/${DEVICE_ID}/telemetry`;
  STATUS_TOPIC = `iot/devices/${DEVICE_ID}/status`;
  COMMAND_TOPIC = `iot/devices/${DEVICE_ID}/commands`;
  RESPONSE_TOPIC = `iot/devices/${DEVICE_ID}/response`;

  logger.info(`Device identity loaded from CSR specification: ${DEVICE_ID}`);
  logger.debug(`[TOPIC CONFIG] Telemetry topic outbound target: ${TELEMETRY_TOPIC}`);
  logger.debug(`[TOPIC CONFIG] Status topic lifecycle events: ${STATUS_TOPIC}`);
  logger.debug(`[TOPIC CONFIG] Command endpoint subscription: ${COMMAND_TOPIC}`);
  logger.debug(`[TOPIC CONFIG] Async Command response link: ${RESPONSE_TOPIC}`);
}

function prepareDeviceRegistrationFiles() {
  logger.debug("Executing stage: Cryptographic Material Validation & Generation.");
  ensureDirectoryExists(DEVICE_CERT_DIR);

  assertFileExists(FACTORY_DEVICE_KEY_PATH, "factory-device.key");
  assertFileExists(FACTORY_DEVICE_CERT_PATH, "factory-device.crt");

  const factoryDeviceId = getCommonNameFromCertificate(FACTORY_DEVICE_CERT_PATH);
  logger.debug(`Extracted Factory Identity common name value: ${factoryDeviceId}`);

  if (!fs.existsSync(OPERATIONAL_DEVICE_KEY_PATH)) {
    logger.info("Operational private key infrastructure missing. Triggering generation...");
    runOpenSsl(["genrsa", "-out", OPERATIONAL_DEVICE_KEY_PATH, "2048"]);
  } else {
    logger.debug("Existing Operational Key material discovered. Skipping key pair generation.");
  }

  logger.debug("Compiling Operational Certificate Signing Request (CSR)...");
  runOpenSsl(["req", "-new", "-key", OPERATIONAL_DEVICE_KEY_PATH, "-out", OPERATIONAL_DEVICE_CSR_PATH, "-subj", `/CN=${factoryDeviceId}`]);

  const csrDeviceId = getCommonNameFromCsr(OPERATIONAL_DEVICE_CSR_PATH);
  if (factoryDeviceId !== csrDeviceId) {
    throw new Error(`Identity Verification Failed: Factory ID [${factoryDeviceId}] distinct from CSR ID [${csrDeviceId}]`);
  }

  setupTopics(csrDeviceId);

  logger.debug("Signing CSR with local hardware identity keys to synthesize validation proof signature...");
  runOpenSsl(["dgst", "-sha256", "-sign", FACTORY_DEVICE_KEY_PATH, "-out", FACTORY_PROOF_PATH, OPERATIONAL_DEVICE_CSR_PATH]);
  logger.info("Cryptographic registration artifacts built and staged successfully.");
}

async function registerDevice() {
  if (process.env.SKIP_CERT === 'true') {
    logger.warn("SKIP_CERT enabled: Preskačem OpenSSL i koristim mock identitet.");
    DEVICE_ID = DEVICE_ARG; 
    setupTopics(DEVICE_ID);
    return; 
  }
 
  logger.info("Initiating registration sequence with core platform PKI interface...");
  prepareDeviceRegistrationFiles();

  const csrPem = fs.readFileSync(OPERATIONAL_DEVICE_CSR_PATH, "utf8");
  const factoryDeviceCertPem = fs.readFileSync(FACTORY_DEVICE_CERT_PATH, "utf8");
  const factoryProofBase64 = fs.readFileSync(FACTORY_PROOF_PATH).toString("base64");

  try {
    const response = await fetch(REGISTRATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem, factoryDeviceCertPem, factoryProofBase64 }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`PKI Edge endpoint rejected signing: Status ${response.status} -> ${responseText}`);
    }

    const result = JSON.parse(responseText);
    fs.writeFileSync(OPERATIONAL_DEVICE_CERT_PATH, result.operationalDeviceCertPem);
    fs.writeFileSync(OPERATIONAL_CA_CERT_PATH, result.operationalCaCertPem);

    logger.info(`Device cryptographic authentication registration validated successfully: ${result.deviceId}`);
  } catch (err) {
    logger.error(`Critical failure during bootstrap registration chain execution: ${err.message}`);
    throw err;
  }
}
const activeTick =
  telemetryGenerator.getOptimalTick("ACTIVE");

const idleTick =
  telemetryGenerator.getOptimalTick("IDLE");

function supportsFeature(feature) {
  return feature in fieldDefinitions;
}
//supportsFeature("status.ledColor");

function connectMqtt() {
  if (!DEVICE_ID) throw new Error("Initialization fault: MQTT startup aborted due to undefined parameters.");

  logger.info(`Connecting to broker instance URL: ${BROKER_URL}`);
  client = mqtt.connect(BROKER_URL);
  

  client.on("connect", () => {
    logger.info("Network transport channel established to target MQTT Broker.");
    telemetryGenerator.setForceFull(true);

    client.subscribe(COMMAND_TOPIC, (err) => {
      if (err) {
        logger.error(`Subscription sequence rejected for command channel ${COMMAND_TOPIC}: ${err.message}`);
        return;
      }
      logger.info(`Inbound Command engine processing topic linked: ${COMMAND_TOPIC}`);
    });
    

    logger.info("Publishing lifecycle status flag [ONLINE] to platform state management...");
    client.publish(STATUS_TOPIC, JSON.stringify({ deviceId: DEVICE_ID, timestamp: nowIso(), status: "online" }), { qos: 1, retain: true });

    //telemetryTimer = setInterval(sendTelemetry, INTERVAL_MS);
    //switchTelemetryInterval(IDLE_INTERVAL);
    switchTelemetryInterval(idleTick);
  });

  client.on("message", (topic, payload) => {
    try {
      const commandObj = JSON.parse(payload.toString());
      console.log("DEBUG - Primljena poruka:", commandObj);
      logger.info(`Inbound transaction processing command request token: ${commandObj.command}`);
      logger.debug(`Raw dynamic command parameters payload: ${payload.toString()}`);
      
      if (commandObj.command === "SET_STATE") {
        const state = commandObj.payload?.state; 
        
        if (state === 'ACTIVE') {
          isTelemetryActive = true;
          switchTelemetryInterval(activeTick);
          logger.info("Telemetry STREAM ENABLED.");
          sendCommandResponse(commandObj.command, true, { status: "ACTIVE" });
        } else if (state === 'IDLE') {
          isTelemetryActive = false;
          switchTelemetryInterval(idleTick);
          logger.info("Telemetry STREAM DISABLED.");
          sendCommandResponse(commandObj.command, true, { status: "IDLE" });
        } else {
          sendCommandResponse(commandObj.command, false, { error: "Invalid state. Use ACTIVE or IDLE." });
        }
        return;
      }

      if (commandObj.command === "SET_LED") {

      if (!supportsLed) { 
        sendCommandResponse( commandObj.command, false, { error: "LED not supported by this device model." });
        return;
      }

        deviceState.led = Boolean(commandObj.payload?.value);
        logger.info(`Execution side effect applied -> Hardware Component state led: ${deviceState.led}`);
        sendCommandResponse(commandObj.command, true, { state: deviceState });
        return;
      }
      if (commandObj.command === "SET_LED_COLOR") {

          if (!supportsLedColor) { 
            sendCommandResponse( commandObj.command, false, { error: "LED color not supported by this device model." });
              return;
          }

          if (!allowedColors.includes(commandObj.payload.color)) {
            sendCommandResponse( commandObj.command, false, { error: "Invalid LED color." });
            return;
          }

        deviceState.ledColor = commandObj.payload.color;

        logger.info(
          `Execution side effect applied -> Hardware Component color led: ${deviceState.ledColor}`
        );

        sendCommandResponse( commandObj.command, true, { state: deviceState });
        return;
      }

      if (commandObj.command === "SET_MODE") {
        deviceState.mode = String(commandObj.payload?.value);
        logger.info(`Execution side effect applied -> Internal operating paradigm mode: ${deviceState.mode}`);
        sendCommandResponse(commandObj.command, true, { state: deviceState });
        return;
      }
      if (commandObj.command === "STOP_DEVICE") {
          logger.error(
            `Simulator terminated by server. Reason: ${commandObj.reason}`
          );

          if (telemetryTimer) {
          clearInterval(telemetryTimer);
        }

        if (client) {
          client.publish(
            STATUS_TOPIC,
            JSON.stringify({
              deviceId: DEVICE_ID,
              timestamp: nowIso(),
              status: "offline"
            }),
            { qos: 1, retain: true },
            () => {
                          
              if (client) {
                client.end(true);
              }

              process.exit(1);
            }
          );
        } else {
          process.exit(1);
        }
        return;
      }

      logger.warn(`Unrecognized action schema. Discarding call command identifier: ${commandObj.command}`);
      sendCommandResponse(commandObj.command, false, { error: "Unknown command profile received." });
    } catch (error) {
      logger.error(`Malformed command envelope transaction context parsed: ${error.message}`);
    }
  });

  client.on("error", (error) => { logger.error(`MQTT engine operational runtime error occurred: ${error.message}`); });
  client.on("reconnect", () => { logger.warn("MQTT transport pipeline severed. Attempting retry reconnection hook..."); });
  client.on("offline", () => { logger.warn("Transport layer shifted status to OFFLINE."); });
}

function trimLogFile() {
  if (!fs.existsSync(STATS_FILE)) return;

  const content = fs.readFileSync(STATS_FILE, "utf8");
  const lines = content.split("\n").filter(Boolean);

 
  if (lines.length > 10) {
    const lastTen = lines.slice(-10); 
    fs.writeFileSync(STATS_FILE, lastTen.join("\n") + "\n", "utf8");
    logger.warn("[LOG ROTATION] Truncated to last 10 lines.");
  }
}
function sendTelemetry() {
//  if(!isTelemetryActive) return;
  try {
   // const generatedMessage = telemetryGenerator.generate();
   let generatedMessage;
    try {
      //generatedMessage = telemetryGenerator.generate();
      generatedMessage = isTelemetryActive ? telemetryGenerator.generate() : telemetryGenerator.generateHeartbeat();
    } catch (genErr) {
      logger.error(`[TELEMETRY] Generator failed to produce data: ${genErr.message}`);
      // Ovde vraćamo iz funkcije da ne bismo pokušali slanje "undefined" poruke
      return; 
    }
    if (!generatedMessage) {
        logger.warn("[TELEMETRY] Generator returned empty object.");
        return;
    }
    logger.info(`RAW TELEMETRY SENT: ${JSON.stringify(generatedMessage, null, 2)}`);
   
    const payloadString = JSON.stringify(generatedMessage);
    if (Buffer.byteLength(payloadString) > 1024 * 64) { 
        logger.warn("Payload prevelik, preskačem slanje...");
        return;
    }
    
    
    const sizeInBytes = Buffer.byteLength(payloadString, 'utf8');
    const logEntry = {
      deviceId: DEVICE_ID,
      type: "DELTA",
      size: sizeInBytes,
      timestamp: nowIso()
    };
   /*
    if (fs.existsSync(STATS_FILE)) {
      const stats = fs.statSync(STATS_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        
        fs.truncateSync(STATS_FILE, 0); 
        logger.warn("Log fajl je dostigao limit, resetovan.");
        
      }
    }
*/
    fs.appendFileSync(STATS_FILE, JSON.stringify(logEntry) + "\n");

    logCheckCounter++;

    if (logCheckCounter % 100 === 0) {
      trimLogFile();
    }

   
    
    logger.info("Dispatching real-time sensor data packet stream frame...");
    logger.debug(`Generated state simulation details: ${JSON.stringify(generatedMessage)}`);

    client.publish(TELEMETRY_TOPIC, JSON.stringify(generatedMessage), { qos: 1 });
  } catch (err) {
    logger.error(`Simulation loop processing crash during generation sequence: ${err.message}`);
  }
}

function sendCommandResponse(command, success, extraData = {}) {
  const response = { deviceId: DEVICE_ID, timestamp: nowIso(), command, success, ...extraData };
  client.publish(RESPONSE_TOPIC, JSON.stringify(response), { qos: 1 });
  logger.debug(`Dispatched verification notification status response back to cloud link: ${JSON.stringify(response)}`);
}

process.on("SIGINT", () => {
  logger.warn("SIGINT interrupt received. Initiating clean termination teardown sequence...");

  if (telemetryTimer) clearInterval(telemetryTimer);

  if (!client) process.exit(0);

  logger.info("Sending offline lifecycle message to platform state controller...");
  client.publish(STATUS_TOPIC, JSON.stringify({ deviceId: DEVICE_ID, timestamp: nowIso(), status: "offline" }), { qos: 1, retain: true }, () => {
    logger.info("Disconnecting MQTT transport interface client link... Goodbye.");
    client.end();
    process.exit(0);
  });
});

function switchTelemetryInterval(intervalMs) {
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
  }

  telemetryTimer = setInterval(
    sendTelemetry,
    intervalMs
  );
}
async function main() {
  isTelemetryActive=false;
  try {
    await registerDevice();
    connectMqtt();
  } catch (error) {
    logger.error(`Fatal application runtime failure: ${error.message}`);
    process.exit(1);
  }
}

main();