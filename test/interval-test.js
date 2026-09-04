const fs = require("fs");
const path = require("path");

const { createTelemetryGenerator } = require("../telemetry-generator3");

const MODEL = process.argv[2] || "modelB";
const SCHEMA_FILE = path.join(
  __dirname,
  `../schema/${MODEL}/v1.schema.json`
);

const schema = JSON.parse(
  fs.readFileSync(SCHEMA_FILE, "utf8")
);

const generator = createTelemetryGenerator(schema);

const expectedIntervals = {};
const lastSeen = {};

const TOLERANCE_MS = 50;
const MAX_ITERATIONS = 40;

function collectIntervals(schemaNode, currentPath = "") {
  if (!schemaNode || typeof schemaNode !== "object") {
    return;
  }

  if (
    schemaNode.type === "object" &&
    schemaNode.properties
  ) {
    Object.entries(schemaNode.properties)
      .forEach(([key, value]) => {

        if (key === "schemaId") {
          return;
        }

        const nextPath = currentPath
          ? `${currentPath}.${key}`
          : key;

        collectIntervals(value, nextPath);
      });

    return;
  }

  const reporting = schemaNode["x-reporting"];

  if (
    reporting &&
    typeof reporting.ACTIVE === "number"
  ) {
    expectedIntervals[currentPath] =
      reporting.ACTIVE;
  }
}

collectIntervals(schema);

const tick = generator.getOptimalTick("ACTIVE");

console.log(
  `Running interval test for ${MODEL} (tick=${tick}ms)`
);

function getValueByPath(obj, pathStr) {
  return pathStr
    .split(".")
    .reduce(
      (current, part) =>
        current && current[part] !== undefined
          ? current[part]
          : undefined,
      obj
    );
}


function checkField(field) {
  const now = Date.now();

  if (lastSeen[field]) {
    const diff = now - lastSeen[field];
    const expected = expectedIntervals[field];

    if (
      diff <
      expected - TOLERANCE_MS
    ) {
      throw new Error(
        `[FAILED] ${field} sent after ${diff}ms ` +
        `(expected >= ${expected}ms)`
      );
    }

    console.log(
      `[OK] ${field} sent after ${diff}ms ` +
      `(expected >= ${expected}ms)`
    );
  }

  lastSeen[field] = now;
}

function inspectPayload(payload) {
  Object.keys(expectedIntervals)
    .forEach((field) => {

      const value =
        getValueByPath(payload, field);

    if (value !== undefined) {
      checkField(field);
    }
    });
}

let iterations = 0;

const timer = setInterval(() => {
  const payload = generator.generate();

  inspectPayload(payload);

  iterations++;

  if (iterations >= MAX_ITERATIONS) {

    clearInterval(timer);

    console.log("");
    console.log(
      "================================="
    );
    console.log(
      `TEST PASSED (${MODEL})`
    );
    console.log(
      "No interval violations detected"
    );
    console.log(
      "================================="
    );

    process.exit(0);
  }
}, tick);

process.on("SIGINT", () => {
  clearInterval(timer);

  console.log(
    "\nTest interrupted by user."
  );

  process.exit(0);
});
