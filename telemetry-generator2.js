function createTelemetryGenerator(schema) {

  // =========================
  // DETEKCIJA MODELA
  // =========================

  const isModelA = !!schema.properties.telemetry;
  const isModelB = !!schema.properties.data;
  const isModelC = !!schema.properties.metrics;

  let properties = {};

  if (isModelA) {
    properties = schema.properties.telemetry.properties;
  }

  if (isModelB) {
    const dataProps = schema.properties.data.properties;
    const statusProps = schema.properties.status.properties;

    properties = {
      temperature: dataProps.temp,
      humidity: dataProps.hum,
      pressure: dataProps.press,
      led: statusProps.ledState
    };
  }

  if (isModelC) {
    const env = schema.properties.metrics.properties.environment.properties;
    const deviceStatus = schema.properties.device.properties.status.properties;
    const battery = schema.properties.device.properties.battery.properties;

    properties = {
      temperature: env.temperature,
      humidity: env.humidity,
      pressure: env.pressure,
      led: deviceStatus.led,
      batteryLevel: battery.level
    };
  }

  // =========================
  // STATE
  // =========================

  const state = {
    stableCounter: 0,
    peakCounter: 0,
    baseline: {},
  };

  Object.keys(properties).forEach((key) => {
    if (properties[key].type === "number") {
      const min = properties[key].minimum ?? 0;
      const max = properties[key].maximum ?? 100;

      const start = (min + max) / 2;

      state[key] = start;
      state.baseline[key] = start;
    } else if (properties[key].type === "boolean") {
      state[key] = false;
    }

    if (key === "batteryLevel") {
      state[key] = 80;
      state.baseline[key] = 80;
    }
  });

  // =========================
  // UTIL
  // =========================

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
    Object.keys(properties).forEach((key) => {
      if (properties[key].type === "number") {
        state[key] = clamp(
          state[key],
          properties[key].minimum ?? -Infinity,
          properties[key].maximum ?? Infinity
        );
      }
    });
  }

  function maybeToggleBoolean() {
    Object.keys(properties).forEach((key) => {
      if (properties[key].type === "boolean" && Math.random() < 0.05) {
        state[key] = !state[key];
      }
    });
  }

  // =========================
  // BEHAVIOR
  // =========================

  function normalFluctuation() {
    Object.keys(properties).forEach((key) => {
      if (properties[key].type !== "number") return;

      const min = properties[key].minimum ?? 0;
      const max = properties[key].maximum ?? 100;
      const range = max - min;

      const drift =
        key === "pressure"
          ? randomBetween(-0.003 * range, 0.003 * range)
          : randomBetween(-0.01 * range, 0.01 * range);

      state[key] += (state.baseline[key] - state[key]) * 0.1;
      state[key] += drift;
    });
  }

  function peakFluctuation() {
    Object.keys(properties).forEach((key) => {
      if (properties[key].type !== "number") return;

      const range =
        (properties[key].maximum ?? 100) - (properties[key].minimum ?? 0);

      if (key === "humidity") {
        state[key] -= randomBetween(0.02 * range, 0.05 * range);
      } else if (key === "temperature") {
        state[key] += randomBetween(0.03 * range, 0.07 * range);
      } else if (key === "pressure") {
        state[key] += randomBetween(0.02 * range, 0.04 * range);
      }
    });
  }

  function slowRecovery() {
    Object.keys(properties).forEach((key) => {
      if (properties[key].type !== "number") return;

      state[key] += (state.baseline[key] - state[key]) * 0.05;
    });
  }

  function maybeShiftBaseline() {
    if (Math.random() < 0.05) {
      Object.keys(properties).forEach((key) => {
        if (properties[key].type !== "number") return;

        const range =
          (properties[key].maximum ?? 100) - (properties[key].minimum ?? 0);

        state.baseline[key] += randomBetween(
          -0.03 * range,
          0.03 * range
        );
      });

      console.log("[GENERATOR] Baseline shift");
    }
  }

  // =========================
  // BUILD
  // =========================

  function build() {

    if (isModelA) {
      const telemetry = {};

      Object.keys(properties).forEach((key) => {
        telemetry[key] =
          properties[key].type === "number"
            ? round(state[key])
            : state[key];
      });

      return { telemetry };
    }

    
    if (isModelB) {
      return {
        data: {
          temp: round(state.temperature),
          hum: round(state.humidity),
          press: round(state.pressure)
        },
        status: {
          ledState: state.led
        }
      };
    }

    
    if (isModelC) {
      return {
        metrics: {
          environment: {
            temperature: round(state.temperature),
            humidity: round(state.humidity),
            pressure: round(state.pressure)
          }
        },
        device: {
          status: {
            led: state.led,
            mode: Math.random() > 0.5 ? "AUTO" : "MANUAL"
          },
          battery: {
            level: round(state.batteryLevel),
            charging: Math.random() < 0.3
          }
        }
      };
    }
  }

  // =========================
  // GENERATE
  // =========================

  function generate() {

    if (state.stableCounter > 0) {
      state.stableCounter--;
      return build();
    }

    if (state.peakCounter === 0 && Math.random() < 0.12) {
      state.peakCounter = Math.floor(randomBetween(3, 6));
      console.log("[GENERATOR] Peak event");
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

    if (Math.random() < 0.3) {
      state.stableCounter = Math.floor(randomBetween(1, 4));
    }

    return build();
  }

  return {
    generate,
  };
}

module.exports = {
  createTelemetryGenerator,
};
