const telemetryGeneratorState = {
  temperature: 23.5,
  humidity: 45,
  pressure: 1010,
  led: false,

  stableCounter: 0,
  peakCounter: 0,
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function round(value, decimals = 1) {
  return Number(value.toFixed(decimals));
}

function maybeToggleLed() {
  if (Math.random() < 0.08) {
    telemetryGeneratorState.led = !telemetryGeneratorState.led;
  }
}

function generateTelemetryMessage() {
  if (telemetryGeneratorState.stableCounter > 0) {
    telemetryGeneratorState.stableCounter--;

    return {
      telemetry: {
        temperature: round(telemetryGeneratorState.temperature),
        humidity: round(telemetryGeneratorState.humidity),
        pressure: round(telemetryGeneratorState.pressure),
        led: telemetryGeneratorState.led,
      },
    };
  }

  if (telemetryGeneratorState.peakCounter === 0 && Math.random() < 0.08) {
    telemetryGeneratorState.peakCounter = 3;
    console.log("[GENERATOR] Peak event started");
  }

  if (telemetryGeneratorState.peakCounter > 0) {
    telemetryGeneratorState.temperature += randomBetween(2.5, 5.5);
    telemetryGeneratorState.pressure += randomBetween(3, 8);
    telemetryGeneratorState.humidity -= randomBetween(1, 4);

    telemetryGeneratorState.peakCounter--;
  } else {
    telemetryGeneratorState.temperature += randomBetween(-0.4, 0.4);
    telemetryGeneratorState.humidity += randomBetween(-1.2, 1.2);
    telemetryGeneratorState.pressure += randomBetween(-1.5, 1.5);
  }

  maybeToggleLed();

  if (telemetryGeneratorState.temperature > 32) {
    telemetryGeneratorState.temperature -= randomBetween(0.5, 1.5);
  }

  telemetryGeneratorState.temperature = clamp(
    telemetryGeneratorState.temperature,
    -50,
    100
  );

  telemetryGeneratorState.humidity = clamp(
    telemetryGeneratorState.humidity,
    0,
    100
  );

  telemetryGeneratorState.pressure = clamp(
    telemetryGeneratorState.pressure,
    300,
    1200
  );

  if (Math.random() < 0.25) {
    telemetryGeneratorState.stableCounter = Math.floor(randomBetween(1, 4));
  }

  return {
    telemetry: {
      temperature: round(telemetryGeneratorState.temperature),
      humidity: round(telemetryGeneratorState.humidity),
      pressure: round(telemetryGeneratorState.pressure),
      led: telemetryGeneratorState.led,
    },
  };
}

module.exports = {
  generateTelemetryMessage,
};