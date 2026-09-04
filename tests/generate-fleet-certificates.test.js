const {
  parseArguments,
  validateManifest,
} = require('../scripts/generate-fleet-certificates');

function device(serialNumber) {
  return {
    serialNumber,
    name: `Device ${serialNumber}`,
    type: 'sensor',
    model: 'modelA',
    version: '10.0.0',
  };
}

describe('fleet certificate manifest', () => {
  it('accepts a valid structured manifest', () => {
    const manifest = {
      targetUserEmail: 'owner@example.com',
      devices: [device('fleet-a-001'), device('fleet-a-002')],
    };

    expect(validateManifest(manifest)).toBe(manifest);
  });

  it('rejects duplicate serial numbers', () => {
    expect(() =>
      validateManifest({
        devices: [device('fleet-a-001'), device('fleet-a-001')],
      }),
    ).toThrow('FLEET_DEVICE_SERIAL_DUPLICATE:fleet-a-001');
  });

  it('rejects serial numbers that are unsafe for certificate filenames', () => {
    expect(() =>
      validateManifest({ devices: [device('../unsafe-device')] }),
    ).toThrow('FLEET_DEVICE_SERIAL_INVALID:1:../unsafe-device');
  });

  it('supports a custom manifest and validation-only mode', () => {
    expect(
      parseArguments(['--file', 'fleet/custom.json', '--dry-run']),
    ).toMatchObject({
      manifestPath: expect.stringMatching(/fleet\/custom\.json$/),
      dryRun: true,
    });
  });
});
