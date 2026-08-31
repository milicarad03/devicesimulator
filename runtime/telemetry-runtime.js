const fs = require('fs');

const MAX_PAYLOAD_BYTES = 64 * 1024;

class TelemetryRuntime {
  constructor({
    client,
    deviceId,
    logger,
    statsFile,
    telemetryGenerator,
    telemetryTopic,
  }) {
    this.client = client;
    this.deviceId = deviceId;
    this.logger = logger;
    this.statsFile = statsFile;
    this.telemetryGenerator = telemetryGenerator;
    this.telemetryTopic = telemetryTopic;
    this.telemetryTimer = null;
    this.historicalBufferTimer = null;
    this.logCheckCounter = 0;
    this.telemetryActive = false;
    this.activeTick = telemetryGenerator.getOptimalTick('ACTIVE');
    this.idleTick = telemetryGenerator.getOptimalTick('IDLE');
    this.historicalBufferInterval =
      telemetryGenerator.getOptimalHistoricalBufferTick();
  }

  startIdleMode() {
    this.telemetryActive = false;
    this.startHistoricalBuffering();
    this.switchTelemetryInterval(this.idleTick);
  }

  activate() {
    this.telemetryActive = true;
    this.stopHistoricalBuffering();
    this.switchTelemetryInterval(this.activeTick);
  }

  idle() {
    this.startIdleMode();
  }

  clearTimers() {
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }

    this.stopHistoricalBuffering();
  }

  startHistoricalBuffering() {
    this.stopHistoricalBuffering();
    this.telemetryGenerator.addHistoricalSample();
    this.historicalBufferTimer = setInterval(() => {
      this.telemetryGenerator.addHistoricalSample();
    }, this.historicalBufferInterval);
  }

  stopHistoricalBuffering() {
    if (this.historicalBufferTimer) {
      clearInterval(this.historicalBufferTimer);
      this.historicalBufferTimer = null;
    }
  }

  switchTelemetryInterval(intervalMs) {
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
    }

    this.telemetryTimer = setInterval(
      () => this.sendTelemetry(),
      intervalMs,
    );
  }

  sendTelemetry() {
    try {
      let generatedMessage;

      try {
        generatedMessage = this.telemetryActive
          ? this.telemetryGenerator.generate()
          : this.telemetryGenerator.generateHeartbeat();
      } catch (error) {
        this.logger.error(
          `[TELEMETRY] Generator failed to produce data: ${error.message}`,
        );
        return;
      }

      if (!generatedMessage) {
        this.logger.warn('[TELEMETRY] Generator returned empty object.');
        return;
      }

      this.logger.info(
        `RAW TELEMETRY SENT: ${JSON.stringify(generatedMessage, null, 2)}`,
      );
      const payload = JSON.stringify(generatedMessage);

      if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
        this.logger.warn('Payload prevelik, preskacem slanje...');
        return;
      }

      fs.appendFileSync(
        this.statsFile,
        `${JSON.stringify({
          deviceId: this.deviceId,
          type: 'DELTA',
          size: Buffer.byteLength(payload, 'utf8'),
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      this.logCheckCounter += 1;

      if (this.logCheckCounter % 100 === 0) {
        this.trimLogFile();
      }

      this.logger.info(
        'Dispatching real-time sensor data packet stream frame...',
      );
      this.logger.debug(
        `Generated state simulation details: ${JSON.stringify(generatedMessage)}`,
      );
      this.client.publish(this.telemetryTopic, payload, { qos: 1 });
    } catch (error) {
      this.logger.error(
        `Simulation loop processing crash during generation sequence: ${error.message}`,
      );
    }
  }

  trimLogFile() {
    if (!fs.existsSync(this.statsFile)) {
      return;
    }

    const lines = fs
      .readFileSync(this.statsFile, 'utf8')
      .split('\n')
      .filter(Boolean);

    if (lines.length > 10) {
      fs.writeFileSync(
        this.statsFile,
        `${lines.slice(-10).join('\n')}\n`,
        'utf8',
      );
      this.logger.warn('[LOG ROTATION] Truncated to last 10 lines.');
    }
  }
}

module.exports = { TelemetryRuntime };
