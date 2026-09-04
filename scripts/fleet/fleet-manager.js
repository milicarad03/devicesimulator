const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  readManifest,
} = require('../generate-fleet-certificates');
const { FleetStatusTracker } = require('./fleet-status-tracker');

const DEFAULT_STAGGER_MS = 100;
const DEFAULT_ONLINE_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 12_000;
const DEFAULT_FORCE_TIMEOUT_MS = 3_000;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function createRunId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function getRuntimePaths(projectDirectory) {
  const runtimeRoot = path.join(projectDirectory, '.fleet-runs');
  return {
    runtimeRoot,
    currentPointerPath: path.join(runtimeRoot, 'current.json'),
  };
}

function loadCurrentRun(projectDirectory) {
  const { currentPointerPath } = getRuntimePaths(projectDirectory);
  if (!fs.existsSync(currentPointerPath)) return null;

  const pointer = readJson(currentPointerPath);
  if (!pointer?.runFile || !fs.existsSync(pointer.runFile)) {
    return { pointer, run: null };
  }

  return { pointer, run: readJson(pointer.runFile) };
}

function summarizeRun(run, processChecker = isPidAlive) {
  const devices = Array.isArray(run?.devices) ? run.devices : [];
  const aliveDevices = devices.filter((device) =>
    processChecker(device.pid),
  );

  return {
    runId: run?.runId,
    state: run?.state || 'UNKNOWN',
    planned: devices.length,
    processesAlive: aliveDevices.length,
    online: aliveDevices.filter((device) => device.status === 'ONLINE')
      .length,
    offline: devices.filter((device) => device.status === 'OFFLINE').length,
    starting: devices.filter((device) =>
      ['PENDING', 'STARTING'].includes(device.status),
    ).length,
    failed: devices.filter(
      (device) =>
        device.status === 'FAILED' ||
        (run?.state === 'RUNNING' &&
          device.pid &&
          !processChecker(device.pid)),
    ).length,
    stopped: devices.filter((device) => device.status === 'STOPPED').length,
    forcedShutdowns: devices.filter((device) => device.forcedShutdown).length,
    runDirectory: run?.runDirectory,
  };
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      exitCode: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
    });
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', handleExit);
    };
    const handleExit = (exitCode, signal) => {
      cleanup();
      resolve({ exitCode, signal });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`PROCESS_EXIT_TIMEOUT:${child.pid}`));
    }, timeoutMs);

    child.once('exit', handleExit);
  });
}

class FleetManager {
  constructor(options = {}) {
    this.projectDirectory =
      options.projectDirectory ?? path.resolve(__dirname, '../..');
    this.manifestPath =
      options.manifestPath ??
      path.join(this.projectDirectory, 'fleet/devices-100.json');
    this.brokerUrl =
      options.brokerUrl ??
      process.env.MQTT_BROKER_URL ??
      'mqtt://localhost:1883';
    this.staggerMs = options.staggerMs ?? DEFAULT_STAGGER_MS;
    this.onlineTimeoutMs =
      options.onlineTimeoutMs ?? DEFAULT_ONLINE_TIMEOUT_MS;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.forceTimeoutMs =
      options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS;
    this.skipCertificates = options.skipCertificates ?? false;
    this.logLevel = options.logLevel ?? 'warn';
    this.baseEnvironment = options.environment ?? {};
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.trackerFactory =
      options.trackerFactory ??
      ((trackerOptions) => new FleetStatusTracker(trackerOptions));
    this.run = null;
    this.runFile = null;
    this.currentPointerPath = null;
    this.children = new Map();
    this.tracker = null;
    this.stopping = false;
    this.stopPromise = null;
  }

  validateAndLoadManifest() {
    const active = loadCurrentRun(this.projectDirectory);
    if (active?.pointer?.supervisorPid && isPidAlive(active.pointer.supervisorPid)) {
      throw new Error(
        `FLEET_ALREADY_RUNNING:${active.pointer.runId}:${active.pointer.supervisorPid}`,
      );
    }

    if (active) {
      fs.unlinkSync(getRuntimePaths(this.projectDirectory).currentPointerPath);
    }

    const manifest = readManifest(this.manifestPath);
    const missingFiles = [];
    for (const requiredPath of [
      path.join(this.projectDirectory, 'sim.js'),
      path.join(this.projectDirectory, 'device-data1.json'),
    ]) {
      if (!fs.existsSync(requiredPath)) missingFiles.push(requiredPath);
    }

    for (const device of manifest.devices) {
      const schemaPath = path.join(
        this.projectDirectory,
        'schema',
        device.model,
        `${device.version}.schema.json`,
      );
      if (!fs.existsSync(schemaPath)) missingFiles.push(schemaPath);

      if (!this.skipCertificates) {
        const certificateDirectory = path.join(
          this.projectDirectory,
          'certs',
          device.serialNumber,
        );
        for (const fileName of [
          'factory-device.key',
          'factory-device.crt',
        ]) {
          const certificatePath = path.join(certificateDirectory, fileName);
          if (!fs.existsSync(certificatePath)) missingFiles.push(certificatePath);
        }
      }
    }

    if (missingFiles.length > 0) {
      throw new Error(
        `FLEET_PREFLIGHT_FILES_MISSING:\n${missingFiles.join('\n')}`,
      );
    }

    return manifest;
  }

  initializeRun(manifest) {
    const { runtimeRoot, currentPointerPath } = getRuntimePaths(
      this.projectDirectory,
    );
    const runId = createRunId();
    const runDirectory = path.join(runtimeRoot, runId);
    const logDirectory = path.join(runDirectory, 'logs');
    fs.mkdirSync(logDirectory, { recursive: true });

    this.runFile = path.join(runDirectory, 'run.json');
    this.currentPointerPath = currentPointerPath;
    this.run = {
      runId,
      state: 'STARTING',
      supervisorPid: process.pid,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      manifestPath: path.resolve(this.manifestPath),
      runDirectory,
      brokerUrl: this.brokerUrl,
      targetUserEmail: manifest.targetUserEmail,
      devices: manifest.devices.map((device) => ({
        deviceId: device.serialNumber,
        model: device.model,
        version: device.version,
        type: device.type,
        pid: null,
        status: 'PENDING',
        spawnedAt: null,
        statusUpdatedAt: null,
        exitCode: null,
        exitSignal: null,
        forcedShutdown: false,
        logPath: path.join(logDirectory, `${device.serialNumber}.log`),
        telemetryStatsPath: path.join(
          logDirectory,
          `${device.serialNumber}-telemetry.log`,
        ),
        simulatorErrorPath: path.join(
          logDirectory,
          `${device.serialNumber}-error.log`,
        ),
      })),
    };
    this.persistRun();
    writeJsonAtomic(this.currentPointerPath, {
      runId,
      supervisorPid: process.pid,
      runFile: this.runFile,
      runDirectory,
    });
  }

  persistRun() {
    if (this.runFile && this.run) writeJsonAtomic(this.runFile, this.run);
  }

  updateStatus(deviceId, status) {
    const record = this.run?.devices.find(
      (device) => device.deviceId === deviceId,
    );
    if (!record || !record.spawnedAt || this.stopping) return;

    record.status = status;
    record.statusUpdatedAt = new Date().toISOString();
    this.persistRun();
  }

  async spawnDevice(record) {
    const outputFd = fs.openSync(record.logPath, 'a');
    let child;

    try {
      child = this.spawnImpl(
        process.execPath,
        ['sim.js', record.deviceId, record.model, record.version],
        {
          cwd: this.projectDirectory,
          env: {
            ...process.env,
            ...this.baseEnvironment,
            TRANSPORT: 'mqtt',
            MQTT_BROKER_URL: this.brokerUrl,
            SKIP_CERT: this.skipCertificates ? 'true' : 'false',
            LOG_LEVEL: this.logLevel,
            TELEMETRY_STATS_FILE: record.telemetryStatsPath,
            SIMULATOR_ERROR_LOG_FILE: record.simulatorErrorPath,
          },
          stdio: ['ignore', outputFd, outputFd],
        },
      );
    } finally {
      fs.closeSync(outputFd);
    }

    this.children.set(record.deviceId, child);
    record.pid = child.pid ?? null;
    record.status = 'STARTING';
    record.spawnedAt = new Date().toISOString();
    this.persistRun();

    child.once('exit', (exitCode, signal) => {
      record.exitCode = exitCode;
      record.exitSignal = signal;
      record.status = this.stopping ? 'STOPPED' : 'FAILED';
      record.statusUpdatedAt = new Date().toISOString();
      this.persistRun();

      if (!this.stopping) {
        console.error(
          `[fleet] ${record.deviceId} exited unexpectedly ` +
            `(code=${exitCode}, signal=${signal}).`,
        );
      }
    });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (started, error) => {
        if (settled) return;
        settled = true;
        if (!started) {
          record.status = 'FAILED';
          record.spawnError = error?.message || 'UNKNOWN_SPAWN_ERROR';
          this.persistRun();
        }
        resolve(started);
      };

      child.once('spawn', () => finish(true));
      child.once('error', (error) => finish(false, error));
    });
  }

  async waitForInitialStatuses() {
    const deadline = Date.now() + this.onlineTimeoutMs;

    while (Date.now() < deadline) {
      const settled = this.run.devices.filter((device) =>
        ['ONLINE', 'FAILED'].includes(device.status),
      ).length;
      if (settled === this.run.devices.length) return false;
      await this.sleepImpl(250);
    }

    return true;
  }

  async start() {
    const manifest = this.validateAndLoadManifest();
    this.initializeRun(manifest);
    this.tracker = this.trackerFactory({
      brokerUrl: this.brokerUrl,
      deviceIds: manifest.devices.map((device) => device.serialNumber),
      onStatus: (deviceId, status) => this.updateStatus(deviceId, status),
    });

    try {
      await this.tracker.connect();

      for (const record of this.run.devices) {
        if (this.stopping) break;
        await this.spawnDevice(record);
        if (this.staggerMs > 0) await this.sleepImpl(this.staggerMs);
      }

      if (this.stopping) return summarizeRun(this.run);

      this.run.state = 'RUNNING';
      this.run.onlineWaitTimedOut = await this.waitForInitialStatuses();
      this.persistRun();
      return summarizeRun(this.run);
    } catch (error) {
      this.run.state = 'FAILED';
      this.run.startupError = error.message;
      this.persistRun();
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stopChild(record) {
    const child = this.children.get(record.deviceId);
    if (
      !child ||
      !record.pid ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return { deviceId: record.deviceId, forced: false };
    }

    child.kill('SIGINT');
    try {
      await waitForChildExit(child, this.shutdownTimeoutMs);
      return { deviceId: record.deviceId, forced: false };
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        record.forcedShutdown = true;
        child.kill('SIGKILL');
        await waitForChildExit(child, this.forceTimeoutMs);
      }
      return { deviceId: record.deviceId, forced: true };
    }
  }

  async performStop() {
    this.stopping = true;
    if (this.run) {
      this.run.state = 'STOPPING';
      this.persistRun();
    }

    const results = await Promise.allSettled(
      (this.run?.devices || []).map((record) => this.stopChild(record)),
    );
    await this.tracker?.close().catch(() => undefined);

    if (this.run) {
      for (const record of this.run.devices) {
        if (record.status === 'PENDING') record.status = 'STOPPED';
      }
      this.run.state = 'STOPPED';
      this.run.stoppedAt = new Date().toISOString();
      this.persistRun();
    }

    if (this.currentPointerPath && fs.existsSync(this.currentPointerPath)) {
      const pointer = readJson(this.currentPointerPath);
      if (pointer.runId === this.run?.runId) {
        fs.unlinkSync(this.currentPointerPath);
      }
    }

    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'FLEET_SHUTDOWN_FAILED',
      );
    }

    return summarizeRun(this.run);
  }

  stop() {
    if (!this.stopPromise) this.stopPromise = this.performStop();
    return this.stopPromise;
  }
}

async function requestActiveFleetStop(projectDirectory, options = {}) {
  const active = loadCurrentRun(projectDirectory);
  if (!active?.pointer) return { requested: false, reason: 'NO_ACTIVE_FLEET' };

  const supervisorPid = active.pointer.supervisorPid;
  const processChecker = options.processChecker || isPidAlive;
  const killImpl = options.killImpl || process.kill.bind(process);
  const sleepImpl = options.sleepImpl || sleep;

  if (!processChecker(supervisorPid)) {
    return {
      requested: false,
      reason: 'SUPERVISOR_NOT_RUNNING',
      supervisorPid,
    };
  }

  killImpl(supervisorPid, 'SIGINT');
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (!processChecker(supervisorPid)) {
      return { requested: true, stopped: true, supervisorPid };
    }
    await sleepImpl(250);
  }

  throw new Error(`FLEET_SUPERVISOR_STOP_TIMEOUT:${supervisorPid}`);
}

module.exports = {
  FleetManager,
  createRunId,
  getRuntimePaths,
  isPidAlive,
  loadCurrentRun,
  requestActiveFleetStop,
  summarizeRun,
  waitForChildExit,
  writeJsonAtomic,
};
