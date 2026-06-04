const fs = require("fs");
const mqtt = require("mqtt");

const DEVICE_NAME = process.argv[2];

if (!DEVICE_NAME) {
  console.error(" Moraš proslediti device name (device1 ili device2)");
  process.exit(1);
}

// =========================
// CONFIG
// =========================

const DEVICE_CONFIG = {
  device1: {
    topic: "iot/devices/device-1/telemetry",
    schema: "./schema/modelA/v1.schema.json",
  },
  device2: {
    topic: "iot/devices/device-2/telemetry",
    schema: "./schema/modelB/v1.schema.json",
  },
};

const BROKER_URL = "mqtt://localhost:1883";
const INTERVAL_MS = 2000;

// =========================
// LOAD GENERATOR
// =========================

const { createTelemetryGenerator } = require("./telemetry-generator2");

const config = DEVICE_CONFIG[DEVICE_NAME];

if (!config) {
  console.error(" Nepoznat device:", DEVICE_NAME);
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(config.schema, "utf8"));

const baseGenerator = createTelemetryGenerator(schema);

// =========================
// FAULT GENERATOR
// =========================

function createFaultyGenerator(base) {
  return {
    generate() {
      let msg = base.generate();

      if (Math.random() < 0.4) {
        const type = Math.floor(Math.random() * 5);

        switch (type) {
          
          case 0:
            if (msg.data) {
              msg.data.temp = "BAD_VALUE";
              console.log(" WRONG TYPE injected");
            }
            if (msg.telemetry) {
              msg.telemetry.temperature = "BAD_VALUE";
              console.log(" WRONG TYPE injected");
            }
            break;

       
          case 1:
            if (msg.data) {
              msg.data.hum = 999;
              console.log(" OUT OF RANGE injected");
            }
            if (msg.telemetry) {
              msg.telemetry.humidity = 999;
              console.log(" OUT OF RANGE injected");
            }
            break;

         
          case 2:
            if (msg.data) {
              delete msg.data.press;
              console.log("MISSING FIELD injected");
            }
            if (msg.telemetry) {
              delete msg.telemetry.pressure;
              console.log(" MISSING FIELD injected");
            }
            break;

         
          case 3:
            if (msg.data) {
              msg.data.extra = "???";
              console.log(" EXTRA FIELD injected");
            }
            if (msg.telemetry) {
              msg.telemetry.extra = "???";
              console.log(" EXTRA FIELD injected");
            }
            break;

          
          case 4:
            msg.data = null;
            console.log(" BROKEN STRUCTURE injected");
            break;
        }
      }

      return msg;
    },
  };
}

const faultyGenerator = createFaultyGenerator(baseGenerator);

// =========================
// MQTT
// =========================

const client = mqtt.connect(BROKER_URL);

client.on("connect", () => {
  console.log(" Connected to MQTT broker");
  console.log(" Faulty simulator started for:", DEVICE_NAME);

  setInterval(() => {
    const msg = faultyGenerator.generate();

    client.publish(config.topic, JSON.stringify(msg), { qos: 1 });

    console.log("\n SENT:");
    console.log(JSON.stringify(msg, null, 2));
  }, INTERVAL_MS);
});

client.on("error", (err) => {
  console.error("MQTT error:", err.message);
});
``