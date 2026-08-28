class GeneratorLogger {
  debug(message) {
    if (global.simulatorLogger) {
      global.simulatorLogger.debug(`[TelemetryGenerator] ${message}`);
    }
  }
}

const logger = new GeneratorLogger();

function createTelemetryGenerator(schema, deviceState = {}) {
  if (!schema || typeof schema !== 'object') {
    throw new Error("Invalid schema");
  }

  let nextIsFull = true;

  const state = {
    stableCounter: 0,
    peakCounter: 0,
    baseline: {},
    cycleCounter: 0,
    lastSent: {},
    historicalTelemetry: {},
    historicalLastSample: {},
    lastHistoricalFlush: Date.now(),
    lastHistoricalSample: Date.now()
  };

  const supportsHistoricalTelemetry = !!schema.properties?.historicalTelemetry;
  const historicalFlushInterval = schema.properties?.historicalTelemetry?.["x-reporting"]?.IDLE ?? 3600000;
  
  const fieldDefinitions = {};
  const historicalBuffers = {};
  const historicalToLivePath = {};
  const fixedValues = new Map();
  const maximumOverrides = new Map();

  function generateFromPattern(pattern) {
    if (pattern === "^CP-[0-9]{5}-X$") {
      return `CP-${Math.floor(10000 + Math.random() * 90000)}-X`;
    }
    if (pattern === "^SP-[0-9]{5}-X$") {
      return `SP-${Math.floor(10000 + Math.random() * 90000)}-X`;
    }
    if (pattern === "^ERR-[0-9]{3}$") {
      return `ERR-${Math.floor(100 + Math.random() * 900)}`;
    }
    if (pattern.includes("INV")) {
      return "INV-2026-XAE412";
    }
    if (pattern === "^v[0-9]+\\.[0-9]+\\.[0-9]+-(alpha|beta|rc|release)$") {
      const types = ["alpha", "beta", "rc", "release"];
      const type = types[Math.floor(Math.random() * types.length)];
      return `v1.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)}-${type}`;
    }
    if (pattern === "^0x[0-9A-Fa-f]{4}$") {
      const hex = Math.floor(Math.random() * 65536)
        .toString(16)
        .padStart(4, "0");
      return `0x${hex}`;
    }
    return "UNKNOWN";
  }

  function parseSchema(subSchema, currentPath = "", requiredFields = []) {
    if (!subSchema || typeof subSchema !== "object") return;
    if (
      currentPath.startsWith("historicalTelemetry") ||
      currentPath === "attributes" ||
      currentPath.startsWith("attributes.")
    ) {
      return;
    }

    if (subSchema.type === "object" && subSchema.properties) {
      Object.keys(subSchema.properties).forEach((key) => {
        if (key === "schemaId") return;
        const nextPath = currentPath ? `${currentPath}.${key}` : key;
        parseSchema(subSchema.properties[key], nextPath, subSchema.required || []);
      });
    } else {
      fieldDefinitions[currentPath] = {
        ...subSchema,
        required: requiredFields.includes(currentPath.split(".").pop()),
        reporting: subSchema["x-reporting"] || { "ACTIVE": 5000, "IDLE": 300000 }
      };

      if (subSchema.type === "number" || subSchema.type === "integer") {
        const min = subSchema.minimum ?? 0;
        const max = subSchema.maximum ?? 100;
        const start = (min + max) / 2;

        state[currentPath] = start;
        state.baseline[currentPath] = start;
      } else if (subSchema.type === "boolean") {
        state[currentPath] = false;
      }
    }
  }

  parseSchema(schema);

  const historicalProps = schema.properties?.historicalTelemetry?.properties || {};

  Object.entries(historicalProps).forEach(([field, def]) => {
    historicalBuffers[field] = def["x-buffering"]?.interval ?? 5000;
    state.historicalTelemetry[field] = [];
    state.historicalLastSample[field] = 0;

    const matchingPath = Object.keys(fieldDefinitions).find(
      path => path.endsWith(`.${field}`)
    );

    if (matchingPath) {
      historicalToLivePath[field] = matchingPath;
    }
  });

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
  }

  function round(value) {
    return Number(value.toFixed(1));
  }

  function calculateNZD(a, b) {
    while (b) {
      a = a % b;
      [a, b] = [b, a];
    }
    return a;
  }

  function getOptimalTick(mode = "ACTIVE") {
    const intervals = Object.values(fieldDefinitions)
      .map(def => def.reporting?.[mode])
      .filter(i => typeof i === 'number' && i > 0);

    if (intervals.length === 0) return 1000;

    const gcd = intervals.reduce((acc, curr) => calculateNZD(acc, curr));
    return Math.max(gcd, 100);
  }

  function getMinimumInterval(mode = "ACTIVE") {
    let min = Infinity;

    Object.values(fieldDefinitions).forEach((def) => {
      const interval = def.reporting?.[mode];
      if (typeof interval === "number" && interval > 0 && interval < min) {
        min = interval;
      }
    });

    return min === Infinity ? 1000 : min;
  }

  function getOptimalHistoricalBufferTick() {
    const intervals = Object.values(
      schema.properties?.historicalTelemetry?.properties || {}
    )
      .map(def => def["x-buffering"]?.interval)
      .filter(i => typeof i === "number" && i > 0);

    if (intervals.length === 0) {
      return 5000;
    }

    const gcd = intervals.reduce((acc, curr) => calculateNZD(acc, curr));
    return Math.max(gcd, 100);
  }

  function getEffectiveBounds(path) {
    const definition = fieldDefinitions[path] || {};
    const minimum = definition.minimum ?? -Infinity;
    const schemaMaximum = definition.maximum ?? Infinity;
    const configuredMaximum = maximumOverrides.get(path);
    const maximum = configuredMaximum === undefined
      ? schemaMaximum
      : Math.min(configuredMaximum, schemaMaximum);

    return {
      minimum,
      maximum: Math.max(minimum, maximum),
    };
  }

  function normalizeFixedValue(path, value) {
    const definition = fieldDefinitions[path];

    if (!definition) {
      throw new Error(`Telemetry field does not exist in schema: ${path}`);
    }

    if (definition.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`Telemetry field ${path} requires a boolean value.`);
      }
      return value;
    }

    if (definition.type === "number" || definition.type === "integer") {
      const numericValue = Number(value);

      if (!Number.isFinite(numericValue)) {
        throw new Error(`Telemetry field ${path} requires a numeric value.`);
      }

      const { minimum, maximum } = getEffectiveBounds(path);
      const normalized = clamp(numericValue, minimum, maximum);
      return definition.type === "integer" ? Math.round(normalized) : normalized;
    }

    if (definition.enum && !definition.enum.includes(value)) {
      throw new Error(`Telemetry field ${path} does not allow value ${value}.`);
    }

    return value;
  }

  function applyFixedValues() {
    fixedValues.forEach((value, path) => {
      state[path] = value;

      if (
        fieldDefinitions[path]?.type === "number" ||
        fieldDefinitions[path]?.type === "integer"
      ) {
        state.baseline[path] = value;
      }
    });
  }

  function setFixedValue(path, value) {
    const normalized = normalizeFixedValue(path, value);
    fixedValues.set(path, normalized);
    state[path] = normalized;

    if (
      fieldDefinitions[path].type === "number" ||
      fieldDefinitions[path].type === "integer"
    ) {
      state.baseline[path] = normalized;
    }

    return normalized;
  }

  function clearFixedValue(path) {
    fixedValues.delete(path);
  }

  function setMaximumValue(path, value) {
    const definition = fieldDefinitions[path];

    if (!definition) {
      throw new Error(`Telemetry field does not exist in schema: ${path}`);
    }

    if (definition.type !== "number" && definition.type !== "integer") {
      throw new Error(`Telemetry field ${path} does not support a numeric maximum.`);
    }

    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
      throw new Error(`Telemetry maximum for ${path} must be numeric.`);
    }

    const schemaMinimum = definition.minimum ?? -Infinity;
    const schemaMaximum = definition.maximum ?? Infinity;
    const normalized = clamp(numericValue, schemaMinimum, schemaMaximum);
    maximumOverrides.set(path, normalized);

    const effectiveMinimum = Number.isFinite(schemaMinimum)
      ? schemaMinimum
      : Math.min(0, normalized);
    const operatingRange = Math.max(0, normalized - effectiveMinimum);
    const safeBaseline = effectiveMinimum + operatingRange * 0.75;

    state[path] = clamp(
      Math.min(state[path], safeBaseline),
      effectiveMinimum,
      normalized
    );
    state.baseline[path] = safeBaseline;
    return normalized;
  }

  function clearMaximumValue(path) {
    maximumOverrides.delete(path);
  }

  function applyClamp() {
    Object.keys(fieldDefinitions).forEach((path) => {
      if (fieldDefinitions[path].type === "number" || fieldDefinitions[path].type === "integer") {
        const { minimum, maximum } = getEffectiveBounds(path);
        state[path] = clamp(
          state[path],
          minimum,
          maximum
        );
      }
    });

    applyFixedValues();
  }

  function maybeToggleBoolean() {
    Object.keys(fieldDefinitions).forEach(path => {
      if (fixedValues.has(path)) {
        return;
      }

      if (
        path === "telemetry.led" ||
        path.endsWith("ledState") ||
        path === "system.status.pumpEnabled"
      ) {
        return;
      }

      if (fieldDefinitions[path].type === "boolean" && Math.random() < 0.05) {
        state[path] = !state[path];
      }
    });
  }

  function normalFluctuation() {
    Object.keys(fieldDefinitions).forEach((path) => {
      if (fixedValues.has(path)) {
        return;
      }

      if (
        path === "system.status.targetFlow" ||
        path === "metrics.flowRate"
      ) {
        return;
      }
      if (fieldDefinitions[path].type !== "number" && fieldDefinitions[path].type !== "integer") return;

      const bounds = getEffectiveBounds(path);
      const min = Number.isFinite(bounds.minimum) ? bounds.minimum : 0;
      const max = Number.isFinite(bounds.maximum) ? bounds.maximum : 100;
      const range = max - min;
      const drift = randomBetween(-0.01 * range, 0.01 * range);

      state[path] += (state.baseline[path] - state[path]) * 0.1;
      state[path] += drift;
    });
  }

  function peakFluctuation() {
    Object.keys(fieldDefinitions).forEach((path) => {
      if (fixedValues.has(path)) {
        return;
      }

      if (
        path === "system.status.targetFlow" ||
        path === "metrics.flowRate"
      ) {
        return;
      }
      if (fieldDefinitions[path].type !== "number" && fieldDefinitions[path].type !== "integer") return;
      if (path.includes("maintenance") || path.includes("Runtime")) return;
      if (Math.random() > 0.3) return;

      const bounds = getEffectiveBounds(path);
      const min = Number.isFinite(bounds.minimum) ? bounds.minimum : 0;
      const max = Number.isFinite(bounds.maximum) ? bounds.maximum : 100;
      const range = max - min;

      state[path] += randomBetween(0.05 * range, 0.1 * range);
      state[path] = clamp(state[path], min, max);
    });
  }

  function slowRecovery() {
    Object.keys(fieldDefinitions).forEach((path) => {
      if (fixedValues.has(path)) {
        return;
      }

      if (
        path === "system.status.targetFlow" ||
        path === "metrics.flowRate"
      ) {
        return;
      }
      if (fieldDefinitions[path].type !== "number" && fieldDefinitions[path].type !== "integer") return;
      state[path] += (state.baseline[path] - state[path]) * 0.05;
    });
  }

  function maybeShiftBaseline() {
    if (Math.random() < 0.05) {
      Object.keys(fieldDefinitions).forEach((path) => {
        if (fixedValues.has(path)) {
          return;
        }

        if (fieldDefinitions[path].type !== "number" && fieldDefinitions[path].type !== "integer") return;

        const bounds = getEffectiveBounds(path);
        const min = Number.isFinite(bounds.minimum) ? bounds.minimum : 0;
        const max = Number.isFinite(bounds.maximum) ? bounds.maximum : 100;
        const range = max - min;
        let shift = randomBetween(-0.02 * range, 0.02 * range);

        state.baseline[path] = clamp(
          state.baseline[path] + shift,
          min,
          max
        );
      });
    }
  }

  function setDeepValue(obj, path, value) {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) current[part] = {};
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }

  function updateDeviceState() {
    applyFixedValues();

    if (
      deviceState.targetFlow !== undefined &&
      state["system.status.targetFlow"] !== undefined
    ) {
      state["system.status.targetFlow"] = deviceState.targetFlow;
      state.baseline["system.status.targetFlow"] = deviceState.targetFlow;
    }

    if (
      deviceState.pumpEnabled !== undefined &&
      state["system.status.pumpEnabled"] !== undefined
    ) {
      state["system.status.pumpEnabled"] = deviceState.pumpEnabled;
    }

    if (state["metrics.flowRate"] !== undefined) {
      const desiredFlow = deviceState.pumpEnabled ? deviceState.targetFlow : 0;
      state["metrics.flowRate"] += (desiredFlow - state["metrics.flowRate"]) * 0.15;
    }

    if (state.peakCounter === 0 && Math.random() < 0.25) {
      state.peakCounter = Math.floor(randomBetween(5, 10));
      logger.debug(`Peak spike event triggered! Wave duration: ${state.peakCounter} cycles.`);
    }

    if (state.peakCounter > 0) {
      peakFluctuation();
      state.peakCounter--;
    } else {
      normalFluctuation();
    }

    slowRecovery();
    maybeToggleBoolean();
    maybeShiftBaseline();
    applyClamp();

    if (Math.random() < 0.1) {
      state.stableCounter = Math.floor(randomBetween(1, 2));
    }
  }

  function addHistoricalSample() {
    if (!supportsHistoricalTelemetry) {
      return;
    }

    updateDeviceState();

    const now = Date.now();
    const iso = new Date(now).toISOString();

    Object.keys(historicalBuffers).forEach(field => {
      const path = historicalToLivePath[field];
      if (!path) {
        return;
      }
      const interval = historicalBuffers[field];
      const last = state.historicalLastSample[field] ?? 0;

      if (now - last < interval) {
        return;
      }

      let value = state[path];
      const liveDefinition = fieldDefinitions[path];

      if (liveDefinition?.type === "integer") {
        value = Math.round(value);
      } else {
        value = round(value);
      }

      if (!state.historicalTelemetry[field]) {
        state.historicalTelemetry[field] = [];
      }

      state.historicalTelemetry[field].push([value, iso]);

      const maxItems = schema.properties.historicalTelemetry.properties[field]?.maxItems ?? 24;

      if (state.historicalTelemetry[field].length > maxItems) {
        state.historicalTelemetry[field].shift();
      }

      state.historicalLastSample[field] = now;
    });
  }

  function build(mode = "delta") {
    const isFull = mode === "full";
    const isHeartbeat = mode === "heartbeat";

    const payload = {};
    const fields = Object.keys(fieldDefinitions);
    const desiredPercentage = isFull ? 1.0 : randomBetween(0.1, 0.8);
    const activeFields = fields.filter(() => Math.random() < desiredPercentage);

    const now = Date.now();
    if (supportsHistoricalTelemetry && isHeartbeat) {
      const shouldFlush = now - state.lastHistoricalFlush >= historicalFlushInterval;
      const hasData = Object.values(state.historicalTelemetry).some(arr => arr.length > 0);

      if (shouldFlush && hasData) {
        const historicalPayload = {};

        Object.keys(state.historicalTelemetry).forEach(field => {
          if (state.historicalTelemetry[field].length > 0) {
            historicalPayload[field] = [...state.historicalTelemetry[field]];
            state.historicalTelemetry[field] = [];
          }
        });

        payload.historicalTelemetry = historicalPayload;
        logger.debug(`[HISTORY] Flushing historical telemetry buffers`);
        state.lastHistoricalFlush = now;
      }
    }

    Object.keys(fieldDefinitions).forEach((path) => {
      const def = fieldDefinitions[path];

      const reportingMode = isHeartbeat ? "IDLE" : "ACTIVE";

      if (!isFull) {
        const interval = def.reporting?.[reportingMode];
        if (interval == null) {
          return;
        }
        if (state.lastSent[path] && now - state.lastSent[path] < interval) {
          return;
        }
      }

      if (!isFull && !isHeartbeat && !activeFields.includes(path)) {
        return;
      }

      if (fixedValues.has(path)) {
        setDeepValue(payload, path, fixedValues.get(path));
        state.lastSent[path] = now;
      } else if (def.enum) {
        const randomEnum = def.enum[Math.floor(Math.random() * def.enum.length)];
        setDeepValue(payload, path, randomEnum);
        state.lastSent[path] = now;
      } else if (def.type === "number" || def.type === "integer") {
        let val = state[path];
        if (def.multipleOf) {
          val = Math.round(val / def.multipleOf) * def.multipleOf;
        }

        const { minimum: min, maximum: max } = getEffectiveBounds(path);
        val = Math.min(Math.max(val, min), max);

        state[path] = val;

        const finalValue = def.type === "integer"
          ? Math.round(val)
          : Math.round(val * 10) / 10;

        setDeepValue(payload, path, finalValue);
        state.lastSent[path] = now;
      } else if (def.type === "boolean") {
        setDeepValue(payload, path, state[path]);
        state.lastSent[path] = now;
      } else if (def.type === "string") {
        if (def.pattern) {
          setDeepValue(payload, path, generateFromPattern(def.pattern));
        } else if (path.toLowerCase().includes("firmware") || path.toLowerCase().includes("version")) {
          setDeepValue(payload, path, `v1.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)}`);
        } else if (path.toLowerCase().includes("serial")) {
          setDeepValue(payload, path, `SP-${Math.floor(10000 + Math.random() * 90000)}-X`);
        } else {
          setDeepValue(payload, path, "OPERATIONAL");
        }
        state.lastSent[path] = now;
      }
    });

    const schemaId = schema.properties?.schemaId?.const;
    if (schemaId) {
      payload.schemaId = schemaId;
    }

    if (Object.keys(payload).length === 0) {
      return null;
    }

    return payload;
  }

  function generateHeartbeat() {
    applyFixedValues();
    return build("heartbeat");
  }

  function setForceFull(val) {
    nextIsFull = val;
  }

  function generate() {
    state.cycleCounter++;

    applyFixedValues();

    const isFiveMinuteMark = state.cycleCounter >= 300;

    if (isFiveMinuteMark) {
      state.cycleCounter = 0;
      return build("full");
    }

    if (state.stableCounter > 0) {
      state.stableCounter--;
      return build("delta");
    }

    updateDeviceState();

    if (nextIsFull) {
      nextIsFull = false;
      return build("full");
    }

    return build("delta");
  }

  return {
    generate,
    generateHeartbeat,
    addHistoricalSample,
    setForceFull,
    getMinimumInterval,
    getOptimalTick,
    getOptimalHistoricalBufferTick,
    setFixedValue,
    clearFixedValue,
    setMaximumValue,
    clearMaximumValue
  };
}

module.exports = {
  createTelemetryGenerator,
};
