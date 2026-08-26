const fs = require("fs");
const path = require("path");
const { execFileSync} = require("child_process");
const mqtt = require("mqtt");
const winston = require("winston");

const ERROR_LOG_FILE =
  process.env.SIMULATOR_ERROR_LOG_FILE ||
  path.join(__dirname, "error.log");

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
      filename: ERROR_LOG_FILE,
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
      ERROR_LOG_FILE,
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
const DEVICE_ATTRIBUTES = {
  serialNumber: DEVICE_ARG || "sp-100",
  firmware: VERSION_ARG || "5.0.2",
  hardwareModel: MODEL_ARG || "modelC"
};

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
const supportsAttributes = Boolean(
  schema?.properties?.attributes &&
    typeof schema.properties.attributes === "object" &&
    !Array.isArray(schema.properties.attributes)
);
const BROKER_URL =
  process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";
const REGISTRATION_URL =
  process.env.REGISTRATION_URL ||
  "http://localhost:3000/device-certificates/register";
const CONFIG_FILE = "./device-data1.json";

const STAGED_UPDATE_DIR = path.join(
  __dirname,
  "staged",
  DEVICE_FOLDER
);

const STAGED_UPDATE_FILE = path.join(
  STAGED_UPDATE_DIR,
  "model-update.json"
);

if (!fs.existsSync(CONFIG_FILE)) {
  handleEarlyError(`Configuration file missing: ${CONFIG_FILE}`);
  process.exit(1);
}
let deviceState = {
  led: false,
  ledColor: "GREEN",
  mode: "AUTO",
  operatingProfile: null,
  targetPressure: 8,

  pumpEnabled: false,
  targetFlow: 100
};
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const { createTelemetryGenerator } = require("./telemetry-generator3");

const telemetryGenerator = createTelemetryGenerator(schema, deviceState);
const MAX_LOG_SIZE = 5 * 1024 * 1024;


const ACTIVE_INTERVAL = config.intervalMs || 5000;

const IDLE_INTERVAL = config.heartbeatMs || 120000;
const DEVICE_CERT_DIR = path.join(__dirname, "certs", DEVICE_FOLDER);
logger.debug(`Using local certificates target directory: ${DEVICE_CERT_DIR}`);

const FACTORY_DEVICE_KEY_PATH = path.join(DEVICE_CERT_DIR, "factory-device.key");
const FACTORY_DEVICE_CERT_PATH = path.join(DEVICE_CERT_DIR, "factory-device.crt");
const OPERATIONAL_DEVICE_KEY_PATH = path.join(DEVICE_CERT_DIR, "operational-device.key");
const OPERATIONAL_DEVICE_CSR_PATH = path.join(DEVICE_CERT_DIR, "operational-device.csr");
const FACTORY_PROOF_PATH = path.join(DEVICE_CERT_DIR, "factory-proof.sig");
const OPERATIONAL_DEVICE_CERT_PATH = path.join(DEVICE_CERT_DIR, "operational-device.crt");
const OPERATIONAL_CA_CERT_PATH = path.join(DEVICE_CERT_DIR, "operational-ca.crt");
const STATS_FILE =
  process.env.TELEMETRY_STATS_FILE ||
  path.join(__dirname, "telemetry_stats_delta1.log");
let DEVICE_ID = null;
let TELEMETRY_TOPIC = null;
let STATUS_TOPIC = null;
let COMMAND_TOPIC = null;
let RESPONSE_TOPIC = null;
let ATTRIBUTES_TOPIC = null;

let client = null;
let telemetryTimer = null;
let historicalBufferTimer = null;
let operatingProfileTimer=null;
let stagedModelUpdate = null;
let isRestarting = false;
let isShuttingDown = false;


let logCheckCounter = 0;
const supportsLed = !!schema.commands?.SET_LED;

const supportsLedColor = !!schema.commands?.SET_LED_COLOR;

let isTelemetryActive = false;

const allowedColors = schema.commands?.SET_LED_COLOR?.payload?.properties?.color?.enum || [];
//const historicalBufferInterval = schema.properties?.historicalTelemetry?.["x-buffering"]?.interval ?? 5000;
const historicalBufferInterval = telemetryGenerator.getOptimalHistoricalBufferTick();

function startHistoricalBuffering() {

  if (historicalBufferTimer) {
    clearInterval(historicalBufferTimer);
  }
  telemetryGenerator.addHistoricalSample();

  historicalBufferTimer = setInterval(() => {

    telemetryGenerator.addHistoricalSample();

  }, historicalBufferInterval);
}

function stopHistoricalBuffering() {

  if (historicalBufferTimer) {
    clearInterval(historicalBufferTimer);
    historicalBufferTimer = null;
  }
}
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
  ATTRIBUTES_TOPIC = `iot/devices/${DEVICE_ID}/attributes`;

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
    console.log( "ACTIVE TICK =", activeTick);
    console.log("IDLE TICK =", idleTick);
  
    logger.info("Publishing lifecycle status flag [ONLINE] to platform state management...");
    client.publish(STATUS_TOPIC, JSON.stringify({ deviceId: DEVICE_ID, timestamp: nowIso(), status: "online" }), { qos: 1, retain: true });
    if (supportsAttributes) {
      logger.info(`Publishing device attributes snapshot: ${JSON.stringify(DEVICE_ATTRIBUTES)}`);
      client.publish(
        ATTRIBUTES_TOPIC,
        JSON.stringify(DEVICE_ATTRIBUTES),
        { qos: 1, retain: true }
      );
    } else {
      logger.debug(
        `Model ${MODEL_ARG}:${VERSION_ARG} has no attributes schema. Attribute publication skipped.`
      );
    }

    isTelemetryActive = false;
    startHistoricalBuffering();
    
    switchTelemetryInterval(idleTick);
  });

  client.on("message", (topic, payload) => {
    try {
      const commandObj = JSON.parse(payload.toString());
      console.log("DEBUG - Primljena poruka:", commandObj);
      logger.info(`Inbound transaction processing command request token: ${commandObj.command}`);
      logger.debug(`Raw dynamic command parameters payload: ${payload.toString()}`);
      
      if ( commandObj.command === "STAGE_MODEL_VERSION") {
        const {
          model,
          version,
          schema,
          mapping,
          correlationId,
        } = commandObj.payload || {};

        logger.info(`[MODEL UPDATE] Received stage request for ${model}:${version}` );

        if (!model || !version || !schema || !mapping || !correlationId) {
          logger.error( "[MODEL UPDATE] Missing required stage data." );

          sendCommandResponse(
            commandObj.command,
            false,
            {
              correlationId,
              error:
                "INVALID_MODEL_VERSION_PACKAGE",
            }
          );
          return;
        }

        const schemaId = schema?.properties?.schemaId?.const;

        if (schemaId !== model) {
          logger.error(`[MODEL UPDATE] Schema ID mismatch. model=${model}, schemaId=${schemaId}`);

        sendCommandResponse(
          commandObj.command,
          false,
          {
            correlationId,
            error:
              "SCHEMA_MODEL_MISMATCH",
          }
        );

        return;
      }
      try {
        ensureDirectoryExists(STAGED_UPDATE_DIR);

        const stagedPackage = {
          model,
          version,
          schema,
          mapping,
          stagedAt: nowIso(),
        };

        fs.writeFileSync(
          STAGED_UPDATE_FILE,
          JSON.stringify(
            stagedPackage,
            null,
            2
          ),
          "utf8"
        );

        stagedModelUpdate = stagedPackage;

        logger.info(`[MODEL UPDATE] Staged package persisted to ${STAGED_UPDATE_FILE}`);
      } catch (error) {
        logger.error(`[MODEL UPDATE] Failed to persist staged package: ${error.message}`);

        sendCommandResponse(
          commandObj.command,
          false,
          {
            correlationId,
            error:
              "MODEL_VERSION_STAGE_PERSIST_FAILED",
          }
        );

        return;
      }

      logger.info(`[MODEL UPDATE] Successfully staged ${model}:${version}`);
        sendCommandResponse(
          commandObj.command,
          true,
          {
            correlationId,
            model,
            version,
            staged: true,
          }
        );

        return;
      }
      if (commandObj.command === "RESTART_WITH_MODEL_VERSION") {

        if (isRestarting) {
          logger.warn("[MODEL UPDATE] Restart already in progress. Ignoring duplicate restart request.");
          return;
        }

        const {model, version, correlationId} = commandObj.payload || {};
        if (!model || !version || !correlationId) {
          sendCommandResponse(
            commandObj.command,
            false,
            {
              correlationId,
              error: "INVALID_RESTART_REQUEST",
            }
          );

          return;
        }

        if (MODEL_ARG === model && VERSION_ARG === version) {
          logger.warn( `[MODEL UPDATE] Simulator already running ${model}:${version}. Restart skipped.`);

          sendCommandResponse(
            commandObj.command,
            true,
            {
              correlationId,
              model,
              version,
              alreadyRunning: true,
            }
          );
          return;
        }

        logger.info( `[MODEL UPDATE] Restart requested for ${model}:${version}` );


        if (!fs.existsSync(STAGED_UPDATE_FILE)) {
          logger.error( "[MODEL UPDATE] No staged model package found.");

          sendCommandResponse(
            commandObj.command,
            false,
            {
              correlationId,
              error: "NO_STAGED_MODEL_VERSION",
            }
          );
          return;
        }

        let stagedPackage;

        try {
          stagedPackage = JSON.parse(
            fs.readFileSync(
              STAGED_UPDATE_FILE,
              "utf8"
            )
          );
        } catch (error) {
          logger.error( `[MODEL UPDATE] Failed reading staged package: ${error.message}`);

          sendCommandResponse(
            commandObj.command,
            false,
            {
              correlationId,
              error: "STAGED_PACKAGE_READ_FAILED",
            }
          );

          return;
        }

        if ( stagedPackage.model !== model || stagedPackage.version !== version) {
          logger.error( `[MODEL UPDATE] Restart target does not match staged package. staged=${stagedPackage.model}:${stagedPackage.version}, requested=${model}:${version}`);

          sendCommandResponse(
            commandObj.command,
            false,
            {
              correlationId,
              error: "STAGED_VERSION_MISMATCH",
            }
          );

          return;
        }

        const targetSchemaDir = path.join( __dirname, "schema",  model);

        const targetSchemaFile = path.join( targetSchemaDir, `${version}.schema.json`);

        try {
          ensureDirectoryExists(targetSchemaDir);

          fs.writeFileSync(
            targetSchemaFile,
            JSON.stringify(
              stagedPackage.schema,
              null,
              2
            ),
            "utf8"
          );

          logger.info(`[MODEL UPDATE] Activated schema written to ${targetSchemaFile}` );
        } catch (error) {
          logger.error(`[MODEL UPDATE] Failed activating staged schema: ${error.message}` );

          sendCommandResponse(
            commandObj.command,
            false,
            {
              correlationId,
              error: "MODEL_VERSION_ACTIVATION_FAILED",
            }
          );

          return;
        }
        isRestarting = true;

        sendCommandResponse(
          commandObj.command,
          true,
          {
            correlationId,
            model,
            version,
            restartRequired: true,
          }
        );

        logger.info(`[MODEL UPDATE] Model version ${model}:${version} activated. Simulator will shut down for manual restart.`);

        setTimeout(() => {
          logger.info(`[MODEL UPDATE] Simulator shutting down for model version change.` );

          logger.info(
            `[MODEL UPDATE] Start device again with: node sim.js ${DEVICE_ARG} ${model} ${version}`
          );

          if (telemetryTimer) {
            clearInterval(telemetryTimer);
            telemetryTimer = null;
          }

          if (historicalBufferTimer) {
            clearInterval(historicalBufferTimer);
            historicalBufferTimer = null;
          }

          if (operatingProfileTimer) {
            clearTimeout(operatingProfileTimer);
            operatingProfileTimer = null;
          }

          const shutdown = () => {
            if (client) {
              client.end(true);
            }

            process.exit(0);
          };

          if (client?.connected) {
            client.publish(
              STATUS_TOPIC,
              JSON.stringify({
                deviceId: DEVICE_ID,
                timestamp: nowIso(),
                status: "offline",
              }),
              {
                qos: 1,
                retain: true,
              },
              shutdown
            );
          } else {
            shutdown();
          }
        }, 500);

        return;
      }


      if (commandObj.command === "SET_STATE") {
        const state = commandObj.payload?.state; 
        
        if (state === 'ACTIVE') {
          isTelemetryActive = true;
          stopHistoricalBuffering();
          switchTelemetryInterval(activeTick);
          logger.info("Telemetry STREAM ENABLED.");
          sendCommandResponse(commandObj.command, true, { status: "ACTIVE" });
        } else if (state === 'IDLE') {
          isTelemetryActive = false;
          startHistoricalBuffering();
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
      if (commandObj.command === "SET_PUMP_STATE") {

        deviceState.pumpEnabled =
          Boolean(
            commandObj.payload?.enabled
          );

        logger.info(
          `Pump state changed: ${deviceState.pumpEnabled}`
        );

        sendCommandResponse(
          commandObj.command,
          true,
          {
            pumpEnabled:
              deviceState.pumpEnabled
          }
        );

        return;
      }
      if (commandObj.command === "SET_FLOW_TARGET") {

        const target = Number(
          commandObj.payload?.target
        );

        if (
          Number.isNaN(target) ||
          target < 0 ||
          target > 500
        ) {
          sendCommandResponse(
            commandObj.command,
            false,
            {
              error:
                "INVALID_TARGET_FLOW"
            }
          );

          return;
        }

        deviceState.targetFlow =
          target;

        logger.info(
          `Target flow updated: ${target}`
        );

        sendCommandResponse(
          commandObj.command,
          true,
          {
            targetFlow: target
          }
        );

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
      if (commandObj.command === "SET_OPERATING_PROFILE") {

          const durationMinutes = Number(commandObj.payload.schedule.durationMinutes);
          
          if (isNaN(durationMinutes)) {
              logger.error("Invalid durationMinutes provided.");
              sendCommandResponse(commandObj.command, false, { error: "Invalid duration" });
              return;
          }

          deviceState.operatingProfile = { 
              mode: commandObj.payload.mode, 
              pressure: commandObj.payload.pressure, 
              safety: commandObj.payload.safety, 
              schedule: commandObj.payload.schedule, 
              activatedAt: nowIso()
          };

          logger.info(`Operating profile activated: ${JSON.stringify( deviceState.operatingProfile)}` );

          sendCommandResponse(commandObj.command, true, { profile: deviceState.operatingProfile });
          
          if (operatingProfileTimer) {
            clearTimeout(operatingProfileTimer);
          }

          operatingProfileTimer = setTimeout(() => {
              logger.info(`Operating profile expired (${durationMinutes} min). Returning device to NORMAL mode.`);
              
              deviceState.operatingProfile = {
                  mode: "NORMAL",
                  pressure: { target: 8 },
                  safety: { maxTemperature: 80, maxVibration: 3 },
                  schedule: { durationMinutes: 0 },
                  activatedAt: nowIso()
              };
          }, durationMinutes * 60 * 1000); 

          return;
      }

      if (commandObj.command === "SET_MODE") {
        deviceState.mode = String(commandObj.payload?.value);
        logger.info(`Execution side effect applied -> Internal operating paradigm mode: ${deviceState.mode}`);
        sendCommandResponse(commandObj.command, true, { state: deviceState });
        return;
      }
      if (commandObj.command === "SET_TARGET_PRESSURE") {

      const value = Number(
        commandObj.payload?.value
      );

      if (
        Number.isNaN(value) ||
        value < 2 ||
        value > 16
      ) {
        sendCommandResponse(
          commandObj.command,
          false,
          {
            error:
              "INVALID_TARGET_PRESSURE"
          }
        );

        return;
      }

      if (
        !deviceState.targetPressure
      ) {
        deviceState.targetPressure =
          value;
      } else {
        deviceState.targetPressure =
          value;
      }

      logger.info(
        `Target pressure updated to ${value}`
      );

      sendCommandResponse(
        commandObj.command,
        true,
        {
          value,
        }
      );

      return;
    }
      if (commandObj.command === "STOP_DEVICE") {
          logger.error(
            `Simulator terminated by server. Reason: ${commandObj.reason}`
          );

          if (telemetryTimer) {
            clearInterval(telemetryTimer);
          }
          if (historicalBufferTimer) {
            clearInterval(historicalBufferTimer);
            historicalBufferTimer = null;
          }
          if (operatingProfileTimer) {
            clearTimeout(operatingProfileTimer);
            operatingProfileTimer = null;
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
  try {
   // const generatedMessage = telemetryGenerator.generate();
   let generatedMessage;
    try {
      generatedMessage = isTelemetryActive ? telemetryGenerator.generate() : telemetryGenerator.generateHeartbeat();
    } catch (genErr) {
      logger.error(`[TELEMETRY] Generator failed to produce data: ${genErr.message}`);
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

function clearRuntimeTimers() {
  if (operatingProfileTimer) {
    clearTimeout(operatingProfileTimer);
    operatingProfileTimer = null;
  }

  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }

  if (historicalBufferTimer) {
    clearInterval(historicalBufferTimer);
    historicalBufferTimer = null;
  }
}

function shutdownSimulator(signalName) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.warn(
    `${signalName} received. Initiating clean termination teardown sequence...`
  );
  clearRuntimeTimers();

  let fallbackTimer = null;
  let finished = false;

  const finish = () => {
    if (finished) {
      return;
    }

    finished = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
    }
    process.exit(0);
  };

  fallbackTimer = setTimeout(() => {
    logger.warn(
      "MQTT shutdown callback timed out. Closing transport forcefully."
    );
    client?.end(true);
    finish();
  }, 2_000);

  if (!client?.connected) {
    client?.end(true);
    finish();
    return;
  }

  logger.info("Sending offline lifecycle message to platform state controller...");

  try {
    client.publish(
      STATUS_TOPIC,
      JSON.stringify({
        deviceId: DEVICE_ID,
        timestamp: nowIso(),
        status: "offline",
      }),
      { qos: 1, retain: true },
      () => {
        logger.info(
          "Disconnecting MQTT transport interface client link... Goodbye."
        );
        client.end(false, {}, finish);
      }
    );
  } catch (error) {
    logger.error(`Shutdown status publication failed: ${error.message}`);
    client.end(true);
    finish();
  }
}

process.on("SIGINT", () => {
  shutdownSimulator("SIGINT");
});

process.on("SIGTERM", () => {
  shutdownSimulator("SIGTERM");
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