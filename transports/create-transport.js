const mqtt = require('mqtt');

function createMqttConnectOptions(deviceId, statusTopic, now = new Date()) {
  return {
    will: {
      topic: statusTopic,
      payload: JSON.stringify({
        deviceId,
        timestamp: now.toISOString(),
        status: 'offline',
      }),
      qos: 1,
      retain: true,
    },
  };
}

function createTransport(config, deviceId, topics, logger) {
  if (!['mqtt', 'coap'].includes(config.transport)) {
    throw new Error(`Unsupported transport: ${config.transport}`);
  }

  if (config.transport === 'coap') {
    const { createCoapClientAdapter } = require('./coap-client-adapter');
    const backendUrl = new URL(config.coapBackendUrl);

    if (backendUrl.protocol !== 'coap:') {
      throw new Error('COAP_BACKEND_URL must use the coap:// protocol.');
    }

    if (
      !Number.isInteger(config.coapCommandPort) ||
      config.coapCommandPort < 1 ||
      config.coapCommandPort > 65535
    ) {
      throw new Error('COAP_COMMAND_PORT must be between 1 and 65535.');
    }

    logger.info(`Connecting to CoAP backend: ${config.coapBackendUrl}`);
    return createCoapClientAdapter({
      deviceId,
      backendUrl: config.coapBackendUrl,
      listenHost: config.coapCommandHost,
      listenPort: config.coapCommandPort,
      advertisedHost: config.coapAdvertisedHost,
      commandTopic: topics.commands,
      responseTopic: topics.response,
    });
  }

  logger.info(`Connecting to broker instance URL: ${config.mqttBrokerUrl}`);
  return mqtt.connect(
    config.mqttBrokerUrl,
    createMqttConnectOptions(deviceId, topics.status),
  );
}

module.exports = { createMqttConnectOptions, createTransport };
