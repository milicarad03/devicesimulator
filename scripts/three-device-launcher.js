const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_DEVICE_SCENARIOS = Object.freeze([
  Object.freeze({
    deviceId: "multi-model-a",
    model: "modelA",
    version: "2.0.5",
  }),
  Object.freeze({
    deviceId: "multi-model-b",
    model: "modelB",
    version: "5.0.2",
  }),
  Object.freeze({
    deviceId: "multi-model-c",
    model: "modelC",
    version: "1.1.4",
  }),
]);

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_000;
const FORCE_KILL_TIMEOUT_MS = 2_000;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
const TEMP_DIRECTORY_PREFIX = "iot-three-devices-";

const isProcessRunning = (child) =>
  Boolean(
    child &&
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null,
  );

const waitForExit = (child, timeoutMs) => {
  if (!isProcessRunning(child)) {
    return Promise.resolve({
      exitCode: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
    });
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
    };

    const handleExit = (exitCode, signal) => {
      cleanup();
      resolve({ exitCode, signal });
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Process ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);

    child.once("exit", handleExit);
  });
};

class ThreeDeviceLauncher {
  constructor(options = {}) {
    this.projectDirectory =
      options.projectDirectory ?? path.resolve(__dirname, "..");
    this.brokerUrl =
      options.brokerUrl ??
      process.env.MQTT_BROKER_URL ??
      "mqtt://localhost:1883";
    this.scenarios = options.scenarios ?? DEFAULT_DEVICE_SCENARIOS;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.forwardOutput = options.forwardOutput ?? false;
    this.baseEnvironment = options.environment ?? {};
    this.records = new Map();
    this.temporaryDirectory = null;
    this.started = false;
    this.stopping = false;
    this.stopPromise = null;
  }

  validateScenarios() {
    if (!Array.isArray(this.scenarios) || this.scenarios.length !== 3) {
      throw new Error("Exactly three simulator scenarios are required.");
    }

    const deviceIds = new Set();
    const modelIds = new Set();

    for (const scenario of this.scenarios) {
      if (!scenario?.deviceId || !scenario?.model || !scenario?.version) {
        throw new Error(
          "Each simulator scenario requires deviceId, model and version.",
        );
      }

      if (deviceIds.has(scenario.deviceId)) {
        throw new Error(`Duplicate device ID: ${scenario.deviceId}`);
      }
      deviceIds.add(scenario.deviceId);

      if (modelIds.has(scenario.model)) {
        throw new Error(`Duplicate model ID: ${scenario.model}`);
      }
      modelIds.add(scenario.model);

      const schemaPath = path.join(
        this.projectDirectory,
        "schema",
        scenario.model,
        `${scenario.version}.schema.json`,
      );

      if (!fs.existsSync(schemaPath)) {
        throw new Error(`Simulator schema does not exist: ${schemaPath}`);
      }
    }
  }

  appendOutput(record, stream, chunk) {
    const text = chunk.toString();
    record.output = `${record.output}${text}`.slice(
      -MAX_CAPTURED_OUTPUT_BYTES,
    );

    if (this.forwardOutput) {
      const target = stream === "stderr" ? process.stderr : process.stdout;
      target.write(`[${record.scenario.deviceId}] ${text}`);
    }
  }

  async start() {
    if (this.started) {
      throw new Error("Three-device launcher has already been started.");
    }

    this.validateScenarios();
    this.started = true;
    this.temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX),
    );

    try {
      for (const scenario of this.scenarios) {
        const statsPath = path.join(
          this.temporaryDirectory,
          `${scenario.deviceId}-telemetry.log`,
        );
        const errorPath = path.join(
          this.temporaryDirectory,
          `${scenario.deviceId}-error.log`,
        );
        const child = spawn(
          process.execPath,
          ["sim.js", scenario.deviceId, scenario.model, scenario.version],
          {
            cwd: this.projectDirectory,
            env: {
              ...process.env,
              ...this.baseEnvironment,
              SKIP_CERT: "true",
              LOG_LEVEL: this.baseEnvironment.LOG_LEVEL ?? "warn",
              MQTT_BROKER_URL: this.brokerUrl,
              TELEMETRY_STATS_FILE: statsPath,
              SIMULATOR_ERROR_LOG_FILE: errorPath,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const record = {
          scenario,
          child,
          statsPath,
          errorPath,
          output: "",
        };

        this.records.set(scenario.deviceId, record);
        child.stdout?.on("data", (chunk) => {
          this.appendOutput(record, "stdout", chunk);
        });
        child.stderr?.on("data", (chunk) => {
          this.appendOutput(record, "stderr", chunk);
        });
        child.once("error", (error) => {
          this.appendOutput(
            record,
            "stderr",
            Buffer.from(`[SPAWN ERROR] ${error.message}\n`),
          );
        });
      }

      return this.getProcessRecords();
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stopChild(record) {
    const { child } = record;

    if (!isProcessRunning(child)) {
      return {
        deviceId: record.scenario.deviceId,
        forced: false,
        exitCode: child.exitCode,
        signal: child.signalCode,
      };
    }

    child.kill("SIGINT");

    try {
      const result = await waitForExit(child, this.shutdownTimeoutMs);
      return {
        deviceId: record.scenario.deviceId,
        forced: false,
        ...result,
      };
    } catch (gracefulError) {
      if (isProcessRunning(child)) {
        child.kill("SIGKILL");
      }

      try {
        const result = await waitForExit(child, FORCE_KILL_TIMEOUT_MS);
        return {
          deviceId: record.scenario.deviceId,
          forced: true,
          ...result,
        };
      } catch (forceError) {
        throw new Error(
          `Unable to stop ${record.scenario.deviceId}. ` +
            `Graceful error: ${gracefulError.message}. ` +
            `Force-kill error: ${forceError.message}.`,
        );
      }
    }
  }

  async performStop() {
    this.stopping = true;
    const results = await Promise.allSettled(
      this.getProcessRecords().map((record) => this.stopChild(record)),
    );
    const failures = results.filter((result) => result.status === "rejected");

    if (this.getRunningProcessCount() === 0) {
      this.removeTemporaryDirectory();
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "One or more simulator processes could not be stopped.",
      );
    }

    return results.map((result) => result.value);
  }

  stop() {
    if (!this.stopPromise) {
      this.stopPromise = this.performStop();
    }

    return this.stopPromise;
  }

  removeTemporaryDirectory() {
    if (!this.temporaryDirectory) {
      return;
    }

    const parentDirectory = path.dirname(this.temporaryDirectory);
    const directoryName = path.basename(this.temporaryDirectory);

    if (
      parentDirectory === os.tmpdir() &&
      directoryName.startsWith(TEMP_DIRECTORY_PREFIX)
    ) {
      fs.rmSync(this.temporaryDirectory, {
        recursive: true,
        force: true,
      });
      this.temporaryDirectory = null;
    }
  }

  getProcessRecords() {
    return Array.from(this.records.values());
  }

  getRunningProcessCount() {
    return this.getProcessRecords().filter(({ child }) =>
      isProcessRunning(child),
    ).length;
  }

  getOutput(deviceId) {
    return this.records.get(deviceId)?.output ?? "";
  }
}

async function runFromCommandLine() {
  const launcher = new ThreeDeviceLauncher({
    forwardOutput: true,
  });
  let shutdownPromise = null;

  const shutdown = (reason, exitCode) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    launcher.stopping = true;
    console.log(`\n[three-device-launcher] Stopping: ${reason}`);
    shutdownPromise = launcher
      .stop()
      .then((results) => {
        for (const result of results) {
          console.log(
            `[three-device-launcher] ${result.deviceId} stopped` +
              `${result.forced ? " after SIGKILL fallback" : " cleanly"}.`,
          );
        }
        process.exitCode = exitCode;
      })
      .catch((error) => {
        console.error(`[three-device-launcher] ${error.message}`);
        process.exitCode = 1;
      });

    return shutdownPromise;
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT received", 0);
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM received", 0);
  });
  process.once("uncaughtException", (error) => {
    console.error(error);
    void shutdown("uncaught exception", 1);
  });
  process.once("unhandledRejection", (reason) => {
    console.error(reason);
    void shutdown("unhandled rejection", 1);
  });

  try {
    const records = await launcher.start();
    console.log(
      `[three-device-launcher] Started ${records.length} simulator processes.`,
    );

    for (const record of records) {
      console.log(
        `[three-device-launcher] pid=${record.child.pid} ` +
          `device=${record.scenario.deviceId} ` +
          `model=${record.scenario.model}:${record.scenario.version}`,
      );

      record.child.once("exit", (exitCode, signal) => {
        if (!launcher.stopping) {
          console.error(
            `[three-device-launcher] ${record.scenario.deviceId} exited unexpectedly ` +
              `(code=${exitCode}, signal=${signal}).`,
          );
          void shutdown("child process exited unexpectedly", 1);
        }
      });
    }

    console.log(
      "[three-device-launcher] Press Ctrl+C to stop all three devices.",
    );
  } catch (error) {
    console.error(`[three-device-launcher] ${error.message}`);
    await shutdown("startup failed", 1);
  }
}

if (require.main === module) {
  void runFromCommandLine();
}

module.exports = {
  DEFAULT_DEVICE_SCENARIOS,
  ThreeDeviceLauncher,
  isProcessRunning,
  waitForExit,
};
