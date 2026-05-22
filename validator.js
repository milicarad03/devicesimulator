const fs = require("fs");
const Ajv = require("ajv/dist/2020");

function validateConfig(configPath, schemaPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

  const ajv = new Ajv({ allErrors: true });

  const validate = ajv.compile(schema);

  const isValid = validate(config);

  if (!isValid) {
    console.error(" [VALIDATOR] Greška pri startovanju! Konfiguracioni fajl nije ispravan:");

    validate.errors.forEach((err) => {
      const field = err.instancePath || "koren (root)";
      console.error(`   - Polje '${field}' ${err.message}`);
    });

    process.exit(1);
  }

  console.log("[VALIDATOR] Konfiguracioni fajl je uspešno prošao JSON Schema validaciju.");
  return config;
}

module.exports = validateConfig;