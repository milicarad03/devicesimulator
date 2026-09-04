const path = require('path');
const { activateFleet } = require('./fleet-backend-client');
const {
  FleetManager,
  loadCurrentRun,
  requestActiveFleetStop,
  summarizeRun,
} = require('./fleet-manager');

const PROJECT_DIRECTORY = path.resolve(__dirname, '../..');

function parseInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`INVALID_${label}:${value}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const command = argv[0] || 'start';
  if (!['start', 'status', 'stop'].includes(command)) {
    throw new Error(`UNKNOWN_FLEET_COMMAND:${command}`);
  }

  const options = {
    command,
    manifestPath: path.join(
      PROJECT_DIRECTORY,
      'fleet/devices-100.json',
    ),
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    backendUrl: process.env.FLEET_BACKEND_URL || 'http://localhost:3000',
    staggerMs: 100,
    onlineTimeoutMs: 120_000,
    activate: false,
    dryRun: false,
    skipCertificates: false,
    logLevel: 'warn',
  };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`MISSING_VALUE:${argument}`);
      index += 1;
      return value;
    };

    if (argument === '--file') {
      options.manifestPath = path.resolve(process.cwd(), nextValue());
    } else if (argument === '--broker-url') {
      options.brokerUrl = nextValue();
    } else if (argument === '--backend-url') {
      options.backendUrl = nextValue();
    } else if (argument === '--stagger-ms') {
      options.staggerMs = parseInteger(nextValue(), 'STAGGER_MS');
    } else if (argument === '--online-timeout-ms') {
      options.onlineTimeoutMs = parseInteger(
        nextValue(),
        'ONLINE_TIMEOUT_MS',
      );
    } else if (argument === '--log-level') {
      options.logLevel = nextValue();
    } else if (argument === '--activate') {
      options.activate = true;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--skip-cert') {
      options.skipCertificates = true;
    } else {
      throw new Error(`UNKNOWN_FLEET_ARGUMENT:${argument}`);
    }
  }

  return options;
}

function printSummary(title, summary) {
  console.log('');
  console.log(`--- ${title} ---`);
  console.log(`Run: ${summary.runId || 'none'}`);
  console.log(`State: ${summary.state}`);
  console.log(`Planned: ${summary.planned}`);
  console.log(`Processes alive: ${summary.processesAlive}`);
  console.log(`Online: ${summary.online}`);
  console.log(`Offline: ${summary.offline}`);
  console.log(`Starting: ${summary.starting}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Stopped: ${summary.stopped}`);
  console.log(`Forced shutdowns: ${summary.forcedShutdowns}`);
  if (summary.runDirectory) {
    console.log(`Run directory: ${summary.runDirectory}`);
  }
}

async function runStart(options) {
  const manager = new FleetManager({
    projectDirectory: PROJECT_DIRECTORY,
    manifestPath: options.manifestPath,
    brokerUrl: options.brokerUrl,
    staggerMs: options.staggerMs,
    onlineTimeoutMs: options.onlineTimeoutMs,
    skipCertificates: options.skipCertificates,
    logLevel: options.logLevel,
  });

  if (options.dryRun) {
    const manifest = manager.validateAndLoadManifest();
    const modelCounts = new Map();
    for (const device of manifest.devices) {
      const key = `${device.model}:${device.version}`;
      modelCounts.set(key, (modelCounts.get(key) || 0) + 1);
    }

    console.log('--- FLEET PREFLIGHT ---');
    console.log(`Validated devices: ${manifest.devices.length}`);
    for (const [modelVersion, count] of modelCounts) {
      console.log(`${modelVersion}: ${count}`);
    }
    console.log('Missing schemas or certificates: 0');
    return;
  }

  let shutdownPromise = null;

  const shutdown = (reason, exitCode = 0) => {
    if (shutdownPromise) return shutdownPromise;
    console.log(`\n[fleet] Stopping fleet: ${reason}`);
    shutdownPromise = manager
      .stop()
      .then((summary) => {
        printSummary('FLEET STOPPED', summary);
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGTERM');
        process.exitCode = exitCode;
      })
      .catch((error) => {
        console.error(`[fleet] ${error.message}`);
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGTERM');
        process.exitCode = 1;
      });
    return shutdownPromise;
  };

  process.once('SIGINT', () => void shutdown('SIGINT received'));
  process.once('SIGTERM', () => void shutdown('SIGTERM received'));
  process.once('uncaughtException', (error) => {
    console.error(error);
    void shutdown('uncaught exception', 1);
  });
  process.once('unhandledRejection', (reason) => {
    console.error(reason);
    void shutdown('unhandled rejection', 1);
  });

  try {
    const summary = await manager.start();
    if (manager.stopping) return;
    printSummary('FLEET STARTED', summary);

    if (manager.run.onlineWaitTimedOut) {
      console.warn(
        '[fleet] Online wait timed out. Use demo:fleet:status to inspect progress.',
      );
    }

    if (options.activate) {
      const onlineDeviceIds = manager.run.devices
        .filter((device) => device.status === 'ONLINE')
        .map((device) => device.deviceId);

      try {
        console.log(
          `[fleet] Activating ${onlineDeviceIds.length} online devices through backend...`,
        );
        const results = await activateFleet(onlineDeviceIds, {
          backendUrl: options.backendUrl,
        });
        const successful = results.filter((result) => result.success).length;
        const noops = results.filter(
          (result) => result.status === 'NOOP',
        ).length;
        manager.run.activation = {
          requestedAt: new Date().toISOString(),
          attempted: results.length,
          successful,
          noops,
          failed: results.length - successful,
          results,
        };
        manager.persistRun();
        console.log(
          `[fleet] Activation complete: successful=${successful}, ` +
            `noop=${noops}, failed=${results.length - successful}.`,
        );
      } catch (error) {
        manager.run.activation = {
          requestedAt: new Date().toISOString(),
          attempted: 0,
          successful: 0,
          failed: onlineDeviceIds.length,
          error: error.message,
        };
        manager.persistRun();
        console.error(`[fleet] Activation skipped: ${error.message}`);
      }
    }

    console.log('[fleet] Fleet supervisor is running. Press Ctrl+C to stop.');
  } catch (error) {
    console.error(`[fleet] ${error.message}`);
    await shutdown('startup failed', 1);
  }
}

function runStatus() {
  const current = loadCurrentRun(PROJECT_DIRECTORY);
  if (!current?.run) {
    console.log('No active fleet run was found.');
    return;
  }

  printSummary('FLEET STATUS', summarizeRun(current.run));
  if (current.run.activation) {
    const activation = current.run.activation;
    console.log(
      `Activation: attempted=${activation.attempted}, ` +
        `successful=${activation.successful}, failed=${activation.failed}`,
    );
  }
}

async function runStop() {
  const result = await requestActiveFleetStop(PROJECT_DIRECTORY);
  if (!result.requested) {
    console.log(`Fleet stop not sent: ${result.reason}.`);
    return;
  }

  console.log(
    `Fleet supervisor ${result.supervisorPid} stopped successfully.`,
  );
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.command === 'start') await runStart(options);
    else if (options.command === 'status') runStatus();
    else await runStop();
  } catch (error) {
    console.error(`[fleet] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  main,
  parseArguments,
  printSummary,
};
