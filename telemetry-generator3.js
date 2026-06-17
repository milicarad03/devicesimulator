class GeneratorLogger {
  debug(message) {
    if (global.simulatorLogger) {
      global.simulatorLogger.debug(`[TelemetryGenerator] ${message}`);
    }
  }
}
const logger = new GeneratorLogger();

function createTelemetryGenerator(schema) {
  let nextIsFull=true;
  const state = {
    stableCounter: 0,
    peakCounter: 0,
    baseline: {},
    cycleCounter: 0,
  };

  const fieldDefinitions = {};

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

  function parseSchema(subSchema, currentPath = "") {
    if (!subSchema || typeof subSchema !== "object") return;

    if (subSchema.type === "object" && subSchema.properties) {
      Object.keys(subSchema.properties).forEach((key) => {
        if (key === "schemaId") return;
        const nextPath = currentPath ? `${currentPath}.${key}` : key;
        parseSchema(subSchema.properties[key], nextPath);
      });
    } else {
  
      fieldDefinitions[currentPath] = subSchema;

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

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
  }

  function round(value) {
    return Number(value.toFixed(1));
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

        //state.baseline[path] += randomBetween(-0.02 * range, 0.02 * range);
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

 
  function build(forceFull = false) {
    const payload = {};
    const schemaId = schema.properties?.schemaId?.const;
    if (schemaId) {
      payload.schemaId = schemaId;
    }

    Object.keys(fieldDefinitions).forEach((path) => {


      const isRequired = path.includes("status") || path === "schemaId";

      if ( !forceFull && !isRequired && Math.random() < 0.5) {
        return; 
      }
      const def = fieldDefinitions[path];

      if (def.enum) {
        const randomEnum = def.enum[Math.floor(Math.random() * def.enum.length)];
        setDeepValue(payload, path, randomEnum);
      } else if (def.type === "array") {
       
        const itemsEnum = def.items?.enum;
        const mockArray = itemsEnum && Math.random() > 0.8 ? [itemsEnum[Math.floor(Math.random() * itemsEnum.length)]] : [];
        setDeepValue(payload, path, mockArray);

    } else if (def.type === "number" || def.type === "integer") {
        let val = state[path];

        
        if (def.multipleOf) {
          val = Math.round(val / def.multipleOf) * def.multipleOf;
        }

  
        const min = def.minimum ?? -Infinity;
        const max = def.maximum ?? Infinity;
        val = Math.min(Math.max(val, min), max);

        
        state[path] = val; 

      
        //const finalValue = def.type === "integer" ? Math.round(val) : Number(val.toFixed(1));
        const finalValue = def.type === "integer" 
        ? Math.round(val) 
        : Math.round(val * 10) / 10;
        
        
        setDeepValue(payload, path, finalValue);
      }else if (def.type === "boolean") {
        setDeepValue(payload, path, state[path]);
      } else if (def.type === "string") {

      if (def.pattern) {
          setDeepValue(payload, path, generateFromPattern(def.pattern));
        } else if (path.toLowerCase().includes("firmware") || path.toLowerCase().includes("version")) {
          setDeepValue(payload, path, "v1.0.0-release");
        } else if (path.toLowerCase().includes("serial")) {
          setDeepValue(payload, path, "INV-2026-XAE412");
        }else if (path.includes("errorCode")) {
          setDeepValue(payload, path, "0x0000");
        }else {
          setDeepValue(payload, path, "OPERATIONAL");
        }
      }
    });

    return payload;
  }
  function setForceFull(val) {
    nextIsFull = val;
  }

  function generate() {
    state.cycleCounter++; 

    
    const isFiveMinuteMark = state.cycleCounter >= 300; 

    if (isFiveMinuteMark) {
      state.cycleCounter = 0; 
      return build(true); 
    }

    if (state.stableCounter > 0) {
      state.stableCounter--;
      return build(false);
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
    if(nextIsFull){
      nextIsFull=false;
      return build(true);
    }

    return build(false);
  }

  return {
    generate,setForceFull
  };
}

module.exports = {
  createTelemetryGenerator,
};