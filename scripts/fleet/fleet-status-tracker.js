const mqtt = require('mqtt');

const STATUS_TOPIC = 'iot/devices/+/status';

function parseStatusMessage(topic, payload) {
  const match = /^iot\/devices\/([^/]+)\/status$/.exec(topic);
  if (!match) return null;

  try {
    const parsed = JSON.parse(payload.toString('utf8'));
    const status =
      typeof parsed === 'string' ? parsed : parsed?.status;
    if (typeof status !== 'string') return null;

    return {
      deviceId: decodeURIComponent(match[1]),
      status: status.toUpperCase(),
    };
  } catch {
    return null;
  }
}

class FleetStatusTracker {
  constructor(options) {
    this.brokerUrl = options.brokerUrl;
    this.deviceIds = new Set(options.deviceIds);
    this.onStatus = options.onStatus;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.client = null;
  }

  connect() {
    if (this.client) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const client = mqtt.connect(this.brokerUrl, {
        reconnectPeriod: 1_000,
        connectTimeout: this.connectTimeoutMs,
      });
      this.client = client;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.end(true);
        reject(new Error('FLEET_MQTT_CONNECT_TIMEOUT'));
      }, this.connectTimeoutMs);

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      client.on('error', (error) => {
        if (!settled) finish(error);
      });
      client.once('connect', () => {
        client.subscribe(STATUS_TOPIC, { qos: 1 }, (error) => {
          finish(error || null);
        });
      });
      client.on('message', (topic, payload) => {
        const message = parseStatusMessage(topic, payload);
        if (!message || !this.deviceIds.has(message.deviceId)) return;
        this.onStatus(message.deviceId, message.status);
      });
    });
  }

  close() {
    if (!this.client) return Promise.resolve();
    const client = this.client;
    this.client = null;

    return new Promise((resolve) => {
      client.end(false, {}, resolve);
    });
  }
}

module.exports = {
  FleetStatusTracker,
  parseStatusMessage,
};
