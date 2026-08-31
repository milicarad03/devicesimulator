const fs = require('fs');
const { execFileSync } = require('child_process');

function ensureDirectoryExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function assertFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `[CERT SETUP] Missing foundational component ${label}: ${filePath}`,
    );
  }
}

function runOpenSsl(args, logger) {
  try {
    execFileSync('openssl', args, { stdio: 'pipe' });
  } catch (error) {
    logger.error(
      `OpenSSL execution failed command args: ${args.join(' ')}`,
    );
    throw error;
  }
}

function extractCommonName(subject) {
  const match = subject.match(/CN\s*=\s*([^,\n/]+)/);
  return match ? match[1].trim() : null;
}

function getCertificateCommonName(filePath) {
  const subject = execFileSync('openssl', [
    'x509',
    '-in',
    filePath,
    '-noout',
    '-subject',
  ]).toString();
  const commonName = extractCommonName(subject);

  if (!commonName) {
    throw new Error(
      `Cannot extract CN from certificate file: ${filePath}`,
    );
  }

  return commonName;
}

function getCsrCommonName(filePath) {
  const subject = execFileSync('openssl', [
    'req',
    '-in',
    filePath,
    '-noout',
    '-subject',
  ]).toString();
  const commonName = extractCommonName(subject);

  if (!commonName) {
    throw new Error(`Cannot extract CN from CSR specification: ${filePath}`);
  }

  return commonName;
}

async function registerDevice(config, logger) {
  if (config.skipCertificateRegistration) {
    logger.warn(
      'SKIP_CERT enabled: Preskacem OpenSSL i koristim mock identitet.',
    );
    return config.deviceArg;
  }

  logger.info(
    'Initiating registration sequence with core platform PKI interface...',
  );
  ensureDirectoryExists(config.certificateDirectory);

  const paths = config.certificatePaths;
  assertFileExists(paths.factoryKey, 'factory-device.key');
  assertFileExists(paths.factoryCertificate, 'factory-device.crt');

  const factoryDeviceId = getCertificateCommonName(
    paths.factoryCertificate,
  );

  if (!fs.existsSync(paths.operationalKey)) {
    logger.info(
      'Operational private key infrastructure missing. Triggering generation...',
    );
    runOpenSsl(
      ['genrsa', '-out', paths.operationalKey, '2048'],
      logger,
    );
  }

  runOpenSsl(
    [
      'req',
      '-new',
      '-key',
      paths.operationalKey,
      '-out',
      paths.operationalCsr,
      '-subj',
      `/CN=${factoryDeviceId}`,
    ],
    logger,
  );

  const csrDeviceId = getCsrCommonName(paths.operationalCsr);

  if (factoryDeviceId !== csrDeviceId) {
    throw new Error(
      `Identity Verification Failed: Factory ID [${factoryDeviceId}] distinct from CSR ID [${csrDeviceId}]`,
    );
  }

  runOpenSsl(
    [
      'dgst',
      '-sha256',
      '-sign',
      paths.factoryKey,
      '-out',
      paths.factoryProof,
      paths.operationalCsr,
    ],
    logger,
  );
  logger.info(
    'Cryptographic registration artifacts built and staged successfully.',
  );

  const csrPem = fs.readFileSync(paths.operationalCsr, 'utf8');
  const factoryDeviceCertPem = fs.readFileSync(
    paths.factoryCertificate,
    'utf8',
  );
  const factoryProofBase64 = fs
    .readFileSync(paths.factoryProof)
    .toString('base64');

  const response = await fetch(config.registrationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      csrPem,
      factoryDeviceCertPem,
      factoryProofBase64,
    }),
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `PKI Edge endpoint rejected signing: Status ${response.status} -> ${responseText}`,
    );
  }

  const result = JSON.parse(responseText);
  fs.writeFileSync(
    paths.operationalCertificate,
    result.operationalDeviceCertPem,
  );
  fs.writeFileSync(
    paths.operationalCaCertificate,
    result.operationalCaCertPem,
  );
  logger.info(
    `Device cryptographic authentication registration validated successfully: ${result.deviceId}`,
  );

  return csrDeviceId;
}

module.exports = { ensureDirectoryExists, registerDevice };
