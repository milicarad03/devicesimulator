const fs = require("fs");

async function main() {
  const csrPem = fs.readFileSync(
    "./certs/device/operational-device.csr",
    "utf8"
  );

  const factoryDeviceCertPem = fs.readFileSync(
    "./certs/device/factory-device.crt",
    "utf8"
  );

  const factoryProofBase64 = fs.readFileSync(
    "./certs/device/factory-proof.sig"
  ).toString("base64");

  const response = await fetch("http://localhost:3000/device-certificates/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      deviceId: "sn-100",
      csrPem,
      factoryDeviceCertPem,
      factoryProofBase64,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Registration failed: ${response.status} ${error}`);
  }

  const result = await response.json();

  fs.writeFileSync(
    "./certs/device/operational-device.crt",
    result.operationalDeviceCertPem
  );

  fs.writeFileSync(
    "./certs/device/operational-ca.crt",
    result.operationalCaCertPem
  );

  console.log("[DEVICE] Registration successful");
  console.log("[DEVICE] Saved operational-device.crt");
  console.log("[DEVICE] Saved operational-ca.crt");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});