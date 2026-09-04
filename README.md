# IoT Device Simulator

This Node.js simulator loads a model's JSON Schema, generates full or partial
telemetry, and exchanges status, attributes, commands, and responses through
MQTT or the experimental CoAP adapter. The same `sim.js` entry point is used
for manual operation, E2E tests, the three-device launcher, and the 100-device
fleet demo.

## Prerequisites

- Node.js and npm;
- Mosquitto or another MQTT broker on `mqtt://localhost:1883`;
- a schema file at `schema/<model>/<version>.schema.json`;
- OpenSSL when generating device certificates.

```bash
npm install
```

## Run one MQTT device

```bash
node sim.js <deviceId> <model> <version>
```

Example:

```bash
node sim.js sp-100 modelC 1.1.4
```

Useful environment variables:

```dotenv
MQTT_BROKER_URL=mqtt://localhost:1883
TRANSPORT=mqtt
DEVICE_HEARTBEAT_INTERVAL_MS=15000
LOG_LEVEL=info
SKIP_CERT=true
REGISTRATION_URL=http://localhost:3000/device-certificates/register
TELEMETRY_STATS_FILE=/tmp/device-telemetry.log
SIMULATOR_ERROR_LOG_FILE=/tmp/device-error.log
```

`SKIP_CERT=true` is intended only for controlled local tests. Operational
simulation can use certificate registration and the generated device material.

## Transport selection

`sim.js` calls the transport factory after reading configuration. With
`TRANSPORT=mqtt`, the returned `client` is an MQTT client. With
`TRANSPORT=coap`, it is a `CoapClientAdapter` that exposes the MQTT-like methods
used by the existing lifecycle and command code:

```text
on("connect")
subscribe(topic)
publish(topic, payload)
on("message")
end()
```

This interface allows the telemetry generator, command processor, status
lifecycle, and schema loading to remain the same for both protocols.

## CoAP mode

Enable CoAP in the backend first, then run a simulator with a unique command
port:

```bash
TRANSPORT=coap \
COAP_BACKEND_URL=coap://127.0.0.1:5683 \
COAP_COMMAND_HOST=127.0.0.1 \
COAP_COMMAND_PORT=5684 \
node sim.js coap-led-1 modelA 1.0.2
```

Set `COAP_ADVERTISED_HOST` only when the backend must use an address different
from the local listen address. Every simultaneously running CoAP simulator must
have a different `COAP_COMMAND_PORT`.

The adapter translates logical publish topics into CoAP requests. Telemetry,
attributes, and status become confirmable `POST` requests to the backend. The
backend sends a command to the simulator's `/commands` endpoint, and the
matching JSON response returns directly in that same request/response exchange.
CoAP Observe is not used.

When the shared command processor finishes, it still calls
`client.publish(responseTopic, payload)`. In MQTT mode this creates a new MQTT
message. In CoAP mode the adapter recognizes the logical response topic and
uses the payload to complete the open `/commands` request with a `2.05`
response. The logical topic exists only to reuse the command processor.

Large `STAGE_MODEL_VERSION` commands use standard CoAP Block1 transfer.
`node-coap` reassembles the blocks into `request.payload`. The adapter enforces
a 64 KB total payload limit before forwarding parsed JSON to the shared command
handler. This avoids increasing a single UDP datagram beyond a safe size.

The experiment does not use DTLS and is intended for local comparison only.

## MQTT topics

Device `sp-100` uses:

```text
iot/devices/sp-100/commands
iot/devices/sp-100/response
iot/devices/sp-100/status
iot/devices/sp-100/telemetry
iot/devices/sp-100/attributes
```

Status and attributes are retained. Telemetry is not retained. The MQTT
connection defines a retained Last Will with `offline` status, allowing the
broker to report an unexpected process or network loss.

## Device lifecycle

1. Load the model schema.
2. Create the selected transport client.
3. Subscribe to the logical command topic.
4. Publish `online` status and a complete attribute snapshot.
5. Refresh `online` presence periodically; the default interval is 15 seconds.
6. Remain telemetry-silent in `IDLE`, while presence heartbeat stays active.
7. Start reporting timers after `SET_STATE/ACTIVE`.
8. Stop telemetry timers after `SET_STATE/IDLE`.
9. On `SIGINT`, publish `offline`, close the transport, and exit cleanly.

`DEVICE_HEARTBEAT_INTERVAL_MS=0` disables status heartbeat. Use it only in a
specific timeout test because the backend may mark the device `OFFLINE` after
the configured presence timeout.

State command example:

```json
{
  "command": "SET_STATE",
  "payload": { "state": "ACTIVE" },
  "correlationId": "optional-request-id"
}
```

The response includes the command name, success flag, current state, and the
same correlation ID when one was supplied.

## Attributes

Attributes are published separately from telemetry:

```json
{
  "serialNumber": "sp-100",
  "firmware": "1.1.4",
  "hardwareModel": "modelC"
}
```

This is a complete, relatively static identity and configuration snapshot. The
backend validates it against `properties.attributes` in the active schema and
stores the latest state. Telemetry messages do not contain an `attributes`
field.

## Telemetry generation

The generator reads model metadata:

- `x-reporting` defines field intervals in `ACTIVE` and `IDLE` states;
- fields that are not due are omitted from a partial message;
- a complete message is emitted periodically;
- `x-buffering.interval` groups historical samples;
- each model may define different fields, types, ranges, and commands.

Message time and size may be written to `TELEMETRY_STATS_FILE`.

## Model-version change

`STAGE_MODEL_VERSION` validates and stores a new schema and mapping package in
`staged/`. `RESTART_WITH_MODEL_VERSION` verifies the staged model, version,
schema ID, mapping, and correlation ID, then exits cleanly so the next start
uses the new version.

## Three-device launcher

```bash
npm run sim:three
```

The launcher starts separate `sim.js` processes for `modelA`, `modelB`, and
`modelC`, stores their PIDs and output, and shuts down only its own children. It
sends `SIGINT` first and uses `SIGKILL` only when a process does not exit within
the configured deadline.

## Fleet certificates

`fleet/devices-100.json` is the source of device IDs for certificate generation
and the demo launcher.

```bash
npm run fleet:certificates -- --dry-run
npm run fleet:certificates
```

Generation is sequential so multiple OpenSSL processes do not write the CA
serial file concurrently. Fleet private keys and generated run data are ignored
by Git.

## 100-device demo

The fleet manager validates schemas and certificates, starts one MQTT simulator
process per manifest record with a small delay, tracks status, and stores PIDs
and logs in `.fleet-runs/<run-id>/`.

Preflight and start:

```bash
npm run demo:fleet -- --dry-run
npm run demo:fleet
```

Start and activate telemetry through the real backend command and audit path:

```bash
FLEET_ADMIN_TOKEN="$TOKEN" npm run demo:fleet -- --activate
```

In another terminal:

```bash
npm run demo:fleet:status
npm run demo:fleet:stop
```

The stop command signals the supervisor, which sends `SIGINT` only to child
processes from its run manifest. `SIGKILL` is a fallback for an individual child
that does not stop cleanly. Historical manifests and logs remain in
`.fleet-runs/` but are not committed.

Useful options:

```bash
npm run demo:fleet -- --stagger-ms 150
npm run demo:fleet -- --file fleet/another-fleet.json
MQTT_BROKER_URL=mqtt://127.0.0.1:1883 npm run demo:fleet
```

See [`fleet/README.md`](fleet/README.md) for the manifest contract and complete
fleet workflow.

## Tests

All default Jest tests:

```bash
npm test -- --runInBand
```

The default run includes generator, lifecycle, presence, CoAP adapter,
certificate helper, and three-device tests. The fleet smoke suite is opt-in and
appears as skipped unless `test:e2e:fleet` is used.

MQTT lifecycle, heartbeat, Last Will, and clean shutdown with real Mosquitto:

```bash
npm test -- --runInBand --runTestsByPath tests/simulator.e2e.test.js
```

Three real simulator processes with real Mosquitto:

```bash
npm run test:e2e:three
```

CoAP adapter, direct response, Block1, and UDP cleanup:

```bash
npm run test:e2e:coap
```

Fleet manager unit test with fake child processes:

```bash
npx jest --runInBand --runTestsByPath tests/fleet-manager.test.js
```

Presence and MQTT Last Will configuration unit test:

```bash
npx jest --runInBand --runTestsByPath tests/device-presence.test.js
```

Opt-in real MQTT fleet test:

```bash
FLEET_E2E_COUNT=5 npm run test:e2e:fleet
FLEET_E2E_COUNT=20 npm run test:e2e:fleet
FLEET_E2E_COUNT=100 npm run test:e2e:fleet
```

The fleet E2E starts real `sim.js` child processes and uses a real MQTT broker.
It checks `online`, `SET_STATE/ACTIVE`, correlated responses, telemetry,
`offline`, PIDs, and clean shutdown. It uses `SKIP_CERT=true` and does not use
the backend or database.

After MQTT E2E tests, retained status and attribute messages are removed,
temporary logs are deleted, and child processes are awaited. Check manually
that no simulator remains:

```bash
pgrep -af 'node .*sim\.js'
```

## Telemetry size performance

```bash
npm run performance:telemetry
```

`analysis.js` reads JSON lines and `timestamp|size` records, skips invalid
lines, and calculates sample count, total size, minimum, maximum, average,
median, and p95. The result is written to
`performance-results/telemetry-size.json` and printed as a terminal table.

The comparison uses average UTF-8 message size. Total dataset sizes should not
be compared directly when full and partial datasets contain different sample
counts.

## Directory structure

```text
sim.js                    application bootstrap and clean shutdown
config/                   CLI arguments, environment, and device paths
registration/             PKI material and device registration
commands/                 command processing, responses, and model changes
runtime/                  telemetry, history, and presence timers
logging/                  simulator logging configuration
telemetry-generator3.js   schema-driven data generation
transports/               MQTT/CoAP selection and CoAP adapter
schema/                   local model schemas and versions
staged/                   prepared model-version packages
scripts/                  certificate and multi-process launchers
tests/                    unit, MQTT E2E, CoAP E2E, and fleet tests
analysis.js               message-size analysis
performance-results/      generated telemetry reports
```
