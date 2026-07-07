const { createTelemetryGenerator } = require("../telemetry-generator3");
const schema = require("../schema/modelF/v1.schema.json");

describe("Telemetry Generator", () => {
  let generator;

  beforeEach(() => {
    generator = createTelemetryGenerator(schema);
  });
  afterEach(() => {
    generator = null;
  });

  it("should generate a telemetry object", () => {
    const data = generator.generate();
    expect(data).toBeDefined();
    expect(typeof data).toBe("object");
  });

  it("should include schemaId in payload", () => {
    generator.setForceFull(true);
    const data = generator.generate();
    expect(data.schemaId).toBe("modelF");
  });

  it("should generate valid serial pattern", () => {
    generator.setForceFull(true);
    const data = generator.generate();
    const serial = data?.system?.identity?.serial;

    if (serial) {
      expect(serial).toMatch(/^CP-[0-9]{5}-X$/);
    }
  });

  it("should generate valid error code pattern", () => {
    generator.setForceFull(true);
    const data = generator.generate();
    const code = data?.diagnostics?.faults?.code;

    if (code) {
      expect(code).toMatch(/^ERR-[0-9]{3}$/);
    }
  });

  it("should generate valid enum values", () => {
    generator.setForceFull(true);
    const data = generator.generate();
    const mode = data?.system?.status?.mode;

    if (mode) {
      const validModes = ["LOADED", "UNLOADED", "STANDBY", "FAULT"];
      expect(validModes.includes(mode)).toBe(true);
    }
  });

  it("should always generate valid multipleOf values", () => {
    for (let i = 0; i < 100; i++) {
      const data = generator.generate();
      const p1 = data?.performance?.stages?.p1;
      const p2 = data?.performance?.stages?.p2;

      if (p1 !== undefined) {
        expect((p1 * 10) % 1).toBe(0);
      }
      if (p2 !== undefined) {
        expect((p2 * 10) % 1).toBe(0);
      }
    }
  });

  it("should generate integers for integer fields", () => {
    generator.setForceFull(true);
    const data = generator.generate();
    const runtime = data?.performance?.output?.total_runtime;

    if (runtime !== undefined) {
      expect(Number.isInteger(runtime)).toBe(true);
    }
  });

  it("should generate full payload when forced", () => {
    generator.setForceFull(true);
    const data = generator.generate();
    
    expect(data.system).toBeDefined();
    expect(data.performance).toBeDefined();
    expect(data.diagnostics).toBeDefined();
  });

  it("should generate values within defined ranges", () => {
    generator.setForceFull(true);
    const data = generator.generate();
    const voltage = data?.performance?.electrical?.voltage;

    if (voltage !== undefined) {
      expect(voltage).toBeGreaterThanOrEqual(380);
      expect(voltage).toBeLessThanOrEqual(440);
    }
  });

  it("should not crash on repeated generation", () => {
    for (let i = 0; i < 200; i++) {
      expect(() => generator.generate()).not.toThrow();
    }
  });

  it("should generate different values over time", () => {
    const a = generator.generate();
    const b = generator.generate();
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("should handle min and max being the same value", () => {
    const fixedSchema = {
      type: "object",
      properties: {
        val: { type: "number", minimum: 10, maximum: 10 }
      }
    };
    const gen = createTelemetryGenerator(fixedSchema);
    const data = gen.generate();
    expect(data.val).toBe(10);
  });

  it("should handle schema with no properties gracefully", () => {
    const emptySchema = { type: "object" };
    const gen = createTelemetryGenerator(emptySchema);
    expect(() => gen.generate()).not.toThrow();
  });

  it("should not crash if enum is empty", () => {
    const brokenSchema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: [] }
      }
    };
    const gen = createTelemetryGenerator(brokenSchema);
    expect(() => gen.generate()).not.toThrow();
  });

  it("should generate partial payload (not full every time)", () => {
    // 1. Dobij full
    generator.setForceFull(true);
    const fullData = generator.generate();
    const maxFields = Object.keys(fullData).length;

    // 2. Pokušaj nekoliko puta da dobiješ manji payload
    let isSmaller = false;
    for (let i = 0; i < 10; i++) {
      generator.setForceFull(false);
      const deltaData = generator.generate();
      if (Object.keys(deltaData).length < maxFields) {
        isSmaller = true;
        break;
      }
    }

    expect(isSmaller).toBe(true);
  });
});