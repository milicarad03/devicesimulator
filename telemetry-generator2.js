class GeneratorLogger {
  debug(message) {
    if (global.simulatorLogger) {
      global.simulatorLogger.debug(`[TelemetryGenerator] ${message}`);
    }
  }
}
const logger = new GeneratorLogger();



function createTelemetryGenerator(schema) {

  // =========================
  // DETEKCIJA MODELA
  // =========================
  const isModelE = !!schema.properties.gridQualityIndex || !!schema.properties.stringStatus; 


  const isModelA = !!schema.properties.telemetry && !isModelE;
  const isModelB = !!schema.properties.data;
  const isModelC = !!schema.properties.metrics && !!schema.properties.device?.properties?.status?.properties?.led;
  const isModelD = !!schema.properties.networkSignalDb || !!schema.properties.firmwareVersion; 


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
  if (isModelD) {
    properties = schema.properties;
  }

  if (isModelE) {
    
  }
  
  



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



  function build() {
     if (isModelE) {
    
      const pvVolt = round(randomBetween(500, 800));
      const pvCurr = round(randomBetween(5, 18));
      const powerProduced = round(pvVolt * pvCurr);
      
      const soc = round(randomBetween(20, 95));
      const cabTemp = round(randomBetween(35, 55));
      
      
      let chargeDir = "STAGNANT";
      if (powerProduced > 5000) chargeDir = "CHARGING";
      if (powerProduced < 2000) chargeDir = "DISCHARGING";

      const opMode = cabTemp > 75 ? "FAULT_ISOLATION" : (powerProduced > 500 ? "GRID_TIED" : "STANDBY");
      const fanStatus = cabTemp > 45 ? "ACTIVE_HIGH" : "ACTIVE_LOW";
      const gridSwitchState = opMode === "FAULT_ISOLATION" ? "OFF" : "ON";
      const pvStatus = powerProduced > 4000 ? "OPTIMAL" : "SHADED";

      return {
        device: {
          hardware: {
            serialNumber: "INV-2026-XAE412",
            firmware: "v5.4.1-patch3"
          },
          status: {
            operationalMode: opMode,
            gridSwitch: gridSwitchState,
            uptimeSeconds: Math.floor(process.uptime())
          },
          safety: {
            surgeProtectorEngaged: Math.random() > 0.98, 
            coolingStatus: fanStatus
          }
        },
        telemetry: {
          pv_panels: {
            dcVoltage: pvVolt,
            dcCurrent: pvCurr,
            stringStatus: pvStatus
          },
          battery: {
            soc: soc,
            soh: 96.4,
            chargeDirection: chargeDir,
            cycles: 184
          },
          grid_output: {
            phaseA_voltage: round(randomBetween(225, 235)),
            frequencyHz: round(randomBetween(49.9, 50.1)),
            totalActivePowerW: round(powerProduced * 0.95), // Gubitak kroz efikasnost
            gridQualityIndex: "EXCELLENT"
          },
          environment: {
            cabinetTemp: cabTemp,
            fanSpeedRpm: cabTemp > 45 ? 4200 : 1800,
            efficiency: round(randomBetween(94.5, 97.2))
          }
        }
      };
    }

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
    if (isModelD) { 
      const flatTelemetry = {};
      Object.keys(properties).forEach((key) => {
        if (properties[key].enum) {
          flatTelemetry[key] = properties[key].enum[0];
        } else if (properties[key].type === "array") {
          flatTelemetry[key] = Math.random() > 0.7 && properties[key].items?.enum 
            ? [properties[key].items.enum[Math.floor(Math.random() * properties[key].items.enum.length)]]
            : [];
        } else {
          flatTelemetry[key] = properties[key].type === "number" ? round(state[key]) : state[key];
        }
      });

      return {
        device: {
          info: { firmware: flatTelemetry.firmwareVersion || "v1.0.0-release" },
          state: { 
            status: flatTelemetry.systemStatus || "RUNNING", 
            maintenanceCountdown: flatTelemetry.maintenanceCountdown 
          },
          diagnostics: { 
            errorCode: flatTelemetry.errorCode || "0x0000", 
            activeAlarms: flatTelemetry.activeAlarms 
          },
          network: { signalDb: flatTelemetry.networkSignalDb }
        },
        metrics: {
          compressor: { frequency: flatTelemetry.compressorFrequency },
          fluid: { 
            coolantLevel: flatTelemetry.coolantLevel, 
            returnTemp: flatTelemetry.returnLiquidTemp, 
            flowRate: flatTelemetry.flowRate 
          },
          actuators: { valvePosition: flatTelemetry.valvePosition },
          mechanical: { 
            vibrationIndex: flatTelemetry.vibrationIndex, 
            pumpRuntime: flatTelemetry.pumpRuntimeHours 
          },
          electrical: { 
            powerFactor: flatTelemetry.powerFactor, 
            totalEnergyKwh: flatTelemetry.totalEnergyKwh 
          },
          pressure: { 
            discharge: flatTelemetry.dischargePressure, 
            suction: flatTelemetry.suctionPressure, 
            oilStatus: flatTelemetry.oilPressureStatus || "NORMAL" 
          }
        }
      };
    }
   
  }

 

  function generate() {

    if (state.stableCounter > 0) {
      state.stableCounter--;
      return build();
    }

    if (state.peakCounter === 0 && Math.random() < 0.12) {
      state.peakCounter = Math.floor(randomBetween(3, 6));
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
