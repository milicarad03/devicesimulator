const mqtt = require("mqtt");
const path = require("path");
const {
  ThreeDeviceLauncher,
  isProcessRunning,
} = require("../scripts/three-device-launcher");

jest.setTimeout(45_000);

const PROJECT_DIRECTORY = path.resolve(__dirname, "..");
const BROKER_URL =
  process.env.MQTT_BROKER_URL ?? "mqtt://localhost:1883";
const RUN_ID = `${process.pid}-${Date.now()}`;
const SCENARIOS = [
  {
    deviceId: `multi-a-${RUN_ID}`,
    model: "modelA",
    version: "2.0.5",
  },
  {
    deviceId: `multi-b-${RUN_ID}`,
    model: "modelB",
    version: "5.0.2",
  },
  {
    deviceId: `multi-c-${RUN_ID}`,
    model: "modelC",
    version: "1.1.4",
  },
];

const topicsFor = (deviceId) => ({
  commands: `iot/devices/${deviceId}/commands`,
  response: `iot/devices/${deviceId}/response`,
  status: `iot/devices/${deviceId}/status`,
  telemetry: `iot/devices/${deviceId}/telemetry`,
  attributes: `iot/devices/${deviceId}/attributes`,
});

describe("Three device simulator processes (e2e)", () => {
  let controller;
  let launcher;
  const receivedMessages = [];

  const launcherOutput = () =>
    SCENARIOS.map(
      ({ deviceId }) =>
        `\n--- ${deviceId} ---\n${launcher?.getOutput(deviceId) ?? ""}`,
    ).join("");

  const connectController = () =>
    new Promise((resolve, reject) => {
      controller = mqtt.connect(BROKER_URL, {
        clientId: `three-device-e2e-${RUN_ID}`,
        connectTimeout: 3_000,
        reconnectPeriod: 0,
      });

      const cleanup = () => {
        clearTimeout(timeout);
        controller.off("connect", handleConnect);
        controller.off("error", handleError);
      };

      const handleConnect = () => {
        cleanup();
        resolve();
      };

      const handleError = (error) => {
        cleanup();
        controller.end(true);
        reject(error);
      };

      const timeout = setTimeout(() => {
        cleanup();
        controller.end(true);
        reject(
          new Error(
            `MQTT broker is not available at ${BROKER_URL}. Start Mosquitto before running this test.`,
          ),
        );
      }, 5_000);

      controller.once("connect", handleConnect);
      controller.once("error", handleError);
    });

  const subscribe = (topics) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("MQTT subscription timed out."));
      }, 5_000);

      controller.subscribe(topics, { qos: 1 }, (error) => {
        clearTimeout(timeout);

        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

  const publish = (topic, payload, options = { qos: 1 }) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`MQTT publish timed out for ${topic}.`));
      }, 5_000);

      controller.publish(topic, payload, options, (error) => {
        clearTimeout(timeout);

        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

  const waitForMessage = (
    topic,
    predicate = () => true,
    timeoutMs = 10_000,
  ) => {
    const existing = receivedMessages.find(
      (message) =>
        message.topic === topic && predicate(message.payload),
    );

    if (existing) {
      return Promise.resolve(existing.payload);
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        controller.off("message", handleMessage);
      };

      const handleMessage = (receivedTopic, payloadBuffer) => {
        if (receivedTopic !== topic) {
          return;
        }

        try {
          const payload = JSON.parse(payloadBuffer.toString());

          if (!predicate(payload)) {
            return;
          }

          cleanup();
          resolve(payload);
        } catch {}
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for MQTT message on ${topic}.${launcherOutput()}`,
          ),
        );
      }, timeoutMs);

      controller.on("message", handleMessage);
    });
  };

  const closeController = () =>
    new Promise((resolve) => {
      if (!controller) {
        resolve();
        return;
      }

      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timeout);
        controller.removeAllListeners();
        resolve();
      };
      const timeout = setTimeout(() => {
        controller.end(true);
        finish();
      }, 2_000);

      controller.end(false, {}, finish);
    });

  beforeAll(async () => {
    await connectController();

    controller.on("message", (topic, payloadBuffer) => {
      try {
        receivedMessages.push({
          topic,
          payload: JSON.parse(payloadBuffer.toString()),
        });
      } catch {}
    });

    const topics = SCENARIOS.flatMap(({ deviceId }) => {
      const deviceTopics = topicsFor(deviceId);
      return [
        deviceTopics.status,
        deviceTopics.response,
        deviceTopics.telemetry,
      ];
    });

    await subscribe(topics);
  });

  afterAll(async () => {
    let cleanupError;

    try {
      if (launcher) {
        await launcher.stop();
      }
    } catch (error) {
      cleanupError = error;
    }

    if (controller?.connected) {
      try {
        await Promise.all(
          SCENARIOS.flatMap(({ deviceId }) => {
            const topics = topicsFor(deviceId);
            return [
              publish(topics.status, "", {
                qos: 1,
                retain: true,
              }),
              publish(topics.attributes, "", {
                qos: 1,
                retain: true,
              }),
            ];
          }),
        );
      } catch (error) {
        cleanupError ??= error;
      }
    }

    await closeController();

    if (cleanupError) {
      throw cleanupError;
    }
  });

  it("runs three different models and shuts every child process down cleanly", async () => {
    launcher = new ThreeDeviceLauncher({
      projectDirectory: PROJECT_DIRECTORY,
      brokerUrl: BROKER_URL,
      scenarios: SCENARIOS,
      shutdownTimeoutMs: 4_000,
      environment: {
        LOG_LEVEL: "warn",
      },
    });

    const processRecords = await launcher.start();

    expect(processRecords).toHaveLength(3);
    expect(
      new Set(processRecords.map(({ child }) => child.pid)).size,
    ).toBe(3);

    const onlineStatuses = await Promise.all(
      SCENARIOS.map(({ deviceId }) =>
        waitForMessage(
          topicsFor(deviceId).status,
          (payload) =>
            payload.deviceId === deviceId &&
            payload.status === "online",
          8_000,
        ),
      ),
    );

    expect(onlineStatuses).toHaveLength(3);
    expect(launcher.getRunningProcessCount()).toBe(3);

    const activeResponses = SCENARIOS.map(({ deviceId }) =>
      waitForMessage(
        topicsFor(deviceId).response,
        (payload) =>
          payload.deviceId === deviceId &&
          payload.command === "SET_STATE" &&
          payload.status === "ACTIVE" &&
          payload.success === true,
      ),
    );

    await Promise.all(
      SCENARIOS.map(({ deviceId }) =>
        publish(
          topicsFor(deviceId).commands,
          JSON.stringify({
            command: "SET_STATE",
            payload: { state: "ACTIVE" },
          }),
        ),
      ),
    );
    await Promise.all(activeResponses);

    const telemetryMessages = await Promise.all(
      SCENARIOS.map(({ deviceId, model }) =>
        waitForMessage(
          topicsFor(deviceId).telemetry,
          (payload) => payload.schemaId === model,
          12_000,
        ),
      ),
    );

    expect(telemetryMessages.map(({ schemaId }) => schemaId).sort()).toEqual(
      ["modelA", "modelB", "modelC"],
    );

    const offlineStatuses = SCENARIOS.map(({ deviceId }) =>
      waitForMessage(
        topicsFor(deviceId).status,
        (payload) =>
          payload.deviceId === deviceId &&
          payload.status === "offline",
        8_000,
      ),
    );

    const stopResults = await launcher.stop();
    await Promise.all(offlineStatuses);

    expect(stopResults).toHaveLength(3);
    expect(stopResults.every(({ forced }) => forced === false)).toBe(true);
    expect(
      stopResults.every(
        ({ exitCode, signal }) => exitCode === 0 && signal === null,
      ),
    ).toBe(true);
    expect(launcher.getRunningProcessCount()).toBe(0);
    expect(
      processRecords.every(({ child }) => !isProcessRunning(child)),
    ).toBe(true);
  });
});
