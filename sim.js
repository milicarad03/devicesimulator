const { DeviceCommandProcessor } = require('./commands/device-command-processor');
const {
  createDeviceTopics,
  loadSimulatorConfig,
} = require('./config/simulator-config');
const {
  createSimulatorLogger,
} = require('./logging/simulator-logger');
const {
  registerDevice,
} = require('./registration/device-registration');
const { DevicePresence } = require('./runtime/device-presence');
const { TelemetryRuntime } = require('./runtime/telemetry-runtime');
const { createTelemetryGenerator } = require('./telemetry-generator3');
const { createTransport } = require('./transports/create-transport');

const logger = createSimulatorLogger(process.env, __dirname);
global.simulatorLogger = logger;

let config = null;
let client = null;
let commandProcessor = null;
let presence = null;
let runtime = null;
let deviceId = null;
let topics = null;
let isShuttingDown = false;

function logTopicConfiguration() {
  logger.info(`Device identity loaded from CSR specification: ${deviceId}`);
  logger.debug(
    `[TOPIC CONFIG] Telemetry topic outbound target: ${topics.telemetry}`,
  );
  logger.debug(
    `[TOPIC CONFIG] Status topic lifecycle events: ${topics.status}`,
  );
  logger.debug(
    `[TOPIC CONFIG] Command endpoint subscription: ${topics.commands}`,
  );
  logger.debug(
    `[TOPIC CONFIG] Async Command response link: ${topics.response}`,
  );
}

function attachTransportHandlers(telemetryGenerator) {
  client.on('connect', () => {
    logger.info(
      `Network transport channel established over ${config.transport.toUpperCase()}.`,
    );
    telemetryGenerator.setForceFull(true);

    client.subscribe(topics.commands, (error) => {
      if (error) {
        logger.error(
          `Subscription sequence rejected for command channel ${topics.commands}: ${error.message}`,
        );
        return;
      }

      logger.info(
        `Inbound Command engine processing topic linked: ${topics.commands}`,
      );
    });

    console.log('ACTIVE TICK =', runtime.activeTick);
    console.log('IDLE TICK =', runtime.idleTick);
    logger.info(
      'Publishing lifecycle status flag [ONLINE] to platform state management...',
    );
    presence.start();

    if (config.supportsAttributes) {
      logger.info(
        `Publishing device attributes snapshot: ${JSON.stringify(config.deviceAttributes)}`,
      );
      client.publish(
        topics.attributes,
        JSON.stringify(config.deviceAttributes),
        { qos: 1, retain: true },
      );
    } else {
      logger.debug(
        `Model ${config.modelArg}:${config.versionArg} has no attributes schema. Attribute publication skipped.`,
      );
    }

    runtime.startIdleMode();
  });

  client.on('message', (topic, payload) => {
    commandProcessor.handleMessage(topic, payload);
  });
  client.on('error', (error) => {
    logger.error(
      `${config.transport.toUpperCase()} transport runtime error occurred: ${error.message}`,
    );
  });
  client.on('reconnect', () => {
    logger.warn(
      `${config.transport.toUpperCase()} transport pipeline severed. Attempting retry reconnection hook...`,
    );
  });
  client.on('offline', () => {
    logger.warn('Transport layer shifted status to OFFLINE.');
  });
}

function shutdownSimulator(signalName, exitCode = 0) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.warn(
    `${signalName} received. Initiating clean termination teardown sequence...`,
  );
  runtime?.clearTimers();
  commandProcessor?.clearTimers();
  presence?.stopHeartbeat();

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

    process.exit(exitCode);
  };

  fallbackTimer = setTimeout(() => {
    logger.warn(
      `${config?.transport?.toUpperCase() ?? 'TRANSPORT'} shutdown callback timed out. Closing transport forcefully.`,
    );
    client?.end(true);
    finish();
  }, 2_000);

  if (!client?.connected || !topics || !deviceId) {
    client?.end(true);
    finish();
    return;
  }

  logger.info(
    'Sending offline lifecycle message to platform state controller...',
  );

  try {
    presence.publishOffline(() => {
      logger.info(
        `Disconnecting ${config.transport.toUpperCase()} transport interface client link... Goodbye.`,
      );
      client.end(false, {}, finish);
    });
  } catch (error) {
    logger.error(
      `Shutdown status publication failed: ${error.message}`,
    );
    client.end(true);
    finish();
  }
}

async function main() {
  config = loadSimulatorConfig({
    argv: process.argv,
    env: process.env,
    baseDirectory: __dirname,
    logger,
  });
  deviceId = await registerDevice(config, logger);
  topics = createDeviceTopics(deviceId);
  logTopicConfiguration();

  const deviceState = {
    led: false,
    ledColor: 'GREEN',
    mode: 'AUTO',
    operatingProfile: null,
    targetPressure: 8,
    pumpEnabled: false,
    targetFlow: 100,
  };
  const telemetryGenerator = createTelemetryGenerator(
    config.schema,
    deviceState,
  );

  client = createTransport(config, deviceId, topics, logger);
  presence = new DevicePresence({
    client,
    deviceId,
    heartbeatIntervalMs: config.deviceHeartbeatIntervalMs,
    logger,
    statusTopic: topics.status,
  });
  runtime = new TelemetryRuntime({
    client,
    deviceId,
    logger,
    statsFile: config.telemetryStatsFile,
    telemetryGenerator,
    telemetryTopic: topics.telemetry,
  });
  commandProcessor = new DeviceCommandProcessor({
    client,
    config,
    deviceId,
    deviceState,
    logger,
    runtime,
    telemetryGenerator,
    topics,
    onRestart: () => shutdownSimulator('MODEL_UPDATE', 0),
    onStop: () => shutdownSimulator('STOP_DEVICE', 1),
  });

  attachTransportHandlers(telemetryGenerator);
}

process.on('SIGINT', () => shutdownSimulator('SIGINT'));
process.on('SIGTERM', () => shutdownSimulator('SIGTERM'));

main().catch((error) => {
  logger.error(`Fatal application runtime failure: ${error.message}`);
  process.exit(1);
});
