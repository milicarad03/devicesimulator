const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  FleetManager,
  getRuntimePaths,
  requestActiveFleetStop,
  summarizeRun,
  writeJsonAtomic,
} = require('../scripts/fleet/fleet-manager');
const { parseArguments } = require('../scripts/fleet/fleet-cli');
const {
  parseStatusMessage,
} = require('../scripts/fleet/fleet-status-tracker');
const {
  activateFleet,
} = require('../scripts/fleet/fleet-backend-client');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    queueMicrotask(() => this.emit('spawn'));
  }

  kill(signal) {
    queueMicrotask(() => {
      this.exitCode = 0;
      this.signalCode = signal;
      this.emit('exit', 0, signal);
    });
    return true;
  }
}

describe('fleet process manager', () => {
  let projectDirectory;

  beforeEach(() => {
    projectDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'fleet-manager-test-'),
    );
  });

  afterEach(() => {
    fs.rmSync(projectDirectory, { recursive: true, force: true });
  });

  function createFleetProject() {
    const devices = [
      {
        serialNumber: 'fleet-a-001',
        name: 'Fleet A001',
        type: 'sensor',
        model: 'modelA',
        version: '10.0.0',
      },
      {
        serialNumber: 'fleet-b-001',
        name: 'Fleet B001',
        type: 'compressor',
        model: 'modelB',
        version: '10.0.0',
      },
    ];
    const manifestPath = path.join(projectDirectory, 'fleet.json');
    fs.writeFileSync(path.join(projectDirectory, 'sim.js'), '');
    fs.writeFileSync(path.join(projectDirectory, 'device-data1.json'), '{}');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        targetUserEmail: 'owner@example.com',
        devices,
      }),
    );

    for (const device of devices) {
      const schemaDirectory = path.join(
        projectDirectory,
        'schema',
        device.model,
      );
      const certificateDirectory = path.join(
        projectDirectory,
        'certs',
        device.serialNumber,
      );
      fs.mkdirSync(schemaDirectory, { recursive: true });
      fs.mkdirSync(certificateDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(schemaDirectory, '10.0.0.schema.json'),
        '{}',
      );
      fs.writeFileSync(
        path.join(certificateDirectory, 'factory-device.key'),
        'key',
      );
      fs.writeFileSync(
        path.join(certificateDirectory, 'factory-device.crt'),
        'certificate',
      );
    }

    return { devices, manifestPath };
  }

  it('starts every manifest device with its model and stops it cleanly', async () => {
    const { manifestPath } = createFleetProject();
    const spawnCalls = [];
    let nextPid = 20_000;
    const tracker = {
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const manager = new FleetManager({
      projectDirectory,
      manifestPath,
      staggerMs: 0,
      onlineTimeoutMs: 0,
      spawnImpl: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        nextPid += 1;
        return new FakeChild(nextPid);
      },
      trackerFactory: () => tracker,
    });

    await manager.start();

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0].args).toEqual([
      'sim.js',
      'fleet-a-001',
      'modelA',
      '10.0.0',
    ]);
    expect(spawnCalls[1].args).toEqual([
      'sim.js',
      'fleet-b-001',
      'modelB',
      '10.0.0',
    ]);
    expect(spawnCalls[0].options.env).toMatchObject({
      TRANSPORT: 'mqtt',
      SKIP_CERT: 'false',
    });
    expect(manager.run.devices.every((device) => device.pid)).toBe(true);

    await manager.stop();

    expect(manager.run.state).toBe('STOPPED');
    expect(
      manager.run.devices.every((device) => device.status === 'STOPPED'),
    ).toBe(true);
    expect(tracker.close).toHaveBeenCalledTimes(1);
    expect(
      fs.existsSync(getRuntimePaths(projectDirectory).currentPointerPath),
    ).toBe(false);
  });

  it('summarizes online, failed and stopped devices', () => {
    const run = {
      runId: 'run-1',
      state: 'RUNNING',
      devices: [
        { pid: 1, status: 'ONLINE', forcedShutdown: false },
        { pid: 2, status: 'STARTING', forcedShutdown: false },
        { pid: 3, status: 'FAILED', forcedShutdown: false },
        { pid: null, status: 'STOPPED', forcedShutdown: true },
      ],
    };

    expect(summarizeRun(run, (pid) => pid === 1 || pid === 2)).toMatchObject({
      planned: 4,
      processesAlive: 2,
      online: 1,
      starting: 1,
      failed: 1,
      stopped: 1,
      forcedShutdowns: 1,
    });
  });

  it('asks only the recorded supervisor to stop', async () => {
    const paths = getRuntimePaths(projectDirectory);
    const runDirectory = path.join(paths.runtimeRoot, 'run-1');
    const runFile = path.join(runDirectory, 'run.json');
    fs.mkdirSync(runDirectory, { recursive: true });
    writeJsonAtomic(runFile, { runId: 'run-1', devices: [] });
    writeJsonAtomic(paths.currentPointerPath, {
      runId: 'run-1',
      supervisorPid: 77,
      runFile,
      runDirectory,
    });
    let alive = true;
    const killImpl = jest.fn(() => {
      alive = false;
    });

    await expect(
      requestActiveFleetStop(projectDirectory, {
        processChecker: () => alive,
        killImpl,
        sleepImpl: jest.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toEqual({
      requested: true,
      stopped: true,
      supervisorPid: 77,
    });
    expect(killImpl).toHaveBeenCalledWith(77, 'SIGINT');
  });
});

describe('fleet CLI and MQTT status parsing', () => {
  it('parses start options', () => {
    expect(
      parseArguments([
        'start',
        '--file',
        'fleet/devices-100.json',
        '--stagger-ms',
        '150',
        '--activate',
        '--dry-run',
      ]),
    ).toMatchObject({
      command: 'start',
      staggerMs: 150,
      activate: true,
      dryRun: true,
      skipCertificates: false,
    });
  });

  it('extracts an online lifecycle status', () => {
    expect(
      parseStatusMessage(
        'iot/devices/fleet-a-001/status',
        Buffer.from('{"status":"online"}'),
      ),
    ).toEqual({
      deviceId: 'fleet-a-001',
      status: 'ONLINE',
    });
  });

  it('activates devices through the backend command endpoint', async () => {
    const fetchImpl = jest.fn(async (url) => ({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        status: 'DISPATCHED',
        correlationId: `correlation-${url.split('/').at(-2)}`,
      }),
    }));

    const results = await activateFleet(
      ['fleet-a-001', 'fleet-b-001'],
      {
        token: 'test-admin-token',
        backendUrl: 'http://localhost:3000',
        fetchImpl,
        concurrency: 1,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://localhost:3000/device/fleet-a-001/command',
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      command: 'SET_STATE',
      payload: { state: 'ACTIVE' },
    });
    expect(results.every((result) => result.success)).toBe(true);
  });
});
