const fs = require("fs");
const path = require("path");
const { createTelemetryGenerator: createDeltaGenerator } = require('./telemetry-generator3');
const { createTelemetryGenerator: createFullGenerator } = require('./tel-gen3');

const modelsToTest = ["modelF", "modelB"];
const results = {};

for (const model of modelsToTest) {
    const SCHEMA_FILE = path.join(__dirname, "schema", model, "v1.schema.json");
    
    if (!fs.existsSync(SCHEMA_FILE)) continue;

    const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
    const deltaGen = createDeltaGenerator(schema);
    const fullGen = createFullGenerator(schema);

    let totalDelta = 0;
    let totalFull = 0;

    for (let i = 0; i < 100; i++) {
        totalDelta += JSON.stringify(deltaGen.generate()).length;
        totalFull += JSON.stringify(fullGen.generate()).length;
    }

    results[model] = {
        avgDeltaSize: (totalDelta / 100).toFixed(2),
        avgFullSize: (totalFull / 100).toFixed(2),
        saving: ((1 - totalDelta / totalFull) * 100).toFixed(2) + '%'
    };
}

console.table(results);
fs.writeFileSync('comparison_report.json', JSON.stringify(results, null, 2));