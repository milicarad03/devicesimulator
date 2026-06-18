const mqtt = require('mqtt');
const fs = require('fs');

const client = mqtt.connect('mqtt://localhost:1883');
const LOG_FILE = 'dummy_traffic_delta_MODELF1.log';


const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

client.on('connect', () => {
  console.log("Dummy listener active. Listening for telemetry...");
  client.subscribe('iot/devices/+/telemetry'); 
});

client.on('message', (topic, payload) => {

  stream.write(`${Date.now()}|${Buffer.byteLength(payload)}\n`);
});


process.on('SIGINT', () => {
  console.log("\nClosing stream gracefully...");
  stream.end(); 
  process.exit();
});