const STATUS_PUBLISH_OPTIONS = { qos: 1, retain: true };

class DevicePresence {
  constructor({
    client,
    deviceId,
    heartbeatIntervalMs,
    logger,
    now = () => new Date(),
    statusTopic,
  }) {
    this.client = client;
    this.deviceId = deviceId;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.logger = logger;
    this.now = now;
    this.statusTopic = statusTopic;
    this.heartbeatTimer = null;
  }

  createPayload(status, heartbeat = false) {
    const payload = {
      deviceId: this.deviceId,
      timestamp: this.now().toISOString(),
      status,
    };

    if (heartbeat) payload.heartbeat = true;
    return JSON.stringify(payload);
  }

  publish(status, callback, heartbeat = false) {
    this.client.publish(
      this.statusTopic,
      this.createPayload(status, heartbeat),
      STATUS_PUBLISH_OPTIONS,
      callback,
    );
  }

  start() {
    this.stopHeartbeat();
    this.publish('online');

    if (this.heartbeatIntervalMs === 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (!this.client.connected) return;

      this.publish('online', (error) => {
        if (error) {
          this.logger.warn(
            `Device presence heartbeat failed: ${error.message}`,
          );
        }
      }, true);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  publishOffline(callback) {
    this.stopHeartbeat();
    this.publish('offline', callback);
  }
}

module.exports = { DevicePresence, STATUS_PUBLISH_OPTIONS };
