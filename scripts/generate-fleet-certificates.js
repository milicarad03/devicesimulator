const { existsSync, readFileSync } = require('fs');
const { resolve } = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIRECTORY = resolve(__dirname, '..');
const DEFAULT_MANIFEST = resolve(
  PROJECT_DIRECTORY,
  'fleet/devices-100.json',
);
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseArguments(argv) {
  const options = {
    manifestPath: DEFAULT_MANIFEST,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--file') {
      const value = argv[index + 1];
      if (!value) throw new Error('MISSING_VALUE_FOR_FILE');
      options.manifestPath = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
  }

  return options;
}

function readManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `FLEET_MANIFEST_READ_FAILED:${manifestPath}:${error.message}`,
    );
  }

  return validateManifest(parsed);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('FLEET_MANIFEST_MUST_BE_AN_OBJECT');
  }
  if (!Array.isArray(manifest.devices) || manifest.devices.length === 0) {
    throw new Error('FLEET_MANIFEST_DEVICES_REQUIRED');
  }
  if (manifest.devices.length > 1000) {
    throw new Error('FLEET_MANIFEST_DEVICE_LIMIT_EXCEEDED');
  }

  const serialNumbers = new Set();
  for (const [index, device] of manifest.devices.entries()) {
    const rowNumber = index + 1;
    if (!device || typeof device !== 'object') {
      throw new Error(`FLEET_DEVICE_INVALID:${rowNumber}`);
    }

    for (const field of [
      'serialNumber',
      'name',
      'type',
      'model',
      'version',
    ]) {
      if (typeof device[field] !== 'string' || !device[field].trim()) {
        throw new Error(`FLEET_DEVICE_FIELD_REQUIRED:${rowNumber}:${field}`);
      }
    }

    if (!DEVICE_ID_PATTERN.test(device.serialNumber)) {
      throw new Error(
        `FLEET_DEVICE_SERIAL_INVALID:${rowNumber}:${device.serialNumber}`,
      );
    }
    if (serialNumbers.has(device.serialNumber)) {
      throw new Error(`FLEET_DEVICE_SERIAL_DUPLICATE:${device.serialNumber}`);
    }
    serialNumbers.add(device.serialNumber);
  }

  return manifest;
}

function generateCertificates(manifest, options = {}) {
  const generatorPath = [
    resolve(PROJECT_DIRECTORY, 'scripts/generate-device.sh'),
    resolve(PROJECT_DIRECTORY, 'generate-device.sh'),
  ].find(existsSync);
  if (!generatorPath) {
    throw new Error('DEVICE_CERTIFICATE_GENERATOR_NOT_FOUND');
  }
  const results = [];

  for (const [index, device] of manifest.devices.entries()) {
    const position = `${index + 1}/${manifest.devices.length}`;
    if (options.dryRun) {
      results.push({
        serialNumber: device.serialNumber,
        status: 'VALIDATED',
      });
      continue;
    }

    process.stdout.write(
      `[fleet-certificates] ${position} ${device.serialNumber}\n`,
    );
    const result = spawnSync('bash', [generatorPath, device.serialNumber], {
      cwd: PROJECT_DIRECTORY,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const succeeded = result.status === 0;
    results.push({
      serialNumber: device.serialNumber,
      status: succeeded ? 'CREATED' : 'FAILED',
      error: succeeded
        ? undefined
        : (result.stderr || result.stdout || 'UNKNOWN_ERROR').trim(),
    });
  }

  return results;
}

function printSummary(results, dryRun) {
  const successfulStatus = dryRun ? 'VALIDATED' : 'CREATED';
  const successful = results.filter(
    (result) => result.status === successfulStatus,
  ).length;
  const failed = results.filter(
    (result) => result.status === 'FAILED',
  );

  console.log('');
  console.log('--- FLEET CERTIFICATE SUMMARY ---');
  console.log(`Planned: ${results.length}`);
  console.log(`${dryRun ? 'Validated' : 'Created'}: ${successful}`);
  console.log(`Failed: ${failed.length}`);

  for (const failure of failed) {
    console.error(`${failure.serialNumber}: ${failure.error}`);
  }

  if (failed.length > 0) process.exitCode = 1;
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const manifest = readManifest(options.manifestPath);
    const results = generateCertificates(manifest, options);
    printSummary(results, options.dryRun);
  } catch (error) {
    console.error(`[fleet-certificates] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  generateCertificates,
  parseArguments,
  readManifest,
  validateManifest,
};
