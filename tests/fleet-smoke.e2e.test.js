const fs = require('fs');
const os = require('os');
const path = require('path');
const mqtt = require('mqtt');
const {
  FleetManager,
  isPidAlive,
} = require('../scripts/fleet/fleet-manager');

const E2E_ENABLED = process.env.FLEET_E2E_ENABLED === 'true';
const DEVICE_COUNT = Number.parseInt(
  process.env.FLEET_E2E_COUNT ?? '5',
  10,
);

if (
  E2E_ENABLED &&
  (!Number.isInteger(DEVICE_COUNT) || DEVICE_COUNT < 1 || DEVICE_COUNT > 100)
) {
  throw new Error('FLEET_E2E_COUNT must be an integer between 1 and 100.');
}

jest.setTimeout(Math.max(120_000, DEVICE_COUNT * 3_000));

const PROJECT_DIRECTORY = path.resolve(__dirname, '..');
const BROKER_URL =
  process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883';
const RUN_ID = `${process.pid}-${Date.now()}`;
const MANIFEST_PATH = path.join(
  os.tmpdir(),
  `fleet-smoke-${RUN_ID}.json`,
);
const MODEL_SEQUENCE = ['modelA', 'modelB', 'modelC'];

const devices = Array.from({ length: DEVICE_COUNT }, (_, index) => {
  const model = MODEL_SEQUENCE[index % MODEL_SEQUENCE.length];
  const ordinal = String(index + 1).padStart(3, '0');

  return {
    serialNumber: `fleet-e2e-${RUN_ID}-${ordinal}`,
    name: `Fleet E2E ${ordinal}`,
    type: model === 'modelC' ? 'pump' : 'sensor',
    model,
    version: '10.0.0',
  };
});

const deviceIds = new Set(devices.map((device) => device.serialNumber));
const deviceModels = new Map(
  devices.map((device) => [device.serialNumber, device.model]),
);

const topicsFor = (deviceId) => ({
  commands: `iot/devices/${deviceId}/commands`,
  status: `iot/devices/${deviceId}/status`,
  attributes: `iot/devices/${deviceId}/attributes`,
});

const waitForCondition = async (
  condition,
  timeoutMs,
  errorMessage,
) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(errorMessage);
};

const percentile95 = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
};

const describeFleet = E2E_ENABLED ? describe : describe.skip;

describeFleet('Fleet simulator processes (real MQTT e2e)', () => {
  let controller;
  let manager;
  let runDirectory;
  const online = new Set();
  const offline = new Set();
  const activeResponses = new Set();
  const telemetry = new Set();

  const connectController = () =>
    new Promise((resolve, reject) => {
      controller = mqtt.connect(BROKER_URL, {
        clientId: `fleet-e2e-controller-${RUN_ID}`,
        connectTimeout: 5_000,
        reconnectPeriod: 0,
      });

      const timeout = setTimeout(() => {
        controller.end(true);
        reject(
          new Error(
            `MQTT broker is not available at ${BROKER_URL}. Start Mosquitto before running the fleet E2E test.`,
          ),
        );
      }, 6_000);

      controller.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      controller.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

  const subscribe = (topics) =>
    new Promise((resolve, reject) => {
      controller.subscribe(topics, { qos: 1 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

  const publish = (topic, payload, options = { qos: 1 }) =>
    new Promise((resolve, reject) => {
      controller.publish(topic, payload, options, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

  const closeController = () =>
    new Promise((resolve) => {
      if (!controller) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        controller.end(true);
        resolve();
      }, 2_000);

      controller.end(false, {}, () => {
        clearTimeout(timeout);
        resolve();
      });
    });

  const cleanupRetainedMessages = async () => {
    if (!controller?.connected) return;

    await Promise.all(
      devices.flatMap(({ serialNumber }) => {
        const topics = topicsFor(serialNumber);
        return [
          publish(topics.status, '', { qos: 1, retain: true }),
          publish(topics.attributes, '', { qos: 1, retain: true }),
        ];
      }),
    );
  };

  beforeAll(async () => {
    fs.writeFileSync(
      MANIFEST_PATH,
      `${JSON.stringify(
        {
          targetUserEmail: 'fleet-e2e@example.com',
          devices,
        },
        null,
        2,
      )}\n`,
    );

    await connectController();
    await subscribe([
      'iot/devices/+/status',
      'iot/devices/+/response',
      'iot/devices/+/telemetry',
    ]);

    controller.on('message', (topic, payloadBuffer) => {
      const match = /^iot\/devices\/([^/]+)\/(status|response|telemetry)$/.exec(
        topic,
      );
      if (!match || !deviceIds.has(match[1])) return;

      try {
        const payload = JSON.parse(payloadBuffer.toString('utf8'));
        const [deviceId, channel] = [match[1], match[2]];

        if (channel === 'status' && payload.status === 'online') {
          online.add(deviceId);
        }
        if (channel === 'status' && payload.status === 'offline') {
          offline.add(deviceId);
        }
        if (
          channel === 'response' &&
          payload.command === 'SET_STATE' &&
          payload.status === 'ACTIVE' &&
          payload.success === true
        ) {
          activeResponses.add(deviceId);
        }
        if (
          channel === 'telemetry' &&
          payload.schemaId === deviceModels.get(deviceId)
        ) {
          telemetry.add(deviceId);
        }
      } catch {}
    });
  });

  afterAll(async () => {
    await manager?.stop().catch(() => undefined);
    await cleanupRetainedMessages().catch(() => undefined);
    await closeController();

    if (fs.existsSync(MANIFEST_PATH)) fs.unlinkSync(MANIFEST_PATH);
    if (runDirectory && fs.existsSync(runDirectory)) {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  });

  it(`starts ${DEVICE_COUNT} devices, receives telemetry and shuts down cleanly`, async () => {
    manager = new FleetManager({
      projectDirectory: PROJECT_DIRECTORY,
      manifestPath: MANIFEST_PATH,
      brokerUrl: BROKER_URL,
      staggerMs: 10,
      onlineTimeoutMs: Math.max(30_000, DEVICE_COUNT * 1_000),
      shutdownTimeoutMs: 5_000,
      forceTimeoutMs: 2_000,
      skipCertificates: true,
      logLevel: 'warn',
    });

    const fleetStartedAt = Date.now();
    const startSummary = await manager.start();
    const fleetStartupMs = Date.now() - fleetStartedAt;
    runDirectory = manager.run.runDirectory;

    expect(startSummary).toMatchObject({
      planned: DEVICE_COUNT,
      processesAlive: DEVICE_COUNT,
      online: DEVICE_COUNT,
      failed: 0,
    });
    expect(manager.run.onlineWaitTimedOut).toBe(false);
    expect(new Set(manager.run.devices.map((device) => device.pid)).size).toBe(
      DEVICE_COUNT,
    );
    await waitForCondition(
      () => online.size === DEVICE_COUNT,
      5_000,
      `Only ${online.size}/${DEVICE_COUNT} online statuses reached the E2E controller.`,
    );

    await Promise.all(
      devices.map(({ serialNumber }, index) =>
        publish(
          topicsFor(serialNumber).commands,
          JSON.stringify({
            command: 'SET_STATE',
            payload: { state: 'ACTIVE' },
            correlationId: `fleet-e2e-${RUN_ID}-${index + 1}`,
          }),
        ),
      ),
    );

    await waitForCondition(
      () => activeResponses.size === DEVICE_COUNT,
      Math.max(20_000, DEVICE_COUNT * 500),
      `Only ${activeResponses.size}/${DEVICE_COUNT} devices acknowledged SET_STATE/ACTIVE.`,
    );
    await waitForCondition(
      () => telemetry.size === DEVICE_COUNT,
      Math.max(30_000, DEVICE_COUNT * 750),
      `Only ${telemetry.size}/${DEVICE_COUNT} devices published valid telemetry.`,
    );

    const startupSamples = manager.run.devices.map(
      (device) =>
        new Date(device.statusUpdatedAt).getTime() -
        new Date(device.spawnedAt).getTime(),
    );
    const averageStartupMs =
      startupSamples.reduce((sum, value) => sum + value, 0) /
      startupSamples.length;

    const stopSummary = await manager.stop();
    await waitForCondition(
      () => offline.size === DEVICE_COUNT,
      10_000,
      `Only ${offline.size}/${DEVICE_COUNT} devices published an offline status.`,
    );

    expect(stopSummary).toMatchObject({
      planned: DEVICE_COUNT,
      processesAlive: 0,
      stopped: DEVICE_COUNT,
      forcedShutdowns: 0,
    });
    expect(
      manager.run.devices.every(
        (device) => device.pid && !isPidAlive(device.pid),
      ),
    ).toBe(true);

    console.log('\n--- FLEET E2E RESULT ---');
    console.log(`Planned: ${DEVICE_COUNT}`);
    console.log(`Online: ${online.size}`);
    console.log(`Command responses: ${activeResponses.size}`);
    console.log(`Telemetry received: ${telemetry.size}`);
    console.log(`Offline: ${offline.size}`);
    console.log(`Failed: ${startSummary.failed}`);
    console.log(`Fleet startup total: ${fleetStartupMs} ms`);
    console.log(`Device startup average: ${averageStartupMs.toFixed(2)} ms`);
    console.log(`Device startup p95: ${percentile95(startupSamples)} ms`);
    console.log(`Device startup max: ${Math.max(...startupSamples)} ms`);
    console.log(`Clean shutdown: ${stopSummary.stopped}`);
    console.log(`Forced shutdowns: ${stopSummary.forcedShutdowns}`);
  });
});
