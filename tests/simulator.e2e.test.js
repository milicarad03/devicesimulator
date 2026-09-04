
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const mqtt = require("mqtt");

jest.setTimeout(30_000);

const PROJECT_DIR = path.resolve(__dirname, "..");
const BROKER_URL = "mqtt://localhost:1883";
const DEVICE_ID = `simulator-e2e-${process.pid}-${Date.now()}`;
const MODEL = "modelC";
const VERSION = "1.1.3";

const TOPICS = {
  commands: `iot/devices/${DEVICE_ID}/commands`,
  response: `iot/devices/${DEVICE_ID}/response`,
  status: `iot/devices/${DEVICE_ID}/status`,
  telemetry: `iot/devices/${DEVICE_ID}/telemetry`,
  attributes: `iot/devices/${DEVICE_ID}/attributes`,
};

const STATS_FILE = path.join(
  PROJECT_DIR,
  "telemetry_stats_delta1.log",
);

const delay = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

describe("Device simulator MQTT lifecycle (e2e)", () => {
  let mqttClient;
  let simulatorProcess;
  let simulatorOutput = "";
  let originalStatsFile;
  let statsFileExisted = false;
  const receivedMessages = [];

  const connectMqttClient = () =>
    new Promise((resolve, reject) => {
      mqttClient = mqtt.connect(BROKER_URL, {
        clientId: `simulator-e2e-controller-${process.pid}-${Date.now()}`,
        connectTimeout: 3_000,
        reconnectPeriod: 0,
      });

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `MQTT broker is not available at ${BROKER_URL}. Start Mosquitto before running this test.`,
          ),
        );
      }, 5_000);

      const cleanup = () => {
        clearTimeout(timeout);
        mqttClient.off("connect", handleConnect);
        mqttClient.off("error", handleError);
      };

      const handleConnect = () => {
        cleanup();
        resolve();
      };

      const handleError = (error) => {
        cleanup();
        reject(error);
      };

      mqttClient.once("connect", handleConnect);
      mqttClient.once("error", handleError);
    });

  const subscribeToSimulatorTopics = () =>
    new Promise((resolve, reject) => {
      mqttClient.subscribe(
        [TOPICS.status, TOPICS.telemetry, TOPICS.response, TOPICS.attributes],
        { qos: 1 },
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        },
      );
    });

  const publish = (topic, payload, options = { qos: 1 }) =>
    new Promise((resolve, reject) => {
      mqttClient.publish(
        topic,
        payload,
        options,
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        },
      );
    });

  const waitForMessage = (
    topic,
    predicate = () => true,
    timeoutMs = 8_000,
  ) => {
    const existingMessage = receivedMessages.find(
      (message) =>
        message.topic === topic && predicate(message.payload),
    );

    if (existingMessage) {
      return Promise.resolve(existingMessage.payload);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        mqttClient.off("message", handleMessage);
        reject(
          new Error(
            `Timed out waiting for MQTT message on ${topic}. Simulator output:\n${simulatorOutput}`,
          ),
        );
      }, timeoutMs);

      const handleMessage = (receivedTopic, payloadBuffer) => {
        if (receivedTopic !== topic) {
          return;
        }

        let payload;

        try {
          payload = JSON.parse(payloadBuffer.toString());
        } catch {
          return;
        }

        if (!predicate(payload)) {
          return;
        }

        clearTimeout(timeout);
        mqttClient.off("message", handleMessage);
        resolve(payload);
      };

      mqttClient.on("message", handleMessage);
    });
  };

  const waitForProcessExit = (child, timeoutMs = 5_000) => {
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return Promise.resolve(child?.exitCode ?? 0);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.off("exit", handleExit);
        reject(new Error("Simulator did not stop within the timeout."));
      }, timeoutMs);

      const handleExit = (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      };

      child.once("exit", handleExit);
    });
  };

  const stopSimulator = async () => {
    if (!simulatorProcess || simulatorProcess.exitCode !== null) {
      return;
    }

    simulatorProcess.kill("SIGINT");

    try {
      await waitForProcessExit(simulatorProcess, 3_000);
    } catch {
      simulatorProcess.kill("SIGKILL");
      await waitForProcessExit(simulatorProcess, 3_000);
    }
  };

  const closeMqttClient = () =>
    new Promise((resolve) => {
      if (!mqttClient) {
        resolve();
        return;
      }

      if (!mqttClient.connected) {
        mqttClient.end(true);
        resolve();
        return;
      }

      mqttClient.end(false, {}, resolve);
    });

  beforeAll(async () => {
    statsFileExisted = fs.existsSync(STATS_FILE);

    if (statsFileExisted) {
      originalStatsFile = fs.readFileSync(STATS_FILE);
    }

    await connectMqttClient();

    mqttClient.on("error", (error) => {
      simulatorOutput += `\n[MQTT TEST CLIENT ERROR] ${error.message}`;
    });

    mqttClient.on("message", (topic, payloadBuffer) => {
      try {
        receivedMessages.push({
          topic,
          payload: JSON.parse(payloadBuffer.toString()),
        });
      } catch {}
    });

    await subscribeToSimulatorTopics();
  });

  afterAll(async () => {
    await stopSimulator();

    if (mqttClient?.connected) {
      await publish(TOPICS.status, "", {
        qos: 1,
        retain: true,
      });
      await publish(TOPICS.attributes, "", {
        qos: 1,
        retain: true,
      });
    }

    await closeMqttClient();

    if (statsFileExisted) {
      fs.writeFileSync(STATS_FILE, originalStatsFile);
    } else if (fs.existsSync(STATS_FILE)) {
      fs.unlinkSync(STATS_FILE);
    }
  });

  it("starts, streams telemetry in ACTIVE, stops it in IDLE and shuts down cleanly", async () => {
    simulatorProcess = spawn(
      process.execPath,
      ["sim.js", DEVICE_ID, MODEL, VERSION],
      {
        cwd: PROJECT_DIR,
        env: {
          ...process.env,
          SKIP_CERT: "true",
          LOG_LEVEL: "info",
          DEVICE_HEARTBEAT_INTERVAL_MS: "200",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    simulatorProcess.stdout.on("data", (chunk) => {
      simulatorOutput += chunk.toString();
    });

    simulatorProcess.stderr.on("data", (chunk) => {
      simulatorOutput += chunk.toString();
    });

    const onlineStatus = await waitForMessage(
      TOPICS.status,
      (payload) =>
        payload.deviceId === DEVICE_ID &&
        payload.status === "online",
    );

    expect(onlineStatus.deviceId).toBe(DEVICE_ID);
    expect(simulatorProcess.exitCode).toBeNull();

    await delay(450);
    expect(
      receivedMessages.filter(
        ({ topic, payload }) =>
          topic === TOPICS.status &&
          payload.deviceId === DEVICE_ID &&
          payload.status === "online" &&
          payload.heartbeat === true,
      ).length,
    ).toBeGreaterThanOrEqual(2);

    const initialAttributes = await waitForMessage(
      TOPICS.attributes,
      (payload) => payload.serialNumber === DEVICE_ID,
    );

    expect(initialAttributes).toEqual({
      serialNumber: DEVICE_ID,
      firmware: VERSION,
      hardwareModel: MODEL,
    });
    await delay(100);

    const activeResponsePromise = waitForMessage(
      TOPICS.response,
      (payload) =>
        payload.command === "SET_STATE" &&
        payload.correlationId === "active-correlation" &&
        payload.status === "ACTIVE" &&
        payload.success === true,
    );

    await publish(
      TOPICS.commands,
      JSON.stringify({
        command: "SET_STATE",
        payload: { state: "ACTIVE" },
        correlationId: "active-correlation",
      }),
    );

    await expect(activeResponsePromise).resolves.toMatchObject({
      deviceId: DEVICE_ID,
      command: "SET_STATE",
      correlationId: "active-correlation",
      status: "ACTIVE",
      success: true,
    });

    const telemetry = await waitForMessage(
      TOPICS.telemetry,
      (payload) => payload.schemaId === MODEL,
      7_000,
    );

    expect(telemetry).toEqual(
      expect.objectContaining({
        schemaId: MODEL,
      }),
    );
    expect(telemetry).not.toHaveProperty("attributes");

    const duplicateCommand = JSON.stringify({
      command: "SET_PUMP_STATE",
      payload: { enabled: true },
      correlationId: "duplicate-correlation",
    });
    const pumpResponsePromise = waitForMessage(
      TOPICS.response,
      (payload) =>
        payload.command === "SET_PUMP_STATE" &&
        payload.correlationId === "duplicate-correlation",
    );

    await publish(TOPICS.commands, duplicateCommand);
    await expect(pumpResponsePromise).resolves.toMatchObject({
      success: true,
      pumpEnabled: true,
      correlationId: "duplicate-correlation",
    });
    await publish(TOPICS.commands, duplicateCommand);
    await delay(100);

    expect(simulatorOutput).toContain(
      "acknowledged without repeating its side effect",
    );

    const idleResponsePromise = waitForMessage(
      TOPICS.response,
      (payload) =>
        payload.command === "SET_STATE" &&
        payload.correlationId === "idle-correlation" &&
        payload.status === "IDLE" &&
        payload.success === true,
    );

    await publish(
      TOPICS.commands,
      JSON.stringify({
        command: "SET_STATE",
        payload: { state: "IDLE" },
        correlationId: "idle-correlation",
      }),
    );

    await expect(idleResponsePromise).resolves.toMatchObject({
      deviceId: DEVICE_ID,
      command: "SET_STATE",
      correlationId: "idle-correlation",
      status: "IDLE",
      success: true,
    });

    await delay(200);
    const telemetryCountAfterIdle = receivedMessages.filter(
      ({ topic }) => topic === TOPICS.telemetry,
    ).length;

    await delay(5_300);

    expect(
      receivedMessages.filter(
        ({ topic }) => topic === TOPICS.telemetry,
      ),
    ).toHaveLength(telemetryCountAfterIdle);

    const offlineStatusPromise = waitForMessage(
      TOPICS.status,
      (payload) =>
        payload.deviceId === DEVICE_ID &&
        payload.status === "offline",
    );

    simulatorProcess.kill("SIGINT");

    await expect(offlineStatusPromise).resolves.toMatchObject({
      deviceId: DEVICE_ID,
      status: "offline",
    });

    await expect(
      waitForProcessExit(simulatorProcess),
    ).resolves.toBe(0);
  });

  it("publishes the MQTT Last Will when the simulator is killed", async () => {
    receivedMessages.length = 0;
    simulatorOutput = "";
    simulatorProcess = spawn(
      process.execPath,
      ["sim.js", DEVICE_ID, MODEL, VERSION],
      {
        cwd: PROJECT_DIR,
        env: {
          ...process.env,
          SKIP_CERT: "true",
          LOG_LEVEL: "warn",
          DEVICE_HEARTBEAT_INTERVAL_MS: "200",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    simulatorProcess.stdout.on("data", (chunk) => {
      simulatorOutput += chunk.toString();
    });
    simulatorProcess.stderr.on("data", (chunk) => {
      simulatorOutput += chunk.toString();
    });

    await waitForMessage(
      TOPICS.status,
      (payload) =>
        payload.deviceId === DEVICE_ID && payload.status === "online",
    );
    const offlineStatusPromise = waitForMessage(
      TOPICS.status,
      (payload) =>
        payload.deviceId === DEVICE_ID && payload.status === "offline",
    );

    simulatorProcess.kill("SIGKILL");

    await expect(offlineStatusPromise).resolves.toMatchObject({
      deviceId: DEVICE_ID,
      status: "offline",
    });
    await waitForProcessExit(simulatorProcess);
  });
});
