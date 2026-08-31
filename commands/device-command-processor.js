const fs = require('fs');
const path = require('path');
const { ensureDirectoryExists } = require('../registration/device-registration');

const MAX_RESPONSE_CACHE_SIZE = 100;

class DeviceCommandProcessor {
  constructor({
    client,
    config,
    deviceId,
    deviceState,
    logger,
    onRestart,
    onStop,
    runtime,
    telemetryGenerator,
    topics,
  }) {
    this.client = client;
    this.config = config;
    this.deviceId = deviceId;
    this.deviceState = deviceState;
    this.logger = logger;
    this.onRestart = onRestart;
    this.onStop = onStop;
    this.runtime = runtime;
    this.telemetryGenerator = telemetryGenerator;
    this.topics = topics;
    this.activeCorrelationId = null;
    this.commandResponseCache = new Map();
    this.isRestarting = false;
    this.operatingProfileTimer = null;
    this.commandTelemetryPaths = Object.freeze({
      led:
        config.schema.commands?.SET_LED?.['x-state-path'] ||
        'telemetry.led',
      targetPressure:
        config.schema.commands?.SET_TARGET_PRESSURE?.['x-state-path'] ||
        'performance.stages.p2',
      operatingProfile: 'system.status.operatingProfile',
      outputTemperature: 'performance.stages.tempOut',
      vibration: 'diagnostics.health.vibration',
    });
  }

  clearTimers() {
    if (this.operatingProfileTimer) {
      clearTimeout(this.operatingProfileTimer);
      this.operatingProfileTimer = null;
    }
  }

  handleMessage(_topic, payload) {
    try {
      const commandObject = JSON.parse(payload.toString());
      this.activeCorrelationId =
        commandObject.correlationId ||
        commandObject.payload?.correlationId ||
        null;
      const cacheKey = this.activeCorrelationId
        ? `${commandObject.command}:${this.activeCorrelationId}`
        : null;

      if (cacheKey && this.commandResponseCache.has(cacheKey)) {
        this.client.publish(
          this.topics.response,
          JSON.stringify(this.commandResponseCache.get(cacheKey)),
          { qos: 1 },
        );
        this.logger.info(
          `Duplicate command ${this.activeCorrelationId} acknowledged without repeating its side effect.`,
        );
        return;
      }

      console.log('DEBUG - Primljena poruka:', commandObject);
      this.logger.info(
        `Inbound transaction processing command request token: ${commandObject.command}`,
      );

      if (commandObject.command === 'STAGE_MODEL_VERSION') {
        this.stageModelVersion(commandObject);
        return;
      }

      if (commandObject.command === 'RESTART_WITH_MODEL_VERSION') {
        this.restartWithModelVersion(commandObject);
        return;
      }

      if (commandObject.command === 'SET_STATE') {
        this.setTelemetryState(commandObject);
        return;
      }

      if (commandObject.command === 'SET_LED') {
        this.setLed(commandObject);
        return;
      }

      if (commandObject.command === 'SET_PUMP_STATE') {
        this.deviceState.pumpEnabled = Boolean(
          commandObject.payload?.enabled,
        );
        this.logger.info(
          `Pump state changed: ${this.deviceState.pumpEnabled}`,
        );
        this.sendResponse(commandObject.command, true, {
          pumpEnabled: this.deviceState.pumpEnabled,
        });
        return;
      }

      if (commandObject.command === 'SET_FLOW_TARGET') {
        this.setFlowTarget(commandObject);
        return;
      }

      if (commandObject.command === 'SET_LED_COLOR') {
        this.setLedColor(commandObject);
        return;
      }

      if (commandObject.command === 'SET_OPERATING_PROFILE') {
        this.setOperatingProfile(commandObject);
        return;
      }

      if (commandObject.command === 'SET_MODE') {
        this.deviceState.mode = String(commandObject.payload?.value);
        this.logger.info(
          `Execution side effect applied -> Internal operating paradigm mode: ${this.deviceState.mode}`,
        );
        this.sendResponse(commandObject.command, true, {
          state: this.deviceState,
        });
        return;
      }

      if (commandObject.command === 'SET_TARGET_PRESSURE') {
        this.setTargetPressure(commandObject);
        return;
      }

      if (commandObject.command === 'STOP_DEVICE') {
        this.logger.error(
          `Simulator terminated by server. Reason: ${commandObject.reason}`,
        );
        this.onStop(commandObject.reason);
        return;
      }

      this.logger.warn(
        `Unrecognized action schema. Discarding call command identifier: ${commandObject.command}`,
      );
      this.sendResponse(commandObject.command, false, {
        error: 'Unknown command profile received.',
      });
    } catch (error) {
      this.logger.error(
        `Malformed command envelope transaction context parsed: ${error.message}`,
      );
    }
  }

  stageModelVersion(commandObject) {
    const { model, version, schema, mapping, correlationId } =
      commandObject.payload || {};

    this.logger.info(
      `[MODEL UPDATE] Received stage request for ${model}:${version}`,
    );

    if (!model || !version || !schema || !mapping || !correlationId) {
      this.sendResponse(commandObject.command, false, {
        correlationId,
        error: 'INVALID_MODEL_VERSION_PACKAGE',
      });
      return;
    }

    if (schema?.properties?.schemaId?.const !== model) {
      this.sendResponse(commandObject.command, false, {
        correlationId,
        error: 'SCHEMA_MODEL_MISMATCH',
      });
      return;
    }

    try {
      ensureDirectoryExists(this.config.stagedUpdateDirectory);
      fs.writeFileSync(
        this.config.stagedUpdateFile,
        JSON.stringify(
          {
            model,
            version,
            schema,
            mapping,
            stagedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch (error) {
      this.sendResponse(commandObject.command, false, {
        correlationId,
        error: 'MODEL_VERSION_STAGE_PERSIST_FAILED',
      });
      return;
    }

    this.logger.info(
      `[MODEL UPDATE] Successfully staged ${model}:${version}`,
    );
    this.sendResponse(commandObject.command, true, {
      correlationId,
      model,
      version,
      staged: true,
    });
  }

  restartWithModelVersion(commandObject) {
    if (this.isRestarting) {
      this.logger.warn(
        '[MODEL UPDATE] Restart already in progress. Ignoring duplicate restart request.',
      );
      return;
    }

    const { model, version, correlationId } = commandObject.payload || {};

    if (!model || !version || !correlationId) {
      this.sendResponse(commandObject.command, false, {
        correlationId,
        error: 'INVALID_RESTART_REQUEST',
      });
      return;
    }

    if (
      this.config.modelArg === model &&
      this.config.versionArg === version
    ) {
      this.sendResponse(commandObject.command, true, {
        correlationId,
        model,
        version,
        alreadyRunning: true,
      });
      return;
    }

    if (!fs.existsSync(this.config.stagedUpdateFile)) {
      this.sendResponse(commandObject.command, false, {
        correlationId,
        error: 'NO_STAGED_MODEL_VERSION',
      });
      return;
    }

    let stagedPackage;

    try {
      stagedPackage = JSON.parse(
        fs.readFileSync(this.config.stagedUpdateFile, 'utf8'),
      );
    } catch (error) {
      this.sendResponse(commandObject.command, false, {
        correlationId,
        error: 'STAGED_PACKAGE_READ_FAILED',
      });
      return;
    }

    if (
      stagedPackage.model !== model ||
      stagedPackage.version !== version
    ) {
      this.sendResponse(commandObject.command, false, {
        correlationId,
        error: 'STAGED_VERSION_MISMATCH',
      });
      return;
    }

    const targetSchemaDirectory = path.join(
      this.config.baseDirectory,
      'schema',
      model,
    );
    const targetSchemaFile = path.join(
      targetSchemaDirectory,
      `${version}.schema.json`,
    );

    try {
      ensureDirectoryExists(targetSchemaDirectory);
      fs.writeFileSync(
        targetSchemaFile,
        JSON.stringify(stagedPackage.schema, null, 2),
        'utf8',
      );
    } catch (error) {
      this.sendResponse(commandObject.command, false, {
        correlationId,
        error: 'MODEL_VERSION_ACTIVATION_FAILED',
      });
      return;
    }

    this.isRestarting = true;
    this.sendResponse(commandObject.command, true, {
      correlationId,
      model,
      version,
      restartRequired: true,
    });
    this.logger.info(
      `[MODEL UPDATE] Model version ${model}:${version} activated. Simulator will shut down for manual restart.`,
    );

    setTimeout(() => {
      this.logger.info(
        '[MODEL UPDATE] Simulator shutting down for model version change.',
      );
      this.logger.info(
        `[MODEL UPDATE] Start device again with: node sim.js ${this.config.deviceArg} ${model} ${version}`,
      );
      this.onRestart(model, version);
    }, 500);
  }

  setTelemetryState(commandObject) {
    const state = commandObject.payload?.state;

    if (state === 'ACTIVE') {
      this.runtime.activate();
      this.logger.info('Telemetry STREAM ENABLED.');
      this.sendResponse(commandObject.command, true, { status: 'ACTIVE' });
      return;
    }

    if (state === 'IDLE') {
      this.runtime.idle();
      this.logger.info('Telemetry STREAM DISABLED.');
      this.sendResponse(commandObject.command, true, { status: 'IDLE' });
      return;
    }

    this.sendResponse(commandObject.command, false, {
      error: 'Invalid state. Use ACTIVE or IDLE.',
    });
  }

  setLed(commandObject) {
    if (!this.config.schema.commands?.SET_LED) {
      this.sendResponse(commandObject.command, false, {
        error: 'LED not supported by this device model.',
      });
      return;
    }

    this.deviceState.led = Boolean(commandObject.payload?.value);

    try {
      this.telemetryGenerator.setFixedValue(
        this.commandTelemetryPaths.led,
        this.deviceState.led,
      );
    } catch (error) {
      this.sendResponse(commandObject.command, false, {
        error: `LED_TELEMETRY_UPDATE_FAILED: ${error.message}`,
      });
      return;
    }

    this.logger.info(
      `Execution side effect applied -> Hardware Component state led: ${this.deviceState.led}`,
    );
    this.sendResponse(commandObject.command, true, {
      state: this.deviceState,
    });
  }

  setFlowTarget(commandObject) {
    const target = Number(commandObject.payload?.target);

    if (Number.isNaN(target) || target < 0 || target > 500) {
      this.sendResponse(commandObject.command, false, {
        error: 'INVALID_TARGET_FLOW',
      });
      return;
    }

    this.deviceState.targetFlow = target;
    this.logger.info(`Target flow updated: ${target}`);
    this.sendResponse(commandObject.command, true, {
      targetFlow: target,
    });
  }

  setLedColor(commandObject) {
    const commandDefinition = this.config.schema.commands?.SET_LED_COLOR;

    if (!commandDefinition) {
      this.sendResponse(commandObject.command, false, {
        error: 'LED color not supported by this device model.',
      });
      return;
    }

    const allowedColors =
      commandDefinition.payload?.properties?.color?.enum || [];

    if (!allowedColors.includes(commandObject.payload?.color)) {
      this.sendResponse(commandObject.command, false, {
        error: 'Invalid LED color.',
      });
      return;
    }

    this.deviceState.ledColor = commandObject.payload.color;
    this.logger.info(
      `Execution side effect applied -> Hardware Component color led: ${this.deviceState.ledColor}`,
    );
    this.sendResponse(commandObject.command, true, {
      state: this.deviceState,
    });
  }

  setOperatingProfile(commandObject) {
    const payload = commandObject.payload || {};
    const durationMinutes = Number(payload.schedule?.durationMinutes);
    const targetPressure = Number(payload.pressure?.target);
    const maximumTemperature = Number(payload.safety?.maxTemperature);
    const maximumVibration = Number(payload.safety?.maxVibration);
    const allowedModes =
      this.config.schema.commands?.SET_OPERATING_PROFILE?.payload
        ?.properties?.mode?.enum || [];
    const invalid =
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 1 ||
      durationMinutes > 1440 ||
      !Number.isFinite(targetPressure) ||
      targetPressure < 2 ||
      targetPressure > 16 ||
      !Number.isFinite(maximumTemperature) ||
      maximumTemperature < 40 ||
      maximumTemperature > 120 ||
      !Number.isFinite(maximumVibration) ||
      maximumVibration < 0 ||
      maximumVibration > 25 ||
      (allowedModes.length > 0 && !allowedModes.includes(payload.mode));

    if (invalid) {
      this.sendResponse(commandObject.command, false, {
        error: 'INVALID_OPERATING_PROFILE',
      });
      return;
    }

    const profile = {
      mode: payload.mode,
      pressure: { target: targetPressure },
      safety: {
        maxTemperature: maximumTemperature,
        maxVibration: maximumVibration,
      },
      schedule: { durationMinutes },
      activatedAt: new Date().toISOString(),
    };

    try {
      this.applyOperatingProfileTelemetry(profile);
    } catch (error) {
      this.sendResponse(commandObject.command, false, {
        error: `PROFILE_TELEMETRY_UPDATE_FAILED: ${error.message}`,
      });
      return;
    }

    this.deviceState.targetPressure = targetPressure;
    this.deviceState.operatingProfile = profile;
    this.logger.info(
      `Operating profile activated: ${JSON.stringify(profile)}`,
    );
    this.sendResponse(commandObject.command, true, { profile });
    this.clearTimers();

    this.operatingProfileTimer = setTimeout(() => {
      const normalProfile = {
        mode: 'NORMAL',
        pressure: { target: 8 },
        safety: { maxTemperature: 80, maxVibration: 3 },
        schedule: { durationMinutes: 0 },
        activatedAt: new Date().toISOString(),
      };

      this.logger.info(
        `Operating profile expired (${durationMinutes} min). Returning device to NORMAL mode.`,
      );

      try {
        this.applyOperatingProfileTelemetry(normalProfile);
        this.deviceState.targetPressure = 8;
        this.deviceState.operatingProfile = normalProfile;
      } catch (error) {
        this.logger.error(
          `Unable to restore NORMAL profile telemetry: ${error.message}`,
        );
      }

      this.operatingProfileTimer = null;
    }, durationMinutes * 60 * 1000);
  }

  setTargetPressure(commandObject) {
    const value = Number(commandObject.payload?.value);

    if (Number.isNaN(value) || value < 2 || value > 16) {
      this.sendResponse(commandObject.command, false, {
        error: 'INVALID_TARGET_PRESSURE',
      });
      return;
    }

    try {
      this.telemetryGenerator.setFixedValue(
        this.commandTelemetryPaths.targetPressure,
        value,
      );
    } catch (error) {
      this.sendResponse(commandObject.command, false, {
        error: `TARGET_PRESSURE_TELEMETRY_UPDATE_FAILED: ${error.message}`,
      });
      return;
    }

    this.deviceState.targetPressure = value;
    this.logger.info(`Target pressure updated to ${value}`);
    this.sendResponse(commandObject.command, true, { value });
  }

  applyOperatingProfileTelemetry(profile) {
    this.telemetryGenerator.setFixedValue(
      this.commandTelemetryPaths.targetPressure,
      Number(profile?.pressure?.target),
    );
    this.telemetryGenerator.setMaximumValue(
      this.commandTelemetryPaths.outputTemperature,
      Number(profile?.safety?.maxTemperature),
    );
    this.telemetryGenerator.setMaximumValue(
      this.commandTelemetryPaths.vibration,
      Number(profile?.safety?.maxVibration),
    );
    this.telemetryGenerator.setFixedValue(
      this.commandTelemetryPaths.operatingProfile,
      profile.mode,
    );
  }

  sendResponse(command, success, extraData = {}) {
    const correlationId =
      extraData.correlationId || this.activeCorrelationId;
    const response = {
      deviceId: this.deviceId,
      timestamp: new Date().toISOString(),
      command,
      success,
      ...extraData,
      ...(correlationId ? { correlationId } : {}),
    };

    if (correlationId) {
      const cacheKey = `${command}:${correlationId}`;
      this.commandResponseCache.set(cacheKey, response);

      if (this.commandResponseCache.size > MAX_RESPONSE_CACHE_SIZE) {
        const oldestKey = this.commandResponseCache.keys().next().value;
        this.commandResponseCache.delete(oldestKey);
      }
    }

    this.client.publish(
      this.topics.response,
      JSON.stringify(response),
      { qos: 1 },
    );
  }
}

module.exports = { DeviceCommandProcessor };
