
const fs = require("fs");
const path = require("path");


const { createTelemetryGenerator: createDeltaGenerator } = require('./telemetry-generator3');
const { createTelemetryGenerator: createFullGenerator } = require('./tel-gen3'); 
const MODEL_ARG = "modelF"; 
const VERSION_ARG = "v1"; 

const SCHEMA_FILE = path.join(__dirname, "schema", MODEL_ARG, `${VERSION_ARG}.schema.json`);

if (!fs.existsSync(SCHEMA_FILE)) {
    console.error(`Greška: Ne mogu da nađem šemu na putanji: ${SCHEMA_FILE}`);
    process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
const deltaGen = createDeltaGenerator(schema);
const fullGen = createFullGenerator(schema);

const logs = [];

for (let i = 0; i < 100; i++) {
  const delta = deltaGen.generate();
  const full = fullGen.generate();

  const deltaSize = JSON.stringify(delta).length;
  const fullSize = JSON.stringify(full).length;

  logs.push({
    deviceId: `device-${i}`,
    deltaSize,
    fullSize,
    saving: ((1 - deltaSize / fullSize) * 100).toFixed(2) + '%'
  });
}

fs.writeFileSync('bandwidth_log1.json', JSON.stringify(logs, null, 2));
console.log("Test završen! Rezultati su u bandwidth_log.json");