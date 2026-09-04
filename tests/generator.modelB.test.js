const { createTelemetryGenerator } = require("../telemetry-generator3");
const schema = require("../schema/modelB/v1.schema.json");

describe("ModelB Telemetry Generator", () => {
  let generator;

  beforeEach(() => {
    generator = createTelemetryGenerator(schema);
  });

  afterEach(() => {
    generator = null;
  });

  it("should generate a valid ModelB object", () => {
    generator.setForceFull(true);
    const data = generator.generate();

    expect(data.schemaId).toBe("modelB");
    expect(data.data).toBeDefined();
    expect(data.status).toBeDefined();
  });

  it("should generate values within defined ranges for data fields", () => {
    generator.setForceFull(true);

    for (let i = 0; i < 50; i++) {
      const data = generator.generate();

      if (data.data?.temp !== undefined) {
        expect(data.data.temp).toBeGreaterThanOrEqual(-50);
        expect(data.data.temp).toBeLessThanOrEqual(100);
      }

      if (data.data?.hum !== undefined) {
        expect(data.data.hum).toBeGreaterThanOrEqual(0);
        expect(data.data.hum).toBeLessThanOrEqual(100);
      }

      if (data.data?.press !== undefined) {
        expect(data.data.press).toBeGreaterThanOrEqual(300);
        expect(data.data.press).toBeLessThanOrEqual(1200);
      }
    }
  });

  it("should generate boolean for ledState", () => {
    generator.setForceFull(true);
    const data = generator.generate();

    expect(typeof data.status.ledState).toBe("boolean");
  });

  it("should generate partial payload occasionally", () => {
    generator.setForceFull(true);
    const fullData = generator.generate();
    const maxKeys = Object.keys(fullData).length;

    let foundPartial = false;

    for (let i = 0; i < 10; i++) {
      generator.setForceFull(false);
      const deltaData = generator.generate();

      if (Object.keys(deltaData).length < maxKeys) {
        foundPartial = true;
        break;
      }
    }

    expect(foundPartial).toBe(true);
  });

  it("should not crash on repeated generation", () => {
    for (let i = 0; i < 100; i++) {
      expect(() => generator.generate()).not.toThrow();
    }
  });

  it("should throw error if invalid schema is provided", () => {
    expect(() => createTelemetryGenerator(null)).toThrow();
  });

  it("should maintain schema-required fields even in delta (partial) payload", () => {
    generator.setForceFull(true);
    generator.generate();

    generator.setForceFull(false);

    let delta = null;

    for (let i = 0; i < 20; i++) {
      delta = generator.generate();

      if (delta) {
        break;
      }
    }

    expect(delta).toBeDefined();
    expect(delta).not.toBeNull();

    expect(delta.schemaId).toBe("modelB");
  });

  it("should never exceed defined boundaries after many fluctuations", () => {
    generator.setForceFull(true);

    for (let i = 0; i < 1000; i++) {
      const data = generator.generate();

      if (data.data?.temp !== undefined) {
        expect(data.data.temp).toBeGreaterThanOrEqual(-50);
        expect(data.data.temp).toBeLessThanOrEqual(100);
      }
    }
  });

  it("should eventually generate data object", () => {
    let hasData = false;

    for (let i = 0; i < 20; i++) {
      const generated = generator.generate();

      if (generated?.data) {
        hasData = true;
        break;
      }
    }

    expect(hasData).toBe(true);
  });
});
