const fs = require('fs');
const path = require('path');

function loadSimulatorConfig({ argv, env, baseDirectory, logger }) {
  const deviceArg = argv[2];
  const modelArg = argv[3];
  const versionArg = argv[4];

  if (!deviceArg || !modelArg || !versionArg) {
    throw new Error('Usage: node sim.js <device> <model> <version>');
  }

  const schemaFile = path.join(
    baseDirectory,
    'schema',
    modelArg,
    `${versionArg}.schema.json`,
  );

  if (!fs.existsSync(schemaFile)) {
    throw new Error(`[SCHEMA] Missing file path: ${schemaFile}`);
  }

  logger.info(`Using schema profile: ${schemaFile}`);
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  const runtimeConfigFile = path.join(baseDirectory, 'device-data1.json');

  if (!fs.existsSync(runtimeConfigFile)) {
    throw new Error(`Configuration file missing: ${runtimeConfigFile}`);
  }

  const runtimeConfig = JSON.parse(
    fs.readFileSync(runtimeConfigFile, 'utf8'),
  );
  const deviceFolder = /^\d+$/.test(deviceArg)
    ? `device-${deviceArg}`
    : deviceArg;
  const certificateDirectory = path.join(
    baseDirectory,
    'certs',
    deviceFolder,
  );
  const stagedUpdateDirectory = path.join(
    baseDirectory,
    'staged',
    deviceFolder,
  );

  return {
    baseDirectory,
    deviceArg,
    modelArg,
    versionArg,
    schema,
    schemaFile,
    runtimeConfig,
    transport: (env.TRANSPORT || 'mqtt').toLowerCase(),
    mqttBrokerUrl: env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    coapBackendUrl:
      env.COAP_BACKEND_URL || 'coap://127.0.0.1:5683',
    coapCommandHost: env.COAP_COMMAND_HOST || '127.0.0.1',
    coapCommandPort: Number(env.COAP_COMMAND_PORT || 5684),
    coapAdvertisedHost:
      env.COAP_ADVERTISED_HOST ||
      env.COAP_COMMAND_HOST ||
      '127.0.0.1',
    registrationUrl:
      env.REGISTRATION_URL ||
      'http://localhost:3000/device-certificates/register',
    skipCertificateRegistration: env.SKIP_CERT === 'true',
    telemetryStatsFile:
      env.TELEMETRY_STATS_FILE ||
      path.join(baseDirectory, 'telemetry_stats_delta1.log'),
    deviceAttributes: {
      serialNumber: deviceArg,
      firmware: versionArg,
      hardwareModel: modelArg,
    },
    supportsAttributes: Boolean(
      schema?.properties?.attributes &&
        typeof schema.properties.attributes === 'object' &&
        !Array.isArray(schema.properties.attributes),
    ),
    stagedUpdateDirectory,
    stagedUpdateFile: path.join(
      stagedUpdateDirectory,
      'model-update.json',
    ),
    certificatePaths: {
      factoryKey: path.join(
        certificateDirectory,
        'factory-device.key',
      ),
      factoryCertificate: path.join(
        certificateDirectory,
        'factory-device.crt',
      ),
      operationalKey: path.join(
        certificateDirectory,
        'operational-device.key',
      ),
      operationalCsr: path.join(
        certificateDirectory,
        'operational-device.csr',
      ),
      factoryProof: path.join(
        certificateDirectory,
        'factory-proof.sig',
      ),
      operationalCertificate: path.join(
        certificateDirectory,
        'operational-device.crt',
      ),
      operationalCaCertificate: path.join(
        certificateDirectory,
        'operational-ca.crt',
      ),
    },
    certificateDirectory,
  };
}

function createDeviceTopics(deviceId) {
  return {
    telemetry: `iot/devices/${deviceId}/telemetry`,
    status: `iot/devices/${deviceId}/status`,
    commands: `iot/devices/${deviceId}/commands`,
    response: `iot/devices/${deviceId}/response`,
    attributes: `iot/devices/${deviceId}/attributes`,
  };
}

module.exports = { createDeviceTopics, loadSimulatorConfig };
