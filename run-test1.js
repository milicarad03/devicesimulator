const fs = require('fs');
const mqtt = require('mqtt');

const LOG_FILE = 'dummy_traffic_delta_MODELF1.log';
const READY_FILE = 'listener.ready';


try { fs.unlinkSync(READY_FILE); } catch (e) {}

const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const client = mqtt.connect('mqtt://localhost:1883');

client.on('connect', () => {
  console.log('Dummy listener active. Listening for telemetry...');
  client.subscribe('iot/devices/+/telemetry', (err) => {
    if (err) {
      console.error('Subscribe failed:', err.message);
      return;
    }
    
    fs.writeFileSync(READY_FILE, 'ready');
  });
});

client.on('error', (err) => {
  console.error('MQTT connection error:', err.message);
});

client.on('message', (topic, payload) => {
  stream.write(`${Date.now()}|${Buffer.byteLength(payload)}\n`);
});

function shutdown() {
  console.log('\nClosing stream gracefully...');
  client.end(true, {}, () => {
    stream.end(() => {
      try { fs.unlinkSync(READY_FILE); } catch (e) {}
      process.exit(0);
    });
  });
}


process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);