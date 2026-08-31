const coap = require("coap");
const { once } = require("events");
const {
  createCoapClientAdapter,
} = require("../transports/coap-client-adapter");

jest.setTimeout(15_000);

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server._sock.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function closeAgent(agent) {
  if (!agent?._sock) return Promise.resolve();

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      agent.removeListener("close", finish);
      resolve();
    };

    agent.once("close", finish);
    try {
      agent.close(finish);
    } catch {
      // An agent that was never used owns an unbound socket. It cannot be
      // closed through node-coap, but unref prevents it from keeping Jest alive.
      agent._sock?.unref?.();
      finish();
    }
  });
}

function publish(adapter, topic, body, options = {}) {
  return new Promise((resolve, reject) => {
    adapter.publish(topic, JSON.stringify(body), options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function postJson(endpoint, body) {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const requestBody = Buffer.from(JSON.stringify(body), "utf8");
    const request = coap.request({
      hostname: url.hostname,
      port: Number(url.port),
      pathname: url.pathname,
      method: "POST",
      confirmable: true,
    });
    const chunks = [];

    request.setOption("Content-Format", "application/json");
    if (requestBody.length > 1024) {
      request.setOption("Block1", Buffer.from([6]));
    }
    request.once("error", reject);
    request.once("response", (response) => {
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        resolve({
          code: response.code,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    });
    request.end(requestBody);
  });
}

describe("CoAP simulator transport adapter (e2e)", () => {
  let backendServer;
  let adapter;

  afterEach(async () => {
    if (adapter) {
      await new Promise((resolve) => adapter.end(false, {}, resolve));
      adapter = null;
    }
    if (backendServer) {
      await closeServer(backendServer);
      backendServer = null;
    }
  });

  afterAll(async () => {
    await closeAgent(coap.globalAgent);
    await closeAgent(coap.globalAgentIPv6);
  });

  it("exchanges status, attributes, telemetry and a direct command response, then closes cleanly", async () => {
    const received = [];
    backendServer = coap.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.once("end", () => {
        received.push({
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.code = "2.04";
        response.end(JSON.stringify({ approved: true }));
      });
    });
    const backendPort = await listen(backendServer);

    const deviceId = "coap-e2e-1";
    const commandTopic = `iot/devices/${deviceId}/commands`;
    const responseTopic = `iot/devices/${deviceId}/response`;
    adapter = createCoapClientAdapter({
      deviceId,
      backendUrl: `coap://127.0.0.1:${backendPort}`,
      listenPort: 0,
      commandTopic,
      responseTopic,
      requestTimeoutMs: 2_000,
    });
    await once(adapter, "connect");

    adapter.subscribe(commandTopic, () => undefined);
    adapter.on("message", (topic, payload) => {
      const command = JSON.parse(payload.toString("utf8"));
      adapter.publish(
        responseTopic,
        JSON.stringify({
          deviceId,
          command: command.command,
          correlationId: command.correlationId,
          success: true,
        }),
        { qos: 1 },
      );
    });

    await publish(adapter, `iot/devices/${deviceId}/status`, {
      deviceId,
      status: "online",
    });
    await publish(adapter, `iot/devices/${deviceId}/attributes`, {
      serialNumber: deviceId,
      firmware: "1.0.0",
      hardwareModel: "modelA",
    });
    await publish(adapter, `iot/devices/${deviceId}/telemetry`, {
      schemaId: "modelA",
      telemetry: { led: false },
    });

    expect(received.map((entry) => entry.url)).toEqual([
      `/devices/${deviceId}/status`,
      `/devices/${deviceId}/attributes`,
      `/devices/${deviceId}/telemetry`,
    ]);
    const commandEndpoint = received[0].body.commandEndpoint;
    expect(commandEndpoint).toMatch(/^coap:\/\/127\.0\.0\.1:\d+\/commands$/);

    const correlationId = "coap-correlation-1";
    const commandResponse = await postJson(commandEndpoint, {
      command: "SET_LED",
      payload: { value: true, correlationId },
      correlationId,
    });

    expect(commandResponse).toEqual({
      code: "2.05",
      body: {
        deviceId,
        command: "SET_LED",
        correlationId,
        success: true,
      },
    });

    const modelCorrelationId = "coap-model-stage-correlation";
    const modelStageResponse = await postJson(commandEndpoint, {
      command: "STAGE_MODEL_VERSION",
      payload: {
        model: "modelC",
        version: "1.1.5",
        schema: {
          description: "x".repeat(5_600),
        },
        mapping: { fields: {} },
        correlationId: modelCorrelationId,
      },
      correlationId: modelCorrelationId,
    });

    expect(modelStageResponse).toEqual({
      code: "2.05",
      body: {
        deviceId,
        command: "STAGE_MODEL_VERSION",
        correlationId: modelCorrelationId,
        success: true,
      },
    });
  });
});
