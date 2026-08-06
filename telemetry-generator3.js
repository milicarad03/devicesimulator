class GeneratorLogger {
  debug(message) {
    if (global.simulatorLogger) {
      global.simulatorLogger.debug(`[TelemetryGenerator] ${message}`);
    }
  }
}

const logger = new GeneratorLogger();

function createTelemetryGenerator(schema, deviceState) {
  if (!schema || typeof schema !== 'object') {
    throw new Error("Invalid schema");
  }
  let nextIsFull=true;
  const state = {
    stableCounter: 0,
    peakCounter: 0,
    baseline: {},
    cycleCounter: 0,
    lastSent: {},
   // historicalTelemetry:[],
    historicalTelemetry: {},
    historicalLastSample: {},
    lastHistoricalFlush: Date.now(),
    lastHistoricalSample: Date.now()
  };
  const supportsHistoricalTelemetry = !!schema.properties?.historicalTelemetry;
 // const historicalTelemetryMaxItems =schema.properties?.historicalTelemetry?.maxItems ?? 720;
  const historicalFlushInterval = schema.properties?.historicalTelemetry?.["x-reporting"]?.IDLE ?? 3600000;
  //const historicalBufferInterval = schema.properties?.historicalTelemetry?.["x-buffering"]?.interval ?? 5000;
  
  const fieldDefinitions = {};
  const historicalBuffers = {};

  function generateFromPattern(pattern) {

  if (pattern === "^CP-[0-9]{5}-X$") {
    return `CP-${Math.floor(10000 + Math.random() * 90000)}-X`;
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
    if (currentPath.startsWith("historicalTelemetry")) {
      return;
    }

    if (subSchema.type === "object" && subSchema.properties) {
      Object.keys(subSchema.properties).forEach((key) => {
        if (key === "schemaId") return;
        const nextPath = currentPath ? `${currentPath}.${key}` : key;
        parseSchema(subSchema.properties[key], nextPath, subSchema.required || []);
      });
    } else {
  
      //fieldDefinitions[currentPath] = subSchema;
      fieldDefinitions[currentPath] = {
        ...subSchema,

      required:
        requiredFields.includes(
          currentPath.split(".").pop()
        ),

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
  const historicalProps =
  schema.properties?.historicalTelemetry?.properties || {};

 Object.entries(historicalProps).forEach(([field, def]) => {

    historicalBuffers[field] =
      def["x-buffering"]?.interval ?? 5000;

    state.historicalTelemetry[field] = [];
    state.historicalLastSample[field] = 0;
  });
  console.log("FIELD DEFINITIONS:");
  console.log(Object.keys(fieldDefinitions));

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

      if (
        typeof interval === "number" &&
        interval > 0 &&
        interval < min
      ) {
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

    const gcd = intervals.reduce(
      (acc, curr) => calculateNZD(acc, curr)
    );

    return Math.max(gcd, 100);
  }

  function applyClamp() {
    Object.keys(fieldDefinitions).forEach((path) => {
      if (fieldDefinitions[path].type === "number" || fieldDefinitions[path].type === "integer") {
        state[path] = clamp(
          state[path],
          fieldDefinitions[path].minimum ?? -Infinity,
          fieldDefinitions[path].maximum ?? Infinity
        );
      }
    });
  }

  function maybeToggleBoolean() {
    Object.keys(fieldDefinitions).forEach((path) => {
      if (fieldDefinitions[path].type === "boolean" && Math.random() < 0.05) {
        state[path] = !state[path];
      }
    });
  }

  function normalFluctuation() {
    Object.keys(fieldDefinitions).forEach((path) => {
      if (fieldDefinitions[path].type !== "number" && fieldDefinitions[path].type !== "integer") return;

      const min = fieldDefinitions[path].minimum ?? 0;
      const max = fieldDefinitions[path].maximum ?? 100;
      const range = max - min;

      
      const drift = randomBetween(-0.01 * range, 0.01 * range);

      state[path] += (state.baseline[path] - state[path]) * 0.1;
      state[path] += drift;
    });
  }

  function peakFluctuation() {
    Object.keys(fieldDefinitions).forEach((path) => {
      if (fieldDefinitions[path].type !== "number" && fieldDefinitions[path].type !== "integer") return;
      if (path.includes("maintenance") || path.includes("Runtime")) return;
      if (Math.random() > 0.3) return;
      const min = fieldDefinitions[path].minimum ?? 0;
      const max = fieldDefinitions[path].maximum ?? 100;
      const range = max - min;

    
    state[path] += randomBetween(0.05 * range, 0.1 * range);
    state[path] = clamp(state[path], min, max);

    });
  }

  function slowRecovery() {
    Object.keys(fieldDefinitions).forEach((path) => {
      if (fieldDefinitions[path].type !== "number" && fieldDefinitions[path].type !== "integer") return;
      state[path] += (state.baseline[path] - state[path]) * 0.05;
    });
  }

  function maybeShiftBaseline() {
    if (Math.random() < 0.05) {
      Object.keys(fieldDefinitions).forEach((path) => {
        if (fieldDefinitions[path].type !== "number" && fieldDefinitions[path].type !== "integer") return;

        const min = fieldDefinitions[path].minimum ?? 0;
        const max = fieldDefinitions[path].maximum ?? 100;
        const range = max - min;

        let shift = randomBetween(-0.02 * range, 0.02 * range);
        
        if (path.includes("temp") || path.includes("temperature")) {
          state.baseline[path] = clamp(state.baseline[path] + shift, 10, 40);
        } else {
          state.baseline[path] += shift;
        }
      });
      console.log("[GENERATOR] Baseline shift");
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

  if (state.peakCounter === 0 && Math.random() < 0.25) {
    state.peakCounter = Math.floor(randomBetween(5, 10));

    logger.debug(
      `Peak spike event triggered! Wave duration: ${state.peakCounter} cycles.`
    );
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
  applyOperatingProfile();
  applyClamp();

  if (Math.random() < 0.1) {
    state.stableCounter = Math.floor(randomBetween(1, 2));
  }
}

/*function addHistoricalSample() {

  if (!supportsHistoricalTelemetry) return;
  updateDeviceState();
  const sample = { timestamp: new Date().toISOString()};

  Object.keys(fieldDefinitions).forEach(path => {

    if (path === "historicalTelemetry") return;
  
    if (state[path] === undefined) return;
    
    const key = path.replace("telemetry.", "");

    //sample[key] = state[path];
    let value = state[path];

    if (typeof value === "number") {
      value = round(value);
    }

    sample[key] = value;
    
    //setDeepValue(sample, path, state[path]);
  });

  state.historicalTelemetry.push(sample);

  if (state.historicalTelemetry.length > historicalTelemetryMaxItems) {
    state.historicalTelemetry.shift();
  }
}*/
function addHistoricalSample() {

  if (!supportsHistoricalTelemetry) {
    return;
  }

  updateDeviceState();

  const now = Date.now();
  const iso = new Date(now).toISOString();

  Object.keys(historicalBuffers).forEach(field => {

    const path = `telemetry.${field}`;
    const interval = historicalBuffers[field];

    const last =
      state.historicalLastSample[field] ?? 0;

    if (now - last < interval) {
      return;
    }

    let value = state[path];

    if (typeof value === "number") {
      value = round(value);
    }

    if (!state.historicalTelemetry[field]) {
      state.historicalTelemetry[field] = [];
    }

    state.historicalTelemetry[field].push([
      value,
      iso
    ]);

    const maxItems =
      schema.properties.historicalTelemetry.properties[field]
        ?.maxItems ?? 24;

    if (
      state.historicalTelemetry[field].length >
      maxItems
    ) {
      state.historicalTelemetry[field].shift();
    }

    state.historicalLastSample[field] = now;

  });
}
  function applyOperatingProfile() {
    const profile = deviceState.operatingProfile;

    if (!profile) {
      return;
    }
    const maxTemp = profile.safety?.maxTemperature;

    const maxVibration = profile.safety?.maxVibration;

    switch (profile.mode) {

      case "BOOST":
        if (state["performance.output.flow"] !== undefined) {
          state["performance.output.flow"] *= 1.15;
        }

        if (state["performance.electrical.load"] !== undefined) {
          state["performance.electrical.load"] *= 1.10;
        }

        if (state["performance.electrical.kw"] !== undefined) {
          state["performance.electrical.kw"] *= 1.10;
        }

        if (state["performance.stages.p2"] !== undefined) {
          state["performance.stages.p2"] = profile.pressure.target;
        }

        if (state["performance.stages.tempOut"] !== undefined) {
          const maxT = profile.safety.maxTemperature;
          state["performance.stages.tempOut"] = randomBetween(maxT * 0.9, maxT);
        }
        if (state["diagnostics.health.vibration"] !== undefined) {
          const maxV = profile.safety.maxVibration;
          state["diagnostics.health.vibration"] = randomBetween(maxV * 0.9, maxV);
        }


        break;

      case "ECONOMY":
        if (state["performance.output.flow"] !== undefined) {
          state["performance.output.flow"] *= 0.85;
        }

        if (state["performance.electrical.load"] !== undefined) {
          state["performance.electrical.load"] *= 0.80;
        }

        if (state["performance.electrical.kw"] !== undefined) {
          state["performance.electrical.kw"] *= 0.80;
        }

        if (state["performance.stages.p2"] !== undefined) {
          state["performance.stages.p2"] = profile.pressure.target;
        }

        break;

      case "NORMAL":
        if (state["performance.stages.p2"] !== undefined) {
          state["performance.stages.p2"] = profile.pressure.target;
        }

        break;

      default:
        break;
    }

    applyClamp();
  }
 
  function build(mode = "delta") {

  const isFull = mode === "full";
  const isHeartbeat = mode === "heartbeat";

    const payload = {};
   // const schemaId = schema.properties?.schemaId?.const;
   /* if (schemaId) {
      payload.schemaId = schemaId;
    }*/
    const fields = Object.keys(fieldDefinitions);
    const desiredPercentage = isFull? 1.0 : randomBetween(0.1, 0.8); 
    const activeFields = fields.filter(() => Math.random() < desiredPercentage);

   //const activeFields = fields;

    const now = Date.now();
    if (supportsHistoricalTelemetry) {

  const shouldFlush =
    now - state.lastHistoricalFlush >= historicalFlushInterval;

  const hasData =
    Object.values(state.historicalTelemetry)
      .some(arr => arr.length > 0);

  if (shouldFlush && hasData) {

    const historicalPayload = {};

    Object.keys(state.historicalTelemetry)
      .forEach(field => {

        if (state.historicalTelemetry[field].length > 0) {

          historicalPayload[field] = [
            ...state.historicalTelemetry[field]
          ];

          state.historicalTelemetry[field] = [];
        }
      });

    payload.historicalTelemetry =
      historicalPayload;

    logger.debug(
      `[HISTORY] Flushing historical telemetry buffers`
    );

    state.lastHistoricalFlush = now;
  }
}

    Object.keys(fieldDefinitions).forEach((path) => {
   
      const def = fieldDefinitions[path];
      const isRequired = def.required === true;
      const reportingMode = isHeartbeat ? "IDLE" : "ACTIVE";
      if(!isFull && !isRequired){
        const interval = def.reporting[reportingMode];
    
        if (interval == null) {
          return;
        }
        if (state.lastSent[path] && (now - state.lastSent[path] < interval)) {
            return; 
        }
      }
    

      if (!isFull && !isRequired && !activeFields.includes(path) && !isHeartbeat) {
        return;
      }
      if (path.endsWith("ledState")) {
          setDeepValue(
              payload,
              path,
              deviceState.led
          );

          state.lastSent[path] = now;
      }else  if (path.endsWith("ledColor")) {
        setDeepValue(
          payload,
          path,
          deviceState.ledColor
        );

        state.lastSent[path] = now;
      }

      else if (path === "system.status.operatingProfile") {

        setDeepValue(
          payload,
          path,
          deviceState.operatingProfile?.mode || "NORMAL"
        );

        state.lastSent[path] = now;
      }else if (def.enum) {
        const randomEnum = def.enum[Math.floor(Math.random() * def.enum.length)];
        setDeepValue(payload, path, randomEnum);
        state.lastSent[path] = now;
      } else if (def.type === "array") {
       
        const itemsEnum = def.items?.enum;
        const mockArray = itemsEnum && Math.random() > 0.8 ? [itemsEnum[Math.floor(Math.random() * itemsEnum.length)]] : [];
        setDeepValue(payload, path, mockArray);

        state.lastSent[path] = now;
        


    } else if (def.type === "number" || def.type === "integer") {
        let val = state[path];
        if (def.multipleOf) {
          val = Math.round(val / def.multipleOf) * def.multipleOf;
        }

  
        const min = def.minimum ?? -Infinity;
        const max = def.maximum ?? Infinity;
        val = Math.min(Math.max(val, min), max);

        
        state[path] = val; 

      
        const finalValue = def.type === "integer" 
        ? Math.round(val) 
        : Math.round(val * 10) / 10;
        
        
        setDeepValue(payload, path, finalValue);

        state.lastSent[path] = now;
      }else if (def.type === "boolean") {
        setDeepValue(payload, path, state[path]);
        state.lastSent[path] = now;
      } else if (def.type === "string") {

      if (def.pattern) {
          setDeepValue(payload, path, generateFromPattern(def.pattern));

          state.lastSent[path] = now;

        } else if (path.toLowerCase().includes("firmware") || path.toLowerCase().includes("version")) {
          
          setDeepValue(payload, path, "v1.0.0-release");
          state.lastSent[path] = now;

        } else if (path.toLowerCase().includes("serial")) {
          setDeepValue(payload, path, "INV-2026-XAE412");
          state.lastSent[path] = now;

        }else if (path.includes("errorCode")) {
          setDeepValue(payload, path, "0x0000");
          state.lastSent[path] = now;

        }else {
          setDeepValue(payload, path, "OPERATIONAL");
          state.lastSent[path] = now;

        }
      }
    });

    
    if (Object.keys(payload).length === 0) {
      return null;
    }

    const schemaId = schema.properties?.schemaId?.const;
    if (schemaId) {
      payload.schemaId = schemaId;
    }

    return payload;
  }
  
  function generateHeartbeat() {
    return build("heartbeat");
  }

  function setForceFull(val) {
    nextIsFull = val;
  }

  function generate() {
    state.cycleCounter++; 

    
    const isFiveMinuteMark = state.cycleCounter >= 300; 

    if (isFiveMinuteMark) {
      state.cycleCounter = 0; 
      return build("full"); 
    }

    if (state.stableCounter > 0) {
      state.stableCounter--;
      return build("delta");
    }

   /* if (state.peakCounter === 0 && Math.random() < 0.25) {
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
    applyOperatingProfile();
    applyClamp();

    if (Math.random() < 0.1) {
      state.stableCounter = Math.floor(randomBetween(1, 2));
    }
      */
     updateDeviceState();
    if(nextIsFull){
      nextIsFull=false;
      return build("full");
    }

    return build("delta");
  }

  return {
    generate,generateHeartbeat,addHistoricalSample,setForceFull, getMinimumInterval, getOptimalTick, getOptimalHistoricalBufferTick
  };
}

module.exports = {
  createTelemetryGenerator,
};